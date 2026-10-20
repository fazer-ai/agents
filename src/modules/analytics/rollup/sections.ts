import { Prisma } from "@/../generated/prisma/client";
import type { ScopedDb } from "@/lib/tenancy";
import {
  CAUSE_SQL,
  callRanSql,
  HANDOFF_LINE_SQL,
  TARGET_SQL,
} from "../activity";
import {
  agentRanSql,
  agentTurnSql,
  cohortWhereSql,
  type DashboardFilter,
  localDaySql,
  logWhereSql,
  outcomeSql,
  usageWhereSql,
} from "../filter";
import {
  FIRST_RESPONSE_SAMPLE_SQL,
  type OutcomeRow,
  outcomeCountsSql,
} from "../service";

// WHAT ONE DAY OF THE DASHBOARD KEEPS, per section, in a form that adds up over days (docs/dashboard.md,
// "Kept days"). Every query is the live reader's query for the same figure, narrowed to a range of
// days and grouped by local day. A distinct count keeps, per day, the day each thing was last seen
// before ("prev"); a percentile keeps a coarse histogram plus every value of each bucket; a figure that
// reads a conversation's current state is evaluated when the day is computed, and a later change to
// that conversation drops the day (./store.ts).

export type Family = "conv" | "ledger" | "log" | "know";

export const SECTIONS = [
  "conv.funnel",
  "conv.series",
  "conv.labels",
  "ledger.costs",
  "ledger.breakdown",
  "ledger.latency",
  "log.handoffs",
  "log.followups",
  "log.problems",
  "know.knowledge",
] as const;
export type Section = (typeof SECTIONS)[number];

export const FAMILIES: readonly Family[] = ["conv", "ledger", "log", "know"];

export function familyOf(section: string): Family {
  return section.slice(0, section.indexOf(".")) as Family;
}

// The per-bucket value sections of the two percentiles, beside the sections above.
export const FR_CELL = "conv.fr.";
export const LAT_CELL = "ledger.lat.";

export type Counts5 = [number, number, number, number, number];
// prev day ('' when none) → count, or → [count, flagged count] where a flag is asked.
export type PrevHist = Record<string, number>;
export type PrevHist2 = Record<string, [number, number]>;
export type PrevHist3 = Record<string, [number, number, number]>;
export interface Histogram {
  n: number;
  b: Record<string, number>;
}

export interface FunnelDay {
  c: Counts5 | null;
  fr: Histogram;
}
export interface SeriesDay {
  agent: Record<string, Counts5>;
  inbox: Record<string, Counts5>;
}
export interface LabelsDay {
  l: Record<string, [number, number, number, number]>;
  u: number;
}
export interface CostsDay {
  // Null on a day with no ledger row in the view, as the live reader has no row for it.
  d: { cost: string | null; conv: number; res: number } | null;
  req: number;
  pt: number;
  ct: number;
  m: Record<string, [string | null, number]>;
  bm: Record<string, string>;
  bn: Record<string, string>;
  p: PrevHist2;
}
export interface BreakdownCell {
  r: number;
  c: string | null;
  u: number;
  pt: number;
  ct: number;
  p: PrevHist2;
}
export type BreakdownDay = Record<
  "agent" | "inbox" | "model" | "node",
  Record<string, BreakdownCell>
>;
export type LatencyDay = Record<string, Histogram>;
export interface HandoffsDay {
  d: Record<string, number>;
  s: Record<string, number>;
  t: Record<string, PrevHist>;
  g: Record<string, PrevHist>;
}
export interface FollowupsDay {
  s: number;
  p: PrevHist3;
}
export type ProblemsDay = Record<string, { n: number; p: PrevHist }>;
export type KnowledgeDay = Record<string, number>;

// A null key (a ledger row with no agent, a problem line with no tool) is kept under this string, a
// control character no name carries. Not U+0000: neither a Postgres text nor a jsonb key can hold it.
export const NULL_KEY = "\u0002";
export const SEP = "\u0001";

export interface Range {
  first: string;
  last: string;
  // The instants that bound the range in the zone: the first day's midnight and the day after the
  // last one's.
  since: Date;
  until: Date;
}

export type SectionRows = Map<string, Map<string, unknown>>;

function put(out: SectionRows, section: string, day: string, data: unknown) {
  let m = out.get(section);
  if (!m) {
    m = new Map();
    out.set(section, m);
  }
  m.set(day, data);
}

