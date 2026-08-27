import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  langfuseConnect,
  tenantSettingsUpdate,
} from "@/modules/mcp/write-settings";
import {
  setCompanyLogoKey,
  updateCompanySettings,
  updateEmbeddingSettings,
  updateLangfuse,
  updateSpendCeiling,
} from "@/modules/tenant-settings/service";
import { countingBase } from "../utils/counting-base";

// The tenant / tenant-settings / branding trail, moved into the services that perform the writes.
//
// Six actions existed and all six were written by an MCP tool after the service had committed, so
// the identical change made from the console left no row at all. Measured, not assumed: every
// probe in this file failed on the base. Three more things this family made visible, each with a
// test below that dies if the fix is undone:
//
//   - `audit_logs.tenant_id` is ON DELETE CASCADE, so a `tenant.delete` row filed under the tenant
//     it deletes is erased by the same statement. The deployment's most consequential act, gone.
//   - A SUPER_ADMIN writes whichever tenant the PATH names, not the one its header selects, so a row
//     keyed on the context lands in a stranger's trail.
//   - Removing a branding asset had no audit name on any transport, and none of the branding writes
//     ran inside a transaction, so no row could ever have been atomic with them.

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
let tenantId = 0n;
let otherId = 0n;

// Distinctive, because the fleet-level rows this file reads have no tenant to scope them by and the
// table is shared with every other DB-backed file in the run. `tenant_id IS NULL` alone would read
// somebody else's rows and delete them on the way out.
const USER = 970_394n;

const ctx = (over: Partial<TenantContext> = {}): TenantContext => ({
  tenantId,
  userId: USER,
  role: "TENANT_ADMIN",
  ...over,
});
const principal = (over: Partial<VerifiedToken> = {}): VerifiedToken => ({
  userId: USER,
  tenantId,
  role: "TENANT_ADMIN",
  scopes: ["mcp:read", "mcp:write"],
  clientId: "c",
  jti: "j",
  ...over,
});
async function rows(where: Record<string, unknown> = {}) {
  return (await su?.auditLog.findMany({ where, orderBy: { id: "asc" } })) ?? [];
}

// The projection alone, flattened: the row's ids are BigInt and JSON.stringify refuses those.
function projectionText(rs: { before: unknown; after: unknown }[]) {
  return JSON.stringify(rs.map((r) => [r.before, r.after]));
}

