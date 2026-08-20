import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { TOOL_INSTRUCTIONS_MAX } from "@/modules/agents/text-caps";
import {
  type AgentExport,
  exportAgent,
  importAgent,
} from "@/modules/agents/transfer";

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

let tenantId = 0n;
let agentId = 0n;

function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

describe.skipIf(!dbUp)("agent export/import", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "XF", slug: `xf-${process.pid}` },
    });
    tenantId = t.id;
    const td = await suDb.toolDefinition.create({
      data: {
        tenantId,
        name: "lookup_order",
        label: "Lookup order",
        method: "GET",
        urlTemplate: "https://api.example.com/o/{{id}}",
        allowedHosts: ["api.example.com"],
        credentialRef: "shop-key",
      },
    });
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId, name: "FAQ" },
    });
    // The agent stores credentialRefs in the real `vault:<id>` form; export translates id → name
    // (portable) and import translates name → id in the target tenant.
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: "x" },
      select: { id: true },
    });
    const ttsKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "tts-key", secret: "x" },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Vendedora",
        systemPrompt: "Você vende bem.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: {
          // TWO credentials in one block: the voice engine's and the speech rewrite's own model.
          // The second one is the one a per-block loop misses, and then export refuses the whole
          // agent (a tenant-local vault:<id> survives into the file) while import cannot rewire it.
          tts: {
            mode: "never",
            credentialRef: `vault:${ttsKey.id}`,
            normalize: true,
            normalizeProvider: "openai",
            normalizeCredentialRef: `vault:${llmKey.id}`,
          },
          // And the block that three private copies of the credential-path list did not know: with it
          // out of the list, this same export threw 500 ("unresolved vault reference"), because the
          // id survived translation and the leak defense caught it.
          guardrails: {
            enabled: true,
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${llmKey.id}`,
          },
        },
      },
    });
    agentId = agent.id;
    await suDb.agentToolSelection.createMany({
      data: [
        {
          tenantId,
          agentId,
          source: "HTTP",
          toolDefinitionId: td.id,
          enabledTools: [],
          knowledgeBaseIds: [],
        },
        {
          tenantId,
          agentId,
          source: "RAG",
          enabledTools: ["search_knowledge"],
          knowledgeBaseIds: [kb.id],
        },
      ],
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "agent_tool_selections",
        "agents",
        "tool_definitions",
        "knowledge_bases",
        "vault_entries",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("export references by name and carries no secret value", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    expect(exp.kind).toBe("fazer-ai.agent");
    expect(exp.agent.name).toBe("Vendedora");
    // credentialRef is a NAME, not a secret
    expect(exp.agent.modelConfig.credentialRef).toBe("llm-key");
    const http = exp.agent.tools.find((g) => g.source === "HTTP");
    expect(http && "tool" in http && http.tool).toBe("lookup_order");
    const rag = exp.agent.tools.find((g) => g.source === "RAG");
    expect(rag && "knowledgeBases" in rag && rag.knowledgeBases).toEqual([
      "FAQ",
    ]);
    // No raw vault names leak as secrets; serialized form has no sk- material.
    expect(JSON.stringify(exp)).not.toMatch(/sk-[A-Za-z0-9]{16}/);
    // And no tenant-local `vault:<id>` survives translation (the export guard backstops this).
    expect(JSON.stringify(exp)).not.toContain("vault:");
    // Both credentials of the tts block, by name.
    const tts = (exp.agent.settings as Record<string, Record<string, unknown>>)
      .tts;
    expect(tts?.credentialRef).toBe("tts-key");
    expect(tts?.normalizeCredentialRef).toBe("llm-key");
    const guardrails = (
      exp.agent.settings as Record<string, Record<string, unknown>>
    ).guardrails;
    expect(guardrails?.credentialRef).toBe("llm-key");
  });

  // A hand-written export is operator input like any other, and it lands through a third write path.
  // The host list is reduced to hosts there too, or an imported bundle reintroduces exactly what the
  // editor and the update path were taught not to store.
  test("an imported host list is reduced to hosts before it is stored", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const imported = {
      ...exp,
      agent: {
        ...exp.agent,
        name: "Vendedora importada",
        settings: {
          ...exp.agent.settings,
          sendImage: {
            allowedHosts: [
              "https://usuario:senha-secreta@cdn.loja.com.br/x.png?sig=deadbeef",
            ],
          },
        },
      },
    };
    const { agent } = await importAgent(ctx(), imported, appDb);
    const row = await suDb.agent.findFirstOrThrow({
      where: { id: BigInt(agent.id) },
      select: { settings: true },
    });
    expect(
      (
        (row.settings as Record<string, unknown>).sendImage as {
          allowedHosts: string[];
        }
      ).allowedHosts,
    ).toEqual(["cdn.loja.com.br"]);
    expect(JSON.stringify(row.settings)).not.toContain("senha-secreta");
  });

  // Direct writes REFUSE over-cap operator prose so nobody loses text without being told. An import
  // is a payload authored somewhere else, and refusing the whole bundle over a long note would be a
  // worse trade than the one this path already makes everywhere else: normalize, and say what was
  // normalized. Clamping here is also what keeps the imported agent saveable afterwards.
  test("an imported note over the cap is clamped before storage, with a warning naming the field", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const imported = {
      ...exp,
      agent: {
        ...exp.agent,
        name: "Vendedora prolixa",
        settings: {
          ...exp.agent.settings,
          handoff: {
            mode: "route",
            instructions: "i".repeat(TOOL_INSTRUCTIONS_MAX + 40),
          },
        },
      },
    };
    const { agent, warnings } = await importAgent(ctx(), imported, appDb);
    const row = await suDb.agent.findFirstOrThrow({
      where: { id: BigInt(agent.id) },
      select: { settings: true },
    });
    const ho = (row.settings as Record<string, unknown>).handoff as Record<
      string,
      unknown
    >;
    expect((ho.instructions as string).length).toBe(TOOL_INSTRUCTIONS_MAX);
    expect(ho.mode).toBe("route");
    const w = warnings.find((x) => x.code === "guidanceClipped");
    expect(w?.params?.field).toBe("handoff.instructions");
    expect(w?.params?.max).toBe(TOOL_INSTRUCTIONS_MAX);
  });

  // The sharp end of clipping by UTF-16 unit: an emoji straddling the cutoff leaves an unpaired
  // surrogate, which Postgres refuses in jsonb, so the whole import would fail on a note that merely
  // had an emoji at the wrong offset.
  test("an imported note clipped mid-emoji still stores (no unpaired surrogate)", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const imported = {
      ...exp,
      agent: {
        ...exp.agent,
        name: "Vendedora emoji",
        settings: {
          ...exp.agent.settings,
          handoff: {
            mode: "route",
            instructions: `${"i".repeat(TOOL_INSTRUCTIONS_MAX - 1)}😀 e mais texto`,
          },
        },
      },
    };
    const { agent } = await importAgent(ctx(), imported, appDb);
    const row = await suDb.agent.findFirstOrThrow({
      where: { id: BigInt(agent.id) },
      select: { settings: true },
    });
    const stored = (
      (row.settings as Record<string, unknown>).handoff as Record<
        string,
        unknown
      >
    ).instructions as string;
    expect(stored.length).toBe(TOOL_INSTRUCTIONS_MAX - 1);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(stored)).toBe(false);
  });

  test("round-trip import recreates the agent DISABLED with resolved refs", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const imported = { ...exp, agent: { ...exp.agent, name: "Vendedora 2" } };
    const { agent, warnings } = await importAgent(ctx(), imported, appDb);
    expect(agent.name).toBe("Vendedora 2");
    // Imported agents always land DISABLED and in TEST mode (never live by default), regardless of the
    // source agent's state.
    expect(agent.enabled).toBe(false);
    expect(agent.mode).toBe("test");
    expect(warnings).toEqual([]);
    const grants = await suDb.agentToolSelection.findMany({
      where: { agentId: BigInt(agent.id) },
      select: { source: true, toolDefinitionId: true, knowledgeBaseIds: true },
    });
    expect(
      grants.find((g) => g.source === "HTTP")?.toolDefinitionId,
    ).not.toBeNull();
    expect(
      grants.find((g) => g.source === "RAG")?.knowledgeBaseIds.length,
    ).toBe(1);
  });

  test("missing agent credentials become pending vault entries wired to the agent", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const dst = await suDb.tenant.create({
      data: { name: "XF Dst", slug: `xf-dst-${process.pid}` },
    });
    try {
      const dstCtx: TenantContext = {
        tenantId: dst.id,
        userId: null,
        role: "TENANT_ADMIN",
      };
      const { agent, warnings } = await importAgent(dstCtx, exp, appDb);
      // A credential absent in the target tenant is no longer dropped: a reference-only PENDING entry
      // is created (name + kind) and the ref stays wired, so the operator only fills the secret. The
      // warning deep-links to the vault (where the pending secret is filled), not the editor field.
      for (const name of ["llm-key", "tts-key"]) {
        const w = warnings.find(
          (x) => x.code === "credentialPending" && x.params?.name === name,
        );
        expect(w?.target).toEqual({ kind: "vault" });
        const entry = await suDb.vaultEntry.findFirst({
          where: { tenantId: dst.id, name },
        });
        expect(entry?.status).toBe("pending");
      }
      // The model credential ref is wired to the freshly-created pending entry (not left unset).
      const row = await suDb.agent.findUnique({
        where: { id: BigInt(agent.id) },
      });
      const mc = (row?.modelConfig ?? {}) as Record<string, unknown>;
      expect(mc.credentialRef as string).toMatch(/^vault:/);
    } finally {
      for (const table of [
        "agent_tool_selections",
        "agents",
        "vault_entries",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${dst.id}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${dst.id}`);
    }
  });

  test("import warns (does not crash) on a missing reference", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const broken: AgentExport = {
      ...exp,
      agent: {
        ...exp.agent,
        name: "Broken",
        tools: [{ source: "HTTP", tool: "does_not_exist", enabledTools: [] }],
      },
    };
    const { agent, warnings } = await importAgent(ctx(), broken, appDb);
    expect(
      warnings.some(
        (w) =>
          w.code === "httpGrantNotFound" && w.params?.name === "does_not_exist",
      ),
    ).toBe(true);
    const grants = await suDb.agentToolSelection.findMany({
      where: { agentId: BigInt(agent.id) },
    });
    expect(grants).toHaveLength(0); // the unresolved grant was skipped, agent still created
  });

  test("export includes credentials metadata with name and kind", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    expect(exp.agent.credentials).toBeDefined();
    const creds = exp.agent.credentials ?? [];
    // The agent has two credential refs: llm-key (modelConfig) and tts-key (settings.tts).
    expect(creds).toHaveLength(2);
    expect(
      creds.every(
        (c) => typeof c.name === "string" && typeof c.kind === "string",
      ),
    ).toBe(true);
    const names = creds.map((c) => c.name).sort();
    expect(names).toEqual(["llm-key", "tts-key"]);
    // Default kind is "generic".
    expect(creds.every((c) => c.kind === "generic")).toBe(true);
  });

  test("import with metadata resolves by (name, kind) even when the same name exists under a different kind", async () => {
    // Create a duplicate-name entry under a different kind in the same tenant.
    await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", kind: "bearer", secret: "y" },
    });
    const exp = await exportAgent(ctx(), agentId, appDb);
    // The export carries credentials: [{name:"llm-key",kind:"generic"}, ...].
    // Import should resolve llm-key to the "generic" entry, not the "bearer" one.
    const imported = {
      ...exp,
      agent: { ...exp.agent, name: "Vendedora Kind" },
    };
    const { agent, warnings } = await importAgent(ctx(), imported, appDb);
    expect(warnings).toEqual([]);
    expect(agent.enabled).toBe(false);
    // modelConfig.credentialRef must point to the "generic" llm-key entry, not the "bearer" one.
    const row = await suDb.agent.findUnique({
      where: { id: BigInt(agent.id) },
    });
    const mc = (row?.modelConfig ?? {}) as Record<string, unknown>;
    const resolvedRef = mc.credentialRef as string;
    expect(resolvedRef).toMatch(/^vault:/);
    const resolvedId = BigInt(resolvedRef.replace("vault:", ""));
    const entry = await suDb.vaultEntry.findUnique({
      where: { id: resolvedId },
    });
    expect(entry?.kind).toBe("generic");
    // Cleanup: remove the bearer duplicate and the imported agent to keep test isolation.
    await suDb.agent.delete({ where: { id: BigInt(agent.id) } });
    await suDb.vaultEntry.deleteMany({
      where: { tenantId, name: "llm-key", kind: "bearer" },
    });
  });

  test("import REJECTS a payload without the credentials metadata", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    // The metadata is mandatory (no legacy fallback): stripping it fails schema validation.
    const { credentials: _c, ...agentWithoutCreds } = exp.agent;
    const stripped = {
      ...exp,
      agent: { ...agentWithoutCreds, name: "Vendedora SemMeta" },
    };
    await expect(importAgent(ctx(), stripped, appDb)).rejects.toThrow(
      /invalid agent export payload/,
    );
  });

  test("import REJECTS a system prompt over the cap with the specific error", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const oversized = {
      ...exp,
      agent: {
        ...exp.agent,
        name: "Vendedora PromptGigante",
        systemPrompt: "p".repeat(config.agent.promptMaxChars + 1),
      },
    };
    await expect(importAgent(ctx(), oversized, appDb)).rejects.toThrow(
      /system prompt is too long/,
    );
  });

  test("import with CONFLICTING metadata (same name under two kinds) warns and leaves the ref unset", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    // Craft an export whose metadata lists llm-key under TWO kinds: the bare-name refs in the
    // JSON cannot tell which path meant which credential, so the import must refuse to guess.
    const conflicted = {
      ...exp,
      agent: {
        ...exp.agent,
        name: "Vendedora Conflito",
        credentials: [
          ...(exp.agent.credentials ?? []),
          { name: "llm-key", kind: "bearer_token" },
        ],
      },
    };
    const { agent, warnings } = await importAgent(ctx(), conflicted, appDb);
    expect(
      warnings.some(
        (w) => w.code === "credentialAmbiguous" && w.params?.name === "llm-key",
      ),
    ).toBe(true);
    const row = await suDb.agent.findUnique({
      where: { id: BigInt(agent.id) },
    });
    const mc = (row?.modelConfig ?? {}) as Record<string, unknown>;
    expect(mc.credentialRef).toBeUndefined();
    // Cleanup.
    await suDb.agent.delete({ where: { id: BigInt(agent.id) } });
  });

  test("export REFUSES when a concrete secret leaked into the config", async () => {
    const leaky = await suDb.agent.create({
      data: {
        tenantId,
        name: "Leaky",
        systemPrompt: "x",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          apiKey: "sk-abcdef0123456789abcdef",
        },
      },
    });
    await expect(exportAgent(ctx(), leaky.id, appDb)).rejects.toThrow();
  });
});

