import { Prisma } from "@/../generated/prisma/client";
import config from "@/config";
import type { ScopedDb } from "@/lib/tenancy";
import { FAMILIES, type Family } from "./sections";

// WHERE THE KEPT DAYS LIVE AND WHAT DROPS THEM (docs/dashboard.md, "Kept days"). The triggers of
// migration 20261013170000 queue every late change to `dashboard_dirty`; `settleDirty` turns the queue
// into the kept rows it invalidates, across every filter and zone, before a request reads any.

export interface KeptRow {
  section: string;
  day: string;
  data: unknown;
  // When the row was computed: every row of one computation shares it.
  at?: string;
}

export async function readKept(
  db: ScopedDb,
  key: { version: string; filterKey: string; tz: string },
  sections: string[],
  days: string[],
): Promise<KeptRow[]> {
  if (sections.length === 0 || days.length === 0) return [];
  return db.$queryRaw<KeptRow[]>(Prisma.sql`
    SELECT section, to_char(day, 'YYYY-MM-DD') AS day, data, computed_at::text AS at
      FROM dashboard_days
     WHERE version = ${key.version} AND filter_key = ${key.filterKey} AND tz = ${key.tz}
       AND section = ANY(${sections}::text[])
       AND day = ANY(${days}::date[])`);
}

export async function writeKept(
  db: ScopedDb,
  key: { tenantId: bigint; version: string; filterKey: string; tz: string },
  rows: KeptRow[],
) {
  for (let i = 0; i < rows.length; i += 2000) {
    const batch = rows.slice(i, i + 2000);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO dashboard_days (tenant_id, version, filter_key, tz, section, day, data)
      SELECT ${key.tenantId}, ${key.version}, ${key.filterKey}, ${key.tz}, x.s, x.d::date, x.j::jsonb
        FROM unnest(${batch.map((r) => r.section)}::text[],
                    ${batch.map((r) => r.day)}::text[],
                    ${batch.map((r) => JSON.stringify(r.data))}::text[]) AS x(s, d, j)
      ON CONFLICT (tenant_id, version, filter_key, tz, section, day)
      DO UPDATE SET data = EXCLUDED.data, computed_at = EXCLUDED.computed_at`);
  }
}

// The instants a set of dirty rows reaches, for the families asked. A conversation that changed
// reaches its creation, every ledger and flow-log line it has, and the suggestions proposed in its
// thread; a ledger line reaches the conversation's other ledger lines (which of them comes first), its
// creation (whether the agent ran on it) and its flow-log lines (whether a person taking over came
// after an agent turn), a flow-log line its other flow-log lines; a row without a
// conversation reaches only its own instant. Binned to the quarter hour (every zone's midnight falls
// on one), so a conversation with thousands of lines yields a few instants per day.
function instantsSql(where: Prisma.Sql, fams: readonly Family[] = FAMILIES) {
  const has = (f: Family) => fams.includes(f);
  const parts: Prisma.Sql[] = [];
  const convsOf = (sections: string[]) =>
    Prisma.sql`(SELECT DISTINCT conversation_id AS id FROM dirty
                 WHERE conversation_id IS NOT NULL
                   AND (section IS NULL OR section = ANY(${sections}::text[])))`;
  if (has("conv"))
    parts.push(Prisma.sql`
      SELECT 'conv' AS fam, c.created_at AS at
        FROM conversations c JOIN ${convsOf(["ledger"])} v ON v.id = c.id`);
  if (has("ledger"))
    parts.push(Prisma.sql`
      SELECT 'ledger', date_bin('15 minutes', u.created_at, TIMESTAMP '2000-01-01')
        FROM llm_usage u JOIN ${convsOf(["ledger"])} v ON u.conversation_id = v.id`);
  if (has("log"))
    parts.push(Prisma.sql`
      SELECT 'log', date_bin('15 minutes', l.created_at, TIMESTAMP '2000-01-01')
        FROM execution_logs l JOIN ${convsOf(["log", "ledger"])} v ON l.conversation_id = v.id`);
  if (has("know"))
    parts.push(Prisma.sql`
      SELECT 'know', date_bin('15 minutes', q.created_at, TIMESTAMP '2000-01-01')
        FROM approval_queue_items q
        JOIN conversations c ON c.thread_id = q.thread_id
        JOIN ${convsOf([])} v ON v.id = c.id`);
  parts.push(Prisma.sql`
      SELECT COALESCE(d.section, 'conv'), d.at FROM dirty d
       WHERE d.at IS NOT NULL AND COALESCE(d.section, 'conv') = ANY(${[...fams]}::text[])`);
  return Prisma.sql`
    WITH dirty AS MATERIALIZED (
      SELECT id, conversation_id, section, at FROM dashboard_dirty WHERE ${where})
    SELECT DISTINCT fam, at FROM (${Prisma.join(parts, " UNION ALL ")}) x(fam, at)
     WHERE at IS NOT NULL`;
}

// The local days those instants fall on, per family, in every zone a day is kept in: few rows, which
// reach the kept days through their (tenant, zone, day) index.
function hitDaysSql(inst: Prisma.Sql) {
  return Prisma.sql`
    WITH RECURSIVE zones AS (
      SELECT MIN(tz) AS tz FROM dashboard_days
      UNION ALL
      SELECT (SELECT MIN(tz) FROM dashboard_days WHERE tz > z.tz) FROM zones z WHERE z.tz IS NOT NULL),
    inst AS (${inst})
    SELECT DISTINCT i.fam, z.tz, ((i.at AT TIME ZONE 'UTC') AT TIME ZONE z.tz)::date AS day
      FROM inst i CROSS JOIN zones z
     WHERE z.tz IS NOT NULL`;
}

// Drop the kept days one batch of queued changes reaches, then mark it processed. A flow-log day whose
// lines the retention sweep may already have removed is left alone: recomputing it would count fewer
// lines than it kept. The batch waits for rows another request is settling instead of skipping them,
// so an empty batch means every change queued before it has dropped its days.
export const SETTLE_BATCH = 20_000;

// A part that keeps its days holds `key` shared from the moment it checks for changes until it commits;
// a batch holds it alone. So a batch never marks a change processed while a part that missed it is
// still about to keep the days it reaches: it waits, and then drops them.
export async function publishing(db: ScopedDb, key: string) {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))::text`,
  );
}