function dayRows<T>(
  out: SectionRows,
  section: string,
  day: string,
  init: () => T,
): T {
  let m = out.get(section);
  if (!m) {
    m = new Map();
    out.set(section, m);
  }
  let v = m.get(day) as T | undefined;
  if (v === undefined) {
    v = init();
    m.set(day, v);
  }
  return v;
}

const num = (v: unknown) => Number(v ?? 0);

// A dictionary keyed by names that come from outside (labels, models, tools, reasons): no prototype,
// so a name like `__proto__` or `constructor` is a key like any other.
function dict<T>(): Record<string, T> {
  return Object.create(null);
}

function slot<T>(o: Record<string, T>, key: string, init: () => NoInfer<T>): T {
  let v = Object.hasOwn(o, key) ? o[key] : undefined;
  if (v === undefined) {
    v = init();
    o[key] = v;
  }
  return v;
}
const dec = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

function windowed(f: DashboardFilter, r: Range): DashboardFilter {
  return { ...f, since: r.since, until: r.until };
}
function unwindowed(f: DashboardFilter): DashboardFilter {
  return { ...f, since: undefined, until: undefined };
}

// Counts of occurrences of (key, conversation) per day with the day each was last seen before, for a
// count of distinct conversations per key that adds up over days. `occ` yields distinct
// (key, cid, day); `prior` yields, for the first occurrence of each (key, cid) in the range, the last
// day it occurred before the range (one probe per conversation that already existed then). The days
// of a pair are aggregated into one sorted array, so the previous day is the array's previous element
// and no window sorts every occurrence; the steps are materialized so each runs once.
function prevSql(occ: Prisma.Sql, prior: Prisma.Sql, flag: Prisma.Sql) {
  return Prisma.sql`
    WITH occ AS (${occ}),
    firsts AS MATERIALIZED (
      SELECT key, cid, days[1] AS day, days FROM (
        SELECT key, cid, array_agg(day ORDER BY day) AS days FROM occ GROUP BY 1, 2) a
    ),
    prior AS MATERIALIZED (${prior}),
    seq AS (
      SELECT d.day, f.key, f.cid,
             CASE WHEN d.i = 1 THEN COALESCE(p.prev, '') ELSE f.days[d.i - 1] END AS prev
        FROM firsts f
        CROSS JOIN LATERAL unnest(f.days) WITH ORDINALITY AS d(day, i)
        LEFT JOIN prior p ON p.key = f.key AND p.cid = f.cid
    )
    SELECT s.day, s.key, s.prev, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE ${flag})::int AS f
      FROM seq s
      LEFT JOIN conversations c ON c.id = s.cid
     GROUP BY 1, 2, 3`;
}

type PrevRow = {
  day: string;
  key: string | null;
  prev: string;
  n: number;
  f: number;
};

// The values behind a percentile, per day, series and bucket, each bucket's values with their counts.
function quantileSql(o: {
  day: Prisma.Sql;
  series: Prisma.Sql;
  value: Prisma.Sql;
  from: Prisma.Sql;
}) {
  return Prisma.sql`
    SELECT day, s, b, SUM(n)::int AS n, jsonb_object_agg(v, n) AS cell FROM (
      SELECT ${o.day} AS day, ${o.series} AS s,
             -- Signed, so a duration measured across a clock moving back still has its bucket.
             floor(sign((${o.value})::float8) * ln(1 + abs((${o.value})::float8)) * 16)::int AS b,
             (${o.value})::float8::text AS v, COUNT(*)::int AS n
        ${o.from}
       GROUP BY 1, 2, 3, 4) x
     GROUP BY 1, 2, 3`;
}

type QuantileRow = {
  day: string;
  s: string;
  b: number;
  n: number;
  cell: Record<string, number>;
};

