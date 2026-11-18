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
// The marked quarters one step sums again: a day's worth, so a repricing of a month is settled over
// steps that each fit the transaction, and every mark left waits, read from its rows meanwhile.
export const MARKED_QUARTERS_PER_STEP = 96;
const MARKS_PER_READ = 5000;
const RERUN_MS = 60_000;
const DEDUPE_KEY = "ledger-sums";

// The columns a sums row carries, in the order every source below yields them.
const SUM_COLUMNS = Prisma.raw(
  "quarter, source, anonymous, agent_id, inbox_id, model, node, cost_usd, requests, unpriced, prompt_tokens, completion_tokens, cached_read_tokens, cache_creation_tokens",
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
// cost. Without bounds every row of the window is read.
export function ledgerCtesSql(
  f: DashboardFilter,
  b: SumsBounds | null,
): Prisma.Sql {
  const where = usageWhereSql("u", f);
  if (!b) {
    return Prisma.sql`marks AS (SELECT NULL::timestamp AS quarter WHERE false),
      ledger AS (${rawSumsSelect(where)})`;
  }
  const lo = b.lo ?? new Date(0);
  return Prisma.sql`marks AS MATERIALIZED (
      SELECT DISTINCT m.quarter FROM ledger_sum_marks m
       WHERE m.quarter >= ${lo} AND m.quarter < ${b.hi}
    ),
    ledger AS (
      SELECT ${SUM_COLUMNS} FROM ledger_quarter_sums s
       WHERE s.quarter >= ${lo} AND s.quarter < ${b.hi}
         AND NOT EXISTS (SELECT 1 FROM marks WHERE marks.quarter = s.quarter)
         AND ${sumsFilterSql("s", f)}
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

// The bucket of a duration of zero, which no 5%-wide bucket holds.
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

export interface LedgerSumsStep {
  // Where the sums stand after the step, null while nothing is summed.
  summedUntil: Date | null;
  // Quarters recomputed for their marks.
  remarked: number;
  // Whether the sums reached the latest safe mark, so the next step has nothing to catch up.
  caughtUp: boolean;
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
      // from its rows when the mark gets there.
      const marks = await db.$queryRaw<{ id: bigint; quarter: Date }[]>(
        Prisma.sql`SELECT id, quarter FROM ledger_sum_marks ORDER BY id LIMIT ${MARKS_PER_READ}`,
      );
      const remark = new Set<number>();
      const settledMarks: bigint[] = [];
      for (const m of marks) {
        const q = m.quarter.getTime();
        // NOTE: a quarter at or above the mark is summed when the mark gets there.
        if (!summedUntil || q >= summedUntil.getTime()) {
          settledMarks.push(m.id);
        } else if (remark.has(q) || remark.size < MARKED_QUARTERS_PER_STEP) {
          remark.add(q);
          settledMarks.push(m.id);
        }
      }
      const remarkDays = new Set<number>();
      for (const q of remark) {
        await sumQuarters(db, new Date(q), new Date(q + QUARTER_MS));
        await addRuns(db, new Date(q), new Date(q + QUARTER_MS));
        const day = floorDay(q);
        if (summedUntil && day + DAY_MS <= summedUntil.getTime())
          remarkDays.add(day);
      }
      for (const d of remarkDays)
        await sumLatencyDays(db, new Date(d), new Date(d + DAY_MS));
      if (settledMarks.length > 0) {
        await db.$executeRaw(Prisma.sql`
        DELETE FROM ledger_sum_marks WHERE id = ANY(${settledMarks}::bigint[])`);
      }
      const settle = summedUntil
        ? await settleConversationMarks(db, summedUntil)
        : { settled: 0, more: false };
      const marksLeft =
        settledMarks.length < marks.length ||
        marks.length === MARKS_PER_READ ||
        settle.more;

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
          from = first?.at ? floorDay(first.at.getTime()) : target;
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
  while (Date.now() < stopAt && !ctx?.signal.aborted) {
    const step = await stepLedgerSums(base, job.tenantId);
    if (step.caughtUp || step.summedUntil === null) break;
  }
  return { outcome: "reschedule", runAt: new Date(Date.now() + RERUN_MS) };
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
