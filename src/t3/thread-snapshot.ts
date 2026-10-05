import type { ThreadSnapshot } from "./contracts/orchestration.ts";
import { threadSnapshotSchema } from "./contracts/orchestration.ts";
import { projectThreadSnapshot } from "./thread-state.ts";
import type { HttpClient } from "./transport/http-client.ts";

export function assertThreadSnapshot(snapshot: unknown): ThreadSnapshot {
  const result = threadSnapshotSchema.safeParse(snapshot);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(
      `T3 thread snapshot has invalid fields: ${fields}. The T3 server contract may have changed; update t3code-mcp.`,
    );
  }
  return projectThreadSnapshot(result.data);
}
export async function readThreadSnapshot(
  http: HttpClient,
  threadId: string,
): Promise<ThreadSnapshot> {
  return assertThreadSnapshot(
    await http.get(`/api/orchestration/threads/${encodeURIComponent(threadId)}`),
  );
}
