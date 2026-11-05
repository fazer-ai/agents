import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import {
  drainStatementTimeouts,
  resetStatementTimeouts,
} from "@/lib/pool-stats";
import { asSuperAdminOn } from "@/lib/tenancy";
import {
  probeAvailability,
  readDatabaseScreen,
  slowestMeanShare,
  statementTotals,
} from "@/modules/instance-health/database/read";
import {
  pruneDatabaseScreen,
  resetSnapshotState,
  rowsToWrite,
  type StatementEntry,
  setLastAvailabilityForTest,
  snapshotIfDue,
  statementColumns,
  takeStatsRole,
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

  test("an entry absent from the previous complete scan was evicted and restarted: a zero row at it, never its old value", () => {
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
      previousComplete: true,
      previousRunAt: T0 + 5 * MIN,
      takenAt: T0 + 10 * MIN,
    });
    expect(out.map((w) => [w.takenAt, w.values.calls])).toEqual([
      [T0 + 5 * MIN, 0],
      [T0 + 10 * MIN, 9],
    ]);
  });

  test("an entry reset after the previous run gets a zero row there even with an older baseline stored", () => {
    // Its baseline is from long before the window; it was evicted and came back after the last run.
    const written = new Map([
      [
        "10:1:7",
        {
          calls: 50,
          totalExecMs: 100,
          rows: 50,
          statsSince: T0 - 60 * MIN,
          takenAt: T0 - 50 * MIN,
        },
      ],
    ]);
    const out = rowsToWrite({
      entries: [entry(4, new Date(T0 + 7 * MIN))],
      written,
      presentAtPrevious: new Set(),
      previousRunAt: T0 + 5 * MIN,
      takenAt: T0 + 10 * MIN,
    });
    expect(out.map((w) => [w.takenAt, w.values.calls])).toEqual([
      [T0 + 5 * MIN, 0],
      [T0 + 10 * MIN, 4],
    ]);
  });

  test("without stats_since, a new entry absent from the previous complete scan gets a zero row there", () => {
    const out = rowsToWrite({
      entries: [entry(3)],
      written: new Map(),
      presentAtPrevious: new Set(["10:1:99"]),
      previousComplete: true,
      previousRunAt: T0 + 5 * MIN,
      takenAt: T0 + 10 * MIN,
    });
    expect(out.map((w) => [w.takenAt, w.values.calls])).toEqual([
      [T0 + 5 * MIN, 0],
      [T0 + 10 * MIN, 3],
    ]);
    // An unknown previous scan (a restart, or one cut at the cap) proves nothing: no zero row.
    const unknown = rowsToWrite({
      entries: [entry(3)],
      written: new Map(),
      presentAtPrevious: null,
      previousRunAt: T0 + 5 * MIN,
      takenAt: T0 + 10 * MIN,
    });
    expect(unknown.map((w) => w.takenAt)).toEqual([T0 + 10 * MIN]);
  });

  test("a capped scan still counts as presence: an entry seen at the previous run gets its baseline there", () => {
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
      previousComplete: false,
      previousRunAt: T0 + 65 * MIN,
      takenAt: T0 + 70 * MIN,
    });
    expect(out.map((w) => [w.takenAt, w.values.calls])).toEqual([
      [T0 + 65 * MIN, 5],
      [T0 + 70 * MIN, 9],
    ]);
    // But an absence from a capped scan proves nothing: no zero row.
    const absent = rowsToWrite({
      entries: [entry(3)],
      written: new Map(),
      presentAtPrevious: new Set(["10:1:99"]),
      previousComplete: false,
      previousRunAt: T0 + 5 * MIN,
      takenAt: T0 + 10 * MIN,
    });
    expect(absent.map((w) => w.takenAt)).toEqual([T0 + 10 * MIN]);
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
      resetDatabaseTickState();
      await expect(databaseScreenTick(Date.now(), down)).rejects.toThrow();
    } finally {
      await down.$disconnect();
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
    resetDatabaseTickState();
    setLastAvailabilityForTest({ available: false, reason: "unreadable" });
    await expect(databaseScreenTick(Date.now(), appDb)).rejects.toThrow(
      "could not be read",
    );
    // An extension that is simply absent still reads 0, which is a measurement.
    resetDatabaseTickState();
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
