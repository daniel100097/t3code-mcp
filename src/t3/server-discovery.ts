import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import * as z from "zod/v4";

import type { FetchFunction } from "./transport/http-client.ts";

const runtimeFileSchema = z.object({
  version: z.number().optional(),
  pid: z.number(),
  host: z.string().optional(),
  port: z.number().optional(),
  origin: z.string(),
  devUrl: z.string().optional(),
  startedAt: z.string().optional(),
});
const environmentSchema = z.object({
  environmentId: z.string(),
  serverVersion: z.string().optional(),
  label: z.string().optional(),
  orchestrationProtocolVersion: z.number().optional(),
});
export type RuntimeFile = z.infer<typeof runtimeFileSchema>;
export type EnvironmentInfo = z.infer<typeof environmentSchema>;

export function assertSupportedProtocol(server: EnvironmentInfo): void {
  if (server.orchestrationProtocolVersion !== 2) {
    throw new Error(
      `T3 ${server.serverVersion ?? "(unknown version)"} uses orchestration protocol ${server.orchestrationProtocolVersion ?? "1"}. This client requires protocol 2. Update T3 Code to an Orchestrator V2 build.`,
    );
  }
}

export interface DiscoveredServer extends EnvironmentInfo {
  origin: string;

  source: string;
  pid: number;
}

export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetchImpl?: FetchFunction;
  isAlive?: (pid: number) => boolean;
}

export function runtimeFileCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const homes = [env.T3CODE_HOME?.trim(), join(home, ".t3")].filter((dir): dir is string =>
    Boolean(dir),
  );
  return [...new Set(homes)].flatMap((dir) => [
    join(dir, "userdata", "server-runtime.json"),
    join(dir, "dev", "server-runtime.json"),
  ]);
}

export function parseRuntimeFile(text: string): RuntimeFile | null {
  try {
    const result = runtimeFileSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export async function probeEnvironment(
  origin: string,
  fetchImpl: FetchFunction = fetch,
): Promise<EnvironmentInfo | null> {
  try {
    const response = await fetchImpl(new URL("/.well-known/t3/environment", origin), {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return null;
    }
    const result = environmentSchema.safeParse(await response.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function discoverServer(options: DiscoveryOptions = {}): Promise<DiscoveredServer> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const isAlive = options.isAlive ?? isProcessAlive;
  const explicit = env.T3_SERVER_URL?.trim();
  if (explicit) {
    const origin = new URL(explicit).origin;
    const info = await probeEnvironment(origin, fetchImpl);
    if (!info) {
      throw new Error(`T3_SERVER_URL is set to ${origin} but no T3 server answered there.`);
    }
    return { origin, source: "(T3_SERVER_URL)", pid: -1, ...info };
  }
  const tried: string[] = [];
  for (const file of runtimeFileCandidates(env, options.home)) {
    tried.push(file);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const runtime = parseRuntimeFile(text);
    if (!runtime || !isAlive(runtime.pid)) {
      continue;
    }
    const origin = new URL(runtime.devUrl ?? runtime.origin).origin;
    const info = await probeEnvironment(origin, fetchImpl);
    if (!info) {
      continue;
    }
    return { origin, source: file, pid: runtime.pid, ...info };
  }
  throw new Error(
    `No running T3 server found. Start T3 Code, or set T3_SERVER_URL. Looked at: ${tried.join(", ")}`,
  );
}
