import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import instanceHealthPrisma from "@/api/lib/prisma-instance-health";
import config from "@/config";
import type { TxBudget } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { budgetUntil, fleetWithin, plainWithin } from "./budget";

// Every SNAPSHOT_INTERVAL_MS the instance reads pg_stat_statements and the table statistics
// (docs/logs.md, "Database"). pg_stat_statements is cumulative, so what is stored is the DIFFERENCE
// each entry made since the previous snapshot, taken here at write time: a window on the screen is
// the sum of the rows inside it, and no row depends on another being kept.

export const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
// Bounds one snapshot, so a server with a huge `pg_stat_statements.max` cannot fill the table.
const MAX_ENTRIES = 5_000;
const TEXT_MAX = 8_000;
// What a snapshot run may take, all of its statements together, when no caller gives a deadline.
const SNAPSHOT_BUDGET_MS = 8_000;

export type StatementsAvailability =
  | { available: true }
  | { available: false; reason: "not_created" | "not_loaded" | "unreadable" };

export interface StatementEntry {
  userid: bigint;
  dbid: bigint;
  queryid: bigint;
  query: string;
  calls: number;
  totalExecMs: number;
  rows: number;
  statsSince: Date | null;
}

export interface Counters {
  calls: number;
  totalExecMs: number;
  rows: number;
  statsSince: number | null;
}

interface SnapshotState {
  // The counters each entry had at the previous snapshot of THIS process, the baseline of the next
  // difference. Null after a start: the first snapshot only takes it, which costs one interval of
  // series per restart.
  previous: Map<string, Counters> | null;
  // Whether that read was the whole view (fewer entries than the cap): only then does an entry
  // missing from it prove it started counting since.
  previousComplete: boolean;
  lastRunAt: number | null;
  availability: StatementsAvailability | null;
}

const KEY = Symbol.for("fazerai.instanceHealth.dbSnapshot");

function state(): SnapshotState {
  const g = globalThis as unknown as Record<symbol, SnapshotState>;
  g[KEY] ??= {
    previous: null,
    previousComplete: false,
    lastRunAt: null,
    availability: null,
  };
  return g[KEY];
}

// Test-only.
export function resetSnapshotState(): void {
  const s = state();
  s.previous = null;
  s.previousComplete = false;
  s.lastRunAt = null;
  s.availability = null;
}

// Test-only.
export function setLastAvailabilityForTest(
  availability: StatementsAvailability | null,
): void {
  state().availability = availability;
}

export function lastAvailability(): StatementsAvailability | null {
  return state().availability;
}

export function keyOf(e: {
  userid: bigint;
  dbid: bigint;
  queryid: bigint;
}): string {
  return `${e.userid}:${e.dbid}:${e.queryid}`;
}

// What each entry did since the previous read, the one rule the series rests on. Pure:
//   - seen before, counters not lower and the same `stats_since`: the difference;
//   - seen before but a counter went down or `stats_since` moved: a reset or an eviction, so what it
//     holds now is what it did since;
//   - not seen before: what it holds, when the previous read was complete (so it was not there);
//     nothing when it was cut at the cap (it may have been there with any count).
// Entries that did not run are left out.
export function deltasOf(input: {
  entries: StatementEntry[];
  previous: Map<string, Counters>;
  previousComplete: boolean;
}): { entry: StatementEntry; delta: Omit<Counters, "statsSince"> }[] {
  const out: { entry: StatementEntry; delta: Omit<Counters, "statsSince"> }[] =
    [];
  for (const e of input.entries) {
    const prev = input.previous.get(keyOf(e));
    const since = e.statsSince?.getTime() ?? null;
    let delta: Omit<Counters, "statsSince"> | null;
    if (prev) {
      const reset =
        e.calls < prev.calls ||
        e.totalExecMs < prev.totalExecMs ||
        e.rows < prev.rows ||
        (since !== null &&
          prev.statsSince !== null &&
          since !== prev.statsSince);
      delta = reset
        ? { calls: e.calls, totalExecMs: e.totalExecMs, rows: e.rows }
        : {
            calls: e.calls - prev.calls,
            totalExecMs: e.totalExecMs - prev.totalExecMs,
            rows: e.rows - prev.rows,
          };
    } else {
      delta = input.previousComplete
        ? { calls: e.calls, totalExecMs: e.totalExecMs, rows: e.rows }
        : null;
    }
    if (delta && delta.calls > 0) out.push({ entry: e, delta });
  }
  return out;
}

// Whether pg_stat_statements can be read here, and the entries of this database if so. A missing or
// unloaded extension is a state, not an error: the screen shows how to enable it.
// pg_stat_statements shows another role's statements (text and queryid) only to a member of
// pg_read_all_stats that HAS its privileges. Bootstrap grants the membership, but a NOINHERIT role
// (the runtime role on Postgres 15 and older, where bootstrap makes it NOINHERIT for the fleet role)
// holds it without its privileges, and the fleet path's statements would vanish from the screen.
// Such a member takes the role for this read-only transaction only; nothing else runs under it.
export async function takeStatsRole(
  tx: Pick<PrismaClient, "$queryRaw" | "$executeRawUnsafe">,
): Promise<void> {
  const [r] = await tx.$queryRaw<{ member: boolean; usage: boolean }[]>`
    SELECT pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS member,
           pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS usage`;
  if (r?.member && !r.usage) {
    await tx.$executeRawUnsafe("SET LOCAL ROLE pg_read_all_stats");
  }
}

