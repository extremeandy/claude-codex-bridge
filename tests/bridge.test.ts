import { readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { AppServer } from "../src/app-server.ts";
import { Bridge, type BridgeEvent, type BridgeOptions } from "../src/bridge.ts";

const cleanup: Bridge[] = [];
const directories: string[] = [];
const command = [
  process.execPath,
  resolve(import.meta.dirname, "fixtures/app-server.ts"),
];
const cwd = process.cwd();
async function until(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Event did not arrive");
    await sleep(5);
  }
}
function fixture(
  mode?: string,
  publish?: (event: BridgeEvent) => Promise<void>,
  limit = 200,
  options: Pick<BridgeOptions, "configured" | "eventLog"> = {},
) {
  const events: BridgeEvent[] = [];
  const rpc = new AppServer({
    command: mode ? [...command, mode] : command,
    timeoutMs: mode === "hang" ? 80 : 2_000,
  });
  const bridge = new Bridge(
    rpc,
    publish ??
      (async (event) => {
        events.push(event);
      }),
    { progressMs: 10, journalLimit: limit, ...options },
  );
  cleanup.push(bridge);
  return { bridge, rpc, events };
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((bridge) => bridge.close()));
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-log-"));
  directories.push(directory);
  return directory;
}

test("acceptance returns while Codex runs; progress arrives and steering affects that turn", async () => {
  const { bridge, events } = fixture();
  const session = await bridge.start({ cwd, prompt: "work", model: "fixture" });
  expect(session.status).toBe("running");
  await until(() => events.some((event) => event.kind === "progress"));
  expect(events.some((event) => event.text.includes("working output"))).toBe(
    true,
  );
  const result = await bridge.message(session.threadId, "new direction");
  expect(result.mode).toBe("steered");
  await until(() => events.some((event) => event.kind === "completed"));
  expect(bridge.status(session.threadId).sessions[0].lastAnswer).toBe(
    "steered: new direction",
  );
  expect((await bridge.message(session.threadId, "instant")).mode).toBe(
    "new_turn",
  );
  await until(
    () => bridge.status(session.threadId).sessions[0].status === "completed",
  );
  expect((await bridge.stop(session.threadId)).requested).toBe(false);
});

test("new turns apply model and effort, which stay the thread's defaults", async () => {
  const { bridge } = fixture();
  const session = await bridge.start({
    cwd,
    prompt: "settings",
    effort: "high",
  });
  expect(session.lastAnswer).toBe("fixture/high");
  const switched = await bridge.message(session.threadId, "settings", {
    model: "fixture-2",
  });
  expect(switched.mode).toBe("new_turn");
  expect(switched.model).toBe("fixture-2");
  expect(switched.lastAnswer).toBe("fixture-2/high");
  const lowered = await bridge.message(session.threadId, "settings", {
    effort: "low",
  });
  expect(lowered.lastAnswer).toBe("fixture-2/low");
  expect(bridge.status(session.threadId).sessions[0].model).toBe("fixture-2");
});

test("configured defaults apply to new threads that omit model or effort", async () => {
  const { bridge } = fixture(undefined, undefined, 200, {
    configured: {
      model: "fixture-2",
      effort: "high",
    },
  });
  const session = await bridge.start({ cwd, prompt: "settings" });
  expect(session.model).toBe("fixture-2");
  expect(session.lastAnswer).toBe("fixture-2/high");
  const explicit = await bridge.start({
    cwd,
    prompt: "settings",
    model: "fixture",
    effort: "low",
  });
  expect(explicit.lastAnswer).toBe("fixture/low");
  const explicitModel = await bridge.start({
    cwd,
    prompt: "settings",
    model: "fixture",
  });
  expect(explicitModel.lastAnswer).toBe("fixture/high");
  // codex_resume sends no defaults, so a saved thread keeps what Codex stored.
  await bridge.resume("saved");
  await bridge.message("saved", "settings");
  expect(bridge.status("saved").sessions[0].lastAnswer).toBe(
    "fixture/undefined",
  );
});

test("the default effort belongs to the thread, so it outlives a failed first turn", async () => {
  const { bridge } = fixture(undefined, undefined, 200, {
    configured: { effort: "high" },
  });
  const error = await bridge
    .start({ cwd, prompt: "fail" })
    .catch((error: Error) => error);
  const threadId = String(/Thread (\S+) started/.exec(String(error))?.[1]);
  const retried = await bridge.message(threadId, "settings");
  expect(retried.lastAnswer).toBe("fixture/high");
});

test("without configured defaults, starts send no model or effort", async () => {
  const { bridge } = fixture();
  expect((await bridge.start({ cwd, prompt: "settings" })).lastAnswer).toBe(
    "fixture/undefined",
  );
});

