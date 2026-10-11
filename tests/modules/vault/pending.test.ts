import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  createPendingVaultEntry,
  createVaultEntry,
  formatVaultRef,
  listVaultInfos,
  resolveVaultEntry,
  resolveVaultRefByName,
  resolveVaultSecret,
  tryResolveVaultEntry,
  tryResolveVaultSecret,
  updateVaultEntry,
} from "@/modules/vault/service";
import { dbProbeFailed } from "@/tests/db-gate";

// ── DB-gated tests (real Postgres under a tenant-scoped tx) ──

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

const appDb = app as PrismaClient;
const suDb = su as PrismaClient;
let tenantId = 0n;

describe.skipIf(!dbUp)("vault: pending credentials", () => {
  const ctx = (): TenantContext => ({
    tenantId,
    userId: null,
    role: "TENANT_ADMIN",
  });

  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "VaultPending", slug: `vaultpending-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (su && tenantId) {
      await su.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("createPendingVaultEntry stores status=pending and an empty {} blob", async () => {
    const { id, ref } = await createPendingVaultEntry(
      ctx(),
      { name: "pend-openai", kind: "openai" },
      appDb,
    );
    const row = await suDb.vaultEntry.findUnique({
      where: { id },
      select: { status: true, secret: true },
    });
    if (!row) throw new Error("created row not found");
    expect(row.status).toBe("pending");
    expect(decryptJson<Record<string, unknown>>(row.secret)).toEqual({});
    expect(ref).toBe(formatVaultRef(id));
  });

  test("a pending entry resolves as missing: strict throws, try* returns null", async () => {
    const { ref } = await createPendingVaultEntry(
      ctx(),
      { name: "pend-strict", kind: "generic" },
      appDb,
    );
    await runScopedOn(appDb, ctx(), async (db) => {
      await expect(resolveVaultEntry(db, ref)).rejects.toThrow();
      await expect(resolveVaultSecret(db, ref)).rejects.toThrow();
      expect(await tryResolveVaultEntry(db, ref)).toBeNull();
      expect(await tryResolveVaultSecret(db, ref)).toBeNull();
    });
  });

  test("resolveVaultRefByName reports pending for a pending entry, not for an active one", async () => {
    await createPendingVaultEntry(
      ctx(),
      { name: "pend-byname", kind: "generic" },
      appDb,
    );
    const pendingRes = await resolveVaultRefByName(
      ctx(),
      "pend-byname",
      "generic",
      appDb,
    );
    expect(pendingRes).toMatchObject({ status: "found", pending: true });

    await createVaultEntry(
      ctx(),
      { name: "active-byname", value: "sk-real", kind: "generic" },
      undefined,
      undefined,
      appDb,
    );
    const activeRes = await resolveVaultRefByName(
      ctx(),
      "active-byname",
      "generic",
      appDb,
    );
    expect(activeRes).toMatchObject({ status: "found", pending: false });
  });

  test("listVaultInfos exposes the status field", async () => {
    const infos = await runScopedOn(appDb, ctx(), (db) => listVaultInfos(db));
    const pend = infos.find((i) => i.name === "pend-openai");
    expect(pend?.status).toBe("pending");
  });

  test("filling a pending entry with a real value promotes it to active and resolves", async () => {
    const { id, ref } = await createPendingVaultEntry(
      ctx(),
      { name: "pend-fill", kind: "generic" },
      appDb,
    );
    await updateVaultEntry(ctx(), id, { value: "sk-filled" }, appDb);
    const row = await suDb.vaultEntry.findUnique({
      where: { id },
      select: { status: true },
    });
    expect(row?.status).toBe("active");
    const value = await runScopedOn(appDb, ctx(), (db) =>
      resolveVaultSecret<string>(db, ref),
    );
    expect(value).toBe("sk-filled");
  });

  test("createPendingVaultEntry rejects OAuth/managed-blob kinds", async () => {
    await expect(
      createPendingVaultEntry(
        ctx(),
        { name: "pend-oauth", kind: "google_oauth" },
        appDb,
      ),
    ).rejects.toThrow();
  });

  test("createPendingVaultEntry enforces the (name, kind) unique constraint", async () => {
    await createPendingVaultEntry(
      ctx(),
      { name: "pend-dup", kind: "generic" },
      appDb,
    );
    await expect(
      createPendingVaultEntry(
        ctx(),
        { name: "pend-dup", kind: "generic" },
        appDb,
      ),
    ).rejects.toThrow();
  });
});
