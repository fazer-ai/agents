import {
  afterAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
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

// No test measures how long a read took. A bounded read is refused while the lock it waits on is
// still held; an unbounded one waits the lock out and answers. Where the claim is that a statement
// gets only what is LEFT of the deadline, the clock is moved to near the deadline instead of spent:
// the budget is one no read could spend, so a statement handed a fresh one waits the lock out too.

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

// How long a locked table stays locked when the test does not release it. Every read under test is
// refused well inside it (its budget, or what a jump of the clock left of it, is at most an eighth
// of it); a read that is not bounded waits it out and answers, and the tests assert on that answer.
const HOLD_MS = 4_000;
// A budget twice the hold: a read that got a fresh one, or one counted from somewhere other than its
// deadline, waits on the lock until HOLD_MS and answers. Nothing else cuts that wait short:
// `lockTimeoutUnder` sets no lock timeout for a budget above DB_LOCK_TIMEOUT_MS and one just under
// the budget otherwise, and the clients here open their sessions with none.
const BUDGET_MS = 2 * HOLD_MS;
// What a test leaves of BUDGET_MS by moving the clock, once the read has taken its deadline.
const LEFT_MS = 500;

// Catches a hang, never decides a verdict: five times the longest budget a test arms, which is also
// the longest it can wait on locks (two holds back to back, in the session lookup's mutant run).
const CEILING_MS = 5 * BUDGET_MS;
setDefaultTimeout(CEILING_MS);

// `Date.now()` as the deadline code reads it: the real clock, plus whatever `jump` added. A test moves
// a read to near its deadline without spending the time. Captured before the spy, so `real` is the
// real clock; `until` reads `Date.now()` too, so a test polls before it jumps, never after.
function skewedClock(): { jump: (ms: number) => void; restore: () => void } {
  const real = Date.now.bind(Date);
  let skew = 0;
  const spy = spyOn(Date, "now").mockImplementation(() => real() + skew);
  return {
    jump: (ms) => {
      skew += ms;
    },
    restore: () => spy.mockRestore(),
  };
}

// Locks `table` in a session of its own until `release()`, or for HOLD_MS if it never comes. The
// lock is held once this returns.
async function lockTable(
  table: string,
): Promise<{ release: () => Promise<boolean> }> {
  let pid: number | undefined;
  const held = (su as PrismaClient)
    .$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`,
        );
        const [row] = await tx.$queryRaw<{ pid: number }[]>`
          SELECT pg_backend_pid() AS pid`;
        pid = row?.pid;
        await tx.$queryRawUnsafe(
          `SELECT pg_sleep(${HOLD_MS / 1000})::text /* mb_hold */`,
        );
      },
      { timeout: CEILING_MS },
    )
    // Cancelled by `release()`, the transaction rolls back, which is the release.
    .catch(() => undefined);
  await until(`${table} locked`, async () => (pid === undefined ? null : pid), {
    deadlineMs: CEILING_MS,
  });
  // Cancels the hold only while it is the hold: once it ran out, its connection is back in the pool
  // and the pid may be serving anything, this cancel included. Resolves to whether the hold was still
  // there, which is what a test asserts after the read answered: refused while the lock held, not
  // after the hold ran out on its own.
  let released: Promise<boolean> | undefined;
  return {
    release: () => {
      released ??= (async () => {
        const cancelled = await (su as PrismaClient).$queryRaw<
          { ok: boolean }[]
        >`
          SELECT pg_cancel_backend(pid) AS ok FROM pg_stat_activity
           WHERE pid = ${pid}::int AND pid <> pg_backend_pid() AND query LIKE '%mb_hold%'`;
        await held;
        return cancelled.some((row) => row.ok);
      })();
      return released;
    },
  };
}

// Resolves once a statement of another session is waiting for the lock on `table`.
async function waitedOn(table: string): Promise<void> {
  await until(
    `a statement waiting on ${table}`,
    async () => {
      const [row] = await (su as PrismaClient).$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
       WHERE c.relname = ${table} AND NOT l.granted`;
      return (row?.n ?? 0) > 0 ? true : null;
    },
    { deadlineMs: CEILING_MS },
  );
}