test("model or effort on a running turn is refused instead of steering without them", async () => {
  const { bridge, events } = fixture();
  const session = await bridge.start({ cwd, prompt: "work" });
  for (const settings of [{ model: "fixture-2" }, { effort: "low" }]) {
    await expect(
      bridge.message(session.threadId, "steer", settings),
    ).rejects.toThrow("only when a new turn starts");
  }
  const current = bridge.status(session.threadId).sessions[0];
  expect(current.status).toBe("running");
  expect(current.model).toBe("fixture");
  expect(events.some((event) => event.text.startsWith("steered"))).toBe(false);
  expect((await bridge.message(session.threadId, "steer")).mode).toBe(
    "steered",
  );
});

test("a rejected per-turn model leaves the recorded model unchanged", async () => {
  const { bridge } = fixture();
  const session = await bridge.start({ cwd, prompt: "instant" });
  await expect(
    bridge.message(session.threadId, "instant", { model: "missing" }),
  ).rejects.toThrow("model unavailable");
  expect(bridge.status(session.threadId).sessions[0].model).toBe("fixture");
});

test("a rejected first turn names the started thread so the caller can retry it", async () => {
  const { bridge } = fixture();
  const error = await bridge
    .start({ cwd, prompt: "settings", effort: "missing" })
    .catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  const threadId = /Thread (\S+) started/.exec(String(error))?.[1];
  expect(String(error)).toContain("effort unavailable");
  expect(threadId).toBeDefined();
  expect(bridge.status(threadId).sessions[0].status).toBe("failed");
  const retried = await bridge.message(String(threadId), "settings", {
    effort: "high",
  });
  expect(retried.lastAnswer).toBe("fixture/high");
});

test("a turn that completes before its start response stays completed", async () => {
  const { bridge } = fixture();
  const session = await bridge.start({ cwd, prompt: "instant" });
  expect(session.status).toBe("completed");
  expect(session.turnId).toBeNull();
  expect(session.lastAnswer).toBe("finished");
});

test("start response establishes a running turn before the started notification arrives", async () => {
  const { bridge, events } = fixture();
  const session = await bridge.start({ cwd, prompt: "late" });
  expect(session.status).toBe("running");
  expect(typeof session.turnId).toBe("string");
  expect(events).toEqual([]);
  await until(() => events.some((event) => event.kind === "started"));
  expect(bridge.status(session.threadId).sessions[0].turnId).toBe(
    session.turnId,
  );
});

test("progress bursts retain the tail and report truncation", async () => {
  const { bridge, events } = fixture();
  await bridge.start({ cwd, prompt: "burst" });
  await until(() => events.some((event) => event.kind === "progress"));
  const progress = events.find((event) => event.kind === "progress");
  expect(progress?.truncated).toBe(true);
  expect(progress?.text.length).toBe(8_000);
  expect(progress?.text.endsWith("output")).toBe(true);
});

test("separate threads can run concurrently and stopping one leaves the other running", async () => {
  const { bridge } = fixture();
  const [one, two] = await Promise.all([
    bridge.start({ cwd, prompt: "work" }),
    bridge.start({ cwd, prompt: "work" }),
  ]);
  expect(one.threadId).not.toBe(two.threadId);
  expect((await bridge.stop(one.threadId)).requested).toBe(true);
  await until(
    () => bridge.status(one.threadId).sessions[0].status === "interrupted",
  );
  expect(bridge.status(two.threadId).sessions[0].status).toBe("running");
});

test("overlapping controls for the same thread are rejected", async () => {
  const { bridge } = fixture();
  const session = await bridge.start({ cwd, prompt: "instant" });
  const first = bridge.message(session.threadId, "slow");
  await expect(bridge.stop(session.threadId)).rejects.toThrow(
    "already in flight",
  );
  await first;
});

test("structured questions round-trip, require all IDs, and expire after being answered", async () => {
  const { bridge } = fixture();
  const session = await bridge.start({ cwd, prompt: "question" });
  await until(
    () => bridge.status(session.threadId).sessions[0].questions.length > 0,
  );
  const question = bridge.status(session.threadId).sessions[0].questions[0];
  expect(bridge.status(session.threadId).sessions[0].status).toBe(
    "waiting_input",
  );
  expect(() => bridge.answer(session.threadId, question.requestId, {})).toThrow(
    "every question",
  );
  expect(() =>
    bridge.answer(session.threadId, question.requestId, {
      choice: ["A"],
      extra: ["B"],
    }),
  ).toThrow("every question");
  expect(() =>
    bridge.answer("other", question.requestId, { choice: ["A"] }),
  ).toThrow("expired");
  bridge.answer(session.threadId, question.requestId, { choice: ["A"] });
  expect(() =>
    bridge.answer(session.threadId, question.requestId, { choice: ["A"] }),
  ).toThrow("expired");
  await until(
    () => bridge.status(session.threadId).sessions[0].status === "completed",
  );
  expect(
    JSON.parse(bridge.status(session.threadId).sessions[0].lastAnswer),
  ).toEqual({ answers: { choice: { answers: ["A"] } } });
});

