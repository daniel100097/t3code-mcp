#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { serveHttp } from "./mcp/http-server.ts";
import { registerTools } from "./mcp/register-tools.ts";
import { parseServeOptions } from "./mcp/serve-options.ts";
import { T3Client } from "./t3/client.ts";
import { connectToT3 } from "./t3/connection.ts";
import {
  credentialsPath,
  exchangePairingCode,
  parsePairingInput,
  saveCredential,
} from "./t3/credentials.ts";
import { discoverServer } from "./t3/server-discovery.ts";
import { T3Session } from "./t3/session.ts";

const NAME = "t3code-mcp";
const VERSION = "0.1.0";

const USAGE = `${NAME} <command> [options]

Commands:
  serve            Run the MCP server (default command; stdio by default)
  pair <url|code>  Exchange a T3 pairing link or code for a token and store it
  status           Show the discovered T3 server and whether the token works
  help             Show this help

Serve options (flags override environment variables):
  --transport stdio|http|sse  MCP transport (default stdio)
  --host <hostname|ip>       HTTP bind address (default 127.0.0.1)
  --port <number>            HTTP port (default 3001; 0 chooses a free port)
  --help, -h                Show this help

HTTP endpoints: http uses /mcp; sse uses /sse and /messages?sessionId=...

Environment:
  T3CODE_MCP_TRANSPORT    MCP transport: stdio, http, or sse
  T3CODE_MCP_HOST         HTTP bind address
  T3CODE_MCP_PORT         HTTP port
  T3_SERVER_URL           Skip discovery and use this origin (e.g. http://127.0.0.1:3773)
  T3CODE_HOME             T3 data directory holding userdata/server-runtime.json (default ~/.t3)
  T3_ACCESS_TOKEN         Use this bearer token instead of the stored one
  T3CODE_MCP_CREDENTIALS  Token store path (default ~/.t3code-mcp/credentials.json)
`;

// stdout is the MCP channel, so every log line goes to stderr.
const log = (line: string): void => void process.stderr.write(`${NAME}: ${line}\n`);

function serve(args: string[]): void {
  const options = parseServeOptions(args);
  // Lazy discovery lets MCP start while T3 is still booting.
  const session = new T3Session(process.env, (connection) => {
    log(`connected to ${connection.server.origin} (token from ${connection.tokenSource})`);
  });
  const factory = (): McpServer => {
    const server = new McpServer({ name: NAME, version: VERSION });
    registerTools(server, session);
    return server;
  };
  const onerror = (error: Error): void => log(error.message);
  const handle: { close(): Promise<void>; url?: URL } =
    options.transport === "stdio"
      ? serveStdio(factory, { onerror })
      : serveHttp(factory, { ...options, transport: options.transport }, onerror);
  if (handle.url) {
    log(`${options.transport} listening at ${handle.url.href}`);
  }
  let closing = false;
  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    session.close();
    void handle.close().then(
      () => process.exit(0),
      (error: unknown) => {
        log(error instanceof Error ? error.message : String(error));
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The host went away: do not linger as an orphan holding the T3 socket open.
  if (options.transport === "stdio") {
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
  }
}

async function pair(input: string | undefined): Promise<void> {
  if (!input) {
    throw new Error(`Usage: ${NAME} pair <pairing-url-or-code>`);
  }
  const parsed = parsePairingInput(input);
  const origin = parsed.origin ?? (await discoverServer()).origin;
  const credential = await exchangePairingCode(origin, parsed.code);
  const path = credentialsPath();
  await saveCredential(path, credential);
  console.log(`Paired with ${origin}. Token stored in ${path} (expires ${credential.expiresAt}).`);
}

async function status(): Promise<void> {
  const server = await discoverServer();
  console.log(
    `Server: ${server.origin} (v${server.serverVersion ?? "?"}, ${server.label ?? "unlabeled"}) via ${server.source}`,
  );
  try {
    const connection = await connectToT3();
    const client = new T3Client(connection);
    try {
      const [shell, config] = await Promise.all([client.shell(), client.config()]);
      console.log(`Token: ok (${connection.tokenSource})`);
      console.log(
        `Projects: ${shell.projects.length}, threads: ${shell.threads.length}, harnesses: ${config.providers.map((p) => p.instanceId).join(", ")}`,
      );
    } finally {
      connection.rpc.close();
    }
  } catch (error) {
    console.log(`Connection: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
const command = args[0]?.startsWith("-") ? "serve" : (args.shift() ?? "serve");
try {
  switch (command) {
    case "serve":
      if (args.includes("--help") || args.includes("-h")) {
        process.stdout.write(USAGE);
      } else {
        serve(args);
      }
      break;
    case "pair":
      await pair(args[0]);
      break;
    case "status":
      await status();
      break;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      break;
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