export async function computeConv(
  db: ScopedDb,
  sections: Set<Section>,
  f: DashboardFilter,
  tz: string,
  r: Range,
  out: SectionRows,
) {
  const fw = windowed(f, r);
  const day = localDaySql(Prisma.sql`c.created_at`, tz);
  if (sections.has("conv.funnel")) {
    const rows = await db.$queryRaw<OutcomeRow[]>(
      outcomeCountsSql(fw, { key: day }),
    );
    for (const row of rows)
      dayRows<FunnelDay>(out, "conv.funnel", String(row.key), () => ({
        c: null,
        fr: { n: 0, b: {} },
      })).c = [
        num(row.total),
        num(row.involved),
        num(row.resolved),
        num(row.handoff),
        num(row.untracked),
      ];
    const value = Prisma.sql`EXTRACT(EPOCH FROM (c.chatwoot_first_reply_at - c.chatwoot_created_at))`;
    const q = await db.$queryRaw<QuantileRow[]>(
      quantileSql({
        day,
        series: Prisma.sql`''`,
        value,
        from: Prisma.sql`
          FROM conversations c
         WHERE ${FIRST_RESPONSE_SAMPLE_SQL}
           AND ${cohortWhereSql("c", fw)}`,
      }),
    );
    for (const row of q) {
      const d = dayRows<FunnelDay>(out, "conv.funnel", row.day, () => ({
        c: null,
        fr: { n: 0, b: {} },
      }));
      d.fr.n += num(row.n);
      d.fr.b[String(row.b)] = num(row.n);
      put(out, `${FR_CELL}${row.b}`, row.day, row.cell);
    }
  }
  if (sections.has("conv.series")) {
    for (const breakdown of ["agent", "inbox"] as const) {
      const rows = await db.$queryRaw<(OutcomeRow & { member: string })[]>(
        seriesDaysSql(fw, breakdown, tz),
      );
      for (const row of rows)
        dayRows<SeriesDay>(out, "conv.series", String(row.key), () => ({
          agent: dict(),
          inbox: dict(),
        }))[breakdown][row.member] = [
          num(row.total),
          num(row.involved),
          num(row.resolved),
          num(row.handoff),
          num(row.untracked),
        ];
    }
  }
  if (sections.has("conv.labels")) {
    const rows = await db.$queryRaw<
      {
        day: string;
        label: string;
        total: number;
        involved: number;
        resolved: number;
        handoff: number;
      }[]
    >(Prisma.sql`
      WITH v AS MATERIALIZED (
        SELECT c.id, c.labels, ${day} AS day,
               ${outcomeSql("c")} AS outcome,
               ${agentRanSql("c", fw.agentId)} AS ran
          FROM conversations c
         WHERE ${cohortWhereSql("c", fw)} AND cardinality(c.labels) > 0
      )
      SELECT v.day, lb.label,
             COUNT(DISTINCT v.id)::int AS total,
             COUNT(DISTINCT v.id) FILTER (WHERE v.ran)::int AS involved,
             COUNT(DISTINCT v.id) FILTER (WHERE v.ran AND v.outcome = 'resolved_by_agent')::int AS resolved,
             COUNT(DISTINCT v.id) FILTER (WHERE v.ran AND v.outcome = 'handoff')::int AS handoff
        FROM v
        CROSS JOIN LATERAL unnest(v.labels) AS lb(label)
       GROUP BY 1, 2`);
    for (const row of rows)
      dayRows<LabelsDay>(out, "conv.labels", row.day, () => ({
        l: dict(),
        u: 0,
      })).l[row.label] = [
        num(row.total),
        num(row.involved),
        num(row.resolved),
        num(row.handoff),
      ];
    const unl = await db.$queryRaw<{ day: string; n: number }[]>(Prisma.sql`
      SELECT ${day} AS day, COUNT(*)::int AS n FROM conversations c
       WHERE ${cohortWhereSql("c", fw)} AND cardinality(c.labels) = 0
       GROUP BY 1`);
    for (const row of unl)
      dayRows<LabelsDay>(out, "conv.labels", row.day, () => ({
        l: dict(),
        u: 0,
      })).u = num(row.n);
  }
}

