import { PAIR_HINT } from "../credentials.ts";
import { summarizeError } from "./errors.ts";
import type { FetchFunction } from "./http-client.ts";
import { rpcServerMessageSchema, type RpcFailure } from "./rpc-protocol.ts";

interface PendingRequest {
  socket: WebSocket;
  onChunk?: (value: unknown) => void;
  resolve: (value?: unknown) => void;
  reject: (error: Error) => void;
}

export class T3RpcError extends Error {
  constructor(
    readonly tag: string,
    message: string,
  ) {
    super(message);
    this.name = "T3RpcError";
  }
}

export function exitToError(exit: RpcFailure): T3RpcError {
  const first = exit.cause[0];
  if (!first) {
    return new T3RpcError("Unknown", "RPC failed with an empty cause.");
  }
  if (first._tag === "Fail") {
    const error = first.error;
    const tag =
      error && typeof error === "object" && "_tag" in error && typeof error._tag === "string"
        ? error._tag
        : "Fail";
    return new T3RpcError(tag, explain(tag, summarizeError(first.error)));
  }
  if (first._tag === "Interrupt") {
    return new T3RpcError("Interrupt", "RPC was interrupted.");
  }
  // Schema rejections arrive as defects; phrase them as a request problem rather than a crash.
  return new T3RpcError("Die", `T3 rejected the request: ${summarizeError(first.defect)}`);
}

function explain(tag: string, message: string): string {
  if (tag === "OrchestrationCommandPreviouslyRejectedError") {
    return `${message} This idempotencyKey was rejected before and can never be retried. Fix the cause, then call again with a new idempotencyKey.`;
  }
  if (tag === "EnvironmentAuthInvalidError" || tag === "EnvironmentAuthorizationError") {
    return `${message} ${PAIR_HINT}`;
  }
  return message;
}

const PING_INTERVAL_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** Interrupts must travel on the socket that carried the request; request ids are per socket on the server. */
const sendInterrupt = (socket: WebSocket, requestId: string): void => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ _tag: "Interrupt", requestId }));
  }
};

