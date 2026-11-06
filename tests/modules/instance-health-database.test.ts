import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { requestContext } from "@/api/lib/i18n";
import config from "@/config";
import { MetricsTooSlowError } from "@/lib/errors";
import {
  drainStatementTimeouts,
  resetStatementTimeouts,
} from "@/lib/pool-stats";
import { asSuperAdminOn, DeadlinePassedError } from "@/lib/tenancy";
import { registerFollowUpHandlers } from "@/modules/followups/handlers";
import { fleetWithin } from "@/modules/instance-health/database/budget";
import {
  deadRows,
  isOwnStatement,
  probeAvailability,
  readDatabaseScreen,
  slowestMeanShare,
  sparkBuckets,
  statementTotals,
} from "@/modules/instance-health/database/read";
import {
  type Counters,
  deltasOf,
  lastAvailability,
  pruneDatabaseScreen,
  resetSnapshotState,
  type StatementEntry,
  setLastAvailabilityForTest,
  snapshotIfDue,
  statementColumns,
  takeStatsRole,
} from "@/modules/instance-health/database/snapshot";
import {
  DRIFT_SIGNAL,
  databaseScreenTick,
} from "@/modules/instance-health/database/tick";
import {
  capturePlan,
  flushStatementTimeouts,
  statementFingerprint,
} from "@/modules/instance-health/database/timeouts";
import {
  DATABASE_SIGNALS,
  readDatabaseView,
  signalState,
} from "@/modules/instance-health/database/view";
import {
  setSignalDetail,
  signalDetail,
  statementLine,
} from "@/modules/instance-health/details";
import { firingSummary } from "@/modules/instance-health/evaluator";
import {
  resetSamplerState,
  type SamplerSources,
  sampleOnce,
} from "@/modules/instance-health/sampler";
import { getJobHandler } from "@/modules/scheduler/worker";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";

// The database screen against a real database (docs/logs.md, "Database"): the deltas a snapshot writes
// (with resets), the window sums over them, the plan captured under the scope a statement ran in, one plan per
// statement per window, retention, and a database without pg_stat_statements. The extension is not
// loaded on the test server, so the deltas are seeded the way the sampler writes them. The tables
// are the instance's and only this file writes them, so each test starts from empty.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const MIN = 60_000;

async function wipe(): Promise<void> {
  await suDb.$executeRaw`DELETE FROM db_statement_deltas`;
  await suDb.$executeRaw`DELETE FROM db_statement_texts`;
  await suDb.$executeRaw`DELETE FROM db_stat_snapshot_runs`;
  await suDb.$executeRaw`DELETE FROM db_table_snapshots`;
  await suDb.$executeRaw`DELETE FROM db_statement_timeouts`;
}

async function seed(
  queryid: bigint,
  // Deltas, as the sampler writes them: what the entry did in the interval ending at `at`.
  points: {
    at: number;
    calls: number;
    total: number;
    rows?: number;
  }[],
  query = `SELECT $1 /* q${queryid} */`,
  userid = 10n,
): Promise<void> {
  for (const p of points) {
    await suDb.dbStatementDelta.create({
      data: {
        takenAt: new Date(p.at),
        userid,
        dbid: 1n,
        queryid,
        calls: BigInt(p.calls),
        totalExecMs: p.total,
        rows: BigInt(p.rows ?? p.calls),
      },
    });
  }
  await suDb.dbStatementText.upsert({
    where: { userid_dbid_queryid: { userid, dbid: 1n, queryid } },
    create: {
      userid,
      dbid: 1n,
      queryid,
      query,
      lastSeenAt: new Date(points[points.length - 1]?.at ?? T0),
    },
    update: { query },
  });
}

afterAll(async () => {
  if (dbUp) await wipe();
});

describe("the two signals and what their alert says", () => {
  const sources = (over: Partial<SamplerSources>): SamplerSources => ({
    now: () => T0,
    eventLoopP99Ms: () => 0,
    modelPermitWaiters: () => 0,
    modelPermitOldestMs: () => 0,
    debounceLaneFullMs: () => 0,
    ingressLagP95Ms: () => 0,
    readDatabase: async () => ({ kindAges: {}, chatwootPendingOldestMs: 0 }),
    ...over,
  });

  test("a sample carries the timeouts per minute and the drift share, and the timeout alert names the work and the statement", async () => {
    resetSamplerState();
    const values = await sampleOnce(
      sources({
        statementTimeoutsPerMinute: () => 3,
        lastStatementTimeout: () => ({
          sql: "SELECT c.thread_id\n  FROM conversations c",
          label: "job:FOLLOWUP_SWEEP",
        }),
        databaseScreen: async () => 64,
      }),
      { database: true },
    );
    expect(values.statement_timeouts_per_min).toBe(3);
    expect(values.statement_mean_budget_pct).toBe(64);
    const summary = firingSummary("statement_timeouts_per_min", 3, {
      threshold: 0,
      durationSeconds: 0,
      enabled: true,
    });
    expect(summary).toContain(
      "statement_timeouts_per_min is 3/min, above 0/min.",
    );
    expect(summary).toBe(
      "statement_timeouts_per_min is 3/min, above 0/min. Last timeout: job FOLLOWUP_SWEEP, on conversations. Statement: SELECT c.thread_id FROM conversations c",
    );
  });

  test("a database screen that fails to read records no point, so the drift signal ages instead of reading fresh", async () => {
    resetSamplerState();
    const values = await sampleOnce(
      sources({
        databaseScreen: async () => {
          throw new Error("connection refused");
        },
      }),
      { database: true },
    );
    expect("statement_mean_budget_pct" in values).toBe(false);
  });

  test("with no recent timeout the alert carries no stale name", async () => {
    resetSamplerState();
    await sampleOnce(sources({ lastStatementTimeout: () => null }), {
      database: false,
    });
    expect(signalDetail("statement_timeouts_per_min")).toBeNull();
    expect(
      firingSummary("statement_timeouts_per_min", 1, {
        threshold: 0,
        durationSeconds: 0,
        enabled: true,
      }),
    ).toBe("statement_timeouts_per_min is 1/min, above 0/min.");
  });

  test("the drift share reads as a percent", () => {
    setSignalDetail(
      "statement_mean_budget_pct",
      "Slowest over the last hour: SELECT 1",
    );
    expect(
      firingSummary("statement_mean_budget_pct", 61.4, {
        threshold: 50,
        durationSeconds: 0,
        enabled: true,
      }),
    ).toBe(
      "statement_mean_budget_pct is 61%, above 50%. Slowest over the last hour: SELECT 1",
    );
    setSignalDetail("statement_mean_budget_pct", null);
  });
});

