import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// The channel family's trail, driven through the Channels page's own doors (issue #395).
//
// `tests/modules/audit-channel-family.test.ts` proves the SERVICES record. This file answers the half
// it cannot see: whether the eleven mutating routes of `chatwoot-admin.controller.ts` reach those
// services with a principal at all. None of them contained the string `audit`, and three of them have
// no MCP twin, so before this the console was the ONLY door those three had and it recorded nothing.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

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

setupPrismaMock();

const ADMIN_TOKEN = "cw-console-token-9394";
// The two destructive routes ask for the acting user's password again (step-up), verified against
// the stored hash, so the session alone does not open them.
const PASSWORD = "senha-do-operador-9394";
const PASSWORD_HASH = await Bun.password.hash(PASSWORD);
// The pid in the PATH, the way `withRunNamespace` does it for the seeded fixtures: the server key is
// derived from this URL and `chatwoot_instances (server_key, account_id)` is unique GLOBALLY, so two
// runs against the shared test database collide on P2002 and the route answers 409.
const BASE_URL = `https://203.0.113.94/p${process.pid}`;

const fetchProfile = async () => ({
  accounts: [
    { id: 1, name: "Conta A" },
    { id: 2, name: "Conta B" },
  ],
});

const makeClient = async () =>
  ({
    // 404 is how the fork says an inbox is gone, and the removal REFUSES a mirror whose inbox still
    // exists upstream. The journey below removes one, so this double has to answer that way.
    getInbox: async () => {
      throw new ChatwootApiError(404, "GET /inboxes/94");
    },
    listInboxes: async () => [],
    setInboxAgentBot: async () => ({}),
    listAgentBots: async () => [],
    createAgentBot: async () => ({
      id: 901,
      access_token: "bot-token",
      secret: "bot-secret",
    }),
    updateAgentBot: async () => ({}),
  }) as unknown as ChatwootClient;

const management = await import("@/modules/chatwoot/management");
// COPIES taken before the mocks are installed: Bun updates the imported namespace in place, so a
// wrapper that called the module by name would call itself.
const real = { ...management };

mock.module("@/modules/chatwoot/management", () => ({
  ...real,
  connectChatwootDeployment: mock(
    (
      ctx: TenantContext,
      input: Parameters<typeof management.connectChatwootDeployment>[1],
    ) => real.connectChatwootDeployment(ctx, input, { fetchProfile }, app),
  ),
  rotateChatwootDeploymentToken: mock((ctx: TenantContext, token: string) =>
    real.rotateChatwootDeploymentToken(ctx, token, { fetchProfile }, app),
  ),
  disconnectChatwootDeployment: mock((ctx: TenantContext) =>
    real.disconnectChatwootDeployment(ctx, app),
  ),
  setConnectedAccounts: mock((ctx: TenantContext, ids: number[]) =>
    real.setConnectedAccounts(ctx, ids, { fetchProfile, makeClient }, app),
  ),
  softDisconnectChatwootInstance: mock((ctx: TenantContext, id: bigint) =>
    real.softDisconnectChatwootInstance(ctx, id, app),
  ),
  reconnectChatwootInstance: mock((ctx: TenantContext, id: bigint) =>
    real.reconnectChatwootInstance(ctx, id, app),
  ),
  removeChatwootInstance: mock((ctx: TenantContext, id: bigint) =>
    real.removeChatwootInstance(ctx, id, app),
  ),
  syncInboxes: mock((ctx: TenantContext, id: bigint) =>
    real.syncInboxes(ctx, id, { makeClient }, app),
  ),
  bindInbox: mock((ctx: TenantContext, id: bigint, agentId: bigint | null) =>
    real.bindInbox(ctx, id, agentId, { makeClient }, app),
  ),
  reconnectInbox: mock((ctx: TenantContext, id: bigint) =>
    real.reconnectInbox(ctx, id, { makeClient }, app),
  ),
  removeInbox: mock((ctx: TenantContext, id: bigint) =>
    real.removeInbox(ctx, id, { makeClient }, app),
  ),
  getChatwootDeployment: (ctx: TenantContext) =>
    real.getChatwootDeployment(ctx, app),
  getChatwootInstance: (ctx: TenantContext, id: bigint) =>
    real.getChatwootInstance(ctx, id, app),
  listChatwootInstances: (ctx: TenantContext) =>
    real.listChatwootInstances(ctx, app),
  listInboxes: (ctx: TenantContext) => real.listInboxes(ctx, app),
}));

const server = (await import("@/app")).default;

// TOP-LEVEL, outside the describe: an `afterAll` inside a `describe.skipIf(...)` that skips does NOT
// run, while this one does, and the wrappers are already installed for the whole worker.
afterAll(() => {
  mock.module("@/modules/chatwoot/management", () => real);
});

const ADMIN_ID = 9394n;
let tenantId = 0n;
let cookie = "";

const rows = async () =>
  (await su?.auditLog.findMany({
    where: { tenantId },
    orderBy: { id: "asc" },
  })) ?? [];

async function clearAudit() {
  await su?.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
  );
}

function req(path: string, init: RequestInit = {}): Request {
  return new BunRequest(`http://localhost/api/v1/chatwoot${path}`, {
    ...init,
    // SUPER_ADMIN on seven of the eleven routes (the deployment and account ones), so the tenant is
    // named by the header the console sends rather than by the session.
    headers: {
      "content-type": "application/json",
      cookie,
      "X-Tenant-Id": String(tenantId),
      ...init.headers,
    },
  });
}

