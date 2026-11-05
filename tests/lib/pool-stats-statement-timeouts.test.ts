import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Pool } from "pg";
import { localeMiddleware } from "@/api/middlewares/locale";
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
import { currentWorkLabel, runWithWorkLabel } from "@/lib/work-label";
import { dbProbeFailed } from "@/tests/db-gate";

// A statement cancelled by its budget (SQLSTATE 57014) is recorded by the pool it ran on, with the
// work that ran it and the scope its transaction set (docs/logs.md, "Database"): that is what the
// database screen stores and plans, and what the instance alert names.

const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
let pool: Pool | undefined;
if (appUrl) {
  try {
    pool = instrumentPool(
      "test-statement-timeouts",
      new Pool({ connectionString: appUrl, max: 2 }),
    );
    await pool.query("SELECT 1");
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

afterAll(async () => {
  forgetPool("test-statement-timeouts");
  await pool?.end();
});

describe.skipIf(!dbUp)("statement timeouts on an instrumented pool", () => {
  beforeEach(() => {
    resetStatementTimeouts();
    resetLockTimeouts();
  });

  test("a 57014 inside a scoped transaction is recorded with its work, tenant and budget", async () => {
    const client = await (pool as Pool).connect();
    try {
      await runWithWorkLabel("job:FOLLOWUP_SWEEP", async () => {
        await client.query("BEGIN");
        // The shape src/lib/tenancy/multi-tenant.ts opens every scoped transaction with.
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('statement_timeout', $2, true)",
          ["42", "50"],
        );
        await expect(
          client.query("SELECT pg_sleep($1)", [1]),
        ).rejects.toThrow();
        await client.query("ROLLBACK");
      });
    } finally {
      client.release();
    }
    const [ev] = drainStatementTimeouts();
    expect(ev?.sql).toBe("SELECT pg_sleep($1)");
    expect(ev?.label).toBe("job:FOLLOWUP_SWEEP");
    expect(ev?.tenantId).toBe("42");
    expect(ev?.budgetMs).toBe(50);
    expect(ev?.fleet).toBe(false);
    expect(statementTimeoutsPerMinute()).toBe(1);
    expect(lastStatementTimeout()?.label).toBe("job:FOLLOWUP_SWEEP");
    // Counted apart from the lock timeouts, which mean something else.
    expect(lockTimeoutsPerMinute()).toBe(0);
  });

  test("the fleet path is recorded as such", async () => {
    const client = await (pool as Pool).connect();
    try {
      await client.query("BEGIN");
      // The shape asSuperAdmin opens with.
      await client.query(
        "SELECT set_config('role', public.fazerai_fleet_role(), true), set_config('statement_timeout', $1, true)",
        ["40"],
      );
      await expect(client.query("SELECT pg_sleep(1)")).rejects.toThrow();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const [ev] = drainStatementTimeouts();
    expect(ev?.fleet).toBe(true);
    expect(ev?.tenantId).toBeNull();
  });

  test("a later transaction does not inherit the scope of the one before", async () => {
    const client = await (pool as Pool).connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('statement_timeout', $1, true), set_config('app.tenant_id', $2, true)",
        ["40", "7"],
      );
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SELECT set_config('statement_timeout', '40', true)");
      await expect(client.query("SELECT pg_sleep(1)")).rejects.toThrow();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const [ev] = drainStatementTimeouts();
    expect(ev?.tenantId).toBeNull();
    expect(ev?.budgetMs).toBe(40);
    expect(ev?.label).toBeNull();
  });

  test("a statement after COMMIT, outside any transaction, does not carry the committed scope", async () => {
    const client = await (pool as Pool).connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('statement_timeout', $2, true)",
        ["9", "5000"],
      );
      await client.query("COMMIT");
      // A session-level budget, in autocommit: no transaction, so no tenant.
      await client.query("SELECT set_config('statement_timeout', '40', false)");
      await expect(client.query("SELECT pg_sleep(1)")).rejects.toThrow();
      await client.query("RESET statement_timeout");
    } finally {
      client.release();
    }
    const [ev] = drainStatementTimeouts();
    expect(ev?.tenantId).toBeNull();
    expect(ev?.budgetMs).toBe(40);
  });

  test("a rollback to a savepoint keeps the transaction's scope", async () => {
    const client = await (pool as Pool).connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('statement_timeout', $2, true)",
        ["5", "40"],
      );
      await client.query("SAVEPOINT s1");
      await expect(client.query("SELECT 1/0")).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT s1");
      await expect(client.query("SELECT pg_sleep(1)")).rejects.toThrow();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const [ev] = drainStatementTimeouts();
    expect(ev?.tenantId).toBe("5");
    expect(ev?.budgetMs).toBe(40);
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
