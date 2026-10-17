import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { AppServer, appServerConfig } from "../src/app-server.ts";
import { Bridge, type BridgeEvent } from "../src/bridge.ts";

const fixtures = resolve(import.meta.dirname, "fixtures");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met");
    await sleep(5);
  }
}

// A shared app-server like Codex's daemon: one fixture app-server behind a
// WebSocket endpoint on a Unix socket. Connections take turns in these tests,
// so every connection receives every message.
async function startDaemon() {
  const directory = await mkdtemp(join(tmpdir(), "ccb-"));
  const socketPath = join(directory, "control.sock");
  const backend = spawn(process.execPath, [join(fixtures, "app-server.ts")], {
    stdio: "pipe",
  });
  const methods: string[] = [];
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  server.on("connection", (client) =>
    client.on("message", (data) => {
      methods.push(JSON.parse(String(data)).method);
      backend.stdin.write(`${data}\n`);
    }),
  );
  createInterface({ input: backend.stdout }).on("line", (line) => {
    for (const client of server.clients) client.send(line);
  });
  await new Promise<void>((done) => http.listen(socketPath, done));
  cleanups.push(async () => {
    backend.kill();
    for (const client of server.clients) client.terminate();
    await new Promise((done) => server.close(done));
    await new Promise((done) => http.close(done));
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, backend, methods };
}

function proxied(socketPath: string) {
  const events: BridgeEvent[] = [];
  const rpc = new AppServer(
    [process.execPath, join(fixtures, "proxy.ts"), socketPath],
    2_000,
    "websocket",
  );
  const bridge = new Bridge(rpc, async (event) => {
    events.push(event);
  });
  cleanups.push(() => bridge.close());
  return { bridge, events };
}

test("CODEX_BRIDGE_APP_SERVER chooses a private app-server or the daemon proxy", () => {
  expect(appServerConfig({})).toEqual({
    command: ["codex", "app-server", "--listen", "stdio://"],
    framing: "jsonl",
  });
  expect(appServerConfig({ CODEX_BRIDGE_APP_SERVER: "daemon" })).toEqual({
    command: ["codex", "app-server", "proxy"],
    framing: "websocket",
  });
  expect(() => appServerConfig({ CODEX_BRIDGE_APP_SERVER: "shared" })).toThrow(
    'must be unset or "daemon"',
  );
});

test("closing a bridge on the daemon leaves its turn running for the next connection", async () => {
  const daemon = await startDaemon();
  const first = proxied(daemon.socketPath);
  const session = await first.bridge.start({
    cwd: process.cwd(),
    prompt: "work",
  });
  await until(() => first.events.some((event) => event.kind === "progress"));

  await first.bridge.close();
  expect(daemon.methods).not.toContain("turn/interrupt");
  expect(daemon.backend.exitCode).toBeNull();

  const second = proxied(daemon.socketPath);
  const resumed = await second.bridge.resume(session.threadId);
  expect(resumed.status).toBe("running");
  expect((await second.bridge.message(session.threadId, "after")).mode).toBe(
    "steered",
  );
  await until(() => second.events.some((event) => event.kind === "completed"));
  expect(second.bridge.status(session.threadId).sessions[0].lastAnswer).toBe(
    "steered: after",
  );
});

test("a proxy that cannot reach the daemon fails the connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ccb-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const { bridge } = proxied(join(directory, "missing.sock"));
  await expect(bridge.models()).rejects.toThrow();
  expect(bridge.failure).toBeTruthy();
  await expect(bridge.models()).rejects.toThrow();
});
