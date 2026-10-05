# t3code-mcp

A local MCP server that lets coding agents create and manage threads in a running T3 Code server.

Runs on Bun with selectable stdio, Streamable HTTP, or legacy HTTP/SSE for MCP clients, authenticated HTTP and WebSocket connections to T3, and no build step.

- Talks to T3 the way the T3 web app does: T3's own HTTP + WebSocket interfaces and T3's own pairing tokens.
- Threads show up in the normal T3 UI, with a link back to them.
- Never opens or writes T3's database.
- Runs locally. Stdio needs no extra port; HTTP and SSE listen on loopback by default.

## Tools

| Tool                | What it does                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `t3_list_projects`  | Projects the T3 server knows, with ids and workspace roots                                      |
| `t3_list_worktrees` | Git worktrees and local branches of one project                                                 |
| `t3_list_harnesses` | Configured harnesses and their models, with a usable flag and reason                            |
| `t3_list_threads`   | Recent threads, newest first, optionally per project                                            |
| `t3_create_thread`  | Create a thread with an explicit project + worktree + harness + model and send the first prompt |
| `t3_send_message`   | Send a follow-up prompt to an existing thread (steers or queues during an active run)           |
| `t3_get_thread`     | Status, latest turn state, and recent messages including the assistant reply                    |
| `t3_wait_for_turn`  | Block until the current turn finishes, then return the reply                                    |
| `t3_cancel_turn`    | Interrupt the running turn                                                                      |

## Guarantees

- **No silent substitution.** Unknown, disabled, uninstalled, or signed-out harnesses, unknown models, projects, and worktrees fail with the list of valid options.
- **No duplicate launches.** Pass an `idempotencyKey`: thread, command, and message ids are SHA-256 of the key, and T3 dedupes on command id, so a retry after a crash cannot launch twice. A key whose command T3 _rejected_ is burned; the error says so.
- **Loud on drift.** The response fields the wait loop depends on are checked at runtime, so a T3 upgrade that renames them fails clearly instead of reporting "done".

## Requirements

- Bun 1.2 or newer.
- A running T3 Code server with Orchestrator V2 on this machine (desktop app, `t3 start`, or `npx t3`).
- A pairing code from that T3.

## Install and pair

```bash
git clone https://github.com/daniel100097/t3code-mcp.git
cd t3code-mcp
bun install

# one-time: mint a pairing code in T3 (Settings → Connections, or:)
t3 auth pairing create --ttl 10m --label t3code-mcp --json   # the code is the "credential" field
bun run src/cli.ts pair <code-or-pairing-url>
bun run src/cli.ts status
```

`pair` exchanges the one-time code for a 30-day bearer token and stores it in `~/.t3code-mcp/credentials.json` (mode 0600). Run `pair` again when it expires; revoke it any time in T3 → Settings → Connections (or `t3 auth session revoke`). Credentials from earlier installations are still recognized.

Headless alternative: set `T3_ACCESS_TOKEN` to a token from `t3 auth session issue --token-only`.

## Configure your MCP client

### Select a transport

All three modes expose the same MCP tools and use the same T3 pairing credentials. Stdio is the default.

| Transport       | Start command         | Client connection                                 |
| --------------- | --------------------- | ------------------------------------------------- |
| Stdio           | `bun run start:stdio` | Client launches the process and uses stdin/stdout |
| Streamable HTTP | `bun run start:http`  | `http://127.0.0.1:3001/mcp`                       |
| Legacy HTTP/SSE | `bun run start:sse`   | `http://127.0.0.1:3001/sse`                       |

Select the transport directly and set a different address or port:

```bash
bun run src/cli.ts serve --transport http --host 127.0.0.1 --port 8080
bun run src/cli.ts serve --transport sse --port 8080
bun run src/cli.ts serve --transport stdio

# Or use environment variables (flags take precedence):
T3CODE_MCP_TRANSPORT=http T3CODE_MCP_PORT=8080 bun start
```

Stop the running server before switching HTTP and SSE on the same port. `--port 0` selects a free port; the server prints its endpoint to stderr. `serve` can be omitted when passing transport flags.

### Stdio

Use the absolute path to your checkout in your MCP client's stdio configuration. For clients using `mcpServers`:

