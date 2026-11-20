import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { requestContext } from "@/api/lib/i18n";
import { type MetricsReads, newMetricsReads } from "@/api/lib/metrics-reads";
import config from "@/config";
import { MetricsTooSlowError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { runMetricsScoped } from "@/modules/analytics/budget";
import { dbProbeFailed } from "@/tests/db-gate";
import { until } from "@/tests/utils/poll";

// WHAT A METRICS READ REPORTS ABOUT ITSELF: how long it waited for a connection of its pool and how
// long its statements ran, added to the request's tally that the request's log line prints. Measured
// on a pool of ONE connection held by another transaction, which is the queue a page opening forms on
// the metrics pool.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let one: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    one = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 1 }),
    });
    await one.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
const pool = one as PrismaClient;

let tenantId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// Runs `fn` as a request that arrived at `startedAt` would, with its own tally.
async function asRequest<T>(
  startedAt: number,
  fn: () => Promise<T>,
): Promise<{ result: T | Error; tally: MetricsReads }> {
  const tally = newMetricsReads();
  const result = await requestContext
    .run({ locale: "en", startedAt, metrics: tally }, fn)
    .catch((e: Error) => e);
  return { result, tally };
}

// Holds the pool's only connection for `ms`, and resolves its `taken` once the connection is held.
function hold(ms: number): { done: Promise<unknown>; taken: Promise<unknown> } {
  let held = false;
  const done = pool.$transaction(
    async (tx) => {
      held = true;
      return tx.$queryRaw(
        Prisma.sql`SELECT 1 AS one FROM pg_sleep(${ms / 1000})`,
      );
    },
    { timeout: ms + 5_000, maxWait: 5_000 },
  );
  return { done, taken: until("the held connection", () => held) };
}

beforeAll(async () => {
  if (!dbUp) return;
  tenantId = (
    await suDb.tenant.create({
      data: { name: "bt", slug: `budget-timing-${process.pid}` },
    })
  ).id;
});

afterAll(async () => {
  if (dbUp && tenantId) await suDb.tenant.delete({ where: { id: tenantId } });
  await su?.$disconnect();
  await one?.$disconnect();
});

describe.skipIf(!dbUp)("a metrics read's own timings", () => {
  test("a read behind a held connection reports the wait apart from the run", async () => {
    const held = hold(600);
    await held.taken;
    const { result, tally } = await asRequest(Date.now(), () =>
      runMetricsScoped(pool, ctx(), (db) =>
        db.$queryRaw(Prisma.sql`SELECT 1 AS one FROM pg_sleep(0.2)`),
      ),
    );
    await held.done;
    expect(result).not.toBeInstanceOf(Error);
    expect(tally.reads).toBe(1);
    expect(tally.waitMs).toBeGreaterThanOrEqual(400);
    expect(tally.runMs).toBeGreaterThanOrEqual(180);
    expect(tally.runMs).toBeLessThan(tally.waitMs);
  });

  test("two reads of one request add up", async () => {
    const { tally } = await asRequest(Date.now(), async () => {
      await runMetricsScoped(pool, ctx(), (db) =>
        db.$queryRaw(Prisma.sql`SELECT 1 AS one FROM pg_sleep(0.1)`),
      );
      await runMetricsScoped(pool, ctx(), (db) =>
        db.$queryRaw(Prisma.sql`SELECT 1 AS one FROM pg_sleep(0.1)`),
      );
    });
    expect(tally.reads).toBe(2);
    expect(tally.runMs).toBeGreaterThanOrEqual(190);
  });

  test("a read the budget refused while it waited still reports the wait", async () => {
    const held = hold(1_500);
    await held.taken;
    // Arrived long enough ago that 300 ms of budget are left.
    const startedAt = Date.now() - config.metrics.timeoutMs + 300;
    const { result, tally } = await asRequest(startedAt, () =>
      runMetricsScoped(pool, ctx(), (db) => db.$queryRaw`SELECT 1`),
    );
    await held.done;
    expect(result).toBeInstanceOf(MetricsTooSlowError);
    expect(tally.reads).toBe(1);
    expect(tally.waitMs).toBeGreaterThanOrEqual(250);
    expect(tally.runMs).toBe(0);
  });

  test("a read retried after running out of shared memory reports the retry's own wait", async () => {
    // The first attempt runs 100 ms and fails with 53100. While it holds the pool's only connection,
    // another transaction queues for it, so the retry waits behind that one for its 500 ms.
    let held: ReturnType<typeof hold> | undefined;
    let attempts = 0;
    const { result, tally } = await asRequest(Date.now(), () =>
      runMetricsScoped(pool, ctx(), async (db) => {
        attempts += 1;
        if (attempts === 1) {
          held = hold(500);
          await db.$queryRaw(Prisma.sql`SELECT 1 AS one FROM pg_sleep(0.1)`);
          throw Object.assign(
            new Error("could not resize shared memory segment"),
            {
              originalCode: "53100",
            },
          );
        }
        return db.$queryRaw(Prisma.sql`SELECT 1 AS one FROM pg_sleep(0.1)`);
      }),
    );
    await held?.done;
    expect(result).not.toBeInstanceOf(Error);
    expect(attempts).toBe(2);
    expect(tally.reads).toBe(1);
    expect(tally.waitMs).toBeGreaterThanOrEqual(400);
    expect(tally.runMs).toBeGreaterThanOrEqual(180);
    expect(tally.runMs).toBeLessThan(400);
  });

  test("a read asked for after its request's budget was spent counts as a read that ran nothing", async () => {
    const startedAt = Date.now() - config.metrics.timeoutMs - 10;
    const { result, tally } = await asRequest(startedAt, () =>
      runMetricsScoped(pool, ctx(), (db) => db.$queryRaw`SELECT 1`),
    );
    expect(result).toBeInstanceOf(MetricsTooSlowError);
    expect(tally).toEqual({ reads: 1, waitMs: 0, runMs: 0 });
  });

  test("outside a request a read runs as before and reports to no one", async () => {
    const rows = await runMetricsScoped(
      pool,
      ctx(),
      (db) => db.$queryRaw<{ one: number }[]>`SELECT 1 AS one`,
    );
    expect(rows).toEqual([{ one: 1 }]);
  });
});
