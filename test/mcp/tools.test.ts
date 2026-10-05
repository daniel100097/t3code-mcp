import { afterEach, describe, expect, it } from "bun:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { registerTools } from "../../src/mcp/register-tools.ts";
import { T3Client } from "../../src/t3/client.ts";
import { commandIds } from "../../src/t3/command-ids.ts";
import type {
  Run,
  ShellSnapshot,
  Thread,
  ThreadSnapshot,
} from "../../src/t3/contracts/orchestration.ts";
import type { Provider } from "../../src/t3/contracts/providers.ts";
import type { VcsListRefsResult } from "../../src/t3/contracts/vcs.ts";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const unexpectedCall = async (): Promise<never> => {
  throw new Error("Unexpected client call");
};
const toolError = (result: unknown): string => z.object({ error: z.string() }).parse(result).error;

async function harness(api: Partial<T3Client>) {
  const fake = Object.assign(
    new T3Client({
      server: { origin: "http://t3", environmentId: "env-9", source: "test", pid: 0 },
      tokenSource: "test",
      http: { get: unexpectedCall },
      rpc: { call: unexpectedCall, stream: unexpectedCall, close() {} },
    }),
    api,
  );
  const server = new McpServer({ name: "test", version: "0" });
  registerTools(server, { getClient: async () => fake });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("");
    return result.isError ? { error: text } : JSON.parse(text);
  };
  return { client, call };
}

const provider: Provider = {
  instanceId: "testHarness",
  driver: "testHarness",
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  models: [{ slug: "model-large", name: "Large Model", aliases: ["large"], isDefault: true }],
};
const brokenProvider: Provider = {
  ...provider,
  instanceId: "missingHarness",
  driver: "missingHarness",
  installed: false,
  message: "missingHarness CLI missing",
  models: [],
};

const thread = (id: string, run: Run | null, extra: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p1",
  title: "t",
  providerInstanceId: "testHarness",
  modelSelection: { instanceId: "testHarness", model: "model-large" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestRunId: run?.id ?? null,
  latestRunStartedAt: run?.startedAt ?? null,
  latestRunCompletedAt: run?.completedAt ?? null,
  status: run?.status ?? "idle",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  lastError: null,
  pendingRuntimeRequest: null,
  hasActionableProposedPlan: false,
  ...extra,
});
const detail = (shell: Thread, messages: ThreadSnapshot["messages"] = []): ThreadSnapshot => ({
  snapshotSequence: 1,
  thread: shell,
  messages,
  runtimeRequests: [],
  runErrors: {},
  proposedPlans: [],
  runs: shell.latestRunId
    ? [
        {
          id: shell.latestRunId,
          ordinal: 1,
          rootNodeId: null,
          status: shell.status,
          userMessageId: messages.find((m) => m.role === "user")?.id ?? "user",
          requestedAt: shell.latestRunStartedAt ?? "",
          startedAt: shell.latestRunStartedAt ?? null,
          completedAt: shell.latestRunCompletedAt ?? null,
        },
      ]
    : [],
});

const shell = (threads: Thread[]): ShellSnapshot => ({
  snapshotSequence: 1,
  projects: [
    { id: "p1", title: "proj", workspaceRoot: "C:\\code\\proj", defaultModelSelection: null },
  ],
  threads,
});

const refs: VcsListRefsResult = {
  isRepo: true,
  nextCursor: null,
  refs: [
    { name: "main", current: true, isDefault: true, worktreePath: "c:/code/proj" },
    { name: "feat", current: false, isDefault: false, worktreePath: "C:\\code\\proj-feat" },
    { name: "origin/main", current: false, isDefault: false, isRemote: true, worktreePath: null },
  ],
};