describe("deltasOf: what a snapshot run writes", () => {
  const entry = (
    calls: number,
    statsSince: Date | null = null,
    queryid = 7n,
  ): StatementEntry => ({
    userid: 10n,
    dbid: 1n,
    queryid,
    query: "SELECT 1",
    calls,
    totalExecMs: calls * 2,
    rows: calls,
    statsSince,
  });
  const counters = (calls: number, statsSince: number | null = null) =>
    new Map<string, Counters>([
      ["10:1:7", { calls, totalExecMs: calls * 2, rows: calls, statsSince }],
    ]);
  const calls = (out: ReturnType<typeof deltasOf>) =>
    out.map((d) => d.delta.calls);

  test("an entry seen before writes the difference, and one that did not run writes nothing", () => {
    expect(
      calls(
        deltasOf({
          entries: [entry(1030)],
          previous: counters(1000),
          previousComplete: true,
        }),
      ),
    ).toEqual([30]);
    expect(
      deltasOf({
        entries: [entry(1000)],
        previous: counters(1000),
        previousComplete: true,
      }),
    ).toEqual([]);
  });

  test("a counter that went down is a reset: what the entry holds is what it did since", () => {
    expect(
      calls(
        deltasOf({
          entries: [entry(10)],
          previous: counters(510),
          previousComplete: true,
        }),
      ),
    ).toEqual([10]);
  });

  test("fewer calls is a reset even when the time and the rows did not go down", () => {
    const out = deltasOf({
      entries: [{ ...entry(10), totalExecMs: 5000, rows: 5 }],
      previous: new Map<string, Counters>([
        [
          "10:1:7",
          { calls: 510, totalExecMs: 1020, rows: 5, statsSince: null },
        ],
      ]),
      previousComplete: true,
    });
    expect(out.map((d) => d.delta)).toEqual([
      { calls: 10, totalExecMs: 5000, rows: 5 },
    ]);
  });

  test("a moved stats_since is a reset even when the counters happen to be higher", () => {
    expect(
      calls(
        deltasOf({
          entries: [entry(8, new Date(T0 + 2 * MIN))],
          previous: counters(3, T0 - 60 * MIN),
          previousComplete: true,
        }),
      ),
    ).toEqual([8]);
  });

  test("an entry the previous complete read did not have started since: all it holds counts", () => {
    expect(
      calls(
        deltasOf({
          entries: [entry(4, null, 99n)],
          previous: counters(1000),
          previousComplete: true,
        }),
      ),
    ).toEqual([4]);
  });

  test("an entry missing from a read cut at the cap proves nothing: it writes no row yet", () => {
    expect(
      deltasOf({
        entries: [entry(4, null, 99n)],
        previous: counters(1000),
        previousComplete: false,
      }),
    ).toEqual([]);
  });

  test("no difference is ever negative", () => {
    const out = deltasOf({
      entries: [entry(5), entry(3, null, 99n)],
      previous: new Map<string, Counters>([
        ["10:1:7", { calls: 5, totalExecMs: 20, rows: 5, statsSince: null }],
        ["10:1:99", { calls: 9, totalExecMs: 1, rows: 9, statsSince: null }],
      ]),
      previousComplete: true,
    });
    for (const d of out) {
      expect(d.delta.calls).toBeGreaterThanOrEqual(0);
      expect(d.delta.totalExecMs).toBeGreaterThanOrEqual(0);
      expect(d.delta.rows).toBeGreaterThanOrEqual(0);
    }
  });
});

