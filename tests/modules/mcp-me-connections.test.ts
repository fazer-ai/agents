import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  disconnectClient,
  listMyConnections,
} from "@/modules/mcp/oauth/connections";
import { upsertApproval } from "@/modules/mcp/oauth/consent";
import {
  issueAccessToken,
  verifyAccessToken,
} from "@/modules/mcp/oauth/tokens";

// Self-service connections module (oauth/connections.ts): a user lists/disconnects only their OWN MCP
// apps. Fences everything by userId on the GLOBAL mcp_oauth_* tables. Real-DB harness (skips if down).
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
let userA = 0n;
let userB = 0n;

// The caller, as the principal the disconnect now records itself under (#400).
const asUser = (userId: bigint): TenantContext & { userId: bigint } => ({
  tenantId: tenantA,
  userId,
  role: "TENANT_ADMIN",
});
const clientId = `mc-${process.pid}`;

describe.skipIf(!dbUp)("mcp self-service connections", () => {
  beforeAll(async () => {
    if (!su) return;
    const tA = await su.tenant.create({
      data: { name: "MC-A", slug: `mc-a-${process.pid}` },
    });
    tenantA = tA.id;
    const uA = await su.user.create({
      data: {
        email: `mc-a-${process.pid}@test.local`,
        passwordHash: "x",
        role: "TENANT_ADMIN",
        tenantId: tenantA,
      },
    });
    const uB = await su.user.create({
      data: {
        email: `mc-b-${process.pid}@test.local`,
        passwordHash: "x",
        role: "TENANT_ADMIN",
        tenantId: tenantA,
      },
    });
    userA = uA.id;
    userB = uB.id;
    // A self-registered (DCR) client → unverified in the self-service view.
    await su.mcpOAuthClient.create({
      data: {
        clientId,
        name: "Conn Client",
        redirectUris: ["https://c.example.com/cb"],
        grantTypes: ["authorization_code", "refresh_token"],
        scopes: ["mcp:read", "mcp:write"],
        dynamicallyRegistered: true,
      },
    });
  });

  afterAll(async () => {
    if (su) {
      await su.$executeRawUnsafe(
        `DELETE FROM mcp_oauth_access_tokens WHERE client_id = '${clientId}'`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM mcp_oauth_refresh_tokens WHERE client_id = '${clientId}'`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM mcp_oauth_client_approvals WHERE client_id = '${clientId}'`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM mcp_oauth_clients WHERE client_id = '${clientId}'`,
      );
      if (tenantA) {
        await su.$executeRawUnsafe(
          `DELETE FROM users WHERE tenant_id = ${tenantA}`,
        );
        await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantA}`);
      }
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("listMyConnections is fenced to the caller and enriches the row", async () => {
    await upsertApproval(userA, clientId, ["mcp:read", "mcp:write"], appDb);
    await upsertApproval(userB, clientId, ["mcp:read"], appDb);

    const aConns = await listMyConnections(userA, appDb);
    expect(aConns.length).toBe(1);
    expect(aConns[0]?.clientId).toBe(clientId);
    expect(aConns[0]?.clientName).toBe("Conn Client");
    // dynamicallyRegistered && !firstParty → unverified.
    expect(aConns[0]?.unverified).toBe(true);
    expect(aConns[0]?.firstParty).toBe(false);
    expect(new Set(aConns[0]?.scopes)).toEqual(
      new Set(["mcp:read", "mcp:write"]),
    );

    // B sees only its own approval (the union it consented to).
    const bConns = await listMyConnections(userB, appDb);
    expect(bConns.length).toBe(1);
    expect(new Set(bConns[0]?.scopes)).toEqual(new Set(["mcp:read"]));
  });

  test("activeTokenCount counts only the caller's live tokens", async () => {
    await issueAccessToken({
      clientId,
      userId: userA,
      tenantId: tenantA,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      base: appDb,
    });
    const row = (await listMyConnections(userA, appDb)).find(
      (c) => c.clientId === clientId,
    );
    expect(row?.activeTokenCount).toBeGreaterThanOrEqual(1);
  });

  test("disconnect forgets the approval AND revokes the caller's tokens", async () => {
    const issued = await issueAccessToken({
      clientId,
      userId: userA,
      tenantId: tenantA,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      base: appDb,
    });
    expect(await verifyAccessToken(issued.token, appDb)).not.toBeNull();

    const result = await disconnectClient(asUser(userA), clientId, appDb);
    expect(result.removedApproval).toBe(true);
    expect(result.revokedAccessTokens).toBeGreaterThanOrEqual(1);

    // Approval forgotten, token dead.
    expect(
      (await listMyConnections(userA, appDb)).some(
        (c) => c.clientId === clientId,
      ),
    ).toBe(false);
    expect(await verifyAccessToken(issued.token, appDb)).toBeNull();

    // Idempotent: a second disconnect is a no-op.
    const again = await disconnectClient(asUser(userA), clientId, appDb);
    expect(again.removedApproval).toBe(false);
  });

  test("disconnecting a client never touches another user's connection/tokens", async () => {
    const bIssued = await issueAccessToken({
      clientId,
      userId: userB,
      tenantId: tenantA,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      base: appDb,
    });
    // A disconnects the same clientId again — must not affect B.
    await disconnectClient(asUser(userA), clientId, appDb);
    expect(await verifyAccessToken(bIssued.token, appDb)).not.toBeNull();
    expect(
      (await listMyConnections(userB, appDb)).some(
        (c) => c.clientId === clientId,
      ),
    ).toBe(true);
  });
});