// Phase D: export with ?components=true bundles full component defs; import creates the missing ones
// (fresh integration route token, EMPTY KB) before resolving grants, reusing same-name components.
describe.skipIf(!dbUp)("agent export/import with components", () => {
  let srcTenant = 0n;
  let dstTenant = 0n;
  let srcAgentId = 0n;

  const srcCtx = (): TenantContext => ({
    tenantId: srcTenant,
    userId: null,
    role: "TENANT_ADMIN",
  });
  const dstCtx = (): TenantContext => ({
    tenantId: dstTenant,
    userId: null,
    role: "TENANT_ADMIN",
  });

  beforeAll(async () => {
    const s = await suDb.tenant.create({
      data: { name: "CompSrc", slug: `comp-src-${process.pid}` },
    });
    srcTenant = s.id;
    const d = await suDb.tenant.create({
      data: { name: "CompDst", slug: `comp-dst-${process.pid}` },
    });
    dstTenant = d.id;

    const key = await suDb.vaultEntry.create({
      data: { tenantId: srcTenant, name: "shop-key", secret: "x" },
      select: { id: true },
    });
    const td = await suDb.toolDefinition.create({
      data: {
        tenantId: srcTenant,
        name: "lookup_order",
        label: "Buscar pedido",
        method: "GET",
        urlTemplate: "https://api.example.com/o/{{id}}",
        allowedHosts: ["api.example.com"],
        credentialRef: `vault:${key.id}`,
        // A lookup that answers 404 for "no such order" is the canonical case of issue #59, and it
        // is exactly the sort of tool an operator moves between instances.
        expectedStatuses: [404],
      },
    });
    const mcp = await suDb.mcpServerConnection.create({
      data: {
        tenantId: srcTenant,
        name: "tools-server",
        transport: "streamableHttp",
        url: "https://mcp.example.com",
      },
    });
    const integ = await suDb.integrationInstance.create({
      data: {
        tenantId: srcTenant,
        catalogType: "ASAAS",
        name: "Pagamentos",
        config: { foo: "bar" },
        inboundAuthStrategy: "STATIC_HEADER",
        inboundSecretRef: `vault:${key.id}`,
        routeTokenHash: `src-hash-${process.pid}`,
      },
    });
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId: srcTenant, name: "Catálogo", chunkSize: 500 },
    });
    const bh = await suDb.businessHours.create({
      data: {
        tenantId: srcTenant,
        name: "Comercial",
        timezone: "America/Sao_Paulo",
        windows: [],
        // Date exceptions are part of the schedule, so they have to travel with it. Nothing in the
        // type system says so: the bundle carries the schedule as raw JSON, and a forgotten field
        // here would arrive at the destination as a schedule that quietly forgot its holidays.
        exceptions: [
          { date: "2026-09-07", label: "Independência", ranges: [] },
        ],
      },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId: srcTenant,
        name: "Comp Agent",
        systemPrompt: "x",
        businessHoursId: bh.id,
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {},
      },
    });
    srcAgentId = agent.id;
    await suDb.agentToolSelection.createMany({
      data: [
        {
          tenantId: srcTenant,
          agentId: srcAgentId,
          source: "HTTP",
          toolDefinitionId: td.id,
          enabledTools: [],
          knowledgeBaseIds: [],
        },
        {
          tenantId: srcTenant,
          agentId: srcAgentId,
          source: "MCP",
          mcpServerConnectionId: mcp.id,
          enabledTools: ["do_thing"],
          knowledgeBaseIds: [],
        },
        {
          tenantId: srcTenant,
          agentId: srcAgentId,
          source: "INTEGRATION",
          integrationInstanceId: integ.id,
          enabledTools: [],
          knowledgeBaseIds: [],
        },
        {
          tenantId: srcTenant,
          agentId: srcAgentId,
          source: "RAG",
          enabledTools: ["search_knowledge"],
          knowledgeBaseIds: [kb.id],
        },
      ],
    });
  });

  afterAll(async () => {
    for (const tid of [srcTenant, dstTenant]) {
      if (!tid) continue;
      for (const table of [
        "agent_tool_selections",
        "agents",
        "tool_definitions",
        "mcp_server_connections",
        "integration_instances",
        "knowledge_bases",
        "business_hours",
        "vault_entries",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
  });

  test("export with components bundles full defs and leaks no secret/token", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    expect(exp.components).toBeDefined();
    const c = exp.components;
    expect(c?.httpTools.find((h) => h.name === "lookup_order")?.label).toBe(
      "Buscar pedido",
    );
    // credentialRef is a NAME, never a vault:<id>.
    expect(c?.httpTools[0]?.credentialRef).toBe("shop-key");
    expect(c?.mcpServers.find((m) => m.name === "tools-server")).toBeDefined();
    expect(c?.integrations.find((i) => i.name === "Pagamentos")).toBeDefined();
    expect(c?.knowledgeBases.find((k) => k.name === "Catálogo")).toBeDefined();
    // Business hours are bundled so the import can recreate them.
    expect(c?.businessHours?.some((h) => h.name === "Comercial")).toBe(true);
    expect(
      c?.businessHours?.find((h) => h.name === "Comercial")?.exceptions,
    ).toEqual([{ date: "2026-09-07", label: "Independência", ranges: [] }]);
    const json = JSON.stringify(exp);
    // No inbound secret / route token hash / vault id ever travels.
    expect(json).not.toContain("vault:");
    expect(json).not.toContain("src-hash");
    expect(json).not.toContain("inboundSecretRef");
    expect(json).not.toContain("routeTokenHash");
    // meta block present (item 2).
    expect(exp.meta?.appVersion).toBeDefined();
  });

  test("import into a fresh tenant creates the missing components (fresh token, empty KB) then grants", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const { agent, warnings } = await importAgent(dstCtx(), exp, appDb);
    // Components created on the destination tenant.
    const td = await suDb.toolDefinition.findFirst({
      where: { tenantId: dstTenant, name: "lookup_order" },
    });
    expect(td?.label).toBe("Buscar pedido");
    // Review finding, round 1: a declaration dropped in transfer makes the destination resume
    // alerting on a status the operator had already ruled a result, with nothing to point at.
    expect(td?.expectedStatuses).toEqual([404]);
    // credential absent on the destination ⇒ re-created as a PENDING entry with the ref kept wired
    // (the operator only fills the secret), not dropped.
    expect(td?.credentialRef).toMatch(/^vault:/);
    const shopKey = await suDb.vaultEntry.findFirst({
      where: { tenantId: dstTenant, name: "shop-key" },
    });
    expect(shopKey?.status).toBe("pending");
    const mcp = await suDb.mcpServerConnection.findFirst({
      where: { tenantId: dstTenant, name: "tools-server" },
    });
    expect(mcp).not.toBeNull();
    const integ = await suDb.integrationInstance.findFirst({
      where: { tenantId: dstTenant, catalogType: "ASAAS", name: "Pagamentos" },
    });
    expect(integ).not.toBeNull();
    // Fresh route token (not the source's) + inbound auth reset.
    expect(integ?.routeTokenHash).not.toBe(`src-hash-${process.pid}`);
    expect(integ?.inboundSecretRef).toBeNull();
    expect(integ?.inboundAuthStrategy).toBe("NONE");
    const kb = await suDb.knowledgeBase.findFirst({
      where: { tenantId: dstTenant, name: "Catálogo" },
    });
    expect(kb?.chunkSize).toBe(500);
    // KB created empty (no bundled documents). Creation is SILENT now — only a reuse warns — so no
    // kbCreatedEmpty warning fires; the empty base just exists.
    expect(warnings.some((w) => w.code === "kbCreatedEmpty")).toBe(false);
    const kbDocCount = await suDb.knowledgeDocument.count({
      where: { tenantId: dstTenant, knowledgeBaseId: kb?.id },
    });
    expect(kbDocCount).toBe(0);
    // Business hours were recreated on the destination and linked to the agent — also silently.
    const bh = await suDb.businessHours.findFirst({
      where: { tenantId: dstTenant, name: "Comercial" },
    });
    expect(bh).not.toBeNull();
    expect(bh?.exceptions).toEqual([
      { date: "2026-09-07", label: "Independência", ranges: [] },
    ]);
    const agentRow = await suDb.agent.findUnique({
      where: { id: BigInt(agent.id) },
      select: { businessHoursId: true },
    });
    expect(agentRow?.businessHoursId).not.toBeNull();
    expect(warnings.some((w) => w.code === "hoursCreated")).toBe(false);
    // Grants resolved to the just-created components.
    const grants = await suDb.agentToolSelection.findMany({
      where: { agentId: BigInt(agent.id) },
      select: { source: true },
    });
    expect(grants.map((g) => g.source).sort()).toEqual([
      "HTTP",
      "INTEGRATION",
      "MCP",
      "RAG",
    ]);
  });

  test("import canonicalizes legacy authoring shapes (JSON-Schema inputSchema, single-brace {var})", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    // NOTE: simulate a bundle exported from a pre-normalization instance: rename the tool so the
    // import creates it fresh, and regress its shapes to the legacy authoring forms.
    const legacy = structuredClone(exp);
    const tool = legacy.components?.httpTools.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool) throw new Error("bundle missing lookup_order");
    tool.name = "legacy_lookup";
    tool.urlTemplate = "https://shop.example.com/orders/{order_id}";
    tool.inputSchema = {
      required: ["order_id"],
      properties: { order_id: { type: "string" } },
    };
    const grant = legacy.agent.tools.find(
      (g) => g.source === "HTTP" && g.tool === "lookup_order",
    );
    if (grant?.source === "HTTP") grant.tool = "legacy_lookup";
    await importAgent(dstCtx(), legacy, appDb);
    const row = await suDb.toolDefinition.findFirst({
      where: { tenantId: dstTenant, name: "legacy_lookup" },
    });
    expect(row?.urlTemplate).toBe(
      "https://shop.example.com/orders/{{order_id}}",
    );
    expect(row?.inputSchema).toEqual({
      order_id: { type: "string", required: true },
    });
  });

  test("a bundle this build produces still carries riskTier, for an older importer (issue #137)", async () => {
    // The other direction of the same compatibility. The bundle format is versioned as a whole, so
    // an instance one release behind parses OUR bundle with a schema where `riskTier` is REQUIRED —
    // dropping the key from the export would make every bundle this build writes unimportable there.
    // The literal below stands in for that older required-field check.
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const previousReleaseShape = z.object({ riskTier: z.string() });
    for (const tool of exp.components?.httpTools ?? []) {
      expect(previousReleaseShape.safeParse(tool).success).toBe(true);
    }
  });

  test("a bundle carrying the retired riskTier still imports (issue #137)", async () => {
    // Bundles exported before the risk tier was dropped carry `riskTier` on every HTTP tool. The
    // import schema is a plain z.object, which STRIPS unknown keys — the removal is only safe as
    // long as that holds, so pin it against a bundle from an older instance.
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const dated = structuredClone(exp);
    const tool = dated.components?.httpTools.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool) throw new Error("bundle missing lookup_order");
    tool.name = "retired_tier_lookup";
    (tool as unknown as Record<string, unknown>).riskTier = "high";
    const grant = dated.agent.tools.find(
      (g) => g.source === "HTTP" && g.tool === "lookup_order",
    );
    if (grant?.source === "HTTP") grant.tool = "retired_tier_lookup";
    await importAgent(dstCtx(), dated, appDb);
    const row = await suDb.toolDefinition.findFirst({
      where: { tenantId: dstTenant, name: "retired_tier_lookup" },
    });
    expect(row?.name).toBe("retired_tier_lookup");
  });

  test("re-import reuses same-name components (never overwrites) and warns", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const before = await suDb.toolDefinition.count({
      where: { tenantId: dstTenant, name: "lookup_order" },
    });
    const { warnings } = await importAgent(dstCtx(), exp, appDb);
    const after = await suDb.toolDefinition.count({
      where: { tenantId: dstTenant, name: "lookup_order" },
    });
    expect(after).toBe(before); // not duplicated
    expect(
      warnings.some(
        (w) => w.code === "httpToolReused" && w.params?.name === "lookup_order",
      ),
    ).toBe(true);
  });
});

