import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { TOOL_INSTRUCTIONS_MAX } from "@/modules/agents/text-caps";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  agentList,
  agentSettingsGet,
  agentSettingsSet,
  brandingAssetSet,
  brandingSet,
  credentialCreate,
  diffFields,
  promptSet,
  resolveSecretRef,
  tenantUpdate,
} from "@/modules/mcp/write";
import { langfuseConnect } from "@/modules/mcp/write-settings";

// MCP write tools: the security gate (scope + tenant target) is DB-free and always runs; the
// dry-run/apply/audit path and cross-tenant fencing need a real Postgres (skipIf).

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

describe("diffFields", () => {
  test("reports only changed keys, before → after", () => {
    expect(diffFields({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual({
      b: { before: 2, after: 3 },
    });
  });
  test("empty when nothing changed (deep-equal via JSON)", () => {
    expect(diffFields({ x: { y: 1 } }, { x: { y: 1 } })).toEqual({});
  });
});

describe("MCP write gate (no DB)", () => {
  test("missing mcp:write scope → error before any DB access", async () => {
    const r = await promptSet(principal({ scopes: ["mcp:read"] }), {
      agent_id: "1",
      system_prompt: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("tenant-less token → error before any DB access", async () => {
    const r = await tenantUpdate(
      principal({ tenantId: null, role: "SUPER_ADMIN" }),
      { name: "x" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no tenant target");
  });

  test("invalid agent_id → error", async () => {
    const r = await promptSet(principal({}), {
      agent_id: "not-a-number",
      system_prompt: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid agent_id");
  });

  test("system_prompt over the cap → err on the DRY-RUN path too, before any DB access", async () => {
    const r = await promptSet(principal({}), {
      agent_id: "1",
      system_prompt: "p".repeat(config.agent.promptMaxChars + 1),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("system prompt is too long");
  });

  test("credential_create requires mcp:write", async () => {
    const r = await credentialCreate(principal({ scopes: ["mcp:read"] }), {
      name: "k",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("branding_set with mcp:write but not mcp:admin → insufficient_scope", async () => {
    // mcp:write alone (the per-agent tier) is no longer enough for the fleet-level branding tool.
    const r = await brandingSet(
      principal({
        scopes: ["mcp:read", "mcp:write"],
        role: "SUPER_ADMIN",
        tenantId: null,
      }),
      { brand_color: "#2563eb" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("branding_set with mcp:admin but non-SUPER_ADMIN → forbidden (defense-in-depth)", async () => {
    // filterScopes never grants mcp:admin to a non-SUPER_ADMIN; this force-grants it to exercise the
    // in-tool role check that backstops a future broadening of the scope.
    const r = await brandingSet(
      principal({ scopes: ["mcp:admin"], role: "TENANT_ADMIN" }),
      { brand_color: "#2563eb" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("forbidden");
  });

  test("branding_set with no fields → error before any DB access", async () => {
    const r = await brandingSet(
      principal({
        scopes: ["mcp:read", "mcp:write", "mcp:admin"],
        role: "SUPER_ADMIN",
        tenantId: null,
      }),
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no updatable fields");
  });

  test("branding_asset_set with mcp:write but not mcp:admin → insufficient_scope", async () => {
    const r = await brandingAssetSet(
      principal({
        scopes: ["mcp:read", "mcp:write"],
        role: "SUPER_ADMIN",
        tenantId: null,
      }),
      {
        kind: "logo",
        variant: "dark",
        content_base64: "AAAA",
        mime: "image/png",
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("branding_asset_set with mcp:admin but non-SUPER_ADMIN → forbidden", async () => {
    const r = await brandingAssetSet(
      principal({ scopes: ["mcp:admin"], role: "TENANT_ADMIN" }),
      {
        kind: "logo",
        variant: "dark",
        content_base64: "AAAA",
        mime: "image/png",
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("forbidden");
  });

  test("branding_asset_set rejects invalid kind / variant (before any DB access)", async () => {
    const sa = principal({
      scopes: ["mcp:admin"],
      role: "SUPER_ADMIN",
      tenantId: null,
    });
    const badKind = await brandingAssetSet(sa, {
      kind: "banner",
      variant: "dark",
      content_base64: "AAAA",
      mime: "image/png",
    });
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.error).toContain("invalid kind");
    const badVariant = await brandingAssetSet(sa, {
      kind: "logo",
      variant: "huge",
      content_base64: "AAAA",
      mime: "image/png",
    });
    expect(badVariant.ok).toBe(false);
    if (!badVariant.ok) expect(badVariant.error).toContain("invalid variant");
  });

  test("branding_asset_set rejects an unsupported mime", async () => {
    const r = await brandingAssetSet(
      principal({ scopes: ["mcp:admin"], role: "SUPER_ADMIN", tenantId: null }),
      {
        kind: "logo",
        variant: "dark",
        content_base64: "AAAA",
        mime: "application/pdf",
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unsupported image type");
  });

  test("branding_asset_set rejects invalid base64 (before any DB access)", async () => {
    const r = await brandingAssetSet(
      principal({ scopes: ["mcp:admin"], role: "SUPER_ADMIN", tenantId: null }),
      {
        kind: "favicon",
        variant: "light",
        content_base64: "%%%not-base64%%%",
        mime: "image/png",
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("valid base64");
  });

  test("agent_settings_set without mcp:write → insufficient_scope", async () => {
    const r = await agentSettingsSet(principal({ scopes: ["mcp:read"] }), {
      agent_id: "1",
      debounce: { enabled: false },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("agent_settings_set with no blocks → error before any DB access", async () => {
    const r = await agentSettingsSet(principal({}), { agent_id: "1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no updatable fields");
  });

  test("agent_settings_set invalid agent_id → error", async () => {
    const r = await agentSettingsSet(principal({}), {
      agent_id: "nope",
      debounce: { enabled: false },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid agent_id");
  });

  test("agent_settings_get without mcp:read → insufficient_scope", async () => {
    const r = await agentSettingsGet(principal({ scopes: [] }), {
      agent_id: "1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("agent_list tenant-less SUPER_ADMIN → no tenant target", async () => {
    const r = await agentList(
      principal({ tenantId: null, role: "SUPER_ADMIN" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no tenant target");
  });

  test("langfuse_connect without mcp:write → insufficient_scope", async () => {
    const r = await langfuseConnect(principal({ scopes: ["mcp:read"] }), {
      public_key: "pk-lf-x",
      secret_key: "sk-lf-y",
      base_url: "https://langfuse.example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("langfuse_connect dry-run previews with the keys redacted (writes nothing)", async () => {
    const r = await langfuseConnect(
      principal({ scopes: ["mcp:read", "mcp:write"] }),
      {
        public_key: "pk-lf-secret",
        secret_key: "sk-lf-secret",
        base_url: "https://langfuse.example.com",
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(true);
      const preview = r.data.preview as Record<string, unknown>;
      expect(preview.publicKey).toBe("(redacted)");
      expect(preview.secretKey).toBe("(redacted)");
      expect(preview.baseUrl).toBe("https://langfuse.example.com");
    }
    // The raw keys must never appear anywhere in the result.
    expect(JSON.stringify(r)).not.toContain("pk-lf-secret");
    expect(JSON.stringify(r)).not.toContain("sk-lf-secret");
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

// Pull a behavior block out of a normalized settings object (asserts presence for type-narrowing
// under noUncheckedIndexedAccess).
function blk(settings: unknown, key: string): Record<string, unknown> {
  const bag = (settings ?? {}) as Record<string, unknown>;
  const v = bag[key];
  if (!v || typeof v !== "object") {
    throw new Error(`expected settings block "${key}"`);
  }
  return v as Record<string, unknown>;
}

describe.skipIf(!dbUp)("MCP write tools (DB)", () => {
  let tenantA = 0n;
  let tenantB = 0n;
  // Its own tenant for the legacy-cap case: a sibling test counts every agent_settings_set audit row
  // in tenantA, so an apply landing there would break it.
  let tenantLegacy = 0n;
  let agentA = 0n;
  // Vault entry ids for credential ref tests.
  let credGenericId = 0n;
  let _credBearerId = 0n;

  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "WA", slug: `w-a-${process.pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "WB", slug: `w-b-${process.pid}` },
    });
    tenantB = b.id;
    const l = await suDb.tenant.create({
      data: { name: "WLegacy", slug: `w-legacy-${process.pid}` },
    });
    tenantLegacy = l.id;
    const ag = await suDb.agent.create({
      data: { tenantId: tenantA, name: "Bot", systemPrompt: "old prompt" },
    });
    agentA = ag.id;
    // Two entries with the same name but different kinds: used to test ambiguity + vault:<id> path.
    const eg = await suDb.vaultEntry.create({
      data: {
        tenantId: tenantA,
        name: "shared-cred",
        kind: "generic",
        secret: "x",
      },
      select: { id: true },
    });
    credGenericId = eg.id;
    const eb = await suDb.vaultEntry.create({
      data: {
        tenantId: tenantA,
        name: "shared-cred",
        kind: "bearer",
        secret: "y",
      },
      select: { id: true },
    });
    _credBearerId = eb.id;
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB, tenantLegacy]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM agents WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("dry-run previews a diff and writes NOTHING", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await promptSet(
      p,
      { agent_id: String(agentA), system_prompt: "new prompt" },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(true);
      expect(
        (r.data.diff as Record<string, unknown>).systemPrompt,
      ).toBeDefined();
    }
    const row = await suDb.agent.findUnique({ where: { id: agentA } });
    expect(row?.systemPrompt).toBe("old prompt");
    const audits = await suDb.auditLog.count({
      where: { tenantId: tenantA, action: "mcp.prompt_set" },
    });
    expect(audits).toBe(0);
  });

  test("apply updates the agent AND appends an audit row", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await promptSet(
      p,
      {
        agent_id: String(agentA),
        system_prompt: "applied prompt",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.applied).toBe(true);
    const row = await suDb.agent.findUnique({ where: { id: agentA } });
    expect(row?.systemPrompt).toBe("applied prompt");
    const audits = await suDb.auditLog.findMany({
      where: { tenantId: tenantA, action: "mcp.prompt_set" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorType).toBe("mcp");
  });

  test("cross-tenant agent_id is invisible → 'agent not found', never a write", async () => {
    const p = principal({ tenantId: tenantB });
    const r = await promptSet(
      p,
      { agent_id: String(agentA), system_prompt: "evil", dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
    const row = await suDb.agent.findUnique({ where: { id: agentA } });
    expect(row?.systemPrompt).toBe("applied prompt");
  });

  test("credential_create dry-run creates NOTHING", async () => {
    const p = principal({ tenantId: tenantA });
    const before = await suDb.vaultEntry.count({
      where: { tenantId: tenantA },
    });
    const r = await credentialCreate(
      p,
      { name: "dry-cred", kind: "openai" },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.dryRun).toBe(true);
    const after = await suDb.vaultEntry.count({ where: { tenantId: tenantA } });
    expect(after).toBe(before);
  });

  test("credential_create apply creates a pending entry (no secret) + audits + fillAt", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await credentialCreate(
      p,
      { name: "mcp-pending", kind: "openai", dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.applied).toBe(true);
      expect(r.data.status).toBe("pending");
      expect(String(r.data.ref)).toMatch(/^vault:\d+$/);
      expect(String(r.data.fillAt)).toContain("/resources/vault?fill=");
      // Issue #151: the link has to name the tenant the entry belongs to. The console resolves the
      // tenant from localStorage, so without this a fleet-level session's link opens whatever tenant
      // the recipient's browser had selected, and the id is simply absent there.
      expect(String(r.data.fillAt)).toContain(`&switchTenant=${tenantA}`);
    }
    const row = await suDb.vaultEntry.findFirst({
      where: { tenantId: tenantA, name: "mcp-pending", kind: "openai" },
      select: { status: true },
    });
    expect(row?.status).toBe("pending");
    const audits = await suDb.auditLog.findMany({
      where: { tenantId: tenantA, action: "mcp.credential_create" },
    });
    expect(audits).toHaveLength(1);
    // The audit projection must never carry a secret (the tool never receives one).
    expect(JSON.stringify(audits[0]?.after ?? {})).not.toContain("sk-");
  });

  test("resolveSecretRef resolves a PENDING entry to its ref (wiring works before fill)", async () => {
    const p = principal({ tenantId: tenantA });
    await credentialCreate(
      p,
      { name: "wire-pending", kind: "generic", dry_run: false },
      { base: appDb },
    );
    const res = await resolveSecretRef(
      { tenantId: tenantA, userId: null, role: "TENANT_ADMIN" },
      "wire-pending",
      appDb,
    );
    expect("ref" in res).toBe(true);
    if ("ref" in res) expect(res.ref).toMatch(/^vault:\d+$/);
  });

  test("agent_list returns the tenant's agents (id, name, enabled)", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await agentList(p, { base: appDb });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const agents = r.data.agents as {
        id: string;
        name: string;
        enabled: boolean;
      }[];
      const mine = agents.find((a) => a.id === String(agentA));
      expect(mine).toBeDefined();
      expect(mine?.name).toBe("Bot");
    }
  });

  test("agent_list is tenant-fenced (other tenant cannot see agentA)", async () => {
    const p = principal({ tenantId: tenantB });
    const r = await agentList(p, { base: appDb });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const agents = r.data.agents as { id: string }[];
      expect(agents.find((a) => a.id === String(agentA))).toBeUndefined();
    }
  });

  test("agent_settings_get returns normalized defaults for an unset bag", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await agentSettingsGet(
      p,
      { agent_id: String(agentA) },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const s = r.data.settings;
      // Defaults from the typed readers (debounce on by default; tts mode never).
      expect(blk(s, "debounce").enabled).toBe(true);
      expect(blk(s, "tts").mode).toBe("never");
      expect(blk(s, "stt").provider).toBe("openai");
    }
  });

  test("agent_settings_set dry-run previews a diff and writes NOTHING", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await agentSettingsSet(
      p,
      { agent_id: String(agentA), debounce: { enabled: false } },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(true);
      expect((r.data.diff as Record<string, unknown>).debounce).toBeDefined();
    }
    const row = await suDb.agent.findUnique({ where: { id: agentA } });
    expect(row?.settings).toEqual({});
    const audits = await suDb.auditLog.count({
      where: { tenantId: tenantA, action: "mcp.agent_settings_set" },
    });
    expect(audits).toBe(0);
  });

  // Operator prose (handoff/kanban/tool guidance, guardrails policy, vision prompt, follow-up steps)
  // is clamped by the readers, so an over-cap note used to come back as a SUCCESSFUL diff already
  // showing the shortened value, which reads as "applied" rather than "cut". The dry run is checked
  // too: a preview that promises a write the apply would refuse is worse than no preview.
  test("agent_settings_set refuses over-cap guidance, on the preview and on the apply", async () => {
    const p = principal({ tenantId: tenantA });
    const boom = "h".repeat(TOOL_INSTRUCTIONS_MAX + 1);
    const preview = await agentSettingsSet(
      p,
      { agent_id: String(agentA), handoff: { instructions: boom } },
      { base: appDb },
    );
    expect(preview.ok).toBe(false);
    if (!preview.ok) {
      expect(preview.error).toContain("handoff.instructions");
      expect(preview.error).toContain(String(TOOL_INSTRUCTIONS_MAX));
    }
    const applied = await agentSettingsSet(
      p,
      {
        agent_id: String(agentA),
        handoff: { instructions: boom },
        dry_run: false,
      },
      { base: appDb },
    );
    expect(applied.ok).toBe(false);
    const row = await suDb.agent.findUnique({ where: { id: agentA } });
    expect(JSON.stringify(row?.settings)).not.toContain(boom.slice(0, 200));
  });

  // The refusal is about what the write CHANGES: a caller that reads the agent, edits one block and
  // sends the bag back has to be able to send the rest of it unchanged, over-cap legacy text included.
  test("agent_settings_set accepts a stored over-cap value it does not change", async () => {
    const legacy = "h".repeat(TOOL_INSTRUCTIONS_MAX + 1);
    const legacyAgent = await suDb.agent.create({
      data: {
        tenantId: tenantLegacy,
        name: "LegacyCap",
        systemPrompt: "p",
        settings: { handoff: { instructions: legacy } },
      },
    });
    const res = await agentSettingsSet(
      principal({ tenantId: tenantLegacy }),
      {
        agent_id: String(legacyAgent.id),
        handoff: { instructions: legacy },
        split: { enabled: true, maxChars: 400 },
        dry_run: false,
      },
      { base: appDb },
    );
    expect(res.ok).toBe(true);
    const row = await suDb.agent.findUnique({ where: { id: legacyAgent.id } });
    expect(blk(row?.settings, "split").maxChars).toBe(400);
    // MCP normalizes each touched block through its reader, so the handoff note it re-sent is stored
    // clamped. That is the pre-existing behavior of this transport, not the refusal doing it.
    expect(String(blk(row?.settings, "handoff").instructions)).toHaveLength(
      TOOL_INSTRUCTIONS_MAX,
    );
  });

  test("agent_settings_set apply merges + clamps + audits, preserving other keys", async () => {
    // Seed an unrelated key (grounding) to prove the merge preserves untouched keys.
    await suDb.agent.update({
      where: { id: agentA },
      data: { settings: { grounding: { maxDistance: 0.4 } } },
    });
    const p = principal({ tenantId: tenantA });
    const r = await agentSettingsSet(
      p,
      {
        agent_id: String(agentA),
        // windowSeconds 999 is out of range → clamped to the reader's ceiling (120).
        debounce: { enabled: true, windowSeconds: 999 },
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.applied).toBe(true);

    const row = await suDb.agent.findUnique({ where: { id: agentA } });
    // Touched block was clamped.
    expect(blk(row?.settings, "debounce").enabled).toBe(true);
    expect(blk(row?.settings, "debounce").windowSeconds).toBe(120);
    // Untouched key preserved through the merge.
    expect(blk(row?.settings, "grounding").maxDistance).toBe(0.4);

    const audits = await suDb.auditLog.findMany({
      where: { tenantId: tenantA, action: "mcp.agent_settings_set" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorType).toBe("mcp");
  });

  // The allowlist is what makes send_image usable at all, so an operator driving the fleet over MCP
  // has to be able to set it — granting the tool without it leaves every call refused.
  test("agent_settings_set persists the send_image host allowlist, normalized", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await agentSettingsSet(
      p,
      {
        agent_id: String(agentA),
        sendImage: {
          allowedHosts: ["https://CDN.loja.com.br/x", "cdn.loja.com.br", "??"],
        },
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    const row = await suDb.agent.findUnique({ where: { id: agentA } });
    // Normalized to a hostname, deduped, and the junk entry dropped by the reader.
    expect(blk(row?.settings, "sendImage").allowedHosts).toEqual([
      "cdn.loja.com.br",
    ]);
  });

  test("agent_settings_set partial block merge keeps sibling sub-keys", async () => {
    const p = principal({ tenantId: tenantA });
    // Only flip tts.mode; provider/model must keep their existing (default) values.
    const r = await agentSettingsSet(
      p,
      { agent_id: String(agentA), tts: { mode: "mirror" }, dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    const row = await suDb.agent.findUnique({ where: { id: agentA } });
    expect(blk(row?.settings, "tts").mode).toBe("mirror");
    expect(blk(row?.settings, "tts").provider).toBe("openai");
    // debounce from the prior apply is still intact.
    expect(blk(row?.settings, "debounce").windowSeconds).toBe(120);
  });

  test("agent_settings_set applies followUp + handoff (the closed MCP gap)", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await agentSettingsSet(
      p,
      {
        agent_id: String(agentA),
        followUp: {
          enabled: true,
          steps: [
            {
              delayValue: 6,
              delayUnit: "hours",
              instructions: "primeiro toque leve",
            },
            {
              delayValue: 2,
              delayUnit: "days",
              instructions: "fechamento",
              resolve: true,
            },
          ],
        },
        handoff: {
          mode: "agent_choice",
          instructions: "escale negociação de valor",
        },
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.applied).toBe(true);
    const row = await suDb.agent.findUnique({ where: { id: agentA } });
    const fu = blk(row?.settings, "followUp");
    expect(fu.enabled).toBe(true);
    expect(fu.pauseWhileAppointment).toBe(true);
    expect(Array.isArray(fu.steps)).toBe(true);
    expect(blk(row?.settings, "handoff").mode).toBe("agent_choice");
    expect(blk(row?.settings, "handoff").instructions).toContain("negocia");
  });

  test("agent_settings_set cross-tenant agent_id is invisible → 'agent not found'", async () => {
    const p = principal({ tenantId: tenantB });
    const r = await agentSettingsSet(
      p,
      {
        agent_id: String(agentA),
        debounce: { enabled: false },
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });

  test("agent_settings_get cross-tenant agent_id → 'agent not found'", async () => {
    const p = principal({ tenantId: tenantB });
    const r = await agentSettingsGet(
      p,
      { agent_id: String(agentA) },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });

  test("agent_settings_set with ambiguous credential name returns error listing types", async () => {
    const p = principal({ tenantId: tenantA });
    // "shared-cred" exists under both "generic" and "bearer" kinds.
    const r = await agentSettingsSet(
      p,
      { agent_id: String(agentA), stt: { credentialRef: "shared-cred" } },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("ambiguous");
      expect(r.error).toContain("bearer");
      expect(r.error).toContain("generic");
      expect(r.error).toContain("vault:");
    }
  });

  test("agent_settings_set with vault:<id> ref resolves correctly", async () => {
    const p = principal({ tenantId: tenantA });
    // Passing the stable vault:<id> ref bypasses the name-ambiguity check.
    const r = await agentSettingsSet(
      p,
      {
        agent_id: String(agentA),
        stt: { credentialRef: `vault:${credGenericId}` },
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.applied).toBe(true);
    const row = await suDb.agent.findUnique({ where: { id: agentA } });
    const stt = blk(row?.settings, "stt");
    expect(stt.credentialRef).toBe(`vault:${credGenericId}`);
  });

  // The tts block carries TWO credentials (the voice engine's, and the speech normalizer's own
  // model). The name→ref translation is keyed by (block, field), so a loop that only knew
  // "credentialRef" would store this one as a raw NAME, which resolves nowhere at turn time, and
  // the operator would only find out from a missing rewrite in production.
  test("agent_settings_set translates the tts normalizer credential name too, and get projects it back", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await agentSettingsSet(
      p,
      {
        agent_id: String(agentA),
        tts: {
          normalize: true,
          normalizeCredentialRef: `vault:${credGenericId}`,
        },
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    const row = await suDb.agent.findUnique({ where: { id: agentA } });
    expect(blk(row?.settings, "tts").normalizeCredentialRef).toBe(
      `vault:${credGenericId}`,
    );
    const got = await agentSettingsGet(
      p,
      { agent_id: String(agentA) },
      { base: appDb },
    );
    expect(got.ok).toBe(true);
    if (got.ok) {
      const tts = (got.data.settings as Record<string, Record<string, unknown>>)
        .tts;
      // Back to the NAME, like every other credential the MCP contract exposes.
      expect(tts?.normalizeCredentialRef).toBe("shared-cred");
    }
  });

  test("agent_settings_set with vault:<id> not in tenant returns not-found error", async () => {
    const p = principal({ tenantId: tenantA });
    // Use credBearerId from tenantA but pretend it belongs to a different tenant by using a
    // non-existent id — this simulates a ref that does not resolve under RLS.
    const r = await agentSettingsSet(
      p,
      {
        agent_id: String(agentA),
        tts: { credentialRef: "vault:999999999999" },
      },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });

  test("langfuse_connect applies: fills a kind:langfuse vault entry + enables tracing + audits", async () => {
    const p = principal({
      tenantId: tenantA,
      scopes: ["mcp:read", "mcp:write"],
    });
    const r = await langfuseConnect(
      p,
      {
        public_key: "pk-lf-aaa",
        secret_key: "sk-lf-bbb",
        base_url: "https://langfuse.test",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.applied).toBe(true);
      const lf = r.data.langfuse as Record<string, unknown>;
      expect(lf.enabled).toBe(true);
      expect(lf.credentialRef).toBe("langfuse");
    }
    const entries = await suDb.vaultEntry.findMany({
      where: { tenantId: tenantA, kind: "langfuse" },
      select: { status: true },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("active");
    const row = await suDb.tenant.findUnique({ where: { id: tenantA } });
    expect(blk(row?.settings, "langfuse").enabled).toBe(true);
    const audits = await suDb.auditLog.count({
      where: { tenantId: tenantA, action: "mcp.langfuse_connect" },
    });
    expect(audits).toBe(1);
  });

  test("langfuse_connect re-connect is idempotent (updates the same entry, no duplicate)", async () => {
    const p = principal({
      tenantId: tenantA,
      scopes: ["mcp:read", "mcp:write"],
    });
    const r = await langfuseConnect(
      p,
      {
        public_key: "pk-lf-rotated",
        secret_key: "sk-lf-rotated",
        base_url: "https://langfuse.test",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    const entries = await suDb.vaultEntry.findMany({
      where: { tenantId: tenantA, kind: "langfuse" },
    });
    expect(entries).toHaveLength(1);
  });
});
