import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
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
