import { Prisma } from "@/../generated/prisma/client";
import type { ScopedDb } from "@/lib/tenancy";
import {
  agentRanSql,
  agentTurnSql,
  cohortWhereSql,
  type DashboardFilter,
  outcomeSql,
} from "./filter";
import type { Grain } from "./grain";
import {
  MARKED_QUARTERS_PER_STEP,
  type SumsBounds,
  spansOf,
  sumsBounds,
  ZERO_BUCKET,
} from "./ledger-sums";
import { FIRST_RESPONSE_SAMPLE_SQL } from "./service";

// THE CONVERSATION COUNTS (docs/dashboard.md, "Conversation sums"): conversations per
// UTC quarter hour of creation, inbox, outcome and the agents that ran on them, the same per label,
// and the first response time per UTC day as a histogram, written by the LEDGER_SUMS job
// (./ledger-sums.ts) below the same mark as the ledger's sums. The job also keeps
// `conversation_agent_runs`, which `agentRanSql` reads once a route has the mark (`withRunsMark`).
// The marking triggers are in prisma/migrations/20261118120100_conversation_sums.

const QUARTER_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// How far behind now the mark may be for the counts and the runs to be read: past it, the ledger
// above the mark is too large to read as one set.
const RUNS_MAX_LAG_MS = 60 * 60 * 1000;
const CONVERSATION_MARKS_MAX = 5000;
// The UTC days one step counts again for its conversation marks.
const MARKED_DAYS_PER_STEP = 7;

// The view with the tenant's sums mark, so `agentRanSql` and `cohortWhereSql` read the runs. A
// tenant still being summed, or settling more marks than a step takes, gets no mark: its
// conversation figures are read from the rows, the same read as before any sums.
export async function withRunsMark(
  db: ScopedDb,
  f: DashboardFilter,
): Promise<DashboardFilter> {
  const [row] = await db.$queryRaw<
    { until: Date | null; lag: number; marked: number; cmarked: number }[]
  >(Prisma.sql`
    SELECT max(summed_until) AS until,
           COALESCE(EXTRACT(EPOCH FROM (now() AT TIME ZONE 'UTC') - max(summed_until)) * 1000, 0)::float8 AS lag,
           (SELECT count(DISTINCT quarter) FROM ledger_sum_marks)::int AS marked,
           (SELECT count(*) FROM (SELECT 1 FROM conversation_sum_marks LIMIT ${CONVERSATION_MARKS_MAX + 1}) m)::int AS cmarked
      FROM ledger_sums_state`);
  if (!row?.until) return f;
  if (
    row.lag > RUNS_MAX_LAG_MS ||
    row.marked > MARKED_QUARTERS_PER_STEP ||
    row.cmarked > CONVERSATION_MARKS_MAX
  )
    return f;
  return { ...f, runsMark: row.until };
}

// An agent turn of real traffic on a conversation, as the ledger row `ar`.
const RUN_ROW = Prisma.sql`ar.conversation_id IS NOT NULL AND ar.source = 'inbox' AND ${agentTurnSql("ar")}`;

// Whether the view's ledger rows are real traffic, the only traffic with conversations: a divisor by
// the funnel's conversations has a meaning only there. A playground or client-channel view has none.
export function dividesByConversations(f: DashboardFilter): boolean {
  return (f.source === undefined || f.source === "inbox") && !f.audience;
}

// THE JOB'S SIDE.

// Adds the runs of the ledger rows written in [from, to).
export async function addRuns(
  db: ScopedDb,
  from: Date,
  to: Date,
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO conversation_agent_runs (tenant_id, conversation_id, agent_id)
    SELECT DISTINCT current_setting('app.tenant_id')::bigint, ar.conversation_id, COALESCE(ar.agent_id, 0)
      FROM llm_usage ar
      JOIN conversations c ON c.id = ar.conversation_id
     WHERE ar.created_at >= ${from} AND ar.created_at < ${to} AND ${RUN_ROW}
    ON CONFLICT (tenant_id, conversation_id, agent_id) DO NOTHING`);
}

// Recomputes the runs of the conversations named, from all their ledger rows.
async function recomputeRuns(db: ScopedDb, ids: bigint[]): Promise<void> {
  if (ids.length === 0) return;
  await db.$executeRaw(Prisma.sql`
    DELETE FROM conversation_agent_runs WHERE conversation_id = ANY(${ids}::bigint[])`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO conversation_agent_runs (tenant_id, conversation_id, agent_id)
    SELECT DISTINCT current_setting('app.tenant_id')::bigint, ar.conversation_id, COALESCE(ar.agent_id, 0)
      FROM llm_usage ar
      JOIN conversations c ON c.id = ar.conversation_id
     WHERE ar.conversation_id = ANY(${ids}::bigint[]) AND ${RUN_ROW}
    ON CONFLICT (tenant_id, conversation_id, agent_id) DO NOTHING`);
}