// trends.ts `seriesSql`, grouped by (member, day) only: a conversation belongs to one day, so a
// member's totals are the sum of its days.
export function seriesDaysSql(
  filter: DashboardFilter,
  breakdown: "agent" | "inbox",
  tz: string,
): Prisma.Sql {
  const members =
    breakdown === "agent"
      ? Prisma.sql`
        ran AS (
          SELECT DISTINCT ar.conversation_id AS id, ar.agent_id AS member
            FROM llm_usage ar
            JOIN base b ON b.id = ar.conversation_id
           WHERE ar.source = 'inbox' AND ${agentTurnSql("ar")} AND ar.agent_id IS NOT NULL
        ),
        members AS (
          SELECT b.id, i.agent_id AS member
            FROM base b JOIN inboxes i ON i.id = b.inbox_id
           WHERE i.agent_id IS NOT NULL
          UNION
          SELECT id, member FROM ran
        ),
        rated AS (
          SELECT m.id, m.member, (r.id IS NOT NULL) AS ran
            FROM members m
            LEFT JOIN ran r ON r.id = m.id AND r.member = m.member
           WHERE (${filter.agentId ?? null}::bigint IS NULL OR m.member = ${filter.agentId ?? null})
        )`
      : Prisma.sql`
        rated AS (
          SELECT b.id, b.inbox_id AS member, b.ran FROM base b
        )`;
  return Prisma.sql`
    WITH base AS (
      SELECT c.id, c.inbox_id,
             ${localDaySql(Prisma.sql`c.created_at`, tz)} AS day,
             ${outcomeSql("c")} AS outcome,
             ${agentRanSql("c", filter.agentId)} AS ran
        FROM conversations c
       WHERE ${cohortWhereSql("c", filter)}
    ),
    ${members}
    SELECT rt.member::text AS member,
           b.day AS key,
           COUNT(DISTINCT b.id)::int AS total,
           COUNT(DISTINCT b.id) FILTER (WHERE rt.ran)::int AS involved,
           COUNT(DISTINCT b.id) FILTER (WHERE rt.ran AND b.outcome = 'resolved_by_agent')::int AS resolved,
           COUNT(DISTINCT b.id) FILTER (WHERE rt.ran AND b.outcome = 'handoff')::int AS handoff,
           COUNT(DISTINCT b.id) FILTER (WHERE rt.ran AND b.outcome = 'resolved_before_tracking')::int AS untracked
      FROM rated rt JOIN base b ON b.id = rt.id
     GROUP BY rt.member, b.day`;
}

const BREAKDOWN_KEYS: Record<keyof BreakdownDay, (a: string) => Prisma.Sql> = {
  agent: (a) => Prisma.sql`${Prisma.raw(a)}.agent_id::text`,
  inbox: (a) => Prisma.sql`${Prisma.raw(a)}.inbox_id::text`,
  model: (a) => Prisma.sql`${Prisma.raw(a)}.model`,
  node: (a) => Prisma.sql`COALESCE(${Prisma.raw(a)}.node, 'agent')`,
};

// Every (dimension, key) a ledger row counts under, as `dim SEP key`: one scan of the window serves the
// conversation counts of the cost block and of the four breakdowns.
function ledgerKeysSql(a: string, dims: LedgerDim[]) {
  return Prisma.sql`CROSS JOIN LATERAL (VALUES ${Prisma.join(
    dims.map((d) =>
      d === "*"
        ? Prisma.sql`('*' || ${SEP}::text || '*')`
        : Prisma.sql`(${d}::text || ${SEP}::text || COALESCE(${BREAKDOWN_KEYS[d](a)}, ${NULL_KEY}::text))`,
    ),
  )}) AS k(key)`;
}

type LedgerDim = "*" | keyof BreakdownDay;

function ledgerPrevSql(
  f: DashboardFilter,
  r: Range,
  tz: string,
  dims: LedgerDim[],
) {
  const fw = windowed(f, r);
  return prevSql(
    Prisma.sql`
      SELECT k.key, u.conversation_id AS cid,
             ${localDaySql(Prisma.sql`u.created_at`, tz)} AS day
        FROM llm_usage u ${ledgerKeysSql("u", dims)}
       WHERE ${usageWhereSql("u", fw)} AND u.conversation_id IS NOT NULL
       GROUP BY 1, 2, 3`,
    Prisma.sql`
      WITH cand AS MATERIALIZED (
        SELECT f2.cid FROM (SELECT DISTINCT cid FROM firsts) f2
          LEFT JOIN conversations pc ON pc.id = f2.cid
         WHERE pc.id IS NULL OR pc.created_at < ${r.since}
      )
      SELECT f.key, f.cid, MAX(${localDaySql(Prisma.sql`u.created_at`, tz)}) AS prev
        FROM cand
        JOIN llm_usage u ON u.conversation_id = cand.cid
        ${ledgerKeysSql("u", dims)}
        JOIN firsts f ON f.cid = cand.cid AND f.key = k.key
       WHERE u.created_at < ${r.since}
         AND ${usageWhereSql("u", unwindowed(f))}
       GROUP BY 1, 2`,
    Prisma.sql`${outcomeSql("c")} = 'resolved_by_agent'`,
  );
}

