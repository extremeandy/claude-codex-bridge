import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { AppServer } from "../src/app-server.ts";
import type { SettingsInput } from "../src/bridge.ts";
import { main } from "../src/index.ts";
import { createServer, settingsFromEnv } from "../src/server.ts";

const cleanups: (() => Promise<void>)[] = [];

test("stdio EOF closes the Codex child and shutdown is idempotent", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new AppServer([
    process.execPath,
    resolve(import.meta.dirname, "fixtures/app-server.ts"),
  ]);
  const { bridge, shutdown } = await main(input, output, rpc, {});
  await bridge.models();
  input.end();
  await sleep(10);
  await shutdown();
  await shutdown();
  await expect(rpc.call("model/list", {})).rejects.toThrow("closed");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function connect(configured: SettingsInput = {}) {
  const rpc = new AppServer([
    process.execPath,
    resolve(import.meta.dirname, "fixtures/app-server.ts"),
  ]);
  const { server, bridge } = createServer(rpc, 5, configured);
  const client = new Client({ name: "test", version: "1" });
  const events: { content: string; meta: Record<string, string> }[] = [];
  client.setNotificationHandler(
    z.object({
      method: z.literal("notifications/claude/channel"),
      params: z.object({
        content: z.string(),
        meta: z.record(z.string(), z.string()),
      }),
    }),
    async ({ params }) => {
      events.push(params);
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await bridge.close();
    await client.close();
    await server.close();
  });
  const call = async (name: string, args?: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.structuredContent as Record<string, unknown>;
  };
  return { client, events, call };
}

test("MCP advertises channel capability, typed tools, and nonblocking push events", async () => {
  const { client, call, events } = await connect();
  expect(client.getInstructions()).toContain(
    "(sandbox default danger-full-access;",
  );
  expect(client.getServerCapabilities()?.experimental).toEqual({
    "claude/channel": {},
  });
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toContain("codex_answer");
  expect(tools.tools.every((tool) => tool.inputSchema.type === "object")).toBe(
    true,
  );
  expect((await call("codex_models")).nextCursor).toBe("page2");
  const session = await call("codex_start", {
    cwd: process.cwd(),
    prompt: "work",
  });
  expect(session.status).toBe("running");
  const threadId = session.threadId;
  await sleep(30);
  expect(events.some((event) => event.meta.kind === "progress")).toBe(true);
  expect(
    (await call("codex_message", { threadId, message: "steer over MCP" })).mode,
  ).toBe("steered");
  await sleep(10);
  expect(
    events.some((event) => event.content === "steered: steer over MCP"),
  ).toBe(true);
  expect((await call("codex_stop", { threadId })).requested).toBe(false);
  expect((await call("codex_events")).events).toBeInstanceOf(Array);
  expect((await call("codex_status", { threadId })).sessions).toBeInstanceOf(
    Array,
  );
  await call("codex_resume", { threadId: "saved" });
  expect(
    (await call("codex_resume", { threadId: "readonly", sandbox: "read-only" }))
      .sandbox,
  ).toBe("read-only");
  expect(
    (
      await call("codex_start", {
        cwd: process.cwd(),
        prompt: "sandbox",
        sandbox: "workspace-write",
      })
    ).lastAnswer,
  ).toBe("workspace-write");
});

test("MCP question answer reaches Codex and tool errors use isError", async () => {
  const { call, events, client } = await connect();
  const session = await call("codex_start", {
    cwd: process.cwd(),
    prompt: "question",
  });
  await sleep(15);
  const questionEvent = events.find((event) => event.meta.kind === "question");
  expect(questionEvent).toBeDefined();
  const question = JSON.parse(questionEvent?.content ?? "{}");
  await call("codex_answer", {
    threadId: session.threadId,
    requestId: question.requestId,
    answers: { choice: ["A"] },
  });
  await sleep(10);
  expect(events.some((event) => event.meta.kind === "completed")).toBe(true);
  expect((await client.callTool({ name: "unknown" })).isError).toBe(true);
  expect(
    (
      await client.callTool({
        name: "codex_start",
        arguments: { cwd: process.cwd() },
      })
    ).isError,
  ).toBe(true);
  expect(
    (
      await client.callTool({
        name: "codex_start",
        arguments: { cwd: process.cwd(), prompt: "work", sandbox: "none" },
      })
    ).isError,
  ).toBe(true);
});

test("CODEX_BRIDGE_SANDBOX sets the default and maximum sandbox and rejects empty or unknown modes", async () => {
  expect(settingsFromEnv({}).sandbox).toBeUndefined();
  expect(
    settingsFromEnv({ CODEX_BRIDGE_SANDBOX: "workspace-write" }).sandbox,
  ).toBe("workspace-write");
  for (const value of ["", "readonly"]) {
    const rpc = new AppServer([
      process.execPath,
      resolve(import.meta.dirname, "fixtures/app-server.ts"),
    ]);
    await expect(
      main(new PassThrough(), new PassThrough(), rpc, {
        CODEX_BRIDGE_SANDBOX: value,
      }),
    ).rejects.toThrow(
      "CODEX_BRIDGE_SANDBOX must be one of read-only, workspace-write, danger-full-access",
    );
  }
  const { client, call } = await connect({ sandbox: "workspace-write" });
  expect(client.getInstructions()).toContain(
    "(sandbox default and maximum workspace-write;",
  );
  const tools = (await client.listTools()).tools;
  for (const name of ["codex_start", "codex_resume"])
    expect(tools.find((tool) => tool.name === name)?.description).toContain(
      "defaults to workspace-write, which is also the widest allowed",
    );
  expect(
    tools.find((tool) => tool.name === "codex_status")?.description,
  ).not.toContain("sandbox");
  expect(
    (await call("codex_start", { cwd: process.cwd(), prompt: "sandbox" }))
      .lastAnswer,
  ).toBe("workspace-write");
  expect(
    (
      await call("codex_start", {
        cwd: process.cwd(),
        prompt: "sandbox",
        sandbox: "read-only",
      })
    ).lastAnswer,
  ).toBe("read-only");
  expect(
    (
      await client.callTool({
        name: "codex_resume",
        arguments: { threadId: "saved", sandbox: "danger-full-access" },
      })
    ).isError,
  ).toBe(true);
});

test("approval env defaults are validated and unset keeps never with no reviewer", async () => {
  expect(settingsFromEnv({})).toEqual({});
  for (const [name, options] of [
    ["CODEX_BRIDGE_APPROVAL_POLICY", "untrusted, on-request, never"],
    ["CODEX_BRIDGE_APPROVALS_REVIEWER", "user, auto_review"],
  ]) {
    const rpc = new AppServer([
      process.execPath,
      resolve(import.meta.dirname, "fixtures/app-server.ts"),
    ]);
    await expect(
      main(new PassThrough(), new PassThrough(), rpc, { [name]: "" }),
    ).rejects.toThrow(`${name} must be one of ${options}; got ""`);
  }
  expect(
    settingsFromEnv({
      CODEX_BRIDGE_APPROVAL_POLICY: "on-request",
      CODEX_BRIDGE_APPROVALS_REVIEWER: "auto_review",
    }),
  ).toMatchObject({
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
  });
  expect(() =>
    settingsFromEnv({ CODEX_BRIDGE_APPROVAL_POLICY: "on-failure" }),
  ).toThrow(
    "CODEX_BRIDGE_APPROVAL_POLICY must be one of untrusted, on-request, never",
  );
  expect(() =>
    settingsFromEnv({ CODEX_BRIDGE_APPROVALS_REVIEWER: "guardian_subagent" }),
  ).toThrow("CODEX_BRIDGE_APPROVALS_REVIEWER must be one of user, auto_review");
  const { client } = await connect({
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
  });
  expect(client.getInstructions()).toContain(
    "(sandbox default danger-full-access; approvalPolicy default untrusted; approvalsReviewer default user)",
  );
});

test("MCP approval requests surface as events and codex_approve answers them", async () => {
  const { call, events, client } = await connect();
  expect(client.getInstructions()).toContain(
    "call codex_approve only with the decision the user explicitly gave",
  );
  expect(client.getInstructions()).toContain(
    "can still let a single command run outside the sandbox",
  );
  const approve = (await client.listTools()).tools.find(
    (tool) => tool.name === "codex_approve",
  );
  expect(approve?.description).toContain("Never decide on your own judgment");
  expect(approve?.description).toContain(
    "cannot send Codex's acceptWithExecpolicyAmendment or applyNetworkPolicyAmendment",
  );
  const session = await call("codex_start", {
    cwd: process.cwd(),
    prompt: "approve_command",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  });
  await sleep(15);
  const approvalEvent = events.find((event) => event.meta.kind === "approval");
  const request = JSON.parse(approvalEvent?.content ?? "{}");
  expect(request.command).toBe("curl https://example.com");
  expect(
    (await call("codex_status", { threadId: session.threadId })).sessions,
  ).toMatchObject([{ status: "waiting_approval" }]);
  await call("codex_approve", {
    threadId: session.threadId,
    requestId: request.requestId,
    decision: "decline",
  });
  await sleep(10);
  expect(
    events.some((event) => event.content === '{"decision":"decline"}'),
  ).toBe(true);
  expect(
    (
      await client.callTool({
        name: "codex_approve",
        arguments: {
          threadId: session.threadId,
          requestId: request.requestId,
          decision: "yes",
        },
      })
    ).isError,
  ).toBe(true);
});