test("interruption clears pending questions and nonblocking questions keep a running status", async () => {
  const { bridge } = fixture();
  const session = await bridge.start({ cwd, prompt: "nonblocking_question" });
  await until(
    () => bridge.status(session.threadId).sessions[0].questions.length > 0,
  );
  expect(bridge.status(session.threadId).sessions[0].status).toBe("running");
  await bridge.stop(session.threadId);
  await until(
    () => bridge.status(session.threadId).sessions[0].status === "interrupted",
  );
  expect(bridge.status(session.threadId).sessions[0].questions).toEqual([]);
});

test("unsupported server requests receive an explicit error instead of hanging", async () => {
  const { bridge } = fixture();
  const session = await bridge.start({ cwd, prompt: "unsupported" });
  await until(
    () => bridge.status(session.threadId).sessions[0].status === "completed",
  );
  expect(bridge.status(session.threadId).sessions[0].lastAnswer).toContain(
    "does not support",
  );
});

test("model errors, invalid directories, unknown threads, and rejected turns remain visible", async () => {
  const { bridge } = fixture();
  await expect(bridge.start({ cwd: ".", prompt: "work" })).rejects.toThrow(
    "absolute",
  );
  await expect(
    bridge.start({ cwd: resolve(import.meta.filename), prompt: "work" }),
  ).rejects.toThrow("directory");
  await expect(
    bridge.start({ cwd, prompt: "work", model: "missing" }),
  ).rejects.toThrow("model unavailable");
  await expect(
    bridge.start({ cwd, prompt: "work", serviceTier: "missing" }),
  ).rejects.toThrow("service tier unavailable");
  expect(() => bridge.status("missing")).toThrow("Unknown thread");
  await expect(bridge.start({ cwd, prompt: "fail" })).rejects.toThrow(
    "turn rejected",
  );
  expect(
    bridge.status().sessions.some((session) => session.status === "failed"),
  ).toBe(true);
  const failed = await bridge.start({ cwd, prompt: "failed" });
  expect(failed.status).toBe("failed");
  expect(
    bridge.events().events.some((event) => event.text === "failed upstream"),
  ).toBe(true);
});

test("resume attaches saved history and active turn IDs; model catalog supports pagination", async () => {
  const { bridge } = fixture();
  const catalog = await bridge.models();
  expect(catalog.nextCursor).toBe("page2");
  expect(
    (await bridge.models(catalog.nextCursor ?? undefined)).nextCursor,
  ).toBeNull();
  await bridge.resume("saved");
  expect(bridge.status("saved").sessions[0].lastAnswer).toBe("saved answer");
  expect(await bridge.resume("saved")).toEqual(
    bridge.status("saved").sessions[0],
  );
  await bridge.resume("active");
  expect((await bridge.resume("paged")).lastAnswer).toBe("page answer");
  expect(bridge.status("active").sessions[0].turnId).toBe("resumed-turn");
  expect((await bridge.message("active", "hello")).mode).toBe("steered");
});

test("the sandbox defaults to danger-full-access and an explicit mode reaches Codex on start and resume", async () => {
  const { bridge } = fixture();
  const full = await bridge.start({ cwd, prompt: "sandbox" });
  expect(full.sandbox).toBe("danger-full-access");
  expect(full.lastAnswer).toBe("danger-full-access");
  const readOnly = await bridge.start({
    cwd,
    prompt: "sandbox",
    sandbox: "read-only",
  });
  expect(readOnly.sandbox).toBe("read-only");
  expect(readOnly.lastAnswer).toBe("read-only");
  expect((await bridge.resume("saved")).sandbox).toBe("danger-full-access");
  expect(
    (await bridge.resume("workspace", { sandbox: "workspace-write" })).sandbox,
  ).toBe("workspace-write");
  await bridge.message("workspace", "sandbox");
  expect(bridge.status("workspace").sessions[0].lastAnswer).toBe(
    "workspace-write",
  );
  expect((await bridge.resume("workspace")).sandbox).toBe("workspace-write");
  expect(
    (await bridge.resume("workspace", { sandbox: "workspace-write" })).sandbox,
  ).toBe("workspace-write");
  await expect(
    bridge.resume("workspace", { sandbox: "danger-full-access" }),
  ).rejects.toThrow("already attached with sandbox workspace-write");
});

