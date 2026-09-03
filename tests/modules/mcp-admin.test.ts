import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { createApiKey } from "@/modules/api-keys/service";
import { verifyApiKey } from "@/modules/api-keys/verify";
import {
  createClient,
  deleteClient,
  deleteClientApproval,
  listActiveTokens,
  listClientApprovals,
  listClients,
  revokeToken,
  updateClient,
} from "@/modules/mcp/oauth/admin";
import { upsertApproval } from "@/modules/mcp/oauth/consent";
import {
  issueAccessToken,
  mcpPrincipalFromApiKey,
  scopesForRole,
  verifyAccessToken,
} from "@/modules/mcp/oauth/tokens";

// The fleet principal these SUPER_ADMIN-only functions now take. It is what names the actor on the
// row each of them appends (#400); the rows themselves are asserted in
// `tests/modules/audit-actor-family.test.ts`.
const su9400: TenantContext = {
  tenantId: null,
  userId: 9400n,
  role: "SUPER_ADMIN",
};

describe("scopesForRole + mcpPrincipalFromApiKey", () => {
  test("an API-key (TENANT_ADMIN) gets mcp:read + mcp:write, never mcp:admin", () => {
    expect(scopesForRole("TENANT_ADMIN")).toEqual(["mcp:read", "mcp:write"]);
    expect(scopesForRole("AGENT")).toEqual(["mcp:read"]);
    expect(scopesForRole("SUPER_ADMIN")).toContain("mcp:admin");
  });

  test("maps a verified API-key principal to the MCP token shape", () => {
    const principal = mcpPrincipalFromApiKey({
      apiKeyId: 9n,
      userId: 3n,
      tenantId: 5n,
      role: "TENANT_ADMIN",
      stepUpAt: new Date(),
    });
    expect(principal.tenantId).toBe(5n);
    expect(principal.userId).toBe(3n);
    expect(principal.role).toBe("TENANT_ADMIN");
    expect(principal.scopes).toEqual(["mcp:read", "mcp:write"]);
    expect(principal.scopes).not.toContain("mcp:admin");
    expect(principal.clientId).toBe("api-key");
    expect(principal.jti).toBe("api-key:9");
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
// A real TENANT_ADMIN user in tenantA — verifyAccessToken re-resolves the user and rejects a
// role/tenant mismatch, so issued tokens must reference a matching user.
let userA = 0n;
const createdClientIds: string[] = [];

describe.skipIf(!dbUp)("mcp admin service", () => {
  beforeAll(async () => {
    if (!su) return;
    const a = await su.tenant.create({
      data: { name: "MA-A", slug: `ma-a-${process.pid}` },
    });
    const b = await su.tenant.create({
      data: { name: "MA-B", slug: `ma-b-${process.pid}` },
    });
    tenantA = a.id;
    tenantB = b.id;
    const u = await su.user.create({
      data: {
        email: `ma-user-${process.pid}@test.local`,
        // A check constraint requires an auth method; the value is never used (we never log in).
        passwordHash: "test-only-hash",
        role: "TENANT_ADMIN",
        tenantId: tenantA,
      },
    });
    userA = u.id;
  });

  afterAll(async () => {
    if (su) {
      for (const cid of createdClientIds) {
        await su.$executeRawUnsafe(
          `DELETE FROM mcp_oauth_access_tokens WHERE client_id = '${cid}'`,
        );
        await su.$executeRawUnsafe(
          `DELETE FROM mcp_oauth_refresh_tokens WHERE client_id = '${cid}'`,
        );
        await su.$executeRawUnsafe(
          `DELETE FROM mcp_oauth_client_approvals WHERE client_id = '${cid}'`,
        );
        await su.$executeRawUnsafe(
          `DELETE FROM mcp_oauth_clients WHERE client_id = '${cid}'`,
        );
      }
      for (const id of [tenantA, tenantB]) {
        if (!id) continue;
        await su.$executeRawUnsafe(
          `DELETE FROM mcp_oauth_access_tokens WHERE tenant_id = ${id}`,
        );
        await su.$executeRawUnsafe(
          `DELETE FROM api_keys WHERE tenant_id = ${id}`,
        );
        await su.$executeRawUnsafe(
          `DELETE FROM audit_logs WHERE tenant_id = ${id}`,
        );
        await su.$executeRawUnsafe(`DELETE FROM users WHERE tenant_id = ${id}`);
        await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
      }
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("create validates redirect URIs and never leaks the secret hash", async () => {
    await expect(
      createClient(
        su9400,
        { name: "bad", redirectUris: ["https://*.evil.com/cb"] },
        appDb,
      ),
    ).rejects.toThrow();
    const client = await createClient(
      su9400,
      {
        name: "Claude",
        redirectUris: ["https://app.example.com/cb"],
        scopes: ["mcp:read", "mcp:write"],
      },
      appDb,
    );
    createdClientIds.push(client.clientId);
    expect(client.isConfidential).toBe(false);
    expect(client.grantTypes).toContain("authorization_code");
    expect("clientSecretHash" in client).toBe(false);
    const listed = await listClients(appDb);
    const found = listed.find((c) => c.clientId === client.clientId);
    expect(found).toBeDefined();
    expect(JSON.stringify(found)).not.toContain("Secret");
  });

  test("update rejects an unknown client; revoke a token closes the denylist loop", async () => {
    await expect(
      updateClient(su9400, "nonexistent-client", { name: "x" }, appDb),
    ).rejects.toThrow();

    const client = await createClient(
      su9400,
      { name: "Cursor", redirectUris: ["https://cursor.example.com/cb"] },
      appDb,
    );
    createdClientIds.push(client.clientId);
    const issued = await issueAccessToken({
      clientId: client.clientId,
      userId: userA,
      tenantId: tenantA,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
      base: appDb,
    });
    // Listed as active and the JWT verifies.
    let active = await listActiveTokens({ tenantId: tenantA }, appDb);
    expect(active.some((tk) => tk.jti === issued.jti)).toBe(true);
    expect(await verifyAccessToken(issued.token, appDb)).not.toBeNull();
    // Tenant filter isolates: tenant B does not see tenant A's token.
    const bActive = await listActiveTokens({ tenantId: tenantB }, appDb);
    expect(bActive.some((tk) => tk.jti === issued.jti)).toBe(false);
    // Revoke → gone from the active list AND the JWT no longer verifies (denylist).
    await revokeToken(su9400, issued.jti, appDb);
    active = await listActiveTokens({ tenantId: tenantA }, appDb);
    expect(active.some((tk) => tk.jti === issued.jti)).toBe(false);
    expect(await verifyAccessToken(issued.token, appDb)).toBeNull();
  });

  test("deleting a client revokes its tokens and removes it", async () => {
    const client = await createClient(
      su9400,
      { name: "ToDelete", redirectUris: ["https://d.example.com/cb"] },
      appDb,
    );
    createdClientIds.push(client.clientId);
    const issued = await issueAccessToken({
      clientId: client.clientId,
      userId: userA,
      tenantId: tenantA,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      base: appDb,
    });
    await deleteClient(su9400, client.clientId, appDb);
    expect(
      (await listClients(appDb)).some((c) => c.clientId === client.clientId),
    ).toBe(false);
    // The client's token was revoked in the cascade.
    expect(await verifyAccessToken(issued.token, appDb)).toBeNull();
    await expect(
      deleteClient(su9400, client.clientId, appDb),
    ).rejects.toThrow();
  });

  test("firstParty defaults false; can be set on create and toggled on update", async () => {
    const def = await createClient(
      su9400,
      { name: "DefaultParty", redirectUris: ["https://dp.example.com/cb"] },
      appDb,
    );
    createdClientIds.push(def.clientId);
    expect(def.firstParty).toBe(false);

    const fp = await createClient(
      su9400,
      {
        name: "FirstParty",
        redirectUris: ["https://fp.example.com/cb"],
        firstParty: true,
      },
      appDb,
    );
    createdClientIds.push(fp.clientId);
    expect(fp.firstParty).toBe(true);

    const toggled = await updateClient(
      su9400,
      def.clientId,
      { firstParty: true },
      appDb,
    );
    expect(toggled.firstParty).toBe(true);
  });

  test("dynamicallyRegistered: false on admin-created clients, true is exposed in the DTO", async () => {
    const admin = await createClient(
      su9400,
      { name: "AdminMade", redirectUris: ["https://am.example.com/cb"] },
      appDb,
    );
    createdClientIds.push(admin.clientId);
    expect(admin.dynamicallyRegistered).toBe(false);

    // Simulate a DCR self-registration (what POST /register persists) and confirm the DTO surfaces it.
    const dcrClientId = `dcr-${process.pid}`;
    await appDb.mcpOAuthClient.create({
      data: {
        clientId: dcrClientId,
        name: "Self Registered",
        redirectUris: ["https://sr.example.com/cb"],
        grantTypes: ["authorization_code", "refresh_token"],
        scopes: ["mcp:read"],
        dynamicallyRegistered: true,
      },
    });
    createdClientIds.push(dcrClientId);
    const found = (await listClients(appDb)).find(
      (c) => c.clientId === dcrClientId,
    );
    expect(found?.dynamicallyRegistered).toBe(true);
    expect(found?.firstParty).toBe(false);
  });

  test("approvals: an upsert is listed (enriched) and revoke removes it; unknown revoke throws", async () => {
    const client = await createClient(
      su9400,
      { name: "ApprClient", redirectUris: ["https://ap.example.com/cb"] },
      appDb,
    );
    createdClientIds.push(client.clientId);
    await upsertApproval(
      userA,
      client.clientId,
      ["mcp:read", "mcp:write"],
      appDb,
    );

    const listed = await listClientApprovals(appDb);
    const found = listed.find(
      (a) => a.clientId === client.clientId && a.userId === userA.toString(),
    );
    expect(found).toBeDefined();
    expect(found?.clientName).toBe("ApprClient");
    expect(found?.userEmail).toContain("ma-user-");
    expect(new Set(found?.scopes)).toEqual(new Set(["mcp:read", "mcp:write"]));

    await deleteClientApproval(su9400, BigInt(found?.id as string), appDb);
    expect(
      (await listClientApprovals(appDb)).some((a) => a.id === found?.id),
    ).toBe(false);

    await expect(
      deleteClientApproval(su9400, 999_999_999n, appDb),
    ).rejects.toThrow();
  });

  test("MCP-via-API-key seam: a verified API key maps to a read+write MCP principal", async () => {
    const { token } = await createApiKey(
      { tenantId: tenantA, userId: 1n, role: "TENANT_ADMIN" },
      { displayName: "mcp client key" },
      appDb,
    );
    const apiPrincipal = await verifyApiKey(token, appDb);
    expect(apiPrincipal).not.toBeNull();
    if (!apiPrincipal) return;
    const mcp = mcpPrincipalFromApiKey(apiPrincipal);
    expect(mcp.tenantId).toBe(tenantA);
    expect(mcp.scopes).toEqual(["mcp:read", "mcp:write"]);
    // A revoked key no longer verifies → the MCP transport would 401 (su bypasses RLS to revoke).
    await su?.apiKey.update({
      where: { id: apiPrincipal.apiKeyId },
      data: { revokedAt: new Date() },
    });
    expect(await verifyApiKey(token, appDb)).toBeNull();
  });
});
