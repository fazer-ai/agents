import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { processAlertBatch } from "@/modules/flowlog/alert-worker";
import { createAlertChannel } from "@/modules/flowlog/channels";
import { outboundUrl } from "../utils/outbound";

// Alert worker: claim → deliver/retry/dead, and the coalesce window. The claim is cross-tenant, so
// each test asserts ITS OWN delivery row by id (a default-204 fetch makes any co-claimed row a
// harmless success) and branches the injected fetch/assertSafe on the channel URL.

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
function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}
const ok204 = (() =>
  new Response(null, { status: 204 })) as unknown as typeof fetch;

// NOTE: `created_at` is stamped by the CLIENT, not by the column default. Prisma sends a value for
// `@default(now())` on every insert, so the DEFAULT CURRENT_TIMESTAMP in the migration never fires,
// and the claim then compares that host timestamp against Postgres `now()`. Two clocks.
//
// Production absorbs the difference in the 30s coalesce window. A test that passes
// `coalesceWindowMs: 0` strips all of it and is left with the few milliseconds between the insert
// and the claim: measured here, 4ms. A row stamped even 50ms ahead of the database is invisible to
// `created_at <= now()`, so the claim comes back empty and the test fails on `claimed >= 1` having
// nothing to do with the code under test. The Docker VM hosting Postgres locally drifts after the
// Mac sleeps, which is how a whole run turns red and then heals on its own. Injecting a 500ms
// host-ahead skew reproduces it exactly: all three due tests fail, and none of them do once the
// stamp comes from the database.
//
// So every delivery is stamped from the database's own clock, and the coalesce window each test
// passes is what decides due or fresh. `now()` in an earlier transaction is by construction at or
// before `now()` in the claim's, so there is no margin to tune and no assumption about how far the
// two clocks are apart.
async function makeDelivery(channelId: bigint): Promise<bigint> {
  const [stamp] = await suDb.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  const row = await suDb.alertDelivery.create({
    data: {
      tenantId,
      channelId,
      stage: "generate",
      level: "error",
      summary: "boom",
      createdAt: (stamp as { now: Date }).now,
    },
  });
  return row.id;
}