test("a sandbox limit is the default for starts and resumes and refuses wider modes", async () => {
  const { bridge } = fixture(undefined, undefined, 200, {
    configured: {
      sandbox: "workspace-write",
    },
  });
  const started = await bridge.start({ cwd, prompt: "sandbox" });
  expect(started.sandbox).toBe("workspace-write");
  expect(started.lastAnswer).toBe("workspace-write");
  expect(
    (await bridge.start({ cwd, prompt: "sandbox", sandbox: "read-only" }))
      .lastAnswer,
  ).toBe("read-only");
  await expect(
    bridge.start({ cwd, prompt: "sandbox", sandbox: "danger-full-access" }),
  ).rejects.toThrow(
    "sandbox danger-full-access is wider than workspace-write, the maximum set by CODEX_BRIDGE_SANDBOX",
  );
  expect((await bridge.resume("saved")).sandbox).toBe("workspace-write");
  await bridge.message("saved", "sandbox");
  expect(bridge.status("saved").sessions[0].lastAnswer).toBe("workspace-write");
  await expect(
    bridge.resume("other", { sandbox: "danger-full-access" }),
  ).rejects.toThrow("wider than workspace-write");
  expect(() => bridge.status("other")).toThrow("Unknown thread");
  expect(
    (await bridge.resume("narrow", { sandbox: "read-only" })).sandbox,
  ).toBe("read-only");
});

test("approval settings default to never with no reviewer and explicit values reach Codex on start and resume", async () => {
  const { bridge } = fixture();
  const settings = async (threadId: string) => {
    await until(() =>
      ["completed", "idle"].includes(
        bridge.status(threadId).sessions[0].status,
      ),
    );
    return JSON.parse(bridge.status(threadId).sessions[0].lastAnswer);
  };
  const plain = await bridge.start({ cwd, prompt: "thread_settings" });
  expect(plain).toMatchObject({
    approvalPolicy: "never",
    approvalsReviewer: null,
  });
  expect(await settings(plain.threadId)).toEqual({
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    approvalsReviewer: "absent",
  });
  const asking = await bridge.start({
    cwd,
    prompt: "thread_settings",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
  });
  expect(await settings(asking.threadId)).toMatchObject({
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
  });
  expect(
    await bridge.resume("strict", {
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
    }),
  ).toMatchObject({ approvalPolicy: "untrusted", approvalsReviewer: "user" });
  await bridge.message("strict", "thread_settings");
  expect(await settings("strict")).toMatchObject({
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
  });
  expect(
    (await bridge.resume("strict", { approvalPolicy: "untrusted" }))
      .approvalPolicy,
  ).toBe("untrusted");
  await expect(
    bridge.resume("strict", { approvalPolicy: "never" }),
  ).rejects.toThrow("already attached with approvalPolicy untrusted");
  await expect(
    bridge.resume("strict", { approvalsReviewer: "auto_review" }),
  ).rejects.toThrow("already attached with approvalsReviewer user");
  await bridge.resume("saved");
  await expect(
    bridge.resume("saved", { approvalsReviewer: "user" }),
  ).rejects.toThrow("already attached with approvalsReviewer unset");
});

test("configured approval defaults apply to starts and resumes that omit them", async () => {
  const { bridge } = fixture(undefined, undefined, 200, {
    configured: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    },
  });
  const started = await bridge.start({ cwd, prompt: "thread_settings" });
  await until(
    () => bridge.status(started.threadId).sessions[0].status === "completed",
  );
  expect(
    JSON.parse(bridge.status(started.threadId).sessions[0].lastAnswer),
  ).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "user" });
  expect(await bridge.resume("saved")).toMatchObject({
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  });
});

async function approval(bridge: Bridge, prompt: string) {
  const session = await bridge.start({
    cwd,
    prompt,
    approvalPolicy: "on-request",
  });
  await until(
    () => bridge.status(session.threadId).sessions[0].approvals.length > 0,
  );
  const status = bridge.status(session.threadId).sessions[0];
  return { threadId: session.threadId, status, ...status.approvals[0] };
}

async function answered(bridge: Bridge, threadId: string) {
  await until(() => bridge.status(threadId).sessions[0].status === "completed");
  return JSON.parse(bridge.status(threadId).sessions[0].lastAnswer);
}

