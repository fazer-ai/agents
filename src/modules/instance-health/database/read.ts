import type { PrismaClient } from "@/../generated/prisma/client";
import metricsPrisma from "@/api/lib/prisma-metrics";
import config from "@/config";
import type { TxBudget } from "@/lib/tenancy";
import { metricsBudget, metricsDeadline } from "@/modules/analytics/budget";
import { budgetUntil, fleetWithin, plainWithin } from "./budget";
import {
  availabilityOfError,
  lastAvailability,
  type StatementsAvailability,
} from "./snapshot";

// What the "Database" screen, its REST route and its MCP tool read (docs/logs.md, "Database"). Every
// figure about statements is the sum of the deltas stored inside the window (./snapshot.ts).

export const WINDOWS = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
} as const;
export type WindowKey = keyof typeof WINDOWS;

const TOP = 50;
const SPARK_BUCKETS = 24;
// Every table of the schema (a hundred or so): a seeded test table is as much a table as the largest.
const TABLES_TOP = 500;
// How many timed-out statements the screen lists, the most recent first.
const TIMEOUT_GROUPS = 100;
// What the drift computation may take when its caller gives no deadline.
const DRIFT_BUDGET_MS = 5_000;

// How to switch the extension on, said the same way on every surface that shows it.
export const ENABLE_STATEMENTS = [
  "shared_preload_libraries = 'pg_stat_statements'",
  "pg_stat_statements.track = top",
  "pg_stat_statements.track_utility = off",
] as const;

export interface StatementRowDto {
  queryid: string;
  userid: string;
  query: string;
  calls: number;
  rows: number;
  totalMs: number;
  meanMs: number;
  // Mean time per bucket of the window, oldest first; null where the statement did not run.
  spark: (number | null)[];
}

export interface TimeoutDto {
  fingerprint: string;
  statement: string;
  occurrences: number;
  lastAt: string;
  label: string | null;
  tenantId: string | null;
  fleet: boolean;
  budgetMs: number | null;
  plan: string | null;
  planError: string | null;
  plannedAs: string | null;
  plannedAt: string | null;
}

export interface TableHealthDto {
  table: string;
  totalBytes: number;
  growthBytes: number | null;
  liveTuples: number;
  deadTuples: number;
  lastAutovacuum: string | null;
  lastAutoanalyze: string | null;
  seqScans: number;
  indexScans: number;
}

export interface DatabaseScreenDto {
  window: WindowKey;
  statements:
    | {
        available: true;
        snapshots: number;
        lastSnapshotAt: string | null;
        byTotal: StatementRowDto[];
        byMean: StatementRowDto[];
      }
    | {
        available: false;
        reason: "not_created" | "not_loaded" | "unreadable";
        enable: readonly string[];
      };
  timeouts: TimeoutDto[];
  tables: TableHealthDto[];
  unusedIndexes: { table: string; index: string; bytes: number }[];
  seqScanHeavy: TableHealthDto[];
}

interface KeyTotals {
  userid: bigint;
  dbid: bigint;
  queryid: bigint;
  calls: number;
  rows: number;
  total_ms: number;
}

// The per-entry totals of a window: the sum of the deltas stored inside it (./snapshot.ts takes each
// difference when it writes, resets included), so nothing here compares rows.
export async function statementTotals(
  db: Pick<PrismaClient, "$queryRaw">,
  from: Date,
  to: Date,
): Promise<KeyTotals[]> {
  const rows = await db.$queryRaw<
    {
      userid: bigint;
      dbid: bigint;
      queryid: bigint;
      calls: number;
      rows: number;
      total_ms: number;
    }[]
  >`
    SELECT userid, dbid, queryid,
           sum(calls)::float8 AS calls, sum(rows)::float8 AS rows,
           sum(total_exec_ms)::float8 AS total_ms
      FROM db_statement_deltas
     WHERE taken_at > ${from} AND taken_at <= ${to}
     GROUP BY userid, dbid, queryid
    HAVING sum(calls) > 0`;
  return rows.map((r) => ({
    ...r,
    calls: Number(r.calls),
    rows: Number(r.rows),
    total_ms: Number(r.total_ms),
  }));
}

