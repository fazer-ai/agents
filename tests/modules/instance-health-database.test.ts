import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { asSuperAdminOn } from "@/lib/tenancy";
import {
  readDatabaseScreen,
  slowestMeanShare,
  statementTotals,
} from "@/modules/instance-health/database/read";
import {
  pruneDatabaseScreen,
  resetSnapshotState,
  rowsToWrite,
  type StatementEntry,
  snapshotIfDue,
} from "@/modules/instance-health/database/snapshot";
import {
  DRIFT_SIGNAL,
  databaseScreenTick,
  resetDatabaseTickState,
} from "@/modules/instance-health/database/tick";
import {
  capturePlan,
  flushStatementTimeouts,
  statementFingerprint,
  unplannableReason,
} from "@/modules/instance-health/database/timeouts";
import {
  setSignalDetail,
  signalDetail,
} from "@/modules/instance-health/details";
import { firingSummary } from "@/modules/instance-health/evaluator";
import {
  resetSamplerState,
  type SamplerSources,
  sampleOnce,
} from "@/modules/instance-health/sampler";
import { dbProbeFailed } from "@/tests/db-gate";

// The database screen against a real database (docs/logs.md, "Database"): the window arithmetic over
// snapshots (with resets), the plan captured under the scope a statement ran in, one plan per
// statement per window, retention, and a database without pg_stat_statements. The extension is not
// loaded on the test server, so the snapshots are seeded the way the sampler writes them. The tables
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
  await suDb.$executeRaw`DELETE FROM db_statement_snapshots`;
  await suDb.$executeRaw`DELETE FROM db_statement_texts`;
  await suDb.$executeRaw`DELETE FROM db_stat_snapshot_runs`;
  await suDb.$executeRaw`DELETE FROM db_table_snapshots`;
  await suDb.$executeRaw`DELETE FROM db_statement_timeouts`;
}