test("a command approval surfaces as an event, waits, and codex_approve sends the decision", async () => {
  const { bridge, events } = fixture();
  const { threadId, requestId, status } = await approval(
    bridge,
    "approve_command",
  );
  expect(status.status).toBe("waiting_approval");
  const event = events.find((event) => event.kind === "approval");
  expect(JSON.parse(event?.text ?? "{}")).toMatchObject({
    requestId,
    method: "item/commandExecution/requestApproval",
    command: "curl https://example.com",
    reason: "Needs network access",
  });
  expect(() => bridge.answer(threadId, requestId, { choice: ["A"] })).toThrow(
    "expired question",
  );
  expect(() => bridge.approve("other", requestId, "accept")).toThrow(
    "expired approval",
  );
  expect(() => bridge.approve(threadId, requestId, "acceptForSession")).toThrow(
    "does not offer acceptForSession for this request; it offers accept, cancel",
  );
  bridge.approve(threadId, requestId, "accept");
  expect(bridge.status(threadId).sessions[0]).toMatchObject({
    status: "running",
    approvals: [],
  });
  expect(() => bridge.approve(threadId, requestId, "accept")).toThrow(
    "expired approval",
  );
  expect(await answered(bridge, threadId)).toEqual({ decision: "accept" });
});

test("refusals are sent even when Codex does not list them", async () => {
  const { bridge } = fixture();
  for (const decision of ["decline", "cancel"] as const) {
    const { threadId, requestId } = await approval(bridge, "approve_command");
    bridge.approve(threadId, requestId, decision);
    expect(await answered(bridge, threadId)).toEqual({ decision });
  }
});

test("a file change approval carries the latest proposed diff", async () => {
  const { bridge } = fixture();
  const { threadId, requestId, changes } = await approval(
    bridge,
    "approve_file",
  );
  expect(changes).toEqual([
    { path: "a.txt", kind: { type: "add" }, diff: "+b" },
  ]);
  bridge.approve(threadId, requestId, "acceptForSession");
  expect(await answered(bridge, threadId)).toEqual({
    decision: "acceptForSession",
  });
  // The fixture completed that turn without completing the file change item,
  // so a later request for the same item ID has no diff to show.
  const later = await approval(bridge, "approve_file_unstarted");
  expect(later.changes).toBeUndefined();
});

test("a permissions approval grants the requested profile or nothing", async () => {
  const { bridge } = fixture();
  let request = await approval(bridge, "approve_permissions");
  expect(() =>
    bridge.approve(request.threadId, request.requestId, "cancel"),
  ).toThrow("accept, acceptForSession or decline");
  bridge.approve(request.threadId, request.requestId, "acceptForSession");
  expect(await answered(bridge, request.threadId)).toEqual({
    permissions: { network: { enabled: true } },
    scope: "session",
  });
  request = await approval(bridge, "approve_permissions");
  bridge.approve(request.threadId, request.requestId, "decline");
  expect(await answered(bridge, request.threadId)).toEqual({
    permissions: {},
    scope: "turn",
  });
});

test("an approval answered by another client clears without a response", async () => {
  const { bridge } = fixture();
  const { threadId, requestId } = await approval(bridge, "approve_elsewhere");
  await until(
    () =>
      bridge.status(threadId).sessions[0].lastAnswer === "answered elsewhere",
  );
  expect(bridge.status(threadId).sessions[0].approvals).toEqual([]);
  expect(() => bridge.approve(threadId, requestId, "accept")).toThrow(
    "expired approval",
  );
});

test("interruption clears pending approvals", async () => {
  const { bridge } = fixture();
  const { threadId } = await approval(bridge, "approve_command");
  await bridge.stop(threadId);
  await until(
    () => bridge.status(threadId).sessions[0].status === "interrupted",
  );
  expect(bridge.status(threadId).sessions[0].approvals).toEqual([]);
});

test("an approval request for a thread the bridge does not know is rejected", async () => {
  const { bridge, events } = fixture();
  const { threadId } = await bridge.start({
    cwd,
    prompt: "approve_unknown_thread",
  });
  expect(await answered(bridge, threadId)).toEqual({
    code: -32601,
    message:
      "Bridge does not support Codex request: item/commandExecution/requestApproval",
  });
  expect(events.some((event) => event.kind === "approval")).toBe(false);
  expect(() => bridge.status("ghost")).toThrow("Unknown thread");
});

test("an app-server failure clears pending approvals", async () => {
  const { bridge } = fixture();
  const { threadId, requestId } = await approval(bridge, "approve_then_crash");
  await until(
    () => bridge.status(threadId).sessions[0].status === "unavailable",
  );
  expect(bridge.status(threadId).sessions[0].approvals).toEqual([]);
  expect(() => bridge.approve(threadId, requestId, "decline")).toThrow(
    "expired approval",
  );
});

test("closing drops pending questions and approvals and refuses later answers", async () => {
  const { bridge } = fixture();
  const { threadId, requestId } = await approval(bridge, "approve_command");
  const asked = await bridge.start({ cwd, prompt: "question" });
  await until(
    () => bridge.status(asked.threadId).sessions[0].questions.length > 0,
  );
  const question = bridge.status(asked.threadId).sessions[0].questions[0];
  await bridge.close();
  expect(bridge.status()).toMatchObject({
    failure: "Bridge closed",
    sessions: [
      { status: "unavailable", approvals: [], questions: [] },
      { status: "unavailable", approvals: [], questions: [] },
    ],
  });
  expect(() => bridge.approve(threadId, requestId, "decline")).toThrow(
    "Bridge closed",
  );
  expect(() =>
    bridge.answer(asked.threadId, question.requestId, { choice: ["A"] }),
  ).toThrow("Bridge closed");
});

