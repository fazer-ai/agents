import { Prisma } from "@/../generated/prisma/client";
import { usageNode } from "@/graph/usage";
import { parseDbId } from "@/lib/db-id";
import type { ScopedDb } from "@/lib/tenancy";
import {
  type FollowUpActivity,
  HANDOFF_CAUSES,
  HANDOFF_TARGETS,
  type HandoffCause,
  type HandoffReasons,
  type HandoffTarget,
  type KnowledgeActivity,
  type LabelOutcomes,
} from "../activity";
import type { BreakdownDimension, BreakdownRow } from "../breakdown";
import type { DashboardCosts } from "../costs";
import type { HealthReport } from "../health";
import {
  type DashboardKpis,
  type OutcomeCounts,
  outcomeRates,
} from "../service";
import type { OutcomeSeries, OutcomeTrend } from "../trends";
import { pgLerp } from "./lerp";
import {
  type BreakdownDay,
  type CostsDay,
  type Counts5,
  type FollowupsDay,
  FR_CELL,
  type FunnelDay,
  type HandoffsDay,
  type Histogram,
  type KnowledgeDay,
  LAT_CELL,
  type LabelsDay,
  type LatencyDay,
  NULL_KEY,
  type ProblemsDay,
  SEP,
  type Section,
  type SeriesDay,
} from "./sections";

// THE WINDOW FROM ITS DAYS. Each function returns exactly what the live reader of the same block
// returns for the same window, built from the days' kept sections (./sections.ts). A day absent from
// the store (not computed yet, or a flow-log day that was never kept and whose lines are gone) adds
// nothing, and the caller reports how many days each block covers.

export interface DayStore {
  get(section: Section, day: string): unknown;
  // The value cells of a percentile, for the buckets asked, on the days asked.
  cells(
    prefix: string,
    buckets: number[],
    days: string[],
  ): Promise<Map<string, Map<number, unknown>>>;
}

export interface WindowDays {
  // Every local day of the window, ascending.
  days: string[];
}

const Dec = Prisma.Decimal.clone({ precision: 60 });
type Dec = InstanceType<typeof Dec>;

function sumDec(a: Dec | null, v: string | null): Dec | null {
  if (v === null) return a;
  return a === null ? new Dec(v) : a.plus(v);
}

const counts = (c: Counts5): OutcomeCounts => ({
  total: c[0],
  involved: c[1],
  resolvedByBot: c[2],
  handoff: c[3],
  resolvedBeforeTracking: c[4],
});

function addCounts(a: Counts5, b: Counts5): Counts5 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4]];
}

const ZERO: Counts5 = [0, 0, 0, 0, 0];

// Whether an occurrence counted on its day is the thing's first in the window: its previous day is
// before the window, or is a day of the window the store does not hold. The day an occurrence was
// seen before always has a row of its section, so a day without one is a flow-log day the retention
// sweep emptied before it was kept: the occurrence there counts nowhere else, and it counts here.
type First = (prev: string) => boolean;

function firstOf(store: DayStore, section: Section, start: string): First {
  return (prev) =>
    prev === "" || prev < start || store.get(section, prev) === undefined;
}

function each<T>(
  store: DayStore,
  section: Section,
  w: WindowDays,
  fn: (d: T, day: string) => void,
) {
  for (const day of w.days) {
    const d = store.get(section, day) as T | undefined;
    if (d !== undefined) fn(d, day);
  }
}

// The order Postgres gives these strings, for the lists the live readers sort with ORDER BY on text:
// the database's collation, which no JavaScript comparison reproduces.
export async function pgOrder(
  db: ScopedDb,
  keys: string[],
): Promise<Map<string, number>> {
  const uniq = [...new Set(keys)];
  if (uniq.length < 2) return new Map(uniq.map((k, i) => [k, i]));
  const rows = await db.$queryRaw<{ k: string }[]>(
    Prisma.sql`SELECT k FROM unnest(${uniq}::text[]) AS t(k) ORDER BY k`,
  );
  return new Map(rows.map((r, i) => [r.k, i]));
}

