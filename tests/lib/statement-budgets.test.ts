import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { instrumentPool } from "@/lib/pool-stats";
import {
  budgetClassOf,
  budgetOfClass,
  canonicalStatement,
  noteStatementPool,
  resetStatementBudgetsForTest,
} from "@/lib/statement-budgets";
import { dbProbeFailed } from "@/tests/db-gate";

beforeEach(() => resetStatementBudgetsForTest());
afterAll(() => resetStatementBudgetsForTest());

describe("the budget class of a statement text", () => {
  test("a text only the metrics pool sent is 'metrics'", () => {
    noteStatementPool("metrics", "SELECT sum(cost_usd) FROM llm_usage");
    expect(budgetClassOf("SELECT sum(cost_usd) FROM llm_usage")).toBe(
      "metrics",
    );
  });

  test("a text another pool also sent is 'default', whichever came first", () => {
    noteStatementPool("metrics", "SELECT 1 FROM agents WHERE id = $1");
    noteStatementPool("main", "SELECT 1 FROM agents WHERE id = $1");
    expect(budgetClassOf("SELECT 1 FROM agents WHERE id = $1")).toBe("default");
    noteStatementPool("metrics", "SELECT 1 FROM agents WHERE id = $1");
    expect(budgetClassOf("SELECT 1 FROM agents WHERE id = $1")).toBe("default");
  });

  test("a text another pool sent before the metrics pool ever did stays 'default'", () => {
    noteStatementPool("main", "SELECT id FROM conversations WHERE id = $1");
    expect(budgetClassOf("SELECT id FROM conversations WHERE id = $1")).toBe(
      "default",
    );
    noteStatementPool("metrics", "SELECT id FROM conversations WHERE id = $1");
    expect(budgetClassOf("SELECT id FROM conversations WHERE id = $1")).toBe(
      "default",
    );
  });

  test("a text no pool of this process sent is unknown", () => {
    noteStatementPool("metrics", "SELECT 1 FROM llm_usage");
    expect(budgetClassOf("SELECT 1 FROM scheduler_jobs")).toBeNull();
  });

  test("the text pg_stat_statements stores matches the text sent: literals and placeholders compare equal", () => {
    noteStatementPool(
      "metrics",
      "SELECT day FROM llm_usage u\n  WHERE u.source = 'inbox' AND u.tenant_id = $1\n  LIMIT 5000",
    );
    expect(
      budgetClassOf(
        "SELECT day FROM llm_usage u WHERE u.source = $2 AND u.tenant_id = $1 LIMIT $3",
      ),
    ).toBe("metrics");
    // The server stores booleans, NULL, typed literals and signed numbers as one placeholder each:
    // the dashboard's `COUNT(*) FILTER (WHERE false)` is stored as `FILTER (WHERE $3)`.
    noteStatementPool(
      "metrics",
      "SELECT count(*) FILTER (WHERE false) AS n, NULL::bigint AS t, avg(EXTRACT(EPOCH FROM (c.resolved_at - c.created_at))) AS secs FROM firsts WHERE d > now() - interval '7 days' AND s = -1",
    );
    expect(
      budgetClassOf(
        "SELECT count(*) FILTER (WHERE $1) AS n, $2::bigint AS t, avg(EXTRACT($3 FROM (c.resolved_at - c.created_at))) AS secs FROM firsts WHERE d > now() - $4 AND s = $5",
      ),
    ).toBe("metrics");
    expect(
      canonicalStatement("SELECT t1.a FROM t1 WHERE x = 'it''s' AND y = 2.5"),
    ).toBe("SELECT t1.a FROM t1 WHERE x = ? AND y = ?");
  });

  test("an apostrophe in a comment opens no string: the server keeps the comment and replaces only the constants", () => {
    noteStatementPool(
      "metrics",
      "SELECT count(*) FROM threads t\n  -- the thread's owner, not an actor\n  WHERE t.kind = 'knowledge' AND t.state <> 'done'",
    );
    expect(
      budgetClassOf(
        "SELECT count(*) FROM threads t\n  -- the thread's owner, not an actor\n  WHERE t.kind = $1 AND t.state <> $2",
      ),
    ).toBe("metrics");
    expect(
      canonicalStatement("SELECT '--x' AS a /* it's */ FROM t WHERE b = 'y'"),
    ).toBe("SELECT ? AS a FROM t WHERE b = ?");
  });

  test("an unknown class is the transaction budget, 'metrics' the metrics one", () => {
    const budgets = { tx: 5000, metrics: 15000 };
    expect(budgetOfClass("metrics", budgets)).toBe(15000);
    expect(budgetOfClass("default", budgets)).toBe(5000);
    expect(budgetOfClass(null, budgets)).toBe(5000);
  });
});

const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
if (appUrl) {
  const probe = new Pool({ connectionString: appUrl, max: 1 });
  try {
    await probe.query("SELECT 1");
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  } finally {
    await probe.end();
  }
}

describe.skipIf(!dbUp)("the instrumented pools note what they send", () => {
  test("a statement sent through the metrics pool is 'metrics', and through another pool 'default'", async () => {
    const metrics = instrumentPool(
      "metrics",
      new Pool({ connectionString: appUrl, max: 1 }),
    );
    const main = instrumentPool(
      "main",
      new Pool({ connectionString: appUrl, max: 1 }),
    );
    try {
      await metrics.query("SELECT $1::int AS budget_probe_metrics", [1]);
      expect(budgetClassOf("SELECT $1::int AS budget_probe_metrics")).toBe(
        "metrics",
      );
      await main.query("SELECT $1::int AS budget_probe_metrics", [2]);
      expect(budgetClassOf("SELECT $1::int AS budget_probe_metrics")).toBe(
        "default",
      );
    } finally {
      await metrics.end();
      await main.end();
    }
  });
});