test("auto-review decisions surface as events", async () => {
  const { bridge, events } = fixture();
  await bridge.start({ cwd, prompt: "auto_review" });
  await until(() => events.some((event) => event.kind === "auto_review"));
  expect(
    JSON.parse(
      events.find((event) => event.kind === "auto_review")?.text ?? "",
    ),
  ).toMatchObject({
    status: "denied",
    rationale: "Sends data to an unknown host",
    action: { type: "command", command: "curl" },
  });
});

test("bounded journal signals eviction and oversized final answers signal truncation", async () => {
  const { bridge } = fixture(undefined, undefined, 2);
  const session = await bridge.start({ cwd, prompt: "long" });
  expect(session.lastAnswer.length).toBe(64_000);
  expect(session.answerTruncated).toBe(true);
  const journal = bridge.events();
  expect(journal.events.length).toBe(2);
  expect(journal.gap).toBe(true);
  expect(journal.events[0].truncated).toBe(true);
  expect(bridge.events(journal.latestSequence).events).toEqual([]);
  expect(bridge.events(journal.latestSequence).gap).toBe(false);
});

test("events page oldest first, 50 at a time by default", async () => {
  const { bridge, events: all } = fixture();
  const completed = () => all.filter((event) => event.kind === "completed");
  const { threadId } = await bridge.start({ cwd, prompt: "instant" });
  for (let turn = 1; turn < 25; turn++) {
    await until(() => completed().length === turn);
    await bridge.message(threadId, "instant");
  }
  await until(() => completed().length === 25);
  expect(all.length).toBeGreaterThan(70);
  const first = bridge.events();
  expect(first.events).toEqual(all.slice(0, 50));
  expect(first).toMatchObject({ more: true, gap: false });
  const after = first.events.at(-1)?.sequence ?? 0;
  const second = bridge.events(after, 10);
  expect(second.events).toEqual(all.slice(50, 60));
  expect(second.more).toBe(true);
  const rest = bridge.events(second.events.at(-1)?.sequence);
  expect(rest.events).toEqual(all.slice(60));
  expect(rest).toMatchObject({
    more: false,
    gap: false,
    latestSequence: all.at(-1)?.sequence,
  });
});

test("events stop early at the text budget", async () => {
  const { bridge } = fixture();
  const { threadId } = await bridge.start({ cwd, prompt: "long" });
  for (let turn = 1; turn < 3; turn++) {
    await until(
      () => bridge.status(threadId).sessions[0].status === "completed",
    );
    await bridge.message(threadId, "long");
  }
  await until(() => bridge.status(threadId).sessions[0].status === "completed");
  const page = bridge.events();
  const size = page.events.reduce((sum, event) => sum + event.text.length, 0);
  expect(size).toBeLessThanOrEqual(20_000);
  expect(page.events.filter((event) => event.kind === "message").length).toBe(
    2,
  );
  expect(page.more).toBe(true);
  const rest = bridge.events(page.events.at(-1)?.sequence);
  expect(rest.events[0].kind).toBe("message");
  expect(rest.more).toBe(false);
});

test("notification write failure retains the journal for recovery", async () => {
  const { bridge } = fixture(undefined, async () => {
    throw new Error("channel disconnected");
  });
  await bridge.start({ cwd, prompt: "instant" });
  await until(() => bridge.channelError !== null);
  expect(bridge.status().channelError).toContain("channel disconnected");
  expect(bridge.events().events.at(-1)?.kind).toBe("completed");
});

test("event log mirrors the journal as one JSON line per event", async () => {
  const directory = await temporaryDirectory();
  const eventLog = join(directory, "nested", "events.jsonl");
  const { bridge, events } = fixture(undefined, undefined, 200, { eventLog });
  expect(readFileSync(eventLog, "utf8")).toBe("");
  expect(statSync(join(directory, "nested")).mode & 0o777).toBe(0o700);
  expect(statSync(eventLog).mode & 0o777).toBe(0o600);
  const session = await bridge.start({ cwd, prompt: "work" });
  await bridge.message(session.threadId, "first line\nsecond line");
  await until(() => events.some((event) => event.kind === "completed"));
  expect(events.some((event) => event.text.includes("\n"))).toBe(true);
  const lines = readFileSync(eventLog, "utf8").split("\n");
  expect(lines.pop()).toBe("");
  expect(lines.map((line) => JSON.parse(line))).toEqual(bridge.events().events);
  expect(events).toEqual(bridge.events().events);
  expect(bridge.status()).toMatchObject({ eventLog, eventLogError: null });
});

