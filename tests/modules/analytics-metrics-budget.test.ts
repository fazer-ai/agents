import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { metricsPoolOptions } from "@/api/lib/pool-options";
import config from "@/config";
import { postgresCodeOf } from "@/lib/pg-error";
import { runMetricsScoped } from "@/modules/analytics/budget";
import { getDashboardCosts } from "@/modules/analytics/costs";
import { getHealth } from "@/modules/analytics/health";
import { verifyApiKey } from "@/modules/api-keys/verify";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { metricsGet } from "@/modules/mcp/read";
import { until } from "@/tests/utils/poll";

// A metrics read that does not fit its time budget is refused as too slow (503, a sentence the
// console and the MCP tools show), and Postgres stops the statement, so the connection is back in
// the pool when the request answers. `LOCK TABLE llm_usage` stands in for a window too long to
// aggregate: the read waits exactly as long as the lock is held.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let app: PrismaClient | undefined;
let su: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 3 }),
    });
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
afterAll(async () => {
  await app?.$disconnect();
  await su?.$disconnect();
});

const ctx = { tenantId: 1n, role: "TENANT_ADMIN" as const, userId: 1n };
const principal: VerifiedToken = {
  userId: 1n,
  tenantId: 1n,
  role: "TENANT_ADMIN",
  scopes: ["mcp:read"],
  clientId: "c",
  jti: "j",
};

