import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import type { SandboxMode } from "../.generated/v2/SandboxMode.ts";
import { AppServer } from "../src/app-server.ts";
import { main } from "../src/index.ts";
import { createServer, sandboxFromEnv } from "../src/server.ts";

const cleanups: (() => Promise<void>)[] = [];

test("stdio EOF closes the Codex child and shutdown is idempotent", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new AppServer([
    process.execPath,
    resolve(import.meta.dirname, "fixtures/app-server.ts"),
  ]);
  const { bridge, shutdown } = await main(input, output, rpc);
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

async function connect(defaultSandbox?: SandboxMode) {
  const rpc = new AppServer([
    process.execPath,
    resolve(import.meta.dirname, "fixtures/app-server.ts"),
  ]);
  const { server, bridge } = createServer(rpc, 5, defaultSandbox);
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

test("CODEX_BRIDGE_SANDBOX sets the default sandbox and rejects unknown modes", async () => {
  expect(sandboxFromEnv(undefined)).toBe("danger-full-access");
  expect(sandboxFromEnv("")).toBe("danger-full-access");
  expect(sandboxFromEnv("workspace-write")).toBe("workspace-write");
  expect(() => sandboxFromEnv("readonly")).toThrow(
    "CODEX_BRIDGE_SANDBOX must be one of read-only, workspace-write, danger-full-access",
  );
  const { client, call } = await connect("read-only");
  expect(client.getInstructions()).toContain("(default read-only)");
  const tools = (await client.listTools()).tools;
  for (const name of ["codex_start", "codex_resume"])
    expect(tools.find((tool) => tool.name === name)?.description).toContain(
      "defaults to read-only",
    );
  expect(
    tools.find((tool) => tool.name === "codex_status")?.description,
  ).not.toContain("sandbox");
  expect(
    (await call("codex_start", { cwd: process.cwd(), prompt: "sandbox" }))
      .lastAnswer,
  ).toBe("read-only");
});