// Which of the version-dependent columns the installed pg_stat_statements view has.
export async function statementColumns(
  db: Pick<PrismaClient, "$queryRaw">,
): Promise<Set<string>> {
  const cols = await db.$queryRaw<{ attname: string }[]>`
    SELECT attname::text AS attname FROM pg_attribute
     WHERE attrelid = to_regclass('pg_stat_statements')
       AND attname IN ('stats_since', 'toplevel') AND NOT attisdropped`;
  return new Set(cols.map((c) => c.attname));
}

// The schemas whose tables the screen shows: the application's, and the checkpointer's own
// (`langgraph`, src/graph/checkpointer.ts), where `checkpoint_blobs` can be the largest table there
// is. A table outside `public` is named with its schema, so the two never share a name.
// Both read a statistics view aliased `s`.
export const SCREEN_SCHEMAS = Prisma.sql`('public', 'langgraph')`;
export const TABLE_NAME = Prisma.sql`CASE WHEN s.schemaname = 'public' THEN s.relname::text
  ELSE s.schemaname || '.' || s.relname END`;

export async function readStatements(
  base: PrismaClient,
  budget: TxBudget,
): Promise<
  | { availability: { available: true }; entries: StatementEntry[] }
  | { availability: Exclude<StatementsAvailability, { available: true }> }