export async function settleDirty(
  db: ScopedDb,
  key: string,
  batch: number = SETTLE_BATCH,
): Promise<number> {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`,
  );
  const picked = await db.$queryRaw<
    { id: bigint; section: string | null }[]
  >(Prisma.sql`
    SELECT id, section FROM dashboard_dirty
     WHERE processed_at IS NULL
     ORDER BY id
     LIMIT ${batch}
     FOR UPDATE`);
  if (picked.length === 0) return 0;
  const ids = picked.map((p) => p.id);
  if (picked.some((p) => p.section === "conv-all")) {
    await db.$executeRaw(
      Prisma.sql`DELETE FROM dashboard_days WHERE section LIKE 'conv.%'`,
    );
  }
  const retention = `${config.flowlog.retentionDays} days`;
  await db.$executeRaw(Prisma.sql`
    WITH hit AS (${hitDaysSql(instantsSql(Prisma.sql`id = ANY(${ids}::bigint[])`))})
    DELETE FROM dashboard_days k
     USING hit h
     WHERE k.tz = h.tz AND k.day = h.day
       AND k.section LIKE h.fam || '.%'
       AND NOT (h.fam = 'log' AND (k.day::timestamp AT TIME ZONE k.tz) < now() - ${retention}::interval)`);
  await db.$executeRaw(Prisma.sql`
    UPDATE dashboard_dirty SET processed_at = clock_timestamp() AT TIME ZONE 'UTC'
     WHERE id = ANY(${ids}::bigint[])`);
  await db.$executeRaw(Prisma.sql`
    DELETE FROM dashboard_dirty
     WHERE processed_at < (now() AT TIME ZONE 'UTC') - interval '1 day'`);
  return picked.length;
}

// The (family, local day) pairs a part's snapshot may not have seen: changes still in the queue when
// the part checks, whatever their writer's start, and changes a batch settled since the part began
// (`began`, by the clock the batch stamps with). A change settled before the part began was committed
// before it, so the part's snapshot already counts it, and the part keeps the days it reaches: on a
// tenant whose old conversations change every few minutes, a margin before the part's start would
// leave those days to be computed again on every request.
export async function changedSince(
  db: ScopedDb,
  began: Date,
  tz: string,
  fam: Family,
): Promise<Set<string>> {
  const unseen = Prisma.sql`(processed_at IS NULL OR processed_at >= ${began})`;
  const rows = await db.$queryRaw<
    { fam: Family | "conv-all"; day: string | null }[]
  >(Prisma.sql`
    WITH inst AS (${instantsSql(unseen, [fam])})
    SELECT fam, to_char(((at AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text)::date, 'YYYY-MM-DD') AS day
      FROM inst
    UNION ALL
    SELECT 'conv-all', NULL FROM dashboard_dirty
     WHERE ${unseen} AND section = 'conv-all'`);
  return new Set(
    rows.map((r) => (r.fam === "conv-all" ? "conv-all" : `${r.fam}|${r.day}`)),
  );
}

// The first day the tenant has anything a dashboard figure reads, in the zone, or a day kept for this
// view, whose records the flow-log sweep may have removed since. Null when none.
export async function firstDataDay(
  db: ScopedDb,
  tz: string,
  key: { version: string; filterKey: string },
): Promise<string | null> {
  const [row] = await db.$queryRaw<{ day: string | null }[]>(Prisma.sql`
    SELECT to_char(LEAST(
             ((LEAST(
               (SELECT MIN(created_at) FROM conversations),
               (SELECT MIN(created_at) FROM llm_usage),
               (SELECT MIN(created_at) FROM execution_logs),
               (SELECT MIN(created_at) FROM approval_queue_items)
             ) AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text)::date,
             (SELECT MIN(day) FROM dashboard_days
               WHERE version = ${key.version} AND filter_key = ${key.filterKey} AND tz = ${tz})
           ), 'YYYY-MM-DD') AS day`);
  return row?.day ?? null;
}

export async function tryLock(db: ScopedDb, key: string): Promise<boolean> {
  const [row] = await db.$queryRaw<{ got: boolean }[]>(
    Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS got`,
  );
  return row?.got === true;
}

export async function readCells(
  db: ScopedDb,
  key: { version: string; filterKey: string; tz: string },
  sections: string[],
  days: string[],
): Promise<KeptRow[]> {
  return readKept(db, key, sections, days);
}
