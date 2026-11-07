import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Elysia } from "elysia";
import { Pool } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { localeMiddleware } from "@/api/middlewares/locale";
import { checkpointTransaction } from "@/graph/checkpoint-sweep";
import { openScopeMarkCount } from "@/lib/db-scope";
import {
  drainStatementTimeouts,
  forgetPool,
  instrumentPool,
  lastStatementTimeout,
  lockTimeoutsPerMinute,
  recordStatementTimeout,
  requeueStatementTimeouts,
  resetLockTimeouts,
  resetStatementTimeouts,
  statementTimeoutsPerMinute,
} from "@/lib/pool-stats";
import { asSuperAdminOn, runScopedOn, runWithinBudgetOn } from "@/lib/tenancy";
import { currentWorkLabel, runWithWorkLabel } from "@/lib/work-label";
import { dbProbeFailed } from "@/tests/db-gate";

// A statement cancelled by its budget (SQLSTATE 57014) is recorded by the pool it ran on, with the
// work that ran it and the scope its transaction was opened under (src/lib/db-scope.ts, declared by
// the tenancy helpers and never parsed from the SQL; docs/logs.md, "Database"): that is what the
// database screen stores and plans, and what the instance alert names.

const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
let pool: Pool | undefined;
// The tenancy helpers over the instrumented pool, as src/api/lib/prisma.ts builds the app's client.
let db: PrismaClient | undefined;
if (appUrl) {
  try {
    pool = instrumentPool(
      "test-statement-timeouts",
      new Pool({ connectionString: appUrl, max: 2 }),
    );
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
    await pool.query("SELECT 1");
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

afterAll(async () => {
  forgetPool("test-statement-timeouts");
  await db?.$disconnect();
  await pool?.end();
});

const budget = (timeout: number, deadline?: number) => ({
  maxWait: 5000,
  timeout,
  ...(deadline === undefined ? {} : { deadline }),
});

describe.skipIf(!dbUp)("statement timeouts on an instrumented pool", () => {
  beforeEach(() => {
    resetStatementTimeouts();
    resetLockTimeouts();
  });

  test("a 57014 inside a scoped transaction is recorded with its work, tenant and budget", async () => {
    await runWithWorkLabel("job:FOLLOWUP_SWEEP", () =>
      expect(
        runScopedOn(
          db as PrismaClient,
          { tenantId: 42n, userId: null, role: "TENANT_ADMIN" },
          (tx) => tx.$queryRaw`SELECT pg_sleep(1)`,
          budget(50),
        ),
      ).rejects.toThrow(),
    );
    const [ev] = drainStatementTimeouts();
    expect(ev?.sql).toContain("pg_sleep");
    expect(ev?.label).toBe("job:FOLLOWUP_SWEEP");
    expect(ev?.tenantId).toBe("42");
    expect(ev?.budgetMs).toBe(50);
    expect(ev?.fleet).toBe(false);
    expect(ev?.pool).toBe("test-statement-timeouts");
    expect(statementTimeoutsPerMinute()).toBe(1);
    expect(lastStatementTimeout()?.label).toBe("job:FOLLOWUP_SWEEP");
    // Counted apart from the lock timeouts, which mean something else.
    expect(lockTimeoutsPerMinute()).toBe(0);
  });

  // Both callbacks wait on one gate, so their statements go out in the same tick: Prisma dispatches
  // requests issued together from the first one's async context, and read at the driver both would
  // carry the first caller's scope and label.
  const together = () => {
    let ready = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    return async (n: number) => {
      if (++ready === n) open();
      await gate;
    };
  };

  test("two transactions whose statements go out in the same tick each keep their own work and tenant", async () => {
    const wait = together();
    const run = (label: string, tenantId: bigint) =>
      runWithWorkLabel(label, () =>
        runScopedOn(
          db as PrismaClient,
          { tenantId, userId: null, role: "TENANT_ADMIN" },
          async (tx) => {
            await wait(2);
            return tx.$queryRaw`SELECT pg_sleep(1)`;
          },
          budget(50),
        ),
      ).catch(() => null);
    await Promise.all([run("job:FIRST", 11n), run("job:SECOND", 22n)]);
    const seen = drainStatementTimeouts()
      .map((e) => `${e.label} ${e.tenantId}`)
      .sort();
    expect(seen).toEqual(["job:FIRST 11", "job:SECOND 22"]);
    // Each transaction's mark is closed when it ends, failed or not.
    expect(openScopeMarkCount()).toBe(0);
  });

  test("two fleet transactions whose statements go out together each keep their own work", async () => {
    const wait = together();
    const fleet = (label: string) =>
      runWithWorkLabel(label, () =>
        asSuperAdminOn(
          db as PrismaClient,
          async (tx) => {
            await wait(2);
            return tx.$queryRaw`SELECT pg_sleep(1)`;
          },
          budget(50),
        ),
      ).catch(() => null);
    await Promise.all([fleet("job:FLEET_A"), fleet("job:FLEET_B")]);
    const seen = drainStatementTimeouts()
      .map((e) => `${e.label} ${e.fleet} ${e.tenantId}`)
      .sort();
    expect(seen).toEqual(["job:FLEET_A true null", "job:FLEET_B true null"]);
  });

  test("the fleet path is recorded as such", async () => {
    await expect(
      asSuperAdminOn(
        db as PrismaClient,
        (tx) => tx.$queryRaw`SELECT pg_sleep(1)`,
        budget(40),
      ),
    ).rejects.toThrow();
    const [ev] = drainStatementTimeouts();
    expect(ev?.fleet).toBe(true);
    expect(ev?.tenantId).toBeNull();
    expect(ev?.budgetMs).toBe(40);
  });

  test("under a deadline the budget recorded is what was left of it when the statement went out", async () => {
    await expect(
      runWithinBudgetOn(
        db as PrismaClient,
        budget(5000, Date.now() + 60),
        (tx) => tx.$queryRaw`SELECT pg_sleep(1)`,
      ),
    ).rejects.toThrow();
    const [ev] = drainStatementTimeouts();
    expect(ev?.tenantId).toBeNull();
    expect(ev?.fleet).toBe(false);
    expect(ev?.budgetMs).toBeGreaterThan(0);
    expect(ev?.budgetMs).toBeLessThanOrEqual(60);
  });

  test("the SQL a transaction sends cannot change the scope it is recorded under", async () => {
    await expect(
      runWithinBudgetOn(db as PrismaClient, budget(40), async (tx) => {
        // A statement that sets a tenant by itself: the scope is what the helper declared.
        await tx.$queryRaw`SELECT set_config('app.tenant_id', '9', true), set_config('role', current_user, true)`;
        return tx.$queryRaw`SELECT pg_sleep(1)`;
      }),
    ).rejects.toThrow();
    const [ev] = drainStatementTimeouts();
    expect(ev?.tenantId).toBeNull();
    expect(ev?.fleet).toBe(false);
  });

  test("a statement after the transaction, outside any scope, carries none of it", async () => {
    await asSuperAdminOn(
      db as PrismaClient,
      (tx) => tx.$queryRaw`SELECT 1`,
      budget(5000),
    );
    const client = await (pool as Pool).connect();
    try {
      await client.query("SET statement_timeout = 40");
      await expect(client.query("SELECT pg_sleep(1)")).rejects.toThrow();
      await client.query("RESET statement_timeout");
    } finally {
      client.release();
    }
    const [ev] = drainStatementTimeouts();
    expect(ev?.tenantId).toBeNull();
    expect(ev?.fleet).toBe(false);
    expect(ev?.budgetMs).toBeNull();
  });

  test("the checkpointer's sweep is recorded with what was left of its deadline", async () => {
    await expect(
      checkpointTransaction(
        pool as Pool,
        { deadline: Date.now() + 45, beforeCommit: async () => {} },
        (query) => query("SELECT pg_sleep(1)", []),
      ),
    ).rejects.toThrow();
    const [ev] = drainStatementTimeouts();
    expect(ev?.sql).toBe("SELECT pg_sleep(1)");
    expect(ev?.tenantId).toBeNull();
    expect(ev?.budgetMs).toBeGreaterThan(0);
    expect(ev?.budgetMs).toBeLessThanOrEqual(45);
  });

  test("a query that waited in the pool keeps the label of the work that sent it", async () => {
    // One connection, with a budget on every statement, so the second query waits behind the first.
    const tiny = instrumentPool(
      "test-statement-timeouts-tiny",
      new Pool({ connectionString: appUrl, max: 1, statement_timeout: 40 }),
    );
    try {
      let release: () => void = () => {};
      const holding = new Promise<void>((r) => {
        release = r;
      });
      let held: () => void = () => {};
      const isHeld = new Promise<void>((r) => {
        held = r;
      });
      // Work B holds the only connection and releases it from its own context.
      const b = runWithWorkLabel("job:B", async () => {
        const client = await tiny.connect();
        held();
        await holding;
        client.release();
      });
      await isHeld;
      // Work A queues on the pool; pg hands it the connection from B's release.
      const a = runWithWorkLabel("job:A", () =>
        tiny.query("SELECT pg_sleep(1)").then(
          () => "ran",
          () => "timed out",
        ),
      );
      release();
      expect(await a).toBe("timed out");
      await b;
      const [ev] = drainStatementTimeouts();
      expect(ev?.label).toBe("job:A");
    } finally {
      forgetPool("test-statement-timeouts-tiny");
      await tiny.end();
    }
  });

  test("a statement that fails for another reason records nothing", async () => {
    await expect((pool as Pool).query("SELECT 1/0")).rejects.toThrow();
    expect(drainStatementTimeouts()).toEqual([]);
    expect(statementTimeoutsPerMinute()).toBe(0);
  });
});

describe("the label of a request is its route pattern", () => {
  test("a handler reads the method and the matched route, never the ids in the path", async () => {
    const app = new Elysia()
      .use(localeMiddleware)
      .get("/v1/things/:id", () => currentWorkLabel() ?? "none");
    const res = await app.handle(new Request("http://localhost/v1/things/123"));
    expect(await res.text()).toBe("GET /v1/things/:id");
  });

  test("the authentication a plugin derives after it already runs under the label", async () => {
    // The shape of the tenancy plugin: a global derive that looks the principal up in the database.
    const auth = new Elysia({ name: "auth-probe" }).derive(
      { as: "global" },
      () => ({ seenByAuth: currentWorkLabel() ?? "none" }),
    );
    const app = new Elysia()
      .use(localeMiddleware)
      .use(auth)
      .get("/v1/things/:id", ({ seenByAuth }) => seenByAuth);
    const res = await app.handle(new Request("http://localhost/v1/things/123"));
    expect(await res.text()).toBe("GET /v1/things/:id");
  });
});

describe("the queue a flush drains", () => {
  const ev = (at: number) => ({
    at,
    sql: "SELECT 1",
    label: null,
    tenantId: null,
    fleet: false,
    budgetMs: null,
  });

  test("a bounded drain leaves the rest, and what is put back goes ahead of what arrived since", () => {
    resetStatementTimeouts();
    for (const at of [1, 2, 3]) recordStatementTimeout(ev(at));
    const taken = drainStatementTimeouts(2);
    expect(taken.map((e) => e.at)).toEqual([1, 2]);
    recordStatementTimeout(ev(4));
    requeueStatementTimeouts(taken.slice(1));
    expect(drainStatementTimeouts().map((e) => e.at)).toEqual([2, 3, 4]);
  });
});