async function waitingOnUsage(): Promise<number> {
  const [row] = await (su as PrismaClient).$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE state = 'active' AND query ILIKE '%llm_usage%' AND pid <> pg_backend_pid()
       AND usename <> current_user`;
  return row?.n ?? -1;
}

// Runs `act` while llm_usage is locked, and releases the lock only once `act` has answered: an
// unbounded read never answers, and the test times out.
async function underUsageLock<T>(act: () => Promise<T>): Promise<{
  result: T;
  elapsed: number;
  left: number;
}> {
  let out: { result: T; elapsed: number; left: number } | undefined;
  await (su as PrismaClient).$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        "LOCK TABLE llm_usage IN ACCESS EXCLUSIVE MODE",
      );
      const t0 = Date.now();
      const result = await act();
      out = { result, elapsed: Date.now() - t0, left: await waitingOnUsage() };
    },
    { timeout: 20_000 },
  );
  return out as { result: T; elapsed: number; left: number };
}

function withMetricsTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const metrics = config.metrics;
  const saved = metrics.timeoutMs;
  metrics.timeoutMs = ms;
  return fn().finally(() => {
    metrics.timeoutMs = saved;
  });
}

describe.skipIf(!dbUp)("metrics time budget", () => {
  test("a read past METRICS_TIMEOUT_MS answers 503 at the budget and leaves no statement running", async () => {
    const { result, elapsed, left } = await withMetricsTimeout(500, () =>
      underUsageLock(() =>
        getDashboardCosts(ctx, {}, app as PrismaClient).catch((e) => e),
      ),
    );
    expect((result as { statusCode?: number }).statusCode).toBe(503);
    expect((result as Error).message).toContain("Try a shorter period");
    expect((result as { field?: string }).field).toBe("since");
    expect(elapsed).toBeLessThan(2_000);
    expect(left).toBe(0);
  });

  test("a read refused by the lock timeout is the same 503", async () => {
    const locking = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, lock_timeout: 300 }),
    });
    try {
      const { result, elapsed } = await withMetricsTimeout(10_000, () =>
        underUsageLock(() => getHealth(ctx, {}, locking).catch((e) => e)),
      );
      expect((result as { statusCode?: number }).statusCode).toBe(503);
      expect(elapsed).toBeLessThan(2_000);
      // The sentence states the time the read ran (about 0.3 s), not the 10 s budget it never reached.
      const seconds = (result as { translationParams?: { seconds?: number } })
        .translationParams?.seconds;
      expect(seconds).toBeGreaterThanOrEqual(0.2);
      expect(seconds).toBeLessThan(2);
      expect((result as Error).message).not.toContain("10s");
    } finally {
      await locking.$disconnect();
    }
  });

  test("the MCP metrics tool returns the refusal as a tool error", async () => {
    const { result } = await withMetricsTimeout(500, () =>
      underUsageLock(() =>
        metricsGet(principal, {}, { base: app as PrismaClient }),
      ),
    );
    expect(JSON.stringify(result)).toContain("Try a shorter period");
  });

  test("a read of several aggregates is bounded as a whole, not per aggregate", async () => {
    // Each aggregate fits the 1 s budget; together they do not. Per statement, the second would start
    // at 0.8 s with a fresh second and hold the connection to 1.6 s.
    const t0 = Date.now();
    const result = await withMetricsTimeout(1_000, () =>
      runMetricsScoped(app as PrismaClient, ctx, async (db) => {
        await db.$queryRawUnsafe("SELECT pg_sleep(0.8)::text /* mb_two */");
        await db.$queryRawUnsafe("SELECT pg_sleep(0.8)::text /* mb_two */");
        return "answered";
      }).catch((e) => e),
    );
    const elapsed = Date.now() - t0;
    expect((result as { statusCode?: number }).statusCode).toBe(503);
    expect(elapsed).toBeLessThan(1_400);
    const [row] = await (su as PrismaClient).$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE state = 'active' AND query LIKE '%mb_two%' AND pid <> pg_backend_pid()`;
    expect(row?.n).toBe(0);
  });

  test("a model aggregate gets only the time left too", async () => {
    // The raw query spends 0.8 s of the 1 s budget; the model count then waits on the lock. Bounded,
    // it is cancelled at the deadline; per statement it would wait a full second more.
    const { result, elapsed } = await withMetricsTimeout(1_000, () =>
      underUsageLock(() =>
        runMetricsScoped(app as PrismaClient, ctx, async (db) => {
          await db.$queryRawUnsafe("SELECT pg_sleep(0.8)::text");
          return db.llmUsage.count();
        }).catch((e) => e),
      ),
    );
    expect((result as { statusCode?: number }).statusCode).toBe(503);
    expect(elapsed).toBeLessThan(1_400);
  });

  test("a statement on the metrics pool outside a read, like the session lookup, is bounded too", async () => {
    const pool = await withMetricsTimeout(
      500,
      async () =>
        new PrismaClient({
          adapter: new PrismaPg(metricsPoolOptions(appUrl)),
        }),
    );
    try {
      let code: unknown;
      let waitedMs = -1;
      await (su as PrismaClient).$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            "LOCK TABLE users IN ACCESS EXCLUSIVE MODE",
          );
          const t0 = Date.now();
          code = await pool.user
            .findUnique({ where: { id: 1n }, select: { id: true } })
            .then(
              () => "answered",
              (e) => postgresCodeOf(e),
            );
          waitedMs = Date.now() - t0;
        },
        { timeout: 20_000 },
      );
      expect(code === "57014" || code === "55P03").toBe(true);
      expect(waitedMs).toBeLessThan(1_500);
    } finally {
      await pool.$disconnect();
    }
  });

  test("a SUPER_ADMIN's tenant check spends the same budget the aggregates do", async () => {
    const tenant = await (su as PrismaClient).tenant.create({
      data: { name: "mb", slug: `mb-${process.pid}-${Date.now()}` },
    });
    try {
      // The tenant check waits 0.8 s on a lock, then the aggregate would take 0.8 s more.
      const holder = (su as PrismaClient).$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            "LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE",
          );
          await tx.$queryRawUnsafe("SELECT pg_sleep(0.8)::text");
        },
        { timeout: 10_000 },
      );
      await until("tenants locked", async () => {
        const [row] = await (app as PrismaClient).$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
           WHERE c.relname = 'tenants' AND l.mode = 'AccessExclusiveLock' AND l.granted`;
        return (row?.n ?? 0) > 0 ? true : null;
      });
      const t0 = Date.now();
      const result = await withMetricsTimeout(1_000, () =>
        runMetricsScoped(
          app as PrismaClient,
          { tenantId: tenant.id, role: "SUPER_ADMIN" as const, userId: 1n },
          async (db) => {
            await db.$queryRawUnsafe("SELECT pg_sleep(0.8)::text");
            return "answered";
          },
        ).catch((e) => e),
      );
      const elapsed = Date.now() - t0;
      await holder;
      expect((result as { statusCode?: number }).statusCode).toBe(503);
      expect(elapsed).toBeLessThan(1_400);
    } finally {
      await (su as PrismaClient).tenant.delete({ where: { id: tenant.id } });
    }
  });

  test("an API key lookup keeps to the budget it is given", async () => {
    let waitedMs = -1;
    await (su as PrismaClient).$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          "LOCK TABLE api_keys IN ACCESS EXCLUSIVE MODE",
        );
        const t0 = Date.now();
        await verifyApiKey("fazerai_mb_lookup", app as PrismaClient, {
          maxWait: 1_000,
          timeout: 400,
        }).catch(() => null);
        waitedMs = Date.now() - t0;
      },
      { timeout: 20_000 },
    );
    expect(waitedMs).toBeLessThan(1_200);
  });

  test("a read inside the budget answers with its figures", async () => {
    const costs = await withMetricsTimeout(5_000, () =>
      getDashboardCosts(ctx, {}, app as PrismaClient),
    );
    expect(costs.requests).toBe(0);
  });
});
