import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ToolMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { buildHttpTools, loadToolSelections } from "@/graph/tools/assemble";
import { buildHttpTool, type HttpToolDef } from "@/graph/tools/http";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { exportAgent, importAgent } from "@/modules/agents/transfer";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { toolCreate, toolUpdate } from "@/modules/mcp/write-agents";
import { renderResponseTemplate } from "@/modules/tool-definitions/response-template";
import {
  createToolDefinition,
  getToolDefinition,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";
import { runToolTest } from "@/modules/tool-definitions/test-run";

// An HTTP tool's own ceiling on what the model receives. The shape that needs it: a
// catalog tool whose one job is a long description, 12,000 characters, with a field after it.

const DESCRIPTION = `${"d".repeat(11_987)}FIM-DESCRICAO`;
const EVENT_BODY = JSON.stringify({
  titulo: "T",
  descricao: DESCRIPTION,
  preco: "R$ 10",
});
const TEMPLATE = "Descrição: {{descricao}}\nPreço: {{preco}}";

function fetchReturning(body: string, status = 200): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function def(over: Partial<HttpToolDef> = {}): HttpToolDef {
  return {
    name: "evento",
    method: "GET",
    urlTemplate: "https://8.8.8.8/evento",
    allowedHosts: ["8.8.8.8"],
    headers: {},
    inputSchema: {},
    expectedStatuses: [],
    credentialRef: null,
    credentialKind: null,
    credentialParamName: null,
    credentialBaseUrl: null,
    ackMessage: null,
    ...over,
  };
}

async function modelText(
  d: HttpToolDef,
  body: string,
  notes: { phase: string; detail?: Record<string, unknown> }[] = [],
): Promise<string> {
  const tool = buildHttpTool(d, {
    resolveCredential: async () => null,
    fetchImpl: fetchReturning(body),
    onSideEffectError: (e) => notes.push({ phase: e.phase, detail: e.detail }),
  });
  const out = (await tool.invoke({})) as unknown as ToolMessage;
  return String(out.content ?? out);
}

describe("a response template under the tool's limit", () => {
  test("at the default a long value is still cut at 2000, and the field after it survives", () => {
    const got = renderResponseTemplate(
      { template: TEMPLATE },
      JSON.parse(EVENT_BODY),
    );
    expect(got.text).not.toContain("FIM-DESCRICAO");
    expect(got.text).toContain(`${"d".repeat(2000)}…[truncated]`);
    expect(got.text).not.toContain("d".repeat(2001));
    expect(got.text).toContain("Preço: R$ 10");
  });

  test("a value longer than the limit is cut where it is, and the rest of the template keeps 2000", () => {
    const got = renderResponseTemplate(
      { template: TEMPLATE },
      { descricao: "x".repeat(30_000), preco: "R$ 10" },
      { maxChars: 20_000 },
    );
    expect(got.text).toContain(`${"x".repeat(18_000)}…[truncated]`);
    expect(got.text).not.toContain("x".repeat(18_001));
    expect(got.text).toContain("Preço: R$ 10");
  });
});

describe("what an HTTP tool hands the model", () => {
  test("with no limit declared, the raw body is cut at 4000 and the note says 4000", async () => {
    const notes: { phase: string; detail?: Record<string, unknown> }[] = [];
    const text = await modelText(def(), EVENT_BODY, notes);
    expect(text.length).toBe(
      "HTTP 200\n".length + 4000 + "…[truncated]".length,
    );
    expect(text).not.toContain("FIM-DESCRICAO");
    expect(
      notes.find((n) => n.phase === "response_clipped")?.detail,
    ).toMatchObject({ limit: 4000 });
  });

  test("the raw body is cut at the tool's own limit", async () => {
    const notes: { phase: string; detail?: Record<string, unknown> }[] = [];
    const cut = await modelText(
      def({ maxResponseChars: 5000 }),
      EVENT_BODY,
      notes,
    );
    expect(cut.length).toBe("HTTP 200\n".length + 5000 + "…[truncated]".length);
    expect(
      notes.find((n) => n.phase === "response_clipped")?.detail,
    ).toMatchObject({ limit: 5000 });
    const whole = await modelText(
      def({ maxResponseChars: 20_000 }),
      EVENT_BODY,
    );
    expect(whole).toBe(`HTTP 200\n${EVENT_BODY}`);
  });

  test("through a template, the tool's limit reaches the per-value cut too", async () => {
    const withTemplate = (n: number | null) =>
      def({
        maxResponseChars: n,
        outputSchema: { mode: "template", template: TEMPLATE },
      });
    const raised = await modelText(withTemplate(20_000), EVENT_BODY);
    expect(raised).toBe(`HTTP 200\nDescrição: ${DESCRIPTION}\nPreço: R$ 10`);
    const asBefore = await modelText(withTemplate(null), EVENT_BODY);
    expect(asBefore).not.toContain("FIM-DESCRICAO");
    expect(asBefore).toContain("…[truncated]\nPreço: R$ 10");
  });

  test("a stored value outside the band is clamped, and the tool still runs", async () => {
    const big = "y".repeat(30_000);
    const notes: { phase: string; detail?: Record<string, unknown> }[] = [];
    const high = await modelText(def({ maxResponseChars: 50_000 }), big, notes);
    expect(high.length).toBe(
      "HTTP 200\n".length + 20_000 + "…[truncated]".length,
    );
    const low = await modelText(def({ maxResponseChars: 100 }), big, notes);
    expect(low.length).toBe("HTTP 200\n".length + 500 + "…[truncated]".length);
    expect(
      notes
        .filter((n) => n.phase === "response_clipped")
        .map((n) => n.detail?.limit),
    ).toEqual([20_000, 500]);
  });
});

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const tenants: bigint[] = [];
let tenantId = 0n;
let otherTenant = 0n;

const ctxFor = (id: bigint): TenantContext => ({
  tenantId: id,
  userId: null,
  role: "TENANT_ADMIN",
});
const ctx = () => ctxFor(tenantId);

function principal(): VerifiedToken {
  return {
    userId: 1n,
    tenantId,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
  };
}

function toolInput(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    label: name,
    method: "GET" as const,
    urlTemplate: "https://8.8.8.8/evento",
    allowedHosts: ["8.8.8.8"],
    ...extra,
  };
}

