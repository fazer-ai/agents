import type { PrismaClient } from "@/../generated/prisma/client";
import metricsPrisma from "@/api/lib/prisma-metrics";
import config from "@/config";
import type { TxBudget } from "@/lib/tenancy";
import { metricsBudget, metricsDeadline } from "@/modules/analytics/budget";
import { budgetUntil, fleetWithin, plainWithin } from "./budget";
import {
  availabilityOfError,
  lastAvailability,
  SCREEN_SCHEMAS,
  SNAPSHOT_INTERVAL_MS,
  type StatementsAvailability,
  TABLE_NAME,
} from "./snapshot";
import { type PlanFailure, planFailureOf, plannedScopeOf } from "./timeouts";

// What the "Database" screen, its REST route and its MCP tool read (docs/logs.md, "Database"). Every
// figure about statements is the sum of the deltas stored inside the window (./snapshot.ts).

export const WINDOWS = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
} as const;
export type WindowKey = keyof typeof WINDOWS;

const TOP = 50;
// At most this many points per series, and never more than the snapshots a window holds: a bucket
// shorter than the snapshot interval would be empty every other time and draw a run as a gap.
const SPARK_BUCKETS = 24;

export function sparkBuckets(spanMs: number): number {
  return Math.max(
    1,
    Math.min(SPARK_BUCKETS, Math.floor(spanMs / SNAPSHOT_INTERVAL_MS)),
  );
}
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

// The settings load the library; the extension itself is created per database, by a role allowed to
// (db-bootstrap tries it, and on a managed server it may not have been allowed). Said apart, since it
// is a statement to run and not a setting.
export const CREATE_STATEMENTS =
  "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;";

export interface StatementRowDto {
  queryid: string;
  userid: string;
  query: string;
  calls: number;
  rows: number;
  totalMs: number;
  meanMs: number;
  // The mean as a share of DB_TX_TIMEOUT_MS, in percent and not capped at 100; null with no budget.
  meanBudgetPct: number | null;
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
  // The category of planError, for the screen; null when a plan was taken or none was tried.
  planFailure: PlanFailure | null;
  plannedAs: string | null;
  // plannedAs as fields, for the screen.
  plannedScope: { fleet: boolean; tenantId: string | null } | null;
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
  // Dead rows over live plus dead; null for an empty table.
  deadRatio: number | null;
  // The dead-row count at which autovacuum triggers on this table, computed as autovacuum does: the
  // table's own autovacuum_vacuum_threshold and _scale_factor (the server's where it sets none), the
  // scale factor applied to `reltuples`.
  vacuumTriggerRows: number;
  // More dead rows than `vacuumTriggerRows`: autovacuum should already have run on this table.
  vacuumOverdue: boolean;
}

export interface DatabaseScreenDto {
  window: WindowKey;
  statements:
    | {
        available: true;
        snapshots: number;
        lastSnapshotAt: string | null;
        // DB_TX_TIMEOUT_MS, which each row's meanBudgetPct is a share of.
        budgetMs: number;
        byTotal: StatementRowDto[];
        byMean: StatementRowDto[];
      }
    | {
        available: false;
        reason: "not_created" | "not_loaded" | "unreadable";
        enable: readonly string[];
        // The statement that creates the extension in this database, when it does not exist here.
        create: string | null;
      };
  timeouts: TimeoutDto[];
  // Every timeout of the window, across all the groups (the list above stops at TIMEOUT_GROUPS).
  timeoutOccurrences: number;
  // Every table of the screen's schemas, indexes and TOAST included, and how much they grew in the
  // window (null when no table has a snapshot that old).
  size: { totalBytes: number; growthBytes: number | null };
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
  const buckets = sparkBuckets(span);
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
           least(${buckets - 1}, floor(extract(epoch FROM taken_at - ${from}::timestamp) * 1000 / ${span} * ${buckets}))::int AS bucket,
           sum(calls)::float8 AS calls, sum(total_exec_ms)::float8 AS total_ms
      FROM db_statement_deltas
     WHERE taken_at > ${from} AND taken_at <= ${to}
       AND (userid::text || ':' || dbid::text || ':' || queryid::text)
           = ANY(${keys.map((k) => `${k.userid}:${k.dbid}:${k.queryid}`)}::text[])
     GROUP BY 1, 2, 3, 4`;
  for (const k of keys) {
    out.set(`${k.userid}:${k.dbid}:${k.queryid}`, Array(buckets).fill(null));
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
): Promise<{ pct: number; query: string | null; meanMs: number }> {
  return fleetWithin(base, txBudget, async (db) => {
    const totals = await statementTotals(
      db,
      new Date(now - WINDOWS["1h"]),
      new Date(now),
    );
    if (totals.length === 0) return { pct: 0, query: null, meanMs: 0 };
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
    if (!best || budgetMs <= 0) return { pct: 0, query: null, meanMs: 0 };
    return {
      pct: (best.mean / budgetMs) * 100,
      query: best.query,
      meanMs: best.mean,
    };
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
  budgetMs: number,
): StatementRowDto {
  const k = `${t.userid}:${t.dbid}:${t.queryid}`;
  const meanMs = t.calls > 0 ? t.total_ms / t.calls : 0;
  return {
    queryid: String(t.queryid),
    userid: String(t.userid),
    query: texts.get(k) ?? "",
    calls: t.calls,
    rows: t.rows,
    totalMs: t.total_ms,
    meanMs,
    meanBudgetPct: budgetMs > 0 ? (meanMs / budgetMs) * 100 : null,
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

// `trigger`: the table's effective threshold and scale factor, and its `reltuples` (-1 when never
// analyzed, which autovacuum reads as zero rows).
export function deadRows(
  live: number,
  dead: number,
  trigger: { threshold: number; scale: number; reltuples: number },
): Pick<TableHealthDto, "deadRatio" | "vacuumOverdue" | "vacuumTriggerRows"> {
  const at =
    Number(trigger.threshold) +
    Number(trigger.scale) * Math.max(0, Number(trigger.reltuples));
  return {
    deadRatio: live + dead > 0 ? dead / (live + dead) : null,
    vacuumTriggerRows: Math.round(at),
    vacuumOverdue: dead > at,
  };
}

// How late after a window's start its growth baseline may be taken: a tenth of the window, and never
// less than two snapshot intervals, so a missed snapshot does not blank the 1h figure.
export function growthBaselineSlackMs(windowMs: number): number {
  return Math.max(2 * SNAPSHOT_INTERVAL_MS, windowMs / 10);
}

export async function readDatabaseScreen(
  window: WindowKey,
  base: PrismaClient = metricsPrisma,
  now: number = Date.now(),
  budgetMs: number = config.dbTx.timeoutMs,
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
        budgetMs,
        byTotal: byTotal.map((t) => toRow(t, texts, spark, budgetMs)),
        byMean: byMean.map((t) => toRow(t, texts, spark, budgetMs)),
      };
    } else {
      statements = {
        available: false,
        reason: availability.reason,
        enable: ENABLE_STATEMENTS,
        create:
          availability.reason === "not_created" ? CREATE_STATEMENTS : null,
      };
    }

    // Counted over the whole window first, then limited to the statements that failed most
    // recently: a storm of one statement neither undercounts itself nor hides the others. Each
    // group shows its newest occurrence's scope and the newest plan of that statement taken under
    // THAT scope (the same role and tenant), which can predate the window and still describes it: a
    // plan from another scope carries another RLS predicate and is never shown in its place.
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
               AND t.fleet = l.fleet
               AND t.scope_tenant_id IS NOT DISTINCT FROM l.scope_tenant_id
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
      planFailure: r.plan_error === null ? null : planFailureOf(r.plan_error),
      plannedAs: r.planned_as,
      plannedScope: r.planned_as === null ? null : plannedScopeOf(r.planned_as),
      plannedAt: r.planned_at?.toISOString() ?? null,
    }));
    const [occurrences] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM db_statement_timeouts
       WHERE occurred_at >= ${from} AND occurred_at <= ${to}`;

