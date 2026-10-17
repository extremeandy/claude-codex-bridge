import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ServerNotification } from "../.generated/ServerNotification.ts";
import type { ServerRequest } from "../.generated/ServerRequest.ts";
import type { ApprovalsReviewer } from "../.generated/v2/ApprovalsReviewer.ts";
import type { CommandExecutionRequestApprovalResponse } from "../.generated/v2/CommandExecutionRequestApprovalResponse.ts";
import type { FileChangeRequestApprovalResponse } from "../.generated/v2/FileChangeRequestApprovalResponse.ts";
import type { FileUpdateChange } from "../.generated/v2/FileUpdateChange.ts";
import type { PermissionsRequestApprovalResponse } from "../.generated/v2/PermissionsRequestApprovalResponse.ts";
import type { SandboxMode } from "../.generated/v2/SandboxMode.ts";
import type { ToolRequestUserInputParams } from "../.generated/v2/ToolRequestUserInputParams.ts";
import type { AppServer } from "./app-server.ts";

/** The string approval policies; the granular object form is not offered. */
export type ApprovalPolicy = "untrusted" | "on-request" | "never";
/** Reviewers the bridge accepts; guardian_subagent is Codex's legacy alias for auto_review. */
export type Reviewer = Exclude<ApprovalsReviewer, "guardian_subagent">;
/** Settings sent when a thread is attached. A null reviewer is not sent, so Codex uses its configured reviewer. */
export type ThreadSettings = {
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer: Reviewer | null;
};
export const defaultSettings: ThreadSettings = {
  sandbox: "danger-full-access",
  approvalPolicy: "never",
  approvalsReviewer: null,
};
/** Settings a caller or the operator may set; an omitted one falls back. */
export type SettingsInput = {
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: Reviewer;
};
export type ApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export type BridgeEvent = {
  sequence: number;
  threadId: string;
  kind: string;
  text: string;
  truncated: boolean;
  timestamp: string;
};
// Ordered from narrowest to widest. `satisfies` makes tsc reject a SandboxMode
// that Codex adds until it is ranked here.
export const sandboxRank = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
} satisfies Record<SandboxMode, number>;

type Question = { requestId: string; params: ToolRequestUserInputParams };
type ApprovalRequest = Extract<
  ServerRequest,
  {
    method:
      | "item/commandExecution/requestApproval"
      | "item/fileChange/requestApproval"
      | "item/permissions/requestApproval";
  }
>;
type PendingRequest =
  | ApprovalRequest
  | Extract<ServerRequest, { method: "item/tool/requestUserInput" }>;
const handledRequests: PendingRequest["method"][] = [
  "item/tool/requestUserInput",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
];
type Approval = {
  requestId: string;
  method: ApprovalRequest["method"];
  params: ApprovalRequest["params"];
  /** The proposed edits of a file change, from its item/started notification. */
  changes?: FileUpdateChange[];
};
type Session = ThreadSettings & {
  threadId: string;
  model: string;
  cwd: string;
  status:
    | "idle"
    | "running"
    | "waiting_input"
    | "waiting_approval"
    | "completed"
    | "interrupted"
    | "failed"
    | "unavailable";
  turnId: string | null;
  lastTurnId: string | null;
  lastAnswer: string;
  answerTruncated: boolean;
  questions: Question[];
  approvals: Approval[];
};

export class Bridge {
  private sessions = new Map<string, Session>();
  private requests = new Map<string, PendingRequest>();
  /** Proposed edits of file changes in flight, by item ID. */
  private fileChanges = new Map<
    string,
    { turnId: string; changes: FileUpdateChange[] }
  >();
  private busy = new Set<string>();
  private journal: BridgeEvent[] = [];
  private sequence = 0;
  private buffers = new Map<
    string,
    { text: string; truncated: boolean; timer: ReturnType<typeof setTimeout> }
  >();
  private delivery = Promise.resolve();
  private closed = false;
  channelError: string | null = null;
  failure: string | null = null;

  constructor(
    private rpc: AppServer,
    private publish: (event: BridgeEvent) => Promise<void>,
    private progressMs = 1_000,
    private journalLimit = 200,
    // The operator's settings (CODEX_BRIDGE_*). A set sandbox is both the
    // default and the widest mode a caller may ask for. Without one, the
    // default is danger-full-access and any mode is allowed.
    private configured: SettingsInput = {},
  ) {
    rpc.onNotification = (event) => this.notification(event);
    rpc.onRequest = (request) => this.request(request);
    rpc.onFailure = (error) => {
      this.failure = error.message;
      this.markUnavailable();
      for (const session of this.sessions.values()) {
        this.flush(session.threadId);
        this.emit(session.threadId, "unavailable", error.message);
      }
    };
  }

