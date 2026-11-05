import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import instanceHealthPrisma from "@/api/lib/prisma-instance-health";
import config from "@/config";
import { clipText } from "@/lib/text";
import { asFleetForInstanceHealth } from "../fleet-tx";

// Every SNAPSHOT_INTERVAL_MS the instance copies pg_stat_statements and the table statistics into its
// own tables (docs/logs.md, "Database"). pg_stat_statements is cumulative since its last reset, so a
// window on the screen is the difference between snapshots, never the lifetime total.

export const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
// Bounds one snapshot, so a server with a huge `pg_stat_statements.max` cannot fill the table.
const MAX_ENTRIES = 5_000;
const TEXT_MAX = 8_000;

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

interface Written {
  calls: number;
  totalExecMs: number;
  rows: number;
  statsSince: number | null;
  takenAt: number;
}

interface SnapshotState {
  // The last row written per entry: an entry that did not move is not written again, and its
  // previous row stays its baseline.
  written: Map<string, Written> | null;
  // The entries present at the previous run, and when that run was.
  presentAtPrevious: Set<string> | null;
  previousRunAt: number | null;
  lastRunAt: number | null;
  availability: StatementsAvailability | null;
}

const KEY = Symbol.for("fazerai.instanceHealth.dbSnapshot");

function state(): SnapshotState {
  const g = globalThis as unknown as Record<symbol, SnapshotState>;
  g[KEY] ??= {
    written: null,
    presentAtPrevious: null,
    previousRunAt: null,
    lastRunAt: null,
    availability: null,
  };
  return g[KEY];
}

// Test-only.
export function resetSnapshotState(): void {
  const s = state();
  s.written = null;
  s.presentAtPrevious = null;
  s.previousRunAt = null;
  s.lastRunAt = null;
  s.availability = null;
}

export function lastAvailability(): StatementsAvailability | null {
  return state().availability;
}

function keyOf(e: { userid: bigint; dbid: bigint; queryid: bigint }): string {
  return `${e.userid}:${e.dbid}:${e.queryid}`;
}

