import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import {
  asSuperAdminOn,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
  type TxBudget,
} from "@/lib/tenancy";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import {
  type JobContext,
  type JobResult,
  registerJobHandler,
} from "@/modules/scheduler/worker";
import {
  addRuns,
  countConversationDays,
  countConversations,
  settleConversationMarks,
} from "./conversation-sums";
import { audienceSql, type DashboardFilter, usageWhereSql } from "./filter";
import { type DayGroup, insideOneGroupSql } from "./grain";

// THE LEDGER'S QUARTER-HOUR SUMS (docs/dashboard.md, "Ledger sums"). The dashboard's
// ledger blocks read `llm_usage` summed per UTC quarter hour, and the call latency from a histogram
// per UTC day, instead of the window's rows. A job per tenant writes the sums for the quarters wholly
// below a safe mark that no uncommitted row can fall under; the statement triggers of
// prisma/migrations/20261118120000_ledger_quarter_sums mark the quarters of rows written, rewritten
// or deleted below it; a reader reads the sums of the unmarked quarters below the mark and the rows of
// everything else, so every figure is the figure the rows give.

// How far behind the moment its mark was taken a quarter must end before it is summed. The trigger
// marks a row older than this when its statement runs, which is the other half of the rule.
export const GRACE_MS = 5 * 60 * 1000;
const QUARTER_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// How much of a tenant's earlier ledger one transaction sums on the way up to the mark: a day of a
// large tenant is a few hundred thousand rows, well inside a scoped transaction's budget.
const SLICE_MS = DAY_MS;
// How long one run works before it hands the lane back, far under the run's deadline
// (worker.ts, jobDeadlineMs), and how soon it runs again.
const RUN_BUDGET_MS = 30_000;
// A step's transaction: the slice and the marks it settles, under the handler's budget.
const STEP_TX: TxBudget = { maxWait: 5_000, timeout: 25_000 };
// The marked quarters one step sums again: a day's worth, as much as a slice, so a repricing of a
// month is settled over steps that each fit the transaction, and every mark left waits, read from its
// rows meanwhile.
export const MARKED_QUARTERS_PER_STEP = 96;
const MARKS_PER_READ = 5000;
const RERUN_MS = 60_000;
const DEDUPE_KEY = "ledger-sums";

// The columns a sums row carries, in the order every source below yields them.
const SUM_COLUMNS = Prisma.raw(
  "quarter, source, anonymous, agent_id, inbox_id, model, node, cost_usd, requests, unpriced, prompt_tokens, completion_tokens, cached_read_tokens, cache_creation_tokens",
);

// The same columns on a day sums row, the day apart, and the keys a day groups its quarters by.
const DAY_COLUMNS = Prisma.raw(
  "source, anonymous, agent_id, inbox_id, model, node, cost_usd, requests, unpriced, prompt_tokens, completion_tokens, cached_read_tokens, cache_creation_tokens",
);
const DAY_GROUP_COLUMNS = Prisma.raw(
  "q.source, q.anonymous, q.agent_id, q.inbox_id, q.model, q.node",
);