const running = (id: string): Run => ({
  id,
  ordinal: 1,
  rootNodeId: null,
  userMessageId: "user",
  status: "running",
  requestedAt: "2026-01-01T00:00:01.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  completedAt: null,
});
const done = (id: string): Run => ({
  ...running(id),
  status: "completed",
  completedAt: "2026-01-01T00:00:02.000Z",
});
const launch = (key: string, extra: Record<string, unknown> = {}) => ({
  project: "p1",
  harness: "testHarness",
  model: "large",
  title: "T",
  prompt: "go",
  idempotencyKey: key,
  ...extra,
});

describe("tool registry", () => {
  it("exposes the T3 tools with schemas and read-only annotations", async () => {
    const { client } = await harness({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      "t3_cancel_turn",
      "t3_create_thread",
      "t3_get_thread",
      "t3_list_harnesses",
      "t3_list_projects",
      "t3_list_threads",
      "t3_list_worktrees",
      "t3_send_message",
      "t3_wait_for_turn",
    ]);
    const create = tools.find((t) => t.name === "t3_create_thread");
    const schema = z
      .object({
        type: z.string(),
        required: z.array(z.string()),
        properties: z.object({ harness: z.object({ description: z.string() }) }),
      })
      .parse(create?.inputSchema);
    expect(schema.type).toBe("object");
    for (const field of ["project", "harness", "model", "title", "prompt"]) {
      expect(schema.required).toContain(field);
    }
    expect(schema.properties.harness.description).toMatch(/t3_list_harnesses/);
    expect(tools.find((t) => t.name === "t3_list_projects")?.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(tools.find((t) => t.name === "t3_cancel_turn")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("reports schema violations and thrown errors as isError results", async () => {
    const { call } = await harness({ shell: async () => shell([]) });
    expect(toolError(await call("t3_create_thread", { project: "p1" }))).toMatch(
      /validation|Invalid/i,
    );
    expect(toolError(await call("t3_list_worktrees", { project: "zzz" }))).toMatch(
      /project "zzz" not found/,
    );
  });
});

describe("read tools", () => {
  it("lists projects, worktrees, harnesses, and threads", async () => {
    const threads = [
      thread("old", done("A"), { updatedAt: "2026-01-01T00:00:00.000Z" }),
      thread("new", running("B"), {
        updatedAt: "2026-02-01T00:00:00.000Z",
        pendingRuntimeRequest: { kind: "permission" },
      }),
      thread("gone", null, {
        updatedAt: "2026-03-01T00:00:00.000Z",
        archivedAt: "2026-03-02T00:00:00.000Z",
      }),
    ];
    const { call } = await harness({
      shell: async () => shell(threads),
      listRefs: async () => refs,
      config: async () => ({ providers: [provider, brokenProvider] }),
    });

    expect(await call("t3_list_projects")).toEqual([
      { id: "p1", title: "proj", workspaceRoot: "C:\\code\\proj", defaultModelSelection: null },
    ]);

    const worktrees = await call("t3_list_worktrees", { project: "proj" });
    expect(worktrees).toMatchObject({
      worktrees: [
        { worktreePath: "C:\\code\\proj", branch: "main", isProjectRoot: true },
        { worktreePath: "C:\\code\\proj-feat", branch: "feat", isProjectRoot: false },
      ],
      branches: [{ name: "main" }, { name: "feat" }],
    });

    const usable = await call("t3_list_harnesses");
    expect(usable).toHaveLength(1);
    expect(usable).toMatchObject([
      {
        harnessId: "testHarness",
        usable: true,
        models: [{ model: "model-large", aliases: ["large"], isDefault: true }],
      },
    ]);
    const all = await call("t3_list_harnesses", { includeUnusable: true });
    expect(all).toMatchObject([
      {},
      { harnessId: "missingHarness", usable: false, reason: "missingHarness CLI missing" },
    ]);

    const listed = await call("t3_list_threads", { project: "p1" });
    expect(listed).toMatchObject([
      {
        threadId: "new",
        turn: { state: "running" },
        needsAttention: { pendingApprovals: true },
        url: "http://t3/env-9/new",
      },
      { threadId: "old" },
    ]);
    expect(await call("t3_list_threads", { includeArchived: true, limit: 1 })).toMatchObject([
      { threadId: "gone" },
    ]);
  });

  it("reads a thread window and truncates long messages", async () => {
    const long = "x".repeat(500);
    const snapshot = detail(thread("t1", done("A")), [
      { id: "u0", role: "user", text: "first", runId: "A", streaming: false, createdAt: "" },
      { id: "u1", role: "user", text: "hi", runId: "A", streaming: false, createdAt: "" },
      { id: "a1", role: "assistant", text: long, runId: "A", streaming: false, createdAt: "" },
    ]);
    snapshot.proposedPlans = [
      { id: "plan", kind: "proposed_plan", runId: "A", status: "active", markdown: long },
    ];
    const { call } = await harness({
      thread: async () => {
        return snapshot;
      },
    });
    const result = z
      .object({
        messages: z.array(z.object({ id: z.string(), text: z.string() })),
        proposedPlans: z.array(z.object({ markdown: z.string() })),
      })
      .parse(await call("t3_get_thread", { threadId: "t1", messageLimit: 2, maxChars: 100 }));
    expect(result.proposedPlans[0]?.markdown).toMatch(/^x{100}\n…\[truncated 400 chars\]$/);
    expect(result.messages.map((m: { id: string }) => m.id)).toEqual(["u1", "a1"]);
    expect(result.messages[1]?.text).toMatch(/^x{100}\n…\[truncated 400 chars\]$/);
  });
  it("keeps an active plan visible when the detail window is smaller than plan history", async () => {
    const snapshot = detail(thread("t1", done("B"), { hasActionableProposedPlan: true }));
    snapshot.proposedPlans = [
      {
        id: "active",
        kind: "proposed_plan",
        runId: "A",
        status: "active",
        markdown: "Review this plan",
      },
      {
        id: "newer",
        kind: "proposed_plan",
        runId: "B",
        status: "draft",
        markdown: "Still drafting",
      },
    ];
    const { call } = await harness({ thread: async () => snapshot });
    expect(await call("t3_get_thread", { threadId: "t1", messageLimit: 1 })).toMatchObject({
      needsAttention: { actionablePlan: true },
      proposedPlans: [{ id: "active", markdown: "Review this plan" }],
    });
  });
});

describe("t3_create_thread", () => {
  it("bootstraps a thread on the project root and reports the web url", async () => {
    const ids = commandIds("launch", "k1");
    const created: unknown[] = [];
    const { call } = await harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [provider] }),
      listRefs: async () => refs,
      createThread: async (spec) => {
        created.push(spec);
        return { threadId: "t1", resumed: false };
      },
      thread: async () => detail(thread(ids.threadId, null)),
    });
    const result = await call(
      "t3_create_thread",
      launch("k1", { context: [{ label: "Why", text: "because" }] }),
    );
    expect(result).toMatchObject({
      reused: false,
      idempotencyKey: "k1",
      threadId: ids.threadId,
      url: `http://t3/env-9/${ids.threadId}`,
    });
    expect(created[0]).toMatchObject({
      threadId: ids.threadId,
      commandId: ids.commandId,
      messageId: ids.messageId,
      modelSelection: { instanceId: "testHarness", model: "model-large" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root", branch: "main" },
      text: "go\n\n---\n\n### Why\n\nbecause",
    });
  });

  it("asks T3 for a fresh worktree from a known local branch", async () => {
    const created: unknown[] = [];
    const { call } = await harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [provider] }),
      listRefs: async () => refs,
      createThread: async (spec) => {
        created.push(spec);
        return { threadId: "t1", resumed: false };
      },
      thread: async (id) => detail(thread(id, null)),
    });
    expect(
      toolError(
        await call("t3_create_thread", launch("k2", { newWorktree: { baseBranch: "nope" } })),
      ),
    ).toMatch(/baseBranch "nope" is not a local branch.*main, feat/);
    expect(
      toolError(
        await call(
          "t3_create_thread",
          launch("k2", { newWorktree: { baseBranch: "main" }, worktreePath: "x" }),
        ),
      ),
    ).toMatch(/not both/);
    await call(
      "t3_create_thread",
      launch("k2", {
        newWorktree: { baseBranch: "main", branch: "feat/x" },
      }),
    );
    expect(created[0]).toMatchObject({
      workspaceStrategy: {
        type: "worktree",
        baseRef: "main",
        branch: "feat/x",
        startFromOrigin: false,
      },
    });
  });

  it("retries launches through T3 so preparation resumes without dispatching a second run", async () => {
    const ids = commandIds("launch", "k3");
    const created: unknown[] = [];
    const { call } = await harness({
      shell: async () => shell([thread(ids.threadId, null)]),
      config: async () => ({ providers: [provider] }),
      listRefs: async () => refs,
      createThread: async (spec) => {
        created.push(spec);
        return { threadId: ids.threadId, resumed: true };
      },
      thread: async () => detail(thread(ids.threadId, null)),
    });
    expect(await call("t3_create_thread", launch("k3"))).toMatchObject({
      reused: true,
      threadId: ids.threadId,
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ commandId: ids.commandId, messageId: ids.messageId });
  });

  it("refuses to launch when V2 cannot honor skipping setup", async () => {
    const { call } = await harness({});
    expect(
      toolError(
        await call(
          "t3_create_thread",
          launch("skip", {
            newWorktree: { baseBranch: "main", runSetupScript: false },
          }),
        ),
      ),
    ).toMatch(/runSetupScript|Unrecognized/i);
  });

  it("refuses unknown or unusable harnesses, models, and worktrees without substituting", async () => {
    const { call } = await harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [provider, brokenProvider] }),
      listRefs: async () => refs,
    });
    expect(
      toolError(await call("t3_create_thread", launch("k4", { harness: "unknownHarness" }))),
    ).toMatch(/harness "unknownHarness" not found.*testHarness, missingHarness/);
    expect(
      toolError(await call("t3_create_thread", launch("k4", { harness: "missingHarness" }))),
    ).toMatch(/not usable right now: missingHarness CLI missing/);
    expect(
      toolError(await call("t3_create_thread", launch("k4", { model: "unknown-model" }))),
    ).toMatch(/not offered by harness "testHarness"/);
    expect(
      toolError(await call("t3_create_thread", launch("k4", { worktreePath: "/elsewhere" }))),
    ).toMatch(/is not a worktree of project "proj"/);
  });

  it("waits for its own turn when asked and returns the reply", async () => {
    const ids = commandIds("launch", "k5");
    const waited: unknown[] = [];
    const settled = detail(thread(ids.threadId, done("A")), [
      { id: "a1", role: "assistant", text: "PONG", runId: "A", streaming: false, createdAt: "" },
    ]);
    const { call } = await harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [provider] }),
      listRefs: async () => refs,
      createThread: async () => ({ threadId: ids.threadId, resumed: false }),
      waitForTurn: async (threadId, timeoutMs, options) => {
        waited.push({ threadId, timeoutMs, options });
        return { snapshot: settled, timedOut: false };
      },
    });
    const result = await call("t3_create_thread", launch("k5", { wait: true, timeoutSeconds: 7 }));
    expect(waited).toEqual([
      { threadId: ids.threadId, timeoutMs: 7000, options: { expectedMessageId: ids.messageId } },
    ]);
    expect(result).toMatchObject({ timedOut: false, reply: { messageId: "a1", text: "PONG" } });
  });
});