// The agents that ran on `c` at the moment of counting: its runs, and its agent turns the runs do
// not hold yet, at or above the mark or in a marked ledger quarter (a turn stamped back in time on a
// conversation too young for a mark of its own). 0 is a legacy turn with no agent.
function countedAgentsSql(mark: Date): Prisma.Sql {
  return Prisma.sql`ARRAY(
    SELECT DISTINCT a FROM (
      SELECT r.agent_id AS a FROM conversation_agent_runs r WHERE r.conversation_id = c.id
      UNION ALL
      SELECT COALESCE(ar.agent_id, 0) FROM llm_usage ar
       WHERE ar.conversation_id = c.id AND ${RUN_ROW}
         AND (ar.created_at >= ${mark}
              OR EXISTS (SELECT 1 FROM ledger_sum_marks lm WHERE lm.quarter = ledger_quarter(ar.created_at)))
    ) x ORDER BY a)`;
}

// The bucket of a duration in seconds: 5%-wide buckets, below one second too (a mirrored reply can
// land within the second), and zero in a bucket of its own.
function secondsBucketSql(seconds: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(CASE WHEN ${seconds} <= 0 THEN ${ZERO_BUCKET}::int ELSE 1 + floor(ln(${seconds}) / ln(1.05::float8))::int END)`;
}

const FIRST_RESPONSE_SECONDS = Prisma.sql`EXTRACT(EPOCH FROM (c.chatwoot_first_reply_at - c.chatwoot_created_at))::float8`;

// Writes the counts, and the counts per label, of the quarters of the conversations created in
// [from, to), from their rows. `mark` is where the runs stop.
export async function countConversations(
  db: ScopedDb,
  from: Date,
  to: Date,
  mark: Date,
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    DELETE FROM conversation_quarter_sums WHERE quarter >= ${from} AND quarter < ${to}`);
  await db.$executeRaw(Prisma.sql`
    DELETE FROM conversation_label_quarter_sums WHERE quarter >= ${from} AND quarter < ${to}`);
  await db.$executeRaw(Prisma.sql`
    WITH v AS MATERIALIZED (
      SELECT ledger_quarter(c.created_at) AS quarter, c.inbox_id, ${outcomeSql("c")} AS outcome,
             c.labels, ${countedAgentsSql(mark)} AS agents
        FROM conversations c
       WHERE c.created_at >= ${from} AND c.created_at < ${to} AND NOT c.sweep_only
    ), counted AS (
      INSERT INTO conversation_quarter_sums (tenant_id, quarter, inbox_id, outcome, ran_any, ran_agents, labeled, conversations)
      SELECT current_setting('app.tenant_id')::bigint, quarter, inbox_id, outcome, cardinality(agents) > 0,
             agents, cardinality(labels) > 0, COUNT(*)::int
        FROM v GROUP BY 2, 3, 4, 5, 6, 7
      RETURNING 1
    )
    INSERT INTO conversation_label_quarter_sums (tenant_id, quarter, inbox_id, outcome, ran_any, ran_agents, label, conversations)
    SELECT current_setting('app.tenant_id')::bigint, v.quarter, v.inbox_id, v.outcome, cardinality(v.agents) > 0,
           v.agents, lb.label, COUNT(*)::int
      FROM v CROSS JOIN LATERAL (SELECT DISTINCT l FROM unnest(v.labels) AS l) AS lb(label)
     WHERE (SELECT COUNT(*) FROM counted) >= 0
     GROUP BY 2, 3, 4, 5, 6, 7`);
}

