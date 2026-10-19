import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ServerNotification } from "../.generated/ServerNotification.ts";
import type { ServerRequest } from "../.generated/ServerRequest.ts";
import type { ToolRequestUserInputParams } from "../.generated/v2/ToolRequestUserInputParams.ts";
import type { AppServer } from "./app-server.ts";

export type BridgeEvent = {
  sequence: number;
  threadId: string;
  kind: string;
  text: string;
  truncated: boolean;
  timestamp: string;
};
type Question = { requestId: string; params: ToolRequestUserInputParams };
/**
 * The event kinds codex_wait returns on: Codex's messages and questions, and
 * the end of a turn or of the connection. Progress and activity events never
 * end a wait.
 */
export const waitKinds: ReadonlySet<string> = new Set([
  "message",
  "question",
  "completed",
  "interrupted",
  "failed",
  "error",
  "unavailable",
]);
export const defaultWaitMs = 100_000;
/** Below Claude Code's 120 s default, after which a tool call moves to the background. */
export const maxWaitMs = 110_000;
// Bounds a codex_wait result when the caller falls far behind.
const waitTextBudget = 20_000;
/** Statuses in which a turn can still emit events worth waiting for. */
const activeStatuses: ReadonlySet<Session["status"]> = new Set([
  "running",
  "waiting_input",
]);
type Session = {
  threadId: string;
  model: string;
  cwd: string;
  status:
    | "idle"
    | "running"
    | "waiting_input"
    | "completed"
    | "interrupted"
    | "failed"
    | "unavailable";
  turnId: string | null;
  lastTurnId: string | null;
  lastAnswer: string;
  answerTruncated: boolean;
  questions: Question[];
};

export class Bridge {
  private sessions = new Map<string, Session>();
  private requests = new Map<
    string,
    ServerRequest & { method: "item/tool/requestUserInput" }
  >();
  private busy = new Set<string>();
  private journal: BridgeEvent[] = [];
  private sequence = 0;
  private buffers = new Map<
    string,
    { text: string; truncated: boolean; timer: ReturnType<typeof setTimeout> }
  >();
  private delivery = Promise.resolve();
  private waiters = new Set<{ threadId: string; wake: () => void }>();
  private closed = false;
  channelError: string | null = null;
  failure: string | null = null;

  constructor(
    private rpc: AppServer,
    private publish: (event: BridgeEvent) => Promise<void>,
    private progressMs = 1_000,
    private journalLimit = 200,
  ) {
    rpc.onNotification = (event) => this.notification(event);
    rpc.onRequest = (request) => this.request(request);
    rpc.onFailure = (error) => {
      this.failure = error.message;
      this.requests.clear();
      for (const session of this.sessions.values()) {
        this.flush(session.threadId);
        session.status = "unavailable";
        session.turnId = null;
        session.questions = [];
        this.emit(session.threadId, "unavailable", error.message);
      }
      this.wakeAll();
    };
  }

  async models(cursor?: string) {
    await this.rpc.connect();
    return this.rpc.call("model/list", { cursor, limit: 100 });
  }