  async models(cursor?: string) {
    await this.rpc.connect();
    return this.rpc.call("model/list", { cursor, limit: 100 });
  }

  async start(
    input: {
      prompt: string;
      cwd: string;
      model?: string;
      serviceTier?: string;
    } & SettingsInput,
  ) {
    if (!isAbsolute(input.cwd) || !(await stat(input.cwd)).isDirectory()) {
      throw new Error("cwd must be an existing absolute directory");
    }
    const settings = this.settings(input);
    await this.rpc.connect();
    const result = await this.rpc.call("thread/start", {
      cwd: input.cwd,
      model: input.model,
      serviceTier: input.serviceTier,
      allowProviderModelFallback: false,
      ...this.settingsParams(settings),
    });
    const session = this.attach(
      result.thread.id,
      result.model,
      result.cwd,
      settings,
    );
    return this.lock(session, async () => {
      await this.begin(session, input.prompt);
      return this.snapshot(session);
    });
  }

  async resume(threadId: string, requested: SettingsInput = {}) {
    const settings = this.settings(requested);
    const attached = this.sessions.get(threadId);
    if (attached) {
      // Settings are sent only when a thread is attached, so a different
      // value for an attached thread would otherwise be silently ignored.
      for (const key of [
        "sandbox",
        "approvalPolicy",
        "approvalsReviewer",
      ] as const)
        if (requested[key] && requested[key] !== attached[key])
          throw new Error(
            `Thread is already attached with ${key} ${attached[key] ?? "unset"}`,
          );
      return this.snapshot(attached);
    }
    await this.rpc.connect();
    const result = await this.rpc.call("thread/resume", {
      threadId,
      ...this.settingsParams(settings),
      initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "full" },
    });
    const session = this.attach(
      result.thread.id,
      result.model,
      result.cwd,
      settings,
    );
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
    if (this.closed) throw new Error("Bridge closed");
    const request = this.requests.get(requestId);
    if (
      request?.method !== "item/tool/requestUserInput" ||
      request.params.threadId !== threadId
    )
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