export class RpcClient {
  private socket: WebSocket | null = null;
  private connecting: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pings = new Map<WebSocket, ReturnType<typeof setInterval>>();

  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly fetchImpl: FetchFunction = fetch,
  ) {}

  private connect(): Promise<WebSocket> {
    if (this.closed) {
      return Promise.reject(new Error("T3 RPC client is closed."));
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.socket);
    }
    if (this.opening) {
      return this.opening;
    }
    const attempt = new Promise<WebSocket>((resolve, reject) => {
      const url = new URL("/ws", this.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("clientSurface", "web");
      url.searchParams.set("connectionMethod", "direct");
      url.searchParams.set("orchestrationProtocol", "2");
      // Bun's WebSocket takes request headers as a (non-standard) option.
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.token}` } });
      this.connecting = socket;
      let opened = false;
      const fail = (error: Error) => {
        this.forget(socket, attempt);
        if (!opened) {
          reject(error);
        }
        this.failSocket(socket, error);
      };
      socket.addEventListener("open", () => {
        if (this.closed) {
          socket.close();
          fail(new Error("T3 RPC client is closed."));
          return;
        }
        opened = true;
        this.socket = socket;
        if (this.connecting === socket) {
          this.connecting = null;
        }
        if (this.opening === attempt) {
          this.opening = null;
        }
        const ping = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ _tag: "Ping" }));
          }
        }, PING_INTERVAL_MS);
        this.pings.set(socket, ping);
        resolve(socket);
      });
      socket.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (typeof event.data === "string") {
          this.handleMessage(socket, event.data);
        }
      });
      // The close event carries the error detail.
      socket.addEventListener("error", () => {});
      socket.addEventListener("close", (event) => {
        const detail = `${event.code}${event.reason ? `: ${event.reason}` : ""}`;
        if (opened) {
          fail(new Error(`T3 WebSocket closed (${detail})`));
          return;
        }
        if (this.closed) {
          fail(new Error("T3 RPC client is closed."));
          return;
        }
        void this.explainHandshakeFailure(detail).then(fail);
      });
    });
    this.opening = attempt;
    return attempt;
  }

  /** Bun hides the HTTP status of a failed upgrade, so ask over HTTP whether the token is the problem. */
  private async explainHandshakeFailure(detail: string): Promise<Error> {
    try {
      const response = await this.fetchImpl(new URL("/api/orchestration/shell", this.origin), {
        headers: { authorization: `Bearer ${this.token}`, "x-t3-orchestration-protocol": "2" },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 401 || response.status === 403) {
        return new Error(`T3 rejected the stored token (${response.status}). ${PAIR_HINT}`);
      }
    } catch {
      // Fall through to the generic explanation.
    }
    return new Error(`T3 WebSocket handshake failed (${detail}).`);
  }

  private forget(socket: WebSocket, attempt: Promise<WebSocket>): void {
    const ping = this.pings.get(socket);
    if (ping) {
      clearInterval(ping);
    }
    this.pings.delete(socket);
    if (this.socket === socket) {
      this.socket = null;
    }
    if (this.connecting === socket) {
      this.connecting = null;
    }
    if (this.opening === attempt) {
      this.opening = null;
    }
  }

  private failSocket(socket: WebSocket, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) {
        continue;
      }
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of messages) {
      const result = rpcServerMessageSchema.safeParse(item);
      if (!result.success) {
        continue;
      }
      const message = result.data;
      if (message._tag === "Pong") {
        continue;
      }
      if (message._tag === "Defect" || message._tag === "ClientProtocolError") {
        const detail = message._tag === "Defect" ? message.defect : message.error;
        this.failSocket(socket, new Error(`T3 RPC ${message._tag}: ${summarizeError(detail)}`));
        continue;
      }
      const id = String(message.requestId);
      const pending = this.pending.get(id);
      if (!pending || pending.socket !== socket) {
        continue;
      }
      if (message._tag === "Chunk") {
        for (const value of message.values) {
          pending.onChunk?.(value);
        }
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
        }
        continue;
      }
      this.pending.delete(id);
      if (message.exit._tag === "Success") {
        pending.resolve(message.exit.value);
      } else {
        pending.reject(exitToError(message.exit));
      }
    }
  }

  private async send(
    tag: string,
    payload: unknown,
    onChunk?: (value: unknown) => void,
  ): Promise<{ id: string; socket: WebSocket; done: Promise<unknown> }> {
    const socket = await this.connect();
    const id = String(this.nextId++);
    const done = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { socket, onChunk, resolve, reject });
      try {
        socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return { id, socket, done };
  }

  async call(tag: string, payload: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    const { id, socket, done } = await this.send(tag, payload);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          sendInterrupt(socket, id);
        }
        reject(new Error(`T3 RPC ${tag} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Streaming RPC. `onChunk` returns true to stop early, which interrupts the
   * server-side stream. Resolves when the stream ends, is stopped, or the
   * timeout passes; rejects only if the socket fails.
   */
  async stream(
    tag: string,
    payload: unknown,
    onChunk: (value: unknown) => boolean | void,
    timeoutMs?: number,
  ): Promise<void> {
    let stopped = false;
    let requestId = "";
    const { id, done } = await this.send(tag, payload, (value) => {
      if (stopped) {
        return;
      }
      if (onChunk(value) === true) {
        stopped = true;
        this.interrupt(requestId);
      }
    });
    requestId = id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout =
      timeoutMs === undefined
        ? null
        : new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => {
              resolve("timeout");
            }, timeoutMs);
          });
    try {
      const outcome = await (timeout ? Promise.race([done, timeout]) : done);
      if (outcome === "timeout") {
        stopped = true;
        this.interrupt(id);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private interrupt(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    pending.resolve();
    sendInterrupt(pending.socket, id);
  }

  close(): void {
    this.closed = true;
    const { socket, connecting } = this;
    this.socket = null;
    this.connecting = null;
    for (const ping of this.pings.values()) {
      clearInterval(ping);
    }
    this.pings.clear();
    socket?.close();
    connecting?.close();
  }
}
