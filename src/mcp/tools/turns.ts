import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { commandIds } from "../../t3/command-ids.ts";
import { isRunInterruptible } from "../../t3/thread-state.ts";
import { composeMessage, summarizeThread, turnResult } from "../presenters.ts";
import { MUTATING, READ_ONLY, registerJsonTool, type ClientSource } from "../register-tool.ts";
import {
  contextSchema,
  interactionModeSchema,
  runtimeModeSchema,
  waitFields,
  waitTimeoutMs,
} from "../schemas.ts";

export function registerTurnTools(server: McpServer, source: ClientSource): void {
  registerJsonTool(
    server,
    "t3_send_message",
    {
      title: "Send a follow-up prompt",
      description:
        "Send another user message to an existing T3 thread with the thread's current harness and model. During an active run, T3 steers or queues the message according to the harness, as the T3 UI does. A retry with the same idempotencyKey is always safe.",
      input: {
        threadId: z.string(),
        prompt: z.string().min(1),
        context: contextSchema,
        runtimeMode: runtimeModeSchema.optional().describe("Default: the thread's current mode"),
        interactionMode: interactionModeSchema
          .optional()
          .describe("Default: the thread's current mode"),
        idempotencyKey: z
          .string()
          .optional()
          .describe("Stable key; retries with the same key do not start a second turn"),
        ...waitFields,
      },
      annotations: MUTATING,
    },
    async (input) => {
      const client = await source.getClient();
      const before = await client.thread(input.threadId);
      const ids = commandIds(input.threadId, input.idempotencyKey);
      const alreadySent = before.messages.some((m) => m.id === ids.messageId);
      // T3 resolves delivery against its serialized state and deduplicates command ids.
      if (!alreadySent) {
        await client.startTurn({
          ...ids,
          threadId: input.threadId,
          text: composeMessage(input.prompt, input.context),
          runtimeMode:
            input.runtimeMode === before.thread.runtimeMode ? undefined : input.runtimeMode,
          interactionMode:
            input.interactionMode === before.thread.interactionMode
              ? undefined
              : input.interactionMode,
        });
      }
      const base = { reused: alreadySent, idempotencyKey: ids.idempotencyKey };
      if (input.wait) {
        const { snapshot, timedOut } = await client.waitForTurn(
          input.threadId,
          waitTimeoutMs(input.timeoutSeconds),
          { expectedMessageId: ids.messageId },
        );
        return { ...base, ...turnResult(client, snapshot, timedOut) };
      }
      return {
        ...base,
        ...summarizeThread(client, (await client.thread(input.threadId)).thread),
      };
    },
  );

  registerJsonTool(
    server,
    "t3_wait_for_turn",
    {
      title: "Wait for the current turn",
      description:
        "Block until the thread's latest turn finishes (or the timeout passes) and return the assistant reply. Prefer wait=true on t3_create_thread / t3_send_message, which know exactly which turn to wait for.",
      input: {
        threadId: z.string(),
        timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Default 300"),
      },
      annotations: READ_ONLY,
    },
    async ({ threadId, timeoutSeconds }) => {
      const client = await source.getClient();
      const { snapshot, timedOut } = await client.waitForTurn(
        threadId,
        waitTimeoutMs(timeoutSeconds),
      );
      return turnResult(client, snapshot, timedOut);
    },
  );

  registerJsonTool(
    server,
    "t3_cancel_turn",
    {
      title: "Cancel the running turn",
      description:
        "Interrupt the thread's running turn. No-op with a clear message if nothing is running.",
      input: { threadId: z.string() },
      annotations: { ...MUTATING, destructiveHint: true },
    },
    async ({ threadId }) => {
      const client = await source.getClient();
      const before = await client.thread(threadId);
      const run = before.runs
        .filter((r) => isRunInterruptible(r.status))
        .toSorted((a, b) => b.ordinal - a.ordinal)[0];
      if (!run) {
        return {
          cancelled: false,
          reason: "No turn is running.",
          ...summarizeThread(client, before.thread),
        };
      }
      await client.interruptTurn(randomUUID(), threadId, run.id);
      const { snapshot, timedOut } = await client.waitForTurn(threadId, 15_000, {
        expectedRunId: run.id,
      });
      return {
        cancelled: !timedOut && ["interrupted", "cancelled"].includes(snapshot.thread.status),
        timedOut,
        ...summarizeThread(client, snapshot.thread),
      };
    },
  );
}
