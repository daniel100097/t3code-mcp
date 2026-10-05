import type { T3Connection } from "./connection.ts";
import { dispatchResultSchema, launchResultSchema } from "./contracts/commands.ts";
import type {
  DispatchResult,
  OrchestrationCommand,
  LaunchResult,
  WorkspaceStrategy,
} from "./contracts/commands.ts";
import type {
  InteractionMode,
  RuntimeMode,
  ShellSnapshot,
  ThreadSnapshot,
} from "./contracts/orchestration.ts";
import { shellSnapshotSchema } from "./contracts/orchestration.ts";
import { serverConfigSchema } from "./contracts/providers.ts";
import type { ModelSelection, ServerConfig } from "./contracts/providers.ts";
import { vcsListRefsResultSchema } from "./contracts/vcs.ts";
import type { VcsListRefsResult } from "./contracts/vcs.ts";
import { readThreadSnapshot } from "./thread-snapshot.ts";
import { waitForTurn, type WaitForTurnOptions, type WaitForTurnResult } from "./turn-waiter.ts";

export interface CreateThreadOptions extends StartTurnOptions {
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  workspaceStrategy: WorkspaceStrategy;
}

export interface StartTurnOptions {
  commandId: string;
  threadId: string;
  messageId: string;
  text: string;
  runtimeMode?: RuntimeMode;
  interactionMode?: InteractionMode;
}

export class T3Client {
  constructor(readonly connection: T3Connection) {}

  async shell(): Promise<ShellSnapshot> {
    const shell = shellSnapshotSchema.parse(
      await this.connection.http.get("/api/orchestration/shell"),
    );
    return {
      snapshotSequence: shell.snapshotSequence,
      projects: shell.projects,
      threads: [...shell.threads, ...shell.archivedThreads],
    };
  }

  async thread(threadId: string): Promise<ThreadSnapshot> {
    return readThreadSnapshot(this.connection.http, threadId);
  }

  async config(): Promise<ServerConfig> {
    return serverConfigSchema.parse(await this.connection.rpc.call("server.getConfig", {}));
  }

  async listRefs(cwd: string): Promise<VcsListRefsResult> {
    const refs: VcsListRefsResult["refs"] = [];
    let isRepo = false;
    let cursor: number | undefined;
    for (let page = 0; page < 50; page++) {
      const result = vcsListRefsResultSchema.parse(
        await this.connection.rpc.call("vcs.listRefs", {
          cwd,
          refKind: "local",
          refresh: page === 0,
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      refs.push(...result.refs);
      isRepo = result.isRepo;
      if (result.nextCursor === null || result.nextCursor === undefined) {
        break;
      }
      cursor = result.nextCursor;
    }
    return { refs, isRepo, nextCursor: null };
  }

  private async dispatch(command: OrchestrationCommand): Promise<DispatchResult> {
    return dispatchResultSchema.parse(
      await this.connection.rpc.call("orchestration.dispatchCommand", command),
    );
  }

  async createThread(spec: CreateThreadOptions): Promise<LaunchResult> {
    return launchResultSchema.parse(
      await this.connection.rpc.call("orchestration.launchThread", {
        commandId: spec.commandId,
        threadId: spec.threadId,
        projectId: spec.projectId,
        title: spec.title,
        creationSource: "mcp",
        modelSelection: spec.modelSelection,
        runtimeMode: spec.runtimeMode,
        interactionMode: spec.interactionMode,
        workspaceStrategy: spec.workspaceStrategy,
        initialMessage: { messageId: spec.messageId, text: spec.text, attachments: [] },
      }),
    );
  }

  async startTurn(spec: StartTurnOptions): Promise<DispatchResult> {
    if (spec.runtimeMode !== undefined) {
      await this.dispatch({
        type: "thread.runtime-mode.set",
        commandId: `${spec.commandId}:runtime-mode`,
        threadId: spec.threadId,
        runtimeMode: spec.runtimeMode,
      });
    }
    if (spec.interactionMode !== undefined) {
      await this.dispatch({
        type: "thread.interaction-mode.set",
        commandId: `${spec.commandId}:interaction-mode`,
        threadId: spec.threadId,
        interactionMode: spec.interactionMode,
      });
    }
    return this.dispatch({
      type: "message.dispatch",
      commandId: spec.commandId,
      threadId: spec.threadId,
      messageId: spec.messageId,
      text: spec.text,
      attachments: [],
      createdBy: "user",
      creationSource: "mcp",
      deliveryIntent: "auto",
      dispatchMode: { type: "start_immediately" },
    });
  }

  interruptTurn(commandId: string, threadId: string, runId: string): Promise<DispatchResult> {
    return this.dispatch({
      type: "run.interrupt",
      commandId,
      threadId,
      runId,
      holdQueue: true,
    });
  }

  waitForTurn(
    threadId: string,
    timeoutMs: number,
    options: WaitForTurnOptions = {},
  ): Promise<WaitForTurnResult> {
    return waitForTurn(this.connection, threadId, timeoutMs, options);
  }
}