// percentile_cont over the values a set of daily histograms describe, the way Postgres computes it:
// the two order statistics around p·(n−1), interpolated as lo + frac·(hi − lo).
async function percentiles(
  store: DayStore,
  prefix: string,
  hists: { day: string; h: Histogram }[],
  pick: (cell: unknown) => Record<string, number> | undefined,
  ps: number[],
): Promise<(number | null)[]> {
  const byBucket = new Map<number, number>();
  let n = 0;
  for (const { h } of hists) {
    n += h.n;
    for (const [b, c] of Object.entries(h.b))
      byBucket.set(Number(b), (byBucket.get(Number(b)) ?? 0) + c);
  }
  if (n === 0) return ps.map(() => null);
  const buckets = [...byBucket.keys()].sort((a, b) => a - b);
  const locate = (rank: number) => {
    let before = 0;
    for (const b of buckets) {
      const c = byBucket.get(b) ?? 0;
      if (rank < before + c) return { b, offset: rank - before };
      before += c;
    }
    throw new Error("rank past the histogram");
  };
  const wanted = ps.flatMap((p) => {
    const pos = p * (n - 1);
    return [Math.floor(pos), Math.ceil(pos)];
  });
  const located = wanted.map(locate);
  const need = [...new Set(located.map((l) => l.b))];
  const days = hists.map((x) => x.day);
  const cells = await store.cells(prefix, need, days);
  const sorted = new Map<number, [number, number][]>();
  for (const b of need) {
    const merged = new Map<number, number>();
    for (const day of days) {
      const cell = pick(cells.get(day)?.get(b));
      if (!cell) continue;
      for (const [v, c] of Object.entries(cell))
        merged.set(Number(v), (merged.get(Number(v)) ?? 0) + c);
    }
    sorted.set(
      b,
      [...merged.entries()].sort((x, y) => x[0] - y[0]),
    );
  }
  const valueAt = (l: { b: number; offset: number }) => {
    let before = 0;
    for (const [v, c] of sorted.get(l.b) ?? []) {
      if (l.offset < before + c) return v;
      before += c;
    }
    throw new Error("rank past the bucket");
  };
  return ps.map((p, i) => {
    const pos = p * (n - 1);
    const at = (j: number) => {
      const l = located[j];
      if (!l) throw new Error("rank not located");
      return valueAt(l);
    };
    const lo = at(2 * i);
    if (Math.floor(pos) === Math.ceil(pos)) return lo;
    return pgLerp(p, n, lo, at(2 * i + 1));
  });
}

export async function mergeKpis(
  store: DayStore,
  w: WindowDays,
): Promise<DashboardKpis> {
  let c = ZERO;
  const hists: { day: string; h: Histogram }[] = [];
  each<FunnelDay>(store, "conv.funnel", w, (d, day) => {
    if (d.c) c = addCounts(c, d.c);
    if (d.fr.n > 0) hists.push({ day, h: d.fr });
  });
  const sampled = hists.reduce((s, x) => s + x.h.n, 0);
  const [median = null, p90 = null] = await percentiles(
    store,
    FR_CELL,
    hists,
    (cell) => cell as Record<string, number> | undefined,
    [0.5, 0.9],
  );
  const oc = counts(c);
  return {
    totalConversations: oc.total,
    involved: oc.involved,
    resolvedByBot: oc.resolvedByBot,
    handoff: oc.handoff,
    resolvedBeforeTracking: oc.resolvedBeforeTracking,
    firstResponseSeconds: median,
    firstResponseP90Seconds: p90,
    firstResponseSampled: sampled,
    ...outcomeRates(oc),
  };
}