describe("t3_send_message", () => {
  it("starts a turn with the thread's modes and skips when the message already landed", async () => {
    const ids = commandIds("t1", "f1");
    const started: unknown[] = [];
    const fresh = detail(thread("t1", done("A"), { runtimeMode: "auto", interactionMode: "plan" }));
    const { call } = await harness({
      thread: async () => fresh,
      startTurn: async (spec) => {
        started.push(spec);
        return { sequence: 3 };
      },
    });
    expect(
      await call("t3_send_message", { threadId: "t1", prompt: "more", idempotencyKey: "f1" }),
    ).toMatchObject({ reused: false, threadId: "t1" });
    expect(started[0]).toMatchObject({
      threadId: "t1",
      commandId: ids.commandId,
      messageId: ids.messageId,
      text: "more",
      runtimeMode: undefined,
      interactionMode: undefined,
    });

    const landed = detail(thread("t1", running("B")), [
      {
        id: ids.messageId,
        role: "user",
        text: "more",
        runId: "B",
        streaming: false,
        createdAt: "",
      },
    ]);
    const again = await harness({
      thread: async () => landed,
      startTurn: async () => {
        throw new Error("must not start twice");
      },
    });
    expect(
      await again.call("t3_send_message", { threadId: "t1", prompt: "more", idempotencyKey: "f1" }),
    ).toMatchObject({ reused: true });
  });
});

