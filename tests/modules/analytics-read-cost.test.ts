import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { metricsPoolOptions, withJitOff } from "@/api/lib/pool-options";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  getFollowUpActivity,
  getHandoffReasons,
  getLabelOutcomes,
} from "@/modules/analytics/activity";
import type { DashboardFilter } from "@/modules/analytics/filter";
import { outcomeCountsSql } from "@/modules/analytics/service";
import { dbProbeFailed } from "@/tests/db-gate";

// WHAT A 30-DAY SCREEN COSTS THE DATABASE. The figures are fixed by analytics-dashboard.test.ts; these
// tests fix how the readers reach them, read from the plan Postgres would run: the flow-log readers
// reach their lines through the narrow index instead of the whole log, a conversation's ledger probe
// runs once however many figures use it, and the metrics pool does not pay the JIT.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let logged: PrismaClient | undefined;
const statements: { query: string; params: unknown[] }[] = [];
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
      log: [{ level: "query", emit: "event" }],
    });
    client.$on("query", (e) => {
      statements.push({ query: e.query, params: JSON.parse(e.params) });
    });
    await client.$queryRaw`SELECT 1`;
    logged = client as unknown as PrismaClient;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
const db = logged as PrismaClient;

let tenantId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});
const MONTH: DashboardFilter = {
  since: new Date("2026-09-12T03:00:00Z"),
  until: new Date("2026-10-12T03:00:00Z"),
  source: "inbox",
  tz: "America/Sao_Paulo",
};

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  Alias?: string;
  "Index Name"?: string;
  "Parent Relationship"?: string;
  Plans?: PlanNode[];
};

function nodes(n: PlanNode): PlanNode[] {
  return [n, ...(n.Plans ?? []).flatMap(nodes)];
}

// The plan of `query`, as the tenant runs it, with sequential scans priced out: what is left is the
// cheapest index the statement's own predicate lets Postgres use.
async function planOf(query: string, params: unknown[]): Promise<PlanNode> {
  return runScopedOn(db, ctx(), async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
    const [row] = await tx.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
      `EXPLAIN (FORMAT JSON) ${query}`,
      ...params,
    );
    const plan = row?.["QUERY PLAN"] as [{ Plan: PlanNode }];
    return plan[0].Plan;
  });
}

class Rollback extends Error {
  constructor(readonly plan: PlanNode) {
    super("rollback");
  }
}

// The plan of `query` as the tenant runs it, with every other index of the flow log dropped inside a
// transaction that is rolled back, and sequential scans priced out. Which index the planner picks
// among several depends on the statistics of whatever the suite wrote; this asks only whether the
// statement's own predicate lets Postgres reach its lines through the dashboard index.
async function planWithOnlyDashboardIndex(
  query: string,
  params: unknown[],
): Promise<PlanNode> {
  const role = new URL(appUrl as string).username;
  try {
    await suDb.$transaction(async (tx) => {
      const others = await tx.$queryRaw<{ name: string }[]>`
        SELECT c.relname AS name FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indrelid = 'execution_logs'::regclass AND NOT i.indisprimary
           AND c.relname <> 'execution_logs_dashboard_lines_idx'`;
      for (const o of others)
        await tx.$executeRawUnsafe(`DROP INDEX "${o.name}"`);
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      const [row] = await tx.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
        `EXPLAIN (FORMAT JSON) ${query}`,
        ...params,
      );
      const explained = row as { "QUERY PLAN": [{ Plan: PlanNode }] };
      throw new Rollback(explained["QUERY PLAN"][0].Plan);
    });
  } catch (e) {
    if (e instanceof Rollback) return e.plan;
    throw e;
  }
  throw new Error("the plan transaction committed");
}

