import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { ForbiddenError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  createApiKey,
  createFleetApiKey,
  listApiKeys,
  listFleetApiKeys,
  revokeApiKey,
  revokeFleetApiKey,
} from "@/modules/api-keys/service";
import {
  API_KEY_PREFIX,
  type ApiKeyPrincipal,
  generateApiKey,
  hasApiKeyPrefix,
  hashApiKey,
  LEGACY_API_KEY_PREFIX,
  verifyApiKey,
} from "@/modules/api-keys/verify";
import { mcpPrincipalFromApiKey } from "@/modules/mcp/oauth/tokens";

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

// ── fleet-scoped keys (issue #308) ──
//
// Every key used to be born TENANT_ADMIN and pinned to one tenant, so a fleet operation (create a
// tenant, read the whole roster) could only be driven by a SUPER_ADMIN browser session: automation
// logged in, kept cookies, and re-typed a person's password for step-up. A fleet key is the same
// row with the shape `users` already gives a SUPER_ADMIN — no home tenant, SUPER_ADMIN authority —
// and the CHECK constraint below is what keeps the two halves of that shape from drifting apart.
const FLEET_USER = 4343n;
const fleetCtx = (): TenantContext => ({
  tenantId: null,
  userId: FLEET_USER,
  role: "SUPER_ADMIN",
  actorType: "user",
});
// Its own tenant: the block above drops A and B in its afterAll before this one runs.
let tenantF = 0n;
const ctxF = (): TenantContext => ({
  tenantId: tenantF,
  userId: USER_A,
  role: "TENANT_ADMIN",
});