// The rows of `u` grouped into the shape of a sums row.
function rawSumsSelect(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT ledger_quarter(u.created_at) AS quarter, u.source, u.anonymous, u.agent_id, u.inbox_id,
           u.model, COALESCE(u.node, 'agent') AS node,
           SUM(u.cost_usd) AS cost_usd,
           COUNT(*)::int AS requests,
           COUNT(*) FILTER (WHERE u.cost_usd IS NULL)::int AS unpriced,
           COALESCE(SUM(u.prompt_tokens), 0)::bigint AS prompt_tokens,
           COALESCE(SUM(u.completion_tokens), 0)::bigint AS completion_tokens,
           COALESCE(SUM(u.cached_read_tokens), 0)::bigint AS cached_read_tokens,
           COALESCE(SUM(u.cache_creation_tokens), 0)::bigint AS cache_creation_tokens
      FROM llm_usage u
     WHERE ${where}
     GROUP BY 1, 2, 3, 4, 5, 6, 7`;
}

// The view's filter on a sums row, the window apart: the same segment, audience, agent and inbox
// `usageWhereSql` applies to a ledger row.
function sumsFilterSql(alias: string, f: DashboardFilter): Prisma.Sql {
  const s = Prisma.raw(alias);
  const source = f.source ?? null;
  const agent = f.agentId ?? null;
  const inbox = f.inboxId ?? null;
  return Prisma.sql`(${source}::text IS NULL OR ${s}.source = ${source})
    AND ${audienceSql(alias, f)}
    AND (${agent}::bigint IS NULL OR ${s}.agent_id = ${agent})
    AND (${inbox}::bigint IS NULL OR ${s}.inbox_id = ${inbox})`;
}

// THE STRETCH OF THE WINDOW THE SUMS COVER: the quarters from the first one wholly inside the window
// (`lo`, null for an open start) up to the earlier of the last one wholly inside it and the tenant's
// mark (`hi`). Null when the sums cover nothing of the window, which reads it all from the rows. Read
// in a statement of its own so the reads below carry the bounds as values the planner can use: sums
// below a mark stay valid once written (a later change marks its quarter, and the marks are read in
// the same statement as the sums), so a mark that moves after this read only leaves more to read from
// the rows.
export interface SumsBounds {
  lo: Date | null;
  hi: Date;
}

export async function sumsBounds(
  db: ScopedDb,
  f: DashboardFilter,
): Promise<SumsBounds | null> {
  const [row] = await db.$queryRaw<{ until: Date | null }[]>(
    Prisma.sql`SELECT max(summed_until) AS until FROM ledger_sums_state`,
  );
  const until = row?.until ?? null;
  if (!until) return null;
  const lo = f.since ? ceilQuarter(f.since.getTime()) : null;
  const hi = Math.min(
    until.getTime(),
    f.until ? floorQuarter(f.until.getTime()) : Number.POSITIVE_INFINITY,
  );
  if (lo !== null && hi <= lo) return null;
  return { lo: lo === null ? null : new Date(lo), hi: new Date(hi) };
}

// THE VIEW'S LEDGER, AS SUMS ROWS: one statement's CTEs, `marks` and a SELECT named `ledger` whose
// rows carry `SUM_COLUMNS`. A reader sums them again by what it groups by: the cost, the tokens and the
// counts add up exactly (the cost is decimal), and a group whose every call was unpriced keeps a null
// cost. Without bounds every row of the window is read. Given a week or month grouping, a UTC day of
// the summed stretch wholly inside one local group and with no marked quarter comes from its day row,
// whose `quarter` is the day's start, and every other day of the stretch from its quarters.
export function ledgerCtesSql(
  f: DashboardFilter,
  b: SumsBounds | null,
  group?: DayGroup | null,
): Prisma.Sql {
  const where = usageWhereSql("u", f);
  if (!b) {
    return Prisma.sql`marks AS (SELECT NULL::timestamp AS quarter WHERE false),
      ledger AS (${rawSumsSelect(where)})`;
  }
  const lo = b.lo ?? new Date(0);
  const dayLo = b.lo === null ? 0 : Math.ceil(b.lo.getTime() / DAY_MS) * DAY_MS;
  const dayHi = floorDay(b.hi.getTime());
  const unmarked = Prisma.sql`NOT EXISTS (SELECT 1 FROM marks WHERE marks.quarter = s.quarter)`;
  const quarters = (range: Prisma.Sql) => Prisma.sql`
      SELECT ${SUM_COLUMNS} FROM ledger_quarter_sums s
       WHERE ${range} AND ${unmarked} AND ${sumsFilterSql("s", f)}`;
  const byDay = group && group.grain !== "day" && dayHi > dayLo;
  const summed = byDay
    ? Prisma.sql`${daySumsSql(f, new Date(dayLo), new Date(dayHi))}
      UNION ALL
      ${quarters(Prisma.sql`s.quarter >= ${lo} AND s.quarter < ${new Date(dayLo)}`)}
      UNION ALL
      ${quarters(Prisma.sql`s.quarter >= ${new Date(dayHi)} AND s.quarter < ${b.hi}`)}
      UNION ALL
      SELECT r.* FROM generate_series(${new Date(dayLo)}::timestamp, ${new Date(dayHi)}::timestamp - interval '1 day', interval '1 day') AS g(day)
       CROSS JOIN LATERAL (
         ${quarters(Prisma.sql`s.quarter >= g.day AND s.quarter < g.day + interval '1 day'`)}
         OFFSET 0
       ) r
       WHERE NOT EXISTS (SELECT 1 FROM ldays WHERE ldays.day = g.day)`
    : quarters(Prisma.sql`s.quarter >= ${lo} AND s.quarter < ${b.hi}`);
  const ldays = byDay
    ? Prisma.sql`ldays AS MATERIALIZED (
      SELECT d.day FROM generate_series(${new Date(dayLo)}::timestamp, ${new Date(dayHi)}::timestamp - interval '1 day', interval '1 day') AS d(day)
       WHERE NOT EXISTS (SELECT 1 FROM marks WHERE marks.quarter >= d.day AND marks.quarter < d.day + interval '1 day')
         AND ${insideOneGroupSql(group, Prisma.sql`d.day`)}
    ),`
    : Prisma.empty;
  return Prisma.sql`marks AS MATERIALIZED (
      SELECT DISTINCT m.quarter FROM ledger_sum_marks m
       WHERE m.quarter >= ${lo} AND m.quarter < ${b.hi}
    ),
    ${ldays}
    ledger AS (
      ${summed}
      UNION ALL
      ${rawSumsSelect(Prisma.sql`${where} AND u.created_at >= ${b.hi}`)}
      UNION ALL
      ${rawSumsSelect(Prisma.sql`${where} AND u.created_at < ${lo}`)}
      UNION ALL
      SELECT r.* FROM marks CROSS JOIN LATERAL (
        ${rawSumsSelect(Prisma.sql`${where}
          AND u.created_at >= marks.quarter AND u.created_at < marks.quarter + interval '15 minutes'`)}
        OFFSET 0
      ) r
    )`;
}

// The day rows of the clean days (`ldays`) in [lo, hi), in the shape of a sums row.
function daySumsSql(f: DashboardFilter, lo: Date, hi: Date): Prisma.Sql {
  return Prisma.sql`
      SELECT s.day AS quarter, ${DAY_COLUMNS} FROM ledger_day_sums s
       WHERE s.day >= ${lo} AND s.day < ${hi}
         AND EXISTS (SELECT 1 FROM ldays WHERE ldays.day = s.day)
         AND ${sumsFilterSql("s", f)}`;
}

// THE VIEW'S CALL LATENCY, AS HISTOGRAM ROWS (`model`, `bucket`, `calls`) under the CTE name
// `latency`. The UTC days wholly inside the summed stretch and with no marked quarter come from
// `ledger_latency_days`, every other timed row of the window is bucketed on the spot.
export function latencyCtesSql(
  f: DashboardFilter,
  b: SumsBounds | null,
): Prisma.Sql {
  const where = Prisma.sql`${usageWhereSql("u", f)} AND u.duration_ms IS NOT NULL`;
  const raw = (extra: Prisma.Sql) => Prisma.sql`
      SELECT u.model, ledger_latency_bucket(u.duration_ms) AS bucket, COUNT(*)::int AS calls,
             MIN(u.duration_ms)::int AS min_ms, MAX(u.duration_ms)::int AS max_ms
        FROM llm_usage u
       WHERE ${where} ${extra}
       GROUP BY 1, 2`;
  const dayLo = b
    ? b.lo === null
      ? 0
      : Math.ceil(b.lo.getTime() / DAY_MS) * DAY_MS
    : 0;
  const dayHi = b ? floorDay(b.hi.getTime()) : 0;
  if (!b || dayHi <= dayLo) {
    return Prisma.sql`latency AS (${raw(Prisma.empty)})`;
  }
  const lo = new Date(dayLo);
  const hi = new Date(dayHi);
  return Prisma.sql`days AS MATERIALIZED (
      SELECT d.day FROM generate_series(${lo}::timestamp, ${hi}::timestamp - interval '1 day', interval '1 day') AS d(day)
       WHERE NOT EXISTS (SELECT 1 FROM ledger_sum_marks m
                          WHERE m.quarter >= d.day AND m.quarter < d.day + interval '1 day')
    ),
    latency AS (
      SELECT l.model, l.bucket, SUM(l.calls)::int AS calls, MIN(l.min_ms)::int AS min_ms, MAX(l.max_ms)::int AS max_ms
        FROM ledger_latency_days l
       WHERE l.day >= ${lo} AND l.day < ${hi}
         AND EXISTS (SELECT 1 FROM days WHERE days.day = l.day)
         AND ${sumsFilterSql("l", f)}
       GROUP BY 1, 2
      UNION ALL
      ${raw(Prisma.sql`AND u.created_at < ${lo}`)}
      UNION ALL
      ${raw(Prisma.sql`AND u.created_at >= ${hi}`)}
      UNION ALL
      SELECT r.* FROM generate_series(${lo}::timestamp, ${hi}::timestamp - interval '1 day', interval '1 day') AS g(day)
       CROSS JOIN LATERAL (${raw(Prisma.sql`AND u.created_at >= g.day AND u.created_at < g.day + interval '1 day'`)} OFFSET 0) r
       WHERE NOT EXISTS (SELECT 1 FROM days WHERE days.day = g.day)
    )`;
}

// The duration a bucket stands for: the geometric middle of its 5%-wide span, so a percentile read
// from the histogram is within 2.5% of every duration in the bucket.
export function bucketMs(bucket: number): number {
  return bucket === ZERO_BUCKET ? 0 : 1.05 ** (bucket - 0.5);
}

// The bucket of a duration of zero, which no 5%-wide bucket holds (`ledger_latency_bucket` writes it
// as a literal).
export const ZERO_BUCKET = -100_000;

export type HistogramBucket = {
  bucket: number;
  calls: number;
  min: number;
  max: number;
};

// The duration a bucket's values stand for: its geometric middle, pulled inside the smallest and
// largest value the bucket holds. That point is no farther from any of them than the middle is, and
// it is the value itself when the bucket holds one.
function bucketValue(b: HistogramBucket): number {
  return Math.min(Math.max(bucketMs(b.bucket), b.min), b.max);
}

// The `p` percentile (0 to 1) of a histogram, the way `percentile_cont` reads it from the values: at
// position p * (n - 1) of the sorted values, between the two values around it. Each value stands for
// its bucket's duration (`bucketValue`), within 2.5% of the real one, and so does a point between two.
export function histogramPercentile(
  buckets: HistogramBucket[],
  p: number,
): number | null {
  const sorted = [...buckets]
    .filter((b) => b.calls > 0)
    .sort((a, b) => a.bucket - b.bucket);
  const total = sorted.reduce((n, b) => n + b.calls, 0);
  if (total === 0) return null;
  const at = (rank: number): number => {
    let seen = 0;
    for (const b of sorted) {
      seen += b.calls;
      if (rank < seen) return bucketValue(b);
    }
    const last = sorted[sorted.length - 1];
    return last ? bucketValue(last) : 0;
  };
  const pos = p * (total - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return at(lo) + (pos - lo) * (at(hi) - at(lo));
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Writes the sums of the quarters in [from, to) from their rows, replacing what was there.
async function sumQuarters(db: ScopedDb, from: Date, to: Date): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    DELETE FROM ledger_quarter_sums WHERE quarter >= ${from} AND quarter < ${to}`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO ledger_quarter_sums (tenant_id, ${SUM_COLUMNS})
    SELECT current_setting('app.tenant_id')::bigint, ${SUM_COLUMNS}
      FROM (${rawSumsSelect(Prisma.sql`u.created_at >= ${from} AND u.created_at < ${to}`)}) r`);
}

// Writes the day sums of the UTC days in [from, to) from their quarter sums, which the caller has
// brought up to date for those days (a marked quarter left for a later step keeps its day off the
// reads until that step rewrites the day).
async function sumLedgerDays(
  db: ScopedDb,
  from: Date,
  to: Date,
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    DELETE FROM ledger_day_sums WHERE day >= ${from} AND day < ${to}`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO ledger_day_sums (tenant_id, day, ${DAY_COLUMNS})
    SELECT current_setting('app.tenant_id')::bigint, date_trunc('day', q.quarter), ${DAY_GROUP_COLUMNS},
           SUM(q.cost_usd), SUM(q.requests)::int, SUM(q.unpriced)::int, SUM(q.prompt_tokens)::bigint,
           SUM(q.completion_tokens)::bigint, SUM(q.cached_read_tokens)::bigint,
           SUM(q.cache_creation_tokens)::bigint
      FROM ledger_quarter_sums q
     WHERE q.quarter >= ${from} AND q.quarter < ${to}
     GROUP BY 2, 3, 4, 5, 6, 7, 8`);
}

// Writes the latency histogram of the UTC days in [from, to) from their rows.
async function sumLatencyDays(
  db: ScopedDb,
  from: Date,
  to: Date,
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    DELETE FROM ledger_latency_days WHERE day >= ${from} AND day < ${to}`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO ledger_latency_days (tenant_id, day, source, anonymous, agent_id, inbox_id, model, bucket, calls, min_ms, max_ms)
    SELECT current_setting('app.tenant_id')::bigint, date_trunc('day', u.created_at), u.source, u.anonymous,
           u.agent_id, u.inbox_id, u.model, ledger_latency_bucket(u.duration_ms), COUNT(*)::int,
           MIN(u.duration_ms), MAX(u.duration_ms)
      FROM llm_usage u
     WHERE u.created_at >= ${from} AND u.created_at < ${to} AND u.duration_ms IS NOT NULL
     GROUP BY 2, 3, 4, 5, 6, 7, 8`);
}

function floorQuarter(at: number): number {
  return Math.floor(at / QUARTER_MS) * QUARTER_MS;
}

function ceilQuarter(at: number): number {
  return Math.ceil(at / QUARTER_MS) * QUARTER_MS;
}

function floorDay(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

// The spans [from, to) that cover a set of quarters or days, adjacent ones merged: a repricing marks
// every quarter of its range, which is then summed in a statement or two, not one per quarter.
export function spansOf(
  starts: Iterable<number>,
  width: number,
): [Date, Date][] {
  const spans: [number, number][] = [];
  for (const at of [...starts].sort((a, b) => a - b)) {
    const last = spans[spans.length - 1];
    if (last && last[1] === at) last[1] = at + width;
    else spans.push([at, at + width]);
  }
  return spans.map(([from, to]) => [new Date(from), new Date(to)]);
}

export interface LedgerSumsStep {
  // Where the sums stand after the step, null while nothing is summed.
  summedUntil: Date | null;
  // Quarters recomputed for their marks.
  remarked: number;
  // Whether the sums reached the latest safe mark, so the next step has nothing to catch up.
  caughtUp: boolean;
  // Whether the step waited on a candidate an older transaction still holds: another step now
  // would wait the same.
  waiting: boolean;
}

// ONE STEP OF A TENANT'S SUMS, in one transaction: recompute the marked quarters below the mark, move
// the mark up (by a slice at most, so a tenant's earlier ledger is summed a day per transaction), and
// take the next candidate. The candidate is the instant the step began and the step's own transaction
// id, assigned after it. A later step moves the mark only once the oldest running transaction is past
// that id, so every transaction that had an id at the instant has ended: a row it wrote is committed
// and summed. A transaction that had no id yet takes a larger one, so its rows were written by
// statements that ran after the instant, and the trigger marks those older than the grace. So no row
// below `candidate_at - GRACE` can be missed by the sums.
export async function stepLedgerSums(
  base: PrismaClient,
  tenantId: bigint,
): Promise<LedgerSumsStep> {
  return runScopedOn(
    base,
    sysCtx(tenantId),
    async (db) => {
      const [now] = await db.$queryRaw<{ at: Date }[]>(
        Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at`,
      );
      // The oldest transaction still running, and this step's own id, assigned after the instant above:
      // every transaction that had an id before it has an id below it, and one that had none yet gets
      // a larger one, so its statements run after the instant.
      const [snap] = await db.$queryRaw<{ xmin: string; xid: string }[]>(
        Prisma.sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin,
                        pg_current_xact_id()::text AS xid`,
      );
      const takenAt = now?.at ?? new Date();
      await db.$executeRaw(Prisma.sql`
      INSERT INTO ledger_sums_state (tenant_id) VALUES (current_setting('app.tenant_id')::bigint)
      ON CONFLICT (tenant_id) DO NOTHING`);
      const [state] = await db.$queryRaw<
        {
          summed_until: Date | null;
          candidate_at: Date | null;
          pending: boolean;
          waited_out: boolean;
        }[]
      >(Prisma.sql`
      SELECT summed_until, candidate_at, candidate_xid IS NOT NULL AS pending,
             candidate_xid IS NOT NULL AND ${snap?.xmin ?? "0"}::xid8 > candidate_xid AS waited_out
        FROM ledger_sums_state FOR UPDATE`);
      let summedUntil = state?.summed_until ?? null;

      // The marks first, against the mark as it stands: a marked quarter at or above it is summed
      // from its rows when the mark gets there. The marked quarters of the earliest marked day below
      // it are summed again, so a step rebuilds one day's histogram at most and a repricing's quarters
      // come in runs a statement each sums. Only the marks read
      // here are deleted: one committed later may be for a row the sums below did not see.
      // Before the first sums every mark is dropped: the rows answer for everything.
      const marks = await db.$queryRaw<{ id: bigint; quarter: Date }[]>(
        summedUntil
          ? Prisma.sql`SELECT m.id, m.quarter FROM ledger_sum_marks m
              WHERE m.quarter >= ${summedUntil} OR m.quarter IN (
                SELECT DISTINCT quarter FROM ledger_sum_marks
                 WHERE quarter < ${summedUntil}
                   AND quarter < (SELECT date_trunc('day', min(quarter)) + interval '1 day'
                                    FROM ledger_sum_marks WHERE quarter < ${summedUntil})
                 ORDER BY quarter LIMIT ${MARKED_QUARTERS_PER_STEP})
              ORDER BY m.id LIMIT ${MARKS_PER_READ}`
          : Prisma.sql`SELECT id, quarter FROM ledger_sum_marks ORDER BY id LIMIT ${MARKS_PER_READ}`,
      );
      const settledMarks = marks.map((m) => m.id);
      const remark = new Set(
        marks
          .map((m) => m.quarter.getTime())
          .filter((q) => summedUntil && q < summedUntil.getTime()),
      );
      for (const [from, to] of spansOf(remark, QUARTER_MS)) {
        await sumQuarters(db, from, to);
        await addRuns(db, from, to);
      }
      const remarkDays = new Set<number>();
      for (const q of remark) {
        const day = floorDay(q);
        if (summedUntil && day + DAY_MS <= summedUntil.getTime())
          remarkDays.add(day);
      }
      for (const [from, to] of spansOf(remarkDays, DAY_MS)) {
        await sumLatencyDays(db, from, to);
        await sumLedgerDays(db, from, to);
      }
      if (settledMarks.length > 0) {
        await db.$executeRaw(Prisma.sql`
        DELETE FROM ledger_sum_marks WHERE id = ANY(${settledMarks}::bigint[])`);
      }
      const settle = summedUntil
        ? await settleConversationMarks(db, summedUntil)
        : { settled: 0, more: false };
      const [left] = await db.$queryRaw<{ any: boolean }[]>(
        Prisma.sql`SELECT EXISTS (SELECT 1 FROM ledger_sum_marks) AS any`,
      );
      const marksLeft = Boolean(left?.any) || settle.more;

      // Then the mark.
      let caughtUp = false;
      if (state?.waited_out && state.candidate_at) {
        const target = floorQuarter(state.candidate_at.getTime() - GRACE_MS);
        let from = summedUntil?.getTime() ?? null;
        if (from === null) {
          const [first] = await db.$queryRaw<{ at: Date | null }[]>(
            Prisma.sql`SELECT LEAST((SELECT MIN(created_at) FROM llm_usage),
                                  (SELECT MIN(created_at) FROM conversations)) AS at`,
          );
          // NOTE: never past the safe target, which a first row stamped ahead of it would put it.
          from = first?.at
            ? Math.min(floorDay(first.at.getTime()), target)
            : target;
        }
        const to = Math.min(target, from + SLICE_MS);
        if (to > from) {
          const mark = new Date(to);
          await sumQuarters(db, new Date(from), mark);
          await addRuns(db, new Date(from), mark);
          await countConversations(db, new Date(from), mark, mark);
          // The UTC days the step completed: wholly below `to`, and not wholly below `from`.
          const firstDay = floorDay(from);
          const lastDay = floorDay(to);
          if (lastDay > firstDay) {
            await sumLatencyDays(db, new Date(firstDay), new Date(lastDay));
            await sumLedgerDays(db, new Date(firstDay), new Date(lastDay));
            await countConversationDays(
              db,
              new Date(firstDay),
              new Date(lastDay),
              mark,
            );
          }
          summedUntil = mark;
        } else if (summedUntil === null) {
          summedUntil = new Date(from);
        }
        caughtUp = to >= target && !marksLeft;
      }

      // NOTE: a candidate still waiting is kept. Replaced on every step, it would never be waited out
      // while transactions overlap without end, each older than the newest candidate.
      if (state?.pending && !state.waited_out) {
        await db.$executeRaw(Prisma.sql`
          UPDATE ledger_sums_state SET summed_until = ${summedUntil}`);
      } else {
        await db.$executeRaw(Prisma.sql`
          UPDATE ledger_sums_state
             SET summed_until = ${summedUntil}, candidate_at = ${takenAt},
                 candidate_xid = ${snap?.xid ?? null}::xid8`);
      }
      return {
        summedUntil,
        remarked: remark.size + settle.settled,
        caughtUp,
        waiting: Boolean(state?.pending && !state.waited_out),
      };
    },
    STEP_TX,
  );
}

export async function ledgerSumsHandler(
  job: ClaimedJob,
  base: PrismaClient,
  ctx?: JobContext,
): Promise<JobResult> {
  const stopAt = Date.now() + RUN_BUDGET_MS;
  let rest = false;
  while (Date.now() < stopAt && !ctx?.signal.aborted) {
    const step = await stepLedgerSums(base, job.tenantId);
    rest = step.caughtUp || step.waiting || step.summedUntil === null;
    if (rest) break;
  }
  // NOTE: a run that spent its budget with work left (a tenant being summed, a repricing being
  // settled) runs again at once: until it is done, the figures it has not reached are read from rows.
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + (rest ? RERUN_MS : 0)),
  };
}

let registered = false;
export function registerLedgerSumsHandler(): void {
  if (registered) return;
  registerJobHandler("LEDGER_SUMS", ledgerSumsHandler);
  registered = true;
}

// The job of one tenant, armed once: it reschedules itself for as long as the tenant exists, and the
// dedupe key keeps one job per tenant, which the scheduler never runs twice at once.
export async function ensureLedgerSums(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "LEDGER_SUMS",
    dedupeKey: DEDUPE_KEY,
    rearm: "same-work",
    runAt: new Date(),
    base,
  });
}

// Arms a new tenant's job, best-effort: until it runs, or until the next boot arms it, the tenant's
// figures are read from its rows.
export function armLedgerSums(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): void {
  void ensureLedgerSums(tenantId, base).catch((err) =>
    logger.warn(
      { tenantId: String(tenantId), err },
      "ledger sums arm failed for a new tenant",
    ),
  );
}

// Arms every tenant's job (called once at boot).
export async function ensureAllLedgerSums(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenants = await asSuperAdminOn(base, (db) =>
    db.tenant.findMany({ select: { id: true } }),
  );
  for (const t of tenants) {
    try {
      await ensureLedgerSums(t.id, base);
    } catch (err) {
      logger.warn(
        { tenantId: String(t.id), err },
        "ledger sums arm failed for tenant; continuing",
      );
    }
  }
}
