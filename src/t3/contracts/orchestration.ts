import * as z from "zod/v4";

import { modelSelectionSchema } from "./providers.ts";

export const RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
export const INTERACTION_MODES = ["default", "plan"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export type InteractionMode = (typeof INTERACTION_MODES)[number];

export const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  workspaceRoot: z.string(),
  defaultModelSelection: modelSelectionSchema.nullable(),
});
const appThreadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  providerInstanceId: z.string(),
  modelSelection: modelSelectionSchema,
  runtimeMode: z.enum(RUNTIME_MODES),
  interactionMode: z.enum(INTERACTION_MODES),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export const runtimeRequestSchema = z.object({ kind: z.string(), status: z.string() });
export const threadSchema = appThreadSchema.extend({
  latestRunId: z.string().nullable(),
  latestRunStartedAt: z.string().nullable().optional(),
  latestRunCompletedAt: z.string().nullable().optional(),
  status: z.string(),
  lastError: z.string().nullable().optional(),
  pendingRuntimeRequest: runtimeRequestSchema.pick({ kind: true }).nullable(),
  hasActionableProposedPlan: z.boolean().optional(),
});
export const shellSnapshotSchema = z.object({
  schemaVersion: z.number(),
  snapshotSequence: z.number(),
  projects: z.array(projectSchema),
  threads: z.array(threadSchema),
  archivedThreads: z.array(threadSchema),
});
export const messageSchema = z.object({
  id: z.string(),
  role: z.string(),
  text: z.string(),
  runId: z.string().nullable(),
  streaming: z.boolean(),
  createdAt: z.string(),
});
export const runSchema = z.object({
  id: z.string(),
  ordinal: z.number().int().positive(),
  rootNodeId: z.string().nullable(),
  queueHeld: z.boolean().optional(),
  userMessageId: z.string(),
  status: z.string(),
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
const turnItemSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    runId: z.string().nullable(),
    nodeId: z.string().nullable(),
    status: z.string(),
    ordinal: z.number(),
    updatedAt: z.string(),
    planId: z.string().optional(),
    failure: z.object({ class: z.string(), message: z.string() }).optional(),
  })
  .refine((item) => item.type !== "proposed_plan" || item.planId !== undefined, {
    path: ["planId"],
    message: "Proposed plan items must include a plan id",
  })
  .refine((item) => item.type !== "error" || item.failure !== undefined, {
    path: ["failure"],
    message: "Error items must include a failure",
  });
const planFields = { id: z.string(), runId: z.string().nullable(), status: z.string() };
const proposedPlanSchema = z.object({
  ...planFields,
  kind: z.literal("proposed_plan"),
  markdown: z.string(),
});
const planSchema = z.discriminatedUnion("kind", [
  proposedPlanSchema,
  z.object({ ...planFields, kind: z.literal("todo_list") }),
]);
export const threadSnapshotSchema = z.object({
  snapshotSequence: z.number(),
  projection: z.object({
    thread: appThreadSchema,
    runs: z.array(runSchema),
    messages: z.array(messageSchema),
    providerSessions: z.array(
      z.object({
        providerInstanceId: z.string(),
        lastError: z.string().nullable(),
        updatedAt: z.string(),
      }),
    ),
    turnItems: z.array(turnItemSchema),
    runtimeRequests: z.array(runtimeRequestSchema),
    plans: z.array(planSchema),
  }),
});
export type Project = z.infer<typeof projectSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type Run = z.infer<typeof runSchema>;
export type Message = z.infer<typeof messageSchema>;
export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;
export type WireThreadSnapshot = z.infer<typeof threadSnapshotSchema>;
export interface ShellSnapshot {
  snapshotSequence: number;
  projects: Project[];
  threads: Thread[];
}
export interface ThreadSnapshot {
  snapshotSequence: number;
  thread: Thread;
  runs: Run[];
  messages: Message[];
  runtimeRequests: RuntimeRequest[];
  runErrors: Record<string, string>;
  proposedPlans: z.infer<typeof proposedPlanSchema>[];
}