    // Growth is measured from a snapshot near the window's start: a later one would report the minutes
    // since it as the window's growth (a 7d window on an instance a day old). Without one, unknown.
    const baselineUntil = new Date(
      from.getTime() + growthBaselineSlackMs(WINDOWS[window]),
    );
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
        vac_threshold: number;
        vac_scale: number;
        reltuples: number;
      }[]
    >`SELECT t.table_name, pg_total_relation_size(c.oid) AS total_bytes,
             COALESCE(
               (SELECT split_part(o, '=', 2)::float8 FROM unnest(c.reloptions) o
                 WHERE o LIKE 'autovacuum_vacuum_threshold=%'),
               current_setting('autovacuum_vacuum_threshold')::float8) AS vac_threshold,
             COALESCE(
               (SELECT split_part(o, '=', 2)::float8 FROM unnest(c.reloptions) o
                 WHERE o LIKE 'autovacuum_vacuum_scale_factor=%'),
               current_setting('autovacuum_vacuum_scale_factor')::float8) AS vac_scale,
             c.reltuples::float8 AS reltuples,
             s.n_live_tup AS live, s.n_dead_tup AS dead,
             s.last_autovacuum, s.last_autoanalyze, s.seq_scan, s.idx_scan,
             (SELECT ts.total_bytes FROM db_table_snapshots ts
               WHERE ts.table_name = t.table_name AND ts.taken_at >= ${from}
                 AND ts.taken_at <= ${baselineUntil}
               ORDER BY ts.taken_at ASC LIMIT 1) AS first_bytes
        FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
        CROSS JOIN LATERAL (
          SELECT ${TABLE_NAME} AS table_name) t
       WHERE s.schemaname IN ${SCREEN_SCHEMAS}`;
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
      ...deadRows(Number(r.live), Number(r.dead), {
        threshold: r.vac_threshold,
        scale: r.vac_scale,
        reltuples: r.reltuples,
      }),
    }));
    const grown = tables.filter((t) => t.growthBytes !== null);

    const unused = await db.$queryRaw<
      { table_name: string; index_name: string; bytes: bigint }[]
    >`SELECT ${TABLE_NAME} AS table_name,
             s.indexrelname AS index_name, pg_relation_size(s.indexrelid) AS bytes
        FROM pg_stat_user_indexes s
        JOIN pg_index i ON i.indexrelid = s.indexrelid
       WHERE s.schemaname IN ${SCREEN_SCHEMAS} AND s.idx_scan = 0
         AND NOT i.indisunique AND NOT i.indisprimary
       ORDER BY pg_relation_size(s.indexrelid) DESC
       LIMIT 50`;

    return {
      window,
      statements,
      timeouts,
      timeoutOccurrences: occurrences?.n ?? 0,
      size: {
        totalBytes: tables.reduce((n, t) => n + t.totalBytes, 0),
        growthBytes: grown.length
          ? grown.reduce((n, t) => n + (t.growthBytes ?? 0), 0)
          : null,
      },
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