async function sparks(
  db: Pick<PrismaClient, "$queryRaw">,
  keys: KeyTotals[],
  from: Date,
  to: Date,
): Promise<Map<string, (number | null)[]>> {
  const out = new Map<string, (number | null)[]>();
  if (keys.length === 0) return out;
  const span = Math.max(1, to.getTime() - from.getTime());
  const rows = await db.$queryRaw<
    {
      userid: bigint;
      dbid: bigint;
      queryid: bigint;
      bucket: number;
      calls: number;
      total_ms: number;
    }[]
  >`
    SELECT userid, dbid, queryid,
           least(${SPARK_BUCKETS - 1}, floor(extract(epoch FROM taken_at - ${from}::timestamp) * 1000 / ${span} * ${SPARK_BUCKETS}))::int AS bucket,
           sum(calls)::float8 AS calls, sum(total_exec_ms)::float8 AS total_ms
      FROM db_statement_deltas
     WHERE taken_at > ${from} AND taken_at <= ${to}
       AND (userid::text || ':' || dbid::text || ':' || queryid::text)
           = ANY(${keys.map((k) => `${k.userid}:${k.dbid}:${k.queryid}`)}::text[])
     GROUP BY 1, 2, 3, 4`;
  for (const k of keys) {
    out.set(
      `${k.userid}:${k.dbid}:${k.queryid}`,
      Array(SPARK_BUCKETS).fill(null),
    );
  }
  for (const r of rows) {
    const series = out.get(`${r.userid}:${r.dbid}:${r.queryid}`);
    const calls = Number(r.calls);
    if (series && calls > 0 && r.bucket >= 0) {
      series[r.bucket] = Number(r.total_ms) / calls;
    }
  }
  return out;
}

// The slowest statement's mean over the last hour, as a share of DB_TX_TIMEOUT_MS, and its text.
// Statements the screen itself runs (EXPLAIN, the snapshot reads) are left out.
export async function slowestMeanShare(
  base: PrismaClient,
  now: number = Date.now(),
  budgetMs: number = config.dbTx.timeoutMs,
  txBudget: TxBudget = budgetUntil(Date.now() + DRIFT_BUDGET_MS),
): Promise<{ pct: number; query: string | null }> {
  return fleetWithin(base, txBudget, async (db) => {
    const totals = await statementTotals(
      db,
      new Date(now - WINDOWS["1h"]),
      new Date(now),
    );
    if (totals.length === 0) return { pct: 0, query: null };
    // Only what this application runs is measured against its budget: the runtime role and the
    // roles it can act as (the fleet role). A statement an operator runs in psql as another user
    // never had DB_TX_TIMEOUT_MS as its limit. An install that connects as a superuser matches every
    // role, which is the same as not filtering.
    const ours = await db.$queryRaw<{ oid: bigint }[]>`
      SELECT oid::bigint AS oid FROM pg_roles WHERE pg_has_role(session_user, oid, 'MEMBER')`;
    const roles = new Set(ours.map((r) => String(r.oid)));
    const texts = await textsOf(db, totals);
    let best: { mean: number; query: string } | null = null;
    for (const t of totals) {
      if (!roles.has(String(t.userid))) continue;
      const query = texts.get(`${t.userid}:${t.dbid}:${t.queryid}`) ?? "";
      if (isOwnStatement(query)) continue;
      const mean = t.total_ms / t.calls;
      if (!best || mean > best.mean) best = { mean, query };
    }
    if (!best || budgetMs <= 0) return { pct: 0, query: null };
    return { pct: (best.mean / budgetMs) * 100, query: best.query };
  });
}

// The monitoring's own statements: the plans it takes, its reads of the statistics views, and every
// statement on the screen's tables (snapshots, texts, runs, table sizes, timeouts). Opening the
// screen or a slow snapshot must not raise the alarm about the workload it measures.
export function isOwnStatement(query: string): boolean {
  return (
    /^\s*EXPLAIN\b/i.test(query) ||
    /\bpg_stat_\w+/.test(query) ||
    /\bdb_(?:statement_deltas|statement_texts|statement_timeouts|stat_snapshot_runs|table_snapshots)\b/.test(
      query,
    )
  );
}

