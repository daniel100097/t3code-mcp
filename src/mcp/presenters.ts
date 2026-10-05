import type { T3Client } from "../t3/client.ts";
import type { Message, Thread, ThreadSnapshot } from "../t3/contracts/orchestration.ts";
import { isApproval } from "../t3/thread-state.ts";
import type { MessageContext } from "./schemas.ts";

export const composeMessage = (prompt: string, context?: MessageContext): string =>
  context?.length
    ? `${prompt}\n\n---\n\n${context.map((c) => `### ${c.label ?? "Context"}\n\n${c.text}`).join("\n\n")}`
    : prompt;

const threadUrl = (client: T3Client, threadId: string): string =>
  `${client.connection.server.origin}/${client.connection.server.environmentId}/${threadId}`;

export const summarizeThread = (client: T3Client, thread: Thread) => ({
  threadId: thread.id,
  title: thread.title,
  projectId: thread.projectId,
  harness: thread.modelSelection.instanceId,
  model: thread.modelSelection.model,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  turn:
    thread.latestRunId === null
      ? null
      : {
          turnId: thread.latestRunId,
          state: thread.status,
          startedAt: thread.latestRunStartedAt ?? null,
          completedAt: thread.latestRunCompletedAt ?? null,
        },
  session: { status: thread.status, lastError: thread.lastError ?? null },
  archived: thread.archivedAt !== null,
  needsAttention: {
    pendingApprovals:
      thread.pendingRuntimeRequest !== null && isApproval(thread.pendingRuntimeRequest.kind),
    pendingUserInput: thread.pendingRuntimeRequest?.kind === "user_input",
    actionablePlan: thread.hasActionableProposedPlan ?? false,
  },
  url: threadUrl(client, thread.id),
});

export const truncateText = (text: string, maxChars: number): string =>
  text.length > maxChars
    ? `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`
    : text;

export const renderMessages = (messages: Message[], limit: number, maxChars: number) =>
  messages.slice(-limit).map((m) => ({
    id: m.id,
    role: m.role,
    turnId: m.runId,
    streaming: m.streaming,
    createdAt: m.createdAt,
    text: truncateText(m.text, maxChars),
  }));

export const turnResult = (client: T3Client, snapshot: ThreadSnapshot, timedOut: boolean) => {
  const reply =
    snapshot.messages.findLast(
      (message) => message.role === "assistant" && message.runId === snapshot.thread.latestRunId,
    ) ?? null;
  return {
    ...summarizeThread(client, snapshot.thread),
    timedOut,
    proposedPlan:
      snapshot.proposedPlans.findLast((plan) => plan.runId === snapshot.thread.latestRunId) ?? null,
    reply: reply && { messageId: reply.id, streaming: reply.streaming, text: reply.text },
  };
};
