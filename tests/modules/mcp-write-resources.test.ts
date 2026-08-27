import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  knowledgeCreate,
  knowledgeDelete,
} from "@/modules/mcp/write-knowledge";
import {
  apiKeyRevoke,
  businessHoursCreate,
  experimentCreate,
  experimentUpdate,
  tenantSettingsUpdate,
} from "@/modules/mcp/write-settings";

// Fase 5 write tools (knowledge bases/docs/approvals + experiments/business-hours/tenant-settings/
// api-keys): gate is DB-free; dry-run/apply/audit, secret-by-reference and tenant fencing need a
// real Postgres (skipIf).

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

describe("MCP resource-write gate (no DB)", () => {
  test("knowledge_create without mcp:write → insufficient_scope", async () => {
    const r = await knowledgeCreate(principal({ scopes: ["mcp:read"] }), {
      name: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("experiment_update invalid id → error", async () => {
    const r = await experimentUpdate(principal({}), {
      experiment_id: "nope",
      name: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid experiment_id");
  });

  test("tenant_settings_update with no blocks → error", async () => {
    const r = await tenantSettingsUpdate(principal({}), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no updatable blocks");
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

describe.skipIf(!dbUp)("MCP resource-write tools (DB)", () => {
  let tenantA = 0n;
  let tenantB = 0n;
  let kbA = 0n;
  let apiKeyA = 0n;

  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "RWA", slug: `rw-a-${process.pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "RWB", slug: `rw-b-${process.pid}` },
    });
    tenantB = b.id;
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId: tenantA, name: "Docs" },
      select: { id: true },
    });
    kbA = kb.id;
    const key = await suDb.apiKey.create({
      data: {
        tenantId: tenantA,
        displayName: "k1",
        keyHash: `hash-${process.pid}`,
        keyPrefix: "fazerai_aaa",
        role: "TENANT_ADMIN",
      },
      select: { id: true },
    });
    apiKeyA = key.id;
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM api_keys WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM experiments WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM business_hours WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM knowledge_bases WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("knowledge_create dry-run creates nothing; apply creates + audits", async () => {
    const p = principal({ tenantId: tenantA });
    const dry = await knowledgeCreate(p, { name: "KB Dry" }, { base: appDb });
    expect(dry.ok).toBe(true);
    if (dry.ok) expect(dry.data.dryRun).toBe(true);
    expect(
      await suDb.knowledgeBase.count({
        where: { tenantId: tenantA, name: "KB Dry" },
      }),
    ).toBe(0);

    const applied = await knowledgeCreate(
      p,
      { name: "KB Real", dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    expect(
      await suDb.knowledgeBase.count({
        where: { tenantId: tenantA, name: "KB Real" },
      }),
    ).toBe(1);
    const audits = await suDb.auditLog.count({
      where: { tenantId: tenantA, action: "knowledge.create" },
    });
    expect(audits).toBe(1);
  });

  test("knowledge_delete cross-tenant → not found", async () => {
    const r = await knowledgeDelete(
      principal({ tenantId: tenantB }),
      { knowledge_base_id: String(kbA), dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    expect(
      await suDb.knowledgeBase.findUnique({ where: { id: kbA } }),
    ).not.toBeNull();
  });

  test("business_hours_create apply persists + audits", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await businessHoursCreate(
      p,
      {
        name: "Comercial",
        timezone: "America/Sao_Paulo",
        windows: [{ day: 1, start: "09:00", end: "18:00" }],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    expect(
      await suDb.businessHours.count({
        where: { tenantId: tenantA, name: "Comercial" },
      }),
    ).toBe(1);
  });

  test("business_hours_create carries date exceptions, and rejects an impossible date", async () => {
    const p = principal({ tenantId: tenantA });
    const ok = await businessHoursCreate(
      p,
      {
        name: "Com feriado",
        timezone: "America/Sao_Paulo",
        windows: [{ day: 1, start: "09:00", end: "18:00" }],
        exceptions: [
          { date: "2026-09-07", label: "Independência", ranges: [] },
          {
            date: "2026-12-24",
            ranges: [{ start: "08:00", end: "12:00" }],
          },
        ],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(ok.ok).toBe(true);
    const row = await suDb.businessHours.findFirstOrThrow({
      where: { tenantId: tenantA, name: "Com feriado" },
      select: { exceptions: true },
    });
    expect(row.exceptions).toHaveLength(2);

    // A dated span that runs backwards covers nothing, so it would sit in the editor looking like a
    // closure that is simply never in force.
    const backwards = await businessHoursCreate(
      p,
      {
        name: "Span invertido",
        windows: [],
        exceptions: [{ date: "2026-12-25", dateEnd: "2026-12-20", ranges: [] }],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(backwards.ok).toBe(false);
    // The same span IS valid when it recurs: that is how a year-end shutdown wraps.
    const wrapping = await businessHoursCreate(
      p,
      {
        name: "Recesso anual",
        windows: [],
        exceptions: [
          {
            date: "2026-12-23",
            dateEnd: "2027-01-02",
            recurring: true,
            ranges: [],
          },
        ],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(wrapping.ok).toBe(true);

    // Feb 30 passes the "YYYY-MM-DD" shape and would roll over into March, silently moving the
    // closure to a day the operator never chose.
    const bad = await businessHoursCreate(
      p,
      {
        name: "Data impossível",
        windows: [],
        exceptions: [{ date: "2026-02-30", ranges: [] }],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(bad.ok).toBe(false);
    expect(
      await suDb.businessHours.count({
        where: { tenantId: tenantA, name: "Data impossível" },
      }),
    ).toBe(0);
  });

  test("experiment_create apply persists", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await experimentCreate(
      p,
      {
        name: "Tone test",
        variants: [
          { key: "a", weight: 1, system_prompt: "be formal" },
          { key: "b", weight: 1, system_prompt: "be casual" },
        ],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    expect(
      await suDb.experiment.count({
        where: { tenantId: tenantA, name: "Tone test" },
      }),
    ).toBe(1);
  });

  test("an orphan half in the NAME does not cost the audit row", async () => {
    // The audit projection here carries `args.name` as the caller sent it, not the value read back
    // from the row — so nothing has round-tripped through a text column to sanitise it on the way.
    // `audit_logs.after` is jsonb, the experiment has already been created by then, and a refusal
    // would apply the change, report a failure and drop the record of who made it.
    const p = principal({ tenantId: tenantA });
    const name = (JSON.parse('{"n":"Teste \\ud800 A/B"}') as { n: string }).n;
    const r = await experimentCreate(
      p,
      {
        name,
        variants: [
          { key: "a", weight: 1, system_prompt: "be formal" },
          { key: "b", weight: 1, system_prompt: "be casual" },
        ],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    expect(
      await suDb.auditLog.count({
        where: { tenantId: tenantA, action: "experiment.create" },
      }),
    ).toBe(2);
  });

  test("tenant_settings_update embedding with unknown credential → needsCredential", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await tenantSettingsUpdate(
      p,
      { embedding: { credential_ref: "missing-emb-key" }, dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.needsCredential).toBe(true);
  });

  test("api_key_revoke dry-run keeps it; apply sets revokedAt", async () => {
    const p = principal({ tenantId: tenantA });
    const dry = await apiKeyRevoke(
      p,
      { api_key_id: String(apiKeyA) },
      { base: appDb },
    );
    expect(dry.ok).toBe(true);
    if (dry.ok) expect(dry.data.dryRun).toBe(true);
    expect(
      (await suDb.apiKey.findUnique({ where: { id: apiKeyA } }))?.revokedAt,
    ).toBeNull();

    const applied = await apiKeyRevoke(
      p,
      { api_key_id: String(apiKeyA), dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    expect(
      (await suDb.apiKey.findUnique({ where: { id: apiKeyA } }))?.revokedAt,
    ).not.toBeNull();
  });
});
