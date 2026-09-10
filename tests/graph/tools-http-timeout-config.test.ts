import { describe, expect, test } from "bun:test";

// The bound on an HTTP tool call is the operator's, not ours (issue #589). What that has to mean, and
// what these tests pin, is the WHOLE path: the variable reaches config, config reaches the exported
// constant, and the constant is what the call actually aborts on when the caller names no timeout.
// Asserting the constant alone would leave the last link untested, and that link is the one a
// literal creeping back into `deps.timeoutMs ?? …` would break.
//
// IN SUBPROCESSES, for the reason tests/config.test.ts gives: `bun test` shares one module registry
// per worker, so `@/config` is evaluated once with whatever the environment held at that moment and a
// later dynamic import returns the cached module. A child process is the only way to ask what a
// DIFFERENT environment produces — including the empty one, which is what pins the default.

const PUBLIC = "8.8.8.8";

const DEF = `{ name: "t", method: "GET", urlTemplate: "https://${PUBLIC}/v1/x", allowedHosts: ["${PUBLIC}"], headers: {}, inputSchema: {}, credentialRef: null }`;

// A provider that answers its headers at once and never finishes the body, with the abort relayed
// into the stream the way a real fetch does. Without the relay the read would hang whatever the
// runtime decides, and the test would prove nothing.
const STALLED = `async (_u, init) => new Response(new ReadableStream({
  start(c) {
    c.enqueue(new TextEncoder().encode('{"a":'));
    init.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
  },
}), { status: 200, headers: { "content-type": "application/json" } })`;

async function inEnv(
  script: string,
  overrides: Record<string, string | undefined>,
): Promise<{ out: string; err: string; code: number }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { out, err, code: await proc.exited };
}

describe("the HTTP tool bound is the operator's", () => {
  test("unset, it is 30s: the default a deployment gets without deciding anything", async () => {
    const { out } = await inEnv(
      `import { DEFAULT_HTTP_TOOL_TIMEOUT_MS } from "@/graph/tools/http";
       console.log(String(DEFAULT_HTTP_TOOL_TIMEOUT_MS));`,
      { HTTP_TOOL_TIMEOUT_MS: undefined },
    );
    expect(out.trim().split("\n").at(-1)).toBe("30000");
  }, 30_000);

  test("set, the call aborts on THAT value and says so", async () => {
    // 150ms rather than a realistic span so the test costs nothing: what is under test is which
    // number reaches the abort, and a wrong one gives a different message rather than a slower test.
    const { out } = await inEnv(
      `import { buildHttpTool } from "@/graph/tools/http";
       const tool = buildHttpTool(${DEF}, { resolveCredential: async () => null, fetchImpl: ${STALLED} });
       const err = await tool.invoke({}).catch((e) => e);
       console.log(JSON.stringify({ message: String(err && err.message) }));`,
      { HTTP_TOOL_TIMEOUT_MS: "150" },
    );
    const got = JSON.parse(out.trim().split("\n").at(-1) as string) as {
      message: string;
    };
    // Names the operator's bound, which no hard-coded fallback in the tool could produce.
    expect(got.message).toMatch(/did not answer within 0\.15s/);
  }, 30_000);

  test("a value that is not a whole number of milliseconds stops the boot, naming itself", async () => {
    // The failure mode the parser exists for: `Number("30s")` is NaN, and a NaN bound would reach
    // the call rather than the operator.
    const { err, code } = await inEnv(
      `import "@/config"; console.log("started");`,
      { HTTP_TOOL_TIMEOUT_MS: "30s" },
    );
    expect(code).not.toBe(0);
    expect(err).toContain("HTTP_TOOL_TIMEOUT_MS");
  }, 30_000);
});
