import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { commandIds } from "../../t3/command-ids.ts";
import type { WorkspaceStrategy } from "../../t3/contracts/commands.ts";
import {
  resolveHarness,
  resolveModel,
  resolveProject,
  resolveWorktree,
} from "../../t3/selection.ts";
import {
  composeMessage,
  renderMessages,
  summarizeThread,
  truncateText,
  turnResult,
} from "../presenters.ts";
import { MUTATING, READ_ONLY, registerJsonTool, type ClientSource } from "../register-tool.ts";
import {
  contextSchema,
  interactionModeSchema,
  runtimeModeSchema,
  waitFields,
  waitTimeoutMs,
} from "../schemas.ts";

export function registerThreadTools(server: McpServer, source: ClientSource): void {
  registerJsonTool(
    server,
    "t3_list_threads",
    {
      title: "List threads",
      description: "List recent T3 threads, newest first. Optionally filter by project.",
      input: {
        project: z.string().optional().describe("Project id, exact title, or workspace root path"),
        includeArchived: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 25"),
      },
      annotations: READ_ONLY,
    },
    async ({ project, includeArchived, limit }) => {
      const client = await source.getClient();
      const shell = await client.shell();
      const projectId = project ? resolveProject(shell.projects, project).id : undefined;
      return shell.threads
        .filter((t) => (projectId ? t.projectId === projectId : true))
        .filter((t) => includeArchived || t.archivedAt === null)
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit ?? 25)
        .map((t) => summarizeThread(client, t));
    },
  );

  registerJsonTool(
    server,
    "t3_create_thread",
    {
      title: "Create a T3 thread and send the first prompt",
      description:
        "Create a new thread in T3 with an explicit project, worktree, harness, and model, then send the first prompt. The thread appears in the T3 UI. Nothing is substituted: unknown or unusable choices fail with the valid options. Pass the same idempotencyKey on retries to guarantee a single launch; a key whose command T3 rejected is burned and needs a new key.",
      input: {
        project: z
          .string()
          .describe("Project id, exact title, or workspace root (see t3_list_projects)"),
        harness: z.string().describe("Harness id exactly as listed by t3_list_harnesses"),
        model: z.string().describe("Model slug or alias exactly as listed for that harness"),
        title: z.string().min(1).describe("Thread title shown in T3"),
        prompt: z.string().min(1).describe("First user message"),
        context: contextSchema,
        worktreePath: z
          .string()
          .optional()
          .describe(
            "Existing worktree path from t3_list_worktrees, or the project root. Default: project root.",
          ),
        newWorktree: z
          .object({
            baseBranch: z.string().describe("Local branch to start from"),
            branch: z
              .string()
              .optional()
              .describe("Name for the new branch; T3 generates one when omitted"),
          })
          .strict()
          .optional()
          .describe(
            "Ask T3 to create a fresh worktree for this thread. Mutually exclusive with worktreePath.",
          ),
        runtimeMode: runtimeModeSchema.optional().describe("Default full-access"),
        interactionMode: interactionModeSchema
          .optional()
          .describe("Default 'default'; 'plan' asks for a plan first"),
        idempotencyKey: z
          .string()
          .optional()
          .describe(
            "Stable key; retries with the same key reuse the same thread instead of launching again",
          ),
        ...waitFields,
      },
      annotations: MUTATING,
    },
    async (input) => {
      if (input.worktreePath && input.newWorktree) {
        throw new Error("Pass either worktreePath or newWorktree, not both.");
      }
      const client = await source.getClient();
      const [shell, config] = await Promise.all([client.shell(), client.config()]);
      const project = resolveProject(shell.projects, input.project);
      const harness = resolveHarness(config.providers, input.harness);
      const model = resolveModel(harness, input.model);
      const ids = commandIds("launch", input.idempotencyKey);
      const text = composeMessage(input.prompt, input.context);

      const { refs } = await client.listRefs(project.workspaceRoot);
      let workspaceStrategy: WorkspaceStrategy;
      if (input.newWorktree) {
        const locals = refs.filter((r) => !r.isRemote);
        const base = locals.find((r) => r.name === input.newWorktree?.baseBranch);
        if (!base) {
          throw new Error(
            `baseBranch "${input.newWorktree.baseBranch}" is not a local branch of ${project.title}. Known: ${locals.map((r) => r.name).join(", ")}`,
          );
        }
        workspaceStrategy = {
          type: "worktree",
          baseRef: base.name,
          startFromOrigin: false,
          ...(input.newWorktree.branch ? { branch: input.newWorktree.branch } : {}),
        };
      } else {
        const choice = resolveWorktree(project, refs, input.worktreePath ?? project.workspaceRoot);
        const branch = choice.branch ? { branch: choice.branch } : {};
        workspaceStrategy = choice.worktreePath
          ? { type: "existing_worktree", worktreePath: choice.worktreePath, ...branch }
          : { type: "root", ...branch };
      }
      const created = await client.createThread({
        ...ids,
        projectId: project.id,
        title: input.title,
        modelSelection: { instanceId: harness.instanceId, model: model.slug },
        runtimeMode: input.runtimeMode ?? "full-access",
        interactionMode: input.interactionMode ?? "default",
        workspaceStrategy,
        text,
      });

      const base = { reused: created.resumed, idempotencyKey: ids.idempotencyKey };
      if (input.wait) {
        const { snapshot, timedOut } = await client.waitForTurn(
          ids.threadId,
          waitTimeoutMs(input.timeoutSeconds),
          { expectedMessageId: ids.messageId },
        );
        return { ...base, ...turnResult(client, snapshot, timedOut) };
      }
      return { ...base, ...summarizeThread(client, (await client.thread(ids.threadId)).thread) };
    },
  );

  registerJsonTool(
    server,
    "t3_get_thread",
    {
      title: "Read a thread",
      description:
        "Read a thread's status, latest turn state, and recent messages (assistant replies included).",
      input: {
        threadId: z.string(),
        messageLimit: z.number().int().min(1).max(200).optional().describe("Default 10"),
        maxChars: z
          .number()
          .int()
          .min(100)
          .max(200_000)
          .optional()
          .describe("Truncate each message to this many characters (default 20000)"),
      },
      annotations: READ_ONLY,
    },
    async ({ threadId, messageLimit, maxChars }) => {
      const client = await source.getClient();
      const limit = messageLimit ?? 10;
      const snapshot = await client.thread(threadId);
      return {
        ...summarizeThread(client, snapshot.thread),
        messages: renderMessages(snapshot.messages, limit, maxChars ?? 20_000),
        proposedPlans: snapshot.proposedPlans
          .toSorted((a, b) => Number(a.status === "active") - Number(b.status === "active"))
          .slice(-limit)
          .map((plan) => ({
            id: plan.id,
            runId: plan.runId,
            status: plan.status,
            markdown: truncateText(plan.markdown, maxChars ?? 20_000),
          })),
      };
    },
  );
}
