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
let otherTenantId = 0n;
// Every tenant this file creates, so afterAll takes them all down. A test that asserts on WHICH rows
// a batch picked needs a tenant nobody else wrote to: the claim is a batch, and a sibling's leftover
// row occupies a slot. That has bitten this file twice.
const tenants: bigint[] = [];
let tenantSeq = 0;
async function newTenant(): Promise<bigint> {
  tenantSeq += 1;
  const t = (
    await suDb.tenant.create({
      data: { name: "FlowW", slug: `flow-w-${process.pid}-${tenantSeq}` },
    })
  ).id;
  tenants.push(t);
  return t;
}
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
async function makeDeliveryFor(
  tenant: bigint,
  channelId: bigint,
): Promise<bigint> {
  const [stamp] = await suDb.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  const row = await suDb.alertDelivery.create({
    data: {
      tenantId: tenant,
      channelId,
      stage: "generate",
      level: "error",
      summary: "boom",
      createdAt: (stamp as { now: Date }).now,
    },
  });
  return row.id;
}

// `updated_at` carries `@updatedAt`, so Prisma overwrites any value handed to `update`. Raw SQL is
// the only way to put a row's clock where a test needs it. Unlike `created_at` above, this one stays
// on the HOST clock on purpose: the reap builds its cutoff from the injected `now()`, so both sides
// of that comparison are host timestamps and crossing them with the database's would reintroduce
// exactly the skew this file just removed.
async function setSending(id: bigint, updatedAt: Date): Promise<void> {
  await suDb.$executeRaw`
    UPDATE alert_deliveries
       SET status = 'SENDING', updated_at = ${updatedAt}
     WHERE id = ${id}`;
}

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
    tenantId = await newTenant();
    // A neighbour, only ever used to prove the worker does not reach across the tenant boundary.
    otherTenantId = await newTenant();
  });

  afterAll(async () => {
    for (const t of tenants) {
      if (!t) continue;
      for (const tbl of ["alert_deliveries", "alert_channels"]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${t}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${t}`);
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
    const t = Date.now();
    // NOTE: the backoff is FULL jitter, `floor(random() * 2000)` on the first retry, so 0 is a
    // legitimate draw about 1 run in 2000 and asserting `> t` against a live `Math.random` would be
    // a flake of exactly the kind this file is being cleaned of. Full jitter is the documented
    // algorithm and an immediate retry is a valid outcome of it (the tick interval absorbs one), so
    // the draw is pinned here rather than a floor being added to production for a test's benefit.
    const realRandom = Math.random;
    Math.random = () => 0.5;
    let batch: Awaited<ReturnType<typeof processAlertBatch>>;
    try {
      batch = await processAlertBatch({
        base: appDb,
        tenantId,
        coalesceWindowMs: 0,
        fetchImpl,
        now: () => t,
      });
    } finally {
      Math.random = realRandom;
    }
    expect(batch.claimed).toBeGreaterThanOrEqual(1);
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("PENDING");
    expect(row?.attempts).toBe(1);
    // Strictly AFTER the tick's own clock, not merely set: a zeroed backoff still writes a
    // timestamp, and `not.toBeNull()` accepted it. Backing off is the point of scheduling a retry,
    // and without a floor the endpoint that just failed is hit again on the very next tick.
    expect(row?.nextAttemptAt?.getTime()).toBeGreaterThan(t);
  });

  // Issue #243. The transport error's own message is what lands in `last_error`, a `text` column
  // that refuses a NUL outright, and the refusal takes the whole retry write with it: the row keeps
  // its SENDING claim and its attempt count, so nothing re-drives it and nothing dead-letters it.
  test("retries a transport failure whose message carries a NUL", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      { name: "nul", type: "webhook", url: outboundUrl("/nul") },
      appDb,
    );
    const id = await makeDelivery(BigInt(ch.id));
    const fetchImpl = (async () => {
      throw new Error(`socket hang up ${String.fromCharCode(0)} (ECONNRESET)`);
    }) as unknown as typeof fetch;
    await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      fetchImpl,
      assertSafe: async (u: string) => new URL(u),
    });
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("PENDING");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain("socket hang up");
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

  // The reap exists because a worker can die mid-delivery and strand a row in SENDING forever. Its
  // whole safety rests on the staleness cutoff: without it the reap resets rows a LIVE worker is
  // delivering right now, which hands the same alert to the claim again and the customer's endpoint
  // is posted to twice. Both sides of the cutoff are asserted, because a reap that never fires is
  // just as wrong as one that fires too eagerly, and only asserting one side leaves the other free.
  test("the reap leaves a SENDING row that is still fresh alone", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      { name: "inflight", type: "webhook", url: outboundUrl("/inflight") },
      appDb,
    );
    const id = await makeDelivery(BigInt(ch.id));
    const t = Date.now();
    await setSending(id, new Date(t - 1_000));
    const batch = await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      staleMs: 60_000,
      fetchImpl: ok204,
      now: () => t,
    });
    expect(batch.reaped).toBe(0);
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("SENDING");
  });

  test("the reap returns a SENDING row stranded past the cutoff to PENDING", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      { name: "stranded", type: "webhook", url: outboundUrl("/stranded") },
      appDb,
    );
    const id = await makeDelivery(BigInt(ch.id));
    const t = Date.now();
    await setSending(id, new Date(t - 120_000));
    await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      staleMs: 60_000,
      fetchImpl: ok204,
      now: () => t,
    });
    // Reaped and then delivered in the same tick, which is the point of reaping it.
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("DELIVERED");
  });

  // The reap's own status filter. Without it the update matches any row past the cutoff and drags
  // DEAD ones back to PENDING, so a delivery that was given up on starts being attempted again.
  test("the reap does not resurrect a DEAD row past the cutoff", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      { name: "buried", type: "webhook", url: outboundUrl("/buried") },
      appDb,
    );
    const id = await makeDelivery(BigInt(ch.id));
    const t = Date.now();
    await suDb.$executeRaw`
      UPDATE alert_deliveries
         SET status = 'DEAD', attempts = 8, updated_at = ${new Date(t - 120_000)}
       WHERE id = ${id}`;
    await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      staleMs: 60_000,
      fetchImpl: ok204,
      now: () => t,
    });
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("DEAD");
    expect(row?.attempts).toBe(8);
  });

  // `tenantId` is the test-only scope that keeps concurrent runs on the shared test DB off each
  // other's rows, and it guards the claim AND the reap. Dropped from either, this neighbour's rows
  // move: the due one gets delivered, the stranded one gets reaped. Both are asserted here because
  // the two call sites carry the scope separately and one can be lost without the other.
  test("neither the claim nor the reap crosses the tenant boundary", async () => {
    const ch = await createAlertChannel(
      ctx(otherTenantId),
      { name: "neighbour", type: "webhook", url: outboundUrl("/neighbour") },
      appDb,
    );
    const due = await makeDeliveryFor(otherTenantId, BigInt(ch.id));
    const stranded = await makeDeliveryFor(otherTenantId, BigInt(ch.id));
    const t = Date.now();
    await setSending(stranded, new Date(t - 120_000));
    let posts = 0;
    const counting = (async (url: string) => {
      if (url.includes("/neighbour")) posts += 1;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      staleMs: 60_000,
      fetchImpl: counting,
      now: () => t,
    });
    expect(posts).toBe(0);
    const after = await suDb.alertDelivery.findMany({
      where: { id: { in: [due, stranded] } },
      orderBy: { id: "asc" },
    });
    expect(after.map((r) => r.status)).toEqual(["PENDING", "SENDING"]);
  });

  // MAX_ATTEMPTS is what stops a permanently broken endpoint being retried forever. The row on its
  // last attempt must go DEAD rather than back to PENDING: PENDING would schedule yet another try,
  // and nothing else in the worker ever ends the cycle.
  test("the last allowed attempt ends in DEAD, not another retry", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      { name: "exhausted", type: "webhook", url: outboundUrl("/exhausted") },
      appDb,
    );
    const id = await makeDelivery(BigInt(ch.id));
    await suDb.alertDelivery.update({
      where: { id },
      data: { attempts: 7 }, // MAX_ATTEMPTS is 8, so this delivery is the last one
    });
    const failing = (async (url: string) =>
      new Response(null, {
        status: url.includes("/exhausted") ? 500 : 204,
      })) as unknown as typeof fetch;
    await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      fetchImpl: failing,
      now: () => Date.now(),
    });
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("DEAD");
    expect(row?.attempts).toBe(8);
    expect(row?.nextAttemptAt).toBeNull();
  });

  // `ORDER BY next_attempt_at NULLS FIRST` is a deliberate priority, not a default: NULLS LAST is
  // what an ASC sort does on its own, so someone chose to put FRESH deliveries (no next_attempt_at)
  // ahead of retries. It only shows when the batch cannot take everything, so the limit is squeezed
  // to make that the case. Its own tenant, because the claim is a batch and a sibling row would
  // occupy one of the two slots being asserted.
  test("a full batch takes fresh deliveries before retries", async () => {
    const own = await newTenant();
    const ch = await createAlertChannel(
      ctx(own),
      { name: "priority", type: "webhook", url: outboundUrl("/priority") },
      appDb,
    );
    const retry = await makeDeliveryFor(own, BigInt(ch.id));
    const [past] = await suDb.$queryRaw<
      { at: Date }[]
    >`SELECT now() - interval '1 hour' AS at`;
    await suDb.alertDelivery.update({
      where: { id: retry },
      data: { attempts: 1, nextAttemptAt: (past as { at: Date }).at },
    });
    const fresh = await makeDeliveryFor(own, BigInt(ch.id));
    await processAlertBatch({
      base: appDb,
      tenantId: own,
      coalesceWindowMs: 0,
      claimLimit: 1,
      fetchImpl: ok204,
      now: () => Date.now(),
    });
    const after = await suDb.alertDelivery.findMany({
      where: { id: { in: [retry, fresh] } },
    });
    const byId = new Map(after.map((r) => [r.id, r.status]));
    expect(byId.get(fresh)).toBe("DELIVERED");
    expect(byId.get(retry)).toBe("PENDING");
  });
});