// The rows a run writes, given what it read and what was written before. Pure, so the rules are
// tested without the extension:
//   - an entry whose counters (or `stats_since`) did not change is not written;
//   - an entry that moved after a quiet stretch gets its unchanged value written at the PREVIOUS run
//     too, which is true (it had not moved) and gives the window that holds the previous run a
//     baseline, so its first movement is counted;
//   - an entry that appeared since the previous run (its `stats_since` is after it) gets a zero row
//     at the previous run, so its whole count lands in the window.
export function rowsToWrite(input: {
  entries: StatementEntry[];
  written: Map<string, Written>;
  presentAtPrevious: Set<string> | null;
  previousRunAt: number | null;
  takenAt: number;
}): {
  takenAt: number;
  entry: StatementEntry;
  values: Omit<Written, "takenAt">;
}[] {
  const out: {
    takenAt: number;
    entry: StatementEntry;
    values: Omit<Written, "takenAt">;
  }[] = [];
  for (const e of input.entries) {
    const k = keyOf(e);
    const prev = input.written.get(k);
    const statsSince = e.statsSince?.getTime() ?? null;
    const now = {
      calls: e.calls,
      totalExecMs: e.totalExecMs,
      rows: e.rows,
      statsSince,
    };
    if (
      prev &&
      prev.calls === now.calls &&
      prev.totalExecMs === now.totalExecMs &&
      prev.rows === now.rows &&
      prev.statsSince === now.statsSince
    ) {
      continue;
    }
    const p = input.previousRunAt;
    if (p !== null) {
      if (
        prev &&
        prev.takenAt < p &&
        input.presentAtPrevious?.has(k) &&
        (statsSince === null ||
          statsSince <= p ||
          prev.statsSince === statsSince)
      ) {
        out.push({ takenAt: p, entry: e, values: { ...prev } });
      } else if (
        statsSince !== null &&
        statsSince > p &&
        // Reset or evicted after the previous run: the counters start from zero there. Also when an
        // older baseline exists, since it can sit outside the window being read; one written AT
        // the previous run already is that baseline.
        (!prev || (prev.takenAt < p && prev.statsSince !== statsSince))
      ) {
        out.push({
          takenAt: p,
          entry: e,
          values: { calls: 0, totalExecMs: 0, rows: 0, statsSince },
        });
      }
    }
    out.push({ takenAt: input.takenAt, entry: e, values: now });
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

export async function readStatements(
  base: PrismaClient,
): Promise<
  | { availability: { available: true }; entries: StatementEntry[] }
  | { availability: Exclude<StatementsAvailability, { available: true }> }
> {
  const [ext] = await base.$queryRaw<
    { created: boolean; version: number }[]
  >`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS created,
           current_setting('server_version_num')::int AS version`;
  if (!ext?.created) {
    return { availability: { available: false, reason: "not_created" } };
  }
  const since = ext.version >= 170000 ? "stats_since" : "NULL::timestamptz";
  const top = ext.version >= 140000 ? "AND toplevel" : "";
  try {
    const rows = await base.$transaction(async (tx) => {
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
    const message = err instanceof Error ? err.message : String(err);
    // 55000: "pg_stat_statements must be loaded via shared_preload_libraries".
    if (/shared_preload_libraries/.test(message)) {
      return { availability: { available: false, reason: "not_loaded" } };
    }
    logger.warn({ err }, "database screen: pg_stat_statements unreadable");
    return { availability: { available: false, reason: "unreadable" } };
  }
}

async function loadWritten(base: PrismaClient): Promise<Map<string, Written>> {
  const rows = await asFleetForInstanceHealth(
    base,
    (db) => db.$queryRaw<
      {
        userid: bigint;
        dbid: bigint;
        queryid: bigint;
        calls: bigint;
        total_exec_ms: number;
        rows: bigint;
        stats_since: Date | null;
        taken_at: Date;
      }[]
    >`SELECT DISTINCT ON (userid, dbid, queryid)
             userid, dbid, queryid, calls, total_exec_ms, rows, stats_since, taken_at
        FROM db_statement_snapshots
       ORDER BY userid, dbid, queryid, taken_at DESC`,
  );
  return new Map(
    rows.map((r) => [
      keyOf(r),
      {
        calls: Number(r.calls),
        totalExecMs: Number(r.total_exec_ms),
        rows: Number(r.rows),
        statsSince: r.stats_since?.getTime() ?? null,
        takenAt: r.taken_at.getTime(),
      },
    ]),
  );
}

// One snapshot when the interval has passed since the last, then the retention prune. Returns
// whether one was taken. `now` is injectable for the tests.
export async function snapshotIfDue(
  base: PrismaClient = instanceHealthPrisma,
  now: number = Date.now(),
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const s = state();
  if (s.lastRunAt === null) {
    const [last] = await asFleetForInstanceHealth(base, (db) =>
      db.dbStatSnapshotRun.findMany({
        orderBy: { takenAt: "desc" },
        take: 2,
        select: { takenAt: true },
      }),
    );
    s.lastRunAt = last?.takenAt.getTime() ?? Number.NEGATIVE_INFINITY;
  }
  if (!opts.force && now - (s.lastRunAt as number) < SNAPSHOT_INTERVAL_MS) {
    return false;
  }
  const read = await readStatements(base);
  s.availability = read.availability;
  const takenAt = now;
  const tables = await base.$queryRaw<
    { table_name: string; total_bytes: bigint; live: bigint; dead: bigint }[]
  >`SELECT c.relname AS table_name, pg_total_relation_size(c.oid) AS total_bytes,
           s.n_live_tup AS live, s.n_dead_tup AS dead
      FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
     WHERE s.schemaname = 'public'`;

  let toWrite: ReturnType<typeof rowsToWrite> = [];
  if (read.availability.available && "entries" in read) {
    s.written ??= await loadWritten(base);
    const previousRunAt = Number.isFinite(s.lastRunAt as number)
      ? (s.lastRunAt as number)
      : null;
    toWrite = rowsToWrite({
      entries: read.entries,
      written: s.written,
      presentAtPrevious: s.presentAtPrevious,
      previousRunAt,
      takenAt,
    });
  }

  await asFleetForInstanceHealth(base, async (db) => {
    await db.dbStatSnapshotRun.create({
      data: {
        takenAt: new Date(takenAt),
        statementsAvailable: read.availability.available,
      },
    });
    if (toWrite.length > 0) {
      await db.dbStatementSnapshot.createMany({
        data: toWrite.map((w) => ({
          takenAt: new Date(w.takenAt),
          userid: w.entry.userid,
          dbid: w.entry.dbid,
          queryid: w.entry.queryid,
          // biome-ignore lint/plugin/no-bigint-cast: a counter read from pg_stat_statements, not an id
          calls: BigInt(Math.round(w.values.calls)),
          totalExecMs: w.values.totalExecMs,
          // biome-ignore lint/plugin/no-bigint-cast: a counter read from pg_stat_statements, not an id
          rows: BigInt(Math.round(w.values.rows)),
          statsSince:
            w.values.statsSince === null ? null : new Date(w.values.statsSince),
        })),
        skipDuplicates: true,
      });
      // One statement for every text, not one upsert each: the first snapshot writes them all, inside
      // the sampler's 10 s budget.
      const texts = new Map<string, StatementEntry>();
      for (const w of toWrite) texts.set(keyOf(w.entry), w.entry);
      const list = [...texts.values()];
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

  if (read.availability.available && "entries" in read && s.written) {
    for (const w of toWrite) {
      if (w.takenAt === takenAt) {
        s.written.set(keyOf(w.entry), { ...w.values, takenAt });
      }
    }
    s.presentAtPrevious = new Set(read.entries.map(keyOf));
  } else {
    s.presentAtPrevious = null;
  }
  s.previousRunAt = Number.isFinite(s.lastRunAt as number)
    ? (s.lastRunAt as number)
    : null;
  s.lastRunAt = takenAt;
  await pruneDatabaseScreen(base, now);
  return true;
}

// Retention: everything older than DB_STATS_RETENTION_DAYS goes, in the sampler's own budget.
export async function pruneDatabaseScreen(
  base: PrismaClient = instanceHealthPrisma,
  now: number = Date.now(),
  retentionDays: number = config.dbStats.retentionDays,
): Promise<void> {
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000);
  await asFleetForInstanceHealth(base, async (db) => {
    await db.dbStatSnapshotRun.deleteMany({
      where: { takenAt: { lt: cutoff } },
    });
    await db.dbStatementSnapshot.deleteMany({
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
  // The cached baselines may name rows just pruned; the next snapshot reloads them.
  const s = state();
  if (s.written) {
    for (const [k, w] of s.written) {
      if (w.takenAt < cutoff.getTime()) s.written.delete(k);
    }
  }
}