> {
  // The columns come from the INSTALLED extension version, not the server's: a server upgraded with
  // the extension left at an older version (CREATE EXTENSION IF NOT EXISTS never upgrades it) lacks
  // `stats_since` even on Postgres 17.
  const probe = await plainWithin(base, budget, async (db) => {
    const [ext] = await db.$queryRaw<{ created: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS created`;
    return ext?.created ? await statementColumns(db) : null;
  });
  if (!probe) {
    return { availability: { available: false, reason: "not_created" } };
  }
  const since = probe.has("stats_since") ? "stats_since" : "NULL::timestamptz";
  const top = probe.has("toplevel") ? "AND toplevel" : "";
  try {
    // Its own transaction: a server that does not preload the library errors here, and that error
    // aborts the transaction it runs in.
    const rows = await plainWithin(base, budget, async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL transaction_read_only = on");
      await takeStatsRole(tx);
      return tx.$queryRawUnsafe<
        {
          userid: bigint;
          dbid: bigint;
          queryid: bigint;
          query: string | null;
          calls: bigint;
          total_exec_time: number;
          rows: bigint;
          stats_since: Date | null;
        }[]
      >(
        `SELECT userid::bigint AS userid, dbid::bigint AS dbid, queryid, query, calls,
              total_exec_time, rows, ${since} AS stats_since
         FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND queryid IS NOT NULL ${top}
        ORDER BY total_exec_time DESC
        LIMIT ${MAX_ENTRIES}`,
      );
    });
    return {
      availability: { available: true },
      entries: rows.map((r) => ({
        userid: r.userid,
        dbid: r.dbid,
        queryid: r.queryid,
        query: clipText(r.query ?? "", TEXT_MAX),
        calls: Number(r.calls),
        totalExecMs: Number(r.total_exec_time),
        rows: Number(r.rows),
        statsSince: r.stats_since,
      })),
    };
  } catch (err) {
    return { availability: availabilityOfError(err) };
  }
}

// What a failed read of pg_stat_statements means: not preloaded, or unreadable for another reason.
export function availabilityOfError(
  err: unknown,
): Exclude<StatementsAvailability, { available: true }> {
  const message = err instanceof Error ? err.message : String(err);
  // 55000: "pg_stat_statements must be loaded via shared_preload_libraries".
  if (/shared_preload_libraries/.test(message)) {
    return { available: false, reason: "not_loaded" };
  }
  logger.warn({ err }, "database screen: pg_stat_statements unreadable");
  return { available: false, reason: "unreadable" };
}

// One snapshot when the interval has passed since the last, then the retention prune. Returns
// whether one was taken. Every statement runs under `budget` (one deadline for the whole run).
export async function snapshotIfDue(
  base: PrismaClient = instanceHealthPrisma,
  now: number = Date.now(),
  opts: { force?: boolean; budget?: TxBudget } = {},
): Promise<boolean> {
  const budget = opts.budget ?? budgetUntil(Date.now() + SNAPSHOT_BUDGET_MS);
  const s = state();
  if (s.lastRunAt === null) {
    const [last] = await fleetWithin(base, budget, (db) =>
      db.dbStatSnapshotRun.findMany({
        orderBy: { takenAt: "desc" },
        take: 1,
        select: { takenAt: true },
      }),
    );
    s.lastRunAt = last?.takenAt.getTime() ?? Number.NEGATIVE_INFINITY;
  }
  if (!opts.force && now - (s.lastRunAt as number) < SNAPSHOT_INTERVAL_MS) {
    return false;
  }
  const read = await readStatements(base, budget);
  s.availability = read.availability;
  const takenAt = now;
  const tables = await plainWithin(
    base,
    budget,
    (db) =>
      db.$queryRaw<
        {
          table_name: string;
          total_bytes: bigint;
          live: bigint;
          dead: bigint;
        }[]
      >`SELECT ${TABLE_NAME} AS table_name,
             pg_total_relation_size(c.oid) AS total_bytes,
             s.n_live_tup AS live, s.n_dead_tup AS dead
        FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
       WHERE s.schemaname IN ${SCREEN_SCHEMAS}`,
  );

  const entries = "entries" in read ? read.entries : null;
  const deltas =
    entries && s.previous
      ? deltasOf({
          entries,
          previous: s.previous,
          previousComplete: s.previousComplete,
        })
      : [];

  await fleetWithin(base, budget, async (db) => {
    await db.dbStatSnapshotRun.create({
      data: {
        takenAt: new Date(takenAt),
        statementsAvailable: read.availability.available,
      },
    });
    if (deltas.length > 0) {
      await db.dbStatementDelta.createMany({
        data: deltas.map((d) => ({
          takenAt: new Date(takenAt),
          userid: d.entry.userid,
          dbid: d.entry.dbid,
          queryid: d.entry.queryid,
          // biome-ignore lint/plugin/no-bigint-cast: a counter read from pg_stat_statements, not an id
          calls: BigInt(Math.round(d.delta.calls)),
          totalExecMs: d.delta.totalExecMs,
          // biome-ignore lint/plugin/no-bigint-cast: a counter read from pg_stat_statements, not an id
          rows: BigInt(Math.round(d.delta.rows)),
        })),
        skipDuplicates: true,
      });
      // One statement for every text, not one upsert each.
      const list = deltas.map((d) => d.entry);
      await db.$executeRaw`
        INSERT INTO db_statement_texts (userid, dbid, queryid, query, last_seen_at)
        SELECT u, d, q, t, ${new Date(takenAt)}
          FROM unnest(${list.map((e) => String(e.userid))}::bigint[],
                      ${list.map((e) => String(e.dbid))}::bigint[],
                      ${list.map((e) => String(e.queryid))}::bigint[],
                      ${list.map((e) => e.query)}::text[]) AS x(u, d, q, t)
        ON CONFLICT (userid, dbid, queryid)
        DO UPDATE SET query = excluded.query, last_seen_at = excluded.last_seen_at`;
    }
    if (tables.length > 0) {
      await db.dbTableSnapshot.createMany({
        data: tables.map((t) => ({
          takenAt: new Date(takenAt),
          tableName: t.table_name,
          totalBytes: t.total_bytes,
          liveTuples: t.live,
          deadTuples: t.dead,
        })),
        skipDuplicates: true,
      });
    }
  });

  // The baseline of the next difference: this read, whole.
  if (entries) {
    s.previous = new Map(
      entries.map((e) => [
        keyOf(e),
        {
          calls: e.calls,
          totalExecMs: e.totalExecMs,
          rows: e.rows,
          statsSince: e.statsSince?.getTime() ?? null,
        },
      ]),
    );
    s.previousComplete = entries.length < MAX_ENTRIES;
  } else {
    s.previous = null;
    s.previousComplete = false;
  }
  s.lastRunAt = takenAt;
  // The snapshot is committed: a failed cleanup is logged and retried with the next snapshot, and
  // must not read as a failed snapshot.
  try {
    await pruneDatabaseScreen(base, now, config.dbStats.retentionDays, budget);
  } catch (err) {
    logger.warn({ err }, "database screen: retention prune failed");
  }
  return true;
}

// Retention: everything older than DB_STATS_RETENTION_DAYS goes. Nothing stored depends on an older
// row, so the cut is plain.
export async function pruneDatabaseScreen(
  base: PrismaClient = instanceHealthPrisma,
  now: number = Date.now(),
  retentionDays: number = config.dbStats.retentionDays,
  budget: TxBudget = budgetUntil(Date.now() + SNAPSHOT_BUDGET_MS),
): Promise<void> {
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000);
  await fleetWithin(base, budget, async (db) => {
    await db.dbStatSnapshotRun.deleteMany({
      where: { takenAt: { lt: cutoff } },
    });
    await db.dbStatementDelta.deleteMany({
      where: { takenAt: { lt: cutoff } },
    });
    await db.dbStatementText.deleteMany({
      where: { lastSeenAt: { lt: cutoff } },
    });
    await db.dbTableSnapshot.deleteMany({ where: { takenAt: { lt: cutoff } } });
    await db.dbStatementTimeout.deleteMany({
      where: { occurredAt: { lt: cutoff } },
    });
  });
}