// Phase 5: ?documents=true bundles the KB documents' SOURCE TEXT; import recreates them as UNINDEXED
// (no ingest job) for manual re-indexing; document content is exempt from the secret scan.
describe.skipIf(!dbUp)("agent export/import with KB documents", () => {
  let srcTenant = 0n;
  let dstTenant = 0n;
  let srcAgentId = 0n;

  const srcCtx = (): TenantContext => ({
    tenantId: srcTenant,
    userId: null,
    role: "TENANT_ADMIN",
  });
  const dstCtx = (): TenantContext => ({
    tenantId: dstTenant,
    userId: null,
    role: "TENANT_ADMIN",
  });

  beforeAll(async () => {
    const s = await suDb.tenant.create({
      data: { name: "DocsSrc", slug: `docs-src-${process.pid}` },
    });
    srcTenant = s.id;
    const d = await suDb.tenant.create({
      data: { name: "DocsDst", slug: `docs-dst-${process.pid}` },
    });
    dstTenant = d.id;

    const kb = await suDb.knowledgeBase.create({
      data: { tenantId: srcTenant, name: "DocsKB", chunkSize: 700 },
    });
    await suDb.knowledgeDocument.createMany({
      data: [
        {
          tenantId: srcTenant,
          knowledgeBaseId: kb.id,
          title: "Guia",
          sourceType: "text",
          content: "Conteúdo do guia.",
          status: "READY",
          chunkCount: 1,
        },
        {
          tenantId: srcTenant,
          knowledgeBaseId: kb.id,
          title: "Chaves",
          sourceType: "file",
          fileName: "keys.txt",
          mimeType: "text/plain",
          // Secret-shaped string INSIDE a document: must NOT trip the export's secret scanner
          // (document content is tenant content, deliberately exempt).
          content: "A chave de exemplo é sk-abcdef0123456789abcdefghij.",
          status: "READY",
          chunkCount: 1,
        },
      ],
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId: srcTenant,
        name: "Docs Agent",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {},
      },
    });
    srcAgentId = agent.id;
    await suDb.agentToolSelection.create({
      data: {
        tenantId: srcTenant,
        agentId: srcAgentId,
        source: "RAG",
        enabledTools: ["search_knowledge"],
        knowledgeBaseIds: [kb.id],
      },
    });
  });

  afterAll(async () => {
    for (const tid of [srcTenant, dstTenant]) {
      if (!tid) continue;
      for (const table of [
        "agent_tool_selections",
        "scheduler_jobs",
        "knowledge_chunks",
        "knowledge_documents",
        "knowledge_bases",
        "agents",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
  });

  test("export with ?documents bundles source text (last field) and exempts it from the scanner", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
      includeDocuments: true,
    });
    const kb = exp.components?.knowledgeBases.find((k) => k.name === "DocsKB");
    expect(kb?.documents).toHaveLength(2);
    expect(kb?.documents?.map((doc) => doc.title).sort()).toEqual([
      "Chaves",
      "Guia",
    ]);
    // The secret-shaped content survived (would have thrown if scanned).
    const keys = kb?.documents?.find((doc) => doc.title === "Chaves");
    expect(keys?.content).toContain("sk-abcdef0123456789abcdefghij");
    expect(keys?.fileName).toBe("keys.txt");
    // documents is appended LAST on each KB object.
    const kbKeys = Object.keys(kb ?? {});
    expect(kbKeys[kbKeys.length - 1]).toBe("documents");
  });

  test("export WITHOUT ?documents omits document text (back-compat)", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const kb = exp.components?.knowledgeBases.find((k) => k.name === "DocsKB");
    expect(kb).toBeDefined();
    expect(kb?.documents).toBeUndefined();
  });

  test("import recreates documents as UNINDEXED with NO ingest job; content preserved", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
      includeDocuments: true,
    });
    const jobsBefore = await suDb.schedulerJob.count({
      where: { tenantId: dstTenant, kind: "RAG_INGEST" },
    });
    const { warnings } = await importAgent(dstCtx(), exp, appDb);
    const kb = await suDb.knowledgeBase.findFirst({
      where: { tenantId: dstTenant, name: "DocsKB" },
      select: { id: true },
    });
    const docs = await suDb.knowledgeDocument.findMany({
      where: { knowledgeBaseId: kb?.id },
      select: { title: true, status: true, content: true, chunkCount: true },
    });
    expect(docs).toHaveLength(2);
    expect(docs.every((doc) => doc.status === "UNINDEXED")).toBe(true);
    expect(docs.every((doc) => doc.chunkCount === 0)).toBe(true);
    expect(docs.find((doc) => doc.title === "Guia")?.content).toBe(
      "Conteúdo do guia.",
    );
    // Manual re-ingest: import must NOT enqueue any RAG_INGEST job.
    const jobsAfter = await suDb.schedulerJob.count({
      where: { tenantId: dstTenant, kind: "RAG_INGEST" },
    });
    expect(jobsAfter).toBe(jobsBefore);
    // Creating the docs is SILENT now (only reuse warns); the editor's live "needs indexing" alert
    // surfaces them instead. So no kbDocsImported warning — the UNINDEXED rows above are the contract.
    expect(warnings.some((w) => w.code === "kbDocsImported")).toBe(false);
  });

  test("re-import into a tenant that already has the base skips the bundled docs (no duplication)", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
      includeDocuments: true,
    });
    const { warnings } = await importAgent(dstCtx(), exp, appDb);
    expect(
      warnings.some(
        (w) => w.code === "kbReusedDocsSkipped" && w.params?.name === "DocsKB",
      ),
    ).toBe(true);
    const kb = await suDb.knowledgeBase.findFirst({
      where: { tenantId: dstTenant, name: "DocsKB" },
      select: { id: true },
    });
    const docCount = await suDb.knowledgeDocument.count({
      where: { knowledgeBaseId: kb?.id },
    });
    expect(docCount).toBe(2);
  });
});