```json
{
  "mcpServers": {
    "t3code-mcp": {
      "command": "bun",
      "args": ["/path/to/t3code-mcp/src/cli.ts", "serve", "--transport", "stdio"]
    }
  }
}
```

### Streamable HTTP

Start `bun run start:http`, then configure your client with the `/mcp` URL. For clients using `mcpServers` and a transport `type`:

```json
{
  "mcpServers": {
    "t3code-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp"
    }
  }
}
```

### Legacy HTTP/SSE

Start `bun run start:sse`, then configure the `/sse` URL:

```json
{
  "mcpServers": {
    "t3code-mcp": {
      "type": "sse",
      "url": "http://127.0.0.1:3001/sse"
    }
  }
}
```

The SSE stream advertises `/messages?sessionId=...` as its POST endpoint; the client handles this automatically. Client configuration formats vary, so use the matching transport and URL in your client's schema. Prefer Streamable HTTP when your client supports it.

## Docker

GitHub Actions builds `ghcr.io/daniel100097/t3code-mcp` for `linux/amd64` and `linux/arm64`. The image runs as the non-root `bun` user, contains only production dependencies, and defaults to stdio. All CLI commands and transport flags work in the container.

```bash
docker pull ghcr.io/daniel100097/t3code-mcp:latest

# Or build and check the image locally:
docker build -t t3code-mcp:local .
bun run test:docker t3code-mcp:local
```

Set `T3_SERVER_URL` explicitly in containers: host runtime-file discovery cannot reliably check host process IDs from a container. Set `T3_ACCESS_TOKEN` in your shell to a token from `t3 auth session issue --token-only`; the examples forward it at runtime. The image does not contain credentials or need access to your project files.

### Connect to T3 on a Linux host

Use host networking to reach T3 even when it listens only on `127.0.0.1`. Replace `3773` with your T3 server's actual port:

```bash
# Streamable HTTP at http://127.0.0.1:3001/mcp
docker run --rm --network host \
  -e T3_SERVER_URL=http://127.0.0.1:3773 \
  -e T3_ACCESS_TOKEN \
  -e T3CODE_MCP_HOST=127.0.0.1 \
  ghcr.io/daniel100097/t3code-mcp:latest serve --transport http

# Stdio: keep stdin open with -i; do not allocate a TTY with -t.
docker run --rm -i --network host \
  -e T3_SERVER_URL=http://127.0.0.1:3773 \
  -e T3_ACCESS_TOKEN \
  ghcr.io/daniel100097/t3code-mcp:latest serve --transport stdio
```

For legacy SSE, change `--transport http` to `--transport sse` and connect to `http://127.0.0.1:3001/sse`.

### Connect to T3 on Docker Desktop

Use Docker Desktop's host alias and publish the MCP port on loopback:

```bash
docker run --rm -p 127.0.0.1:3001:3001 \
  -e T3_SERVER_URL=http://host.docker.internal:3773 \
  -e T3_ACCESS_TOKEN \
  ghcr.io/daniel100097/t3code-mcp:latest serve --transport http
```

The image defaults `T3CODE_MCP_HOST` to `0.0.0.0` inside the container so published ports work. With Linux host networking, explicitly use `T3CODE_MCP_HOST=127.0.0.1` as shown above to keep the MCP listener local.

### Persist pairing credentials

To use pairing instead of `T3_ACCESS_TOKEN`, mount a named volume at `/data` for both the pairing command and the server. For a Linux host:

```bash
docker volume create t3code-mcp-data
docker run --rm --network host \
  -e T3_SERVER_URL=http://127.0.0.1:3773 \
  -v t3code-mcp-data:/data \
  ghcr.io/daniel100097/t3code-mcp:latest pair <pairing-code>

docker run --rm --network host \
  -e T3_SERVER_URL=http://127.0.0.1:3773 \
  -e T3CODE_MCP_HOST=127.0.0.1 \
  -v t3code-mcp-data:/data \
  ghcr.io/daniel100097/t3code-mcp:latest serve --transport http
```

The token is stored in `/data/credentials.json`. Use the same T3 URL for pairing and serving. On Docker Desktop, apply the host alias and port mapping from the previous example.