  approve(threadId: string, requestId: string, decision: ApprovalDecision) {
    if (this.closed) throw new Error("Bridge closed");
    const request = this.requests.get(requestId);
    if (
      !request ||
      request.method === "item/tool/requestUserInput" ||
      request.params.threadId !== threadId
    )
      throw new Error("Unknown or expired approval request");
    this.rpc.respond(request.id, approvalResponse(request, decision));
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

  private settings(input: SettingsInput): ThreadSettings {
    return {
      sandbox: this.sandbox(input.sandbox),
      approvalPolicy:
        input.approvalPolicy ??
        this.configured.approvalPolicy ??
        defaultSettings.approvalPolicy,
      approvalsReviewer:
        input.approvalsReviewer ??
        this.configured.approvalsReviewer ??
        defaultSettings.approvalsReviewer,
    };
  }

  // Only the sandbox is capped: the approval settings decide who may let a
  // single request go beyond it.
  private sandbox(requested?: SandboxMode): SandboxMode {
    const limit = this.configured.sandbox;
    if (!limit) return requested ?? defaultSettings.sandbox;
    if (requested && sandboxRank[requested] > sandboxRank[limit])
      throw new Error(
        `sandbox ${requested} is wider than ${limit}, the maximum set by CODEX_BRIDGE_SANDBOX`,
      );
    return requested ?? limit;
  }

  private settingsParams(settings: ThreadSettings) {
    return {
      sandbox: settings.sandbox,
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: settings.approvalsReviewer ?? undefined,
    };
  }

  private attach(
    threadId: string,
    model: string,
    cwd: string,
    settings: ThreadSettings,
  ) {
    const session: Session = {
      threadId,
      model,
      cwd,
      ...settings,
      status: "idle",
      turnId: null,
      lastTurnId: null,
      lastAnswer: "",
      answerTruncated: false,
      questions: [],
      approvals: [],
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
    return {
      ...session,
      questions: [...session.questions],
      approvals: [...session.approvals],
    };
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
        if (item.type === "fileChange") {
          if (event.method === "item/started")
            this.fileChanges.set(item.id, {
              turnId: event.params.turnId,
              changes: item.changes,
            });
          else this.fileChanges.delete(item.id);
        }
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
        for (const pending of [...session.questions, ...session.approvals])
          this.clearRequest(pending.requestId);
        // A file change interrupted with its turn never sends item/completed.
        for (const [itemId, { turnId }] of this.fileChanges)
          if (turnId === event.params.turn.id) this.fileChanges.delete(itemId);
        this.emit(
          session.threadId,
          session.status,
          event.params.turn.error?.message ??
            `Turn ${event.params.turn.id} ${session.status}`,
        );
        break;
      case "item/fileChange/patchUpdated":
        if (this.fileChanges.has(event.params.itemId))
          this.fileChanges.set(event.params.itemId, {
            turnId: event.params.turnId,
            changes: event.params.changes,
          });
        break;
      case "serverRequest/resolved":
        // Another client of a shared app-server may have answered first.
        this.clearRequest(String(event.params.requestId));
        break;
      case "item/autoApprovalReview/completed":
        this.emit(
          session.threadId,
          "auto_review",
          JSON.stringify({
            ...event.params.review,
            action: event.params.action,
          }),
        );
        break;
      case "error":
        this.emit(session.threadId, "error", event.params.error.message);
        break;
    }
  }

  private request(request: ServerRequest) {
    if (this.closed) return;
    if (!isPending(request) || !this.sessions.has(request.params.threadId)) {
      this.rpc.reject(
        request.id,
        `Bridge does not support Codex request: ${request.method}`,
      );
      return;
    }
    const requestId = String(request.id);
    this.requests.set(requestId, request);
    const session = this.session(request.params.threadId);
    if (request.method === "item/tool/requestUserInput") {
      session.questions.push({ requestId, params: request.params });
      if (request.params.isBlocking) this.settleWaiting(session);
      this.emit(
        session.threadId,
        "question",
        JSON.stringify({ requestId, ...request.params }),
      );
      return;
    }
    const changes =
      request.method === "item/fileChange/requestApproval"
        ? this.fileChanges.get(request.params.itemId)?.changes
        : undefined;
    session.approvals.push({
      requestId,
      method: request.method,
      params: request.params,
      changes,
    });
    this.settleWaiting(session);
    this.emit(
      session.threadId,
      "approval",
      JSON.stringify({
        requestId,
        method: request.method,
        ...request.params,
        changes,
      }),
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
    session.approvals = session.approvals.filter(
      (approval) => approval.requestId !== requestId,
    );
    if (
      session.status === "waiting_input" ||
      session.status === "waiting_approval"
    )
      this.settleWaiting(session);
  }

  /** Approvals always block the turn; questions block it when Codex says so. */
  private settleWaiting(session: Session) {
    session.status = session.approvals.length
      ? "waiting_approval"
      : session.questions.some((question) => question.params.isBlocking)
        ? "waiting_input"
        : "running";
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
    this.delivery = this.delivery.then(async () => {
      try {
        await this.publish(event);
        this.channelError = null;
      } catch (error) {
        this.channelError = String(error);
      }
    });
  }

  /**
   * Marks every session unavailable and forgets its pending questions and
   * approvals, because the app-server can no longer take an answer.
   */
  private markUnavailable() {
    this.requests.clear();
    this.fileChanges.clear();
    for (const session of this.sessions.values()) {
      session.status = "unavailable";
      session.turnId = null;
      session.questions = [];
      session.approvals = [];
    }
  }

  async close() {
    this.closed = true;
    for (const threadId of this.buffers.keys()) this.flush(threadId);
    this.failure ??= "Bridge closed";
    this.markUnavailable();
    await this.rpc.close();
    await this.delivery;
  }
}

function isPending(request: ServerRequest): request is PendingRequest {
  return (handledRequests as string[]).includes(request.method);
}

function approvalResponse(
  request: ApprovalRequest,
  decision: ApprovalDecision,
):
  | CommandExecutionRequestApprovalResponse
  | FileChangeRequestApprovalResponse
  | PermissionsRequestApprovalResponse {
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const offered = request.params.availableDecisions;
      // Refusals are always allowed: they never widen access, and Codex's
      // app-server turns decline and cancel into a denial or an abort without
      // checking availableDecisions. See
      // on_command_execution_request_approval_response in
      // codex-rs/app-server/src/bespoke_event_handling.rs (rust-v0.153.4).
      // codex_approve cannot send the amendment decisions, so a request that
      // offers only those can be refused but not accepted.
      if (
        (decision === "accept" || decision === "acceptForSession") &&
        offered &&
        !offered.includes(decision)
      )
        throw new Error(
          `Codex does not offer ${decision} for this request; it offers ${offered
            .map((option) =>
              typeof option === "string" ? option : Object.keys(option)[0],
            )
            .join(", ")}`,
        );
      return { decision };
    }
    case "item/fileChange/requestApproval":
      return { decision };
    case "item/permissions/requestApproval": {
      if (decision === "cancel")
        throw new Error(
          "A permissions request takes accept, acceptForSession or decline",
        );
      // Codex treats permissions left out of the grant as denied.
      if (decision === "decline") return { permissions: {}, scope: "turn" };
      const { network, fileSystem } = request.params.permissions;
      return {
        permissions: {
          ...(network && { network }),
          ...(fileSystem && { fileSystem }),
        },
        scope: decision === "acceptForSession" ? "session" : "turn",
      };
    }
  }
}