describe.skipIf(!dbUp)("fleet-scoped api keys", () => {
  beforeAll(async () => {
    if (!su) return;
    const f = await su.tenant.create({
      data: { name: "AK-F", slug: `ak-f-${process.pid}` },
    });
    tenantF = f.id;
  });

  afterAll(async () => {
    if (!su) return;
    // USER_A too: the refusal case would leave a NULL-tenant row under it if the gate were ever
    // removed, and a leftover from such a run must not fail the next one's count instead of its own.
    await su.$executeRawUnsafe(
      `DELETE FROM api_keys WHERE tenant_id IS NULL AND created_by_user_id IN (${FLEET_USER}, ${USER_A})`,
    );
    await su.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE tenant_id IS NULL AND actor_id IN (${FLEET_USER}, ${USER_A})`,
    );
    if (tenantF) {
      await su.$executeRawUnsafe(
        `DELETE FROM api_keys WHERE tenant_id = ${tenantF}`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantF}`,
      );
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantF}`);
    }
  });

  test("only a SUPER_ADMIN mints one, and a refusal writes nothing", async () => {
    await expect(
      createFleetApiKey(ctxF(), { displayName: "not yours" }, appDb),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await su?.apiKey.count({ where: { displayName: "not yours" } }),
    ).toBe(0);
  });

  test("the row has no tenant and SUPER_ADMIN authority, whatever tenant the minter had selected", async () => {
    // A SUPER_ADMIN in the console always has SOME tenant selected (X-Tenant-Id); the key is not
    // that tenant's, so the selection must not leak into the row.
    const created = await createFleetApiKey(
      { ...fleetCtx(), tenantId: tenantF },
      { displayName: "fleet one" },
      appDb,
    );
    expect(created.token.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(created.apiKey.role).toBe("SUPER_ADMIN");
    expect("keyHash" in created.apiKey).toBe(false);
    expect(JSON.stringify(created.apiKey)).not.toContain(created.token);
    const row = await su?.apiKey.findUnique({
      where: { id: BigInt(created.apiKey.id) },
    });
    expect(row?.tenantId).toBeNull();
    expect(row?.role).toBe("SUPER_ADMIN");
    expect(row?.createdByUserId).toBe(FLEET_USER);
    expect(row?.keyHash).toBe(hashApiKey(created.token));
  });

  test("verify resolves a fleet principal: no tenant, SUPER_ADMIN, and the MCP seam gives it the fleet scopes", async () => {
    const { token } = await createFleetApiKey(
      fleetCtx(),
      { displayName: "fleet verify" },
      appDb,
    );
    const principal = await verifyApiKey(token, appDb);
    expect(principal).not.toBeNull();
    expect(principal?.tenantId).toBeNull();
    expect(principal?.role).toBe("SUPER_ADMIN");
    expect(principal?.userId).toBe(FLEET_USER);
    // The MCP transport already models a tenant-less SUPER_ADMIN token (the `tenant` selector per
    // call); a fleet key rides that model unchanged.
    const mcp = mcpPrincipalFromApiKey(principal as ApiKeyPrincipal);
    expect(mcp.tenantId).toBeNull();
    expect(mcp.role).toBe("SUPER_ADMIN");
    expect(mcp.scopes).toContain("mcp:admin");
  });

  test("a tenant never lists a fleet key, and the fleet list never carries a tenant key", async () => {
    await createFleetApiKey(fleetCtx(), { displayName: "fleet listed" }, appDb);
    await createApiKey(ctxF(), { displayName: "tenant listed" }, appDb);
    const tenantKeys = await listApiKeys(ctxF(), appDb);
    expect(tenantKeys.some((k) => k.displayName === "fleet listed")).toBe(
      false,
    );
    expect(tenantKeys.every((k) => k.role === "TENANT_ADMIN")).toBe(true);
    const fleetKeys = await listFleetApiKeys(fleetCtx(), appDb);
    expect(fleetKeys.some((k) => k.displayName === "fleet listed")).toBe(true);
    expect(fleetKeys.some((k) => k.displayName === "tenant listed")).toBe(
      false,
    );
    expect(fleetKeys.every((k) => k.role === "SUPER_ADMIN")).toBe(true);
    // The fleet list is a fleet read: a tenant admin has no such list.
    await expect(listFleetApiKeys(ctxF(), appDb)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("revoke: the tenant path cannot reach a fleet key, the fleet path cannot reach a tenant key, and a revoked fleet key stops verifying", async () => {
    const fleet = await createFleetApiKey(
      fleetCtx(),
      { displayName: "fleet revoke" },
      appDb,
    );
    const tenant = await createApiKey(
      ctxF(),
      { displayName: "tenant revoke" },
      appDb,
    );
    const fleetId = BigInt(fleet.apiKey.id);
    const tenantId = BigInt(tenant.apiKey.id);
    // A tenant admin (even the SUPER_ADMIN operating AS tenant A) cannot revoke a fleet key by the
    // tenant path: the row is invisible under tenant scope.
    await expect(revokeApiKey(ctxF(), fleetId, appDb)).rejects.toThrow();
    await expect(
      revokeApiKey({ ...fleetCtx(), tenantId: tenantF }, fleetId, appDb),
    ).rejects.toThrow();
    expect(await verifyApiKey(fleet.token, appDb)).not.toBeNull();
    // The fleet path is for fleet keys only: a tenant key keeps its tenant's trail and its tenant's
    // revoke.
    await expect(
      revokeFleetApiKey(fleetCtx(), tenantId, appDb),
    ).rejects.toThrow();
    expect(await verifyApiKey(tenant.token, appDb)).not.toBeNull();
    await expect(revokeFleetApiKey(ctxF(), fleetId, appDb)).rejects.toThrow();
    // The fleet revoke works once, and the key 401s (null) afterwards.
    await revokeFleetApiKey(fleetCtx(), fleetId, appDb);
    expect(await verifyApiKey(fleet.token, appDb)).toBeNull();
    await expect(
      revokeFleetApiKey(fleetCtx(), fleetId, appDb),
    ).rejects.toThrow();
  });

  test("the trail is fleet-level: tenant NULL, actor and door from the context", async () => {
    const created = await createFleetApiKey(
      { ...fleetCtx(), actorType: "mcp" },
      { displayName: "fleet audited" },
      appDb,
    );
    const id = BigInt(created.apiKey.id);
    await revokeFleetApiKey(fleetCtx(), id, appDb);
    const rows =
      (await su?.auditLog.findMany({
        where: { target: id.toString(), action: { startsWith: "api_key." } },
        orderBy: { id: "asc" },
      })) ?? [];
    expect(rows.map((r) => r.action)).toEqual([
      "api_key.create",
      "api_key.revoke",
    ]);
    for (const r of rows) {
      expect(r.tenantId).toBeNull();
      expect(r.actorId).toBe(FLEET_USER);
      expect(
        JSON.stringify({ before: r.before, after: r.after }),
      ).not.toContain(created.token);
    }
    expect(rows[0]?.actorType).toBe("mcp");
    expect(rows[1]?.actorType).toBe("user");
    expect((rows[0]?.after as { role?: string })?.role).toBe("SUPER_ADMIN");
  });

  test("the database refuses the two shapes the service never writes", async () => {
    if (!su) return;
    const insert = async (role: string, tenant: string) =>
      await su.$executeRawUnsafe(
        `INSERT INTO api_keys (tenant_id, display_name, key_hash, key_prefix, role, created_by_user_id)
         VALUES (${tenant}, 'bad shape', '${hashApiKey(`x-${role}-${tenant}-${process.pid}`)}', 'fazerai_bad', '${role}', ${FLEET_USER})`,
      );
    // SUPER_ADMIN authority pinned to a tenant, and tenant authority with no tenant: both are the
    // same CHECK `users` carries, and both are refused at the row.
    await expect(insert("SUPER_ADMIN", String(tenantF))).rejects.toThrow(
      /api_keys_role_tenant_check/,
    );
    await expect(insert("TENANT_ADMIN", "NULL")).rejects.toThrow(
      /api_keys_role_tenant_check/,
    );
  });
});
