import { describe, expect, it } from "bun:test";

import { turnResult } from "../../src/mcp/presenters.ts";
import { T3Client } from "../../src/t3/client.ts";
import type { CreateThreadOptions } from "../../src/t3/client.ts";
import type { T3Connection } from "../../src/t3/connection.ts";
import { assertThreadSnapshot } from "../../src/t3/thread-snapshot.ts";
import { isTurnSettled } from "../../src/t3/turn-waiter.ts";

const thread = {
  providerInstanceId: "testHarness",
  id: "t1",
  projectId: "p1",
  title: "T",
  modelSelection: {
    instanceId: "testHarness",
    model: "m",
    options: [{ id: "effort", value: "high" }],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  updatedAt: "2026-01-01T00:00:02.000Z",
  archivedAt: null,
};
const run = (id: string, status: string, userMessageId = `u${id}`) => ({
  id,
  ordinal: id === "A" ? 1 : 2,
  rootNodeId: null,
  status,
  userMessageId,
  requestedAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  completedAt: null,
});
const message = (id: string, role: string, runId: string | null, streaming = false) => ({
  id,
  role,
  runId,
  streaming,
  text: id,
  createdAt: "2026-01-01T00:00:01.000Z",
});
const wire = (
  runs = [run("A", "running")],
  messages = [message("uA", "user", "A")],
  sequence = 1,
) => ({
  snapshotSequence: sequence,
  projection: {
    thread,
    runs,
    messages,
    runtimeRequests: [],
    providerSessions: [],
    turnItems: [],
    plans: [],
  },
});
function fakeConnection(snapshots: unknown[], events: unknown[] = []) {
  let reads = 0;
  let streams = 0;
  const calls: Array<{ tag: string; payload: unknown }> = [];
  const conn: T3Connection = {
    server: {
      origin: "http://x",
      source: "",
      pid: 0,
      environmentId: "e",
      orchestrationProtocolVersion: 2,
    },
    tokenSource: "test",
    http: { get: async () => snapshots[Math.min(reads++, snapshots.length - 1)] },
    rpc: {
      call: async (tag, payload) => {
        calls.push({ tag, payload });
        return tag === "orchestration.launchThread"
          ? { threadId: "t1", resumed: false }
          : { sequence: calls.length };
      },
      stream: async (_tag, _payload, onChunk, timeoutMs) => {
        streams++;
        for (const event of events) {
          if (onChunk(event) === true) {
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs ?? 0, 50)));
      },
      close() {},
    },
  };
  return { conn, calls, streams: () => streams };
}

