import * as z from "zod/v4";

import type { T3Connection } from "./connection.ts";
import type { ThreadSnapshot } from "./contracts/orchestration.ts";
import { readThreadSnapshot } from "./thread-snapshot.ts";
import { isRunTerminal, runFields } from "./thread-state.ts";

export interface WaitForTurnOptions {
  /** Only the turn that carries this user message counts as the awaited one. */
  expectedMessageId?: string;
  expectedRunId?: string;
}

export interface WaitForTurnResult {
  snapshot: ThreadSnapshot;
  timedOut: boolean;
}

const threadEventSchema = z.object({
  kind: z.literal("event"),
  event: z.object({ type: z.string() }),
});

const snapshotHintSchema = z.object({ kind: z.literal("snapshot") });

const SETTLE_HINTS = new Set(["run.updated", "message.updated", "turn-item.upserted"]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Settlement events can precede HTTP snapshots; reread before accepting a result.
export async function waitForTurn(
  connection: T3Connection,
  threadId: string,
  timeoutMs: number,
  options: WaitForTurnOptions = {},
): Promise<WaitForTurnResult> {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await readThreadSnapshot(connection.http, threadId);
  const target = {
    ...options,
    expectedRunId:
      options.expectedRunId ??
      (options.expectedMessageId ? undefined : (snapshot.thread.latestRunId ?? undefined)),
  };
  snapshot = selectAwaitedRun(snapshot, target);
  if (isTurnSettled(snapshot, target)) {
    return { snapshot, timedOut: false };
  }
  while (Date.now() < deadline) {
    let hinted = false;
    await connection.rpc.stream(
      "orchestration.subscribeThread",
      { threadId, afterSequence: snapshot.snapshotSequence },
      (item) => {
        if (snapshotHintSchema.safeParse(item).success) {
          hinted = true;
          return true;
        }
        const record = threadEventSchema.safeParse(item);
        if (!record.success || !SETTLE_HINTS.has(record.data.event.type)) {
          return false;
        }
        hinted = true;
        return true;
      },
      Math.max(0, deadline - Date.now()),
    );
    if (!hinted) {
      break;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      snapshot = selectAwaitedRun(await readThreadSnapshot(connection.http, threadId), target);
      if (isTurnSettled(snapshot, target)) {
        return { snapshot, timedOut: false };
      }
      await sleep(150 * (attempt + 1));
    }
  }
  snapshot = selectAwaitedRun(await readThreadSnapshot(connection.http, threadId), target);
  return { snapshot, timedOut: !isTurnSettled(snapshot, target) };
}

function selectAwaitedRun(snapshot: ThreadSnapshot, options: WaitForTurnOptions): ThreadSnapshot {
  const message = snapshot.messages.find((m) => m.id === options.expectedMessageId);
  const runId = options.expectedRunId ?? message?.runId;
  const run = runId
    ? snapshot.runs.find((r) => r.id === runId)
    : snapshot.runs.find((r) => r.userMessageId === options.expectedMessageId);
  if (!run) {
    return snapshot;
  }
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      ...runFields(run),
      lastError:
        run.id === snapshot.thread.latestRunId
          ? snapshot.thread.lastError
          : (snapshot.runErrors[run.id] ?? null),
    },
  };
}

export function isTurnSettled(snapshot: ThreadSnapshot, options: WaitForTurnOptions = {}): boolean {
  const { thread, messages } = snapshot;
  if (!thread.latestRunId || !isRunTerminal(thread.status)) {
    return false;
  }
  if (options.expectedRunId && thread.latestRunId !== options.expectedRunId) {
    return false;
  }
  if (
    options.expectedMessageId &&
    !messages.some(
      (message) => message.id === options.expectedMessageId && message.runId === thread.latestRunId,
    )
  ) {
    return false;
  }
  return !messages.some(
    (message) =>
      message.role === "assistant" && message.runId === thread.latestRunId && message.streaming,
  );
}