async function seed(
  queryid: bigint,
  points: {
    at: number;
    calls: number;
    total: number;
    rows?: number;
    since?: number;
  }[],
  query = `SELECT $1 /* q${queryid} */`,
  userid = 10n,
): Promise<void> {
  for (const p of points) {
    await suDb.dbStatementSnapshot.create({
      data: {
        takenAt: new Date(p.at),
        userid,
        dbid: 1n,
        queryid,
        calls: BigInt(p.calls),
        totalExecMs: p.total,
        rows: BigInt(p.rows ?? p.calls),
        statsSince: p.since === undefined ? null : new Date(p.since),
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
    expect(summary).toContain("job:FOLLOWUP_SWEEP");
    expect(summary).toContain("SELECT c.thread_id FROM conversations c");
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

describe("rowsToWrite: what a snapshot run writes", () => {
  const entry = (
    calls: number,
    statsSince: Date | null = null,
  ): StatementEntry => ({
    userid: 10n,
    dbid: 1n,
    queryid: 7n,
    query: "SELECT 1",
    calls,
    totalExecMs: calls * 2,
    rows: calls,
    statsSince,
  });

  test("an entry that did not move is not written again", () => {
    const written = new Map([
      [
        "10:1:7",
        { calls: 5, totalExecMs: 10, rows: 5, statsSince: null, takenAt: T0 },
      ],
    ]);
    const out = rowsToWrite({
      entries: [entry(5)],
      written,
      presentAtPrevious: new Set(["10:1:7"]),
      previousRunAt: T0 + 5 * MIN,
      takenAt: T0 + 10 * MIN,
    });
    expect(out).toEqual([]);
  });

  test("an entry that moves after a quiet stretch gets its unchanged value at the previous run too", () => {
    const written = new Map([
      [
        "10:1:7",
        { calls: 5, totalExecMs: 10, rows: 5, statsSince: null, takenAt: T0 },
      ],
    ]);
    const out = rowsToWrite({
      entries: [entry(9)],
      written,
      presentAtPrevious: new Set(["10:1:7"]),
      previousRunAt: T0 + 5 * MIN,
      takenAt: T0 + 10 * MIN,
    });
    expect(out.map((w) => [w.takenAt, w.values.calls])).toEqual([
      [T0 + 5 * MIN, 5],
      [T0 + 10 * MIN, 9],
    ]);
  });

  test("an entry absent at the previous run gets no backfilled row at it", () => {
    const written = new Map([
      [
        "10:1:7",
        { calls: 5, totalExecMs: 10, rows: 5, statsSince: null, takenAt: T0 },
      ],
    ]);
    const out = rowsToWrite({
      entries: [entry(9)],
      written,
      presentAtPrevious: new Set(),
      previousRunAt: T0 + 5 * MIN,
      takenAt: T0 + 10 * MIN,
    });
    expect(out.map((w) => w.takenAt)).toEqual([T0 + 10 * MIN]);
  });

  test("an entry that started after the previous run gets a zero row there, so its whole count lands", () => {
    const out = rowsToWrite({
      entries: [entry(4, new Date(T0 + 7 * MIN))],
      written: new Map(),
      presentAtPrevious: new Set(),
      previousRunAt: T0 + 5 * MIN,
      takenAt: T0 + 10 * MIN,
    });
    expect(out.map((w) => [w.takenAt, w.values.calls])).toEqual([
      [T0 + 5 * MIN, 0],
      [T0 + 10 * MIN, 4],
    ]);
  });
});

describe.skipIf(!dbUp)("database screen against a real database", () => {
  beforeEach(async () => {
    await wipe();
    resetSnapshotState();
  });

  test("a window counts the difference between its snapshots, not the lifetime total", async () => {
    await seed(1n, [
      { at: T0, calls: 1000, total: 1000 },
      { at: T0 + 5 * MIN, calls: 1010, total: 1020 },
      { at: T0 + 10 * MIN, calls: 1030, total: 1060 },
    ]);
    const [t] = await asSuperAdminOn(appDb, (db) =>
      statementTotals(db, new Date(T0), new Date(T0 + 10 * MIN)),
    );
    expect(t?.calls).toBe(30);
    expect(t?.total_ms).toBe(60);
  });

  test("a counter that went down restarts the series instead of going negative", async () => {
    await seed(2n, [
      { at: T0, calls: 500, total: 5000 },
      { at: T0 + 5 * MIN, calls: 510, total: 5100 },
      // pg_stat_statements_reset() between these two: what the later one holds is since then.
      { at: T0 + 10 * MIN, calls: 10, total: 30 },
      { at: T0 + 15 * MIN, calls: 14, total: 50 },
    ]);
    const [t] = await asSuperAdminOn(appDb, (db) =>
      statementTotals(db, new Date(T0), new Date(T0 + 15 * MIN)),
    );
    expect(t?.calls).toBe(10 + 10 + 4);
    expect(t?.total_ms).toBe(100 + 30 + 20);
  });

  test("a newer stats_since is a reset even when the counters happen to be higher", async () => {
    await seed(3n, [
      { at: T0, calls: 3, total: 3, since: T0 - 60 * MIN },
      // Evicted and back, and climbed past the old count before the next snapshot.
      { at: T0 + 5 * MIN, calls: 8, total: 16, since: T0 + 2 * MIN },
    ]);
    const [t] = await asSuperAdminOn(appDb, (db) =>
      statementTotals(db, new Date(T0), new Date(T0 + 5 * MIN)),
    );
    expect(t?.calls).toBe(8);
  });

  test("the screen's rows never carry a negative figure, in any window", async () => {
    const now = Date.now();
    await seed(4n, [
      { at: now - 20 * MIN, calls: 900, total: 900 },
      { at: now - 10 * MIN, calls: 2, total: 1 },
      { at: now - 5 * MIN, calls: 12, total: 21 },
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
        { at: now - 30 * MIN, calls: 10, total: 1000 },
        { at: now - 5 * MIN, calls: 20, total: 4000 },
      ],
      "SELECT c.thread_id FROM conversations c WHERE c.status = $1",
      appRole,
    );
    await seed(
      6n,
      [
        { at: now - 30 * MIN, calls: 1000, total: 1000 },
        { at: now - 5 * MIN, calls: 3000, total: 3000 },
      ],
      undefined,
      appRole,
    );
    // Slower, but run by another user (an operator's psql session): not measured.
    await seed(
      7n,
      [
        { at: now - 30 * MIN, calls: 1, total: 0 },
        { at: now - 5 * MIN, calls: 2, total: 4000 },
      ],
      "SELECT pg_sleep($1)",
      appRole + 999_999n,
    );
    const { pct, query } = await slowestMeanShare(appDb, now, 500);
    // (4000 - 1000) / (20 - 10) = 300 ms, 60% of a 500 ms budget.
    expect(pct).toBeCloseTo(60, 5);
    expect(query).toContain("SELECT c.thread_id FROM conversations");
  });

  test("after a restart the drift comes from the stored snapshots, before this process takes its first", async () => {
    const now = Date.now();
    const [app] = await appDb.$queryRaw<{ oid: bigint }[]>`
      SELECT oid::bigint AS oid FROM pg_roles WHERE rolname = session_user`;
    await seed(
      8n,
      [
        { at: now - 20 * MIN, calls: 10, total: 100 },
        { at: now - 2 * MIN, calls: 20, total: 6100 },
      ],
      "SELECT c.id FROM conversations c WHERE c.contact_id = $1",
      app?.oid ?? 0n,
    );
    // The last run two minutes ago: the next snapshot is not due, so availability stays unknown.
    await suDb.dbStatSnapshotRun.create({
      data: { takenAt: new Date(now - 2 * MIN), statementsAvailable: true },
    });
    resetDatabaseTickState();
    setSignalDetail(DRIFT_SIGNAL, null);
    const value = await databaseScreenTick(now, appDb);
    // (6100 - 100) / (20 - 10) = 600 ms, as a share of DB_TX_TIMEOUT_MS.
    expect(Math.round(value)).toBe(
      Math.round((600 / config.dbTx.timeoutMs) * 100),
    );
    expect(signalDetail(DRIFT_SIGNAL) ?? "").toContain(
      "SELECT c.id FROM conversations",
    );
  });

  test("without pg_stat_statements loaded, the screen explains how to enable it and the rest still answers", async () => {
    const took = await snapshotIfDue(appDb, Date.now(), { force: true });
    expect(took).toBe(true);
    const screen = await readDatabaseScreen("1h", appDb);
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
    }
    expect(screen.tables.some((t) => t.table === "conversations")).toBe(true);
    const runs = await suDb.dbStatSnapshotRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.statementsAvailable).toBe(false);
    expect(await suDb.dbTableSnapshot.count()).toBeGreaterThan(0);
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
    const left = await suDb.dbStatementSnapshot.findMany();
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

  test("what is not one plannable statement is refused before anything runs", () => {
    expect(unplannableReason("SELECT 1; DROP TABLE x")).toBe(
      "more than one statement",
    );
    expect(unplannableReason("VACUUM conversations")).not.toBeNull();
    expect(unplannableReason("SELECT 1;")).toBeNull();
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
});