// Every statement `read` sends that scans the flow log as its subject (alias `l`).
async function flowLogScans(read: () => Promise<unknown>) {
  statements.length = 0;
  await read();
  const sent = statements.filter((s) => /\bexecution_logs l\b/.test(s.query));
  const scans: PlanNode[] = [];
  for (const s of sent) {
    const plan = await planWithOnlyDashboardIndex(s.query, s.params);
    for (const n of nodes(plan))
      if (n["Relation Name"] === "execution_logs" && n.Alias === "l")
        scans.push(n);
  }
  return { statements: sent.length, scans };
}

beforeAll(async () => {
  if (!dbUp) return;
  const t = await suDb.tenant.create({
    data: { name: "rc", slug: `read-cost-${process.pid}` },
  });
  tenantId = t.id;
});

afterAll(async () => {
  if (dbUp && tenantId) await suDb.tenant.delete({ where: { id: tenantId } });
  await su?.$disconnect();
  await logged?.$disconnect();
});

describe.skipIf(!dbUp)("the dashboard's reads, by what they cost", () => {
  test("handoff reasons reach their lines through the dashboard index, in two statements", async () => {
    const { statements: n, scans } = await flowLogScans(() =>
      getHandoffReasons(ctx(), MONTH, db),
    );
    expect(n).toBe(2);
    expect(scans.length).toBeGreaterThan(0);
    for (const s of scans)
      expect(s["Index Name"]).toBe("execution_logs_dashboard_lines_idx");
  });

  test("follow-up activity reaches its lines through the dashboard index", async () => {
    const { statements: n, scans } = await flowLogScans(() =>
      getFollowUpActivity(ctx(), MONTH, db),
    );
    expect(n).toBe(1);
    expect(scans.length).toBeGreaterThan(0);
    for (const s of scans)
      expect(s["Index Name"]).toBe("execution_logs_dashboard_lines_idx");
  });

  test("the funnel probes the ledger once per conversation, not once per figure", async () => {
    const sql = outcomeCountsSql(MONTH);
    const probes = nodes(await planOf(sql.text, sql.values)).filter(
      (n) => n["Relation Name"] === "llm_usage",
    );
    expect(probes.length).toBe(1);
  });

  test("labels probe the ledger once per conversation, not once per figure", async () => {
    statements.length = 0;
    await getLabelOutcomes(ctx(), MONTH, db);
    const [byLabel] = statements.filter((s) =>
      /unnest\(\w+\.labels\)/.test(s.query),
    );
    expect(byLabel).toBeDefined();
    const probes = nodes(
      await planOf(
        (byLabel as { query: string }).query,
        (byLabel as { params: unknown[] }).params,
      ),
    ).filter((n) => n["Relation Name"] === "llm_usage");
    expect(probes.length).toBe(1);
  });

  test("the metrics pool runs without the JIT", async () => {
    const pool = new PrismaClient({
      adapter: new PrismaPg(metricsPoolOptions(appUrl)),
    });
    try {
      const [row] = await pool.$queryRaw<{ jit: string }[]>(
        Prisma.sql`SELECT current_setting('jit') AS jit`,
      );
      expect(row?.jit).toBe("off");
    } finally {
      await pool.$disconnect();
    }
  });
});

describe("the metrics pool's options", () => {
  test("an empty `options` in the URL is rewritten too, since `pg` would let it win", async () => {
    const { parse } = await import("pg-connection-string");
    const { connectionString } = withJitOff(
      "postgres://u:p@h:5432/db?options=",
    );
    expect(parse(connectionString as string).options).toBe("-c jit=off");
  });

  test("an `options` the URL already carries is kept, and the JIT is turned off beside it", async () => {
    const { parse } = await import("pg-connection-string");
    const { connectionString } = withJitOff(
      "postgres://u:p%40ss@h:5432/db?options=-c%20search_path%3Dx&sslmode=disable",
    );
    const parsed = parse(connectionString as string);
    expect([parsed.options, parsed.password, parsed.database]).toEqual([
      "-c search_path=x -c jit=off",
      "p@ss",
      "db",
    ]);
  });
});
