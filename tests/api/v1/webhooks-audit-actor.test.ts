import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { outboundUrl } from "@/tests/utils/outbound";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// The webhook and alert-channel trail, driven through real requests to the console's own doors.
//
// `tests/modules/audit-webhook-family.test.ts` proves the SERVICES record. It cannot see the half
// issue #397 is actually about: whether the REST routes reach those services with a principal at
// all. `webhooks.controller.ts` and `alert-channels.controller.ts` never mentioned `audit`, and a
// row can only name who wrote it if the transport hands the context down.
//
// The services are WRAPPED and the wrappers call through, for the reason `mock.module` always
// demands here: it is global to the process and outlives this file for every other one in the same
// worker, so a stub that swallowed the real behaviour would turn somebody else's file green for the
// wrong reason. All a wrapper does is record the context it was handed and give the write the test
// database, which the controller has no way to inject.

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

const subs = await import("@/modules/webhooks/outbound/subscriptions");
const deliveries = await import("@/modules/webhooks/outbound/deliveries");
const channels = await import("@/modules/flowlog/channels");
// COPIES taken before the mocks are installed: Bun updates the imported namespace in place, so a
// wrapper that called the module by name would call itself.
const realSubs = { ...subs };
const realDeliveries = { ...deliveries };
const realChannels = { ...channels };

const seen: TenantContext[] = [];
function watch<A extends unknown[], R>(
  fn: (ctx: TenantContext, ...rest: A) => R,
) {
  return mock((ctx: TenantContext, ...rest: A) => {
    seen.push(ctx);
    return fn(ctx, ...rest);
  });
}

mock.module("@/modules/webhooks/outbound/subscriptions", () => ({
  ...realSubs,
  createWebhookSubscription: watch(
    (
      ctx: TenantContext,
      input: Parameters<typeof subs.createWebhookSubscription>[1],
    ) => realSubs.createWebhookSubscription(ctx, input, app),
  ),
  updateWebhookSubscription: watch(
    (
      ctx: TenantContext,
      id: bigint,
      patch: Parameters<typeof subs.updateWebhookSubscription>[2],
    ) => realSubs.updateWebhookSubscription(ctx, id, patch, app),
  ),
  deleteWebhookSubscription: watch((ctx: TenantContext, id: bigint) =>
    realSubs.deleteWebhookSubscription(ctx, id, app),
  ),
  listWebhookSubscriptions: (ctx: TenantContext) =>
    realSubs.listWebhookSubscriptions(ctx, app),
}));

mock.module("@/modules/webhooks/outbound/deliveries", () => ({
  ...realDeliveries,
  requeueWebhookDelivery: watch((ctx: TenantContext, id: bigint) =>
    realDeliveries.requeueWebhookDelivery(ctx, id, app),
  ),
}));

mock.module("@/modules/flowlog/channels", () => ({
  ...realChannels,
  createAlertChannel: watch(
    (
      ctx: TenantContext,
      input: Parameters<typeof channels.createAlertChannel>[1],
    ) => realChannels.createAlertChannel(ctx, input, app),
  ),
  updateAlertChannel: watch(
    (
      ctx: TenantContext,
      id: bigint,
      patch: Parameters<typeof channels.updateAlertChannel>[2],
    ) => realChannels.updateAlertChannel(ctx, id, patch, app),
  ),
  deleteAlertChannel: watch((ctx: TenantContext, id: bigint) =>
    realChannels.deleteAlertChannel(ctx, id, app),
  ),
  listAlertChannels: (ctx: TenantContext) =>
    realChannels.listAlertChannels(ctx, app),
}));

const server = (await import("@/app")).default;

// TOP-LEVEL, outside the describe below, and measured rather than assumed: an `afterAll` inside a
// `describe.skipIf(...)` that skips does NOT run, while this one does. `mock.module` already
// installed the wrappers globally for the whole worker by the time `dbUp` was decided, so leaving
// the restore inside would leak them into every later file in the same process.
afterAll(() => {
  mock.module("@/modules/webhooks/outbound/subscriptions", () => realSubs);
  mock.module("@/modules/webhooks/outbound/deliveries", () => realDeliveries);
  mock.module("@/modules/flowlog/channels", () => realChannels);
});

const ADMIN_ID = 9397n;
let tenantId = 0n;
let cookie = "";

const rows = async () =>
  (await su?.auditLog.findMany({
    where: { actorId: ADMIN_ID },
    orderBy: { id: "asc" },
  })) ?? [];

async function clearAudit() {
  await su?.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE actor_id = ${ADMIN_ID}`,
  );
}

function req(path: string, init: RequestInit = {}): Request {
  return new BunRequest(`http://localhost/api/v1${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...init.headers },
  });
}

