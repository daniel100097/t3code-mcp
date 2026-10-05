import * as z from "zod/v4";

import type { InteractionMode, RuntimeMode } from "./orchestration.ts";

interface ThreadCommand {
  commandId: string;
  threadId: string;
}

export type OrchestrationCommand = ThreadCommand &
  (
    | {
        type: "message.dispatch";
        createdBy: "user";
        creationSource: "mcp";
        messageId: string;
        text: string;
        attachments: [];
        deliveryIntent: "auto";
        dispatchMode: { type: "start_immediately" };
      }
    | { type: "run.interrupt"; runId: string; holdQueue: true }
    | { type: "thread.runtime-mode.set"; runtimeMode: RuntimeMode }
    | { type: "thread.interaction-mode.set"; interactionMode: InteractionMode }
  );

export const dispatchResultSchema = z.object({ sequence: z.number() });
export type DispatchResult = z.infer<typeof dispatchResultSchema>;
export const launchResultSchema = z.object({ threadId: z.string(), resumed: z.boolean() });
export type LaunchResult = z.infer<typeof launchResultSchema>;

export type WorkspaceStrategy =
  | { type: "root"; branch?: string }
  | { type: "existing_worktree"; worktreePath: string; branch?: string }
  | { type: "worktree"; baseRef: string; branch?: string; startFromOrigin: boolean };
