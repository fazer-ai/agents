import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { DEFAULT_HTTP_TOOL_TIMEOUT_MS } from "@/graph/tools/http";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { DEFAULT_HTTP_METHOD } from "@/modules/tool-definitions/service";
import { runToolTest } from "@/modules/tool-definitions/test-run";

// The editor's one-shot run of an unsaved definition. What is worth pinning here is
// not that a request goes out — every other HTTP-tool test proves that — but the three properties
// that make this endpoint safe to have at all: it reuses the runtime's guards rather than a second
// fetch path, it registers nothing, and it never hands the request back.

// 8.8.8.8 is a public IP literal: the SSRF guard treats it as an IP (no DNS lookup) and does not
// block it, so these tests never touch the network.
const PUBLIC = "8.8.8.8";
const ctx: TenantContext = { tenantId: 1n, userId: null, role: "TENANT_ADMIN" };
// No credentialRef in any case below, so nothing here reads the database.
const noDb = {} as PrismaClient;

interface Seen {
  url?: string;
  init?: RequestInit;
}

function stub(seen: Seen, status = 200, body = '{"ok":true}') {
  return (async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const base = {
  method: "GET",
  urlTemplate: `https://${PUBLIC}/v1/cnpj/{{cnpj}}`,
  allowedHosts: [PUBLIC],
  inputSchema: { cnpj: { type: "string", required: true } },
};

describe("runToolTest", () => {
  test("hands back the RAW response and the model's own text, separately", async () => {
    const seen: Seen = {};
    const body = JSON.stringify({
      razao_social: "MAGAZINE LUIZA S/A",
      descricao_situacao_cadastral: "ATIVA",
    });
    const r = await runToolTest(
      ctx,
      {
        definition: {
          ...base,
          outputSchema: {
            mode: "template",
            template: "{{razao_social}} — {{descricao_situacao_cadastral}}",
          },
        },
        args: { cnpj: "47960950000121" },
      },
      noDb,
      { fetchImpl: stub(seen, 200, body) },
    );
    expect(seen.url).toBe(`https://${PUBLIC}/v1/cnpj/47960950000121`);
    // The raw body is what the picker walks; the model text is what the template made of it.
    expect(r.raw).toBe(body);
    expect(r.rawChars).toBe(body.length);
    expect(r.rawClipped).toBe(false);
    expect(r.modelText).toBe("HTTP 200\nMAGAZINE LUIZA S/A — ATIVA");
    expect(r.failed).toBe(false);
    expect(r.notes).toEqual([]);
  });

  test("with no template the model text is the raw body, clipped as in production", async () => {
    const body = JSON.stringify({ pad: "x".repeat(5000) });
    const r = await runToolTest(
      ctx,
      { definition: base, args: { cnpj: "1" } },
      noDb,
      { fetchImpl: stub({}, 200, body) },
    );
    // The operator sees the whole response AND the fact that the model would not have.
    expect(r.rawChars).toBeGreaterThan(4000);
    expect(r.modelText).toContain("…[truncated]");
    expect(r.notes.map((n) => n.phase)).toEqual(["response_clipped"]);
  });

  test("an unresolved template path is reported on screen, not only in the logs", async () => {
    const r = await runToolTest(
      ctx,
      {
        definition: {
          ...base,
          outputSchema: { mode: "template", template: "Status: {{situacao}}" },
        },
        args: { cnpj: "1" },
      },
      noDb,
      { fetchImpl: stub({}, 200, '{"descricao_situacao_cadastral":"ATIVA"}') },
    );
    expect(r.modelText).toBe("HTTP 200\nStatus: (not returned)");
    expect(r.notes).toEqual([
      {
        phase: "response_template",
        message: "response template path(s) did not resolve: situacao",
        detail: { missing: ["situacao"] },
      },
    ]);
  });

  test("the request is never handed back", async () => {
    const r = await runToolTest(
      ctx,
      {
        definition: {
          ...base,
          headers: { authorization: "Bearer {{secret}}" },
        },
        args: { cnpj: "1" },
      },
      noDb,
      { fetchImpl: stub({}, 200, '{"a":1}') },
    );
    // Whatever the tool sent, the result carries the RESPONSE and nothing else: no url, no headers,
    // no body. A write-only credential stays write-only.
    expect(Object.keys(r).sort()).toEqual([
      "durationMs",
      "failed",
      "modelText",
      "notes",
      "raw",
      "rawChars",
      "rawClipped",
      "status",
    ]);
  });

  test("only the runtime's own context names are honoured", async () => {
    const seen: Seen = {};
    await runToolTest(
      ctx,
      {
        definition: {
          ...base,
          urlTemplate: `https://${PUBLIC}/v1/c/{{contact_id}}`,
          inputSchema: {},
        },
        // `made_up` is not a context variable; letting it through here would make this endpoint a
        // second way to introduce one, which the editor would then not know about.
        context: { contact_id: "42", made_up: "x" },
      },
      noDb,
      { fetchImpl: stub(seen, 200) },
    );
    expect(seen.url).toBe(`https://${PUBLIC}/v1/c/42`);
  });

  test("a status the definition declares a result is not reported as a failure", async () => {
    const r = await runToolTest(
      ctx,
      {
        definition: { ...base, expectedStatuses: [404] },
        args: { cnpj: "1" },
      },
      noDb,
      { fetchImpl: stub({}, 404, '{"message":"não encontrado"}') },
    );
    expect(r.status).toBe(404);
    expect(r.failed).toBe(false);
    const bad = await runToolTest(
      ctx,
      { definition: base, args: { cnpj: "1" } },
      noDb,
      { fetchImpl: stub({}, 500, "boom") },
    );
    expect(bad.failed).toBe(true);
  });

  test("no appointment side effect can fire, however the definition is written", async () => {
    // A definition that declares a booking, answered by a booking: the run reports what the provider
    // said and records nothing, so nothing fails to record either.
    const r = await runToolTest(
      ctx,
      {
        definition: {
          ...base,
          method: "POST",
          urlTemplate: `https://${PUBLIC}/v1/appointments`,
          inputSchema: {},
          appointment: {
            action: "book",
            idPath: "data.id",
            startPath: "data.start",
          },
        } as never,
      },
      noDb,
      {
        fetchImpl: stub(
          {},
          200,
          '{"data":{"id":"ap_1","start":"2026-09-02T14:00:00-03:00"}}',
        ),
      },
    );
    expect(r.failed).toBe(false);
    expect(r.notes).toEqual([]);
  });
});

// The endpoint's whole justification is that it adds no capability
// over saving the definition and calling it, and an unconstrained method is exactly a capability
// the write schema does not grant: `tool_create` takes an enum of five.
describe("runToolTest — the method vocabulary is the write schema's", () => {
  test.each(["PURGE", "PROPFIND", "CONNECT", "TRACE", ""])(
    "refuses %s before anything goes out",
    async (method) => {
      const seen: Seen = {};
      await expect(
        runToolTest(
          ctx,
          { definition: { ...base, method }, args: { cnpj: "1" } },
          noDb,
          { fetchImpl: stub(seen, 200) },
        ),
      ).rejects.toThrow(/GET, POST, PUT, PATCH, DELETE/);
      expect(seen.url).toBeUndefined();
    },
  );

  test("takes the five, in any case the operator wrote them", async () => {
    for (const method of ["get", "POST", "Put", "patch", "DELETE"]) {
      const seen: Seen = {};
      await runToolTest(
        ctx,
        {
          definition: {
            ...base,
            method,
            inputSchema: {},
            urlTemplate: `https://${PUBLIC}/v1/x`,
          },
        },
        noDb,
        { fetchImpl: stub(seen, 200) },
      );
      expect((seen.init as RequestInit).method).toBe(method.toUpperCase());
    }
  });
});

// Three ways this endpoint could answer a different question from the operator's, each a divergence
// from the runtime rather than a bug of its own.
describe("runToolTest — the same request the saved tool would make", () => {
  test("a definition with no method is tested as the method it would be SAVED as", async () => {
    const seen: Seen = {};
    await runToolTest(
      ctx,
      {
        // No `method`, which the write body allows: `createToolDefinition` fills it in.
        definition: {
          urlTemplate: `https://${PUBLIC}/v1/x`,
          allowedHosts: [PUBLIC],
          inputSchema: {},
        },
      },
      noDb,
      { fetchImpl: stub(seen, 200) },
    );
    // Not "POST" spelled again here: the CONSTANT the writer defaults to. Two literals is how the
    // test ran as a GET and the save stored a POST in the first place.
    expect((seen.init as RequestInit).method).toBe(DEFAULT_HTTP_METHOD);
  });

  test("waits no longer than a turn does, and keeps no clock of its own", async () => {
    // A test more patient than the runtime reports a clean 200 for an endpoint that aborts on every
    // real call. The timers armed during a run are read off `setTimeout`: one, the runtime's bound.
    const armed = async (deps: Parameters<typeof runToolTest>[3]) => {
      const delays: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return realSetTimeout(fn, ms);
      }) as typeof setTimeout;
      try {
        await runToolTest(
          ctx,
          { definition: base, args: { cnpj: "1" } },
          noDb,
          deps,
        );
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
      return delays;
    };
    expect(await armed({ fetchImpl: stub({}, 200) })).toEqual([
      DEFAULT_HTTP_TOOL_TIMEOUT_MS,
    ]);
    expect(await armed({ fetchImpl: stub({}, 200), timeoutMs: 150 })).toEqual([
      150,
    ]);
  });

  test("a required field left blank is refused as a bad request, naming the field", async () => {
    const seen: Seen = {};
    const err = await runToolTest(ctx, { definition: base, args: {} }, noDb, {
      fetchImpl: stub(seen, 200),
    }).catch((e: unknown) => e);
    // The declared schema throws out of `invoke` rather than returning a refusal, and that throw
    // carries no status: uncaught, the console reads a 500 for its own operator's blank box, with
    // the sentence that names the box swallowed on the way.
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect(String((err as AppError).message)).toMatch(/cnpj/);
    expect(seen.url).toBeUndefined();
  });

  // NOTE: this endpoint does what saving the definition and calling it does, so every shape the WRITE
  // path refuses is refused here too, or the screen previews a definition the operator cannot save.
  // The method vocabulary is above; these are the other two gates the write path runs.
  test.each([
    // A plain JSON object authored as if it were the payload. `parseBody` reads a fixed set of keys
    // and ignores the rest, so the request goes out assembled from the field names instead.
    [{ contact: { email: "{{cnpj}}" } }, /must declare a mode/],
    // The half-conversion: a mode that a mode-only check accepts, with the author's keys alongside.
    [{ mode: "raw", raw: "{}", contact: "{{cnpj}}" }, /dropped/],
    [{ mode: "kv", rows: [{ key: "", value: "x" }] }, /rows/],
  ])("a body the save refuses is refused here too, %#", async (body, why) => {
    const seen: Seen = {};
    const err = await runToolTest(
      ctx,
      {
        definition: { ...base, body: body as Record<string, unknown> },
        args: { cnpj: "1" },
      },
      noDb,
      { fetchImpl: stub(seen, 200) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect(String((err as AppError).message)).toMatch(why as RegExp);
    // And nothing went out: a body the operator cannot save must not reach the provider even once.
    expect(seen.url).toBeUndefined();
  });

  test("a declared template the save refuses is refused here too", async () => {
    const seen: Seen = {};
    const err = await runToolTest(
      ctx,
      {
        definition: {
          ...base,
          // NOTE: unmatched delimiter: the write schema refuses it, and a reader answering "no
          // template" would run and report the RAW body as the model's text, previewing a
          // definition that cannot be saved.
          outputSchema: { mode: "template", template: "{{razao_social} — ok" },
        },
        args: { cnpj: "1" },
      },
      noDb,
      { fetchImpl: stub(seen, 200) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect(String((err as AppError).message)).toMatch(/unmatched delimiter/);
    expect(seen.url).toBeUndefined();
  });

  // NOTE: the two below pin the OTHER half of the parity: the gates above refuse no more than the
  // write path does, and the authoring shapes the save canonicalizes reach the provider canonicalized.
  test("but a legacy JSON Schema in outputSchema is let through, as the save lets it", async () => {
    // The column has been writable through MCP since it existed, unvalidated and read nowhere, so a
    // row may hold a real JSON Schema. The write schema judges only `mode: "template"`; refusing
    // more HERE would make the test stricter than the save, which is the same divergence upside
    // down.
    const seen: Seen = {};
    const r = await runToolTest(
      ctx,
      {
        definition: {
          ...base,
          outputSchema: {
            type: "object",
            properties: { a: { type: "string" } },
          },
        },
        args: { cnpj: "1" },
      },
      noDb,
      { fetchImpl: stub(seen, 200) },
    );
    expect(seen.url).toBeDefined();
    expect(r.status).toBe(200);
  });

  test("the authoring shapes the save canonicalizes are canonicalized here too", async () => {
    const seen: Seen = {};
    await runToolTest(
      ctx,
      {
        definition: {
          // Single-brace, which `createToolDefinition` rewrites before storing. Left alone here the
          // test issues a URL with a literal `{cnpj}` in it while the saved tool interpolates —
          // two different requests from one screen.
          urlTemplate: `https://${PUBLIC}/v1/cnpj/{cnpj}`,
          allowedHosts: [PUBLIC],
          inputSchema: {
            type: "object",
            properties: { cnpj: { type: "string" } },
            required: ["cnpj"],
          },
        },
        args: { cnpj: "27865757000102" },
      },
      noDb,
      { fetchImpl: stub(seen, 200) },
    );
    expect(seen.url).toBe(`https://${PUBLIC}/v1/cnpj/27865757000102`);
  });

  test("a host off the allowlist is refused the same way", async () => {
    const err = await runToolTest(
      ctx,
      {
        definition: { ...base, allowedHosts: ["example.com"] },
        args: { cnpj: "1" },
      },
      noDb,
      { fetchImpl: stub({}, 200) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect(String((err as AppError).message)).toMatch(/not in allowlist/);
  });
});

// The wrapper that captures the raw body sits between the runtime and the network, and both ways it
// could be noticed are timing rather than content.
describe("runToolTest — the capture wrapper is invisible to the runtime", () => {
  test("a body that arrives after the bound ends the call, wrapper or no wrapper", async () => {
    // There is one bound, over the whole exchange (a bound on the HEADERS alone lets the runtime
    // answer `HTTP 200` where the preview aborts), so the provider's stream is cut at the bound and
    // the run answers then, not when the body would have finished.
    let aborted = false;
    const t0 = Date.now();
    const err = await runToolTest(
      ctx,
      {
        definition: {
          ...base,
          urlTemplate: `https://${PUBLIC}/v1/x`,
          inputSchema: {},
        },
      },
      noDb,
      {
        timeoutMs: 150,
        fetchImpl: (async (_u: string, init: RequestInit) =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('{"a":'));
                const t = setTimeout(() => {
                  c.enqueue(new TextEncoder().encode("1}"));
                  c.close();
                }, 1_500);
                init.signal?.addEventListener("abort", () => {
                  aborted = true;
                  clearTimeout(t);
                  c.error(new Error("The operation was aborted."));
                });
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(504);
    expect(aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_500);
  }, 10_000);

  test("and the streamed body still reaches the operator whole", async () => {
    // The other half of the clone: not delaying the fetch must not cost the raw body, which is the
    // thing the sample field is filled from.
    const r = await runToolTest(
      ctx,
      {
        definition: {
          ...base,
          urlTemplate: `https://${PUBLIC}/v1/x`,
          inputSchema: {},
        },
      },
      noDb,
      {
        fetchImpl: (async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('{"razao_social":'));
                setTimeout(() => {
                  c.enqueue(new TextEncoder().encode('"MAGAZINE LUIZA S/A"}'));
                  c.close();
                }, 30);
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch,
      },
    );
    expect(r.raw).toBe('{"razao_social":"MAGAZINE LUIZA S/A"}');
    expect(r.rawChars).toBe(37);
  });

  test.each([204, 205, 304])(
    "a bodyless %i is handed back as the response it was",
    async (status) => {
      // The wrapper does not rebuild the Response: Bun accepts an empty body on a null-body
      // status where the spec does not, so a rebuild would not throw here, but it is a second object
      // to keep faithful.
      const r = await runToolTest(
        ctx,
        {
          definition: { ...base, expectedStatuses: [status] },
          args: { cnpj: "1" },
        },
        noDb,
        {
          fetchImpl: (async () =>
            new Response(null, { status })) as unknown as typeof fetch,
        },
      );
      expect(r.status).toBe(status);
      expect(r.raw).toBe("");
      expect(r.failed).toBe(false);
    },
  );
});

// Not every throw out of `invoke` is the caller's to fix: a name that does not resolve, a body that
// stops mid-stream, a provider that does not answer inside the bound. A 400 for those tells the
// operator to edit a definition that is fine. The shapes below are the runtime's real ones:
// AbortError (DOMException), DNSException with ENOTFOUND, EncodingError for a broken stream.
describe("runToolTest — what kind of failure it was", () => {
  const pub = {
    ...base,
    urlTemplate: `https://${PUBLIC}/v1/x`,
    inputSchema: {},
  };

  async function statusOf(
    deps: Parameters<typeof runToolTest>[3],
    definition: Record<string, unknown> = pub,
  ): Promise<{ status: number; message: string }> {
    const err = await runToolTest(
      ctx,
      { definition: definition as never },
      noDb,
      deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    return {
      status: (err as AppError).statusCode,
      message: (err as AppError).message,
    };
  }

  test("a provider that does not answer inside the bound is 504, not 400", async () => {
    const got = await statusOf({
      fetchImpl: (async (_u: string, i: RequestInit) =>
        new Promise((_r, rej) => {
          i.signal?.addEventListener("abort", () =>
            rej(i.signal?.reason ?? new Error("aborted")),
          );
        })) as unknown as typeof fetch,
      // Not the runtime's ten seconds, because the property is the CLASS of the answer.
      timeoutMs: 20,
    });
    expect(got.status).toBe(504);
  });

  test("a body that stops mid-stream is 502, not 400", async () => {
    const got = await statusOf({
      fetchImpl: (async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("stream broke"));
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    expect(got.status).toBe(502);
    expect(got.message).toContain("stream broke");
  });

  test("a credential the store cannot inject is 500: it is ours, not the definition's", async () => {
    const got = await statusOf(
      {
        fetchImpl: stub({}, 200),
        resolveCredentialImpl: async () => {
          throw new Error("db down");
        },
      },
      // A ref `readVaultRefId` does not recognise, so the METADATA read short-circuits without
      // touching the store (no auto-injection, which is the runtime's own fallback) and the failure
      // under test is the injection read alone.
      { ...pub, credentialRef: "not-a-vault-ref" },
    );
    expect(got.status).toBe(500);
    expect(got.message).toContain("db down");
  });

  test("and neither is the metadata read, which happens before the call", async () => {
    // `readCredentialMeta` runs OUTSIDE the try around `invoke`, so a store that cannot answer here
    // escaped as a bare throw with no status at all — a generic 500 with the reason stripped off,
    // for the one failure in this function that really is a 500. `noDb` is a PrismaClient with no
    // methods, which is exactly what a store that cannot answer looks like from here.
    const err = await runToolTest(
      ctx,
      { definition: { ...pub, credentialRef: "vault:1" } as never },
      noDb,
      { fetchImpl: stub({}, 200) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(500);
    expect((err as AppError).message).toContain("credential could not be read");
  });

  test.each([
    ["a host off the allowlist", { ...pub, allowedHosts: ["example.com"] }],
    ["a URL the template cannot fill", base],
  ])("%s is still 400", async (_label, definition) => {
    const got = await statusOf({ fetchImpl: stub({}, 200) }, definition);
    expect(got.status).toBe(400);
  });
});

// A provider that answers at once and never finishes the body must still hit the deadline: every
// way of closing the dialog is blocked while a request is in flight, so without it the operator
// has a spinner and no exit, and the 504 this endpoint advertises is never sent.
describe("runToolTest — the deadline covers the body, not just the headers", () => {
  test("a body that never ends is a 504 rather than a hang", async () => {
    const t0 = Date.now();
    const err = await runToolTest(
      ctx,
      {
        definition: {
          ...base,
          urlTemplate: `https://${PUBLIC}/v1/x`,
          inputSchema: {},
        } as never,
      },
      noDb,
      {
        timeoutMs: 200,
        fetchImpl: (async (_u: string, init: RequestInit) =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('{"a":'));
                // Never closed. Only an abort ends this.
                init.signal?.addEventListener("abort", () =>
                  c.error(new Error("aborted")),
                );
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(504);
    // And it really aborted rather than merely giving up on the promise: the answer arrives at the
    // deadline, not at the end of the test.
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 10_000);

  test("a body that ends in time is untouched by it", async () => {
    const r = await runToolTest(
      ctx,
      {
        definition: {
          ...base,
          urlTemplate: `https://${PUBLIC}/v1/x`,
          inputSchema: {},
        } as never,
      },
      noDb,
      {
        timeoutMs: 2_000,
        fetchImpl: (async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('{"a":'));
                setTimeout(() => {
                  c.enqueue(new TextEncoder().encode("1}"));
                  c.close();
                }, 50);
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch,
      },
    );
    expect(r.raw).toBe('{"a":1}');
  }, 10_000);
});

// The wire cap applies while reading: after `.text()` it would be a second complete copy of the
// response beside the one `buildHttpTool` holds, over an endpoint whose contract is 100,000 characters.
describe("runToolTest — the raw body is bounded while it is read", () => {
  test("a response far past the cap comes back capped, and counted whole", async () => {
    // 2 MB in 64kB chunks: enough that retaining it all would be visible, small enough to run.
    const CHUNK = "y".repeat(64 * 1024);
    const CHUNKS = 32;
    const r = await runToolTest(
      ctx,
      {
        definition: {
          ...base,
          urlTemplate: `https://${PUBLIC}/v1/x`,
          inputSchema: {},
        } as never,
      },
      noDb,
      {
        fetchImpl: (async () =>
          new Response(
            new ReadableStream({
              start(c) {
                for (let i = 0; i < CHUNKS; i++) {
                  c.enqueue(new TextEncoder().encode(CHUNK));
                }
                c.close();
              },
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      },
    );
    // Capped on the way out…
    expect(r.raw.length).toBe(100_000);
    // …and the count is the WHOLE response, because "too large to bring back as a sample" is
    // decided on it.
    expect(r.rawChars).toBe(CHUNK.length * CHUNKS);
    expect(r.rawClipped).toBe(true);
  }, 30_000);

  test("a multi-byte character split across two chunks is not corrupted", async () => {
    // The decoder is streaming for exactly this: "é" is two bytes, and a chunk boundary between
    // them would otherwise yield a replacement character in the sample the pickers walk.
    const bytes = new TextEncoder().encode('{"nome":"José"}');
    const r = await runToolTest(
      ctx,
      {
        definition: {
          ...base,
          urlTemplate: `https://${PUBLIC}/v1/x`,
          inputSchema: {},
        } as never,
      },
      noDb,
      {
        fetchImpl: (async () =>
          new Response(
            new ReadableStream({
              start(c) {
                // Split inside the two bytes of "é".
                const at = bytes.indexOf(0xc3) + 1;
                c.enqueue(bytes.slice(0, at));
                c.enqueue(bytes.slice(at));
                c.close();
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch,
      },
    );
    expect(r.raw).toBe('{"nome":"José"}');
  });
});

// And the BOUND itself: a bounded and an unbounded read return the same string, so only what stays
// in memory while the body is read tells them apart. IN A SUBPROCESS, because `heapUsed` is
// process-wide and inside the suite it carries hundreds of MB of other tests' allocations, a
// threshold nobody can set; alone, the guarded read stays at a few MB.
test("a body far larger than memory allows is never retained whole", async () => {
  const script = `
      import { runToolTest } from "@/modules/tool-definitions/test-run";
      const MB = 1024 * 1024;
      // ONE buffer, enqueued many times: the producer allocates 1 MB and the consumer decodes each
      // chunk transiently, so the only thing that could hold 300 MB is the accumulator under test.
      const chunk = new TextEncoder().encode("z".repeat(MB));
      const TIMES = 300;
      Bun.gc(true);
      const before = process.memoryUsage().heapUsed;
      const r = await runToolTest(
        { tenantId: 1n, userId: null, role: "TENANT_ADMIN" },
        { definition: { method: "GET", urlTemplate: "https://8.8.8.8/v1/x", allowedHosts: ["8.8.8.8"], inputSchema: {} } },
        {},
        { fetchImpl: async () => new Response(new ReadableStream({
            start(c) { for (let i = 0; i < TIMES; i++) c.enqueue(chunk); c.close(); },
          }), { status: 200 }) },
      );
      const grew = process.memoryUsage().heapUsed - before;
      console.log(JSON.stringify({ grew, rawChars: r.rawChars, rawLen: r.raw.length }));
    `;
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const line = out.trim().split("\n").at(-1) as string;
  const got = JSON.parse(line) as {
    grew: number;
    rawChars: number;
    rawLen: number;
  };
  expect(got.rawChars).toBe(300 * 1024 * 1024);
  expect(got.rawLen).toBe(100_000);
  // NOTE: retaining the body is ~955 MB; the guard keeps it under 2 MB. The threshold sits between
  // them with an order of magnitude on either side.
  expect(got.grew).toBeLessThan(50 * 1024 * 1024);
}, 180_000);

// The cleanup cannot hang off the BODY promise alone, which does not exist when the fetch itself
// rejects (a refused connection, a TLS failure), or each failed test leaves its timer, controller
// and listener alive for the whole budget.
test("a fetch that rejects leaves no timer behind", async () => {
  const script = `
    import { runToolTest } from "@/modules/tool-definitions/test-run";
    const ctx = { tenantId: 1n, userId: null, role: "TENANT_ADMIN" };
    const def = { method: "GET", urlTemplate: "https://8.8.8.8/v1/x", allowedHosts: ["8.8.8.8"], inputSchema: {} };
    // Twenty refused connections under a bound far longer than this process will live.
    for (let i = 0; i < 20; i++) {
      await runToolTest(ctx, { definition: def }, {}, {
        timeoutMs: 600_000,
        fetchImpl: async () => { throw new Error("connection refused"); },
      }).catch(() => {});
    }
    // If the deadlines were still armed the loop would hold the process open; exiting on its own is
    // the observable. Printed so a hang is told apart from a crash.
    console.log("EXITED_CLEANLY");
  `;
  const started = Date.now();
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out).toContain("EXITED_CLEANLY");
  // Ten minutes of armed timers would have kept it alive; it comes back in seconds.
  expect(Date.now() - started).toBeLessThan(30_000);
}, 60_000);
