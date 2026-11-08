import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import {
  capturePlan,
  PLAN_NEEDS_PG16,
  PLAN_ON_OTHER_DATABASE,
  planFailureOf,
  plannedAsOf,
  plannedScopeOf,
} from "@/modules/instance-health/database/timeouts";
import {
  driftDetail,
  driftFacts,
  setSignalDetail,
  signalDetail,
  signalFacts,
  timeoutDetail,
  timeoutFacts,
} from "@/modules/instance-health/details";

// What the database screen reads to write a signal's line and a plan failure in the console's own
// language: the parts the server already has (work, scope, budget, table, statement, mean; the
// failure's category, code and object), apart from the English sentence the alert channel, REST and
// MCP carry (docs/logs.md, "Database").

describe("a signal's parts, beside its English line", () => {
  test("a timeout keeps its work, scope, budget, table and statement as fields", () => {
    const ev = {
      label: "job:FOLLOWUP_SWEEP",
      tenantId: "1",
      fleet: false,
      budgetMs: 5_000,
      sql: "SELECT c.thread_id\n  FROM conversations c WHERE c.id = $1",
    };
    expect(timeoutFacts(ev)).toEqual({
      kind: "timeout",
      work: { kind: "job", name: "FOLLOWUP_SWEEP" },
      tenantId: "1",
      fleet: false,
      budgetMs: 5_000,
      table: "conversations",
      statement: "SELECT c.thread_id FROM conversations c WHERE c.id = $1",
    });
    setSignalDetail("statement_timeouts_per_min", timeoutFacts(ev));
    // The alert's sentence is the same one, written from the same fields.
    expect(signalDetail("statement_timeouts_per_min")).toBe(timeoutDetail(ev));
    expect(signalFacts("statement_timeouts_per_min")).toEqual(timeoutFacts(ev));
    setSignalDetail("statement_timeouts_per_min", null);
    expect(signalFacts("statement_timeouts_per_min")).toBeNull();
    expect(signalDetail("statement_timeouts_per_min")).toBeNull();
  });

  test("work with no label keeps its pool, a request and a worker their names", () => {
    const base = {
      tenantId: null,
      fleet: true,
      budgetMs: null,
      sql: "SELECT 1",
    };
    expect(
      timeoutFacts({ ...base, label: null, pool: "metrics" }).work,
    ).toEqual({ kind: "none", pool: "metrics" });
    expect(
      timeoutFacts({ ...base, label: "GET /api/v1/agents/" }).work,
    ).toEqual({ kind: "request", name: "GET /api/v1/agents/" });
    expect(timeoutFacts({ ...base, label: "debounce" }).work).toEqual({
      kind: "worker",
      name: "debounce",
    });
  });

  test("the drift line keeps its mean, budget and table as fields", () => {
    const sql = "SELECT * FROM business_hours WHERE tenant_id = $1";
    expect(driftFacts(sql, 1_300, 15_000)).toEqual({
      kind: "drift",
      meanMs: 1_300,
      budgetMs: 15_000,
      table: "business_hours",
      statement: sql,
    });
    setSignalDetail(
      "statement_mean_budget_pct",
      driftFacts(sql, 1_300, 15_000),
    );
    expect(signalDetail("statement_mean_budget_pct")).toBe(
      driftDetail(sql, 1_300, 15_000),
    );
    setSignalDetail("statement_mean_budget_pct", null);
  });
});

describe("a plan that could not be taken, by category", () => {
  const prisma = (code: string, message: string) =>
    `\nInvalid \`prisma.$queryRawUnsafe()\` invocation:\n\n\nRaw query failed. Code: \`${code}\`. Message: \`${message}\``;

  test("a permission error names the object and its kind", () => {
    expect(
      planFailureOf(
        prisma("42501", "permission denied for table business_hours"),
      ),
    ).toEqual({
      kind: "permission",
      code: "42501",
      objectType: "table",
      object: "business_hours",
    });
    expect(
      planFailureOf(prisma("42501", "permission denied for schema langgraph")),
    ).toEqual({
      kind: "permission",
      code: "42501",
      objectType: "schema",
      object: "langgraph",
    });
  });

  test("a permission error that names nothing still reads as one", () => {
    expect(
      planFailureOf(prisma("42501", "must be owner of relation x")),
    ).toEqual({
      kind: "permission",
      code: "42501",
      objectType: null,
      object: null,
    });
  });

  test("the server's own refusals and any other code have their category", () => {
    expect(planFailureOf(PLAN_NEEDS_PG16)).toEqual({ kind: "old_server" });
    expect(planFailureOf(PLAN_ON_OTHER_DATABASE)).toEqual({
      kind: "other_database",
    });
    expect(
      planFailureOf(prisma("42601", 'syntax error at or near "ROLLBACK"')),
    ).toEqual({ kind: "other", code: "42601" });
    expect(planFailureOf("connection closed")).toEqual({
      kind: "other",
      code: null,
    });
  });
});

describe("the scope a plan was taken under, as fields", () => {
  test("each stored wording reads back as the scope that wrote it", () => {
    for (const scope of [
      { fleet: true, tenantId: null },
      { fleet: false, tenantId: "7" },
      { fleet: false, tenantId: null },
    ]) {
      expect(plannedScopeOf(plannedAsOf(scope))).toEqual(scope);
    }
    expect(plannedScopeOf("something else")).toBeNull();
  });
});

describe("a server too old for EXPLAIN (GENERIC_PLAN)", () => {
  test("is named as such before the statement is sent to it", async () => {
    // A server that answers version 15 and refuses the GENERIC_PLAN option, as Postgres 15 does at
    // parse time whatever the statement's parameters.
    const sent: string[] = [];
    const tx = {
      $executeRaw: async () => 0,
      $executeRawUnsafe: async () => 0,
      $queryRaw: async (strings: TemplateStringsArray) =>
        strings.join("").includes("server_version_num") ? [{ v: 150_000 }] : [],
      $queryRawUnsafe: async (text: string) => {
        sent.push(text);
        throw Object.assign(
          new Error('unrecognized EXPLAIN option "generic_plan"'),
          { code: "42601" },
        );
      },
    };
    const base = {
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    } as unknown as PrismaClient;
    const out = await capturePlan(
      {
        sql: "SELECT * FROM agents WHERE id = $1",
        tenantId: null,
        fleet: false,
        pool: "main",
      },
      base,
    );
    expect(out).toEqual({ error: PLAN_NEEDS_PG16 });
    expect(planFailureOf(PLAN_NEEDS_PG16)).toEqual({ kind: "old_server" });
    expect(sent).toEqual([]);
  });
});