const costsDay = (): CostsDay => ({
  d: null,
  req: 0,
  pt: 0,
  ct: 0,
  m: dict(),
  bm: dict(),
  bn: dict(),
  p: {},
});
const breakdownDay = (): BreakdownDay => ({
  agent: dict(),
  inbox: dict(),
  model: dict(),
  node: dict(),
});
const emptyCell = (): BreakdownCell => ({
  r: 0,
  c: null,
  u: 0,
  pt: 0,
  ct: 0,
  p: {},
});

function addPrev2(h: PrevHist2, row: PrevRow) {
  h[row.prev] = [num(row.n), num(row.f)];
}

export async function computeLedger(
  db: ScopedDb,
  sections: Set<Section>,
  f: DashboardFilter,
  tz: string,
  r: Range,
  out: SectionRows,
) {
  const fw = windowed(f, r);
  const where = usageWhereSql("u", fw);
  const day = localDaySql(Prisma.sql`u.created_at`, tz);
  if (sections.has("ledger.costs")) {
    const init = costsDay;
    const days = await db.$queryRaw<
      {
        day: string;
        cost: unknown;
        conversations: number;
        resolved: number;
        requests: number;
        prompt: unknown;
        completion: unknown;
      }[]
    >(Prisma.sql`
      SELECT ${day} AS day,
             SUM(u.cost_usd) AS cost,
             COUNT(DISTINCT u.conversation_id)::int AS conversations,
             COUNT(DISTINCT u.conversation_id) FILTER (WHERE ${outcomeSql("c")} = 'resolved_by_agent')::int AS resolved,
             COUNT(*)::int AS requests,
             COALESCE(SUM(u.prompt_tokens), 0)::bigint AS prompt,
             COALESCE(SUM(u.completion_tokens), 0)::bigint AS completion
        FROM llm_usage u
        LEFT JOIN conversations c ON c.id = u.conversation_id
       WHERE ${where}
       GROUP BY 1`);
    for (const row of days) {
      const d = dayRows(out, "ledger.costs", row.day, init);
      d.d = {
        cost: dec(row.cost),
        conv: num(row.conversations),
        res: num(row.resolved),
      };
      d.req = num(row.requests);
      d.pt = num(row.prompt);
      d.ct = num(row.completion);
    }
    const models = await db.$queryRaw<
      { day: string; model: string; cost: unknown; unpriced: number }[]
    >(Prisma.sql`
      SELECT ${day} AS day, u.model,
             SUM(u.cost_usd) AS cost,
             COUNT(*) FILTER (WHERE u.cost_usd IS NULL)::int AS unpriced
        FROM llm_usage u
       WHERE ${where}
       GROUP BY 1, 2`);
    for (const row of models)
      dayRows(out, "ledger.costs", row.day, init).m[row.model] = [
        dec(row.cost),
        num(row.unpriced),
      ];
    for (const [k, key] of [
      ["bm", Prisma.sql`u.model`],
      ["bn", Prisma.sql`COALESCE(u.node, 'agent')`],
    ] as const) {
      const split = await db.$queryRaw<
        { day: string; key: string; cost: unknown }[]
      >(
        Prisma.sql`
          SELECT ${day} AS day, ${key} AS key, SUM(u.cost_usd) AS cost
            FROM llm_usage u
           WHERE ${where} AND u.cost_usd IS NOT NULL
           GROUP BY 1, 2`,
      );
      for (const row of split)
        dayRows(out, "ledger.costs", row.day, init)[k][row.key] = String(
          row.cost,
        );
    }
  }
  if (sections.has("ledger.breakdown")) {
    const init = breakdownDay;
    for (const dim of ["agent", "inbox", "model", "node"] as const) {
      const rows = await db.$queryRaw<
        {
          day: string;
          key: string | null;
          requests: number;
          cost: unknown;
          unpriced: number;
          prompt: unknown;
          cached: unknown;
        }[]
      >(Prisma.sql`
        SELECT ${day} AS day, ${BREAKDOWN_KEYS[dim]("u")} AS key,
               COUNT(*)::int AS requests,
               SUM(u.cost_usd) AS cost,
               COUNT(*) FILTER (WHERE u.cost_usd IS NULL)::int AS unpriced,
               COALESCE(SUM(u.prompt_tokens), 0)::bigint AS prompt,
               COALESCE(SUM(u.cached_read_tokens), 0)::bigint AS cached
          FROM llm_usage u
         WHERE ${where}
         GROUP BY 1, 2`);
      const cell = (d: string, key: string | null) =>
        slot(
          dayRows(out, "ledger.breakdown", d, init)[dim],
          key ?? NULL_KEY,
          emptyCell,
        );
      for (const row of rows) {
        const c = cell(row.day, row.key);
        c.r = num(row.requests);
        c.c = dec(row.cost);
        c.u = num(row.unpriced);
        c.pt = num(row.prompt);
        c.ct = num(row.cached);
      }
    }
  }
  const dims: LedgerDim[] = [
    ...(sections.has("ledger.costs") ? (["*"] as const) : []),
    ...(sections.has("ledger.breakdown")
      ? (["agent", "inbox", "model", "node"] as const)
      : []),
  ];
  if (dims.length > 0) {
    const prev = await db.$queryRaw<PrevRow[]>(ledgerPrevSql(f, r, tz, dims));
    for (const row of prev) {
      const [dim = "", key = ""] = String(row.key).split(SEP);
      if (dim === "*") {
        addPrev2(dayRows(out, "ledger.costs", row.day, costsDay).p, row);
        continue;
      }
      const bucket = dayRows(out, "ledger.breakdown", row.day, breakdownDay)[
        dim as keyof BreakdownDay
      ];
      addPrev2(slot(bucket, key, emptyCell).p, row);
    }
  }
  if (sections.has("ledger.latency")) {
    const q = await db.$queryRaw<QuantileRow[]>(
      quantileSql({
        day,
        series: Prisma.sql`u.model`,
        value: Prisma.sql`u.duration_ms`,
        from: Prisma.sql`FROM llm_usage u WHERE ${where} AND u.duration_ms IS NOT NULL`,
      }),
    );
    for (const row of q) {
      const d = dayRows<LatencyDay>(out, "ledger.latency", row.day, dict);
      const h = slot(d, row.s, () => ({ n: 0, b: {} }));
      h.n += num(row.n);
      h.b[String(row.b)] = num(row.n);
      dayRows<Record<string, Record<string, number>>>(
        out,
        `${LAT_CELL}${row.b}`,
        row.day,
        dict,
      )[row.s] = row.cell;
    }
  }
}