describe.skipIf(!dbUp)("alert worker", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "FlowW", slug: `flow-w-${process.pid}` },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const tbl of ["alert_deliveries", "alert_channels"]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("delivers a due delivery (2xx) and marks it DELIVERED", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      {
        name: "ok",
        type: "discord",
        url: outboundUrl("/api/webhooks/ok"),
      },
      appDb,
    );
    const id = await makeDelivery(BigInt(ch.id));
    const batch = await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      fetchImpl: ok204,
      now: () => Date.now(),
    });
    // NOTE: assert the CLAIM before the outcome. Every observed flake in this file has been the row
    // not being picked up at all, and `status is PENDING, expected DELIVERED` does not say whether
    // the claim missed it or the delivery failed — checking the summary first names the cause.
    // Lower-bound, not exact: the claim is allowed to sweep up a sibling test's retry row (see the
    // note at the top of the file), so pinning it to 1 would trade one flake for another.
    expect(batch.claimed).toBeGreaterThanOrEqual(1);
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("DELIVERED");
    expect(row?.attempts).toBe(1);
  });

  test("retries on a non-2xx response (back to PENDING with a next attempt)", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      {
        name: "retry",
        type: "webhook",
        url: outboundUrl("/retry"),
      },
      appDb,
    );
    const id = await makeDelivery(BigInt(ch.id));
    const fetchImpl = (async (url: string) =>
      new Response(null, {
        status: url.includes("/retry") ? 500 : 204,
      })) as unknown as typeof fetch;
    const batch = await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      fetchImpl,
      now: () => Date.now(),
    });
    expect(batch.claimed).toBeGreaterThanOrEqual(1);
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("PENDING");
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).not.toBeNull();
  });

  test("a blocked (SSRF) URL goes straight to DEAD", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      {
        name: "dead",
        type: "webhook",
        url: outboundUrl("/blocked"),
      },
      appDb,
    );
    const id = await makeDelivery(BigInt(ch.id));
    const assertSafe = async (url: string) => {
      if (url.includes("/blocked")) throw new Error("ssrf blocked");
      return new URL(url);
    };
    const batch = await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      fetchImpl: ok204,
      assertSafe,
      now: () => Date.now(),
    });
    expect(batch.claimed).toBeGreaterThanOrEqual(1);
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("DEAD");
  });

  test("a fresh delivery within the coalesce window is NOT claimed", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      {
        name: "window",
        type: "discord",
        url: outboundUrl("/api/webhooks/window"),
      },
      appDb,
    );
    const id = await makeDelivery(BigInt(ch.id));
    await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 60_000, // a just-created row is younger than the window → skipped
      fetchImpl: ok204,
      now: () => Date.now(),
    });
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("PENDING");
    expect(row?.attempts).toBe(0);
  });

  // The three below cover claim predicates that mutation found unguarded: removing each one left the
  // WHOLE suite green. They assert on their OWN row rather than on `claimed`, because the claim is a
  // batch and a sibling test's row may ride along (see the note at the top of the file).

  // Disabling a channel is the operator's off switch. With `c2.enabled` dropped from the claim, a
  // channel switched off keeps receiving alerts, and the only thing that told them it was off was
  // the UI.
  test("a delivery on a DISABLED channel is not claimed", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      { name: "off", type: "webhook", url: outboundUrl("/off") },
      appDb,
    );
    await suDb.alertChannel.update({
      where: { id: BigInt(ch.id) },
      data: { enabled: false },
    });
    const id = await makeDelivery(BigInt(ch.id));
    await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      fetchImpl: ok204,
      now: () => Date.now(),
    });
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("PENDING");
    expect(row?.attempts).toBe(0);
  });

  // Without the PENDING filter the claim sweeps up terminal rows, so every tick re-posts alerts that
  // already went out and ones that were given up on. The customer's endpoint sees duplicates forever.
  test("a terminal delivery is never claimed again", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      { name: "terminal", type: "webhook", url: outboundUrl("/terminal") },
      appDb,
    );
    const delivered = await makeDelivery(BigInt(ch.id));
    const dead = await makeDelivery(BigInt(ch.id));
    await suDb.alertDelivery.update({
      where: { id: delivered },
      data: { status: "DELIVERED", attempts: 1 },
    });
    await suDb.alertDelivery.update({
      where: { id: dead },
      data: { status: "DEAD", attempts: 5 },
    });
    // Only this test's URL is counted. The claim is a batch and a sibling's row can ride along (a
    // retry whose backoff came due mid-file did exactly that, 1 run in 20), so a global counter
    // would assert on other tests' traffic.
    let posts = 0;
    const counting = (async (url: string) => {
      if (url.includes("/terminal")) posts += 1;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      fetchImpl: counting,
      now: () => Date.now(),
    });
    expect(posts).toBe(0);
    const after = await suDb.alertDelivery.findMany({
      where: { id: { in: [delivered, dead] } },
      orderBy: { id: "asc" },
    });
    expect(after.map((r) => [r.status, r.attempts])).toEqual([
      ["DELIVERED", 1],
      ["DEAD", 5],
    ]);
  });

  // A retry carries `next_attempt_at`, and the backoff is the whole point of it. With the due check
  // dropped, the very next tick claims it, so a failing endpoint is retried at tick speed instead of
  // backing off. Stamped from the database clock for the same reason every other row here is.
  test("a retry scheduled for the future is not claimed before it is due", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      { name: "backoff", type: "webhook", url: outboundUrl("/backoff") },
      appDb,
    );
    const id = await makeDelivery(BigInt(ch.id));
    const [future] = await suDb.$queryRaw<
      { at: Date }[]
    >`SELECT now() + interval '1 hour' AS at`;
    await suDb.alertDelivery.update({
      where: { id },
      data: { attempts: 1, nextAttemptAt: (future as { at: Date }).at },
    });
    await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      fetchImpl: ok204,
      now: () => Date.now(),
    });
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("PENDING");
    expect(row?.attempts).toBe(1);
  });
});