// Writes the UTC days in [from, to): the counts and the counts per label added up from their
// quarters (written first), and the first response histogram from the rows.
export async function countConversationDays(
  db: ScopedDb,
  from: Date,
  to: Date,
  mark: Date,
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    DELETE FROM conversation_day_sums WHERE day >= ${from} AND day < ${to}`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO conversation_day_sums (tenant_id, day, inbox_id, outcome, ran_any, ran_agents, labeled, conversations)
    SELECT current_setting('app.tenant_id')::bigint, date_trunc('day', s.quarter), s.inbox_id, s.outcome,
           s.ran_any, s.ran_agents, s.labeled, SUM(s.conversations)::int
      FROM conversation_quarter_sums s
     WHERE s.quarter >= ${from} AND s.quarter < ${to}
     GROUP BY 2, 3, 4, 5, 6, 7`);
  await db.$executeRaw(Prisma.sql`
    DELETE FROM conversation_label_day_sums WHERE day >= ${from} AND day < ${to}`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO conversation_label_day_sums (tenant_id, day, inbox_id, outcome, ran_any, ran_agents, label, conversations)
    SELECT current_setting('app.tenant_id')::bigint, date_trunc('day', s.quarter), s.inbox_id, s.outcome,
           s.ran_any, s.ran_agents, s.label, SUM(s.conversations)::int
      FROM conversation_label_quarter_sums s
     WHERE s.quarter >= ${from} AND s.quarter < ${to}
     GROUP BY 2, 3, 4, 5, 6, 7`);
  await db.$executeRaw(Prisma.sql`
    DELETE FROM conversation_first_response_days WHERE day >= ${from} AND day < ${to}`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO conversation_first_response_days (tenant_id, day, inbox_id, ran_any, ran_agents, bucket, conversations, min_seconds, max_seconds)
    SELECT current_setting('app.tenant_id')::bigint, day, inbox_id, cardinality(agents) > 0,
           agents, bucket, COUNT(*)::int, MIN(seconds), MAX(seconds)
      FROM (
        SELECT date_trunc('day', c.created_at) AS day, c.inbox_id, ${countedAgentsSql(mark)} AS agents,
               ${FIRST_RESPONSE_SECONDS} AS seconds, ${secondsBucketSql(FIRST_RESPONSE_SECONDS)} AS bucket
          FROM conversations c
         WHERE c.created_at >= ${from} AND c.created_at < ${to} AND NOT c.sweep_only
           AND ${FIRST_RESPONSE_SAMPLE_SQL}
      ) v
     GROUP BY 2, 3, 4, 5, 6`);
}