describe.skipIf(!dbUp)("database screen against a real database", () => {
  beforeEach(async () => {
    await wipe();
    resetSnapshotState();
  });

  test("a window is the sum of the deltas inside it, and nothing before it", async () => {
    await seed(1n, [
      { at: T0, calls: 1000, total: 1000 },
      { at: T0 + 5 * MIN, calls: 10, total: 20 },
      { at: T0 + 10 * MIN, calls: 20, total: 40 },
    ]);
    const [t] = await asSuperAdminOn(appDb, (db) =>
      statementTotals(db, new Date(T0), new Date(T0 + 10 * MIN)),
    );
    expect(t?.calls).toBe(30);
    expect(t?.total_ms).toBe(60);
  });

  test("the first snapshot after a start writes no deltas, and the next writes what ran between them", async () => {
    resetSnapshotState();
    const t = Date.now();
    expect(await snapshotIfDue(appDb, t, { force: true })).toBe(true);
    // Whatever the counters held before this process started is not attributed to any interval.
    expect(await suDb.dbStatementDelta.count()).toBe(0);
    // The marker is an identifier: pg_stat_statements replaces literals with placeholders.
    const marker = "SELECT $1::int AS delta_probe";
    for (let i = 0; i < 3; i++) await appDb.$queryRawUnsafe(marker, i);
    expect(await snapshotIfDue(appDb, t + 1, { force: true })).toBe(true);
    const availability = lastAvailability();
    const probe = await suDb.$queryRaw<{ calls: bigint }[]>`
      SELECT d.calls FROM db_statement_deltas d
        JOIN db_statement_texts x USING (userid, dbid, queryid)
       WHERE x.query LIKE '%delta_probe%'`;
    if (availability?.available) {
      // The second read's difference holds the three calls made between the two snapshots.
      expect(probe.map((r) => Number(r.calls))).toEqual([3]);
    } else {
      // Without the extension there is nothing to difference, and nothing is invented.
      expect(probe).toEqual([]);
    }
  });

  test("the screen's rows never carry a negative figure, in any window", async () => {
    const now = Date.now();
    await seed(4n, [
      { at: now - 20 * MIN, calls: 900, total: 900 },
      { at: now - 10 * MIN, calls: 2, total: 1 },
      { at: now - 5 * MIN, calls: 10, total: 20 },
    ]);
    await suDb.dbStatSnapshotRun.createMany({
      data: [20, 10, 5].map((m) => ({
        takenAt: new Date(now - m * MIN),
        statementsAvailable: true,
      })),
    });
    for (const w of ["1h", "24h", "7d"] as const) {
      const screen = await readDatabaseScreen(w, appDb, now);
      if (!screen.statements.available) continue;
      for (const r of [
        ...screen.statements.byTotal,
        ...screen.statements.byMean,
      ]) {
        for (const v of [r.calls, r.rows, r.totalMs, r.meanMs]) {
          expect(v).toBeGreaterThanOrEqual(0);
        }
        for (const p of r.spark)
          if (p !== null) expect(p).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("the drift signal is the slowest mean over the last hour as a share of the budget, with its text", async () => {
    const now = Date.now();
    // The application's own role: only what it runs had DB_TX_TIMEOUT_MS as its limit.
    const [app] = await appDb.$queryRaw<{ oid: bigint }[]>`
      SELECT oid::bigint AS oid FROM pg_roles WHERE rolname = session_user`;
    const appRole = app?.oid ?? 0n;
    await seed(
      5n,
      [
        { at: now - 30 * MIN, calls: 4, total: 1200 },
        { at: now - 5 * MIN, calls: 6, total: 1800 },
      ],
      "SELECT c.thread_id FROM conversations c WHERE c.status = $1",
      appRole,
    );
    await seed(
      6n,
      [
        { at: now - 30 * MIN, calls: 1000, total: 1000 },
        { at: now - 5 * MIN, calls: 2000, total: 2000 },
      ],
      undefined,
      appRole,
    );
    // Slower, but run by another user (an operator's psql session): not measured.
    await seed(
      7n,
      [
        { at: now - 30 * MIN, calls: 1, total: 4000 },
        { at: now - 5 * MIN, calls: 1, total: 4000 },
      ],
      "SELECT pg_sleep($1)",
      appRole + 999_999n,
    );
    const { pct, query, meanMs } = await slowestMeanShare(appDb, now, 500);
    // (1200 + 1800) / (4 + 6) = 300 ms, 60% of a 500 ms budget.
    expect(pct).toBeCloseTo(60, 5);
    expect(meanMs).toBeCloseTo(300, 5);
    expect(query).toContain("SELECT c.thread_id FROM conversations");
  });

  test("after a restart the drift comes from the stored deltas, before this process takes its first snapshot", async () => {
    const now = Date.now();
    const [app] = await appDb.$queryRaw<{ oid: bigint }[]>`
      SELECT oid::bigint AS oid FROM pg_roles WHERE rolname = session_user`;
    await seed(
      8n,
      [
        { at: now - 20 * MIN, calls: 4, total: 2400 },
        { at: now - 2 * MIN, calls: 6, total: 3600 },
      ],
      "SELECT c.id FROM conversations c WHERE c.contact_id = $1",
      app?.oid ?? 0n,
    );
    // The last run two minutes ago: the next snapshot is not due, so availability stays unknown.
    await suDb.dbStatSnapshotRun.create({
      data: { takenAt: new Date(now - 2 * MIN), statementsAvailable: true },
    });
    setSignalDetail(DRIFT_SIGNAL, null);
    const value = await databaseScreenTick(now, appDb);
    // (2400 + 3600) / (4 + 6) = 600 ms, as a share of DB_TX_TIMEOUT_MS.
    expect(Math.round(value)).toBe(
      Math.round((600 / config.dbTx.timeoutMs) * 100),
    );
    expect(signalDetail(DRIFT_SIGNAL) ?? "").toContain(
      "SELECT c.id FROM conversations",
    );
  });

  test("without pg_stat_statements loaded, the screen explains how to enable it and the rest still answers", async () => {
    // A server that preloads it (the shipped compose files) has it created by db:test:setup, so the
    // absence is arranged here and undone after, whatever the server is.
    const [ext] = await suDb.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS present`;
    await suDb.$executeRawUnsafe("DROP EXTENSION IF EXISTS pg_stat_statements");
    let screen: Awaited<ReturnType<typeof readDatabaseScreen>>;
    try {
      const took = await snapshotIfDue(appDb, Date.now(), { force: true });
      expect(took).toBe(true);
      screen = await readDatabaseScreen("1h", appDb);
    } finally {
      if (ext?.present) {
        await suDb.$executeRawUnsafe(
          "CREATE EXTENSION IF NOT EXISTS pg_stat_statements",
        );
      }
    }
    expect(screen.statements.available).toBe(false);
    if (!screen.statements.available) {
      expect(screen.statements.enable).toContain(
        "shared_preload_libraries = 'pg_stat_statements'",
      );
      expect(screen.statements.enable).toContain(
        "pg_stat_statements.track = top",
      );
      expect(screen.statements.enable).toContain(
        "pg_stat_statements.track_utility = off",
      );
      // Dropped here, so not created: the statement that creates it is part of the instructions.
      expect(screen.statements.reason).toBe("not_created");
      expect(screen.statements.create).toBe(
        "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;",
      );
    }
    expect(screen.tables.some((t) => t.table === "conversations")).toBe(true);
    const runs = await suDb.dbStatSnapshotRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.statementsAvailable).toBe(false);
    expect(await suDb.dbTableSnapshot.count()).toBeGreaterThan(0);
  });

  test("the checkpointer's own schema is on the screen, its tables named with the schema", async () => {
    // A table of its own in `langgraph` (created when missing), so the test does not depend on the
    // checkpointer having run here, and dropped after.
    const probe = `screen_probe_${process.pid}`;
    await suDb.$executeRawUnsafe("CREATE SCHEMA IF NOT EXISTS langgraph");
    await suDb.$executeRawUnsafe(
      `CREATE TABLE langgraph.${probe} (id int PRIMARY KEY, note text)`,
    );
    await suDb.$executeRawUnsafe(
      `CREATE INDEX ${probe}_note_idx ON langgraph.${probe} (note)`,
    );
    // The screen lists the 50 largest never-read indexes, and a shared test database holds more than
    // 50 empty ones: a few MB of rows put the probe's index at the top of that list.
    await suDb.$executeRawUnsafe(
      `INSERT INTO langgraph.${probe} SELECT g, md5(g::text) || md5((g * 7)::text) FROM generate_series(1, 30000) g`,
    );
    try {
      // Statistics views are fed asynchronously; reading them in this session sees the table.
      expect(await snapshotIfDue(appDb, Date.now(), { force: true })).toBe(
        true,
      );
      const stored = await suDb.dbTableSnapshot.findMany({
        where: { tableName: `langgraph.${probe}` },
      });
      expect(stored).toHaveLength(1);
      const screen = await readDatabaseScreen("1h", appDb);
      expect(screen.tables.map((t) => t.table)).toContain(`langgraph.${probe}`);
      expect(screen.tables.map((t) => t.table)).toContain("conversations");
      expect(screen.unusedIndexes.map((u) => u.table)).toContain(
        `langgraph.${probe}`,
      );
    } finally {
      await suDb.$executeRawUnsafe(`DROP TABLE langgraph.${probe}`);
    }
  });

  test("a snapshot is not taken again before five minutes have passed", async () => {
    const now = Date.now();
    expect(await snapshotIfDue(appDb, now, { force: true })).toBe(true);
    expect(await snapshotIfDue(appDb, now + 4 * MIN)).toBe(false);
    expect(await snapshotIfDue(appDb, now + 5 * MIN)).toBe(true);
    expect(await suDb.dbStatSnapshotRun.count()).toBe(2);
  });

  test("retention drops what is older than the cutoff and keeps the rest", async () => {
    const now = Date.now();
    const day = 24 * 60 * MIN;
    await seed(8n, [
      { at: now - 8 * day, calls: 1, total: 1 },
      { at: now - 6 * day, calls: 2, total: 2 },
    ]);
    await suDb.dbStatSnapshotRun.createMany({
      data: [8, 6].map((d) => ({
        takenAt: new Date(now - d * day),
        statementsAvailable: true,
      })),
    });
    await pruneDatabaseScreen(appDb, now, 7);
    const left = await suDb.dbStatementDelta.findMany();
    expect(
      left.map((r) => Math.round((now - r.takenAt.getTime()) / day)),
    ).toEqual([6]);
    expect(await suDb.dbStatSnapshotRun.count()).toBe(1);
  });

  test("a timeout's plan is captured as the application role under the tenant it ran for", async () => {
    const result = await capturePlan(
      {
        sql: 'SELECT "id" FROM "conversations" WHERE "status" = $1 LIMIT $2',
        tenantId: "1",
        fleet: false,
      },
      appDb,
    );
    expect("plan" in result).toBe(true);
    if (!("plan" in result)) return;
    // The tenant policy's predicate is in the plan: RLS was in force when it was planned.
    expect(result.plan).toContain("current_setting('app.tenant_id'");
    // And the transaction that planned carried that tenant, read back from Postgres.
    expect(result.plannedAs).toBe("application role, tenant 1");
    // EXPLAIN without ANALYZE: nothing ran.
    expect(result.plan).not.toMatch(/actual time|Execution Time/i);
    // As the owner the same statement has no tenant predicate, which is the plan this must not be.
    const owner = await suDb.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
      'EXPLAIN (GENERIC_PLAN) SELECT "id" FROM "conversations" WHERE "status" = $1 LIMIT $2',
    );
    expect(owner.map((r) => r["QUERY PLAN"]).join("\n")).not.toContain(
      "current_setting('app.tenant_id'",
    );
  });

  test("a fleet timeout is planned as the fleet role", async () => {
    const result = await capturePlan(
      {
        sql: 'SELECT "id" FROM "tenants" LIMIT $1',
        tenantId: null,
        fleet: true,
      },
      appDb,
    );
    expect("plannedAs" in result ? result.plannedAs : result.error).toBe(
      "fleet role",
    );
  });

  test("a stored statement keeps its line breaks, so a `--` comment still ends where it did", async () => {
    resetStatementTimeouts();
    const sql =
      'SELECT "id" -- the comment ends here\n  FROM "agents" WHERE "kind" = $1';
    await flushStatementTimeouts(appDb, [
      {
        at: Date.now(),
        sql,
        label: "job:FOLLOWUP_SWEEP",
        tenantId: "1",
        fleet: false,
        budgetMs: 5000,
      },
    ]);
    const [row] = await suDb.dbStatementTimeout.findMany({
      where: { fingerprint: statementFingerprint(sql) },
    });
    expect(row?.statement).toBe(sql);
    // The alert's one line leaves the comment out instead of running the rest of the SQL into it.
    expect(statementLine(sql)).toBe(
      'SELECT "id" FROM "agents" WHERE "kind" = $1',
    );
  });

  test("a flush plans one statement per call and leaves the next one queued with its first occurrence", async () => {
    resetStatementTimeouts();
    const at = Date.now();
    const ev = (sql: string, i: number) => ({
      at: at + i,
      sql,
      label: "job:FOLLOWUP_SWEEP",
      tenantId: "1",
      fleet: false,
      budgetMs: 5000,
    });
    const a = 'SELECT "id" FROM "agents" WHERE "kind" = $1';
    const b = 'SELECT "id" FROM "agents" WHERE "mode" = $1';
    expect(
      await flushStatementTimeouts(appDb, [ev(a, 0), ev(b, 1), ev(b, 2)], 1),
    ).toBe(1);
    // Both occurrences of the second statement wait for the next call, the first one first.
    const queued = drainStatementTimeouts();
    expect(queued.map((e) => e.at)).toEqual([at + 1, at + 2]);
    expect(await flushStatementTimeouts(appDb, queued, 1)).toBe(2);
    const rows = await suDb.dbStatementTimeout.findMany({
      where: { fingerprint: statementFingerprint(b) },
      orderBy: { occurredAt: "asc" },
    });
    expect(rows.map((r) => r.plan !== null)).toEqual([true, false]);
  });

  test("a tick whose snapshot cannot be read throws instead of returning the last value", async () => {
    const down = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: "postgresql://nobody:nothing@127.0.0.1:1/none",
      }),
    });
    try {
      resetSnapshotState();
      await expect(databaseScreenTick(Date.now(), down)).rejects.toThrow();
    } finally {
      await down.$disconnect();
    }
  });

  test("a tick whose snapshot fails to write throws, even when the drift could still be computed", async () => {
    // Only the snapshot's run row is refused; every read, the drift's included, still works.
    const failing = new Proxy(appDb, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
          target.$transaction(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(t, p, r) {
                    const v = Reflect.get(t, p, r);
                    if (p !== "dbStatSnapshotRun") return v;
                    return new Proxy(v as object, {
                      get(d, m, dr) {
                        if (m === "create") {
                          return async () => {
                            throw new Error("snapshot refused");
                          };
                        }
                        return Reflect.get(d, m, dr);
                      },
                    });
                  },
                }),
              ),
            opts as never,
          );
      },
    }) as PrismaClient;
    resetSnapshotState();
    await expect(databaseScreenTick(Date.now(), failing)).rejects.toThrow(
      "snapshot refused",
    );
  });

  test("a budget reused across transactions opens each one with what is left of its deadline", async () => {
    // A budget made with five seconds to spare, reused after most of them went: the deadline is 150 ms
    // away, the allowance it was made with is not.
    const stale = { maxWait: 5000, timeout: 5000, deadline: Date.now() + 150 };
    // A pool of one connection, held, so the next transaction can only wait for it.
    const one = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl as string, max: 1 }),
    });
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let held: () => void = () => {};
      const isHeld = new Promise<void>((r) => {
        held = r;
      });
      const holder = one.$transaction(
        async () => {
          held();
          await gate;
        },
        { timeout: 10_000 },
      );
      await isHeld;
      const started = Date.now();
      await expect(
        fleetWithin(one, stale, (db) => db.$queryRaw`SELECT 1`),
      ).rejects.toThrow();
      // It gave up at the deadline, not after the five seconds the budget was made with.
      expect(Date.now() - started).toBeLessThan(2000);
      release();
      await holder;
      // Once the deadline is spent, nothing opens at all.
      await expect(
        fleetWithin(
          one,
          { ...stale, deadline: Date.now() - 1 },
          (db) => db.$queryRaw`SELECT 1`,
        ),
      ).rejects.toBeInstanceOf(DeadlinePassedError);
    } finally {
      await one.$disconnect();
    }
  });

  test("timeouts that cannot be stored go back to the queue, and one that keeps failing is dropped after three ticks", async () => {
    resetStatementTimeouts();
    const down = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: "postgresql://nobody:nothing@127.0.0.1:1/none",
      }),
    });
    const ev = (i: number) => ({
      at: Date.now() + i,
      sql: `SELECT ${i}`,
      label: null,
      tenantId: null,
      fleet: false,
      budgetMs: 1000,
    });
    const first = ev(1);
    const second = ev(2);
    try {
      expect(await flushStatementTimeouts(down, [first, second])).toBe(0);
      expect(drainStatementTimeouts()).toEqual([first, second]);
      await flushStatementTimeouts(down, [first, second]);
      drainStatementTimeouts();
      await flushStatementTimeouts(down, [first, second]);
      // The first failed three times; the second was never tried, so it stays.
      expect(drainStatementTimeouts()).toEqual([second]);
    } finally {
      await down.$disconnect();
    }
  });

  test("timeout counts cover the whole window, so a storm of one statement hides no other", async () => {
    const now = Date.now();
    const storm = statementFingerprint("SELECT storm");
    await suDb.dbStatementTimeout.createMany({
      data: Array.from({ length: 2100 }, (_, i) => ({
        occurredAt: new Date(now - i * 100),
        fingerprint: storm,
        statement: "SELECT storm",
        fleet: false,
      })),
    });
    await suDb.dbStatementTimeout.create({
      data: {
        occurredAt: new Date(now - 50 * MIN),
        fingerprint: statementFingerprint("SELECT earlier"),
        statement: "SELECT earlier",
        fleet: false,
      },
    });
    const screen = await readDatabaseScreen("1h", appDb, now);
    const counts = Object.fromEntries(
      screen.timeouts.map((t) => [t.statement, t.occurrences]),
    );
    expect(counts).toEqual({ "SELECT storm": 2100, "SELECT earlier": 1 });
  });

  test("a NOINHERIT member of pg_read_all_stats reads statistics under that role, and only then", async () => {
    const roles = await suDb
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "CREATE ROLE stats_probe_noinherit NOINHERIT",
        );
        await tx.$executeRawUnsafe("CREATE ROLE stats_probe_inherit INHERIT");
        await tx.$executeRawUnsafe(
          "GRANT pg_read_all_stats TO stats_probe_noinherit, stats_probe_inherit",
        );
        const seen: string[] = [];
        for (const role of ["stats_probe_noinherit", "stats_probe_inherit"]) {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
          await takeStatsRole(tx as unknown as PrismaClient);
          const [r] = await tx.$queryRaw<
            { u: string }[]
          >`SELECT current_user::text AS u`;
          seen.push(r?.u ?? "");
          await tx.$executeRawUnsafe("RESET ROLE");
        }
        // Rolled back: the probe roles never outlive the test.
        throw Object.assign(new Error("rollback"), { seen });
      })
      .catch((e: { seen?: string[] }) => e.seen);
    expect(roles).toEqual(["pg_read_all_stats", "stats_probe_inherit"]);
  });

  test("an extension that is there but could not be read fails the tick instead of reading 0", async () => {
    // A recent run, so the tick takes no snapshot of its own and reads the availability set here.
    await suDb.dbStatSnapshotRun.create({
      data: { takenAt: new Date(Date.now() - MIN), statementsAvailable: false },
    });
    resetSnapshotState();
    setLastAvailabilityForTest({ available: false, reason: "unreadable" });
    await expect(databaseScreenTick(Date.now(), appDb)).rejects.toThrow(
      "could not be read",
    );
    // An extension that is simply absent still reads 0, which is a measurement.
    setLastAvailabilityForTest({ available: false, reason: "not_loaded" });
    expect(await databaseScreenTick(Date.now(), appDb)).toBe(0);
  });

  test("the version-dependent columns are read from the installed view, not from the server version", async () => {
    const seen = await suDb
      .$transaction(async (tx) => {
        // A view shaped like pg_stat_statements 1.10: toplevel, no stats_since.
        await tx.$executeRawUnsafe("CREATE SCHEMA pss_probe");
        await tx.$executeRawUnsafe(
          "CREATE VIEW pss_probe.pg_stat_statements AS SELECT true AS toplevel, 1::bigint AS calls",
        );
        await tx.$executeRawUnsafe("SET LOCAL search_path = pss_probe");
        const cols = await statementColumns(tx as unknown as PrismaClient);
        // Rolled back: the probe schema never outlives the test.
        throw Object.assign(new Error("rollback"), { cols: [...cols].sort() });
      })
      .catch((e: { cols?: string[] }) => e.cols);
    expect(seen).toEqual(["toplevel"]);
  });

  test("the availability probe runs under the request's deadline and answers within it", async () => {
    // A deadline already spent: refused before any statement is sent, never a wait.
    const spent = await probeAvailability(appDb, {
      maxWait: 1,
      timeout: 1,
      deadline: Date.now() - 1,
    });
    expect(spent).toEqual({ available: false, reason: "unreadable" });
    // With time left it answers what the server has: absent, not preloaded, or readable.
    const live = await probeAvailability(appDb, {
      maxWait: 5000,
      timeout: 5000,
      deadline: Date.now() + 5000,
    });
    expect(
      live.available || ["not_created", "not_loaded"].includes(live.reason),
    ).toBe(true);
  });

  test("a checkpointer timeout is not planned when the checkpointer has a database of its own", async () => {
    const saved = config.langgraphDatabaseUrl;
    (
      config as { langgraphDatabaseUrl: string | undefined }
    ).langgraphDatabaseUrl = "postgresql://elsewhere/langgraph";
    try {
      const other = await capturePlan(
        {
          sql: "SELECT checkpoint FROM checkpoints WHERE thread_id = $1",
          tenantId: null,
          fleet: false,
          pool: "checkpointer",
        },
        appDb,
      );
      expect("error" in other ? other.error : "").toContain("checkpointer");
    } finally {
      (
        config as { langgraphDatabaseUrl: string | undefined }
      ).langgraphDatabaseUrl = saved;
    }
    // Sharing the application database, it is planned like any other statement.
    (
      config as { langgraphDatabaseUrl: string | undefined }
    ).langgraphDatabaseUrl = config.databaseUrl;
    try {
      const same = await capturePlan(
        {
          sql: 'SELECT "id" FROM "agents" LIMIT $1',
          tenantId: "1",
          fleet: false,
          pool: "checkpointer",
        },
        appDb,
      );
      expect("plan" in same).toBe(true);
    } finally {
      (
        config as { langgraphDatabaseUrl: string | undefined }
      ).langgraphDatabaseUrl = saved;
    }
  });

  test("a flush stops at its time budget and puts the rest back", async () => {
    resetStatementTimeouts();
    const ev = (i: number) => ({
      at: Date.now() + i,
      sql: `SELECT ${i}`,
      label: null,
      tenantId: null,
      fleet: false,
      budgetMs: 1000,
    });
    const events = [ev(1), ev(2), ev(3)];
    // A budget already spent: nothing is attempted, everything waits for the next tick.
    expect(await flushStatementTimeouts(appDb, events, 1, 0)).toBe(0);
    expect(drainStatementTimeouts()).toEqual(events);
  });

  test("the flush's deadline reaches its statements: an event the time ran out under goes back, never counted as a failure", async () => {
    resetStatementTimeouts();
    const ev = {
      at: Date.now(),
      sql: 'SELECT "id" FROM "agents" WHERE "name" = $1',
      label: null,
      tenantId: "1",
      fleet: false,
      budgetMs: 1000,
    };
    // Three calls with a 1 ms budget: each runs out inside its statements, and the event is still
    // queued after the third, which it would not be if each counted as a failed attempt.
    for (let i = 0; i < 3; i++) {
      expect(await flushStatementTimeouts(appDb, [ev], 1, 1)).toBe(0);
      expect(drainStatementTimeouts()).toEqual([ev]);
    }
    expect(
      await suDb.dbStatementTimeout.count({
        where: { fingerprint: statementFingerprint(ev.sql) },
      }),
    ).toBe(0);
  });

  test("the monitoring's own statements never count for drift", () => {
    for (const q of [
      "EXPLAIN (GENERIC_PLAN) SELECT 1",
      "SELECT fingerprint, count(*) FROM db_statement_timeouts GROUP BY fingerprint",
      "SELECT userid, query FROM db_statement_texts WHERE true",
      "INSERT INTO db_table_snapshots (table_name) VALUES ($1)",
      "SELECT taken_at FROM db_stat_snapshot_runs",
      "SELECT relname FROM pg_stat_user_indexes",
    ]) {
      expect(isOwnStatement(q)).toBe(true);
    }
    expect(
      isOwnStatement('SELECT "id" FROM "conversations" WHERE "status" = $1'),
    ).toBe(false);
  });

  test("a plan that uses up the flush's time does not keep the occurrence from being stored", async () => {
    resetStatementTimeouts();
    await suDb.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS plan_lock_probe (id int)",
    );
    await suDb.$executeRawUnsafe("GRANT SELECT ON plan_lock_probe TO PUBLIC");
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    // Another session holds the table exclusively, so planning a statement on it waits.
    const holder = suDb.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          "LOCK TABLE plan_lock_probe IN ACCESS EXCLUSIVE MODE",
        );
        locked();
        await held;
      },
      { timeout: 20_000, maxWait: 5_000 },
    );
    try {
      await isLocked;
      const sql = "SELECT id FROM plan_lock_probe WHERE id = $1";
      const stored = await flushStatementTimeouts(
        appDb,
        [
          {
            at: Date.now(),
            sql,
            label: null,
            tenantId: null,
            fleet: false,
            budgetMs: 1000,
          },
        ],
        1,
        1_500,
      );
      expect(stored).toBe(1);
      const rows = await suDb.dbStatementTimeout.findMany({
        where: { fingerprint: statementFingerprint(sql) },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.plan).toBeNull();
    } finally {
      release();
      await holder;
      await suDb.$executeRawUnsafe("DROP TABLE IF EXISTS plan_lock_probe");
    }
  });

  test("a plan without a scope honours the deadline too", async () => {
    const result = await capturePlan(
      {
        sql: 'SELECT "id" FROM "agents" LIMIT $1',
        tenantId: null,
        fleet: false,
      },
      appDb,
      // Generous per-transaction numbers, a deadline already spent: the deadline is what decides.
      { maxWait: 5_000, timeout: 5_000, deadline: Date.now() - 1 },
    );
    expect("error" in result).toBe(true);
  });

  test("a snapshot whose retention prune fails is still a snapshot taken", async () => {
    // The prune's delete of old timeouts fails; everything else is the real client.
    const failing = new Proxy(appDb, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
          target.$transaction(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(t, p, r) {
                    const v = Reflect.get(t, p, r);
                    if (p !== "dbStatementTimeout") return v;
                    return new Proxy(v as object, {
                      get(d, m, dr) {
                        if (m === "deleteMany") {
                          return async () => {
                            throw new Error("prune refused");
                          };
                        }
                        return Reflect.get(d, m, dr);
                      },
                    });
                  },
                }),
              ),
            opts as never,
          );
      },
    }) as PrismaClient;
    expect(await snapshotIfDue(failing, Date.now(), { force: true })).toBe(
      true,
    );
    expect(await suDb.dbStatSnapshotRun.count()).toBe(1);
  });

  test("whether a text is one statement is the server's call: comments, quotes and dollar quotes pass, two statements do not", async () => {
    const plan = async (sql: string) => {
      const out = await capturePlan(
        { sql, tenantId: "1", fleet: false },
        appDb,
      );
      return "plan" in out ? `plan: ${out.plan}` : `error: ${out.error}`;
    };
    // A `;` inside a string literal, a quoted identifier and a dollar-quoted body.
    expect(
      await plan(
        `SELECT id, 'a;b' AS "x;y", $q$c;d$q$ AS z FROM "agents" WHERE "name" = $1`,
      ),
    ).toContain("plan: ");
    // Ending in a quoted identifier with no `;`, and ending in `;` plus a comment.
    expect(await plan('SELECT "id" FROM "agents"')).toContain("agents");
    expect(await plan("SELECT 1; -- done")).toContain("plan: ");
    // Two statements: refused by the server's parser before anything runs.
    expect(
      await plan('SELECT 1; DELETE FROM "agents" WHERE "name" = $1'),
    ).toContain("cannot insert multiple commands");
    // What EXPLAIN does not take is the server's syntax error, and nothing ran.
    expect(await plan("VACUUM conversations")).toContain("error: ");
  });

  test("the follow-up sweep's own query, whose comment carries a `;`, is planned", async () => {
    // The query as the sweep sends it, captured from the handler itself: every `$queryRaw` of its
    // scoped transactions is recorded, and the one on `follow_up_armed_at` is the sweep's.
    const t = await suDb.tenant.create({
      data: { name: "DB1701", slug: `db1701-${process.pid}` },
    });
    try {
      const inst = await seedChatwootInstance(suDb, {
        tenantId: t.id,
        accountId: 5,
      });
      const agent = await suDb.agent.create({
        data: {
          tenantId: t.id,
          name: "Atendente",
          systemPrompt: "x",
          followUpArmedAt: new Date(Date.now() - 86_400_000),
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
          settings: {
            followUp: {
              enabled: true,
              steps: [
                { delayValue: 1, delayUnit: "minutes", instructions: "a" },
              ],
            },
          },
        },
      });
      await suDb.inbox.create({
        data: {
          tenantId: t.id,
          chatwootInstanceId: inst.id,
          chatwootInboxId: 17_011,
          name: "Suporte",
          agentId: agent.id,
          channelType: "Channel::Api",
        },
      });
      const seen: string[] = [];
      const record = <D extends object>(tx: D): D =>
        new Proxy(tx, {
          get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver);
            if (prop !== "$queryRaw") return v;
            // A tagged template, or a Prisma.Sql built elsewhere and passed whole.
            return (
              strings: TemplateStringsArray | Prisma.Sql,
              ...values: unknown[]
            ) => {
              seen.push(
                strings instanceof Prisma.Sql
                  ? strings.text
                  : Prisma.sql(strings, ...values).text,
              );
              return (v as (...a: unknown[]) => unknown).call(
                target,
                strings,
                ...values,
              );
            };
          },
        });
      const wrap = (client: PrismaClient): PrismaClient =>
        new Proxy(client, {
          get(target, prop, receiver) {
            if (prop === "$extends") {
              return (ext: never) => wrap(target.$extends(ext) as never);
            }
            if (prop === "$transaction") {
              return (fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
                target.$transaction(
                  (tx) => fn(record(tx as object)),
                  opts as never,
                );
            }
            return Reflect.get(target, prop, receiver);
          },
        });
      registerFollowUpHandlers();
      const sweep = getJobHandler("FOLLOWUP_SWEEP");
      const jobId = await burnSchedulerJobId(suDb);
      await sweep?.(
        {
          id: jobId,
          tenantId: t.id,
          kind: "FOLLOWUP_SWEEP",
          payload: {},
          attempts: 0,
          claimSeq: 0,
        },
        wrap(appDb),
      );
      const sql = seen.find((q) => q.includes("follow_up_armed_at"));
      expect(sql).toContain("parseStartMs in JS;");
      const out = await capturePlan(
        { sql: sql as string, tenantId: String(t.id), fleet: false },
        appDb,
      );
      expect("plan" in out ? out.plan : out.error).toContain("conversations");
    } finally {
      for (const table of [
        "scheduler_jobs",
        "inboxes",
        "agents",
        "chatwoot_instances",
        "chatwoot_deployments",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${t.id}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${t.id}`);
    }
  });

  test("three timeouts of one statement are three records and one plan", async () => {
    const sql = 'SELECT "id" FROM "agents" WHERE "name" = $1';
    const at = Date.now();
    const ev = (i: number) => ({
      at: at + i,
      sql,
      label: "job:FOLLOWUP_SWEEP",
      tenantId: "1",
      fleet: false,
      budgetMs: 5000,
    });
    expect(await flushStatementTimeouts(appDb, [ev(0), ev(1)])).toBe(2);
    expect(await flushStatementTimeouts(appDb, [ev(2)])).toBe(1);
    const rows = await suDb.dbStatementTimeout.findMany({
      where: { fingerprint: statementFingerprint(sql) },
    });
    expect(rows).toHaveLength(3);
    expect(
      rows.filter((r) => r.plan !== null || r.planError !== null),
    ).toHaveLength(1);
    const screen = await readDatabaseScreen("1h", appDb);
    const group = screen.timeouts.find(
      (g) => g.fingerprint === statementFingerprint(sql),
    );
    expect(group?.occurrences).toBe(3);
    expect(group?.label).toBe("job:FOLLOWUP_SWEEP");
    expect(group?.tenantId).toBe("1");
    expect(group?.budgetMs).toBe(5000);
    expect(group?.plannedAs).toBe("application role, tenant 1");
    expect(group?.plan).toContain("current_setting('app.tenant_id'");
  });

  test("the same statement under another scope gets its own plan, and the screen never shows one scope's plan for another", async () => {
    const sql = 'SELECT "id" FROM "agents" WHERE "system_prompt" = $1';
    const at = Date.now();
    const ev = (i: number, fleet: boolean) => ({
      at: at + i,
      sql,
      label: "job:FOLLOWUP_SWEEP",
      tenantId: fleet ? null : "1",
      fleet,
      budgetMs: 5000,
    });
    // First under the fleet role, then under a tenant, each in its own tick.
    expect(await flushStatementTimeouts(appDb, [ev(0, true)])).toBe(1);
    expect(await flushStatementTimeouts(appDb, [ev(1, false)])).toBe(1);
    const rows = await suDb.dbStatementTimeout.findMany({
      where: { fingerprint: statementFingerprint(sql) },
      orderBy: { occurredAt: "asc" },
    });
    expect(rows.map((r) => r.plannedAs)).toEqual([
      "fleet role",
      "application role, tenant 1",
    ]);
    const screen = await readDatabaseScreen("1h", appDb);
    const group = screen.timeouts.find(
      (g) => g.fingerprint === statementFingerprint(sql),
    );
    // The newest occurrence is the tenant's, and so is the plan beside it, with its RLS predicate.
    expect(group?.tenantId).toBe("1");
    expect(group?.plannedAs).toBe("application role, tenant 1");
    expect(group?.plan).toContain("current_setting('app.tenant_id'");

    // A newer occurrence under a tenant whose plan is not taken yet shows no plan, not another's.
    await suDb.dbStatementTimeout.create({
      data: {
        occurredAt: new Date(at + 2),
        fingerprint: statementFingerprint(sql),
        statement: rows[0]?.statement ?? sql,
        label: "job:FOLLOWUP_SWEEP",
        scopeTenantId: 2n,
        fleet: false,
        budgetMs: 5000,
      },
    });
    const later = (await readDatabaseScreen("1h", appDb)).timeouts.find(
      (g) => g.fingerprint === statementFingerprint(sql),
    );
    expect(later?.tenantId).toBe("2");
    expect(later?.plan).toBeNull();
    expect(later?.plannedAs).toBeNull();
  });
});

describe("what the screen derives, decided by the server", () => {
  test("a table is overdue for vacuum past autovacuum's own trigger, and an empty one has no ratio", () => {
    // The trigger as autovacuum computes it: the table's threshold plus its scale factor times
    // `reltuples` (the planner's row count), not the live-tuple count, which lags after a large delete.
    const pg = { threshold: 50, scale: 0.2, reltuples: 1000 };
    expect(deadRows(1000, 250, pg)).toEqual({
      deadRatio: 0.2,
      vacuumOverdue: false,
      vacuumTriggerRows: 250,
    });
    expect(deadRows(1000, 251, pg).vacuumOverdue).toBe(true);
    // Live tuples already down to 100 after a delete, reltuples still 1000: not past the trigger.
    expect(deadRows(100, 200, pg).vacuumOverdue).toBe(false);
    expect(deadRows(0, 51, { ...pg, reltuples: 0 })).toEqual({
      deadRatio: 1,
      vacuumOverdue: true,
      vacuumTriggerRows: 50,
    });
    // Never analyzed: Postgres reads reltuples -1 as zero rows.
    expect(deadRows(0, 51, { ...pg, reltuples: -1 }).vacuumOverdue).toBe(true);
    expect(deadRows(0, 0, { ...pg, reltuples: 0 })).toEqual({
      deadRatio: null,
      vacuumOverdue: false,
      vacuumTriggerRows: 50,
    });
  });

  // Against the database, skipped with the rest when none is up (ALLOW_NO_DB).
  test.skipIf(!dbUp)(
    "a table's own autovacuum settings decide its trigger, the server's only where it sets none",
    async () => {
      const probe = `vacuum_probe_${process.pid}`;
      await suDb.$executeRawUnsafe(
        `CREATE TABLE ${probe} (id int PRIMARY KEY) WITH (autovacuum_vacuum_threshold = 1000, autovacuum_vacuum_scale_factor = 0)`,
      );
      try {
        const screen = await readDatabaseScreen("1h", appDb);
        const row = screen.tables.find((t) => t.table === probe);
        expect(row?.vacuumTriggerRows).toBe(1000);
        // A table with nothing of its own takes the server's defaults (50 + 0.2 x reltuples).
        const plain = screen.tables.find((t) => t.table === "conversations");
        expect(plain?.vacuumTriggerRows).toBeGreaterThanOrEqual(50);
      } finally {
        await suDb.$executeRawUnsafe(`DROP TABLE ${probe}`);
      }
    },
  );

  test("a series never has more points than the window has snapshots, so a run is not drawn as a gap", () => {
    expect(sparkBuckets(60 * MIN)).toBe(12);
    expect(sparkBuckets(24 * 60 * MIN)).toBe(24);
    expect(sparkBuckets(7 * 24 * 60 * MIN)).toBe(24);
    expect(sparkBuckets(MIN)).toBe(1);
  });

  test("a signal's state: stale before firing, firing before muted, and no reading is not fine", () => {
    const s = { value: 1, enabled: true, firing: false, stale: false };
    expect(signalState(s)).toBe("ok");
    expect(signalState({ ...s, firing: true })).toBe("firing");
    expect(signalState({ ...s, firing: true, stale: true })).toBe("stale");
    expect(signalState({ ...s, enabled: false })).toBe("muted");
    expect(signalState({ ...s, value: null })).toBe("no_data");
  });
});

describe.skipIf(!dbUp)("the screen's summary figures", () => {
  beforeEach(async () => {
    await wipe();
    resetSnapshotState();
  });

  test("each statement carries its mean as a share of the budget, uncapped past 100", async () => {
    const now = Date.now();
    setLastAvailabilityForTest({ available: true });
    await seed(71n, [{ at: now - 5 * MIN, calls: 4, total: 6000 }]);
    await seed(72n, [{ at: now - 5 * MIN, calls: 10, total: 100 }]);
    const screen = await readDatabaseScreen("1h", appDb, now, 1000);
    if (!screen.statements.available) throw new Error("statements off");
    expect(screen.statements.budgetMs).toBe(1000);
    const pct = Object.fromEntries(
      screen.statements.byTotal.map((r) => [r.queryid, r.meanBudgetPct]),
    );
    expect(pct["71"]).toBe(150);
    expect(pct["72"]).toBe(1);
  });

  test("the window's timeout count and the tables' size are totals, not the listed groups", async () => {
    const now = Date.now();
    await suDb.dbStatementTimeout.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        occurredAt: new Date(now - i * 1000),
        fingerprint: statementFingerprint(`SELECT g${i}`),
        statement: `SELECT g${i}`,
        fleet: false,
      })),
    });
    await suDb.dbStatementTimeout.create({
      data: {
        occurredAt: new Date(now - 2 * 60 * MIN),
        fingerprint: statementFingerprint("SELECT old"),
        statement: "SELECT old",
        fleet: false,
      },
    });
    const screen = await readDatabaseScreen("1h", appDb, now);
    expect(screen.timeouts.length).toBe(100);
    expect(screen.timeoutOccurrences).toBe(120);
    expect(screen.size.totalBytes).toBe(
      screen.tables.reduce((n, t) => n + t.totalBytes, 0),
    );
    for (const t of screen.tables) {
      expect(
        t.deadRatio === null || (t.deadRatio >= 0 && t.deadRatio <= 1),
      ).toBe(true);
    }
  });

  test("growth over a window needs a snapshot near its start, or reads as unknown", async () => {
    const now = Date.now();
    // One snapshot of `conversations`, 58 minutes old: the start of a 1h window, the end of a 7d one.
    await suDb.dbTableSnapshot.create({
      data: {
        takenAt: new Date(now - 58 * MIN),
        tableName: "conversations",
        totalBytes: 1n,
        liveTuples: 0n,
        deadTuples: 0n,
      },
    });
    const hour = await readDatabaseScreen("1h", appDb, now);
    const week = await readDatabaseScreen("7d", appDb, now);
    const growth = (s: typeof hour) =>
      s.tables.find((t) => t.table === "conversations")?.growthBytes;
    expect(growth(hour)).not.toBeNull();
    expect(growth(week)).toBeNull();
    expect(week.size.growthBytes).toBeNull();
  });

  test("the view's two reads never hold the metrics pool at once", async () => {
    // With METRICS_POOL_MAX=1 a read waiting behind the other times out on its own wait, well inside
    // the screen's budget: the two run one after the other.
    let open = 0;
    let overlapped = false;
    const base = new Proxy(appDb, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return async (...args: unknown[]) => {
          open++;
          if (open > 1) overlapped = true;
          try {
            return await (
              target.$transaction as unknown as (...a: unknown[]) => unknown
            ).apply(target, args);
          } finally {
            open--;
          }
        };
      },
    });
    await readDatabaseView("1h", base, false);
    expect(overlapped).toBe(false);
  });

  test("the view opens nothing once the request's metrics budget is spent", async () => {
    // A request that arrived longer ago than METRICS_TIMEOUT_MS (a slow session lookup in front of
    // the route): neither read may open a transaction, the thresholds read included.
    let opened = 0;
    const base = new Proxy(appDb, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return (...args: unknown[]) => {
          opened++;
          return (
            target.$transaction as unknown as (...a: unknown[]) => unknown
          ).apply(target, args);
        };
      },
    });
    const late = requestContext.run(
      {
        locale: "en",
        startedAt: Date.now() - config.metrics.timeoutMs - 1_000,
      },
      () => readDatabaseView("1h", base, false),
    );
    await expect(late).rejects.toBeInstanceOf(MetricsTooSlowError);
    expect(opened).toBe(0);
  });

  test("a read that runs out of the metrics budget answers as too slow, not as a failure", async () => {
    // A statement cancelled by its budget mid-read (57014), as an aggregate over a long window is.
    const base = new Proxy(appDb, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return async () => {
          // The shape the driver adapter gives it.
          throw Object.assign(
            new Error("canceling statement due to statement timeout"),
            {
              meta: {
                driverAdapterError: { cause: { originalCode: "57014" } },
              },
            },
          );
        };
      },
    });
    await expect(readDatabaseView("1h", base, false)).rejects.toBeInstanceOf(
      MetricsTooSlowError,
    );
  });

  test("the view carries both statement signals, each with its threshold and state", async () => {
    const view = await readDatabaseView("1h", appDb, false);
    expect(view.signals.map((s) => s.signal)).toEqual([...DATABASE_SIGNALS]);
    for (const s of view.signals) {
      expect(typeof s.threshold).toBe("number");
      expect(s.state).toBe(signalState(s));
      expect("history" in s).toBe(false);
    }
    expect(view.sampling).toBe(false);
    expect(view.window).toBe("1h");
  });
});