async function textsOf(
  db: Pick<PrismaClient, "$queryRaw">,
  keys: { userid: bigint; dbid: bigint; queryid: bigint }[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await db.$queryRaw<
    { userid: bigint; dbid: bigint; queryid: bigint; query: string }[]
  >`SELECT userid, dbid, queryid, query FROM db_statement_texts
     WHERE (userid::text || ':' || dbid::text || ':' || queryid::text)
           = ANY(${keys.map((k) => `${k.userid}:${k.dbid}:${k.queryid}`)}::text[])`;
  return new Map(
    rows.map((r) => [`${r.userid}:${r.dbid}:${r.queryid}`, r.query]),
  );
}

function toRow(
  t: KeyTotals,
  texts: Map<string, string>,
  spark: Map<string, (number | null)[]>,
): StatementRowDto {
  const k = `${t.userid}:${t.dbid}:${t.queryid}`;
  return {
    queryid: String(t.queryid),
    userid: String(t.userid),
    query: texts.get(k) ?? "",
    calls: t.calls,
    rows: t.rows,
    totalMs: t.total_ms,
    meanMs: t.calls > 0 ? t.total_ms / t.calls : 0,
    spark: spark.get(k) ?? [],
  };
}

// Probes pg_stat_statements in a transaction of its own (a server that does not preload it raises an
// error, which would abort any transaction it ran in) under the request's budget, so a slow probe
// cannot take the route past METRICS_TIMEOUT_MS before the screen's own read starts.
export async function probeAvailability(
  base: PrismaClient,
  budget: TxBudget,
): Promise<StatementsAvailability> {
  try {
    return await plainWithin(base, budget, async (db) => {
      const [ext] = await db.$queryRaw<{ created: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS created`;
      if (!ext?.created) {
        return { available: false, reason: "not_created" } as const;
      }
      await db.$queryRawUnsafe("SELECT 1 FROM pg_stat_statements LIMIT 1");
      return { available: true } as const;
    });
  } catch (err) {
    return availabilityOfError(err);
  }
}

export async function readDatabaseScreen(
  window: WindowKey,
  base: PrismaClient = metricsPrisma,
  now: number = Date.now(),
): Promise<DatabaseScreenDto> {
  const from = new Date(now - WINDOWS[window]);
  const to = new Date(now);
  // One deadline for the whole request, the probe included.
  const deadline = metricsDeadline();
  // Whether the extension is readable now: the last snapshot's answer when there was one, else a
  // probe of its own (a fresh process, or one that does not sample).
  const availability =
    lastAvailability() ??
    (await probeAvailability(base, metricsBudget(deadline)));

  // A console read, on the metrics pool and within the metrics budget like the dashboards: a 7 day
  // window aggregates more than a scoped transaction's budget allows.
  return fleetWithin(base, metricsBudget(deadline), async (db) => {
    let statements: DatabaseScreenDto["statements"];
    if (availability.available) {
      const totals = await statementTotals(db, from, to);
      const byTotal = [...totals]
        .sort((a, b) => b.total_ms - a.total_ms)
        .slice(0, TOP);
      const byMean = [...totals]
        .sort((a, b) => b.total_ms / b.calls - a.total_ms / a.calls)
        .slice(0, TOP);
      const shown = [
        ...new Map(
          [...byTotal, ...byMean].map((t) => [
            `${t.userid}:${t.dbid}:${t.queryid}`,
            t,
          ]),
        ).values(),
      ];
      const texts = await textsOf(db, shown);
      const spark = await sparks(db, shown, from, to);
      const runs = await db.dbStatSnapshotRun.findMany({
        where: { takenAt: { gte: from, lte: to } },
        orderBy: { takenAt: "desc" },
        select: { takenAt: true },
      });
      statements = {
        available: true,
        snapshots: runs.length,
        lastSnapshotAt: runs[0]?.takenAt.toISOString() ?? null,
        byTotal: byTotal.map((t) => toRow(t, texts, spark)),
        byMean: byMean.map((t) => toRow(t, texts, spark)),
      };
    } else {
      statements = {
        available: false,
        reason: availability.reason,
        enable: ENABLE_STATEMENTS,
      };
    }

    // Counted over the whole window first, then limited to the statements that failed most
    // recently: a storm of one statement neither undercounts itself nor hides the others. Each
    // group shows its newest occurrence's scope and the newest plan of that statement, which can
    // predate the window and still describes it.
    const timeoutRows = await db.$queryRaw<
      {
        fingerprint: string;
        n: number;
        last_at: Date;
        statement: string;
        label: string | null;
        scope_tenant_id: bigint | null;
        fleet: boolean;
        budget_ms: number | null;
        plan: string | null;
        plan_error: string | null;
        planned_as: string | null;
        planned_at: Date | null;
      }[]
    >`WITH g AS (
          SELECT fingerprint, count(*)::int AS n, max(occurred_at) AS last_at
            FROM db_statement_timeouts
           WHERE occurred_at >= ${from} AND occurred_at <= ${to}
           GROUP BY fingerprint
           ORDER BY last_at DESC
           LIMIT ${TIMEOUT_GROUPS})
        SELECT g.fingerprint, g.n, g.last_at, l.statement, l.label, l.scope_tenant_id, l.fleet,
               l.budget_ms, p.plan, p.plan_error, p.planned_as, p.occurred_at AS planned_at
          FROM g
          CROSS JOIN LATERAL (
            SELECT t.statement, t.label, t.scope_tenant_id, t.fleet, t.budget_ms
              FROM db_statement_timeouts t
             WHERE t.fingerprint = g.fingerprint AND t.occurred_at = g.last_at
             ORDER BY t.id DESC LIMIT 1) l
          LEFT JOIN LATERAL (
            SELECT t.plan, t.plan_error, t.planned_as, t.occurred_at
              FROM db_statement_timeouts t
             WHERE t.fingerprint = g.fingerprint
               AND (t.plan IS NOT NULL OR t.plan_error IS NOT NULL)
             ORDER BY t.occurred_at DESC LIMIT 1) p ON true
         ORDER BY g.last_at DESC`;
    const timeouts: TimeoutDto[] = timeoutRows.map((r) => ({
      fingerprint: r.fingerprint,
      statement: r.statement,
      occurrences: r.n,
      lastAt: r.last_at.toISOString(),
      label: r.label,
      tenantId: r.scope_tenant_id === null ? null : String(r.scope_tenant_id),
      fleet: r.fleet,
      budgetMs: r.budget_ms,
      plan: r.plan,
      planError: r.plan_error,
      plannedAs: r.planned_as,
      plannedAt: r.planned_at?.toISOString() ?? null,
    }));

    const tableRows = await db.$queryRaw<
      {
        table_name: string;
        total_bytes: bigint;
        live: bigint;
        dead: bigint;
        last_autovacuum: Date | null;
        last_autoanalyze: Date | null;
        seq_scan: bigint;
        idx_scan: bigint | null;
        first_bytes: bigint | null;
      }[]
    >`SELECT c.relname AS table_name, pg_total_relation_size(c.oid) AS total_bytes,
             s.n_live_tup AS live, s.n_dead_tup AS dead,
             s.last_autovacuum, s.last_autoanalyze, s.seq_scan, s.idx_scan,
             (SELECT ts.total_bytes FROM db_table_snapshots ts
               WHERE ts.table_name = c.relname AND ts.taken_at >= ${from}
               ORDER BY ts.taken_at ASC LIMIT 1) AS first_bytes
        FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
       WHERE s.schemaname = 'public'`;
    const tables: TableHealthDto[] = tableRows.map((r) => ({
      table: r.table_name,
      totalBytes: Number(r.total_bytes),
      growthBytes:
        r.first_bytes === null
          ? null
          : Number(r.total_bytes) - Number(r.first_bytes),
      liveTuples: Number(r.live),
      deadTuples: Number(r.dead),
      lastAutovacuum: r.last_autovacuum?.toISOString() ?? null,
      lastAutoanalyze: r.last_autoanalyze?.toISOString() ?? null,
      seqScans: Number(r.seq_scan),
      indexScans: Number(r.idx_scan ?? 0),
    }));

    const unused = await db.$queryRaw<
      { table_name: string; index_name: string; bytes: bigint }[]
    >`SELECT s.relname AS table_name, s.indexrelname AS index_name,
             pg_relation_size(s.indexrelid) AS bytes
        FROM pg_stat_user_indexes s
        JOIN pg_index i ON i.indexrelid = s.indexrelid
       WHERE s.schemaname = 'public' AND s.idx_scan = 0
         AND NOT i.indisunique AND NOT i.indisprimary
       ORDER BY pg_relation_size(s.indexrelid) DESC
       LIMIT 50`;

    return {
      window,
      statements,
      timeouts,
      tables: [...tables]
        .sort((a, b) => b.totalBytes - a.totalBytes)
        .slice(0, TABLES_TOP),
      unusedIndexes: unused.map((u) => ({
        table: u.table_name,
        index: u.index_name,
        bytes: Number(u.bytes),
      })),
      // Where sequential scans cost the most: how many times the table was read whole, by its size.
      seqScanHeavy: [...tables]
        .filter((t) => t.seqScans > 0)
        .sort((a, b) => b.seqScans * b.totalBytes - a.seqScans * a.totalBytes)
        .slice(0, 10),
    };
  });
}
