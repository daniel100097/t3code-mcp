import { afterEach, describe, expect, it } from "bun:test";

import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { serveHttp } from "../../src/mcp/http-server.ts";
import { registerTools } from "../../src/mcp/register-tools.ts";
import { T3Client } from "../../src/t3/client.ts";

const clients: Client[] = [];
const servers: ReturnType<typeof serveHttp>[] = [];
const abortControllers: AbortController[] = [];
const unexpectedCall = async (): Promise<never> => {
  throw new Error("Unexpected RPC call");
};
const post = (url: URL, body = "{}"): Promise<Response> =>
  fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json" } });

afterEach(async () => {
  for (const controller of abortControllers.splice(0)) {
    controller.abort();
  }
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function harness(transport: "http" | "sse") {
  const projects = [
    { id: "p1", title: "Project", workspaceRoot: "/work/project", defaultModelSelection: null },
  ];
  const fake = new T3Client({
    server: { origin: "http://t3", environmentId: "env", source: "test", pid: 0 },
    tokenSource: "test",
    http: {
      get: async () => ({
        schemaVersion: 2,
        snapshotSequence: 1,
        projects,
        threads: [],
        archivedThreads: [],
      }),
    },
    rpc: { call: unexpectedCall, stream: unexpectedCall, close() {} },
  });
  let connections = 0;
  const errors: Error[] = [];
  const disconnected = Promise.withResolvers<void>();
  const server = serveHttp(
    () => {
      const mcp = new McpServer({ name: "transport-test", version: "1" });
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- SDK Protocol uses callbacks rather than EventTarget.
      mcp.server.onclose = () => disconnected.resolve();
      registerTools(mcp, {
        getClient: async () => {
          connections++;
          return fake;
        },
      });
      return mcp;
    },
    { transport, host: "127.0.0.1", port: 0 },
    (error) => errors.push(error),
  );
  servers.push(server);
  return {
    server,
    projects,
    errors,
    connections: () => connections,
    disconnected: disconnected.promise,
  };
}

async function connect(url: URL, transport: "http" | "sse", modern = false) {
  const client = new Client(
    { name: "test", version: "1" },
    modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : undefined,
  );
  clients.push(client);
  await client.connect(
    transport === "http" ? new StreamableHTTPClientTransport(url) : new SSEClientTransport(url),
  );
  return client;
}

describe.each(["http", "sse"] as const)("%s MCP transport", (transport) => {
  it("initializes, discovers tools lazily, and serves multiple clients independently", async () => {
    const { server, projects, errors, connections } = harness(transport);
    const [first, second] = await Promise.all([
      connect(server.url, transport),
      connect(server.url, transport),
    ]);
    expect(first.getServerVersion()?.name).toBe("transport-test");
    expect((await first.listTools()).tools).toHaveLength(9);
    expect(connections()).toBe(0);
    const results = await Promise.all([
      first.callTool({ name: "t3_list_projects" }),
      second.callTool({ name: "t3_list_projects" }),
    ]);
    expect(results).toEqual([
      { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] },
      { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] },
    ]);
    await first.close();
    expect((await second.listTools()).tools).toHaveLength(9);
    expect(errors).toEqual([]);
  });

  it("rejects foreign Host/Origin headers and unknown endpoints", async () => {
    const { server } = harness(transport);
    const responses = await Promise.all([
      fetch(server.url, { headers: { Host: "attacker.example" } }),
      fetch(server.url, { headers: { Origin: "https://attacker.example" } }),
      fetch(server.url, { headers: { Origin: "null" } }),
      fetch(new URL("/missing", server.url)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 404]);
    await Promise.all(responses.map((response) => response.text()));
  });

  it("closes active clients and releases its listening port", async () => {
    const { server } = harness(transport);
    await connect(server.url, transport);
    await server.close();
    await server.close();
    await expect(fetch(server.url)).rejects.toThrow();
  });
});

it("serves the modern MCP protocol through Streamable HTTP", async () => {
  const { server, projects, errors } = harness("http");
  const client = await connect(server.url, "http", true);
  expect((await client.listTools()).tools).toHaveLength(9);
  expect(await client.callTool({ name: "t3_list_projects" })).toMatchObject({
    content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
  });
  expect(errors).toEqual([]);
});

it("validates Streamable HTTP request bodies and methods", async () => {
  const { server } = harness("http");
  const responses = await Promise.all([
    fetch(server.url, { method: "POST", body: "{}", headers: { "Content-Type": "text/plain" } }),
    fetch(server.url, {
      method: "POST",
      body: "{",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
    }),
    fetch(server.url, { method: "PUT" }),
  ]);
  expect(responses.map((response) => response.status)).toEqual([415, 400, 405]);
  await Promise.all(responses.map((response) => response.text()));
});

it("validates legacy SSE messages and removes disconnected sessions", async () => {
  const { server, disconnected } = harness("sse");
  const controller = new AbortController();
  abortControllers.push(controller);
  const response = await fetch(server.url, { signal: controller.signal });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("SSE response has no body");
  }
  const chunk: unknown = (await reader.read()).value;
  if (!(chunk instanceof Uint8Array)) {
    throw new Error("SSE response did not contain bytes");
  }
  const first = new TextDecoder().decode(chunk);
  const endpoint = first.match(/data: (\/messages\?sessionId=[^\n]+)/)?.[1];
  if (!endpoint) {
    throw new Error(`Missing SSE endpoint event: ${first}`);
  }
  const messageUrl = new URL(endpoint, server.url);
  const responses = await Promise.all([
    post(new URL("/messages", server.url)),
    post(new URL("/messages?sessionId=unknown", server.url)),
    post(messageUrl, "{"),
    post(messageUrl, "{}"),
    fetch(messageUrl, { method: "POST", body: "{}" }),
    fetch(messageUrl),
    fetch(server.url, { method: "POST" }),
  ]);
  expect(responses.map((result) => result.status)).toEqual([400, 404, 400, 400, 415, 405, 405]);
  expect(responses[5]?.headers.get("allow")).toBe("POST");
  expect(responses[6]?.headers.get("allow")).toBe("GET");
  await Promise.all(responses.map((result) => result.text()));
  controller.abort();
  await reader.cancel().catch(() => {});
  await disconnected;
  const result = await post(messageUrl, '{"jsonrpc":"2.0","method":"notifications/initialized"}');
  expect(result.status).toBe(404);
  await result.text();
});
