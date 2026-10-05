import { PAIR_HINT } from "../credentials.ts";
import { summarizeError } from "./errors.ts";

export type FetchFunction = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export type HttpQuery = Record<string, string | number | undefined>;

export interface HttpClient {
  get(path: string, query?: HttpQuery): Promise<unknown>;
}

export function createHttpClient(
  origin: string,
  token: string,
  fetchImpl: FetchFunction = fetch,
): HttpClient {
  return {
    async get(path: string, query: HttpQuery = {}): Promise<unknown> {
      const url = new URL(path, origin);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            "x-t3-orchestration-protocol": "2",
          },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        const reason =
          error instanceof Error && error.name === "TimeoutError"
            ? "timed out after 30s"
            : summarizeError(error);
        throw new Error(`T3 GET ${url.pathname} failed: ${reason}`, { cause: error });
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(`T3 rejected the stored token (${response.status}). ${PAIR_HINT}`);
      }
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `T3 GET ${url.pathname} failed (${response.status}): ${summarizeError(text)}`,
        );
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`T3 GET ${url.pathname} returned invalid JSON: ${text.slice(0, 120)}`);
      }
    },
  };
}
