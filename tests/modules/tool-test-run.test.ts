import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { buildHttpTool } from "@/graph/tools/http";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { DEFAULT_HTTP_METHOD } from "@/modules/tool-definitions/service";
import { runToolTest } from "@/modules/tool-definitions/test-run";

// The editor's one-shot run of an unsaved definition (issue #456). What is worth pinning here is
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

  test("the host allowlist is the runtime's, not a second copy", async () => {
    await expect(
      runToolTest(
        ctx,
        {
          definition: { ...base, allowedHosts: ["example.com"] },
          args: { cnpj: "1" },
        },
        noDb,
        { fetchImpl: stub({}, 200) },
      ),
    ).rejects.toThrow(/not in allowlist/);
  });

  test("a placeholder with no value refuses before anything goes out", async () => {
    const seen: Seen = {};
    await expect(
      runToolTest(ctx, { definition: base, args: {} }, noDb, {
        fetchImpl: stub(seen, 200),
      }),
    ).rejects.toThrow(/cnpj/);
    expect(seen.url).toBeUndefined();
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
    // Not a wiring assertion: `runToolTest` has no closure to pass, so a booking tool under test
    // cannot reach `appointmentBooked` at all. The fence is that HttpToolDeps here names neither.
    const src = await Bun.file(
      "src/modules/tool-definitions/test-run.ts",
    ).text();
    const wired = src
      .split("buildHttpTool(def, {")[1]
      ?.split("});")[0] as string;
    expect(wired).not.toContain("appointmentBooked");
    expect(wired).not.toContain("cancelAppointment");
    expect(wired).not.toContain("emitAck");
  });
});

// Round 1 of review, finding 2. The endpoint's whole justification is that it adds no capability
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

// Round 2 of review. Three ways this endpoint answered a different question from the one the
// operator was asking, each of them a divergence from the runtime rather than a bug of its own.
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

  test("waits no longer than a turn does", async () => {
    // A test more patient than the runtime reports a clean 200 for an endpoint that aborts on every
    // real call, which is the one number this screen exists to show. Proven at the source because
    // the alternative is a test that sits for ten seconds: what has to hold is that the file names
    // no timeout of its own.
    const src = await Bun.file(
      "src/modules/tool-definitions/test-run.ts",
    ).text();
    // The runtime's constant is what production passes; a test may hand a shorter one, and what
    // must not exist is a number of this file's own.
    expect(src).toMatch(
      /timeoutMs:\s*(?:deps\.timeoutMs\s*\?\?\s*)?DEFAULT_HTTP_TOOL_TIMEOUT_MS/,
    );
    // The second deadline, the one covering the body, reads the same constant.
    expect(src).toMatch(
      /setTimeout\([\s\S]{0,400}deps\.timeoutMs \?\? DEFAULT_HTTP_TOOL_TIMEOUT_MS/,
    );
    expect(src).not.toMatch(/timeoutMs:\s*\d/);
    expect(src).not.toMatch(/TIMEOUT_MS\s*=\s*\d/);
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

// Round 3 of review, findings 1 and 2. The wrapper that captures the raw body sat between the
// runtime and the network, and both of the ways it could be noticed are timing rather than content.
describe("runToolTest — the capture wrapper is invisible to the runtime", () => {
  test("a body that arrives after the headers is not put back under the abort timer", async () => {
    // The runtime clears its timer the instant `fetch` resolves and reads the body afterwards, so
    // the bound is on the HEADERS. Reading the body inside the wrapper moved it back under the
    // armed timer: measured at a 300ms timeout against a provider that answers at once and streams
    // its body 800ms later, the runtime returned the body and this aborted.
    //
    // Written with a short timeout on `buildHttpTool` rather than through `runToolTest`, because
    // the real bound is ten seconds and the property is the ORDERING, not the number.
    const provider = (async (_u: string, init: RequestInit) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"a":'));
            const t = setTimeout(() => {
              c.enqueue(new TextEncoder().encode("1}"));
              c.close();
            }, 400);
            init.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              c.error(new Error("The operation was aborted."));
            });
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    // What `test-run.ts` hands `buildHttpTool`, read out of the file so this cannot pass against a
    // wrapper the module no longer uses.
    const src = await Bun.file(
      "src/modules/tool-definitions/test-run.ts",
    ).text();
    expect(src).toContain(".clone()");
    expect(src).not.toMatch(/const body = await res\.text\(\)/);
    expect(src).not.toMatch(/return new Response\(body/);

    let captured: Promise<string> | null = null;
    const wrapper = (async (u: string, i: RequestInit) => {
      const res = await provider(u, i);
      captured = res
        .clone()
        .text()
        .catch(() => "");
      return res;
    }) as unknown as typeof fetch;

    const tool = buildHttpTool(
      {
        name: "t",
        method: "GET",
        urlTemplate: `https://${PUBLIC}/v1/x`,
        allowedHosts: [PUBLIC],
        headers: {},
        inputSchema: {},
        expectedStatuses: [],
        credentialRef: null,
        credentialKind: null,
        credentialParamName: null,
        credentialBaseUrl: null,
        ackMessage: null,
        outputSchema: undefined,
      },
      {
        resolveCredential: async () => null,
        timeoutMs: 150,
        fetchImpl: wrapper,
      },
    );
    expect(String(await tool.invoke({}))).toBe('HTTP 200\n{"a":1}');
    expect(await (captured as unknown as Promise<string>)).toBe('{"a":1}');
  });

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
      // The wrapper used to rebuild the Response from the text it had read. Bun accepts an empty
      // body on a null-body status where the spec does not, so this never threw here — but a
      // rebuilt Response is a second object to keep faithful, and there is no longer one.
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

// Round 6 of review, finding 3, and it is a correction of a decision made in round 2. That round
// made EVERY throw out of `invoke` a 400, on the reasoning that everything reachable in there is the
// caller's to fix. Half of them are not: a name that does not resolve, a body that stops
// mid-stream, a provider that does not answer inside the bound. Answering 400 for those tells the
// operator to edit a definition that is fine.
//
// The shapes below were measured, not guessed: AbortError (DOMException), DNSException with
// ENOTFOUND, EncodingError for a broken stream.
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

// Round 9 of review. `buildHttpTool` clears its abort timer the instant `fetch` resolves and reads
// the body afterwards, so a provider that answers at once and then never finishes the body leaves
// `res.text()` pending with no upper bound at all — measured under a 300ms bound, still hanging at
// 3,001ms. Mid-turn that is its own defect, and out of this change's scope: closing it makes the
// budget cover the whole exchange for every HTTP tool, which is a decision about a default rather
// than a bug fix.
//
// Here it could not be left, and round 8 is why: every way of closing the dialog is blocked while a
// request is in flight, so the operator would have a spinner and no exit, and the 504 this endpoint
// advertises would never be sent.
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