async function names(
  db: ScopedDb,
  kind: "agent" | "inbox",
  keys: string[],
): Promise<Map<string, string>> {
  const ids = keys
    .map((k) => parseDbId(k))
    .filter((id): id is bigint => id !== null);
  if (ids.length === 0) return new Map();
  const rows =
    kind === "agent"
      ? await db.agent.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        })
      : await db.inbox.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        });
  return new Map(rows.map((r) => [String(r.id), r.name]));
}

export async function mergeTrend(
  db: ScopedDb,
  store: DayStore,
  w: WindowDays,
  breakdown?: "agent" | "inbox",
): Promise<OutcomeTrend> {
  let total = ZERO;
  const days: OutcomeTrend["days"] = [];
  each<FunnelDay>(store, "conv.funnel", w, (d, day) => {
    if (!d.c) return;
    total = addCounts(total, d.c);
    days.push({ date: day, ...counts(d.c) });
  });
  days.sort((a, b) => a.date.localeCompare(b.date));
  if (!breakdown) return { totals: counts(total), days };
  const members = new Map<
    string,
    { totals: Counts5; days: OutcomeSeries["days"] }
  >();
  each<SeriesDay>(store, "conv.series", w, (d, day) => {
    for (const [member, c] of Object.entries(d[breakdown])) {
      const m = members.get(member) ?? { totals: ZERO, days: [] };
      m.totals = addCounts(m.totals, c);
      m.days.push({ date: day, ...counts(c) });
      members.set(member, m);
    }
  });
  const label = await names(db, breakdown, [...members.keys()]);
  const series: OutcomeSeries[] = [];
  for (const [key, m] of members) {
    const l = label.get(key);
    if (l === undefined) continue;
    m.days.sort((a, b) => a.date.localeCompare(b.date));
    series.push({ key, label: l, totals: counts(m.totals), days: m.days });
  }
  series.sort(
    (a, b) => b.totals.total - a.totals.total || a.key.localeCompare(b.key),
  );
  return { totals: counts(total), days, series };
}

export async function mergeLabels(
  db: ScopedDb,
  store: DayStore,
  w: WindowDays,
): Promise<LabelOutcomes> {
  const byLabel = new Map<string, [number, number, number, number]>();
  let unlabeled = 0;
  each<LabelsDay>(store, "conv.labels", w, (d) => {
    unlabeled += d.u;
    for (const [label, c] of Object.entries(d.l)) {
      const a = byLabel.get(label) ?? [0, 0, 0, 0];
      byLabel.set(label, [a[0] + c[0], a[1] + c[1], a[2] + c[2], a[3] + c[3]]);
    }
  });
  const order = await pgOrder(db, [...byLabel.keys()]);
  const labels = [...byLabel.entries()]
    .sort(
      (a, b) =>
        b[1][0] - a[1][0] || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0),
    )
    .map(([label, c]) => ({
      label,
      conversations: c[0],
      involved: c[1],
      resolvedByBot: c[2],
      handoff: c[3],
      resolutionRate: c[1] > 0 ? c[2] / c[1] : null,
    }));
  return { labels, unlabeled };
}

function countFirst2(
  h: Record<string, [number, number]>,
  first: First,
): [number, number] {
  let n = 0;
  let f = 0;
  for (const [prev, [a, b]] of Object.entries(h)) {
    if (!first(prev)) continue;
    n += a;
    f += b;
  }
  return [n, f];
}

function countFirst(h: Record<string, number>, first: First): number {
  let n = 0;
  for (const [prev, a] of Object.entries(h)) if (first(prev)) n += a;
  return n;
}