function floorDay(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

// The conversation marks below the mark: runs recomputed for the conversations named, and the
// creation quarters of those and of the quarters named recounted (with their UTC day
// when the day is complete). Returns how many marks it took.
const MARKS_PER_READ = 5000;

export async function settleConversationMarks(
  db: ScopedDb,
  mark: Date,
): Promise<{ settled: number; more: boolean }> {
  const marks = await db.$queryRaw<
    { id: bigint; quarter: Date | null; conversation_id: bigint | null }[]
  >(
    Prisma.sql`SELECT id, quarter, conversation_id FROM conversation_sum_marks ORDER BY id LIMIT ${MARKS_PER_READ}`,
  );
  if (marks.length === 0) return { settled: 0, more: false };
  const allIds = [
    ...new Set(
      marks
        .map((m) => m.conversation_id)
        .filter((x): x is bigint => x !== null),
    ),
  ];
  const quarterOf = new Map<bigint, number>();
  if (allIds.length > 0) {
    for (const r of await db.$queryRaw<
      { id: bigint; quarter: Date }[]
    >(Prisma.sql`
      SELECT id, ledger_quarter(created_at) AS quarter FROM conversations
       WHERE id = ANY(${allIds}::bigint[])`))
      quarterOf.set(r.id, r.quarter.getTime());
  }
  // The marks in order, up to a day's worth of quarters below the mark and a week of days to count
  // again; the rest wait for the next step, read from the rows meanwhile.
  const quarters = new Set<number>();
  const touched = new Set<number>();
  const taken: typeof marks = [];
  for (const m of marks) {
    const q = m.quarter
      ? m.quarter.getTime()
      : m.conversation_id !== null
        ? quarterOf.get(m.conversation_id)
        : undefined;
    const below = q !== undefined && q < mark.getTime();
    if (below && !quarters.has(q) && quarters.size >= MARKED_QUARTERS_PER_STEP)
      break;
    if (
      below &&
      !touched.has(floorDay(q)) &&
      touched.size >= MARKED_DAYS_PER_STEP
    )
      break;
    if (below) {
      quarters.add(q);
      touched.add(floorDay(q));
    }
    taken.push(m);
  }
  const ids = [
    ...new Set(
      taken
        .map((m) => m.conversation_id)
        .filter((x): x is bigint => x !== null),
    ),
  ];
  await recomputeRuns(db, ids);
  const below = [...quarters].filter((q) => q < mark.getTime());
  for (const [from, to] of spansOf(below, QUARTER_MS))
    await countConversations(db, from, to, mark);
  const days = new Set(
    below.map(floorDay).filter((d) => d + DAY_MS <= mark.getTime()),
  );
  for (const [from, to] of spansOf(days, DAY_MS))
    await countConversationDays(db, from, to, mark);
  await db.$executeRaw(Prisma.sql`
    DELETE FROM conversation_sum_marks WHERE id = ANY(${taken.map((m) => m.id)}::bigint[])`);
  return {
    settled: taken.length,
    more: taken.length < marks.length || marks.length === MARKS_PER_READ,
  };
}

// THE READERS' SIDE.

// The creation quarters in [lo, hi) the counts cannot answer for: marked ones, and those of
// conversations whose runs are being recomputed.
function markedQuartersSql(b: SumsBounds): Prisma.Sql {
  const lo = b.lo ?? new Date(0);
  return Prisma.sql`cmarks AS MATERIALIZED (
      SELECT m.quarter FROM conversation_sum_marks m
       WHERE m.quarter >= ${lo} AND m.quarter < ${b.hi}
      UNION
      SELECT ledger_quarter(c.created_at) FROM conversation_sum_marks m
        JOIN conversations c ON c.id = m.conversation_id
       WHERE c.created_at >= ${lo} AND c.created_at < ${b.hi}
    )`;
}

// The agents that ran on `c` now, for a conversation read from its row: its runs unless they are
// being recomputed, and the ledger rows the runs do not cover. 0 is a legacy turn with no agent.
function readAgentsSql(mark: Date): Prisma.Sql {
  return Prisma.sql`ARRAY(
    SELECT DISTINCT a FROM (
      SELECT r.agent_id AS a FROM conversation_agent_runs r
       WHERE r.conversation_id = c.id
         AND NOT EXISTS (SELECT 1 FROM conversation_sum_marks rm WHERE rm.conversation_id = c.id)
      UNION ALL
      SELECT COALESCE(ar.agent_id, 0) FROM llm_usage ar
       WHERE ar.conversation_id = c.id AND ${RUN_ROW}
         AND (ar.created_at >= ${mark}
              OR EXISTS (SELECT 1 FROM conversation_sum_marks rm WHERE rm.conversation_id = c.id)
              OR EXISTS (SELECT 1 FROM ledger_sum_marks lm WHERE lm.quarter = ledger_quarter(ar.created_at)))
    ) x ORDER BY a)`;
}

// A conversation read from its row, in the shape of a counts row (one conversation). The agents that
// ran on it are read only for the agent split, the one figure that needs them.
function rawConvSelect(
  f: DashboardFilter,
  where: Prisma.Sql,
  withAgents: boolean,
): Prisma.Sql {
  const agents = !withAgents
    ? Prisma.sql`'{}'::bigint[]`
    : f.runsMark
      ? readAgentsSql(f.runsMark)
      : Prisma.sql`ARRAY(SELECT DISTINCT COALESCE(ar.agent_id, 0) FROM llm_usage ar
        WHERE ar.conversation_id = c.id AND ${RUN_ROW} ORDER BY 1)`;
  return Prisma.sql`
    SELECT ledger_quarter(c.created_at) AS quarter, c.inbox_id, ${outcomeSql("c")} AS outcome,
           ${agentRanSql("c", f.agentId, f.runsMark)} AS ran, ${agents} AS ran_agents,
           cardinality(c.labels) > 0 AS labeled, c.labels, 1 AS conversations
      FROM conversations c
     WHERE ${cohortWhereSql("c", f)} AND ${where}`;
}

// The view's agent and inbox filter on a counts row `s`, the inbox's agent joined as `bi`.
function countsFilterSql(f: DashboardFilter): Prisma.Sql {
  const inbox = f.inboxId ?? null;
  const agent = f.agentId ?? null;
  return Prisma.sql`(${inbox}::bigint IS NULL OR s.inbox_id = ${inbox})
    AND (${agent}::bigint IS NULL OR bi.agent_id = ${agent} OR ${agent} = ANY(s.ran_agents))`;
}

function ranSql(f: DashboardFilter): Prisma.Sql {
  const agent = f.agentId ?? null;
  return Prisma.sql`(CASE WHEN ${agent}::bigint IS NULL THEN s.ran_any ELSE ${agent} = ANY(s.ran_agents) END)`;
}

// The days and quarters of the summed stretch [lo, hi) a tiered read takes from the sums: the UTC
// days wholly inside it with no marked quarter (`cdays`) from a day table, every other quarter that
// is not marked from a quarter table. `day` and `quarter` select from their table as `s`, under the
// condition given.
function cleanDaysSql(b: SumsBounds): { lo: Date; hi: Date } | null {
  const lo = b.lo ? Math.ceil(b.lo.getTime() / DAY_MS) * DAY_MS : 0;
  const hi = floorDay(b.hi.getTime());
  return hi > lo ? { lo: new Date(lo), hi: new Date(hi) } : null;
}

function tieredSumsSql(
  b: SumsBounds,
  day: (where: Prisma.Sql) => Prisma.Sql,
  quarter: (where: Prisma.Sql) => Prisma.Sql,
): Prisma.Sql {
  const lo = b.lo ?? new Date(0);
  const unmarked = Prisma.sql`NOT EXISTS (SELECT 1 FROM cmarks WHERE cmarks.quarter = s.quarter)`;
  const days = cleanDaysSql(b);
  if (!days) {
    return quarter(
      Prisma.sql`s.quarter >= ${lo} AND s.quarter < ${b.hi} AND ${unmarked}`,
    );
  }
  return Prisma.sql`${day(Prisma.sql`s.day >= ${days.lo} AND s.day < ${days.hi}
        AND EXISTS (SELECT 1 FROM cdays WHERE cdays.day = s.day)`)}
      UNION ALL
      ${quarter(Prisma.sql`s.quarter >= ${lo} AND s.quarter < ${days.lo} AND ${unmarked}`)}
      UNION ALL
      ${quarter(Prisma.sql`s.quarter >= ${days.hi} AND s.quarter < ${b.hi} AND ${unmarked}`)}
      UNION ALL
      SELECT r.* FROM generate_series(${days.lo}::timestamp, ${days.hi}::timestamp - interval '1 day', interval '1 day') AS g(day)
       CROSS JOIN LATERAL (
         ${quarter(Prisma.sql`s.quarter >= g.day AND s.quarter < g.day + interval '1 day' AND ${unmarked}`)}
         OFFSET 0
       ) r
       WHERE NOT EXISTS (SELECT 1 FROM cdays WHERE cdays.day = g.day)`;
}

// A read grouped by local week or month (./grain.ts): its key is worked out from a row's start, so a
// UTC day can stand for its quarters only when it lies wholly inside one local group. The day that
// holds a group's first instant is read from its quarters.
export interface DayGroup {
  tz: string;
  grain: Grain;
}

function insideOneGroupSql(g: DayGroup): Prisma.Sql {
  const unit = Prisma.raw(`'${g.grain === "month" ? "month" : "week"}'`);
  const local = (at: Prisma.Sql) =>
    Prisma.sql`date_trunc(${unit}, ${at} AT TIME ZONE 'UTC' AT TIME ZONE ${g.tz}::text)`;
  return Prisma.sql`${local(Prisma.sql`d.day`)} = ${local(Prisma.sql`(d.day + interval '1 day' - interval '1 microsecond')`)}`;
}

// The `cdays` of `tieredSumsSql`, after `cmarks`.
function cleanDaysCteSql(b: SumsBounds, group?: DayGroup): Prisma.Sql {
  const days = cleanDaysSql(b);
  if (!days) return Prisma.empty;
  return Prisma.sql`, cdays AS MATERIALIZED (
      SELECT d.day FROM generate_series(${days.lo}::timestamp, ${days.hi}::timestamp - interval '1 day', interval '1 day') AS d(day)
       WHERE NOT EXISTS (SELECT 1 FROM cmarks WHERE cmarks.quarter >= d.day AND cmarks.quarter < d.day + interval '1 day')
         ${group ? Prisma.sql`AND ${insideOneGroupSql(group)}` : Prisma.empty}
    )`;
}

// THE VIEW'S CONVERSATIONS, AS COUNTS ROWS: CTEs ending in `convs`, whose rows carry `quarter`,
// `inbox_id`, `outcome`, `ran` (the agent of the view, or any agent, ran on them), `ran_agents`,
// `labeled`, `labels` (null on a counts row) and `conversations`. The cohort's rules are
// `cohortWhereSql`'s, applied to the counts by inbox and by the agents that ran. Without bounds, or
// without the mark on the view, every conversation is read from its row. With `byDay`, a row's
// `quarter` may be a UTC day (`tieredSumsSql`), for a read that does not split by local day, or, given
// a week or month grouping, a UTC day wholly inside one of its groups.
export function convsCtesSql(
  f: DashboardFilter,
  b: SumsBounds | null,
  withAgents = false,
  byDay: boolean | DayGroup = false,
): Prisma.Sql {
  if (!b || !f.runsMark) {
    return Prisma.sql`convs AS MATERIALIZED (${rawConvSelect(f, Prisma.sql`true`, withAgents)})`;
  }
  const lo = b.lo ?? new Date(0);
  const counts = (table: string, time: string) => (where: Prisma.Sql) =>
    Prisma.sql`SELECT ${Prisma.raw(`s.${time}`)} AS quarter, s.inbox_id, s.outcome, ${ranSql(f)} AS ran,
             s.ran_agents, s.labeled, NULL::text[] AS labels, s.conversations
        FROM ${Prisma.raw(table)} s LEFT JOIN inboxes bi ON bi.id = s.inbox_id
       WHERE ${where} AND ${countsFilterSql(f)}`;
  const quarterCounts = counts("conversation_quarter_sums", "quarter");
  const summed = byDay
    ? tieredSumsSql(b, counts("conversation_day_sums", "day"), quarterCounts)
    : quarterCounts(
        Prisma.sql`s.quarter >= ${lo} AND s.quarter < ${b.hi}
         AND NOT EXISTS (SELECT 1 FROM cmarks WHERE cmarks.quarter = s.quarter)`,
      );
  // Materialized: a reader's FILTERs each read `ran`, and inlined, the probe behind it would run
  // once per figure.
  return Prisma.sql`${markedQuartersSql(b)}${byDay ? cleanDaysCteSql(b, byDay === true ? undefined : byDay) : Prisma.empty},
    convs AS MATERIALIZED (
      ${summed}
      UNION ALL
      ${rawConvSelect(f, Prisma.sql`c.created_at >= ${b.hi}`, withAgents)}
      UNION ALL
      ${rawConvSelect(f, Prisma.sql`c.created_at < ${lo}`, withAgents)}
      UNION ALL
      SELECT r.* FROM cmarks CROSS JOIN LATERAL (
        ${rawConvSelect(f, Prisma.sql`c.created_at >= cmarks.quarter AND c.created_at < cmarks.quarter + interval '15 minutes'`, withAgents)}
        OFFSET 0
      ) r
    )`;
}

// The same per label: CTEs ending in `labelled`, rows (`label`, `outcome`, `ran`, `conversations`),
// over `convs` by day.
export function labelCtesSql(
  f: DashboardFilter,
  b: SumsBounds | null,
): Prisma.Sql {
  const unnested = (from: string) =>
    Prisma.sql`SELECT lb.label, v.outcome, v.ran, v.conversations
      FROM ${Prisma.raw(from)} v CROSS JOIN LATERAL (SELECT DISTINCT l FROM unnest(v.labels) AS l) AS lb(label)`;
  if (!b || !f.runsMark) {
    return Prisma.sql`${convsCtesSql(f, b)}, labelled AS (${unnested("convs")})`;
  }
  const labels = (table: string) => (where: Prisma.Sql) =>
    Prisma.sql`SELECT s.label, s.outcome, ${ranSql(f)} AS ran, s.conversations
        FROM ${Prisma.raw(table)} s LEFT JOIN inboxes bi ON bi.id = s.inbox_id
       WHERE ${where} AND ${countsFilterSql(f)}`;
  return Prisma.sql`${convsCtesSql(f, b, false, true)},
    labelled AS (
      ${tieredSumsSql(b, labels("conversation_label_day_sums"), labels("conversation_label_quarter_sums"))}
      UNION ALL
      ${unnested("(SELECT * FROM convs WHERE labels IS NOT NULL)")}
    )`;
}

// THE VIEW'S FIRST RESPONSE TIMES, AS HISTOGRAM ROWS (`bucket`, `conversations`) under `responses`:
// the UTC days wholly inside the counted stretch with no marked quarter from the histogram, every
// other sampled conversation of the view bucketed from its row.
export function responsesCtesSql(
  f: DashboardFilter,
  b: SumsBounds | null,
): Prisma.Sql {
  const raw = (where: Prisma.Sql) => Prisma.sql`
      SELECT ${secondsBucketSql(FIRST_RESPONSE_SECONDS)} AS bucket, COUNT(*)::int AS conversations,
             MIN(${FIRST_RESPONSE_SECONDS}) AS min_seconds, MAX(${FIRST_RESPONSE_SECONDS}) AS max_seconds
        FROM conversations c
       WHERE ${FIRST_RESPONSE_SAMPLE_SQL} AND ${cohortWhereSql("c", f)} AND ${where}
       GROUP BY 1`;
  const dayLo = b
    ? b.lo === null
      ? 0
      : Math.ceil(b.lo.getTime() / DAY_MS) * DAY_MS
    : 0;
  const dayHi = b ? floorDay(b.hi.getTime()) : 0;
  if (!b || !f.runsMark || dayHi <= dayLo) {
    return Prisma.sql`responses AS (${raw(Prisma.sql`true`)})`;
  }
  const lo = new Date(dayLo);
  const hi = new Date(dayHi);
  return Prisma.sql`${markedQuartersSql({ lo, hi })},
    rdays AS MATERIALIZED (
      SELECT d.day FROM generate_series(${lo}::timestamp, ${hi}::timestamp - interval '1 day', interval '1 day') AS d(day)
       WHERE NOT EXISTS (SELECT 1 FROM cmarks WHERE cmarks.quarter >= d.day AND cmarks.quarter < d.day + interval '1 day')
    ),
    responses AS (
      SELECT s.bucket, SUM(s.conversations)::int AS conversations, MIN(s.min_seconds) AS min_seconds,
             MAX(s.max_seconds) AS max_seconds
        FROM conversation_first_response_days s LEFT JOIN inboxes bi ON bi.id = s.inbox_id
       WHERE s.day >= ${lo} AND s.day < ${hi}
         AND EXISTS (SELECT 1 FROM rdays WHERE rdays.day = s.day)
         AND ${countsFilterSql(f)}
       GROUP BY 1
      UNION ALL
      ${raw(Prisma.sql`c.created_at < ${lo}`)}
      UNION ALL
      ${raw(Prisma.sql`c.created_at >= ${hi}`)}
      UNION ALL
      SELECT r.* FROM generate_series(${lo}::timestamp, ${hi}::timestamp - interval '1 day', interval '1 day') AS g(day)
       CROSS JOIN LATERAL (${raw(Prisma.sql`c.created_at >= g.day AND c.created_at < g.day + interval '1 day'`)} OFFSET 0) r
       WHERE NOT EXISTS (SELECT 1 FROM rdays WHERE rdays.day = g.day)
    )`;
}

// A day grouping reads quarters only: every UTC day of a zone off UTC holds a local midnight.
function grouped(group?: DayGroup): DayGroup | false {
  return group && group.grain !== "day" ? group : false;
}

// THE FUNNEL'S COUNTS over `convs`, grouped by `key` when given: the same five counts
// `outcomeCountsSql` reads from the conversations.
export function funnelCountsSql(
  f: DashboardFilter,
  b: SumsBounds | null,
  key?: Prisma.Sql,
  // The key's week or month grouping, so the UTC days wholly inside a group come from the day sums.
  group?: DayGroup,
): Prisma.Sql {
  const counts = Prisma.sql`
           COALESCE(SUM(v.conversations), 0)::int AS total,
           COALESCE(SUM(v.conversations) FILTER (WHERE v.ran), 0)::int AS involved,
           COALESCE(SUM(v.conversations) FILTER (WHERE v.ran AND v.outcome = 'resolved_by_agent'), 0)::int AS resolved,
           COALESCE(SUM(v.conversations) FILTER (WHERE v.ran AND v.outcome = 'handoff'), 0)::int AS handoff,
           COALESCE(SUM(v.conversations) FILTER (WHERE v.ran AND v.outcome = 'resolved_before_tracking'), 0)::int AS untracked`;
  if (!key) {
    return Prisma.sql`WITH ${convsCtesSql(f, b, false, true)} SELECT ${counts} FROM convs v`;
  }
  // NOTE: counted per quarter first, so the key is worked out once per quarter, not once per row.
  return Prisma.sql`
    WITH ${convsCtesSql(f, b, false, grouped(group))}, byq AS MATERIALIZED (
      SELECT v.quarter, ${counts} FROM convs v GROUP BY 1
    )
    SELECT ${key} AS key,
           SUM(v.total)::int AS total, SUM(v.involved)::int AS involved, SUM(v.resolved)::int AS resolved,
           SUM(v.handoff)::int AS handoff, SUM(v.untracked)::int AS untracked
      FROM byq v
     GROUP BY 1`;
}

// THE FUNNEL SPLIT BY AGENT OR BY INBOX over `convs`: an agent's conversations are those whose inbox
// it is bound to and those it ran on, and it is involved in the ones it ran on; an inbox's are its
// own. `day` adds a second grouping, with the member's totals as the rows whose `key` is null.
export function funnelSeriesSql(
  f: DashboardFilter,
  b: SumsBounds | null,
  breakdown: "agent" | "inbox",
  day?: Prisma.Sql,
  unattributed = false,
  group?: DayGroup,
): Prisma.Sql {
  const agent = f.agentId ?? null;
  const rated =
    breakdown === "agent"
      ? Prisma.sql`
        SELECT m.member, v.*, (m.member = ANY(v.ran_agents)) AS member_ran
          FROM convs v LEFT JOIN inboxes i ON i.id = v.inbox_id
         CROSS JOIN LATERAL (
           SELECT DISTINCT x FROM unnest(v.ran_agents || CASE WHEN i.agent_id IS NULL THEN '{}'::bigint[]
                                                              ELSE ARRAY[i.agent_id] END) AS x
         ) AS m(member)
         WHERE (${agent}::bigint IS NULL OR m.member = ${agent}) AND (${unattributed}::boolean OR m.member <> 0)`
      : Prisma.sql`SELECT v.inbox_id AS member, v.*, v.ran AS member_ran FROM convs v`;
  // The day is a column of its own: a grouping expression written twice carries its zone as two
  // parameters, which GROUPING does not take for the same expression.
  const counts = Prisma.sql`
           COALESCE(SUM(rt.conversations), 0)::int AS total,
           COALESCE(SUM(rt.conversations) FILTER (WHERE rt.member_ran), 0)::int AS involved,
           COALESCE(SUM(rt.conversations) FILTER (WHERE rt.member_ran AND rt.outcome = 'resolved_by_agent'), 0)::int AS resolved,
           COALESCE(SUM(rt.conversations) FILTER (WHERE rt.member_ran AND rt.outcome = 'handoff'), 0)::int AS handoff,
           COALESCE(SUM(rt.conversations) FILTER (WHERE rt.member_ran AND rt.outcome = 'resolved_before_tracking'), 0)::int AS untracked`;
  if (!day) {
    return Prisma.sql`
    WITH ${convsCtesSql(f, b, breakdown === "agent", true)}, rated AS (${rated})
    SELECT rt.member::text AS member, NULL::text AS key, ${counts}
      FROM rated rt
     GROUP BY rt.member`;
  }
  return Prisma.sql`
    WITH ${convsCtesSql(f, b, breakdown === "agent", grouped(group))}, rated AS (SELECT r.*, ${day} AS day FROM (${rated}) r)
    SELECT rt.member::text AS member,
           CASE WHEN GROUPING(rt.day) = 1 THEN NULL ELSE rt.day END AS key, ${counts}
      FROM rated rt
     GROUP BY GROUPING SETS ((rt.member), (rt.member, rt.day))`;
}

// The breakdown's conversation columns for its agent and inbox rows: each member's involved
// conversations, and how many of them it resolved.
export async function funnelByKey(
  db: ScopedDb,
  filter: DashboardFilter,
  dimension: "agent" | "inbox",
): Promise<Map<string, { conversations: number; resolved: number }>> {
  if (!dividesByConversations(filter)) return new Map();
  const f = await withRunsMark(db, filter);
  const b = await sumsBounds(db, f);
  const rows = await db.$queryRaw<
    {
      member: string | null;
      key: string | null;
      involved: number;
      resolved: number;
    }[]
  >(funnelSeriesSql(f, b, dimension, undefined, dimension === "agent"));
  const out = new Map<string, { conversations: number; resolved: number }>();
  // NOTE: the breakdown's null row is looked up as "": conversations with no inbox, and those a legacy
  // turn with no agent ran on (member 0).
  for (const r of rows)
    if (r.key === null)
      out.set(r.member === null || r.member === "0" ? "" : r.member, {
        conversations: Number(r.involved),
        resolved: Number(r.resolved),
      });
  return out;
}
