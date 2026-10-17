import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { AppServer } from "../src/app-server.ts";
import { main } from "../src/index.ts";
import { createServer } from "../src/server.ts";

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

async function connect(eventLogDir = "") {
  const rpc = new AppServer([
    process.execPath,
    resolve(import.meta.dirname, "fixtures/app-server.ts"),
  ]);
  const { server, bridge } = createServer(rpc, 5, eventLogDir);
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
});

test("an event log directory gets a per-process file named in the instructions and status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-log-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const { client, call, events } = await connect(join(directory, "logs"));
  const [file] = readdirSync(join(directory, "logs"));
  expect(file).toMatch(new RegExp(`^codex-bridge-.*-${process.pid}\\.jsonl$`));
  const eventLog = join(directory, "logs", file);
  expect(client.getInstructions()).toContain(`tail -n 0 -F '${eventLog}'`);
  expect(await call("codex_status")).toMatchObject({
    eventLog,
    eventLogError: null,
  });
  await call("codex_start", { cwd: process.cwd(), prompt: "instant" });
  await sleep(10);
  const lines = readFileSync(eventLog, "utf8").trimEnd().split("\n");
  expect(lines.map((line) => JSON.parse(line).sequence)).toEqual(
    events.map((event) => Number(event.meta.sequence)),
  );
});

test("without an event log directory the instructions do not mention a file", async () => {
  const { client } = await connect();
  expect(client.getInstructions()).not.toContain("Monitor");
  expect(client.getInstructions()).toMatch(/approvalPolicy never\.$/);
});
