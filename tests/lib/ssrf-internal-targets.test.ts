import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import config, { parseInternalTargets } from "@/config";
import { buildHttpTool, type HttpToolDef } from "@/graph/tools/http";
import { assertSafeOutboundUrl, SsrfError } from "@/lib/ssrf";

// `Bun.serve` needs the native Response, and the call goes out through Bun's own fetch: the suite's
// DOM preload replaces both globals (tests/dom-setup.ts), and the happy-dom fetch would add a CORS
// preflight and its own redirect handling to a test that is about what reaches the socket.
const BunResponse = (globalThis as unknown as { BunResponse: typeof Response })
  .BunResponse;

// Issue #615: one internal service reachable by one HTTP tool, with the guard ON everywhere else.
// The instance declares the target (`SSRF_INTERNAL_TARGETS`, host:port), the tool names the host in
// its own allowedHosts, and only a call that has both skips the range check.

const noLookup = (async () => {
  throw new Error("an internal target must not be resolved to be decided");
}) as unknown as NonNullable<
  Parameters<typeof assertSafeOutboundUrl>[1]
>["lookup"];

describe("SSRF_INTERNAL_TARGETS parsing", () => {
  test("host:port entries, trimmed, host in URL normal form", () => {
    expect(
      parseInternalTargets(" Sidecar:8080 , renderer:3400,[::1]:9000,", "X"),
    ).toEqual([
      { host: "sidecar", port: 8080 },
      { host: "renderer", port: 3400 },
      { host: "::1", port: 9000 },
    ]);
  });

  test("absent or empty is an empty list", () => {
    expect(parseInternalTargets(undefined, "X")).toEqual([]);
    expect(parseInternalTargets("", "X")).toEqual([]);
    expect(parseInternalTargets(" , ", "X")).toEqual([]);
  });

  // A list with one bad entry fails whole: keeping the good half would read as configured while the
  // other target is refused for a reason nobody sees.
  test.each([
    "sidecar",
    "sidecar:",
    "sidecar:0",
    "sidecar:65536",
    "sidecar:80,renderer",
    "http://sidecar:80",
    "user@sidecar:80",
    "sidecar:80/path",
    // WHATWG URL reads `\` as `/`, so this used to parse to host `sidecar` (review round 1).
    "sidecar\\renderer:8080",
  ])("%p fails naming the variable", (raw) => {
    expect(() => parseInternalTargets(raw, "SSRF_INTERNAL_TARGETS")).toThrow(
      /SSRF_INTERNAL_TARGETS/,
    );
  });

  // The boot, not just the parser: a bad entry stops the process by name.
  test("a malformed entry fails the config load", () => {
    const run = (value: string) =>
      Bun.spawnSync(["bun", "-e", "await import('./src/config.ts')"], {
        env: { ...process.env, SSRF_INTERNAL_TARGETS: value },
        stderr: "pipe",
      });
    const bad = run("sidecar:8080,renderer");
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr.toString()).toContain('Invalid entry "renderer"');
    expect(run("sidecar:8080").exitCode).toBe(0);
  });

  // The shipped compose files forward a closed list of variables, so one missing there is a setting
  // the operator writes in `.env` and the container never sees (review round 2).
  test.each([
    "docker-compose.prod.yml",
    "docker-compose.portainer.yml",
    "docker-compose.coolify.yml",
  ])("%s forwards it to the app", (file) => {
    const src = readFileSync(join(import.meta.dir, "../..", file), "utf8");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the compose interpolation, literally.
    expect(src).toContain("- SSRF_INTERNAL_TARGETS=${SSRF_INTERNAL_TARGETS:-}");
  });

  test("the guard is on in the suite, so nothing below leans on the instance-wide flag", () => {
    expect(config.ssrf.allowPrivateTargets).toBe(false);
  });
});

