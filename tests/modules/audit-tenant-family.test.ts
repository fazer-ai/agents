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

// The tenant / tenant-settings / branding trail, recorded by the services that perform the writes,
// so the console and MCP leave the same row. Three invariants of this family, each with a test:
//   - `audit_logs.tenant_id` is ON DELETE CASCADE, so a `tenant.delete` row filed under the tenant
//     it deletes would be erased by the same statement; it is fleet-level.
//   - A SUPER_ADMIN writes whichever tenant the PATH names, not the one its header selects, so a row
//     keyed on the context would land in a stranger's trail.
//   - Removing a branding asset is recorded, and the branding writes run inside a transaction, so
//     the row is atomic with them.

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
<<<<<<< ours
=======
      // @full-only
      // NOTE: the asset writers put real files on disk, and a leftover is not inert: the next run's
      // set comparison sees it.
      for (const f of brandingFiles()) {
        await unlink(`${BRANDING_DIR}/${f}`).catch(() => {});
      }
      // @full-only-end
>>>>>>> theirs
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
        monthlyInboxUsd: 250,
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
      monthlyInboxUsd: 0,
    });
    expect(all[0]?.after).toMatchObject({
      enabled: true,
      monthlyInboxUsd: 250,
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

  // THREE rows: the credential this tool fills is created by the vault service, which records it;
  // `langfuse.connect` names the connection rather than the entry.
  test("langfuse_connect records the credential, the settings write and the connection as the three writes they are", async () => {
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
      "credential.create",
      "tenant_settings.langfuse_set",
      "langfuse.connect",
    ]);
    // No row carries either key, in any field.
    const dump = projectionText(all);
    expect(dump).not.toContain("pk-lf-probe");
    expect(dump).not.toContain("sk-lf-probe");
  });