  async start(input: {
    prompt: string;
    cwd: string;
    model?: string;
    serviceTier?: string;
  }) {
    if (!isAbsolute(input.cwd) || !(await stat(input.cwd)).isDirectory()) {
      throw new Error("cwd must be an existing absolute directory");
    }
    await this.rpc.connect();
    const result = await this.rpc.call("thread/start", {
      cwd: input.cwd,
      model: input.model,
      serviceTier: input.serviceTier,
      allowProviderModelFallback: false,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const session = this.attach(result.thread.id, result.model, result.cwd);
    return this.lock(session, async () => {
      await this.begin(session, input.prompt);
      return this.snapshot(session);
    });
  }

  async resume(threadId: string) {
    if (this.sessions.has(threadId))
      return this.snapshot(this.session(threadId));
    await this.rpc.connect();
    const result = await this.rpc.call("thread/resume", {
      threadId,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "full" },
    });
    const session = this.attach(result.thread.id, result.model, result.cwd);
    const turn = result.initialTurnsPage?.data[0] ?? result.thread.turns.at(-1);
    if (turn) {
      session.lastTurnId = turn.id;
      session.turnId = turn.status === "inProgress" ? turn.id : null;
      session.status = turn.status === "inProgress" ? "running" : turn.status;
    }
    for (const item of turn?.items ?? []) {
      if (item.type === "agentMessage") this.answerText(session, item.text);
    }
    return this.snapshot(session);
  }

  async message(threadId: string, message: string) {
    const session = this.session(threadId);
    return this.lock(session, async () => {
      if (session.turnId) {
        await this.rpc.call("turn/steer", {
          threadId,
          expectedTurnId: session.turnId,
          input: [{ type: "text", text: message, text_elements: [] }],
        });
        return { mode: "steered", ...this.snapshot(session) };
      }
      await this.begin(session, message);
      return { mode: "new_turn", ...this.snapshot(session) };
    });
  }

  async stop(threadId: string) {
    const session = this.session(threadId);
    return this.lock(session, async () => {
      if (!session.turnId)
        return { requested: false, ...this.snapshot(session) };
      await this.rpc.call("turn/interrupt", {
        threadId,
        turnId: session.turnId,
      });
      return { requested: true, ...this.snapshot(session) };
    });
  }

  answer(
    threadId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ) {
    const request = this.requests.get(requestId);
    if (!request || request.params.threadId !== threadId)
      throw new Error("Unknown or expired question");
    const ids = request.params.questions.map((question) => question.id);
    if (
      ids.some((id) => !answers[id]?.length) ||
      Object.keys(answers).some((id) => !ids.includes(id))
    ) {
      throw new Error(
        "Answer every question ID, using only IDs from this request",
      );
    }
    this.rpc.respond(request.id, {
      answers: Object.fromEntries(
        ids.map((id) => [id, { answers: answers[id] }]),
      ),
    });
    this.clearRequest(requestId);
    return this.status(threadId);
  }

  status(threadId?: string) {
    return {
      sessions: threadId
        ? [this.snapshot(this.session(threadId))]
        : [...this.sessions.values()].map((session) => this.snapshot(session)),
      failure: this.failure,
      channelError: this.channelError,
      latestSequence: this.sequence,
    };
  }

  events(after = 0) {
    const oldest = this.journal[0]?.sequence ?? this.sequence + 1;
    return {
      events: this.journal.filter((event) => event.sequence > after),
      latestSequence: this.sequence,
      gap: after < oldest - 1,
    };
  }

  /**
   * Waits until the thread has an event in waitKinds after `after`, its turn is
   * not active, the bridge stops, or timeoutMs passes. `after` defaults to the
   * latest sequence, so only new events end the wait.
   */
  async wait(threadId: string, after?: number, timeoutMs = defaultWaitMs) {
    if (timeoutMs > maxWaitMs)
      throw new Error(`timeoutMs must be at most ${maxWaitMs}`);
    const session = this.session(threadId);
    // A cursor past the latest sequence came from an earlier bridge process.
    const cursor = Math.min(after ?? this.sequence, this.sequence);
    const pending = () =>
      this.journal.filter(
        (event) =>
          event.threadId === threadId &&
          event.sequence > cursor &&
          waitKinds.has(event.kind),
      );
    let timedOut = false;
    if (
      !pending().length &&
      activeStatuses.has(session.status) &&
      !this.closed &&
      !this.failure
    )
      timedOut = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(true);
        }, timeoutMs);
        const waiter = {
          threadId,
          wake: () => {
            clearTimeout(timer);
            this.waiters.delete(waiter);
            resolve(false);
          },
        };
        this.waiters.add(waiter);
      });
    // Built after the await, so events from the same batch of notifications
    // (a message and its turn's completion) return together.
    const found = pending();
    const events: Omit<BridgeEvent, "threadId" | "timestamp">[] = [];
    let size = 0;
    for (const { sequence, kind, text, truncated } of found) {
      size += text.length;
      // Always return one event so the cursor advances.
      if (size > waitTextBudget && events.length > 0) break;
      events.push({ sequence, kind, text, truncated });
    }
    const more = events.length < found.length;
    const ended = !activeStatuses.has(session.status);
    return {
      threadId,
      status: session.status,
      timedOut,
      events,
      more,
      ...(ended && {
        lastAnswer: session.lastAnswer,
        answerTruncated: session.answerTruncated,
      }),
      questions: [...session.questions],
      // Pass as the next call's `after`. Skipped progress and activity events
      // are not returned later.
      latestSequence: more
        ? (events.at(-1)?.sequence ?? this.sequence)
        : this.sequence,
    };
  }

  private attach(threadId: string, model: string, cwd: string) {
    const session: Session = {
      threadId,
      model,
      cwd,
      status: "idle",
      turnId: null,
      lastTurnId: null,
      lastAnswer: "",
      answerTruncated: false,
      questions: [],
    };
    this.sessions.set(threadId, session);
    return session;
  }

  private session(threadId: string) {
    const session = this.sessions.get(threadId);
    if (!session)
      throw new Error(
        "Unknown thread; use codex_resume to attach a saved Codex thread",
      );
    return session;
  }

  private snapshot(session: Session) {
    return { ...session, questions: [...session.questions] };
  }

  private async lock<T>(session: Session, action: () => Promise<T>) {
    if (this.busy.has(session.threadId))
      throw new Error("A control request for this thread is already in flight");
    if (session.status === "unavailable")
      throw new Error(this.failure ?? "Codex unavailable");
    this.busy.add(session.threadId);
    try {
      return await action();
    } finally {
      this.busy.delete(session.threadId);
    }
  }

  private async begin(session: Session, text: string) {
    session.lastAnswer = "";
    session.answerTruncated = false;
    try {
      // turn/started may arrive before this response; notifications own the live state.
      const result = await this.rpc.call("turn/start", {
        threadId: session.threadId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      if (session.lastTurnId !== result.turn.id) {
        session.lastTurnId = result.turn.id;
        session.turnId =
          result.turn.status === "inProgress" ? result.turn.id : null;
        session.status =
          result.turn.status === "inProgress" ? "running" : result.turn.status;
      }
    } catch (error) {
      if (session.status !== "unavailable") session.status = "failed";
      this.emit(session.threadId, "error", String(error));
      throw error;
    }
  }

  private notification(event: ServerNotification) {
    if (this.closed || !("threadId" in event.params) || !event.params.threadId)
      return;
    const session = this.sessions.get(event.params.threadId);
    if (!session) return;
    switch (event.method) {
      case "turn/started":
        session.lastTurnId = event.params.turn.id;
        session.turnId = event.params.turn.id;
        session.status = "running";
        this.emit(
          session.threadId,
          "started",
          `Turn ${session.turnId} started`,
        );
        break;
      case "item/agentMessage/delta":
      case "item/commandExecution/outputDelta":
        this.buffer(session.threadId, event.params.delta);
        break;
      case "item/started":
      case "item/completed": {
        const item = event.params.item;
        if (item.type === "agentMessage" && event.method === "item/completed") {
          this.flush(session.threadId);
          this.answerText(session, item.text);
          this.emit(session.threadId, "message", item.text);
        } else if (
          [
            "commandExecution",
            "fileChange",
            "mcpToolCall",
            "dynamicToolCall",
            "plan",
          ].includes(item.type)
        ) {
          this.emit(
            session.threadId,
            event.method === "item/started" ? "activity" : "activity_completed",
            JSON.stringify(item),
          );
        }
        break;
      }
      case "turn/completed":
        session.lastTurnId = event.params.turn.id;
        this.flush(session.threadId);
        session.status =
          event.params.turn.status === "inProgress"
            ? "running"
            : event.params.turn.status;
        session.turnId = null;
        for (const question of [...session.questions])
          this.clearRequest(question.requestId);
        this.emit(
          session.threadId,
          session.status,
          event.params.turn.error?.message ??
            `Turn ${event.params.turn.id} ${session.status}`,
        );
        break;
      case "serverRequest/resolved":
        this.clearRequest(String(event.params.requestId));
        break;
      case "error":
        this.emit(session.threadId, "error", event.params.error.message);
        break;
    }
  }

  private request(request: ServerRequest) {
    if (
      request.method !== "item/tool/requestUserInput" ||
      !this.sessions.has(request.params.threadId)
    ) {
      this.rpc.reject(
        request.id,
        `Bridge does not support Codex request: ${request.method}`,
      );
      return;
    }
    const requestId = String(request.id);
    this.requests.set(requestId, request);
    const session = this.session(request.params.threadId);
    session.questions.push({ requestId, params: request.params });
    if (request.params.isBlocking) session.status = "waiting_input";
    this.emit(
      session.threadId,
      "question",
      JSON.stringify({ requestId, ...request.params }),
    );
  }

  private clearRequest(requestId: string) {
    const request = this.requests.get(requestId);
    if (!request) return;
    this.requests.delete(requestId);
    const session = this.session(request.params.threadId);
    session.questions = session.questions.filter(
      (question) => question.requestId !== requestId,
    );
    if (
      session.status === "waiting_input" &&
      !session.questions.some((question) => question.params.isBlocking)
    )
      session.status = "running";
  }

  private answerText(session: Session, text: string) {
    session.lastAnswer = text.slice(0, 64_000);
    session.answerTruncated = text.length > 64_000;
  }

  private buffer(threadId: string, text: string) {
    const buffer = this.buffers.get(threadId);
    if (buffer) {
      buffer.truncated ||= buffer.text.length + text.length > 8_000;
      buffer.text = (buffer.text + text).slice(-8_000);
    } else
      this.buffers.set(threadId, {
        text: text.slice(-8_000),
        truncated: text.length > 8_000,
        timer: setTimeout(() => this.flush(threadId), this.progressMs),
      });
  }

  private flush(threadId: string) {
    const buffer = this.buffers.get(threadId);
    if (!buffer) return;
    clearTimeout(buffer.timer);
    this.buffers.delete(threadId);
    this.emit(threadId, "progress", buffer.text, buffer.truncated);
  }

  private emit(
    threadId: string,
    kind: string,
    text: string,
    truncated = false,
  ) {
    const event = {
      sequence: ++this.sequence,
      threadId,
      kind,
      text: text.slice(0, 8_000),
      truncated: truncated || text.length > 8_000,
      timestamp: new Date().toISOString(),
    };
    this.journal.push(event);
    if (this.journal.length > this.journalLimit) this.journal.shift();
    if (waitKinds.has(kind))
      for (const waiter of this.waiters)
        if (waiter.threadId === threadId) waiter.wake();
    this.delivery = this.delivery.then(async () => {
      try {
        await this.publish(event);
        this.channelError = null;
      } catch (error) {
        this.channelError = String(error);
      }
    });
  }

  private wakeAll() {
    for (const waiter of this.waiters) waiter.wake();
  }

  async close() {
    this.closed = true;
    for (const threadId of this.buffers.keys()) this.flush(threadId);
    this.wakeAll();
    await this.rpc.close();
    await this.delivery;
  }
}