// Holds the client's one connection for `ms`, from now.
function holdOnly(client: PrismaClient, ms: number): Promise<unknown> {
  return client.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT pg_sleep(${ms / 1000})::text`);
    },
    { timeout: CEILING_MS },
  );
}

async function waitingOnUsage(): Promise<number> {
  const [row] = await (su as PrismaClient).$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND state = 'active' AND query ILIKE '%llm_usage%'
       AND pid <> pg_backend_pid() AND usename <> current_user`;
  return row?.n ?? -1;
}

function withMetricsTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const metrics = config.metrics;
  const saved = metrics.timeoutMs;
  metrics.timeoutMs = ms;
  return fn().finally(() => {
    metrics.timeoutMs = saved;
  });
}

const statusOf = (result: unknown) =>
  (result as { statusCode?: number }).statusCode;

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
  test("a read past METRICS_TIMEOUT_MS answers 503 while the lock still holds, and leaves no statement running", async () => {
    const usage = await lockTable("llm_usage");
    try {
      const result = await withMetricsTimeout(500, () =>
        getDashboardCosts(ctx, {}, app as PrismaClient).catch((e) => e),
      );
      expect(statusOf(result)).toBe(503);
      expect((result as Error).message).toContain("Try a shorter period");
      expect((result as { field?: string }).field).toBe("since");
      expect(await waitingOnUsage()).toBe(0);
      expect(await usage.release()).toBe(true);
    } finally {
      await usage.release();
    }
  });

  test("a read refused by the lock timeout is the same 503", async () => {
    const locking = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, lock_timeout: 300 }),
    });
    const usage = await lockTable("llm_usage");
    try {
      const result = await withMetricsTimeout(BUDGET_MS, () =>
        getHealth(ctx, {}, locking).catch((e) => e),
      );
      expect(statusOf(result)).toBe(503);
      expect(await usage.release()).toBe(true);
      // The sentence states the time the read ran (about 0.3 s), not the budget it never reached.
      const seconds = (result as { translationParams?: { seconds?: number } })
        .translationParams?.seconds;
      expect(seconds).toBeGreaterThanOrEqual(0.2);
      expect(seconds).not.toBe(BUDGET_MS / 1000);
      expect((result as Error).message).not.toContain(`${BUDGET_MS / 1000}s`);
    } finally {
      await usage.release();
      await locking.$disconnect();
    }
  });

  test("the MCP metrics tool returns the refusal as a tool error", async () => {
    const usage = await lockTable("llm_usage");
    try {
      const result = await withMetricsTimeout(500, () =>
        metricsGet(principal, {}, { base: app as PrismaClient }),
      );
      expect(JSON.stringify(result)).toContain("Try a shorter period");
      expect(await usage.release()).toBe(true);
    } finally {
      await usage.release();
    }
  });

  test("each statement is given what is left of the deadline, for the statement and for its lock wait", async () => {
    // Read back from the statement itself: what Postgres enforces, not how long anything took. Time
    // that passes only lowers what is left, so the bounds hold on any machine.
    const clock = skewedClock();
    try {
      const seen = await withMetricsTimeout(BUDGET_MS, () =>
        runMetricsScoped(app as PrismaClient, ctx, async (db) => {
          clock.jump(BUDGET_MS - 2_000);
          const [row] = await db.$queryRaw<
            { statement: number; lock: number }[]
          >`SELECT (SELECT setting::int FROM pg_settings WHERE name = 'statement_timeout') AS statement,
                   (SELECT setting::int FROM pg_settings WHERE name = 'lock_timeout') AS lock`;
          return row;
        }),
      );
      expect(seen?.statement).toBeGreaterThan(0);
      expect(seen?.statement).toBeLessThanOrEqual(2_000);
      expect(seen?.lock).toBeLessThanOrEqual(2_000);
    } finally {
      clock.restore();
    }
  });

  test("a read of several aggregates is bounded as a whole, not per aggregate", async () => {
    // The first aggregate answers; by the second only LEFT_MS of the budget remains. Given a budget of
    // its own, the second would wait out the lock and answer.
    const usage = await lockTable("llm_usage");
    const clock = skewedClock();
    try {
      const result = await withMetricsTimeout(BUDGET_MS, () =>
        runMetricsScoped(app as PrismaClient, ctx, async (db) => {
          await db.$queryRawUnsafe("SELECT 1 /* mb_two */");
          clock.jump(BUDGET_MS - LEFT_MS);
          await db.$queryRawUnsafe(
            "SELECT count(*)::int FROM llm_usage /* mb_two */",
          );
          return "answered";
        }).catch((e) => e),
      );
      expect(statusOf(result)).toBe(503);
      const [row] = await (su as PrismaClient).$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND state = 'active' AND query LIKE '%mb_two%'
           AND pid <> pg_backend_pid()`;
      expect(row?.n).toBe(0);
      expect(await usage.release()).toBe(true);
    } finally {
      clock.restore();
      await usage.release();
    }
  });

  test("a read that waited for a metrics connection runs only on what is left of the budget", async () => {
    // The read takes its deadline, and the clock moves to LEFT_MS before it: while the pool's one
    // connection is busy. Counted from the connection, the budget would be whole again.
    const one = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 1 }),
    });
    const usage = await lockTable("llm_usage");
    const clock = skewedClock();
    try {
      await one.$queryRaw`SELECT 1`;
      const holder = holdOnly(one, 200);
      const result = await withMetricsTimeout(BUDGET_MS, () => {
        const read = runMetricsScoped(one, ctx, async (db) => {
          await db.llmUsage.count();
          return "answered";
        });
        clock.jump(BUDGET_MS - LEFT_MS);
        return read.catch((e) => e);
      });
      await holder;
      expect(statusOf(result)).toBe(503);
      expect(await usage.release()).toBe(true);
      expect((result as { field?: string }).field).toBe("since");
    } finally {
      clock.restore();
      await usage.release();
      await one.$disconnect();
    }
  });

  test("a model aggregate gets only the time left too", async () => {
    const usage = await lockTable("llm_usage");
    const clock = skewedClock();
    try {
      const result = await withMetricsTimeout(BUDGET_MS, () =>
        runMetricsScoped(app as PrismaClient, ctx, async (db) => {
          await db.$queryRawUnsafe("SELECT 1");
          clock.jump(BUDGET_MS - LEFT_MS);
          return db.llmUsage.count();
        }).catch((e) => e),
      );
      expect(statusOf(result)).toBe(503);
      expect(await usage.release()).toBe(true);
    } finally {
      clock.restore();
      await usage.release();
    }
  });

  test("a write under the budget runs, and gets only the time left too", async () => {
    // The kept days of the dashboard are written inside the read that computed them.
    const usage = await lockTable("llm_usage");
    const clock = skewedClock();
    try {
      const result = await withMetricsTimeout(BUDGET_MS, () =>
        runMetricsScoped(app as PrismaClient, ctx, async (db) => {
          await db.$executeRaw`SELECT 1`;
          clock.jump(BUDGET_MS - LEFT_MS);
          return db.$executeRawUnsafe("SELECT count(*) FROM llm_usage");
        }).catch((e) => e),
      );
      expect(statusOf(result)).toBe(503);
      expect(await usage.release()).toBe(true);
    } finally {
      clock.restore();
      await usage.release();
    }
  });

  test("a statement on the metrics pool outside a read, like the session lookup, is bounded too", async () => {
    const pool = await withMetricsTimeout(
      500,
      async () =>
        new PrismaClient({
          adapter: new PrismaPg(metricsPoolOptions(appUrl)),
        }),
    );
    const users = await lockTable("users");
    try {
      const code = await pool.user
        .findUnique({ where: { id: 1n }, select: { id: true } })
        .then(
          () => "answered",
          (e) => postgresCodeOf(e),
        );
      expect(code === "57014" || code === "55P03").toBe(true);
      expect(await users.release()).toBe(true);
    } finally {
      await users.release();
      await pool.$disconnect();
    }
  });

  test("a SUPER_ADMIN's tenant check spends the same budget the aggregates do", async () => {
    // The check is the read's first statement, and it waits on `tenants` with LEFT_MS of the budget.
    // Outside the deadline, it would wait out the lock, and the read would answer.
    const tenant = await (su as PrismaClient).tenant.create({
      data: { name: "mb", slug: `mb-${process.pid}-${Date.now()}` },
    });
    const tenants = await lockTable("tenants");
    const clock = skewedClock();
    try {
      const result = await withMetricsTimeout(BUDGET_MS, () => {
        const read = runMetricsScoped(
          app as PrismaClient,
          { tenantId: tenant.id, role: "SUPER_ADMIN" as const, userId: 1n },
          async () => "answered",
        );
        clock.jump(BUDGET_MS - LEFT_MS);
        return read.catch((e) => e);
      });
      expect(statusOf(result)).toBe(503);
      expect(await tenants.release()).toBe(true);
    } finally {
      clock.restore();
      await tenants.release();
      await (su as PrismaClient).tenant.delete({ where: { id: tenant.id } });
    }
  });

  test("a SUPER_ADMIN's tenant check after a wait for a connection gets only what is left", async () => {
    const tenant = await (su as PrismaClient).tenant.create({
      data: { name: "mb", slug: `mb-wait-${process.pid}-${Date.now()}` },
    });
    const one = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 1 }),
    });
    const tenants = await lockTable("tenants");
    const clock = skewedClock();
    try {
      await one.$queryRaw`SELECT 1`;
      const holder = holdOnly(one, 200);
      const result = await withMetricsTimeout(BUDGET_MS, () => {
        const read = runMetricsScoped(
          one,
          { tenantId: tenant.id, role: "SUPER_ADMIN" as const, userId: 1n },
          async () => "answered",
        );
        clock.jump(BUDGET_MS - LEFT_MS);
        return read.catch((e) => e);
      });
      await holder;
      expect(statusOf(result)).toBe(503);
      expect(await tenants.release()).toBe(true);
    } finally {
      clock.restore();
      await tenants.release();
      await one.$disconnect();
      await (su as PrismaClient).tenant.delete({ where: { id: tenant.id } });
    }
  });

  test("an API key lookup keeps to the budget it is given", async () => {
    const keys = await lockTable("api_keys");
    try {
      const outcome = await verifyApiKey(
        "fazerai_mb_lookup",
        app as PrismaClient,
        { maxWait: 1_000, timeout: 400 },
      ).then(
        () => "answered",
        (e) => postgresCodeOf(e),
      );
      expect(outcome === "57014" || outcome === "55P03").toBe(true);
      expect(await keys.release()).toBe(true);
    } finally {
      await keys.release();
    }
  });

  test("an API key lookup that waited for its connection gets only what is left", async () => {
    const one = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 1 }),
    });
    const keys = await lockTable("api_keys");
    const clock = skewedClock();
    try {
      await one.$queryRaw`SELECT 1`;
      const holder = holdOnly(one, 200);
      const lookup = verifyApiKey(
        "fazerai_mb_lookup",
        one,
        metricsBudget(Date.now() + BUDGET_MS),
      );
      clock.jump(BUDGET_MS - LEFT_MS);
      const outcome = await lookup.then(
        () => "answered",
        (e) => e,
      );
      await holder;
      expect(outcome).not.toBe("answered");
      expect(await keys.release()).toBe(true);
    } finally {
      clock.restore();
      await keys.release();
      await one.$disconnect();
    }
  });

  test("a session lookup under the request's deadline that got its connection late gets only what is left", async () => {
    const one = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 1 }),
    });
    const users = await lockTable("users");
    const clock = skewedClock();
    try {
      await one.$queryRaw`SELECT 1`;
      const holder = holdOnly(one, 200);
      const read = runWithinBudgetOn(
        one,
        metricsBudget(Date.now() + BUDGET_MS),
        (db) => db.user.findUnique({ where: { id: 1n }, select: { id: true } }),
      );
      clock.jump(BUDGET_MS - LEFT_MS);
      const outcome = await read.then(
        () => "answered",
        (e) => e,
      );
      await holder;
      expect(outcome).not.toBe("answered");
      expect(await users.release()).toBe(true);
    } finally {
      clock.restore();
      await users.release();
      await one.$disconnect();
    }
  });

  test("a session lookup under a deadline bounds the membership and ended-session reads on their own", async () => {
    // The user row is read while `users` is locked; the clock moves to LEFT_MS, and then the lock
    // goes. The next read, of the memberships (then of the ended sessions), waits on its own lock
    // with what is left. Read in the same Prisma call, it would keep the whole budget and answer.
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
    // Each read is held at the user row until the clock has moved, then meets the second lock.
    async function underSecondLock(
      second: string,
      read: (
        db: Parameters<Parameters<typeof runWithinBudgetOn>[2]>[0],
      ) => Promise<unknown>,
    ): Promise<{ answer: unknown; held: boolean }> {
      const users = await lockTable("users");
      const next = await lockTable(second);
      const clock = skewedClock();
      try {
        const outcome = runWithinBudgetOn(
          app as PrismaClient,
          metricsBudget(Date.now() + BUDGET_MS),
          read,
        ).then(
          () => "answered",
          (e) => e,
        );
        await waitedOn("users");
        clock.jump(BUDGET_MS - LEFT_MS);
        await users.release();
        const answer = await outcome;
        return { answer, held: await next.release() };
      } finally {
        clock.restore();
        await users.release();
        await next.release();
      }
    }
    try {
      {
        const { answer, held } = await underSecondLock("tenant_users", (db) =>
          findSessionUser(db, user.id, session, true),
        );
        expect(answer).not.toBe("answered");
        expect(held).toBe(true);
      }
      // Without the locks it answers with the membership.
      const row = await runWithinBudgetOn(
        app as PrismaClient,
        metricsBudget(Date.now() + 5_000),
        (db) => findSessionUser(db, user.id, session, true),
      );
      expect(row?.memberships.map((m) => m.tenantId)).toEqual([tenant.id]);
      // The identity check's ended-session read is bounded the same way.
      {
        const { answer, held } = await underSecondLock("ended_sessions", (db) =>
          findSessionPassword(db, user.id, session, true),
        );
        expect(answer).not.toBe("answered");
        expect(held).toBe(true);
      }
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
    // The key's row is read while `api_keys` is locked; the clock moves to LEFT_MS, the lock goes,
    // and the tenant lookup waits on `tenants` with what is left. With the deadline set once, at the
    // opening, it would keep the whole budget and answer.
    const keys = await lockTable("api_keys");
    const tenants = await lockTable("tenants");
    const clock = skewedClock();
    try {
      const outcome = verifyApiKey(
        token,
        app as PrismaClient,
        metricsBudget(Date.now() + BUDGET_MS),
      ).then(
        () => "answered",
        (e) => e,
      );
      await waitedOn("api_keys");
      clock.jump(BUDGET_MS - LEFT_MS);
      await keys.release();
      expect(await outcome).not.toBe("answered");
      expect(await tenants.release()).toBe(true);
    } finally {
      clock.restore();
      await keys.release();
      await tenants.release();
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