describe("assertSafeOutboundUrl with internal targets", () => {
  const targets = [{ host: "sidecar", port: 8080 }];

  test("a declared host and port passes over plaintext http, without a lookup", async () => {
    const url = await assertSafeOutboundUrl("http://sidecar:8080/sign", {
      internalTargets: targets,
      lookup: noLookup,
    });
    expect(url.host).toBe("sidecar:8080");
  });

  test("the same URL without the list keeps the full guard", async () => {
    await expect(
      assertSafeOutboundUrl("http://sidecar:8080/sign"),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  test("a declared host on another port is refused, and says which port was declared", async () => {
    const err = await assertSafeOutboundUrl("http://sidecar:9090/sign", {
      internalTargets: targets,
      lookup: noLookup,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SsrfError);
    expect(String(err.message)).toContain("only on port 8080, not 9090");
  });

  // The acceptance line the issue asks for by name: the match is on the host as written.
  test("a different host resolving to the same private address is still refused", async () => {
    const lookup = (async () => [
      { address: "10.0.0.5", family: 4 },
    ]) as unknown as typeof noLookup;
    await expect(
      assertSafeOutboundUrl("https://alias:8080/sign", {
        internalTargets: targets,
        lookup,
      }),
    ).rejects.toThrow("resolves to blocked address 10.0.0.5");
    await expect(
      assertSafeOutboundUrl("http://10.0.0.5:8080/sign", {
        internalTargets: targets,
      }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  test("the implicit port is the scheme's", async () => {
    await assertSafeOutboundUrl("http://sidecar/x", {
      internalTargets: [{ host: "sidecar", port: 80 }],
      lookup: noLookup,
    });
    await assertSafeOutboundUrl("https://sidecar/x", {
      internalTargets: [{ host: "sidecar", port: 443 }],
      lookup: noLookup,
    });
    await expect(
      assertSafeOutboundUrl("https://sidecar/x", {
        internalTargets: [{ host: "sidecar", port: 80 }],
        lookup: noLookup,
      }),
    ).rejects.toThrow("only on port 80, not 443");
  });

  test("an entry opens a service, not a scheme", async () => {
    await expect(
      assertSafeOutboundUrl("ftp://sidecar:8080/x", {
        internalTargets: targets,
        lookup: noLookup,
      }),
    ).rejects.toThrow("protocol ftp: not allowed");
  });
});

describe("the HTTP tool reaches an internal target only when it opts in", () => {
  let sidecar: ReturnType<typeof Bun.serve>;
  let other: ReturnType<typeof Bun.serve>;
  let sidecarHits = 0;
  let otherHits = 0;

  beforeAll(() => {
    other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        otherHits++;
        return new BunResponse("other-ok");
      },
    });
    sidecar = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        sidecarHits++;
        if (new URL(req.url).pathname === "/redir") {
          return new BunResponse(null, {
            status: 302,
            headers: { location: `http://127.0.0.1:${other.port}/ping` },
          });
        }
        return new BunResponse("sidecar-ok");
      },
    });
  });

  afterAll(() => {
    sidecar.stop(true);
    other.stop(true);
  });

  function run(
    over: Partial<HttpToolDef>,
    internalTargets = [{ host: "127.0.0.1", port: sidecar.port as number }],
  ) {
    const tool = buildHttpTool(
      {
        name: "sign",
        method: "GET",
        urlTemplate: `http://127.0.0.1:${sidecar.port}/ping`,
        allowedHosts: ["127.0.0.1"],
        headers: {},
        inputSchema: {},
        credentialRef: null,
        ...over,
      },
      {
        resolveCredential: async () => null,
        internalTargets,
        // The signal is happy-dom's too, and Bun's fetch refuses it. Dropped: the bound is not what
        // this file is about, and `redirect` travels untouched.
        fetchImpl: ((u: string, init?: RequestInit) =>
          Bun.fetch(u, { ...init, signal: undefined })) as typeof fetch,
      },
    );
    return tool.invoke({}).then(String, (e) => `threw: ${String(e)}`);
  }

  test("declared by the instance and named by the tool: the call arrives, over http", async () => {
    const before = sidecarHits;
    expect(await run({})).toContain("sidecar-ok");
    expect(sidecarHits - before).toBe(1);
  });

  test("a tool whose allowedHosts does not name the host gets the full guard", async () => {
    const before = sidecarHits;
    const out = await run({ allowedHosts: [] });
    expect(out).toContain("Blocked outbound URL");
    expect(sidecarHits - before).toBe(0);
  });

  test("with no instance entry the named host is refused", async () => {
    const before = sidecarHits;
    expect(await run({}, [])).toContain("Blocked outbound URL");
    expect(sidecarHits - before).toBe(0);
  });

  test("another port on the declared host is refused before anything is sent", async () => {
    const before = otherHits;
    const out = await run({
      urlTemplate: `http://127.0.0.1:${other.port}/ping`,
    });
    expect(out).toContain(`only on port ${sidecar.port}`);
    expect(otherHits - before).toBe(0);
  });

  test("a redirect out of the internal target is not followed", async () => {
    const s = sidecarHits;
    const o = otherHits;
    const out = await run({
      urlTemplate: `http://127.0.0.1:${sidecar.port}/redir`,
    });
    expect(out).not.toContain("other-ok");
    expect(sidecarHits - s).toBe(1);
    expect(otherHits - o).toBe(0);
  });
});
