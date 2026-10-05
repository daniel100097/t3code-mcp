import type { Run, ThreadSnapshot, WireThreadSnapshot } from "./contracts/orchestration.ts";

export const isRunInterruptible = (status: string): boolean =>
  ["preparing", "starting", "running"].includes(status);
export const isRunTerminal = (status: string): boolean =>
  ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(status);
export const isApproval = (kind: string): boolean =>
  ["command", "file-read", "file-change", "mcp-elicitation", "permission"].includes(kind);

export const runFields = (run?: Run) => ({
  latestRunId: run?.id ?? null,
  latestRunStartedAt: run?.startedAt ?? null,
  latestRunCompletedAt: run?.completedAt ?? null,
  status: run?.status ?? "idle",
});

// Keep run and error presentation aligned with @t3tools/shared/orchestrationV2ThreadError.
export function projectThreadSnapshot(snapshot: WireThreadSnapshot): ThreadSnapshot {
  const { thread, runs, runtimeRequests, providerSessions, turnItems } = snapshot.projection;
  const orderedRuns = runs.toSorted((a, b) => b.ordinal - a.ordinal);
  const sessionError =
    providerSessions
      .filter((session) => session.providerInstanceId === thread.providerInstanceId)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.lastError ?? null;
  const rootFailure = (run: Run | undefined) =>
    run?.status === "failed"
      ? turnItems
          .filter(
            (item) =>
              item.type === "error" &&
              item.status === "failed" &&
              item.runId === run.id &&
              item.nodeId === run.rootNodeId,
          )
          .toSorted(
            (a, b) =>
              b.updatedAt.localeCompare(a.updatedAt) ||
              b.ordinal - a.ordinal ||
              b.id.localeCompare(a.id),
          )[0]?.failure
      : undefined;
  const executed = orderedRuns.find(
    (run) => run.status !== "queued" && !(run.status === "cancelled" && run.startedAt === null),
  );
  const failure = rootFailure(executed);
  // A usage limit remains visible while newer messages wait behind it.
  const limited =
    failure?.class === "usage_limit" &&
    (sessionError === null || sessionError === failure.message) &&
    orderedRuns.some((run) => executed !== undefined && run.ordinal > executed.ordinal);
  const latest = limited
    ? executed
    : orderedRuns.find((run) => !(run.status === "queued" && run.queueHeld === true));
  const pending = runtimeRequests.findLast((r) => r.status === "pending");
  const planTimes = new Map<string, string>();
  for (const item of turnItems) {
    if (
      item.type === "proposed_plan" &&
      item.planId &&
      item.updatedAt > (planTimes.get(item.planId) ?? "")
    ) {
      planTimes.set(item.planId, item.updatedAt);
    }
  }
  const proposedPlans = snapshot.projection.plans
    .filter((plan) => plan.kind === "proposed_plan")
    .toSorted(
      (a, b) =>
        (planTimes.get(a.id) ?? "").localeCompare(planTimes.get(b.id) ?? "") ||
        a.id.localeCompare(b.id),
    );
  return {
    proposedPlans,
    snapshotSequence: snapshot.snapshotSequence,
    runs,
    runErrors: Object.fromEntries(
      runs.flatMap((run) => {
        const error = rootFailure(run)?.message;
        return error ? [[run.id, error]] : [];
      }),
    ),
    messages: snapshot.projection.messages,
    runtimeRequests,
    thread: {
      ...thread,
      ...runFields(latest),
      lastError: sessionError ?? rootFailure(latest)?.message ?? null,
      pendingRuntimeRequest: pending ?? null,
      hasActionableProposedPlan: proposedPlans.some((plan) => plan.status === "active"),
    },
  };
}