test("event log refuses a file already at its path and the bridge keeps working", async () => {
  const directory = await temporaryDirectory();
  const eventLog = join(directory, "events.jsonl");
  writeFileSync(eventLog, "planted\n");
  const { bridge, events } = fixture(undefined, undefined, 200, { eventLog });
  await bridge.start({ cwd, prompt: "instant" });
  await until(() => events.some((event) => event.kind === "completed"));
  expect(readFileSync(eventLog, "utf8")).toBe("planted\n");
  expect(bridge.status()).toMatchObject({
    eventLog,
    eventLogError: expect.stringContaining("EEXIST"),
    channelError: null,
  });
});

test("event log refuses a relative path", () => {
  const { bridge } = fixture(undefined, undefined, 200, {
    eventLog: "logs/events.jsonl",
  });
  expect(bridge.status().eventLogError).toContain(
    "event log directory must be absolute: logs",
  );
});

test("a cursor from an earlier bridge process reports a gap", async () => {
  const { bridge, events } = fixture();
  await bridge.start({ cwd, prompt: "instant" });
  await until(() => events.some((event) => event.kind === "completed"));
  const { latestSequence } = bridge.events();
  expect(bridge.events(latestSequence + 1)).toEqual({
    events: [],
    more: false,
    latestSequence,
    gap: true,
  });
});

test("without an event log, status keeps its original fields", () => {
  const { bridge } = fixture();
  expect(Object.keys(bridge.status())).toEqual([
    "sessions",
    "failure",
    "channelError",
    "latestSequence",
  ]);
});

test("process death makes existing sessions unavailable and rejects later control calls", async () => {
  const { bridge } = fixture();
  const session = await bridge.start({ cwd, prompt: "work" });
  await expect(bridge.start({ cwd, prompt: "crash" })).rejects.toThrow(
    "exited",
  );
  expect(bridge.status(session.threadId).sessions[0].status).toBe(
    "unavailable",
  );
  await expect(bridge.stop(session.threadId)).rejects.toThrow("exited");
  await expect(bridge.models()).rejects.toThrow("exited");
});

test.each(["hang", "malformed", "null"])(
  "bad transport fails promptly: %s",
  async (mode) => {
    const { bridge } = fixture(mode);
    await expect(bridge.models()).rejects.toThrow(
      mode === "hang" ? "timed out" : "Invalid Codex protocol",
    );
  },
);

test("missing executable and unconnected requests fail without hanging", async () => {
  const missing = new AppServer({ command: ["/does-not-exist/codex"] });
  await expect(missing.connect()).rejects.toThrow();
  await missing.close();
  const unconnected = new AppServer();
  await expect(unconnected.call("model/list", {})).rejects.toThrow(
    "not connected",
  );
  await unconnected.close();
});

test("shutdown kills a Codex process that ignores SIGTERM", async () => {
  const { bridge, rpc } = fixture("stubborn");
  await bridge.models();
  await bridge.close();
  await expect(rpc.call("model/list", {})).rejects.toThrow("closed");
});

test("wait returns on a Codex message while the turn keeps running", async () => {
  const { bridge } = fixture();
  const { threadId } = await bridge.start({ cwd, prompt: "message" });
  const result = await bridge.wait(threadId);
  expect(result.timedOut).toBe(false);
  expect(result.status).toBe("running");
  expect(result.events.map((event) => [event.kind, event.text])).toEqual([
    ["message", "interim"],
  ]);
  expect(result).not.toHaveProperty("lastAnswer");
  expect(result.latestSequence).toBe(bridge.status().latestSequence);
});

test("wait returns a Codex message longer than the journal's 8,000 characters whole", async () => {
  const { bridge } = fixture();
  const { threadId } = await bridge.start({ cwd, prompt: "long_message" });
  const result = await bridge.wait(threadId);
  expect(result.events).toEqual([
    expect.objectContaining({
      kind: "message",
      text: "y".repeat(12_000),
      truncated: false,
    }),
  ]);
  const journaled = bridge.events().events.find((e) => e.kind === "message");
  expect(journaled?.text.length).toBe(8_000);
});

test("wait ignores progress and activity and times out without events", async () => {
  const { bridge } = fixture();
  const { threadId } = await bridge.start({ cwd, prompt: "work" });
  const result = await bridge.wait(threadId, 0, 100);
  expect(result.timedOut).toBe(true);
  expect(result.events).toEqual([]);
  const kinds = bridge.events().events.map((event) => event.kind);
  expect(kinds).toContain("progress");
  expect(kinds).toContain("activity");
  expect(kinds).toContain("activity_completed");
  expect(result.latestSequence).toBe(bridge.status().latestSequence);
});