function logPrevSql(
  f: DashboardFilter,
  r: Range,
  tz: string,
  key: Prisma.Sql,
  lines: Prisma.Sql,
) {
  const fw = windowed(f, r);
  return prevSql(
    Prisma.sql`
      SELECT k.key, k.cid, k.day FROM (
        SELECT ${key} AS key, l.conversation_id AS cid,
               ${localDaySql(Prisma.sql`l.created_at`, tz)} AS day
          FROM execution_logs l
         WHERE ${logWhereSql("l", fw)} AND l.conversation_id IS NOT NULL AND ${lines}) k
       WHERE k.key IS NOT NULL
       GROUP BY 1, 2, 3`,
    Prisma.sql`
      SELECT f.key, f.cid, MAX(k.day) AS prev FROM firsts f
        JOIN (
          SELECT ${key} AS key, l.conversation_id AS cid,
                 ${localDaySql(Prisma.sql`l.created_at`, tz)} AS day
            FROM (SELECT DISTINCT cid FROM firsts) f2
            LEFT JOIN conversations pc ON pc.id = f2.cid
            JOIN execution_logs l ON l.conversation_id = f2.cid
           WHERE (pc.id IS NULL OR pc.created_at < ${r.since})
             AND l.created_at < ${r.since}
             AND ${logWhereSql("l", unwindowed(f))} AND ${lines}) k
          ON k.key = f.key AND k.cid = f.cid
       GROUP BY 1, 2`,
    Prisma.sql`false`,
  );
}

