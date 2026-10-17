import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import type { ClientRequest } from "../.generated/ClientRequest.ts";
import type { InitializeResponse } from "../.generated/InitializeResponse.ts";
import type { ServerNotification } from "../.generated/ServerNotification.ts";
import type { ServerRequest } from "../.generated/ServerRequest.ts";
import type { ModelListResponse } from "../.generated/v2/ModelListResponse.ts";
import type { ThreadResumeResponse } from "../.generated/v2/ThreadResumeResponse.ts";
import type { ThreadStartResponse } from "../.generated/v2/ThreadStartResponse.ts";
import type { TurnStartResponse } from "../.generated/v2/TurnStartResponse.ts";
import type { TurnSteerResponse } from "../.generated/v2/TurnSteerResponse.ts";
import manifest from "../package.json" with { type: "json" };

type Results = {
  initialize: InitializeResponse;
  "model/list": ModelListResponse;
  "thread/start": ThreadStartResponse;
  "thread/resume": ThreadResumeResponse;
  "turn/start": TurnStartResponse;
  "turn/steer": TurnSteerResponse;
  "turn/interrupt": Record<string, never>;
};
type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type AppServerConfig = {
  command?: readonly string[];
  // The shared daemon (`codex app-server daemon start`) runs turns outside
  // this process. The bridge reaches it through `codex app-server proxy`,
  // which pipes bytes to the daemon's control socket; that socket speaks
  // JSON-RPC over WebSocket rather than one JSON message per line.
  daemon?: boolean;
  timeoutMs?: number;
};

const privateCommand = ["codex", "app-server", "--listen", "stdio://"] as const;

// CODEX_BRIDGE_APP_SERVER unset starts a private app-server that exits with
// the bridge; "daemon" uses the shared daemon, whose turns outlive the bridge.
export function appServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppServerConfig {
  const mode = env.CODEX_BRIDGE_APP_SERVER;
  if (!mode) return { command: privateCommand, daemon: false };
  if (mode === "daemon")
    return { command: ["codex", "app-server", "proxy"], daemon: true };
  throw new Error(
    `CODEX_BRIDGE_APP_SERVER must be unset or "daemon", not ${JSON.stringify(mode)}`,
  );
}

export class AppServer {
  onNotification?: (event: ServerNotification) => void;
  onRequest?: (request: ServerRequest) => void;
  onFailure?: (error: Error) => void;
  // Runs after every successful initialize, before connect() resolves.
  onConnect?: () => Promise<void>;
  private command: readonly string[];
  private daemon: boolean;
  private timeoutMs: number;
  private child?: ChildProcessWithoutNullStreams;
  private send?: (text: string) => void;
  private ready?: Promise<void>;
  private failure?: Error;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private stopping = false;

  constructor({
    command = privateCommand,
    daemon = false,
    timeoutMs = 30_000,
  }: AppServerConfig = {}) {
    this.command = command;
    this.daemon = daemon;
    this.timeoutMs = timeoutMs;
  }

  connect(): Promise<void> {
    // The daemon's turns outlive a dropped connection, so each call after a
    // failure tries one fresh connection. A private app-server's turns die
    // with it, so its failure is final.
    if (this.failure && this.daemon && !this.stopping) {
      this.child?.kill();
      this.child = undefined;
      this.send = undefined;
      this.failure = undefined;
      this.ready = undefined;
    }
    this.ready ??= this.initialize();
    return this.ready;
  }

  private async initialize() {
    const [command, ...args] = this.command;
    const child = spawn(command, args, { stdio: "pipe" });
    this.child = child;
    // Events from a replaced connection must not touch the current one.
    const fail = (error: Error) => {
      if (this.child === child) this.fail(error);
    };
    const receive = (text: string) => {
      if (this.child === child) this.receive(text);
    };
    child.stderr.pipe(process.stderr, { end: false });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("exit", (code, signal) =>
      fail(new Error(`Codex app-server exited: ${code ?? signal}`)),
    );
    try {
      await this.handshake(child, fail, receive);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    // A failure during the handshake can let a later connect() replace this
    // connection before the handshake returns.
    if (this.child !== child)
      throw new Error("Codex app-server connection closed");
    if (this.failure) throw this.failure;
  }

  private async handshake(
    child: ChildProcessWithoutNullStreams,
    fail: (error: Error) => void,
    receive: (text: string) => void,
  ) {
    if (this.daemon) {
      // Node's built-in WebSocket cannot run over an arbitrary duplex such as
      // the proxy's stdio; `ws` accepts createConnection.
      const socket = new WebSocket("ws://localhost/", {
        createConnection: () =>
          Duplex.from({ readable: child.stdout, writable: child.stdin }),
        handshakeTimeout: this.timeoutMs,
        perMessageDeflate: false,
      });
      socket.on("message", (data) => receive(String(data)));
      socket.on("error", fail);
      socket.on("close", () =>
        fail(new Error("Codex app-server connection closed")),
      );
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
        socket.once("close", () =>
          reject(new Error("Codex app-server connection closed")),
        );
      });
      this.send = (text) => socket.send(text);
    } else {
      createInterface({ input: child.stdout }).on("line", receive);
      this.send = (text) => child.stdin.write(`${text}\n`);
    }
    await this.call("initialize", {
      clientInfo: {
        name: "claude_codex_bridge",
        title: "Claude Codex Bridge",
        version: manifest.version,
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.write({ method: "initialized" });
    await this.onConnect?.();
  }

  call<M extends keyof Results>(
    method: M,
    params: Extract<ClientRequest, { method: M }>["params"],
  ): Promise<Results[M]> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out launch may have succeeded; close the connection instead of retrying it.
        this.fail(new Error(`Codex control request timed out: ${method}`));
        this.child?.kill();
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  respond(id: string | number, result: unknown) {
    this.write({ id, result });
  }

  reject(id: string | number, message: string) {
    this.write({ id, error: { code: -32601, message } });
  }

  private write(message: unknown) {
    if (this.failure) throw this.failure;
    if (!this.send) throw new Error("Codex app-server is not connected");
    this.send(JSON.stringify(message));
  }

  private receive(line: string) {
    try {
      const message = JSON.parse(line);
      if (!message || typeof message !== "object")
        throw new Error("Expected a JSON object");
      if (typeof message.method === "string") {
        if (message.id !== undefined)
          this.onRequest?.(message as ServerRequest);
        else this.onNotification?.(message as ServerNotification);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    } catch (error) {
      this.fail(new Error(`Invalid Codex protocol event: ${String(error)}`));
      this.child?.kill();
    }
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.stopping) this.onFailure?.(error);
  }

  // Ends the child without interrupting turns. For the daemon the child is
  // only the proxy, so the daemon keeps running the bridge's turns.
  async close() {
    this.stopping = true;
    this.fail(new Error("Bridge closed"));
    const child = this.child;
    if (
      !child ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      !child.pid
    )
      return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}