test("wait returns at once for a thread with no running turn", async () => {
  const { bridge } = fixture();
  const { threadId } = await bridge.start({ cwd, prompt: "instant" });
  const started = Date.now();
  const latest = await bridge.wait(threadId);
  expect(Date.now() - started).toBeLessThan(50);
  expect(latest).toMatchObject({
    status: "completed",
    timedOut: false,
    events: [],
    lastAnswer: "finished",
  });
  expect(
    (await bridge.wait(threadId, 0)).events.map((event) => event.kind),
  ).toEqual(["message", "completed"]);
});

test("wait returns on a question with the pending question", async () => {
  const { bridge } = fixture();
  const { threadId } = await bridge.start({ cwd, prompt: "question" });
  const result = await bridge.wait(threadId, 0);
  expect(result.status).toBe("waiting_input");
  expect(result.events.map((event) => event.kind)).toEqual(["question"]);
  expect(result.questions[0].params.questions[0].id).toBe("choice");
});

test("looping wait from latestSequence follows a turn to its end and lastAnswer", async () => {
  const { bridge } = fixture();
  const { threadId } = await bridge.start({ cwd, prompt: "work" });
  const first = bridge.wait(threadId, 0);
  await bridge.message(threadId, "go");
  const kinds: string[] = [];
  let result = await first;
  for (;;) {
    kinds.push(...result.events.map((event) => event.kind));
    if (result.status !== "running") break;
    result = await bridge.wait(threadId, result.latestSequence);
  }
  expect(kinds).toEqual(["message", "completed"]);
  expect(result).toMatchObject({
    status: "completed",
    lastAnswer: "steered: go",
    answerTruncated: false,
  });
});

test("wait resolves when the bridge closes or Codex exits", async () => {
  const { bridge } = fixture();
  const one = await bridge.start({ cwd, prompt: "work" });
  const crashed = bridge.wait(one.threadId);
  await expect(bridge.start({ cwd, prompt: "crash" })).rejects.toThrow(
    "exited",
  );
  const result = await crashed;
  expect(result.status).toBe("unavailable");
  expect(result.events.map((event) => event.kind)).toEqual(["unavailable"]);

  const other = fixture().bridge;
  const two = await other.start({ cwd, prompt: "work" });
  const closing = other.wait(two.threadId);
  await other.close();
  expect((await closing).timedOut).toBe(false);
  expect((await other.wait(two.threadId)).timedOut).toBe(false);
});

test("wait rejects a timeout above the maximum", async () => {
  const { bridge } = fixture();
  const { threadId } = await bridge.start({ cwd, prompt: "instant" });
  await expect(bridge.wait(threadId, undefined, 110_001)).rejects.toThrow(
    "at most 110000",
  );
});

test("concurrent waits on one thread all return, and other threads keep waiting", async () => {
  const { bridge } = fixture();
  const quiet = await bridge.start({ cwd, prompt: "work" });
  const chatty = await bridge.start({ cwd, prompt: "message" });
  const [a, b, c] = await Promise.all([
    bridge.wait(chatty.threadId),
    bridge.wait(chatty.threadId),
    bridge.wait(quiet.threadId, undefined, 100),
  ]);
  expect(a.events.map((event) => event.text)).toEqual(["interim"]);
  expect(b.events).toEqual(a.events);
  expect(c.timedOut).toBe(true);
});

test("wait returns on an approval request with the pending approval", async () => {
  const { bridge } = fixture();
  const { threadId } = await bridge.start({
    cwd,
    prompt: "approve_command",
    approvalPolicy: "on-request",
  });
  const result = await bridge.wait(threadId, 0);
  expect(result.status).toBe("waiting_approval");
  expect(result.events.map((event) => event.kind)).toEqual(["approval"]);
  expect(result.approvals).toEqual([
    expect.objectContaining({
      method: "item/commandExecution/requestApproval",
    }),
  ]);
  expect(result.approvals[0]).not.toHaveProperty("changes");
});

test("wait returns auto_review events without waking for them", async () => {
  const { bridge } = fixture();
  const running = await bridge.start({ cwd, prompt: "auto_review_running" });
  const quiet = await bridge.wait(running.threadId, 0, 100);
  expect(quiet.timedOut).toBe(true);
  expect(quiet.events.map((event) => event.kind)).toEqual(["auto_review"]);
  const done = await bridge.start({ cwd, prompt: "auto_review" });
  expect(
    (await bridge.wait(done.threadId, 0)).events.map((event) => event.kind),
  ).toEqual(["auto_review", "message", "completed"]);
});
