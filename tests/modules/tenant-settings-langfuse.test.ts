import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import {
  getTenantSettings,
  parseLangfuseSettings,
  updateLangfuse,
} from "@/modules/tenant-settings/service";
import { formatVaultRef } from "@/modules/vault/service";
import { dbProbeFailed } from "@/tests/db-gate";

// ── unit: schema parser ignores legacy baseUrl in stored JSON ──
describe("parseLangfuseSettings", () => {
  test("returns defaults for missing/empty block", () => {
    const s = parseLangfuseSettings({});
    expect(s.enabled).toBe(false);
    expect(s.credentialRef).toBeNull();
    expect(s.sendContent).toBe(false);
  });

  test("parses a complete block", () => {
    const s = parseLangfuseSettings({
      langfuse: {
        enabled: true,
        credentialRef: "vault:99",
        sendContent: true,
      },
    });
    expect(s.enabled).toBe(true);
    expect(s.credentialRef).toBe("vault:99");
    expect(s.sendContent).toBe(true);
  });

  test("tolerates legacy fields (baseUrl, environment) without throwing", () => {
    // baseUrl and environment were stored in earlier versions; the parser must strip them silently.
    const s = parseLangfuseSettings({
      langfuse: {
        enabled: true,
        credentialRef: "vault:1",
        baseUrl: "https://cloud.langfuse.com",
        environment: "production",
        sendContent: false,
      },
    });
    expect(s.enabled).toBe(true);
    expect(s.credentialRef).toBe("vault:1");
    // No legacy fields on the returned type.
    expect((s as Record<string, unknown>).baseUrl).toBeUndefined();
    expect((s as Record<string, unknown>).environment).toBeUndefined();
  });
});

// ── DB-gated: updateLangfuse with credential validation ──
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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

let tenantId = 0n;
let langfuseEntryId = 0n;
let otherKindEntryId = 0n;

function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

describe.skipIf(!dbUp)("updateLangfuse (DB)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "LFTest", slug: `lf-${process.pid}` },
    });
    tenantId = t.id;

    // Create a langfuse-kind vault entry (has the correct multi-field shape).
    const lf = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "my-langfuse",
        kind: "langfuse",
        secret: encryptJson({ publicKey: "pk-test", secretKey: "sk-test" }),
        baseUrl: "https://us.cloud.langfuse.com",
      },
      select: { id: true },
    });
    langfuseEntryId = lf.id;

    // Create a non-langfuse vault entry (wrong kind).
    const other = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "openai-cred",
        kind: "openai",
        secret: encryptJson("sk-openai"),
      },
      select: { id: true },
    });
    otherKindEntryId = other.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("PUT with valid langfuse credentialRef stores the ref", async () => {
    const ref = formatVaultRef(langfuseEntryId);
    const result = await updateLangfuse(
      ctx(),
      { enabled: true, credentialRef: ref },
      appDb,
    );
    expect(result.enabled).toBe(true);
    expect(result.credentialRef).toBe(ref);
  });

  test("PUT with null credentialRef clears it", async () => {
    const result = await updateLangfuse(ctx(), { credentialRef: null }, appDb);
    expect(result.credentialRef).toBeNull();
  });

  test("PUT with credentialRef of wrong kind → 400", async () => {
    const ref = formatVaultRef(otherKindEntryId);
    await expect(
      updateLangfuse(ctx(), { credentialRef: ref }, appDb),
    ).rejects.toThrow("langfuse");
  });

  test("PUT with non-existent credentialRef → 400", async () => {
    await expect(
      updateLangfuse(ctx(), { credentialRef: "vault:999999999" }, appDb),
    ).rejects.toThrow();
  });

  test("GET exposes credentialRef (not hasCredential/baseUrl)", async () => {
    const ref = formatVaultRef(langfuseEntryId);
    await updateLangfuse(ctx(), { enabled: true, credentialRef: ref }, appDb);
    const settings = await getTenantSettings(ctx(), appDb);
    // New shape: credentialRef is exposed directly.
    expect(settings.langfuse.credentialRef).toBe(ref);
    // No baseUrl on the returned type.
    expect(
      (settings.langfuse as Record<string, unknown>).baseUrl,
    ).toBeUndefined();
    expect(
      (settings.langfuse as Record<string, unknown>).hasCredential,
    ).toBeUndefined();
  });
});
