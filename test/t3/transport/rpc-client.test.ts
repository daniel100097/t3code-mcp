import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import * as z from "zod/v4";

import { RpcClient, T3RpcError } from "../../../src/t3/transport/rpc-client.ts";

type Seen = { auth: string | null; path: string };

describe("RpcClient", () => {
  let server: ReturnType<typeof Bun.serve<Seen>>;
  let origin: string;
  let seen: Seen[];
  let inbound: Array<Record<string, unknown>>;
  let sockets: Set<Bun.ServerWebSocket<Seen>>;
  let rejectUpgradeWith: number | null;
  let interrupted: Promise<void>;
  let onInterrupt: () => void;

  beforeEach(() => {
    seen = [];
    inbound = [];
    sockets = new Set();
    rejectUpgradeWith = null;
    interrupted = new Promise<void>((resolve) => (onInterrupt = resolve));
    const acked = new Map<string, () => void>();
    server = Bun.serve<Seen>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, srv) {
        if (rejectUpgradeWith) {
          return new Response("nope", { status: rejectUpgradeWith });
        }
        const url = new URL(request.url);
        if (
          url.pathname === "/ws" &&
          url.searchParams.get("orchestrationProtocol") === "2" &&
          srv.upgrade(request, {
            data: { auth: request.headers.get("authorization"), path: url.pathname + url.search },
          })
        ) {
          return undefined;
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
          seen.push(ws.data);
        },
        close(ws) {
          sockets.delete(ws);
        },
        async message(ws, data) {
          const message = z
            .record(z.string(), z.unknown())
            .parse(JSON.parse(typeof data === "string" ? data : data.toString()));
          inbound.push(message);
          if (message._tag === "Ping") {
            return void ws.send(JSON.stringify({ _tag: "Pong" }));
          }
          if (message._tag === "Ack") {
            return acked.get(String(message.requestId))?.();
          }
          if (message._tag === "Interrupt") {
            onInterrupt();
            return;
          }
          if (message._tag !== "Request") {
            return;
          }
          const id = z.string().parse(message.id);
          const exit = (value: unknown) =>
            void ws.send(JSON.stringify({ _tag: "Exit", requestId: id, exit: value }));
          switch (message.tag) {
            case "echo": {
              exit({ _tag: "Success", value: message.payload });
              return;
            }
            case "fail": {
              exit({
                _tag: "Failure",
                cause: [
                  {
                    _tag: "Fail",
                    error: { _tag: "EnvironmentScopeRequiredError", message: "needs operate" },
                  },
                ],
              });
              return;
            }
            case "rejected": {
              exit({
                _tag: "Failure",
                cause: [
                  {
                    _tag: "Fail",
                    error: {
                      _tag: "OrchestrationCommandPreviouslyRejectedError",
                      message: "was rejected",
                    },
                  },
                ],
              });
              return;
            }
            case "defect": {
              exit({
                _tag: "Failure",
                cause: [{ _tag: "Die", defect: { message: "schema mismatch" } }],
              });
              return;
            }
            case "protocol":
              return void ws.send(
                JSON.stringify({ _tag: "ClientProtocolError", error: { message: "bad frame" } }),
              );
            case "count": {
              for (let n = 1; n <= 3; n++) {
                ws.send(JSON.stringify({ _tag: "Chunk", requestId: id, values: [{ n }] }));
                await new Promise<void>((resolve) => acked.set(id, resolve));
              }
              exit({ _tag: "Success", value: undefined });
              return;
            }
            case "forever":
              return void ws.send(
                JSON.stringify({ _tag: "Chunk", requestId: id, values: [{ n: 1 }] }),
              );
            case "drop":
              return ws.terminate();
            case "silent":
              return;
          }
        },
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    for (const ws of sockets) {
      ws.terminate();
    }
    await server.stop(true);
  });

  it("connects to /ws with the bearer header and resolves unary calls", async () => {
    const client = new RpcClient(origin, "secret");
    expect(await client.call("echo", { a: 1 })).toEqual({ a: 1 });
    expect(seen[0]?.auth).toBe("Bearer secret");
    expect(seen[0]?.path).toBe(
      "/ws?clientSurface=web&connectionMethod=direct&orchestrationProtocol=2",
    );
    const request = inbound.find((m) => m._tag === "Request");
    expect(request).toMatchObject({
      _tag: "Request",
      id: "1",
      tag: "echo",
      payload: { a: 1 },
      headers: [],
    });
    client.close();
  });

  it("turns tagged failures into T3RpcError with tag and message, adding hints where T3 has none", async () => {
    const client = new RpcClient(origin, "secret");
    await expect(client.call("fail", {})).rejects.toMatchObject({
      tag: "EnvironmentScopeRequiredError",
      message: "EnvironmentScopeRequiredError: needs operate",
    });
    await expect(client.call("fail", {})).rejects.toBeInstanceOf(T3RpcError);
    await expect(client.call("rejected", {})).rejects.toThrow(/new idempotencyKey/);
    await expect(client.call("defect", {})).rejects.toThrow(
      /T3 rejected the request: schema mismatch/,
    );
    client.close();
  });

  it("acks every chunk so back-pressured streams drain to completion", async () => {
    const client = new RpcClient(origin, "secret");
    const chunks: unknown[] = [];
    await client.stream("count", {}, (value) => {
      chunks.push(value);
    });
    expect(chunks).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(inbound.filter((m) => m._tag === "Ack")).toHaveLength(3);
    client.close();
  });

  it("stops a stream early when the handler returns true and sends Interrupt", async () => {
    const client = new RpcClient(origin, "secret");
    let calls = 0;
    await client.stream("count", {}, () => ++calls >= 1);
    expect(calls).toBe(1);
    await interrupted;
    client.close();
  });

  it("gives up on a stream after the timeout without throwing", async () => {
    const client = new RpcClient(origin, "secret");
    const started = Date.now();
    await client.stream("forever", {}, () => false, 100);
    expect(Date.now() - started).toBeLessThan(2000);
    await interrupted;
    client.close();
  });

  it("rejects pending work when the socket drops, then reconnects for the next call", async () => {
    const client = new RpcClient(origin, "secret");
    await expect(client.call("drop", {})).rejects.toThrow(/WebSocket closed/);
    expect(await client.call("echo", { ok: true })).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    client.close();
  });

  it("fails pending calls on ClientProtocolError and times out lost replies with an Interrupt", async () => {
    const client = new RpcClient(origin, "secret");
    await expect(client.call("protocol", {})).rejects.toThrow(/ClientProtocolError: bad frame/);
    await expect(client.call("silent", {}, 100)).rejects.toThrow(/timed out after 0s/);
    await interrupted;
    client.close();
  });

  it("explains a rejected handshake as a token problem", async () => {
    rejectUpgradeWith = 401;
    const client = new RpcClient(origin, "stale");
    await expect(client.call("echo", {})).rejects.toThrow(
      /rejected the stored token \(401\).*pair/,
    );
    client.close();
  });

  it("close() during the handshake rejects the pending call and every later call", async () => {
    const client = new RpcClient(origin, "secret");
    const pending = client.call("echo", {});
    client.close();
    await expect(pending).rejects.toThrow(/closed/);
    await expect(client.call("echo", {})).rejects.toThrow(/closed/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sockets.size).toBe(0);
  });
});