describe.skipIf(!dbUp)("the Channels page names who wrote", () => {
  beforeAll(async () => {
    if (!su || !app) return;
    const t = await su.tenant.create({
      data: { name: "CHREST", slug: `chrest-${process.pid}` },
    });
    tenantId = t.id;
    mockFindUnique.mockImplementation(() =>
      Promise.resolve({
        id: ADMIN_ID,
        tenantId,
        email: "admin@example.com",
        passwordHash: PASSWORD_HASH,
        googleId: null,
        name: null,
        role: "SUPER_ADMIN" as const,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const token = await new SignJWT({
      userId: ADMIN_ID.toString(),
      email: "admin@example.com",
      role: "SUPER_ADMIN",
      tenantId: tenantId.toString(),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(config.jwtSecret));
    cookie = `fazerai_auth_token=${token}`;
    await clearAudit();
  });

  afterAll(async () => {
    // `dbUp`, not `su`: the probe assigns the client and only then checks the connection, so a
    // configured-but-unreachable database leaves `su` truthy while the suite skips.
    if (dbUp && su && tenantId) {
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("the whole channel journey, from the console, names the operator on every row", async () => {
    await clearAudit();

    // Connect the deployment, pick both accounts, then walk one account and one inbox through every
    // door the page offers. One test rather than eleven because the state is a chain: each route
    // needs what the one before it created, and splitting it would rebuild the chain per case.
    const connected = await server.handle(
      req("/deployment", {
        method: "POST",
        body: JSON.stringify({ baseUrl: BASE_URL, adminToken: ADMIN_TOKEN }),
      }),
    );
    expect(connected.status).toBe(200);

    const rotated = await server.handle(
      req("/deployment", {
        method: "PATCH",
        body: JSON.stringify({ adminToken: `${ADMIN_TOKEN}-2` }),
      }),
    );
    expect(rotated.status).toBe(200);

    const chose = await server.handle(
      req("/deployment/accounts", {
        method: "PUT",
        body: JSON.stringify({ accountIds: [1, 2] }),
      }),
    );
    expect(chose.status).toBe(200);

    const instance = await su?.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 2 },
      select: { id: true, accountName: true },
    });
    const instanceId = String(instance?.id);

    expect(
      (
        await server.handle(
          req(`/instances/${instanceId}`, { method: "DELETE" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await server.handle(
          req(`/instances/${instanceId}/reconnect`, { method: "POST" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await server.handle(
          req(`/instances/${instanceId}/sync-inboxes`, { method: "POST" }),
        )
      ).status,
    ).toBe(200);

    const agent = await su?.agent.create({
      data: { tenantId, name: "Atendente", systemPrompt: "x" },
      select: { id: true },
    });
    const inbox = await su?.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instance?.id ?? 0n,
        chatwootInboxId: 94,
        name: "WhatsApp",
      },
      select: { id: true },
    });
    const inboxId = String(inbox?.id);

    expect(
      (
        await server.handle(
          req(`/inboxes/${inboxId}`, {
            method: "PATCH",
            body: JSON.stringify({ agentId: String(agent?.id) }),
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await server.handle(
          req(`/inboxes/${inboxId}/reconnect`, { method: "POST" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await server.handle(req(`/inboxes/${inboxId}`, { method: "DELETE" })))
        .status,
    ).toBe(200);
    expect(
      (
        await server.handle(
          req(`/instances/${instanceId}/remove`, {
            method: "POST",
            body: JSON.stringify({
              confirmName: instance?.accountName ?? "2",
              password: PASSWORD,
            }),
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await server.handle(
          req("/deployment", {
            method: "DELETE",
            body: JSON.stringify({
              confirmDomain: "203.0.113.94",
              password: PASSWORD,
            }),
          }),
        )
      ).status,
    ).toBe(200);

    const r = await rows();
    // Every action the journey performed, in order. Choosing the accounts connects two and syncs
    // each, and both of those are changes of their own: the pair repeats before the choice's row.
    expect(r.map((x) => x.action)).toEqual([
      "deployment.connect",
      "deployment.rotate_token",
      "instance.connect",
      "instance.sync_inboxes",
      "instance.connect",
      "instance.sync_inboxes",
      "deployment.set_accounts",
      "instance.disconnect",
      "instance.reconnect",
      "instance.sync_inboxes",
      "inbox.bind",
      "inbox.reconnect",
      "inbox.remove",
      "instance.remove",
      "deployment.disconnect",
    ]);
    // The door is a browser session, so every row is attributed to one, and to the operator behind
    // it. This is the half no transport-written row could have covered for the console.
    expect(r.every((x) => x.actorType === "user")).toBe(true);
    expect(r.every((x) => x.actorId === ADMIN_ID)).toBe(true);
    expect(r.every((x) => x.tenantId === tenantId)).toBe(true);
    // And the fence again, on the transport's side: the console hands the raw admin token to the
    // connect and the rotate, and neither may put it on a row.
    const dumped = JSON.stringify(r, (_k, v) =>
      typeof v === "bigint" ? String(v) : v,
    );
    expect(dumped).not.toContain(ADMIN_TOKEN);
  });

  test("connecting with no session is refused before anything is recorded", async () => {
    await clearAudit();
    const res = await server.handle(
      new BunRequest("http://localhost/api/v1/chatwoot/deployment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: BASE_URL, adminToken: ADMIN_TOKEN }),
      }),
    );
    expect(res.status).toBe(401);
    expect(await rows()).toEqual([]);
  });
});