async function clearAudit() {
  await su?.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE actor_id = ${USER} OR tenant_id IN (${tenantId}, ${otherId})`,
  );
}

describe.skipIf(!dbUp)("the tenant family records from its services", () => {
  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "AUDT", slug: `audt-${process.pid}` },
    });
    tenantId = t.id;
    const o = await su.tenant.create({
      data: { name: "OTHER", slug: `audo-${process.pid}` },
    });
    otherId = o.id;
  });

  afterAll(async () => {
    // `dbUp` for the same reason as its sibling: `su` is assigned before the connection is checked.
    if (dbUp && su && tenantId) {
      await su.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE actor_id = ${USER}`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id IN (${tenantId}, ${otherId})`,
      );
      await su.$executeRawUnsafe(`DELETE FROM app_branding WHERE id = 1`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  // ── tenant lifecycle: which trail the row joins is the whole question ──
  // ── settings: every block writer goes through the same lock, so every one records ──

  test("each settings block writes its own action, with the block's before and after", async () => {
    await clearAudit();
    await updateEmbeddingSettings(ctx(), { credentialRef: null }, appDb);
    await updateLangfuse(ctx(), { enabled: true, sendContent: true }, appDb);
    await updateCompanySettings(ctx(), { name: "ACME LTDA" }, appDb);
    const all = await rows({ tenantId });
    expect(all.map((r) => r.action)).toEqual([
      "tenant_settings.embedding_set",
      "tenant_settings.langfuse_set",
      "tenant_settings.company_set",
    ]);
    const lf = all[1];
    expect(lf?.before).toMatchObject({ enabled: false, sendContent: false });
    expect(lf?.after).toMatchObject({ enabled: true, sendContent: true });
    // The letterhead names WHICH fields moved and carries none of their values: this block holds the
    // operator's own tax id, address and phone, and a row outlives the profile that held them.
    expect(all[2]?.before).toBeNull();
    expect(all[2]?.after).toEqual({ changed: ["name"] });
  });

  // THE NUMBER THAT DECIDES WHETHER A CUSTOMER IS ANSWERED, so the trail owes both sides of it: a
  // month that went silent is investigated by asking who moved the ceiling and from what. The
  // operator's own sentence is the one field reported as moved rather than quoted — it is free text
  // the console reads back in full, and a row keeps whatever it copies forever.
  test("the spend ceiling records its numbers, and the copy only as set or cleared", async () => {
    await clearAudit();
    await updateSpendCeiling(
      ctx(),
      {
        enabled: true,
        monthlyInboxTokens: 250_000,
        overCeilingMessage:
          "Voltamos amanhã, e alguém da equipe continua por aqui.",
      },
      appDb,
    );
    const all = await rows({ tenantId });
    expect(all.map((r) => r.action)).toEqual([
      "tenant_settings.spend_ceiling_set",
    ]);
    expect(all[0]?.before).toMatchObject({
      enabled: false,
      monthlyInboxTokens: 0,
    });
    expect(all[0]?.after).toMatchObject({
      enabled: true,
      monthlyInboxTokens: 250_000,
    });
    // The sentence itself is not in the row, on either side.
    expect(projectionText(all)).not.toContain("Voltamos amanhã");
    // ...and what IS there answers "did it move": null before, a digest after.
    const first = all[0]?.after as { overCeilingMessage?: string | null };
    expect(first.overCeilingMessage).toBeTruthy();

    // ONE SENTENCE REPLACED BY ANOTHER IS A CHANGE, and a bare "set" on both sides could not say so.
    // This is the edit an operator actually makes — the message exists and its wording is being
    // corrected — so it is the one the trail must not read as a no-op.
    await clearAudit();
    await updateSpendCeiling(
      ctx(),
      { overCeilingMessage: "Estamos fora do ar; alguém retorna em breve." },
      appDb,
    );
    const second = await rows({ tenantId });
    const before = second[0]?.before as { overCeilingMessage?: string | null };
    const after = second[0]?.after as { overCeilingMessage?: string | null };
    expect(before.overCeilingMessage).toBe(first.overCeilingMessage);
    expect(after.overCeilingMessage).not.toBe(before.overCeilingMessage);
    expect(projectionText(second)).not.toContain("Estamos fora do ar");
  });

  test("the logo's two acts are recorded under their own names", async () => {
    await clearAudit();
    await setCompanyLogoKey(ctx(), "tenant-logo.png", appDb);
    await setCompanyLogoKey(ctx(), null, appDb);
    const all = await rows({ tenantId });
    expect(all.map((r) => r.action)).toEqual([
      "company_logo.set",
      "company_logo.clear",
    ]);
    expect(all[0]?.after).toMatchObject({ logoKey: "tenant-logo.png" });
    expect(all[1]?.before).toMatchObject({ logoKey: "tenant-logo.png" });
    expect(all[1]?.after).toMatchObject({ logoKey: null });
  });

  test("a settings write and its row share ONE transaction", async () => {
    const { base, total } = countingBase(appDb);
    await updateCompanySettings(ctx(), { phone: "1199999" }, base);
    expect(total()).toBe(1);
  });

  test("no letterhead value reaches a row, not even the one being replaced", async () => {
    await clearAudit();
    const pii = {
      name: "Joao da Silva ME",
      document: "12345678901",
      address: "Rua das Flores 42, Sao Paulo",
      phone: "11987654321",
      email: "joao.silva@example.com",
      website: "https://example.com",
    };
    await updateCompanySettings(ctx(), pii, appDb);
    // Correcting one field: the SUPERSEDED tax id is the value a trail would otherwise keep forever.
    await updateCompanySettings(ctx(), { document: "98765432100" }, appDb);
    const all = await rows({ tenantId });
    expect(all.map((r) => r.action)).toEqual([
      "tenant_settings.company_set",
      "tenant_settings.company_set",
    ]);
    expect(all[1]?.after).toEqual({ changed: ["document"] });
    const text = projectionText(all);
    for (const value of Object.values(pii)) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toContain("98765432100");
  });

  test("a refused settings write records nothing", async () => {
    await clearAudit();
    await expect(
      // A character no PDF font in the renderer can print: refused before the lock is taken.
      updateCompanySettings(ctx(), { name: "ACME 你好" }, appDb),
    ).rejects.toThrow();
    expect(await rows({ tenantId })).toEqual([]);
  });

  // ── the same actions, through the MCP door ──

  test("the MCP settings tool leaves one row per block it touched, attributed to MCP", async () => {
    await clearAudit();
    const res = await tenantSettingsUpdate(
      principal(),
      {
        embedding: { credential_ref: null },
        langfuse: { enabled: false },
        dry_run: false,
      },
      { base: appDb },
    );
    expect(res.ok).toBe(true);
    const all = await rows({ tenantId });
    expect(all.map((r) => r.action)).toEqual([
      "tenant_settings.embedding_set",
      "tenant_settings.langfuse_set",
    ]);
    for (const r of all) expect(r.actorType).toBe("mcp");
  });

  test("an MCP dry run records nothing", async () => {
    await clearAudit();
    await tenantSettingsUpdate(
      principal(),
      { langfuse: { enabled: true } },
      { base: appDb },
    );
    expect(await rows({ tenantId })).toEqual([]);
  });

  test("langfuse_connect records the vault fill and the settings write as the two writes they are", async () => {
    await clearAudit();
    const res = await langfuseConnect(
      principal(),
      {
        public_key: "pk-lf-probe",
        secret_key: "sk-lf-probe",
        base_url: "https://lf.example.com",
        name: `lf-${process.pid}`,
        dry_run: false,
      },
      { base: appDb },
    );
    expect(res.ok).toBe(true);
    const all = await rows({ tenantId });
    expect(all.map((r) => r.action)).toEqual([
      "tenant_settings.langfuse_set",
      "langfuse.connect",
    ]);
    // Neither row carries either key, in any field.
    const dump = projectionText(all);
    expect(dump).not.toContain("pk-lf-probe");
    expect(dump).not.toContain("sk-lf-probe");
  });
});