export async function mergeCosts(
  db: ScopedDb,
  store: DayStore,
  w: WindowDays,
  langfuse: DashboardCosts["langfuse"],
): Promise<DashboardCosts> {
  const start = w.days[0] ?? "";
  const first = firstOf(store, "ledger.costs", start);
  const days: DashboardCosts["days"] = [];
  const models = new Map<string, { cost: Dec | null; unpriced: number }>();
  const byModelDays: { date: string; key: string; cost: string }[] = [];
  const byNodeDays: { date: string; key: string; cost: string }[] = [];
  let requests = 0;
  let prompt = 0;
  let completion = 0;
  let conversations = 0;
  let resolved = 0;
  let priced = false;
  each<CostsDay>(store, "ledger.costs", w, (d, day) => {
    if (d.d) {
      const costUsd = Number(d.d.cost ?? 0);
      const isPriced = d.d.cost !== null;
      if (isPriced) priced = true;
      days.push({
        date: day,
        costUsd: Number.isFinite(costUsd) ? costUsd : 0,
        conversations: d.d.conv,
        resolvedConversations: d.d.res,
        costPerConversation:
          isPriced && d.d.conv > 0 ? costUsd / d.d.conv : null,
        costPerResolvedConversation:
          isPriced && d.d.res > 0 ? costUsd / d.d.res : null,
      });
    }
    requests += d.req;
    prompt += d.pt;
    completion += d.ct;
    for (const [model, [cost, unpriced]] of Object.entries(d.m)) {
      const m = models.get(model) ?? { cost: null, unpriced: 0 };
      m.cost = sumDec(m.cost, cost);
      m.unpriced += unpriced;
      models.set(model, m);
    }
    for (const [key, cost] of Object.entries(d.bm))
      byModelDays.push({ date: day, key, cost });
    for (const [key, cost] of Object.entries(d.bn))
      byNodeDays.push({ date: day, key, cost });
    const [n, r] = countFirst2(d.p, first);
    conversations += n;
    resolved += r;
  });
  days.sort((a, b) => a.date.localeCompare(b.date));
  const order = await pgOrder(db, [
    ...byModelDays.map((r) => r.key),
    ...byNodeDays.map((r) => r.key),
  ]);
  const split = (rows: typeof byModelDays, name: (k: string) => string) =>
    rows
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0),
      )
      .map((r) => ({ date: r.date, key: name(r.key), costUsd: usd(r.cost) }));
  const totalCostUsd = days.reduce((sum, d) => sum + d.costUsd, 0);
  const byModel = [...models.entries()]
    .filter(([, m]) => m.cost !== null)
    .map(([model, m]) => ({ model, costUsd: usd(m.cost?.toString() ?? null) }))
    .sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model));
  const unpricedModels = [...models.entries()].filter(
    ([, m]) => m.unpriced > 0,
  );
  return {
    totalCostUsd,
    requests,
    tokens: { prompt, completion },
    conversations,
    resolvedConversations: resolved,
    costPerConversation:
      priced && conversations > 0 ? totalCostUsd / conversations : null,
    costPerResolvedConversation:
      priced && resolved > 0 ? totalCostUsd / resolved : null,
    days,
    daysByModel: split(byModelDays, (k) => k),
    daysByNode: split(byNodeDays, usageNode),
    byModel,
    unpriced: {
      calls: unpricedModels.reduce((n, [, m]) => n + m.unpriced, 0),
      models: unpricedModels.map(([model]) => model).sort(),
    },
    langfuse,
  };
}

