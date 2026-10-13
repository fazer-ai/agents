import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  findSessionPassword,
  findSessionUser,
  type JWTPayload,
} from "@/api/lib/auth";
import { metricsPoolOptions } from "@/api/lib/pool-options";
import config from "@/config";
import { postgresCodeOf } from "@/lib/pg-error";
import { runWithinBudgetOn } from "@/lib/tenancy";
import { untilDeadline } from "@/lib/tenancy/deadline";
import {
  isOverMetricsBudget,
  metricsBudget,
  runMetricsScoped,
} from "@/modules/analytics/budget";
import { getDashboardCosts } from "@/modules/analytics/costs";
import { getHealth } from "@/modules/analytics/health";
import { hashApiKey, verifyApiKey } from "@/modules/api-keys/verify";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { metricsGet } from "@/modules/mcp/read";
import { dbProbeFailed } from "@/tests/db-gate";
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
  } catch (err) {
    dbUp = dbProbeFailed(err);
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

test("a statement asked for after the deadline is refused before it is sent, and reads as the metrics refusal", async () => {
  // A cheap statement finishes inside any timeout Postgres is given, so clamping what is left to 1 ms
  // would let a read keep answering past its budget, one fast statement at a time.
  const sent: string[] = [];
  const db = {
    $executeRaw: async () => {
      sent.push("set statement_timeout");
      return 0;
    },
    llmUsage: {
      count: async () => {
        sent.push("count");
        return 0;
      },
    },
  };
  const late = untilDeadline(db, Date.now() - 1);
  const error = await late.llmUsage.count().catch((e: unknown) => e);
  expect(sent).toEqual([]);
  expect(isOverMetricsBudget(error)).toBe(true);
});

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

  test("a read that waited for a metrics connection runs only on what is left of the budget", async () => {
    // The pool's one connection is held for 0.7 s of the 1 s budget, and the read then needs 0.7 s.
    // Counted from the connection it would answer at 1.4 s; counted from its start it is refused at 1 s.
    const one = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 1 }),
    });
    try {
      await one.$queryRaw`SELECT 1`;
      const t0 = Date.now();
      const holder = one.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe("SELECT pg_sleep(0.7)::text");
        },
        { timeout: 5_000 },
      );
      const result = await withMetricsTimeout(1_000, () =>
        runMetricsScoped(one, ctx, async (db) => {
          await db.$queryRawUnsafe("SELECT pg_sleep(0.7)::text /* mb_wait */");
          return "answered";
        }).catch((e) => e),
      );
      const elapsed = Date.now() - t0;
      await holder;
      expect((result as { statusCode?: number }).statusCode).toBe(503);
      expect((result as { field?: string }).field).toBe("since");
      expect(elapsed).toBeLessThan(1_300);
      const [row] = await (su as PrismaClient).$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE state = 'active' AND query LIKE '%mb_wait%' AND pid <> pg_backend_pid()`;
      expect(row?.n).toBe(0);
    } finally {
      await one.$disconnect();
    }
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

  test("a write under the budget runs, and gets only the time left too", async () => {
    // The kept days of the dashboard are written inside the read that computed them.
    const t0 = Date.now();
    const result = await withMetricsTimeout(1_000, () =>
      runMetricsScoped(app as PrismaClient, ctx, async (db) => {
        await db.$executeRaw`SELECT pg_sleep(0.8)`;
        return db.$executeRawUnsafe("SELECT pg_sleep(1)");
      }).catch((e) => e),
    );
    const elapsed = Date.now() - t0;
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

  test("a SUPER_ADMIN's tenant check after a wait for a connection gets only what is left", async () => {
    // The connection arrives at 0.7 s of the 1 s budget, and the tenant check then waits on a lock
    // held to 1.5 s. Bounded from the request's start it is cancelled at 1 s; from the connection, at
    // 1.7 s.
    const tenant = await (su as PrismaClient).tenant.create({
      data: { name: "mb", slug: `mb-wait-${process.pid}-${Date.now()}` },
    });
    const one = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 1 }),
    });
    try {
      await one.$queryRaw`SELECT 1`;
      const locker = (su as PrismaClient).$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            "LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE",
          );
          await tx.$queryRawUnsafe("SELECT pg_sleep(1.5)::text");
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
      const holder = one.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe("SELECT pg_sleep(0.7)::text");
        },
        { timeout: 5_000 },
      );
      const result = await withMetricsTimeout(1_000, () =>
        runMetricsScoped(
          one,
          { tenantId: tenant.id, role: "SUPER_ADMIN" as const, userId: 1n },
          async () => "answered",
        ).catch((e) => e),
      );
      const elapsed = Date.now() - t0;
      await holder;
      await locker;
      expect((result as { statusCode?: number }).statusCode).toBe(503);
      expect(elapsed).toBeLessThan(1_350);
    } finally {
      await one.$disconnect();
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

  // Holds the client's one connection for `ms`, from now.
  function holdOnly(client: PrismaClient, ms: number): Promise<unknown> {
    return client.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT pg_sleep(${ms / 1000})::text`);
      },
      { timeout: 10_000 },
    );
  }

  // Locks `table` until `ms` from now, in a session of its own.
  async function lockFor(
    table: string,
    ms: number,
  ): Promise<{ held: Promise<unknown> }> {
    const held = (su as PrismaClient).$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`,
        );
        await tx.$queryRawUnsafe(`SELECT pg_sleep(${ms / 1000})::text`);
      },
      { timeout: 20_000 },
    );
    await until(`${table} locked`, async () => {
      const [row] = await (su as PrismaClient).$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
         WHERE c.relname = ${table} AND l.mode = 'AccessExclusiveLock' AND l.granted`;
      return (row?.n ?? 0) > 0 ? true : null;
    });
    // Wrapped: an async function returning the promise itself would wait for it.
    return { held };
  }

  test("a session lookup under the request's deadline that got its connection late gets only what is left", async () => {
    const one = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 1 }),
    });
    try {
      await one.$queryRaw`SELECT 1`;
      // Connection at 0.7 s of a 1 s budget, then `users` stays locked to 1.5 s.
      const { held: locked } = await lockFor("users", 1_500);
      const t0 = Date.now();
      const holder = holdOnly(one, 700);
      const budget = metricsBudget(t0 + 1_000);
      const outcome = await runWithinBudgetOn(one, budget, (db) =>
        db.user.findUnique({ where: { id: 1n }, select: { id: true } }),
      ).then(
        () => "answered",
        (e) => e,
      );
      const elapsed = Date.now() - t0;
      await holder;
      await locked;
      expect(outcome).not.toBe("answered");
      expect(elapsed).toBeLessThan(1_350);
    } finally {
      await one.$disconnect();
    }
  });

  test("a session lookup under a deadline bounds the membership and ended-session reads on their own", async () => {
    const tenant = await (su as PrismaClient).tenant.create({
      data: { name: "mb", slug: `mb-session-${process.pid}-${Date.now()}` },
    });
    const user = await (su as PrismaClient).user.create({
      data: {
        email: `mb-session-${process.pid}-${Date.now()}@example.com`,
        passwordHash:
          "$2b$10$mbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbm",
        memberships: { create: { tenantId: tenant.id, role: "AGENT" } },
      },
    });
    const session: JWTPayload = {
      userId: String(user.id),
      email: user.email,
      role: "AGENT",
      tenantId: String(tenant.id),
      jti: `mb-session-${process.pid}`,
    };
    try {
      // A 1 s budget: `users` stays locked to 0.6 s and `tenant_users` to 1.6 s. Read in one Prisma
      // call, the membership read would start with the whole second and end at 1.6 s.
      const { held: users } = await lockFor("users", 600);
      const { held: memberships } = await lockFor("tenant_users", 1_600);
      const t0 = Date.now();
      const outcome = await runWithinBudgetOn(
        app as PrismaClient,
        metricsBudget(t0 + 1_000),
        (db) => findSessionUser(db, user.id, session, true),
      ).then(
        () => "answered",
        (e) => e,
      );
      const elapsed = Date.now() - t0;
      await users;
      await memberships;
      expect(outcome).not.toBe("answered");
      expect(elapsed).toBeLessThan(1_350);
      // Without the locks it answers with the membership.
      const row = await runWithinBudgetOn(
        app as PrismaClient,
        metricsBudget(Date.now() + 5_000),
        (db) => findSessionUser(db, user.id, session, true),
      );
      expect(row?.memberships.map((m) => m.tenantId)).toEqual([tenant.id]);
      // The identity check's ended-session read is bounded the same way.
      const { held: usersAgain } = await lockFor("users", 600);
      const { held: ended } = await lockFor("ended_sessions", 1_600);
      const t1 = Date.now();
      const check = await runWithinBudgetOn(
        app as PrismaClient,
        metricsBudget(t1 + 1_000),
        (db) => findSessionPassword(db, user.id, session, true),
      ).then(
        () => "answered",
        (e) => e,
      );
      const checkElapsed = Date.now() - t1;
      await usersAgain;
      await ended;
      expect(check).not.toBe("answered");
      expect(checkElapsed).toBeLessThan(1_350);
    } finally {
      await (su as PrismaClient).user.delete({ where: { id: user.id } });
      await (su as PrismaClient).tenant.delete({ where: { id: tenant.id } });
    }
  });

  test("an API key lookup sets what is left of the deadline before each of its statements", async () => {
    const tenant = await (su as PrismaClient).tenant.create({
      data: { name: "mb", slug: `mb-key-${process.pid}-${Date.now()}` },
    });
    const user = await (su as PrismaClient).user.create({
      data: {
        email: `mb-key-${process.pid}-${Date.now()}@example.com`,
        passwordHash:
          "$2b$10$mbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbmbm",
      },
    });
    const token = `fazerai_mbkey${process.pid}${Date.now()}`;
    await (su as PrismaClient).apiKey.create({
      data: {
        tenantId: tenant.id,
        displayName: "mb",
        keyHash: hashApiKey(token),
        keyPrefix: token.slice(0, 14),
        role: "TENANT_ADMIN",
        createdByUserId: user.id,
      },
    });
    const one = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 1 }),
    });
    try {
      await one.$queryRaw`SELECT 1`;
      // A 2 s budget, the connection at 1.0 s; the key's row stays locked to 1.6 s and its tenant's to
      // 2.6 s. With the deadline set once, at the opening, each lookup gets a fresh second and the
      // tenant lookup ends at 2.6 s; set before each statement, it is cancelled at 2 s.
      const { held: keys } = await lockFor("api_keys", 1_600);
      const { held: tenants } = await lockFor("tenants", 2_600);
      const t0 = Date.now();
      const holder = holdOnly(one, 1_000);
      const outcome = await verifyApiKey(
        token,
        one,
        metricsBudget(t0 + 2_000),
      ).then(
        () => "answered",
        (e) => e,
      );
      const elapsed = Date.now() - t0;
      await holder;
      await keys;
      await tenants;
      expect(outcome).not.toBe("answered");
      expect(elapsed).toBeLessThan(2_350);
    } finally {
      await one.$disconnect();
      await (su as PrismaClient).apiKey.deleteMany({
        where: { tenantId: tenant.id },
      });
      await (su as PrismaClient).user.delete({ where: { id: user.id } });
      await (su as PrismaClient).tenant.delete({ where: { id: tenant.id } });
    }
  });

  test("a read inside the budget answers with its figures", async () => {
    // A tenant no row names: tenant 1 is the first one a fresh database hands out, and the files that
    // share this database may have billed usage to it.
    const costs = await withMetricsTimeout(5_000, () =>
      getDashboardCosts(
        { ...ctx, tenantId: 9_000_000_000_000n },
        {},
        app as PrismaClient,
      ),
    );
    expect(costs.requests).toBe(0);
  });
});
