import { describe, expect, test } from "bun:test";
import { buildHttpTool, type HttpToolDef } from "@/graph/tools/http";
import { MAX_OUTBOUND_BODY_CHARS } from "@/lib/outbound";

// 8.8.8.8 is a public IP literal: the SSRF guard treats it as an IP (no DNS lookup) and does not
// block it, so these tests never touch the network.
const PUBLIC = "8.8.8.8";
const enc = new TextEncoder();

function def(over: Partial<HttpToolDef> = {}): HttpToolDef {
  return {
    name: "thing",
    method: "GET",
    urlTemplate: `https://${PUBLIC}/v1/thing`,
    allowedHosts: [PUBLIC],
    headers: {},
    inputSchema: {},
    credentialRef: null,
    ...over,
  };
}

// A provider that answers its headers at once and then never finishes the body. The abort is
// relayed into the stream because that is what a real fetch does: aborting the signal errors the
// body, and a hand-made Response has to be told. Without the relay this stub would hang whatever
// the runtime does, which would prove nothing.
function stalledBody(): typeof fetch {
  return (async (_u: string, init: RequestInit) =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('{"a":'));
          init.signal?.addEventListener("abort", () =>
            c.error(new Error("The operation was aborted.")),
          );
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

describe("an HTTP tool's bound covers the body, not only the headers", () => {
  test("a body that never finishes ends the call instead of hanging the turn", async () => {
    const tool = buildHttpTool(def(), {
      resolveCredential: async () => null,
      timeoutMs: 150,
      fetchImpl: stalledBody(),
    });

    const startedAt = Date.now();
    const HUNG = Symbol("hung");
    const outcome = await Promise.race([
      tool.invoke({}).then(
        (v) => ({ kind: "returned" as const, v }),
        (e: unknown) => ({ kind: "threw" as const, e }),
      ),
      new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), 3_000)),
    ]);

    expect(outcome).not.toBe(HUNG);
    expect((outcome as { kind: string }).kind).toBe("threw");
    // And it ended NEAR the bound, not after the body finally arrived: a fix that merely waits
    // longer would satisfy the assertion above and not this one.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  }, 10_000);

  test("the refusal names the bound rather than the stream's own error", async () => {
    // What the model reads when a tool call is cut. "The operation was aborted." says nothing it
    // can act on; the bound and the fact that it was the provider that went quiet do.
    const tool = buildHttpTool(def(), {
      resolveCredential: async () => null,
      timeoutMs: 150,
      fetchImpl: stalledBody(),
    });
    const err = (await tool.invoke({}).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/did not answer within 0\.15s/);
  }, 10_000);

  test("a body that arrives inside the bound is still returned whole", async () => {
    // The fence on the other side: the bound must not turn a slow-but-fine provider into a failure.
    const tool = buildHttpTool(def(), {
      resolveCredential: async () => null,
      timeoutMs: 1_000,
      fetchImpl: (async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode('{"a":'));
              setTimeout(() => {
                c.enqueue(enc.encode("1}"));
                c.close();
              }, 200);
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    expect(String(await tool.invoke({}))).toBe('HTTP 200\n{"a":1}');
  }, 10_000);
});

describe("what the operator is told when the body itself was cut", () => {
  test("the note names the read cap, and the size the provider actually answered with", async () => {
    // Past the read cap a JSON body arrives truncated, so it stops parsing and the template reports
    // itself as "not JSON". Saying that on its own sends the operator to fix a template that was
    // never the problem — and reporting the cap as the response size understates what their
    // provider sent by however much was left on the wire.
    const filler = "x".repeat(MAX_OUTBOUND_BODY_CHARS);
    const big = `{"a":"${filler}"}`;
    const notes: Array<{
      phase: string;
      detail?: Record<string, unknown>;
      err: unknown;
    }> = [];
    const tool = buildHttpTool(
      def({ outputSchema: { mode: "template", template: "{{a}}" } }),
      {
        resolveCredential: async () => null,
        onSideEffectError: (e) => notes.push(e),
        fetchImpl: (async () =>
          new Response(big, {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      },
    );
    await tool.invoke({});
    const note = notes.find((n) => n.phase === "response_clipped");
    expect(note).toBeDefined();
    expect(note?.detail?.readCap).toBe(MAX_OUTBOUND_BODY_CHARS);
    // The WHOLE response, not the part that was kept.
    expect(note?.detail?.chars).toBe(big.length);
    expect((note?.err as Error | undefined)?.message).toContain(
      `only the first ${MAX_OUTBOUND_BODY_CHARS} characters of the body were read`,
    );
  }, 30_000);

  test("a body that fits says nothing about a cap", async () => {
    // The fence: a tool with no template and a long-but-readable response still gets the ordinary
    // advice, which is to declare one.
    const notes: Array<{ phase: string; detail?: Record<string, unknown> }> =
      [];
    const tool = buildHttpTool(def(), {
      resolveCredential: async () => null,
      onSideEffectError: (e) => notes.push(e),
      fetchImpl: (async () =>
        new Response(JSON.stringify({ a: "y".repeat(9_000) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    await tool.invoke({});
    const note = notes.find((n) => n.phase === "response_clipped");
    expect(note).toBeDefined();
    expect(note?.detail?.readCap).toBeUndefined();
  });
});

// The other half of an unbounded read, and the one the time bound does not fix: `res.text()`
// buffers the whole body before the 4000-char clip is applied to the string that comes out of it.
// Measured on `main` against a local server: 1,438 MiB of resident memory from a single call, three
// seconds in and still climbing.
//
// IN A SUBPROCESS, and measuring RSS rather than `heapUsed`. The decoded body lives in native
// memory: the same probe that showed 1.4 GiB of RSS showed the JS heap growing by 0.5 MiB, so a
// heap-based threshold would be green with the defect fully present.
test("a body far larger than memory allows is never retained whole", async () => {
  const script = `
    import { buildHttpTool } from "@/graph/tools/http";
    const MB = 1024 * 1024;
    // ONE buffer, enqueued many times: the producer allocates 1 MB and the consumer decodes each
    // chunk transiently, so the only thing that could hold 300 MB is the accumulator under test.
    const chunk = new TextEncoder().encode("z".repeat(MB));
    const TIMES = 300;
    const tool = buildHttpTool(
      { name: "t", method: "GET", urlTemplate: "https://8.8.8.8/v1/x", allowedHosts: ["8.8.8.8"], headers: {}, inputSchema: {}, credentialRef: null },
      {
        resolveCredential: async () => null,
        fetchImpl: async () => new Response(new ReadableStream({
          start(c) { for (let i = 0; i < TIMES; i++) c.enqueue(chunk); c.close(); },
        }), { status: 200 }),
      },
    );
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    const out = String(await tool.invoke({}));
    const grew = process.memoryUsage().rss - before;
    console.log(JSON.stringify({ grew, len: out.length }));
  `;
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const line = out.trim().split("\n").at(-1) as string;
  const got = JSON.parse(line) as { grew: number; len: number };
  // The model still gets its clipped view — the cap is on what is read, not on what is answered.
  expect(got.len).toBeLessThan(5_000);
  // Retaining 300 MB shows up as hundreds of MB of RSS; the cap keeps it in the low tens.
  expect(got.grew).toBeLessThan(50 * 1024 * 1024);
}, 180_000);