async function refusal(p: Promise<unknown>) {
  return p.then(
    () => null,
    (e: { statusCode?: number; field?: string; message?: string }) => e,
  );
}

describe("the turn's builder", () => {
  test("hands each loaded row's limit to its tool", async () => {
    const real = globalThis.fetch;
    // NOTE: the builder takes no fetch of its own, and the tool binds the global one when it is built.
    globalThis.fetch = fetchReturning(EVENT_BODY);
    try {
      const [tool] = buildHttpTools(
        [
          {
            name: "evento",
            description: null,
            method: "GET",
            urlTemplate: "https://8.8.8.8/evento",
            allowedHosts: ["8.8.8.8"],
            headers: {},
            inputSchema: {},
            expectedStatuses: [],
            maxResponseChars: 20_000,
            silenceTruncationAlert: false,
            appointment: null,
            conversationRefIntegrationId: null,
            outputSchema: { mode: "template", template: TEMPLATE },
            credentialRef: null,
            credentialKind: null,
            credentialParamName: null,
            credentialBaseUrl: null,
            ackEnabled: false,
            ackMessage: null,
            query: {},
            body: {},
          },
        ],
        { resolveCredential: async () => null },
      );
      const out = (await tool?.invoke({})) as unknown as ToolMessage;
      expect(String(out.content ?? out)).toBe(
        `HTTP 200\nDescrição: ${DESCRIPTION}\nPreço: R$ 10`,
      );
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe.skipIf(!dbUp)("the limit, stored and read back", () => {
  beforeAll(async () => {
    for (const slug of ["mrc", "mrc-dst"]) {
      const t = await suDb.tenant.create({
        data: { name: slug, slug: `${slug}-${process.pid}` },
      });
      tenants.push(t.id);
    }
    [tenantId, otherTenant] = tenants as [bigint, bigint];
  });

  afterAll(async () => {
    for (const id of tenants) await suDb.tenant.delete({ where: { id } });
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("created without it, a tool stores NULL and reads back null", async () => {
    const t = await createToolDefinition(ctx(), toolInput("sem_teto"), appDb);
    expect(t.maxResponseChars).toBeNull();
    const row = await suDb.toolDefinition.findUnique({
      where: { id: BigInt(t.id) },
    });
    expect(row?.maxResponseChars).toBeNull();
  });

  test("the band's ends are stored, and a patch without the field keeps it", async () => {
    const lo = await createToolDefinition(
      ctx(),
      toolInput("teto_min", { maxResponseChars: 500 }),
      appDb,
    );
    expect(lo.maxResponseChars).toBe(500);
    const hi = await createToolDefinition(
      ctx(),
      toolInput("teto_max", { maxResponseChars: 20_000 }),
      appDb,
    );
    expect(hi.maxResponseChars).toBe(20_000);
    const relabeled = await updateToolDefinition(
      ctx(),
      BigInt(hi.id),
      { label: "renamed" },
      appDb,
    );
    expect(relabeled.maxResponseChars).toBe(20_000);
    const cleared = await updateToolDefinition(
      ctx(),
      BigInt(hi.id),
      { maxResponseChars: null },
      appDb,
    );
    expect(cleared.maxResponseChars).toBeNull();
    expect(
      (await getToolDefinition(ctx(), BigInt(hi.id), appDb)).maxResponseChars,
    ).toBeNull();
  });

  test("outside the band, create and update are refused by name and nothing is written", async () => {
    for (const bad of [499, 20_001, 0, -1, 1500.5]) {
      const err = await refusal(
        createToolDefinition(
          ctx(),
          toolInput(`teto_bad_${String(bad).replace(/\W/g, "_")}`, {
            maxResponseChars: bad,
          }),
          appDb,
        ),
      );
      expect([bad, err?.statusCode, err?.field]).toEqual([
        bad,
        400,
        "maxResponseChars",
      ]);
    }
    expect(
      await suDb.toolDefinition.count({
        where: { tenantId, name: { startsWith: "teto_bad_" } },
      }),
    ).toBe(0);
    const kept = await createToolDefinition(
      ctx(),
      toolInput("teto_kept", { maxResponseChars: 8000 }),
      appDb,
    );
    const err = await refusal(
      updateToolDefinition(
        ctx(),
        BigInt(kept.id),
        { maxResponseChars: 20_001 },
        appDb,
      ),
    );
    expect(err?.statusCode).toBe(400);
    const row = await suDb.toolDefinition.findUnique({
      where: { id: BigInt(kept.id) },
    });
    expect(row?.maxResponseChars).toBe(8000);
  });

  test("MCP: the dry run refuses an out-of-band value under the caller's own argument name", async () => {
    const dry = await toolCreate(
      principal(),
      {
        name: "mcp_teto_bad",
        url_template: "https://8.8.8.8/evento",
        allowed_hosts: ["8.8.8.8"],
        max_response_chars: 20_001,
      },
      { base: appDb },
    );
    expect(dry.ok).toBe(false);
    if (!dry.ok) expect(dry.error).toContain("max_response_chars");
  });

  test("MCP: tool_create stores it, and tool_update with null clears it", async () => {
    const created = await toolCreate(
      principal(),
      {
        name: "mcp_teto",
        url_template: "https://8.8.8.8/evento",
        allowed_hosts: ["8.8.8.8"],
        max_response_chars: 12_000,
        dry_run: false,
      },
      { base: appDb },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const tool = created.data.tool as { id: string; maxResponseChars: number };
    expect(tool.maxResponseChars).toBe(12_000);
    const preview = await toolUpdate(
      principal(),
      { tool_id: tool.id, max_response_chars: null },
      { base: appDb },
    );
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.data.diff).toMatchObject({
        maxResponseChars: { before: 12_000, after: null },
      });
    }
    const cleared = await toolUpdate(
      principal(),
      { tool_id: tool.id, max_response_chars: null, dry_run: false },
      { base: appDb },
    );
    expect(cleared.ok).toBe(true);
    const row = await suDb.toolDefinition.findUnique({
      where: { id: BigInt(tool.id) },
    });
    expect(row?.maxResponseChars).toBeNull();
  });

  test("the editor's test run clips by the definition's limit, and refuses one outside the band", async () => {
    const run = (maxResponseChars?: number | null) =>
      runToolTest(
        ctx(),
        {
          definition: {
            method: "GET",
            urlTemplate: "https://8.8.8.8/evento",
            allowedHosts: ["8.8.8.8"],
            outputSchema: { mode: "template", template: TEMPLATE },
            ...(maxResponseChars !== undefined ? { maxResponseChars } : {}),
          },
        },
        appDb,
        { fetchImpl: fetchReturning(EVENT_BODY) },
      );
    const raised = await run(20_000);
    expect(raised.modelText).toBe(
      `HTTP 200\nDescrição: ${DESCRIPTION}\nPreço: R$ 10`,
    );
    const asBefore = await run();
    expect(asBefore.modelText).not.toContain("FIM-DESCRICAO");
    const err = await refusal(run(50_000));
    expect([err?.statusCode, err?.field]).toEqual([400, "maxResponseChars"]);
  });

  test("the turn's loader hands the stored limit to the tool", async () => {
    const t = await createToolDefinition(
      ctx(),
      toolInput("teto_turno", { maxResponseChars: 12_000 }),
      appDb,
    );
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "mrc",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        agentId: agent.id,
        tenantId,
        source: "HTTP",
        toolDefinitionId: BigInt(t.id),
        knowledgeBaseIds: [],
        enabledTools: [],
      },
    });
    const sel = await runScopedOn(appDb, ctx(), (db) =>
      loadToolSelections(db, agent.id),
    );
    expect(
      sel.httpToolDefs.find((d) => d.name === "teto_turno")?.maxResponseChars,
    ).toBe(12_000);
  });

  test("export carries the limit, and import keeps it, or clamps one a bundle carries out of band", async () => {
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "mrc-transfer",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    const names = ["tr_teto", "tr_sem", "tr_alto", "tr_baixo"];
    const values = [12_000, null, 8000, 8000];
    for (const [i, name] of names.entries()) {
      const t = await createToolDefinition(
        ctx(),
        toolInput(name, { maxResponseChars: values[i] }),
        appDb,
      );
      await suDb.agentToolSelection.create({
        data: {
          agentId: agent.id,
          tenantId,
          source: "HTTP",
          toolDefinitionId: BigInt(t.id),
          knowledgeBaseIds: [],
          enabledTools: [],
        },
      });
    }
    const payload = await exportAgent(ctx(), agent.id, appDb, {
      includeComponents: true,
    });
    const httpTools = (
      payload as unknown as {
        components: {
          httpTools: { name: string; maxResponseChars?: number | null }[];
        };
      }
    ).components.httpTools;
    const byName = new Map(httpTools.map((h) => [h.name, h]));
    expect(byName.get("tr_teto")?.maxResponseChars).toBe(12_000);
    expect(byName.get("tr_sem")?.maxResponseChars ?? null).toBeNull();
    // NOTE: a hand-edited bundle, which is the only way a value outside the band reaches the import.
    (byName.get("tr_alto") as { maxResponseChars: number }).maxResponseChars =
      50_000;
    (byName.get("tr_baixo") as { maxResponseChars: number }).maxResponseChars =
      100;
    await importAgent(ctxFor(otherTenant), payload, appDb);
    const rows = await suDb.toolDefinition.findMany({
      where: { tenantId: otherTenant, name: { in: names } },
      select: { name: true, maxResponseChars: true },
    });
    expect(
      Object.fromEntries(rows.map((r) => [r.name, r.maxResponseChars])),
    ).toEqual({
      tr_teto: 12_000,
      tr_sem: null,
      tr_alto: 20_000,
      tr_baixo: 500,
    });
  });
});