describe.skipIf(!dbUp)("the webhook transports name who wrote", () => {
  beforeAll(async () => {
    if (!su || !app) return;
    const t = await su.tenant.create({
      data: { name: "WHREST", slug: `whrest-${process.pid}` },
    });
    tenantId = t.id;
    mockFindUnique.mockImplementation(() =>
      Promise.resolve({
        id: ADMIN_ID,
        tenantId,
        email: "admin@example.com",
        passwordHash: null,
        googleId: null,
        name: null,
        role: "TENANT_ADMIN" as const,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const token = await new SignJWT({
      userId: ADMIN_ID.toString(),
      email: "admin@example.com",
      role: "TENANT_ADMIN",
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
      for (const table of [
        "audit_logs",
        "outbound_webhook_deliveries",
        "webhook_subscriptions",
        "alert_channels",
        "scheduler_jobs",
      ]) {
        await su.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a POST with no session is refused before reaching the service", async () => {
    seen.length = 0;
    await clearAudit();
    const res = await server.handle(
      new BunRequest("http://localhost/api/v1/webhooks/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: outboundUrl("/nope"),
          events: ["conversation.created"],
        }),
      }),
    );
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  test("the console's own subscription doors each leave a row that names the operator", async () => {
    seen.length = 0;
    await clearAudit();

    const created = await server.handle(
      req("/webhooks/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          url: outboundUrl("/rest"),
          events: ["conversation.created"],
        }),
      }),
    );
    expect(created.status).toBe(200);
    const id = ((await created.json()) as { subscription: { id: string } })
      .subscription.id;

    // The toggle the Webhooks page sends, and the only PATCH it has.
    const patched = await server.handle(
      req(`/webhooks/subscriptions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(patched.status).toBe(200);

    const deleted = await server.handle(
      req(`/webhooks/subscriptions/${id}`, { method: "DELETE" }),
    );
    expect(deleted.status).toBe(200);

    // The context each route handed down, which is where every row's actor comes from.
    expect(seen.length).toBe(3);
    for (const ctx of seen) {
      expect(ctx.userId).toBe(ADMIN_ID);
      expect(ctx.tenantId).toBe(tenantId);
    }
    const got = await rows();
    expect(got.map((r) => r.action)).toEqual([
      "webhook.create",
      "webhook.update",
      "webhook.delete",
    ]);
    for (const row of got) {
      expect(row.target).toBe(`webhook:${id}`);
      // A browser session, not the MCP transport: `actorType` is the only field that says the door.
      expect(row.actorType).toBe("user");
    }
    expect(got[1]?.before).toMatchObject({ enabled: true });
    expect(got[1]?.after).toMatchObject({ enabled: false });
  });

  test("requeueing a dead delivery from the console leaves a row", async () => {
    seen.length = 0;
    const sub = await realSubs.createWebhookSubscription(
      { tenantId, userId: ADMIN_ID, role: "TENANT_ADMIN" },
      { url: outboundUrl("/rest-requeue"), events: ["conversation.created"] },
      app,
    );
    const delivery = await (su as PrismaClient).outboundWebhookDelivery.create({
      data: {
        tenantId,
        subscriptionId: BigInt(sub.id),
        event: "conversation.created",
        payload: { value: 42 },
        status: "DEAD",
        attempts: 8,
      },
    });
    await clearAudit();
    const res = await server.handle(
      req(`/webhooks/deliveries/${delivery.id}/requeue`, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const [row] = await rows();
    expect(row?.action).toBe("webhook_delivery.requeue");
    expect(row?.target).toBe(`webhook_delivery:${delivery.id}`);
    expect(row?.actorType).toBe("user");
    expect(row?.before).toMatchObject({ status: "DEAD", attempts: 8 });
  });

  test("the console's own alert-channel doors each leave a row that names the operator", async () => {
    seen.length = 0;
    await clearAudit();

    const created = await server.handle(
      req("/alert-channels", {
        method: "POST",
        body: JSON.stringify({
          name: "rest ops",
          type: "discord",
          url: outboundUrl("/api/webhooks/9/RESTTOKEN"),
        }),
      }),
    );
    expect(created.status).toBe(200);
    const id = ((await created.json()) as { channel: { id: string } }).channel
      .id;

    const patched = await server.handle(
      req(`/alert-channels/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "rest renamed" }),
      }),
    );
    expect(patched.status).toBe(200);

    const deleted = await server.handle(
      req(`/alert-channels/${id}`, { method: "DELETE" }),
    );
    expect(deleted.status).toBe(200);

    expect(seen.length).toBe(3);
    const got = await rows();
    expect(got.map((r) => r.action)).toEqual([
      "alert_channel.create",
      "alert_channel.update",
      "alert_channel.delete",
    ]);
    for (const row of got) {
      expect(row.actorType).toBe("user");
      expect(row.target).toBe(`alert_channel:${id}`);
    }
    // The token the operator typed reached the column encrypted and the trail masked; a row is
    // readable by every tenant admin.
    const text = JSON.stringify(got, (_k, v) =>
      typeof v === "bigint" ? String(v) : v,
    );
    expect(text).not.toContain("RESTTOKEN");
  });
});
