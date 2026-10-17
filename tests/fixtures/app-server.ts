import { createInterface } from "node:readline";

const mode = process.argv[2];
if (mode === "stubborn") process.on("SIGTERM", () => {});
const threads = new Map<
  string,
  {
    model: string;
    cwd: string;
    turnId: string;
    prompt: string;
    sandbox: string;
    approvalPolicy: string;
    approvalsReviewer?: string;
  }
>();
const sandboxes = ["read-only", "workspace-write", "danger-full-access"];
const policies = ["untrusted", "on-request", "never"];
const reviewers = [undefined, "user", "auto_review"];
const permitted = (params: {
  sandbox: string;
  approvalPolicy: string;
  approvalsReviewer?: string;
}) =>
  sandboxes.includes(params.sandbox) &&
  policies.includes(params.approvalPolicy) &&
  reviewers.includes(params.approvalsReviewer);
let sequence = 0;
const send = (message: object) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method: string, params: object) => send({ method, params });
const turn = (id: string, status = "inProgress") => ({
  id,
  status,
  items: [],
  error: null,
});
const finish = (threadId: string, status = "completed", text = "finished") => {
  const thread = threads.get(threadId);
  if (!thread) throw new Error("Unknown thread");
  notify("item/completed", {
    threadId,
    turnId: thread.turnId,
    item: { type: "agentMessage", id: "answer", text },
  });
  notify("turn/completed", { threadId, turn: turn(thread.turnId, status) });
  thread.turnId = "";
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params, result, error } = JSON.parse(line);
  if (method === undefined) {
    const threadId = String(id).split(":")[0];
    notify("serverRequest/resolved", { threadId, requestId: id });
    finish(threadId, "completed", JSON.stringify(result ?? error));
    return;
  }
  const reply = (value: object) => send({ id, result: value });
  switch (method) {
    case "initialize":
      if (mode === "hang") break;
      if (mode === "malformed") {
        process.stdout.write("not json\n");
        break;
      }
      if (mode === "null") {
        process.stdout.write("null\n");
        break;
      }
      reply({ userAgent: "fixture" });
      break;
    case "initialized":
      break;
    case "model/list":
      reply({
        data: [{ id: "fixture", model: "fixture", isDefault: true }],
        nextCursor: params.cursor ? null : "page2",
      });
      break;
    case "thread/start": {
      if (params.model === "missing") {
        send({ id, error: { code: -1, message: "model unavailable" } });
        break;
      }
      if (params.serviceTier === "missing") {
        send({ id, error: { code: -1, message: "service tier unavailable" } });
        break;
      }
      if (!permitted(params) || params.allowProviderModelFallback !== false)
        throw new Error("Wrong permissions or model fallback");
      const threadId = `thread-${++sequence}`;
      const thread = {
        model: params.model ?? "fixture",
        cwd: params.cwd,
        turnId: "",
        prompt: "",
        sandbox: params.sandbox,
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer,
      };
      threads.set(threadId, thread);
      notify("thread/started", { thread: { id: threadId } });
      reply({ thread: { id: threadId }, ...thread });
      break;
    }
    case "thread/resume": {
      if (params.initialTurnsPage?.itemsView !== "full")
        throw new Error("Resume needs full recent items");
      if (!permitted(params)) throw new Error("Wrong permissions");
      const thread = {
        model: "fixture",
        cwd: process.cwd(),
        turnId: params.threadId === "active" ? "resumed-turn" : "",
        prompt: "",
        sandbox: params.sandbox,
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer,
      };
      threads.set(params.threadId, thread);
      reply({
        thread: {
          id: params.threadId,
          turns: [
            {
              ...turn(
                thread.turnId,
                thread.turnId ? "inProgress" : "completed",
              ),
              items: [{ type: "agentMessage", text: "saved answer" }],
            },
          ],
        },
        ...thread,
        initialTurnsPage:
          params.threadId === "paged"
            ? {
                data: [
                  {
                    ...turn("saved-turn", "completed"),
                    items: [{ type: "agentMessage", text: "page answer" }],
                  },
                ],
              }
            : null,
      });
      break;
    }
    case "turn/start": {
      const thread = threads.get(params.threadId);
      if (!thread) throw new Error("Unknown thread");
      const prompt = params.input[0].text;
      if (prompt === "fail") {
        send({ id, error: { code: -1, message: "turn rejected" } });
        break;
      }
      if (prompt === "crash") {
        process.exit(7);
      }
      if (prompt === "malformed") {
        process.stdout.write("bad\n");
        break;
      }
      thread.prompt = prompt;
      thread.turnId = `turn-${++sequence}`;
      const initialTurn = turn(thread.turnId);
      if (prompt === "late") {
        reply({ turn: initialTurn });
        setTimeout(
          () =>
            notify("turn/started", {
              threadId: params.threadId,
              turn: initialTurn,
            }),
          25,
        );
        break;
      }
      notify("turn/started", { threadId: params.threadId, turn: initialTurn });
      notify("irrelevant/event", { threadId: "other" });
      send({ id: -99, result: {} });
      notify("item/started", {
        threadId: params.threadId,
        item: { type: "userMessage" },
      });
      if (prompt === "instant") finish(params.threadId);
      if (prompt === "sandbox")
        finish(params.threadId, "completed", thread.sandbox);
      if (prompt === "settings")
        finish(
          params.threadId,
          "completed",
          JSON.stringify({
            sandbox: thread.sandbox,
            approvalPolicy: thread.approvalPolicy,
            approvalsReviewer: thread.approvalsReviewer ?? "absent",
          }),
        );
      if (prompt === "auto_review") {
        notify("item/autoApprovalReview/completed", {
          threadId: params.threadId,
          turnId: thread.turnId,
          reviewId: "review",
          targetItemId: "cmd",
          decisionSource: "agent",
          review: {
            status: "denied",
            riskLevel: "high",
            userAuthorization: "low",
            rationale: "Sends data to an unknown host",
          },
          action: {
            type: "command",
            source: "shell",
            command: "curl",
            cwd: "/",
          },
        });
        finish(params.threadId);
      }
      if (prompt === "failed") {
        notify("error", {
          threadId: params.threadId,
          error: { message: "failed upstream" },
        });
        notify("turn/completed", {
          threadId: params.threadId,
          turn: {
            ...turn(thread.turnId, "failed"),
            error: { message: "failed upstream" },
          },
        });
      }
      if (prompt === "long")
        finish(params.threadId, "completed", "x".repeat(65_000));
      const respond = () => reply({ turn: initialTurn });
      if (prompt === "slow") setTimeout(respond, 80);
      else respond();
      if (prompt.includes("question")) {
        send({
          id: `${params.threadId}:question`,
          method: "item/tool/requestUserInput",
          params: {
            threadId: params.threadId,
            turnId: thread.turnId,
            itemId: "question",
            isBlocking: prompt !== "nonblocking_question",
            autoResolutionMs: null,
            questions: [
              {
                id: "choice",
                header: "Choice",
                question: "Which?",
                options: [{ label: "A", description: "First" }],
              },
            ],
          },
        });
      } else if (prompt === "unsupported") {
        send({
          id: `${params.threadId}:unsupported`,
          method: "mcpServer/elicitation/request",
          params: { threadId: params.threadId },
        });
      } else if (
        prompt === "approve_command" ||
        prompt === "approve_elsewhere"
      ) {
        notify("item/started", {
          threadId: params.threadId,
          item: { type: "commandExecution", id: "cmd", command: "curl" },
        });
        const requestId = `${params.threadId}:command`;
        send({
          id: requestId,
          method: "item/commandExecution/requestApproval",
          params: {
            kind: "command",
            threadId: params.threadId,
            turnId: thread.turnId,
            itemId: "cmd",
            reason: "Needs network access",
            command: "curl https://example.com",
            availableDecisions: ["accept", "cancel"],
          },
        });
        if (prompt === "approve_elsewhere")
          setTimeout(() => {
            notify("serverRequest/resolved", {
              threadId: params.threadId,
              requestId,
            });
            finish(params.threadId, "completed", "answered elsewhere");
          }, 20);
      } else if (prompt === "approve_file") {
        notify("item/started", {
          threadId: params.threadId,
          item: {
            type: "fileChange",
            id: "patch",
            changes: [{ path: "a.txt", kind: { type: "add" }, diff: "+a" }],
            status: "inProgress",
          },
        });
        notify("item/fileChange/patchUpdated", {
          threadId: params.threadId,
          turnId: thread.turnId,
          itemId: "patch",
          changes: [{ path: "a.txt", kind: { type: "add" }, diff: "+b" }],
        });
        send({
          id: `${params.threadId}:file`,
          method: "item/fileChange/requestApproval",
          params: {
            threadId: params.threadId,
            turnId: thread.turnId,
            itemId: "patch",
            reason: null,
          },
        });
      } else if (prompt === "approve_permissions") {
        send({
          id: `${params.threadId}:permissions`,
          method: "item/permissions/requestApproval",
          params: {
            threadId: params.threadId,
            turnId: thread.turnId,
            itemId: "permissions",
            environmentId: "local",
            cwd: process.cwd(),
            reason: "Fetch dependencies",
            permissions: { network: { enabled: true }, fileSystem: null },
          },
        });
      } else if (
        ![
          "instant",
          "sandbox",
          "settings",
          "auto_review",
          "failed",
          "long",
        ].includes(prompt)
      ) {
        setTimeout(() => {
          notify("item/started", {
            threadId: params.threadId,
            item: { type: "commandExecution", command: "fixture command" },
          });
          notify("item/agentMessage/delta", {
            threadId: params.threadId,
            delta: prompt === "burst" ? "x".repeat(10_000) : "working ",
          });
          notify("item/commandExecution/outputDelta", {
            threadId: params.threadId,
            delta: "output",
          });
          notify("item/completed", {
            threadId: params.threadId,
            item: {
              type: "commandExecution",
              command: "fixture command",
              exitCode: 0,
            },
          });
        }, 5);
      }
      break;
    }
    case "turn/steer": {
      const thread = threads.get(params.threadId);
      if (!thread?.turnId || thread.turnId !== params.expectedTurnId) {
        send({ id, error: { code: -1, message: "No matching active turn" } });
        break;
      }
      reply({ turnId: thread.turnId });
      finish(params.threadId, "completed", `steered: ${params.input[0].text}`);
      break;
    }
    case "turn/interrupt":
      reply({});
      finish(params.threadId, "interrupted");
      break;
  }
});