function usd(v: string | null): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function mergeBreakdown(
  db: ScopedDb,
  store: DayStore,
  w: WindowDays,
  dimension: BreakdownDimension,
): Promise<BreakdownRow[]> {
  const start = w.days[0] ?? "";
  const first = firstOf(store, "ledger.breakdown", start);
  const rows = new Map<
    string,
    {
      r: number;
      c: Dec | null;
      u: number;
      pt: number;
      ct: number;
      conv: number;
      res: number;
    }
  >();
  each<BreakdownDay>(store, "ledger.breakdown", w, (d) => {
    for (const [key, cell] of Object.entries(d[dimension])) {
      const a = rows.get(key) ?? {
        r: 0,
        c: null,
        u: 0,
        pt: 0,
        ct: 0,
        conv: 0,
        res: 0,
      };
      a.r += cell.r;
      a.c = sumDec(a.c, cell.c);
      a.u += cell.u;
      a.pt += cell.pt;
      a.ct += cell.ct;
      const [n, f] = countFirst2(cell.p, first);
      a.conv += n;
      a.res += f;
      rows.set(key, a);
    }
  });
  const keys = [...rows.keys()].filter((k) => k !== NULL_KEY);
  const label =
    dimension === "agent" || dimension === "inbox"
      ? await names(db, dimension, keys)
      : new Map<string, string>();
  return [...rows.entries()]
    .map(([k, a]) => {
      const key = k === NULL_KEY ? null : k;
      const priced = a.c !== null;
      const cost = Number(a.c?.toString() ?? 0);
      return {
        key,
        label:
          key === null
            ? null
            : dimension === "agent" || dimension === "inbox"
              ? (label.get(key) ?? null)
              : dimension === "node"
                ? usageNode(key)
                : key,
        conversations: a.conv,
        requests: a.r,
        costUsd: Number.isFinite(cost) ? cost : 0,
        unpricedRequests: a.u,
        costPerConversation: priced && a.conv > 0 ? cost / a.conv : null,
        resolvedConversations: a.res,
        resolutionRate: a.conv > 0 ? a.res / a.conv : null,
        promptTokens: a.pt,
        cachedReadTokens: a.ct,
        cacheShare: a.pt > 0 ? a.ct / a.pt : null,
      };
    })
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        b.requests - a.requests ||
        String(a.key).localeCompare(String(b.key)),
    );
}

export async function mergeHandoffs(
  db: ScopedDb,
  store: DayStore,
  w: WindowDays,
): Promise<HandoffReasons> {
  const start = w.days[0] ?? "";
  const first = firstOf(store, "log.handoffs", start);
  const known = (c: string): c is HandoffCause =>
    (HANDOFF_CAUSES as readonly string[]).includes(c);
  const days: HandoffReasons["days"] = [];
  const totals = new Map<string, number>();
  const silences = new Map<string, number>();
  const silenceDays: HandoffReasons["silenceDays"] = [];
  const targets = new Map<string, number>();
  each<HandoffsDay>(store, "log.handoffs", w, (d, day) => {
    for (const [cause, n] of Object.entries(d.d)) {
      if (known(cause)) days.push({ date: day, cause, conversations: n });
    }
    for (const [reason, n] of Object.entries(d.s)) {
      silences.set(reason, (silences.get(reason) ?? 0) + n);
      silenceDays.push({ date: day, reason, turns: n });
    }
    for (const [cause, h] of Object.entries(d.t))
      totals.set(cause, (totals.get(cause) ?? 0) + countFirst(h, first));
    for (const [key, h] of Object.entries(d.g))
      targets.set(key, (targets.get(key) ?? 0) + countFirst(h, first));
  });
  const order = await pgOrder(db, [...silences.keys()]);
  days.sort(
    (a, b) => a.date.localeCompare(b.date) || a.cause.localeCompare(b.cause),
  );
  silenceDays.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (order.get(a.reason) ?? 0) - (order.get(b.reason) ?? 0),
  );
  const isTarget = (t: string): t is HandoffTarget =>
    (HANDOFF_TARGETS as readonly string[]).includes(t);
  return {
    days,
    totals: [...totals.entries()]
      .filter(([cause, n]) => known(cause) && n > 0)
      .map(([cause, conversations]) => ({
        cause: cause as HandoffCause,
        conversations,
      }))
      .sort(
        (a, b) =>
          b.conversations - a.conversations || a.cause.localeCompare(b.cause),
      ),
    silences: [...silences.entries()]
      .map(([reason, turns]) => ({ reason, turns }))
      .sort(
        (a, b) =>
          b.turns - a.turns ||
          (order.get(a.reason) ?? 0) - (order.get(b.reason) ?? 0),
      ),
    silenceDays,
    targets: [...targets.entries()]
      .filter(([, n]) => n > 0)
      .map(([key, conversations]) => {
        const [cause = "", target = ""] = key.split(SEP);
        return { cause, target, conversations };
      })
      .filter(
        (
          r,
        ): r is {
          cause: HandoffCause;
          target: HandoffTarget;
          conversations: number;
        } => known(r.cause) && isTarget(r.target),
      )
      .sort(
        (a, b) =>
          a.cause.localeCompare(b.cause) || a.target.localeCompare(b.target),
      ),
  };
}

