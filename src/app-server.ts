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
type Framing = "jsonl" | "websocket";
type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const privateCommand = ["codex", "app-server", "--listen", "stdio://"];

/**
 * Chooses the app-server from CODEX_BRIDGE_APP_SERVER. Unset starts a private
 * app-server that exits with the bridge. "daemon" connects to the shared
 * local daemon (`codex app-server daemon start`), whose turns outlive the
 * bridge.
 */
export function appServerConfig(env: NodeJS.ProcessEnv = process.env): {
  command: string[];
  framing: Framing;
} {
  const mode = env.CODEX_BRIDGE_APP_SERVER;
  if (!mode) return { command: [...privateCommand], framing: "jsonl" };
  // The proxy pipes bytes to the daemon's control socket, which speaks
  // JSON-RPC over WebSocket rather than one JSON message per line.
  if (mode === "daemon")
    return { command: ["codex", "app-server", "proxy"], framing: "websocket" };
  throw new Error(
    `CODEX_BRIDGE_APP_SERVER must be unset or "daemon", not ${JSON.stringify(mode)}`,
  );
}

export class AppServer {
  onNotification?: (event: ServerNotification) => void;
  onRequest?: (request: ServerRequest) => void;
  onFailure?: (error: Error) => void;
  private child?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private ready?: Promise<void>;
  private failure?: Error;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private stopping = false;

  constructor(
    private command = privateCommand,
    private timeoutMs = 30_000,
    private framing: Framing = "jsonl",
  ) {}

  connect(): Promise<void> {
    this.ready ??= this.initialize();
    return this.ready;
  }

  private async initialize() {
    const [command, ...args] = this.command;
    this.child = spawn(command, args, { stdio: "pipe" });
    this.child.stderr.pipe(process.stderr, { end: false });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) =>
      this.fail(new Error(`Codex app-server exited: ${code ?? signal}`)),
    );
    if (this.framing === "websocket") {
      const { stdout, stdin } = this.child;
      const socket = new WebSocket("ws://localhost/", {
        createConnection: () =>
          Duplex.from({ readable: stdout, writable: stdin }),
        handshakeTimeout: this.timeoutMs,
        perMessageDeflate: false,
      });
      this.socket = socket;
      socket.on("message", (data) => this.receive(String(data)));
      socket.on("close", () =>
        this.fail(new Error("Codex app-server connection closed")),
      );
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.on("error", (error) => {
          this.fail(error);
          reject(error);
        });
      });
    } else {
      const lines = createInterface({ input: this.child.stdout });
      lines.on("line", (line) => this.receive(line));
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
    if (!this.child) throw new Error("Codex app-server is not connected");
    if (this.socket) this.socket.send(JSON.stringify(message));
    else this.child.stdin.write(`${JSON.stringify(message)}\n`);
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