<<<<<<< ours
=======
  // @full-only

  // ── branding: fleet-level, and the actor's selected tenant does not move it ──

  test("a branding write records at the fleet level even when the actor has a tenant selected", async () => {
    await clearAudit();
    await updateBrandingColors(
      // A SUPER_ADMIN with a tenant chosen in the console: the row must NOT follow that choice.
      superAdmin({ tenantId }),
      { brandName: "Contoso" },
      appDb,
    );
    expect(await rows({ tenantId })).toEqual([]);
    const fleet = await rows({ tenantId: null, actorId: USER });
    expect(fleet.map((r) => r.action)).toEqual(["branding.set"]);
    expect(fleet[0]?.target).toBe("branding:global");
    expect(fleet[0]?.before).toMatchObject({ brandName: null });
    expect(fleet[0]?.after).toMatchObject({ brandName: "Contoso" });
  });

  test("a branding write and its row share ONE transaction", async () => {
    const { base, total } = countingBase(appDb);
    await updateBrandingColors(superAdmin(), { brandName: "Fabrikam" }, base);
    expect(total()).toBe(1);
  });

  test("uploading and REMOVING an asset both leave a row, and neither carries bytes", async () => {
    await clearAudit();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const file = new Blob([png], { type: "image/png" });
    await setBrandingAsset(superAdmin(), "logo", "dark", file, appDb);
    await clearBrandingAsset(superAdmin(), "logo", "dark", appDb);
    const fleet = await rows({ tenantId: null, actorId: USER });
    expect(fleet.map((r) => r.action)).toEqual([
      "branding_asset.set",
      // Removal had no audit name on ANY transport before: no MCP tool clears an asset.
      "branding_asset.clear",
    ]);
    expect(fleet[0]?.after).toMatchObject({ present: true, bytes: 4 });
    expect(fleet[1]?.before).toMatchObject({ present: true });
    expect(fleet[1]?.after).toMatchObject({ present: false });
    expect(projectionText(fleet)).not.toContain("PNG");
    await unlink(assetPath("logo-dark.png")).catch(() => {});
  });

  // The file side of the same transaction, which is the half Postgres does not roll back for you.
  //
  // Both writes touch disk as well as the row, so both have an ordering that only matters when the
  // transaction does not commit. The upload drops the file it superseded and the clear drops the one
  // it is unlinking, and each happens AFTER the commit rather than beside the write: deleting the
  // file first would leave a failed update's row naming bytes that are already gone.
  test("the file a row names is written before the row, and outlives a rollback", async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
      type: "image/png",
    });
    const png2 = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d])], {
      type: "image/png",
    });
    const nameOf = async () =>
      (await su?.appBranding.findUnique({ where: { id: 1 } }))
        ?.logoDarkKey as string;

    await setBrandingAsset(superAdmin(), "logo", "dark", png, appDb);
    const live = await nameOf();
    expect(await Bun.file(assetPath(live)).exists()).toBe(true);

    // A DIFFERENT image of the same format. The deterministic name this replaced would have made
    // this the same path, so the public image would already have changed before the transaction.
    const filesBefore = brandingFiles();
    await expect(
      setBrandingAsset(superAdmin(), "logo", "dark", png2, failingAudit(appDb)),
    ).rejects.toThrow();
    expect(await nameOf()).toBe(live);
    expect((await Bun.file(assetPath(live)).arrayBuffer()).byteLength).toBe(4);
    // The file this call wrote and then rolled back left nothing behind. Compared as a SET against a
    // snapshot, not as a count: the directory is shared with whatever else the run touched.
    expect(brandingFiles()).toEqual(filesBefore);

    await expect(
      clearBrandingAsset(superAdmin(), "logo", "dark", failingAudit(appDb)),
    ).rejects.toThrow();
    expect(await nameOf()).toBe(live);
    expect(await Bun.file(assetPath(live)).exists()).toBe(true);

    // Committing is what publishes, and it drops the file it superseded.
    await setBrandingAsset(superAdmin(), "logo", "dark", png2, appDb);
    const live2 = await nameOf();
    expect(live2).not.toBe(live);
    expect((await Bun.file(assetPath(live2)).arrayBuffer()).byteLength).toBe(5);
    expect(await Bun.file(assetPath(live)).exists()).toBe(false);

    // Re-uploading the SAME bytes lands on the same digest, so there is nothing to drop.
    await setBrandingAsset(superAdmin(), "logo", "dark", png2, appDb);
    expect(await nameOf()).toBe(live2);
    expect(await Bun.file(assetPath(live2)).exists()).toBe(true);

    // And the same re-upload ROLLING BACK must not take the live file with it. Content addressing
    // is what makes this case exist: identical bytes make the name this call "created" the name the
    // row already had, so the cleanup has to ask the committed row rather than assume.
    await expect(
      setBrandingAsset(superAdmin(), "logo", "dark", png2, failingAudit(appDb)),
    ).rejects.toThrow();
    expect(await nameOf()).toBe(live2);
    expect(await Bun.file(assetPath(live2)).exists()).toBe(true);

    await clearBrandingAsset(superAdmin(), "logo", "dark", appDb);
    expect(await Bun.file(assetPath(live2)).exists()).toBe(false);
  });

  test("clearing an asset that was never set writes nothing, row or no row", async () => {
    await su?.$executeRawUnsafe(`DELETE FROM app_branding WHERE id = 1`);
    await clearAudit();
    await clearBrandingAsset(superAdmin(), "favicon", "light", appDb);
    expect(await rows({ tenantId: null, actorId: USER })).toEqual([]);

    // The other half, and the one that was wrong: a row EXISTS because something else was
    // configured, and this variant is already null. Writing anyway would record a clearance reading
    // `present: false` on both sides and bump `updatedAt`, which is the version every visitor's
    // browser keys its cached copy of every asset on.
    await updateBrandingColors(superAdmin(), { brandName: "SOMETHING" }, appDb);
    const before = await su?.appBranding.findUnique({ where: { id: 1 } });
    await clearAudit();
    const answered = await clearBrandingAsset(
      superAdmin(),
      "favicon",
      "light",
      appDb,
    );
    expect(await rows({ tenantId: null, actorId: USER })).toEqual([]);
    // A no-op still answers with the branding that IS stored. Reporting the default would have the
    // console re-render the fallback identity over a configured one.
    expect(answered.brandName).toBe("SOMETHING");
    expect(
      (await su?.appBranding.findUnique({ where: { id: 1 } }))?.updatedAt,
    ).toEqual(before?.updatedAt as Date);
  });
  // @full-only-end
>>>>>>> theirs
});
