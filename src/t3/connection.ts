import { resolveAccessToken } from "./credentials.ts";
import {
  assertSupportedProtocol,
  discoverServer,
  type DiscoveredServer,
} from "./server-discovery.ts";
import { createHttpClient, type HttpClient } from "./transport/http-client.ts";
import { RpcClient } from "./transport/rpc-client.ts";

export interface T3Connection {
  server: DiscoveredServer;
  tokenSource: string;
  http: HttpClient;
  rpc: Pick<RpcClient, "call" | "stream" | "close">;
}

export async function connectToT3(env: NodeJS.ProcessEnv = process.env): Promise<T3Connection> {
  const server = await discoverServer({ env });
  assertSupportedProtocol(server);
  const { token, source } = await resolveAccessToken(server.origin, env);
  return {
    server,
    tokenSource: source,
    http: createHttpClient(server.origin, token),
    rpc: new RpcClient(server.origin, token),
  };
}
