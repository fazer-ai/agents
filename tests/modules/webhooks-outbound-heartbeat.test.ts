import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import type { ClaimedJob } from "@/modules/scheduler/service";
import {
  heartbeatHandler,
  syncTenantHeartbeat,
} from "@/modules/webhooks/outbound/heartbeat";
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
} from "@/modules/webhooks/outbound/subscriptions";
import { outboundUrl } from "../utils/outbound";

// Heartbeat emitter: the per-tenant HEARTBEAT SchedulerJob is armed lazily by subscription mutations
// (syncTenantHeartbeat) and self-terminates when no enabled `heartbeat` subscription remains. The
// invariant under test: 0 subs → no active job, 1..N subs → exactly ONE job row per tenant.

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
const suDb = su as PrismaClient;
let tenantId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// Active (runnable) heartbeat jobs for the tenant — a cancelled one is DONE, not runnable.
function pendingHeartbeatJobs(): Promise<number> {
  return suDb.schedulerJob.count({
    where: { tenantId, kind: "HEARTBEAT", status: "PENDING" },
  });
}
// Total HEARTBEAT rows (the unique(tenant, kind, dedupeKey) constraint caps this at 1).
function heartbeatJobRows(): Promise<number> {
  return suDb.schedulerJob.count({ where: { tenantId, kind: "HEARTBEAT" } });
}
function claimedJob(): ClaimedJob {
  return {
    id: 0n,
    tenantId,
    kind: "HEARTBEAT",
    payload: {},
    attempts: 0,
    claimSeq: 0,
  };
}
async function clearTenantWebhookState(): Promise<void> {
  await suDb.$executeRawUnsafe(
    `DELETE FROM outbound_webhook_deliveries WHERE tenant_id = ${tenantId}`,
  );
  await suDb.$executeRawUnsafe(
    `DELETE FROM webhook_subscriptions WHERE tenant_id = ${tenantId}`,
  );
  await suDb.$executeRawUnsafe(
    `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId} AND kind = 'HEARTBEAT'`,
  );
}

describe.skipIf(!dbUp)("heartbeat emitter", () => {
  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "HB", slug: `hb-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (su && tenantId) {
      await su.$executeRawUnsafe(
        `DELETE FROM outbound_webhook_deliveries WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM webhook_subscriptions WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("subscribing arms exactly one job; a 2nd heartbeat sub keeps it at one (X = 1 job)", async () => {
    await clearTenantWebhookState();
    expect(await pendingHeartbeatJobs()).toBe(0);

    await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/hb1"), events: ["heartbeat"] },
      appDb,
    );
    expect(await pendingHeartbeatJobs()).toBe(1);

    await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/hb2"), events: ["heartbeat"] },
      appDb,
    );
    // Still exactly one job row (and it is active) despite two subscriptions.
    expect(await heartbeatJobRows()).toBe(1);
    expect(await pendingHeartbeatJobs()).toBe(1);
  });

  test("a non-heartbeat subscription arms nothing (0 subs → 0 jobs)", async () => {
    await clearTenantWebhookState();
    await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/other"), events: ["conversation.created"] },
      appDb,
    );
    expect(await pendingHeartbeatJobs()).toBe(0);
  });

  test("the handler emits one delivery per enabled sub and re-arms", async () => {
    await clearTenantWebhookState();
    await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/hb1"), events: ["heartbeat"] },
      appDb,
    );
    await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/hb2"), events: ["heartbeat", "llm.usage"] },
      appDb,
    );

    const result = await heartbeatHandler(claimedJob(), appDb);
    expect(result.outcome).toBe("reschedule");

    const deliveries = await suDb.outboundWebhookDelivery.findMany({
      where: { tenantId, event: "heartbeat" },
      select: { status: true, payload: true },
    });
    expect(deliveries.length).toBe(2);
    expect(deliveries.every((d) => d.status === "PENDING")).toBe(true);
    const env = deliveries[0]?.payload as { event: string; data: unknown };
    expect(env.event).toBe("heartbeat");
    expect(env.data).toMatchObject({ at: expect.any(String) });
  });

  test("removing the last heartbeat sub cancels the job; handler then ends it (0 subs → no job)", async () => {
    await clearTenantWebhookState();
    const sub = await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/hb1"), events: ["heartbeat"] },
      appDb,
    );
    expect(await pendingHeartbeatJobs()).toBe(1);

    await deleteWebhookSubscription(ctx(), BigInt(sub.id), appDb);
    // syncTenantHeartbeat cancelled the pending job (it is DONE, not runnable).
    expect(await pendingHeartbeatJobs()).toBe(0);

    // Backstop: even if a CLAIMED job slipped through, the handler self-terminates with no subs.
    const result = await heartbeatHandler(claimedJob(), appDb);
    expect(result.outcome).toBe("done");
  });

  test("disabling the only heartbeat sub cancels the job", async () => {
    await clearTenantWebhookState();
    await createWebhookSubscription(
      ctx(),
      { url: outboundUrl("/hb1"), events: ["heartbeat"] },
      appDb,
    );
    expect(await pendingHeartbeatJobs()).toBe(1);

    // Re-arm test path: syncTenantHeartbeat cancels because no ENABLED heartbeat sub remains.
    await suDb.$executeRawUnsafe(
      `UPDATE webhook_subscriptions SET enabled = false WHERE tenant_id = ${tenantId}`,
    );
    await syncTenantHeartbeat(tenantId, appDb);
    expect(await pendingHeartbeatJobs()).toBe(0);
  });
});