export async function computeLog(
  db: ScopedDb,
  sections: Set<Section>,
  f: DashboardFilter,
  tz: string,
  r: Range,
  out: SectionRows,
) {
  const fw = windowed(f, r);
  const where = logWhereSql("l", fw);
  const day = localDaySql(Prisma.sql`l.created_at`, tz);
  if (sections.has("log.handoffs")) {
    const init = (): HandoffsDay => ({
      d: dict(),
      s: dict(),
      t: dict(),
      g: dict(),
    });
    const days = await db.$queryRaw<
      { day: string; cause: string; n: number }[]
    >(Prisma.sql`
      SELECT day, cause, COUNT(DISTINCT conversation_id)::int AS n
        FROM (SELECT ${day} AS day, ${CAUSE_SQL} AS cause, l.conversation_id
                FROM execution_logs l
               WHERE ${where}
                 AND l.conversation_id IS NOT NULL
                 AND ${HANDOFF_LINE_SQL}) x
       WHERE cause IS NOT NULL
       GROUP BY 1, 2`);
    for (const row of days)
      dayRows(out, "log.handoffs", row.day, init).d[row.cause] = num(row.n);
    const silences = await db.$queryRaw<
      { day: string; reason: string; n: number }[]
    >(
      Prisma.sql`
        SELECT ${day} AS day,
               COALESCE(l.detail->>'skipReason', 'unrecorded') AS reason,
               COUNT(*)::int AS n
          FROM execution_logs l
         WHERE ${where}
           AND l.stage = 'tool'
           AND l.detail->>'tool' = 'skip_reply'
           AND ${callRanSql("l")}
         GROUP BY 1, 2`,
    );
    for (const row of silences)
      dayRows(out, "log.handoffs", row.day, init).s[row.reason] = num(row.n);
    const totals = await db.$queryRaw<PrevRow[]>(
      logPrevSql(f, r, tz, CAUSE_SQL, HANDOFF_LINE_SQL),
    );
    for (const row of totals) {
      const t = dayRows(out, "log.handoffs", row.day, init).t;
      slot(t, String(row.key), dict)[row.prev] = num(row.n);
    }
    const targets = await db.$queryRaw<PrevRow[]>(
      logPrevSql(
        f,
        r,
        tz,
        Prisma.sql`(CASE WHEN ${TARGET_SQL} IS NOT NULL THEN ${CAUSE_SQL} || ${SEP}::text || ${TARGET_SQL} END)`,
        Prisma.sql`l.stage = 'handoff'`,
      ),
    );
    for (const row of targets) {
      const g = dayRows(out, "log.handoffs", row.day, init).g;
      slot(g, String(row.key), dict)[row.prev] = num(row.n);
    }
  }
  if (sections.has("log.followups")) {
    const init = (): FollowupsDay => ({ s: 0, p: {} });
    const step = Prisma.sql`l.stage = 'generate'
           AND l.detail->>'trigger' = 'followup'
           AND l.detail->>'outcome' IN ('messaged', 'templated')`;
    const steps = await db.$queryRaw<{ day: string; n: number }[]>(Prisma.sql`
      SELECT ${day} AS day, COUNT(*)::int AS n
        FROM execution_logs l
       WHERE ${where} AND ${step} AND l.conversation_id IS NOT NULL
       GROUP BY 1`);
    for (const row of steps)
      dayRows(out, "log.followups", row.day, init).s = num(row.n);
    // A conversation's first step of the window is its first step on the first day it counts, so
    // whether the customer wrote back after it is decided per (conversation, day) here.
    const prev = await db.$queryRaw<
      { day: string; prev: string; n: number; came: number; closed: number }[]
    >(Prisma.sql`
      WITH occ AS MATERIALIZED (
        SELECT l.conversation_id AS cid, ${day} AS day, MIN(l.created_at) AS first_at
          FROM execution_logs l
         WHERE ${where} AND ${step} AND l.conversation_id IS NOT NULL
         GROUP BY 1, 2
      ),
      firsts AS MATERIALIZED (SELECT cid, MIN(day) AS day FROM occ GROUP BY 1),
      prior AS MATERIALIZED (
        SELECT f.cid, MAX(${day}) AS prev
          FROM firsts f
          LEFT JOIN conversations pc ON pc.id = f.cid
          JOIN execution_logs l ON l.conversation_id = f.cid
         WHERE (pc.id IS NULL OR pc.created_at < ${r.since})
           AND l.created_at < ${r.since}
           AND ${logWhereSql("l", unwindowed(f))} AND ${step}
         GROUP BY 1
      ),
      seq AS (
        SELECT o.day, o.cid, o.first_at,
               COALESCE(LAG(o.day) OVER (PARTITION BY o.cid ORDER BY o.day), p.prev, '') AS prev
          FROM occ o LEFT JOIN prior p ON p.cid = o.cid
      )
      SELECT s.day, s.prev, COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE c.last_inbound_at > s.first_at)::int AS came,
             COUNT(*) FILTER (WHERE c.status = 'resolved' AND c.resolved_by = 'followup_abandonment')::int AS closed
        FROM seq s
        JOIN conversations c ON c.id = s.cid
       GROUP BY 1, 2`);
    for (const row of prev)
      dayRows(out, "log.followups", row.day, init).p[row.prev] = [
        num(row.n),
        num(row.came),
        num(row.closed),
      ];
  }
  if (sections.has("log.problems")) {
    const key = Prisma.sql`(l.stage || ${SEP}::text || COALESCE(CASE WHEN l.stage = 'tool' THEN l.detail->>'tool' END, ${NULL_KEY}::text) || ${SEP}::text || l.level)`;
    const problem = Prisma.sql`l.level IN ('warn', 'error')`;
    const lines = await db.$queryRaw<
      { day: string; key: string; n: number }[]
    >(Prisma.sql`
      SELECT ${day} AS day, ${key} AS key, COUNT(*)::int AS n
        FROM execution_logs l
       WHERE ${where} AND ${problem}
       GROUP BY 1, 2`);
    for (const row of lines)
      dayRows<ProblemsDay>(out, "log.problems", row.day, dict)[row.key] = {
        n: num(row.n),
        p: {},
      };
    const prev = await db.$queryRaw<PrevRow[]>(
      logPrevSql(f, r, tz, key, problem),
    );
    for (const row of prev) {
      const d = dayRows<ProblemsDay>(out, "log.problems", row.day, dict);
      slot(d, String(row.key), () => ({ n: 0, p: {} })).p[row.prev] = num(
        row.n,
      );
    }
  }
}