describe("V2 snapshots", () => {
  it("reads canonical model options and refuses malformed lifecycle and message fields", async () => {
    const snapshot = assertThreadSnapshot(wire());
    expect(snapshot.thread.modelSelection.options).toEqual([{ id: "effort", value: "high" }]);
    expect(() => assertThreadSnapshot({ snapshotSequence: 1, projection: { thread } })).toThrow(
      /contract may have changed/,
    );
    const valid = wire();
    const broken = {
      ...valid,
      projection: {
        ...valid.projection,
        messages: [{ ...message("a1", "assistant", "A"), streaming: "false" }],
      },
    };
    const fake = fakeConnection([broken]);
    await expect(new T3Client(fake.conn).thread("t1")).rejects.toThrow(
      /projection.messages.0.streaming/,
    );
  });

  it.each(["preparing", "queued", "starting", "running", "waiting", "future-state"])(
    "does not report %s runs as finished",
    (status) => {
      expect(isTurnSettled(assertThreadSnapshot(wire([run("A", status)])))).toBe(false);
    },
  );

  it("requires a terminal run and a finished assistant message", () => {
    expect(isTurnSettled(assertThreadSnapshot(wire([], [])))).toBe(false);
    expect(
      isTurnSettled(
        assertThreadSnapshot(
          wire([run("A", "completed")], [message("a1", "assistant", "A", true)]),
        ),
      ),
    ).toBe(false);
    expect(
      isTurnSettled(
        assertThreadSnapshot(wire([run("A", "completed")], [message("a1", "assistant", "A")])),
      ),
    ).toBe(true);
  });

  it("keeps held queued work out of the default turn but waits for it when requested", async () => {
    const queued = { ...run("B", "queued"), queueHeld: true };
    const value = wire([queued, run("A", "interrupted")], [message("uB", "user", "B")]);
    expect(assertThreadSnapshot(value).thread.latestRunId).toBe("A");
    const api = new T3Client(fakeConnection([value]).conn);
    expect((await api.waitForTurn("t1", 50)).timedOut).toBe(false);
    expect((await api.waitForTurn("t1", 50, { expectedMessageId: "uB" })).timedOut).toBe(true);
  });

  it("keeps usage limits visible when newer messages are queued", () => {
    const value = wire([run("A", "failed"), run("B", "queued")]);
    const limited = {
      ...value,
      projection: {
        ...value.projection,
        turnItems: [
          {
            id: "error",
            type: "error",
            runId: "A",
            nodeId: null,
            status: "failed",
            ordinal: 1,
            updatedAt: "2026-01-01T00:00:02.000Z",
            failure: { class: "usage_limit", message: "Quota reached" },
          },
        ],
      },
    };
    const result = assertThreadSnapshot(limited);
    expect(result.thread.latestRunId).toBe("A");
    expect(result.thread.lastError).toBe("Quota reached");
  });

  it("reports only the current provider's latest session error", () => {
    const value = wire([run("A", "failed")]);
    const snapshot = assertThreadSnapshot({
      ...value,
      projection: {
        ...value.projection,
        providerSessions: [
          {
            providerInstanceId: "testHarness",
            lastError: "Old failure",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            providerInstanceId: "testHarness",
            lastError: "Connection lost",
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
          {
            providerInstanceId: "other",
            lastError: "Other provider",
            updatedAt: "2026-01-01T00:00:03.000Z",
          },
        ],
      },
    });
    expect(snapshot.thread.lastError).toBe("Connection lost");
  });

  it("does not mistake the previous run for an unassigned follow-up", () => {
    const snapshot = assertThreadSnapshot(
      wire([run("A", "completed")], [message("u2", "user", null)]),
    );
    expect(isTurnSettled(snapshot, { expectedMessageId: "u2" })).toBe(false);
  });
});

describe("waiting and replies", () => {
  it("returns a plan-only run's markdown and keeps later plans out of a pinned wait", async () => {
    const value = wire([run("A", "completed"), run("B", "completed")]);
    const fake = fakeConnection([
      {
        ...value,
        projection: {
          ...value.projection,
          turnItems: [
            {
              id: "i1",
              type: "proposed_plan",
              planId: "zOld",
              runId: "B",
              nodeId: null,
              status: "completed",
              ordinal: 1,
              updatedAt: "2026-01-01T00:00:01.000Z",
            },
            {
              id: "i2",
              type: "proposed_plan",
              planId: "pB",
              runId: "B",
              nodeId: null,
              status: "completed",
              ordinal: 2,
              updatedAt: "2026-01-01T00:00:02.000Z",
            },
          ],
          plans: [
            {
              id: "pA",
              kind: "proposed_plan",
              runId: "A",
              status: "superseded",
              markdown: "Plan A",
            },
            { id: "todo", kind: "todo_list", runId: "B", status: "active" },
            { id: "pB", kind: "proposed_plan", runId: "B", status: "active", markdown: "Plan B" },
            {
              id: "zOld",
              kind: "proposed_plan",
              runId: "B",
              status: "superseded",
              markdown: "Old B",
            },
          ],
        },
      },
    ]);
    const api = new T3Client(fake.conn);
    expect(turnResult(api, await api.thread("t1"), false)).toMatchObject({
      reply: null,
      needsAttention: { actionablePlan: true },
      proposedPlan: { markdown: "Plan B" },
    });
    const { snapshot, timedOut } = await api.waitForTurn("t1", 1000, { expectedRunId: "A" });
    expect(timedOut).toBe(false);
    expect(turnResult(api, snapshot, false)).toMatchObject({
      reply: null,
      proposedPlan: { markdown: "Plan A" },
    });
  });

  it("presents the newest pending request and ignores resolved requests", () => {
    const value = wire();
    const snapshot = assertThreadSnapshot({
      ...value,
      projection: {
        ...value.projection,
        runtimeRequests: [
          { kind: "permission", status: "pending" },
          { kind: "user_input", status: "pending" },
          { kind: "command", status: "resolved" },
        ],
      },
    });
    expect(snapshot.thread.pendingRuntimeRequest?.kind).toBe("user_input");
    expect(snapshot.thread.hasActionableProposedPlan).toBe(false);
  });

  it("returns immediately for a terminal run", async () => {
    const fake = fakeConnection([wire([run("A", "completed")])]);
    expect((await new T3Client(fake.conn).waitForTurn("t1", 1000)).timedOut).toBe(false);
    expect(fake.streams()).toBe(0);
  });

  it("rereads V2 run events until the requested run settles", async () => {
    const fake = fakeConnection(
      [
        wire([run("A", "queued")]),
        wire([run("A", "running")]),
        wire(
          [run("A", "completed")],
          [message("uA", "user", "A"), message("a1", "assistant", "A")],
          2,
        ),
      ],
      [{ kind: "event", event: { type: "run.updated" } }],
    );
    const result = await new T3Client(fake.conn).waitForTurn("t1", 3000, {
      expectedMessageId: "uA",
    });
    expect(result.timedOut).toBe(false);
    expect(result.snapshot.thread.status).toBe("completed");
  });

  it("returns the requested reply even when a later run is active", async () => {
    const fake = fakeConnection([
      wire(
        [run("A", "completed"), run("B", "running")],
        [
          message("uA", "user", "A"),
          message("a1", "assistant", "A"),
          message("a2", "assistant", "B", true),
        ],
      ),
    ]);
    const api = new T3Client(fake.conn);
    const { snapshot, timedOut } = await api.waitForTurn("t1", 1000, { expectedMessageId: "uA" });
    expect(timedOut).toBe(false);
    expect(turnResult(api, snapshot, timedOut).reply?.text).toBe("a1");
  });

  it("does not attach a later run's failure to the requested completed run", async () => {
    const value = wire([run("A", "completed"), run("B", "failed")]);
    const fake = fakeConnection([
      {
        ...value,
        projection: {
          ...value.projection,
          turnItems: [
            {
              id: "error",
              type: "error",
              runId: "B",
              nodeId: null,
              status: "failed",
              ordinal: 1,
              updatedAt: "2026-01-01T00:00:02.000Z",
              failure: { class: "usage_limit", message: "Quota reached" },
            },
          ],
        },
      },
    ]);
    const api = new T3Client(fake.conn);
    const { snapshot } = await api.waitForTurn("t1", 1000, { expectedRunId: "A" });
    expect(turnResult(api, snapshot, false)).toMatchObject({
      turn: { turnId: "A", state: "completed" },
      session: { lastError: null },
    });
  });

  it("does not reuse an older assistant reply when the current run fails without one", async () => {
    const fake = fakeConnection([
      wire([run("A", "completed"), run("B", "failed")], [message("a1", "assistant", "A")]),
    ]);
    const api = new T3Client(fake.conn);
    expect(turnResult(api, await api.thread("t1"), false).reply).toBeNull();
  });

  it("pins a plain wait to the run active when waiting started", async () => {
    const fake = fakeConnection(
      [
        wire(),
        wire([run("A", "completed"), run("B", "running")], [message("a1", "assistant", "A")], 2),
      ],
      [{ kind: "snapshot" }],
    );
    const result = await new T3Client(fake.conn).waitForTurn("t1", 1000);
    expect(result.timedOut).toBe(false);
    expect(result.snapshot.thread.latestRunId).toBe("A");
  });

  it("times out when the requested message has not arrived", async () => {
    const fake = fakeConnection([wire([run("A", "completed")])]);
    const result = await new T3Client(fake.conn).waitForTurn("t1", 50, {
      expectedMessageId: "missing",
    });
    expect(result.timedOut).toBe(true);
  });
});

const launch: CreateThreadOptions = {
  commandId: "c1",
  threadId: "t1",
  messageId: "m1",
  projectId: "p1",
  title: "T",
  modelSelection: { instanceId: "testHarness", model: "m" },
  runtimeMode: "auto",
  interactionMode: "plan",
  workspaceStrategy: { type: "root" },
  text: "go",
};
describe("commands", () => {
  it("launches with the chosen workspace", async () => {
    const fake = fakeConnection([]);
    const api = new T3Client(fake.conn);
    await api.createThread({
      ...launch,
      workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
    });
    expect(fake.calls[0]).toMatchObject({
      tag: "orchestration.launchThread",
      payload: {
        threadId: "t1",
        commandId: "c1",
        workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
        initialMessage: { messageId: "m1", text: "go", attachments: [] },
      },
    });
    await api.createThread({
      ...launch,
      workspaceStrategy: {
        type: "existing_worktree",
        worktreePath: "/repo/feature",
        branch: "feature",
      },
    });
    expect(fake.calls[1]?.payload).toMatchObject({
      workspaceStrategy: {
        type: "existing_worktree",
        worktreePath: "/repo/feature",
        branch: "feature",
      },
    });
  });

  it("dispatches follow-ups with automatic delivery and interrupts the specific run with the queue held", async () => {
    const fake = fakeConnection([]);
    const api = new T3Client(fake.conn);
    await api.startTurn(launch);
    expect(fake.calls.at(-1)?.payload).toMatchObject({
      type: "message.dispatch",
      commandId: "c1",
      messageId: "m1",
      deliveryIntent: "auto",
      createdBy: "user",
    });
    await api.interruptTurn("c2", "t1", "A");
    expect(fake.calls.at(-1)?.payload).toMatchObject({
      type: "run.interrupt",
      runId: "A",
      holdQueue: true,
    });
  });

  it("leaves permission modes unchanged for a follow-up without overrides", async () => {
    const fake = fakeConnection([]);
    const accepted = await new T3Client(fake.conn).startTurn({
      commandId: "c1",
      threadId: "t1",
      messageId: "u1",
      text: "more",
    });
    expect(accepted.sequence).toBe(1);
    expect(fake.calls.map((call) => call.tag)).toEqual(["orchestration.dispatchCommand"]);
    expect(fake.calls[0]?.payload).toMatchObject({ type: "message.dispatch" });
  });

  it("follows vcs.listRefs cursors until the last page", async () => {
    const fake = fakeConnection([]);
    let page = 0;
    fake.conn.rpc.call = async () => {
      page++;
      return {
        refs: [
          { name: page === 1 ? "a" : "b", current: false, isDefault: false, worktreePath: null },
        ],
        isRepo: true,
        nextCursor: page === 1 ? 200 : null,
      };
    };
    const result = await new T3Client(fake.conn).listRefs("/repo");
    expect(result.refs.map((r) => r.name)).toEqual(["a", "b"]);
    expect(result.nextCursor).toBeNull();
    expect(page).toBe(2);
  });
});
