import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertSupportedProtocol,
  discoverServer,
  parseRuntimeFile,
  probeEnvironment,
  runtimeFileCandidates,
} from "../../src/t3/server-discovery.ts";
import type { FetchFunction } from "../../src/t3/transport/http-client.ts";

const environment = { environmentId: "env-1", serverVersion: "0.0.43", label: "laptop" };

const fakeFetch =
  (origins: string[]): FetchFunction =>
  async (url: string | URL | Request) => {
    const parsed = new URL(url instanceof Request ? url.url : url);
    if (origins.includes(parsed.origin) && parsed.pathname === "/.well-known/t3/environment") {
      return Response.json(environment);
    }
    return new Response("nope", { status: 404 });
  };

describe("runtimeFileCandidates", () => {
  it("prefers T3CODE_HOME, then ~/.t3, and dedupes", () => {
    expect(runtimeFileCandidates({ T3CODE_HOME: "/data/t3" }, "/test-home")).toEqual([
      "/data/t3/userdata/server-runtime.json",
      "/data/t3/dev/server-runtime.json",
      "/test-home/.t3/userdata/server-runtime.json",
      "/test-home/.t3/dev/server-runtime.json",
    ]);
    expect(runtimeFileCandidates({ T3CODE_HOME: "/test-home/.t3" }, "/test-home")).toHaveLength(2);
  });
});

describe("parseRuntimeFile", () => {
  it("requires a numeric pid and a string origin", () => {
    expect(
      parseRuntimeFile('{"pid":75,"origin":"http://127.0.0.1:4096","port":4096}')?.origin,
    ).toBe("http://127.0.0.1:4096");
    expect(parseRuntimeFile('{"origin":"http://x"}')).toBeNull();
    expect(parseRuntimeFile("not json")).toBeNull();
  });
});

describe("probeEnvironment", () => {
  it("returns the environment info or null", async () => {
    expect(await probeEnvironment("http://a", fakeFetch(["http://a"]))).toEqual(environment);
    expect(await probeEnvironment("http://b", fakeFetch(["http://a"]))).toBeNull();
  });
});

describe("discoverServer", () => {
  let home = "";
  afterEach(async () => {
    if (home) {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses T3_SERVER_URL when set and fails if nothing answers there", async () => {
    const found = await discoverServer({
      env: { T3_SERVER_URL: "http://127.0.0.1:9999/some/path" },
      fetchImpl: fakeFetch(["http://127.0.0.1:9999"]),
    });
    expect(found).toMatchObject({
      origin: "http://127.0.0.1:9999",
      source: "(T3_SERVER_URL)",
      pid: -1,
      environmentId: "env-1",
    });
    await expect(
      discoverServer({ env: { T3_SERVER_URL: "http://127.0.0.1:1" }, fetchImpl: fakeFetch([]) }),
    ).rejects.toThrow(/no T3 server answered/);
  });

  it("reads the runtime file, skips dead pids, and prefers the dev url", async () => {
    home = await mkdtemp(join(tmpdir(), "t3home-"));
    const file = join(home, ".t3", "userdata", "server-runtime.json");
    await mkdir(join(home, ".t3", "userdata"), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        pid: 4242,
        origin: "http://127.0.0.1:4096",
        devUrl: "http://127.0.0.1:5173/",
      }),
    );
    const fetchImpl = fakeFetch(["http://127.0.0.1:5173"]);
    const found = await discoverServer({ env: {}, home, fetchImpl, isAlive: () => true });
    expect(found).toMatchObject({
      origin: "http://127.0.0.1:5173",
      source: file,
      pid: 4242,
      label: "laptop",
    });
    await expect(
      discoverServer({ env: {}, home, fetchImpl, isAlive: () => false }),
    ).rejects.toThrow(/No running T3 server found.*server-runtime\.json/);
  });
});

describe("protocol compatibility", () => {
  it("rejects V1 and unknown future protocols with an upgrade error", () => {
    expect(() => assertSupportedProtocol(environment)).toThrow(/requires protocol 2/);
    expect(() =>
      assertSupportedProtocol({ ...environment, orchestrationProtocolVersion: 3 }),
    ).toThrow(/protocol 3/);
    expect(() =>
      assertSupportedProtocol({ ...environment, orchestrationProtocolVersion: 2 }),
    ).not.toThrow();
  });
});