describe("t3_cancel_turn and t3_wait_for_turn", () => {
  it("is a no-op without a running turn and interrupts a running one", async () => {
    const idle = await harness({ thread: async () => detail(thread("t1", done("A"))) });
    expect(await idle.call("t3_cancel_turn", { threadId: "t1" })).toMatchObject({
      cancelled: false,
      reason: "No turn is running.",
    });

    const interrupts: unknown[] = [];
    const busy = await harness({
      thread: async () => detail(thread("t1", running("B"))),
      interruptTurn: async (_commandId, threadId, turnId) => {
        interrupts.push({ threadId, turnId });
        return { sequence: 4 };
      },
      waitForTurn: async () => ({
        snapshot: detail(thread("t1", { ...running("B"), status: "interrupted" })),
        timedOut: false,
      }),
    });
    expect(await busy.call("t3_cancel_turn", { threadId: "t1" })).toMatchObject({
      cancelled: true,
      turn: { state: "interrupted" },
    });
    expect(interrupts).toEqual([{ threadId: "t1", turnId: "B" }]);
  });

  it("does not interrupt a run waiting at a checkpoint", async () => {
    const { call } = await harness({
      thread: async () => detail(thread("t1", { ...running("B"), status: "waiting" })),
    });
    expect(await call("t3_cancel_turn", { threadId: "t1" })).toMatchObject({
      cancelled: false,
      reason: "No turn is running.",
      turn: { state: "waiting" },
    });
  });

  it.each([
    ["running", true],
    ["completed", false],
  ] as const)("does not claim cancellation when the run is %s", async (status, timedOut) => {
    const { call } = await harness({
      thread: async () => detail(thread("t1", running("B"))),
      interruptTurn: async () => ({ sequence: 1 }),
      waitForTurn: async () => ({
        snapshot: detail(thread("t1", { ...running("B"), status })),
        timedOut,
      }),
    });
    expect(await call("t3_cancel_turn", { threadId: "t1" })).toMatchObject({
      cancelled: false,
      timedOut,
      turn: { state: status },
    });
  });

  it("returns the latest reply and the timeout flag when waiting", async () => {
    const snapshot = detail(thread("t1", running("B")), [
      { id: "a0", role: "assistant", text: "partial", runId: "B", streaming: true, createdAt: "" },
    ]);
    const { call } = await harness({ waitForTurn: async () => ({ snapshot, timedOut: true }) });
    expect(await call("t3_wait_for_turn", { threadId: "t1", timeoutSeconds: 1 })).toMatchObject({
      timedOut: true,
      reply: { messageId: "a0", streaming: true, text: "partial" },
    });
  });
});
