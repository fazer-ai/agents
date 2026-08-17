import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "@/modules/api-keys/service";
import {
  API_KEY_PREFIX,
  generateApiKey,
  hasApiKeyPrefix,
  hashApiKey,
  LEGACY_API_KEY_PREFIX,
  verifyApiKey,
} from "@/modules/api-keys/verify";

describe("api key token generation", () => {
  test("generateApiKey is prefixed and its hash round-trips", () => {
    const gen = generateApiKey();
    expect(gen.token.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(gen.hash).toBe(hashApiKey(gen.token));
    // The display prefix is the brand marker + 6 chars and never the full token.
    expect(gen.prefix).toBe(gen.token.slice(0, API_KEY_PREFIX.length + 6));
    expect(gen.token.length).toBeGreaterThan(gen.prefix.length);
  });

  test("two keys never collide", () => {
    expect(generateApiKey().token).not.toBe(generateApiKey().token);
  });

  // Brand rename compatibility window: new keys are minted `fazerai_`, keys minted before it carry
  // `secv4_`. The prefix guard has to admit both; the DB lookup then decides. Dropped at 2.0.
  test("the mint prefix is the current brand marker", () => {
    expect(API_KEY_PREFIX).toBe("fazerai_");
    expect(generateApiKey().token.startsWith("fazerai_")).toBe(true);
  });

  test("the prefix guard admits both markers and nothing else", () => {
    expect(hasApiKeyPrefix(`${API_KEY_PREFIX}abc`)).toBe(true);
    expect(hasApiKeyPrefix(`${LEGACY_API_KEY_PREFIX}abc`)).toBe(true);
    expect(hasApiKeyPrefix("sk_live_abc")).toBe(false);
    expect(hasApiKeyPrefix("")).toBe(false);
  });
});

// ── integration (real DB) ──
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
let tenantA = 0n;
let tenantB = 0n;
const USER_A = 4242n;
const ctxA = (): TenantContext => ({
  tenantId: tenantA,
  userId: USER_A,
  role: "TENANT_ADMIN",
});
const ctxB = (): TenantContext => ({
  tenantId: tenantB,
  userId: 7n,
  role: "TENANT_ADMIN",
});

describe.skipIf(!dbUp)("api key service + verify (RLS)", () => {
  beforeAll(async () => {
    if (!su) return;
    const a = await su.tenant.create({
      data: { name: "AK-A", slug: `ak-a-${process.pid}` },
    });
    const b = await su.tenant.create({
      data: { name: "AK-B", slug: `ak-b-${process.pid}` },
    });
    tenantA = a.id;
    tenantB = b.id;
  });

  afterAll(async () => {
    if (su && tenantA) {
      for (const id of [tenantA, tenantB]) {
        await su.$executeRawUnsafe(
          `DELETE FROM api_keys WHERE tenant_id = ${id}`,
        );
        await su.$executeRawUnsafe(
          `DELETE FROM audit_logs WHERE tenant_id = ${id}`,
        );
        await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
      }
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("create returns a one-time token whose hash matches the stored row; the DTO never leaks it", async () => {
    const created = await createApiKey(
      ctxA(),
      { displayName: "client one" },
      appDb,
    );
    expect(created.token.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(created.apiKey.displayName).toBe("client one");
    expect(created.apiKey.role).toBe("TENANT_ADMIN");
    expect(created.apiKey.keyPrefix).toBe(
      created.token.slice(0, API_KEY_PREFIX.length + 6),
    );
    // The DTO carries neither the hash nor the plaintext.
    expect("keyHash" in created.apiKey).toBe(false);
    expect(JSON.stringify(created.apiKey)).not.toContain(created.token);
    // The stored hash is sha256(token).
    const row = await su?.apiKey.findFirst({
      where: { tenantId: tenantA, displayName: "client one" },
    });
    expect(row?.keyHash).toBe(hashApiKey(created.token));
    expect(row?.createdByUserId).toBe(USER_A);
  });

  test("verify resolves the principal (tenant, role, creator)", async () => {
    const { token } = await createApiKey(
      ctxA(),
      { displayName: "verify me" },
      appDb,
    );
    const principal = await verifyApiKey(token, appDb);
    expect(principal).not.toBeNull();
    expect(principal?.tenantId).toBe(tenantA);
    expect(principal?.role).toBe("TENANT_ADMIN");
    expect(principal?.userId).toBe(USER_A);
  });

  // The load-bearing half of the compatibility window: a key an operator is already using was
  // minted under the old marker and lives in their DB. It has to keep authenticating unchanged —
  // we cannot reach a self-hosted instance to rewrite it.
  test("verify still resolves a key minted under the pre-rename prefix", async () => {
    const legacyToken = `${LEGACY_API_KEY_PREFIX}${"l".repeat(32)}`;
    await su?.apiKey.create({
      data: {
        tenantId: tenantA,
        displayName: "pre-rename key",
        // The stored hash covers the WHOLE token, prefix included — this is why no data migration
        // is needed for the rename.
        keyHash: hashApiKey(legacyToken),
        keyPrefix: legacyToken.slice(0, LEGACY_API_KEY_PREFIX.length + 6),
        role: "TENANT_ADMIN",
        createdByUserId: USER_A,
      },
    });
    const principal = await verifyApiKey(legacyToken, appDb);
    expect(principal).not.toBeNull();
    expect(principal?.tenantId).toBe(tenantA);
    expect(principal?.role).toBe("TENANT_ADMIN");
    expect(principal?.userId).toBe(USER_A);
  });

  test("verify rejects a malformed or unknown key", async () => {
    expect(await verifyApiKey("not-a-key", appDb)).toBeNull();
    expect(await verifyApiKey(`${API_KEY_PREFIX}deadbeef`, appDb)).toBeNull();
    expect(
      await verifyApiKey(`${LEGACY_API_KEY_PREFIX}deadbeef`, appDb),
    ).toBeNull();
  });

  test("list is RLS-scoped: a tenant sees only its own keys", async () => {
    await createApiKey(ctxA(), { displayName: "a-only" }, appDb);
    const aKeys = await listApiKeys(ctxA(), appDb);
    const bKeys = await listApiKeys(ctxB(), appDb);
    expect(aKeys.some((k) => k.displayName === "a-only")).toBe(true);
    expect(bKeys.some((k) => k.displayName === "a-only")).toBe(false);
  });

  test("revoke is at-most-once and tenant-fenced; a revoked key stops verifying", async () => {
    const { token, apiKey } = await createApiKey(
      ctxA(),
      { displayName: "to revoke" },
      appDb,
    );
    const id = BigInt(apiKey.id);
    // Cross-tenant revoke cannot touch tenant A's key (RLS → count 0 → NotFound).
    await expect(revokeApiKey(ctxB(), id, appDb)).rejects.toThrow();
    expect(await verifyApiKey(token, appDb)).not.toBeNull();
    // Owner revoke succeeds; the key 401s (null) afterwards.
    await revokeApiKey(ctxA(), id, appDb);
    expect(await verifyApiKey(token, appDb)).toBeNull();
    // Re-revoking an already-revoked key is a no-op NotFound.
    await expect(revokeApiKey(ctxA(), id, appDb)).rejects.toThrow();
  });

  test("verify rejects a key whose tenant no longer exists", async () => {
    if (!su) return;
    const tmp = await su.tenant.create({
      data: { name: "AK-tmp", slug: `ak-tmp-${process.pid}` },
    });
    const { token } = await createApiKey(
      { tenantId: tmp.id, userId: USER_A, role: "TENANT_ADMIN" },
      { displayName: "orphan" },
      appDb,
    );
    expect(await verifyApiKey(token, appDb)).not.toBeNull();
    await su.$executeRawUnsafe(
      `DELETE FROM api_keys WHERE tenant_id = ${tmp.id}`,
    );
    await su.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE tenant_id = ${tmp.id}`,
    );
    await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tmp.id}`);
    expect(await verifyApiKey(token, appDb)).toBeNull();
  });
});
