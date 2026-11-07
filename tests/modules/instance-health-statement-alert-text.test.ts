import { describe, expect, test } from "bun:test";
import {
  driftDetail,
  statementTable,
  timeoutDetail,
} from "@/modules/instance-health/details";

// The line a statement signal's alert carries after its number: what an operator reads in the alert
// channel to know what broke without opening the database screen (docs/logs.md, "Database").

describe("the timeout alert's line", () => {
  test("names the job, the tenant, the budget and the table before the statement", () => {
    expect(
      timeoutDetail({
        label: "job:FOLLOWUP_SWEEP",
        tenantId: "1",
        fleet: false,
        budgetMs: 5_000,
        sql: "SELECT c.thread_id\n  FROM conversations c WHERE c.id = $1",
      }),
    ).toBe(
      "Last timeout: job FOLLOWUP_SWEEP, tenant 1, 5.0 s budget, on conversations. Statement: SELECT c.thread_id FROM conversations c WHERE c.id = $1",
    );
  });

  test("a request reads as one, and fleet-wide work says so instead of a tenant", () => {
    expect(
      timeoutDetail({
        label: "GET /api/v1/agents/",
        tenantId: null,
        fleet: true,
        budgetMs: null,
        sql: 'UPDATE "public"."scheduler_jobs" SET status = $1',
      }),
    ).toBe(
      'Last timeout: request GET /api/v1/agents/, all tenants, on scheduler_jobs. Statement: UPDATE "public"."scheduler_jobs" SET status = $1',
    );
  });

  test("a worker's label is named as a worker, and no label says which pool ran it", () => {
    expect(
      timeoutDetail({
        label: "webhooks:delivery",
        tenantId: null,
        fleet: true,
        budgetMs: 5_000,
        sql: "SELECT 1",
      }),
    ).toBe(
      "Last timeout: worker webhooks:delivery, all tenants, 5.0 s budget. Statement: SELECT 1",
    );
    expect(
      timeoutDetail({
        label: null,
        tenantId: null,
        fleet: false,
        budgetMs: null,
        pool: "ack",
        sql: "SELECT 1",
      }),
    ).toBe("Last timeout: work with no label (pool ack). Statement: SELECT 1");
  });
});

describe("the drift alert's line", () => {
  test("names the mean and the table before the statement", () => {
    expect(
      driftDetail(
        "WITH due AS MATERIALIZED (SELECT id FROM scheduler_jobs WHERE status = 'PENDING')",
        2_940,
      ),
    ).toBe(
      "Slowest over the last hour: 2.9 s mean, on scheduler_jobs. Statement: WITH due AS MATERIALIZED (SELECT id FROM scheduler_jobs WHERE status = 'PENDING')",
    );
  });
});

describe("statementTable: the first relation a statement reads or writes", () => {
  test.each([
    ["SELECT * FROM conversations c", "conversations"],
    [
      'SELECT "public"."agents"."id" FROM "public"."agents" WHERE 1=1',
      "agents",
    ],
    ["UPDATE alert_deliveries AS a SET status = 'SENDING'", "alert_deliveries"],
    ["INSERT INTO process_leases (id) VALUES ($1)", "process_leases"],
    [
      "DELETE FROM langgraph.checkpoint_blobs WHERE thread_id = $1",
      "langgraph.checkpoint_blobs",
    ],
  ])("%s", (sql, table) => {
    expect(statementTable(sql)).toBe(table);
  });

  test("a statement with no relation names none", () => {
    expect(statementTable("SELECT 1")).toBeNull();
    expect(statementTable("ROLLBACK")).toBeNull();
  });
});