export async function computeKnow(
  db: ScopedDb,
  sections: Set<Section>,
  f: DashboardFilter,
  tz: string,
  r: Range,
  out: SectionRows,
) {
  if (!sections.has("know.knowledge")) return;
  const agent = f.agentId ?? null;
  const inbox = f.inboxId ?? null;
  const source = f.source ?? null;
  const audience = f.audience ?? null;
  // A suggestion's segment is its thread's: a playground thread is `<tenant>:playground:<agent>:…`, a
  // client channel thread `<tenant>:client:<agent>:…` (src/graph/detached-thread.ts); anything else
  // is real traffic.
  const rows = await db.$queryRaw<
    { day: string; status: string; n: number }[]
  >(Prisma.sql`
    SELECT ${localDaySql(Prisma.sql`q.created_at`, tz)} AS day, q.status::text AS status, COUNT(*)::int AS n
      FROM approval_queue_items q
     WHERE q.created_at >= ${r.since}
       AND q.created_at < ${r.until}
       AND (${agent}::bigint IS NULL OR q.agent_id = ${agent})
       AND (${source}::text IS NULL
            OR CASE split_part(COALESCE(q.thread_id, ''), ':', 2)
                 WHEN 'playground' THEN 'playground'
                 WHEN 'client' THEN 'client'
                 ELSE 'inbox'
               END = ${source}::text)
       -- A suggestion carries no audience of its own, so it is its thread's owner when the day is
       -- computed: one proposed before an anonymous visitor signed in counts as identified, and one
       -- whose anonymous thread expired counts as neither.
       AND (${audience}::text IS NULL OR EXISTS (
             SELECT 1 FROM detached_threads dt
               JOIN external_users eu ON eu.id = dt.external_user_id
              WHERE dt.thread_id = q.thread_id
                AND split_part(q.thread_id, ':', 2) = 'client'
                AND (eu.external_id LIKE 'anon:%') = (${audience}::text = 'anonymous')))
       AND (${inbox}::bigint IS NULL OR EXISTS (
             SELECT 1 FROM conversations c
              WHERE c.thread_id = q.thread_id AND c.inbox_id = ${inbox}))
     GROUP BY 1, 2`);
  for (const row of rows)
    dayRows<KnowledgeDay>(out, "know.knowledge", row.day, dict)[row.status] =
      num(row.n);
}

export const COMPUTE: Record<
  Family,
  (
    db: ScopedDb,
    sections: Set<Section>,
    f: DashboardFilter,
    tz: string,
    r: Range,
    out: SectionRows,
  ) => Promise<void>
> = {
  conv: computeConv,
  ledger: computeLedger,
  log: computeLog,
  know: computeKnow,
};