### GitHub builds

The [Docker workflow](https://github.com/daniel100097/t3code-mcp/actions/workflows/docker.yml) runs formatting, linting, type checks, and tests before building. It then checks MCP initialization and tool discovery against the production image. Pull requests build both architectures without publishing; pushes to `main`, version tags, and manual workflow runs publish to GHCR using the repository's `GITHUB_TOKEN`.

| Image tag               | Published from                 |
| ----------------------- | ------------------------------ |
| `latest`, `main`        | Successful builds of `main`    |
| `sha-<full-commit-sha>` | Each published commit          |
| `0.1.0`, `0.1`          | A version tag such as `v0.1.0` |

The Bun image and GitHub Actions are pinned; update the Bun version in both `Dockerfile` and the workflow together.

## Typical agent flow

```text
t3_list_projects                       → pick a project id
t3_list_worktrees  {project}           → pick a worktreePath (or use the project root)
t3_list_harnesses                      → pick harnessId + model slug
t3_create_thread   {project, worktreePath, harness, model, title, prompt,
                    idempotencyKey, wait: true}      → reply text + thread url
t3_send_message    {threadId, prompt, wait: true}  → next reply
t3_get_thread      {threadId}                      → status + recent messages
t3_cancel_turn     {threadId}                      → stop a running turn
```

Detail reads include `proposedPlans` with plan markdown. Wait results include `proposedPlan` for the awaited run, even when that run has no assistant message. `needsAttention.actionablePlan` reports active proposed plans.

Every thread result includes `url` (opens the thread in the T3 web UI) and `turn.state` (`preparing`, `queued`, `starting`, `running`, `waiting`, `completed`, `interrupted`, `failed`, `cancelled`, `rolled_back`).

## Environment variables

| Variable                 | Meaning                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `T3CODE_MCP_TRANSPORT`   | MCP transport: `stdio` (default), `http` (Streamable HTTP), or `sse` (legacy)   |
| `T3CODE_MCP_HOST`        | HTTP/SSE bind address. Default `127.0.0.1`                                      |
| `T3CODE_MCP_PORT`        | HTTP/SSE port. Default `3001`; `0` selects a free port                          |
| `T3_SERVER_URL`          | Skip discovery and use this origin, e.g. `http://127.0.0.1:4096`                |
| `T3CODE_HOME`            | T3 data directory to search for `userdata/server-runtime.json`. Default `~/.t3` |
| `T3_ACCESS_TOKEN`        | Bearer token to use instead of the stored one                                   |
| `T3CODE_MCP_CREDENTIALS` | Path of the credentials file. Default `~/.t3code-mcp/credentials.json`          |

CLI commands: `serve` (default), `pair <url-or-code>`, `status`, `help`. Run `serve --help` for transport options.

## How it works

- **MCP transports.** Stdio uses the SDK's stdio server. Streamable HTTP uses its stateless HTTP handler, supporting both current and older MCP protocol versions. Legacy SSE uses one event stream and a separate message endpoint per client. Network modes support multiple clients and close connections on shutdown.
- **Discovery.** Reads `<T3 home>/userdata/server-runtime.json` (then `dev/`), checks the pid is alive, and probes `/.well-known/t3/environment`. The server connects lazily on the first tool call, so the MCP server starts even while T3 is still booting.
- **Auth.** Bearer token from T3's pairing flow (`POST /oauth/token` token exchange), sent on HTTP requests and on the WebSocket upgrade.
- **Reads.** `GET /api/orchestration/shell` and `GET /api/orchestration/threads/:id`.
- **Commands.** `orchestration.launchThread` starts a thread with an explicit workspace strategy. `orchestration.dispatchCommand` sends `message.dispatch`, mode changes, and `run.interrupt`. T3 resolves delivery against its current state and harness capabilities. Explicit mode changes use separate commands before the message. If message delivery fails, the selected mode can remain changed; retries reuse the command ids.
- **RPC client.** `server.getConfig` and `vcs.listRefs` are socket-only, so `src/t3/transport/rpc-client.ts` speaks the RPC JSON envelope on Bun's built-in WebSocket: `Request`, `Chunk` + `Ack` back-pressure, `Exit`, `Ping`/`Pong`, `Interrupt`.
- **Waiting.** `orchestration.subscribeThread` resumes after the HTTP snapshot sequence. Run and message events trigger a snapshot read. Waiting tracks the requested run, including queued work, and returns only that run's reply.

Wire contracts target T3 Code server `0.0.46-nightly.20261005.2676`, orchestration protocol 2. HTTP reads send `x-t3-orchestration-protocol: 2`; WebSocket connections send `orchestrationProtocol=2`. Older servers fail with an upgrade message before authentication or commands.

T3 Code now includes its own MCP for agents running inside T3. This repository remains a separate adapter for external MCP clients, with stdio, Streamable HTTP, legacy SSE, Docker, and caller-supplied idempotency keys.

V2 launch preparation always runs the project's setup script. The obsolete `newWorktree.runSetupScript` option is rejected before launch. Thread reads use the full V2 projection so waiting and retries can find earlier messages. `messageLimit` limits the MCP response, not the server snapshot.

## Development

```bash
bun test                    # unit tests and MCP transport integration tests; no T3 needed
bun run typecheck
bun run lint                # strict, type-aware linting
bun run lint:fix             # apply safe lint fixes
bun run format              # format the project
bun run check               # formatting, lint, types, and unit tests
bun run test:docker t3code-mcp:local # MCP smoke test against a built Docker image
bun run test:live            # read-only checks against your running T3
bun run test:live --create <projectIdOrRoot> <harness> <model>   # also launches ONE real thread
```

Oxlint checks correctness, suspicious code, performance, and TypeScript safety with warnings treated as failures. Narrow overrides allow sequential discovery, paging, and stream operations, plus awaited test assertions that Bun currently types as returning `void`. Oxfmt formats the source, tests, scripts, configuration, and documentation.

Layout:

```text
src/
  cli.ts                    entry point: serve | pair | status
  mcp/
    register-tools.ts       assemble the tool registry
    serve-options.ts        transport flags and environment settings
    http-server.ts          Bun HTTP listener, request validation, and routing
    sse-transport.ts        legacy SSE event streams and message handling
    register-tool.ts        JSON responses, error handling, and annotations
    schemas.ts              shared MCP input schemas
    presenters.ts           thread summaries, replies, and message formatting
    tools/                  project, harness, thread, and turn handlers
  t3/
    client.ts               typed T3 operations and their options
    connection.ts           assemble authenticated HTTP and RPC clients
    session.ts              lazy connection lifetime
    server-discovery.ts     find the running T3 server
    credentials.ts          pairing exchange and token store
    selection.ts            strict project, harness, model, and worktree lookup
    command-ids.ts          idempotency key → deterministic ids
    thread-snapshot.ts      read snapshots and check contract drift
    turn-waiter.ts          wait for the caller's turn to settle
    contracts/              orchestration, command, provider, and VCS wire shapes
    transport/              HTTP and WebSocket RPC clients, shared error formatting
test/                       tests grouped to match the source modules
scripts/smoke-live.ts        opt-in checks against a running T3 server
scripts/smoke-docker.ts      MCP smoke test against a production Docker image
Dockerfile                  production container with all MCP transports
.github/workflows/docker.yml checks, image smoke test, and multi-platform GHCR publication
```

T3 wire contracts live in `src/t3/contracts/`; client options and transport types stay beside the code that owns them. MCP schemas reuse the contract's mode values, and inferred schema types describe validated inputs. The T3 client has no dependency on the MCP layer.

## Security

- The stored token carries T3's standard client scopes (`orchestration:read/operate`, `terminal:operate`, `review:write`, `relay:read`). Treat the credentials file like a password.
- Anything reachable through your T3 (its projects, its harness credentials) is reachable through this server. Only expose it to MCP clients you trust.
- HTTP/SSE bind to `127.0.0.1` by default and validate Host and Origin headers. The MCP listener has no client authentication; T3 pairing authenticates the connection from this server to T3. Use an authenticated proxy if you expose the listener beyond your machine. Wildcard bind addresses accept Host headers for the machine's local interface addresses; a proxy should forward a matching Host header.

## License

MIT.