export async function mergeHealth(
  store: DayStore,
  w: WindowDays,
): Promise<HealthReport> {
  const start = w.days[0] ?? "";
  const first = firstOf(store, "log.problems", start);
  const byModel = new Map<
    string,
    { day: string; h: { n: number; b: Record<string, number> } }[]
  >();
  each<LatencyDay>(store, "ledger.latency", w, (d, day) => {
    for (const [model, h] of Object.entries(d)) {
      const l = byModel.get(model) ?? [];
      l.push({ day, h });
      byModel.set(model, l);
    }
  });
  const latency: HealthReport["latency"] = [];
  for (const [model, hists] of byModel) {
    const [p50 = null, p90 = null] = await percentiles(
      store,
      LAT_CELL,
      hists,
      (cell) =>
        (cell as Record<string, Record<string, number>> | undefined)?.[model],
      [0.5, 0.9],
    );
    latency.push({
      model,
      calls: hists.reduce((s, x) => s + x.h.n, 0),
      p50Ms: p50,
      p90Ms: p90,
    });
  }
  latency.sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
  const problems = new Map<string, { lines: number; conversations: number }>();
  each<ProblemsDay>(store, "log.problems", w, (d) => {
    for (const [key, cell] of Object.entries(d)) {
      const p = problems.get(key) ?? { lines: 0, conversations: 0 };
      p.lines += cell.n;
      p.conversations += countFirst(cell.p, first);
      problems.set(key, p);
    }
  });
  return {
    latency,
    problems: [...problems.entries()]
      .map(([key, p]) => {
        const [stage = "", tool = NULL_KEY, level = ""] = key.split(SEP);
        return {
          stage,
          tool: tool === NULL_KEY ? null : tool,
          level: level === "error" ? ("error" as const) : ("warn" as const),
          lines: p.lines,
          conversations: p.conversations,
        };
      })
      .sort(
        (a, b) =>
          b.lines - a.lines ||
          a.stage.localeCompare(b.stage) ||
          String(a.tool).localeCompare(String(b.tool)) ||
          a.level.localeCompare(b.level),
      ),
  };
}

export function mergeFollowUps(
  store: DayStore,
  w: WindowDays,
): FollowUpActivity {
  const start = w.days[0] ?? "";
  const first = firstOf(store, "log.followups", start);
  let steps = 0;
  let conversations = 0;
  let cameBack = 0;
  let closed = 0;
  each<FollowupsDay>(store, "log.followups", w, (d) => {
    steps += d.s;
    for (const [prev, [n, came, cl]] of Object.entries(d.p)) {
      if (!first(prev)) continue;
      conversations += n;
      cameBack += came;
      closed += cl;
    }
  });
  return {
    stepsSent: steps,
    conversations,
    cameBack,
    closedByLastStep: closed,
  };
}

export function mergeKnowledge(
  store: DayStore,
  w: WindowDays,
): KnowledgeActivity {
  const by = new Map<string, number>();
  each<KnowledgeDay>(store, "know.knowledge", w, (d) => {
    for (const [status, n] of Object.entries(d))
      by.set(status, (by.get(status) ?? 0) + n);
  });
  const n = (...statuses: string[]) =>
    statuses.reduce((s, x) => s + (by.get(x) ?? 0), 0);
  return {
    proposed: [...by.values()].reduce((s, x) => s + x, 0),
    waiting: n("PENDING", "EDITED", "SCREENING"),
    discarded: n("DISCARDED"),
    approved: n("APPROVED"),
    rejected: n("REJECTED"),
  };
}
