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

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "ccb-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// A shared app-server like Codex's daemon: one fixture app-server behind a
// WebSocket endpoint on a Unix socket. Connections take turns in these tests,
// so every connection receives every message.
async function startDaemon(directory?: string) {
  const socketPath = join(directory ?? (await tempDirectory()), "control.sock");
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
  // Ends every proxy connection; the daemon and its turns keep running.
  const drop = () => {
    for (const client of server.clients) client.terminate();
  };
  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= (async () => {
      backend.kill();
      drop();
      await new Promise((done) => server.close(done));
      await new Promise((done) => http.close(done));
    })();
    return stopped;
  };
  cleanups.push(stop);
  return { socketPath, backend, methods, drop, stop };
}

function proxied(socketPath: string) {
  const events: BridgeEvent[] = [];
  const rpc = new AppServer({
    command: [process.execPath, join(fixtures, "proxy.ts"), socketPath],
    daemon: true,
    timeoutMs: 2_000,
  });
  const bridge = new Bridge(rpc, async (event) => {
    events.push(event);
  });
  cleanups.push(() => bridge.close());
  return { bridge, events };
}

test("CODEX_BRIDGE_APP_SERVER chooses a private app-server or the daemon proxy", () => {
  expect(appServerConfig({})).toEqual({
    command: ["codex", "app-server", "--listen", "stdio://"],
    daemon: false,
  });
  expect(appServerConfig({ CODEX_BRIDGE_APP_SERVER: "daemon" })).toEqual({
    command: ["codex", "app-server", "proxy"],
    daemon: true,
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

test("after a dropped connection the next call reconnects and reattaches the running turn", async () => {
  const daemon = await startDaemon();
  const { bridge, events } = proxied(daemon.socketPath);
  const session = await bridge.start({
    cwd: process.cwd(),
    prompt: "question",
  });
  await until(() => events.some((event) => event.kind === "question"));
  const { requestId } = bridge.status(session.threadId).sessions[0]
    .questions[0];

  daemon.drop();
  await until(() => events.some((event) => event.kind === "unavailable"));
  expect(events.find((event) => event.kind === "unavailable")?.text).toContain(
    "1 pending question(s) lost",
  );
  expect(bridge.status(session.threadId).sessions[0].status).toBe(
    "unavailable",
  );
  expect(() =>
    bridge.answer(session.threadId, requestId, { choice: ["A"] }),
  ).toThrow("Unknown or expired question");

  expect((await bridge.message(session.threadId, "after")).mode).toBe(
    "steered",
  );
  expect(events.find((event) => event.kind === "reconnected")?.text).toBe(
    "Reattached: running",
  );
  expect(bridge.failure).toBeNull();
  await until(() => events.some((event) => event.kind === "completed"));
  expect(bridge.status(session.threadId).sessions[0].lastAnswer).toBe(
    "steered: after",
  );
});

test("resume reattaches a session after the daemon restarts", async () => {
  const directory = await tempDirectory();
  const first = await startDaemon(directory);
  const { bridge } = proxied(first.socketPath);
  const session = await bridge.start({ cwd: process.cwd(), prompt: "work" });

  await first.stop();
  await until(
    () => bridge.status(session.threadId).sessions[0].status === "unavailable",
  );
  await expect(bridge.resume(session.threadId)).rejects.toThrow();

  // The restarted fixture daemon has no record of the turn, like a daemon
  // whose restart ended it.
  await startDaemon(directory);
  const resumed = await bridge.resume(session.threadId);
  expect(resumed.status).toBe("completed");
  expect(resumed.lastAnswer).toBe("saved answer");
});

test("a daemon that is down at startup is reached once it starts", async () => {
  const directory = await tempDirectory();
  const { bridge } = proxied(join(directory, "control.sock"));
  await expect(bridge.models()).rejects.toThrow();
  expect(bridge.failure).toBeTruthy();
  await expect(bridge.models()).rejects.toThrow();

  await startDaemon(directory);
  expect((await bridge.models()).data[0].id).toBe("fixture");
  expect(bridge.failure).toBeNull();
});
