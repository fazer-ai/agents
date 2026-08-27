import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  AGENT_EXPORT_KIND,
  AGENT_EXPORT_VERSION,
  EXPORTED_COMPONENT_KEYS,
} from "@/modules/agents/transfer";
import { documentStarter } from "@/modules/documents/starters";
import { createDocumentTemplate } from "@/modules/documents/templates";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  agentCreate,
  agentDelete,
  agentImport,
  agentToolsSet,
  agentUpdate,
  toolCreate,
} from "@/modules/mcp/write-agents";

// Agent-builder write tools: gate (scope + tenant target) is DB-free; dry-run/apply/audit, the
// credential-by-NAME resolution and tenant fencing need a real Postgres (skipIf).

function principal(over: Partial<VerifiedToken>): VerifiedToken {
  return {
    userId: 1n,
    tenantId: 1n,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
    ...over,
  };
}

describe("MCP agent-builder gate (no DB)", () => {
  test("agent_create without mcp:write → insufficient_scope", async () => {
    const r = await agentCreate(principal({ scopes: ["mcp:read"] }), {
      name: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("agent_update invalid agent_id → error", async () => {
    const r = await agentUpdate(principal({}), {
      agent_id: "nope",
      name: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid agent_id");
  });

  test("agent_update with no fields → error", async () => {
    const r = await agentUpdate(principal({}), { agent_id: "1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no updatable fields");
  });

  test("agent_import without mcp:write → insufficient_scope", async () => {
    const r = await agentImport(principal({ scopes: ["mcp:read"] }), {
      export: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("agent_import invalid export → error", async () => {
    const r = await agentImport(principal({}), { export: { not: "valid" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid agent export");
  });

  test("agent_import dry-run (default) previews without writing", async () => {
    const exp = {
      version: AGENT_EXPORT_VERSION,
      kind: AGENT_EXPORT_KIND,
      agent: {
        name: "Imported",
        systemPrompt: "hi",
        modelConfig: {},
        settings: {},
        transferWithSummary: false,
        businessHours: null,
        followUpHours: null,
        tools: [],
        credentials: [{ name: "OpenAI", kind: "openai" }],
      },
    };
    const r = await agentImport(principal({}), { export: exp });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(true);
      expect(r.data.agentName).toBe("Imported");
      expect(r.data.willCreate).toEqual({ enabled: false, mode: "test" });
      expect(r.data.credentialsNeeded).toEqual([
        { name: "OpenAI", kind: "openai" },
      ]);
    }
  });

  // The preview has to disclose EVERY component array the apply can create — the apply reuses or
  // creates each of them before it assigns the grants, so an omitted one is the dry run standing in
  // for a different operation than the one that will run.
  //
  // Compared against the export schema's own keys rather than a list written here: the way this
  // broke was a component array being added to the bundle and not to the preview, and a hand-written
  // list in the test would have been the same omission a second time.
  test("the preview counts every component array a bundle can carry", async () => {
    const exp = {
      version: AGENT_EXPORT_VERSION,
      kind: AGENT_EXPORT_KIND,
      agent: {
        name: "Com componentes",
        systemPrompt: "hi",
        modelConfig: {},
        settings: {},
        transferWithSummary: false,
        businessHours: null,
        followUpHours: null,
        tools: [],
        credentials: [],
      },
      components: {
        httpTools: [],
        mcpServers: [],
        integrations: [],
        knowledgeBases: [],
        documentTemplates: [
          {
            name: "Orçamento",
            slug: "orcamento_importado",
            blocks: [{ id: "t", type: "text", text: "Olá." }],
            fields: [],
          },
        ],
      },
    };
    const r = await agentImport(principal({}), { export: exp });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const components = r.data.components as Record<string, number>;
    expect(Object.keys(components).sort()).toEqual(
      [...EXPORTED_COMPONENT_KEYS].sort(),
    );
    expect(components.documentTemplates).toBe(1);
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

describe.skipIf(!dbUp)("MCP agent-builder tools (DB)", () => {
  let tenantA = 0n;
  let tenantB = 0n;
  let agentA = 0n;
  let credId = 0n;

  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "GA", slug: `g-a-${process.pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "GB", slug: `g-b-${process.pid}` },
    });
    tenantB = b.id;
    const ag = await suDb.agent.create({
      data: { tenantId: tenantA, name: "Builder", systemPrompt: "p" },
    });
    agentA = ag.id;
    const cred = await suDb.vaultEntry.create({
      data: {
        tenantId: tenantA,
        name: "my-api",
        kind: "generic",
        secret: encryptJson("sk-secret"),
      },
      select: { id: true },
    });
    credId = cred.id;
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM agent_tool_selections WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tool_definitions WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM agents WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("agent_create dry-run creates nothing; apply creates + audits", async () => {
    const p = principal({ tenantId: tenantA });
    const dry = await agentCreate(p, { name: "Dryrun Agent" }, { base: appDb });
    expect(dry.ok).toBe(true);
    if (dry.ok) expect(dry.data.dryRun).toBe(true);
    const before = await suDb.agent.count({
      where: { tenantId: tenantA, name: "Dryrun Agent" },
    });
    expect(before).toBe(0);

    const applied = await agentCreate(
      p,
      { name: "Real Agent", dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    const row = await suDb.agent.findFirst({
      where: { tenantId: tenantA, name: "Real Agent" },
    });
    expect(row).not.toBeNull();
    const audits = await suDb.auditLog.count({
      where: { tenantId: tenantA, action: "agent.create" },
    });
    expect(audits).toBe(1);
  });

  test("tool_create resolves credential NAME → vault:<id> on apply", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await toolCreate(
      p,
      {
        name: "lookup",
        url_template: "https://api.example.com/x",
        allowed_hosts: ["api.example.com"],
        method: "GET",
        credential_ref: "my-api",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    const row = await suDb.toolDefinition.findFirst({
      where: { tenantId: tenantA, name: "lookup" },
    });
    expect(row?.credentialRef).toBe(`vault:${credId}`);
  });

  test("tool_create dry-run previews the canonical shapes + warnings; apply stores them", async () => {
    const p = principal({ tenantId: tenantA });
    const shapes = {
      name: "consultar_cnpj",
      url_template: "https://api.example.com/v1/cnpj/{cnpj}?x={typo_token}",
      allowed_hosts: ["api.example.com"],
      method: "GET" as const,
      input_schema: {
        required: ["cnpj"],
        properties: { cnpj: { type: "string" } },
      },
    };
    const dry = await toolCreate(p, shapes, { base: appDb });
    expect(dry.ok).toBe(true);
    if (dry.ok) {
      const data = dry.data as {
        preview: { urlTemplate: string; inputSchema: Record<string, unknown> };
        warnings?: string[];
      };
      expect(data.preview.urlTemplate).toBe(
        "https://api.example.com/v1/cnpj/{{cnpj}}?x={typo_token}",
      );
      expect(data.preview.inputSchema).toEqual({
        cnpj: { type: "string", required: true },
      });
      expect(data.warnings?.join(" ")).toContain("JSON Schema");
      expect(data.warnings?.join(" ")).toContain("{typo_token}");
    }

    const applied = await toolCreate(
      p,
      { ...shapes, dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    const row = await suDb.toolDefinition.findFirst({
      where: { tenantId: tenantA, name: "consultar_cnpj" },
    });
    expect(row?.urlTemplate).toBe(
      "https://api.example.com/v1/cnpj/{{cnpj}}?x={typo_token}",
    );
    expect(row?.inputSchema).toEqual({
      cnpj: { type: "string", required: true },
    });
  });

  // Review finding, round 1: a dry run promises that the preview IS what an apply would store. The
  // service normalizes the declaration (2xx and out-of-range dropped, deduped, sorted), so a preview
  // echoing the raw argument would promise a shape the apply never writes, and would report a change
  // for a no-op like [200].
  test("tool_create dry-run previews the SAME expected statuses the apply stores", async () => {
    const p = principal({ tenantId: tenantA });
    const shapes = {
      name: "lookup_es",
      url_template: "https://api.example.com/v1/x",
      allowed_hosts: ["api.example.com"],
      method: "GET" as const,
      expected_statuses: [200, 404, 404, 409],
    };
    const dry = await toolCreate(p, shapes, { base: appDb });
    expect(dry.ok).toBe(true);
    const preview = dry.ok
      ? (dry.data as { preview: { expectedStatuses?: number[] } }).preview
      : null;
    expect(preview?.expectedStatuses).toEqual([404, 409]);

    const applied = await toolCreate(
      p,
      { ...shapes, dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    const row = await suDb.toolDefinition.findFirst({
      where: { tenantId: tenantA, name: "lookup_es" },
    });
    expect(row?.expectedStatuses).toEqual(preview?.expectedStatuses ?? []);
  });

  test("tool_create with unknown credential → needsCredential + console URL (no write)", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await toolCreate(
      p,
      {
        name: "nope-tool",
        url_template: "https://api.example.com/y",
        allowed_hosts: ["api.example.com"],
        credential_ref: "does-not-exist",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.needsCredential).toBe(true);
      expect(typeof r.data.createAt).toBe("string");
    }
    const row = await suDb.toolDefinition.findFirst({
      where: { tenantId: tenantA, name: "nope-tool" },
    });
    expect(row).toBeNull();
  });

  test("agent_tools_set replace (empty set) applies + audits", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await agentToolsSet(
      p,
      { agent_id: String(agentA), grants: [], dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.applied).toBe(true);
      expect((r.data.grants as unknown[]).length).toBe(0);
    }
    const audits = await suDb.auditLog.count({
      where: { tenantId: tenantA, action: "agent.tools_set" },
    });
    expect(audits).toBe(1);
  });

  // A grant's id is caller-supplied, and `BigInt` accepts more than a column does. `0x11` is 17n, so
  // a request that never named a template could be handed one; a value past 2^63-1 converts here and
  // is refused by POSTGRES when the query binds it, answering 500 on a path that advertises a
  // validation error. Both spellings, for the grant path the document tool introduced.
  test("a grant id that is not a plain in-range number is refused, not converted", async () => {
    const p = principal({ tenantId: tenantA });
    for (const bad of ["0x11", "9223372036854775808", " 7 ", "1e3"]) {
      const r = await agentToolsSet(
        p,
        {
          agent_id: String(agentA),
          grants: [{ source: "DOCUMENT", documentTemplateId: bad }],
          dry_run: false,
        },
        { base: appDb },
      );
      expect(r.ok).toBe(false);
    }
    expect(
      await suDb.agentToolSelection.count({
        where: { agentId: agentA, source: "DOCUMENT" },
      }),
    ).toBe(0);
  });

  // The step that closed the MCP loop: this surface could CREATE a document template and had no way
  // to GRANT it, so an operator authoring over MCP ended one move short of a working document tool.
  test("agent_tools_set can grant a document template", async () => {
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      { tenantId: tenantA, userId: null, role: "TENANT_ADMIN" },
      {
        name: "Orçamento MCP",
        slug: "orcamento_mcp",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
      },
      appDb,
    );
    const p = principal({ tenantId: tenantA });
    const r = await agentToolsSet(
      p,
      {
        agent_id: String(agentA),
        grants: [{ source: "DOCUMENT", documentTemplateId: tpl.id }],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    const grant = await suDb.agentToolSelection.findFirst({
      where: { agentId: agentA, source: "DOCUMENT" },
      select: { documentTemplateId: true },
    });
    expect(grant?.documentTemplateId).toBe(BigInt(tpl.id));
    await suDb.$executeRawUnsafe(
      `DELETE FROM agent_tool_selections WHERE agent_id = ${agentA}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM document_templates WHERE id = ${BigInt(tpl.id)}`,
    );
  });

  test("agent_update cross-tenant agent_id → not found, no write", async () => {
    const p = principal({ tenantId: tenantB });
    const r = await agentUpdate(
      p,
      { agent_id: String(agentA), name: "evil", dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
    const row = await suDb.agent.findUnique({ where: { id: agentA } });
    expect(row?.name).toBe("Builder");
  });

  test("agent_delete dry-run keeps the agent; apply removes it", async () => {
    const p = principal({ tenantId: tenantA });
    const victim = await suDb.agent.create({
      data: { tenantId: tenantA, name: "Victim", systemPrompt: "p" },
    });
    const dry = await agentDelete(
      p,
      { agent_id: String(victim.id) },
      { base: appDb },
    );
    expect(dry.ok).toBe(true);
    if (dry.ok) expect(dry.data.dryRun).toBe(true);
    expect(
      await suDb.agent.findUnique({ where: { id: victim.id } }),
    ).not.toBeNull();

    const applied = await agentDelete(
      p,
      { agent_id: String(victim.id), dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    expect(
      await suDb.agent.findUnique({ where: { id: victim.id } }),
    ).toBeNull();
  });
});
