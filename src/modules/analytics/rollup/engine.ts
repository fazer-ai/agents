import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import metricsPrisma from "@/api/lib/prisma-metrics";
import config from "@/config";
import { type AppError, MetricsTooSlowError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import {
  isOverMetricsBudget,
  metricsBudget,
  metricsDeadline,
  metricsTooSlow,
} from "../budget";
import type { DashboardFilter } from "../filter";
import { normalizeTimeZone } from "../service";
import {
  addDays,
  dayCount,
  dayStart,
  daysBetween,
  localDay,
  runsOf,
} from "./days";
import type { DayStore } from "./merge";
import {
  COMPUTE,
  FAMILIES,
  type Family,
  FR_CELL,
  familyOf,
  LAT_CELL,
  type Range,
  SECTIONS,
  type Section,
  type SectionRows,
} from "./sections";
import {
  changedSince,
  firstDataDay,
  type KeptRow,
  publishing,
  readKept,
  SETTLE_BATCH,
  settleDirty,
  tryLock,
  writeKept,
} from "./store";

// THE KEPT DAYS OF ONE DASHBOARD WINDOW (docs/dashboard.md, "Kept days"). A request reads what is
// kept for its filter and zone, computes today and yesterday live, and computes every other missing
// day in parts of at most PART_DAYS (30 days, 15 for the ledger), the most recent first, keeping each part as it finishes. A part
// runs on the metrics pool within METRICS_TIMEOUT_MS; one that does not fit is split in two and
// retried, down to a single day. Two requests for the same view take turns on an advisory lock and
// the second finds the first one's days kept instead of computing them again.

// The ledger is the widest family (several billed calls per conversation, five ways of counting each
// conversation once), so its parts are shorter to stay well inside the budget.
export const PART_DAYS: Record<Family, number> = {
  conv: 30,
  ledger: 15,
  log: 30,
  know: 30,
};
// Days whose figures still move: never kept, always computed.
const LIVE_DAYS = 2;
const DAY_MS = 86_400_000;
// How far before a part's start a change is assumed to have been invisible to its snapshot.
const SNAPSHOT_MARGIN_MS = 5 * 60_000;

export type Block =
  | "kpis"
  | "outcomes"
  | "costs"
  | "breakdown"
  | "handoffs"
  | "labels"
  | "health"
  | "followUps"
  | "knowledge";

export const BLOCK_SECTIONS: Record<Block, Section[]> = {
  kpis: ["conv.funnel"],
  outcomes: ["conv.funnel", "conv.series"],
  costs: ["ledger.costs"],
  breakdown: ["ledger.breakdown"],
  handoffs: ["log.handoffs"],
  labels: ["conv.labels"],
  health: ["ledger.latency", "log.problems"],
  followUps: ["log.followups"],
  knowledge: ["know.knowledge"],
};

let versionCache: string | null = null;

// A hash of every statement the sections run, with their values, on a fixed filter: a release that
// changes what a figure means changes it, and stops reading what was kept before.
export async function rollupVersion(): Promise<string> {
  if (versionCache) return versionCache;
  const seen: string[] = [];
  const recorder = {
    $queryRaw: async (sql: Prisma.Sql) => {
      seen.push(
        sql.sql,
        JSON.stringify(sql.values, (_k, v) =>
          typeof v === "bigint" ? String(v) : v,
        ),
      );
      return [];
    },
  } as unknown as ScopedDb;
  const range: Range = {
    first: "2000-01-01",
    last: "2000-01-02",
    since: new Date("2000-01-01T00:00:00Z"),
    until: new Date("2000-01-03T00:00:00Z"),
  };
  const f: DashboardFilter = { agentId: 1n, inboxId: 1n, source: "inbox" };
  for (const fam of FAMILIES)
    await COMPUTE[fam](recorder, new Set(SECTIONS), f, "UTC", range, new Map());
  versionCache = createHash("sha256")
    .update(seen.join("\n"))
    .digest("hex")
    .slice(0, 16);
  return versionCache;
}

export function filterKey(f: DashboardFilter): string {
  return `${f.source ?? ""}|${f.agentId ?? ""}|${f.inboxId ?? ""}`;
}

// The local days a filter's window covers, when it starts and ends on local midnights of its zone.
// Null when it does not: such a window is answered by the live readers, which take any instant.
export function alignedDays(
  f: DashboardFilter,
): { tz: string; first: string | null; last: string | null } | null {
  const tz = normalizeTimeZone(f.tz);
  let first: string | null = null;
  let last: string | null = null;
  if (f.since) {
    first = localDay(f.since, tz);
    if (dayStart(first, tz).getTime() !== f.since.getTime()) return null;
  }
  if (f.until) {
    const end = localDay(f.until, tz);
    if (dayStart(end, tz).getTime() !== f.until.getTime()) return null;
    last = addDays(end, -1);
  }
  return { tz, first, last };
}

// The section whose histogram a percentile's value cells belong to.
const CELL_PARENT: Record<string, Section> = {
  [FR_CELL]: "conv.funnel",
  [LAT_CELL]: "ledger.latency",
};

// A kept day whose value cells were dropped or recomputed after its histogram was read: the day has
// been computed again in memory, and the figures that used the old histogram are merged again.
export class StaleDayError extends Error {
  constructor(readonly days: string[]) {
    super(`kept days changed while being read: ${days.join(", ")}`);
  }
}

export interface Coverage {
  // Days of the window, days whose figures are in, and flow-log days nothing can fill any more.
  total: number;
  ready: number;
  noData: number;
  // The days without figures yet or for good, as inclusive runs: a chart leaves them blank.
  gaps: [string, string][];
  // Of those, the days with no figures for good (flow-log days the retention sweep emptied before
  // they were kept), which a chart marks apart from the days still loading.
  none?: [string, string][];
  // Why the family stopped, when a day of it did not fit: its blocks say so, the others go on.
  refused?: { status: number; field?: string };
}

export interface Progress {
  total: number;
  ready: number;
  // The days being computed now, and the ranges still waiting, most recent first.
  computing: [string, string] | null;
  pending: [string, string][];
  families: Record<Family, Coverage>;
  // The window's first listed day: a chart draws its axis from it from the first snapshot on, so the
  // axis of a whole-history window does not move as older parts arrive.
  first?: string | null;
  // Each requested flow-log section on its own: past retention, one may be kept and another not.
  sections?: Partial<Record<Section, Coverage>>;
}

interface Part {
  family: Family;
  first: string;
  last: string;
  live: boolean;
}

// One transaction of the kept days on its own METRICS_TIMEOUT_MS, refused as too slow past it. Each
// part gets the whole budget: a long window is many parts, never one long statement. A caller that
// answers once also passes its own deadline, and no part runs past it.
export async function budgeted<T>(
  base: PrismaClient,
  ctx: TenantContext,
  fn: (db: ScopedDb) => Promise<T>,
  until = Number.POSITIVE_INFINITY,
): Promise<T> {
  const deadline = Math.min(Date.now() + config.metrics.timeoutMs, until);
  try {
    return await runScopedOn(base, ctx, fn, metricsBudget(deadline));
  } catch (error) {
    if (isOverMetricsBudget(error)) throw metricsTooSlow(deadline);
    throw error;
  }
}

export class WindowLoad implements DayStore {
  readonly tz: string;
  days: string[] = [];
  private rows: SectionRows = new Map();
  // When each kept (section, day) read from the store was computed, and the (family, day) pairs whose
  // value cells are all in memory because this request computed them.
  private stamps = new Map<string, string>();
  private whole = new Set<string>();
  private sections: Set<Section>;
  private families: Family[];
  private version = "";
  private key = "";
  private dataFrom: string | null = null;
  private logFrom = "";
  private logKeepFrom = "";
  // The window's days before the tenant's first record, and how many of them are flow-log days the
  // sweep may have emptied.
  private before: { first: string; last: string } | null = null;
  private beforeCount = 0;
  private beforeNoData = 0;
  private refused = new Map<Family, AppError>();
  private queue: Part[] = [];
  private current: Part | null = null;
  // The one deadline of a caller that answers once (`complete`), counted from its request's arrival
  // and shared by the merge after it (`figuresOf`); a stream has none, and each part its own budget.
  deadline = Number.POSITIVE_INFINITY;
  private base: PrismaClient;
  private window: { tz: string; first: string | null; last: string | null };

  constructor(
    private ctx: TenantContext,
    private filter: DashboardFilter,
    sections: Section[],
    window: { tz: string; first: string | null; last: string | null },
    base: PrismaClient = metricsPrisma,
  ) {
    this.tz = window.tz;
    this.sections = new Set(sections);
    this.families = FAMILIES.filter((fam) =>
      sections.some((s) => familyOf(s) === fam),
    );
    this.base = base;
    this.window = window;
  }

  private settleKey(): string {
    return `dashboard-settle|${this.ctx.tenantId}`;
  }

  private scoped<T>(fn: (db: ScopedDb) => Promise<T>): Promise<T> {
    return budgeted(this.base, this.ctx, fn, this.deadline);
  }

  // Past the caller's own deadline nothing is cut smaller or tried again: the whole request is refused.
  private overdue(): boolean {
    return Date.now() >= this.deadline;
  }

  private sectionsOf(fam: Family): Section[] {
    return [...this.sections].filter((s) => familyOf(s) === fam);
  }

  get(section: Section, day: string): unknown {
    return this.rows.get(section)?.get(day);
  }

  // Whether a family's day is in: every requested section of it, or the one given. Days are computed
  // a family at a time, but a flow-log day past retention keeps only the sections some request kept
  // before the sweep, so each of its blocks is in or out on its own section.
  private has(fam: Family, day: string, only?: Section): boolean {
    return (only ? [only] : this.sectionsOf(fam)).every((s) =>
      this.rows.get(s)?.has(day),
    );
  }

  private keepRead(r: KeptRow) {
    this.keep(r.section, r.day, r.data);
    if (r.at !== undefined) this.stamps.set(`${r.section}|${r.day}`, r.at);
  }

  private keep(section: string, day: string, data: unknown) {
    let m = this.rows.get(section);
    if (!m) {
      m = new Map();
      this.rows.set(section, m);
    }
    m.set(day, data);
  }

  // This window's days read through `db`, a transaction the caller already holds: a read that opened
  // its own while holding one could wait on the pool for a connection that only it would release.
  on(db: ScopedDb): DayStore {
    return {
      get: (section, day) => this.get(section as Section, day),
      cells: (prefix, buckets, days) => this.cells(prefix, buckets, days, db),
    };
  }

  async cells(
    prefix: string,
    buckets: number[],
    days: string[],
    db?: ScopedDb,
  ) {
    const out = new Map<string, Map<number, unknown>>();
    const missing = new Set<string>();
    const parent = CELL_PARENT[prefix];
    const fam = parent ? familyOf(parent) : null;
    for (const day of days)
      for (const b of buckets) {
        const v = this.rows.get(`${prefix}${b}`)?.get(day);
        if (v !== undefined) {
          if (!out.has(day)) out.set(day, new Map());
          out.get(day)?.set(b, v);
        } else if (!this.whole.has(`${fam}|${day}`)) missing.add(day);
      }
    if (missing.size === 0) return out;
    // The cells and the histogram they belong to, from the same computation: a day another request
    // dropped or computed again since its histogram was read is computed again here, whole.
    const run = async (tx: ScopedDb) => {
      const rows = await readKept(
        tx,
        { version: this.version, filterKey: this.key, tz: this.tz },
        [...buckets.map((b) => `${prefix}${b}`), ...(parent ? [parent] : [])],
        [...missing],
      );
      const stale = new Set<string>();
      if (parent && fam) {
        const seen = new Set<string>();
        for (const r of rows) {
          if (r.section === parent) seen.add(r.day);
          if (r.at !== this.stamps.get(`${parent}|${r.day}`)) stale.add(r.day);
        }
        for (const day of missing) if (!seen.has(day)) stale.add(day);
        // Read live, whatever becomes of this transaction: in memory at once.
        for (const day of stale)
          (
            await this.compute(
              tx,
              { family: fam, first: day, last: day, live: true },
              false,
            )
          )();
      }
      return { rows: rows.filter((r) => !stale.has(r.day)), stale };
    };
    const { rows, stale } = db ? await run(db) : await this.scoped(run);
    if (stale.size > 0) throw new StaleDayError([...stale].sort());
    for (const r of rows) {
      if (r.section === parent) continue;
      this.keep(r.section, r.day, r.data);
      const b = Number(r.section.slice(prefix.length));
      if (!out.has(r.day)) out.set(r.day, new Map());
      out.get(r.day)?.set(b, r.data);
    }
    return out;
  }

  // Settle what changed, find the window's days, read what is kept, and queue the rest.
  // Stops scheduling more once `signal` aborts (the viewer left): a batch or a part already running
  // finishes, and the caller drops the load.
  async prepare(signal?: AbortSignal) {
    this.version = await rollupVersion();
    this.key = filterKey(this.filter);
    const today = localDay(Date.now(), this.tz);
    // Every pending change, not one batch, each batch committed on its own: a day the rest reach would
    // otherwise read as kept, and a backlog longer than one budget still drains across requests.
    // A batch that does not fit the budget is cut to a quarter and tried again: each one that fits
    // commits, so the queue moves whatever its length, and nothing is read before it is empty.
    for (let batch = SETTLE_BATCH; ; ) {
      if (signal?.aborted) return;
      let settled: number;
      try {
        settled = await this.scoped((db) =>
          settleDirty(db, this.settleKey(), batch),
        );
      } catch (error) {
        if (
          !(error instanceof MetricsTooSlowError) ||
          batch === 1 ||
          this.overdue()
        )
          throw error;
        batch = Math.max(1, Math.floor(batch / 4));
        continue;
      }
      if (settled < batch) break;
    }
    await this.scoped(async (db) => {
      this.dataFrom = await firstDataDay(db, this.tz, {
        version: this.version,
        filterKey: this.key,
      });
      const first = this.window.first ?? this.dataFrom ?? today;
      const last =
        this.window.last && this.window.last < today ? this.window.last : today;
      // Days before the tenant's first record hold nothing: counted, never listed, since a window
      // may start centuries back.
      const held = this.dataFrom ?? addDays(last, 1);
      const from = first < held ? held : first;
      const beforeLast = held <= last ? addDays(held, -1) : last;
      this.before = first < held ? { first, last: beforeLast } : null;
      this.days = from <= last ? daysBetween(from, last) : [];
    });
    // Today and yesterday, and any day that ended less than 24 hours ago (the day before yesterday,
    // just after a clock moves forward): the triggers queue nothing younger than that.
    const lastLive = addDays(today, -(LIVE_DAYS - 1));
    const ended = this.days.find(
      (d) => dayStart(addDays(d, 1), this.tz).getTime() > Date.now() - DAY_MS,
    );
    const liveFrom = ended && ended < lastLive ? ended : lastLive;
    const cutoff = Date.now() - config.flowlog.retentionDays * 86_400_000;
    // The day the retention cutoff falls in still has its later lines: it is computed, as the live
    // reader would read it, and never kept, since the sweep is still emptying it.
    this.logFrom =
      this.days.find(
        (d) => dayStart(addDays(d, 1), this.tz).getTime() > cutoff,
      ) ?? addDays(today, 1);
    this.logKeepFrom =
      this.days.find((d) => dayStart(d, this.tz).getTime() >= cutoff) ??
      addDays(today, 1);
    // Of those days before, the flow log's past retention may have had lines swept since: no data,
    // never zero. The rest are empty, and ready.
    this.beforeCount = this.before
      ? dayCount(this.before.first, this.before.last)
      : 0;
    const cutDay = localDay(cutoff, this.tz);
    this.beforeNoData = this.before
      ? dayCount(
          this.before.first,
          this.before.last < cutDay ? this.before.last : addDays(cutDay, -1),
        )
      : 0;
    // Today and yesterday, and the flow log's day the retention cutoff falls in, are never kept: they
    // are computed while the kept days are read, side by side, so a view already kept is whole at
    // its first snapshot.
    const eager: Part[] = [];
    const live = this.days.filter((d) => d >= liveFrom);
    const [liveFirst, liveLast] = [live[0], live[live.length - 1]];
    if (liveFirst && liveLast)
      for (const fam of this.families)
        eager.push({
          family: fam,
          first: liveFirst,
          last: liveLast,
          live: true,
        });
    const cut = this.families.includes("log")
      ? this.days.filter(
          (d) => d >= this.logFrom && d < this.logKeepFrom && d < liveFrom,
        )
      : [];
    const [cutFirst, cutLast] = [cut[0], cut[cut.length - 1]];
    if (cutFirst && cutLast)
      eager.push({ family: "log", first: cutFirst, last: cutLast, live: true });
    const liveDays = new Set(live);
    const cutDays = new Set(cut);
    const reading = this.scoped(async (db) => {
      const kept = await readKept(
        db,
        { version: this.version, filterKey: this.key, tz: this.tz },
        [...this.sections],
        this.days.filter((d) => !liveDays.has(d)),
      );
      // The cutoff's day is computed for the flow log only; the other families read it as kept.
      return () => {
        for (const r of kept)
          if (!(cutDays.has(r.day) && familyOf(r.section) === "log"))
            this.keepRead(r);
      };
    });
    // One connection reads, two compute: the metrics pool is small and the previous period's stream
    // shares it.
    const computing = (async () => {
      for (let i = 0; i < eager.length && !signal?.aborted; i += 2)
        await Promise.all(
          eager.slice(i, i + 2).map((p) => this.runFamilyPart(p, signal)),
        );
    })();
    const [keep] = await Promise.all([reading, computing]);
    keep();
    const parts: Part[] = [];
    const stored = this.days.filter((d) => d < liveFrom).reverse();
    const chunks: { fam: Family; first: string; last: string }[] = [];
    for (const fam of this.families) {
      const missing = stored.filter(
        (d) => !this.has(fam, d) && (fam !== "log" || d >= this.logFrom),
      );
      for (const [a, b] of runsOf(missing)) {
        const size = PART_DAYS[fam];
        for (let end = b; end >= a; end = addDays(end, -size)) {
          const start =
            addDays(end, -(size - 1)) < a ? a : addDays(end, -(size - 1));
          chunks.push({ fam, first: start, last: end });
        }
      }
    }
    chunks.sort((x, y) =>
      x.last === y.last
        ? FAMILIES.indexOf(x.fam) - FAMILIES.indexOf(y.fam)
        : x.last < y.last
          ? 1
          : -1,
    );
    for (const c of chunks)
      if (!this.refused.has(c.fam))
        parts.push({
          family: c.fam,
          first: c.first,
          last: c.last,
          live: false,
        });
    this.queue = parts;
  }

  progress(): Progress {
    const families = {} as Record<Family, Coverage>;
    const total = this.days.length + this.beforeCount;
    let ready = total;
    for (const fam of FAMILIES) {
      if (!this.families.includes(fam)) {
        families[fam] = { total, ready: total, noData: 0, gaps: [], none: [] };
        continue;
      }
      families[fam] = this.coverage(fam);
      ready = Math.min(ready, families[fam].ready + families[fam].noData);
    }
    const sections: Progress["sections"] = {};
    for (const s of this.sectionsOf("log"))
      sections[s] = this.coverage("log", s);
    const pending = runsOfParts(this.queue.filter((p) => !p.live));
    return {
      total,
      ready,
      computing: this.current ? [this.current.first, this.current.last] : null,
      pending,
      families,
      first: this.days[0] ?? null,
      sections,
    };
  }

  private coverage(fam: Family, only?: Section): Coverage {
    const total = this.days.length + this.beforeCount;
    const gone = fam === "log" ? this.beforeNoData : 0;
    let r = this.beforeCount - gone;
    let lost = gone;
    for (const d of this.days) {
      if (this.has(fam, d, only)) r++;
      else if (fam === "log" && d < this.logFrom) lost++;
    }
    const gaps = runsOf(this.days.filter((d) => !this.has(fam, d, only)));
    const none = runsOf(
      this.days.filter(
        (d) => fam === "log" && d < this.logFrom && !this.has(fam, d, only),
      ),
    );
    if (gone > 0 && this.before) {
      const run: [string, string] = [
        this.before.first,
        addDays(this.before.first, gone - 1),
      ];
      gaps.unshift(run);
      none.unshift([...run]);
    }
    const refused = this.refused.get(fam);
    return {
      total,
      ready: r,
      noData: lost,
      gaps,
      none,
      ...(refused
        ? {
            refused: {
              status: refused.statusCode,
              ...(refused.field ? { field: refused.field } : {}),
            },
          }
        : {}),
    };
  }

  done(): boolean {
    return this.queue.length === 0;
  }

  // The days a family's figures that count each conversation once can be merged over. A conversation
  // is counted on its first day in the window, which a day still missing may be: so the whole window
  // once the family is in, while it fills the run of days in that ends on the window's last day (the
  // order parts are computed in), and null when what is in is not such a run. Days before the
  // tenant's first record, and flow-log days nothing can fill, hold no conversation and count as in.
  // With `only`, the days of that one section, which a flow-log block's coverage reports on its own.
  countable(fam: Family, only?: Section): string[] | null {
    if (!this.families.includes(fam)) return this.days;
    const held = (d: string) =>
      this.dataFrom === null ||
      d < this.dataFrom ||
      (fam === "log" && d < this.logFrom && !this.has(fam, d, only));
    const days = this.days.filter((d) => !held(d));
    let i = days.length - 1;
    while (i >= 0 && this.has(fam, days[i] as string, only)) i--;
    if (i < 0) return this.days;
    if (days.some((d, j) => j < i && this.has(fam, d, only))) return null;
    const run = days.slice(i + 1);
    return run.length > 0 ? run : null;
  }

  // The days the next step computes.
  next(): [string, string] | null {
    const part = this.queue[0];
    return part ? [part.first, part.last] : null;
  }

  // Compute the next part. Returns false when nothing is left.
  // Stops waiting for a part another request is computing once `signal` aborts.
  async step(signal?: AbortSignal): Promise<boolean> {
    const part = this.queue[0];
    if (!part) return false;
    // Today and yesterday of every family in one step, side by side: they are small, and they are
    // what a second opening of the same view still waits for.
    const parts = part.live ? this.queue.filter((p) => p.live) : [part];
    this.queue = this.queue.filter((p) => !parts.includes(p));
    this.current = part;
    try {
      // Two at a time: the metrics pool is small and the previous period's stream shares it.
      for (let i = 0; i < parts.length; i += 2)
        await Promise.all(
          parts.slice(i, i + 2).map((p) => this.runFamilyPart(p, signal)),
        );
    } finally {
      this.current = null;
    }
    return true;
  }

  // A single day past the budget stops its family, not the others. Any other refusal (the tenant
  // gone, say) is the whole request's.
  private async runFamilyPart(part: Part, signal?: AbortSignal) {
    try {
      await this.runPart(part, signal);
    } catch (error) {
      if (!(error instanceof MetricsTooSlowError) || this.overdue())
        throw error;
      this.refused.set(part.family, error);
      this.queue = this.queue.filter((p) => p.family !== part.family);
    }
  }

  private async runPart(part: Part, signal?: AbortSignal): Promise<void> {
    try {
      if (part.live)
        (await this.scoped((db) => this.compute(db, part, false)))();
      else await this.computeKept(part, signal);
    } catch (error) {
      // A viewer who left gets no half started in its place.
      if (error instanceof MetricsTooSlowError && signal?.aborted) return;
      if (
        !(error instanceof MetricsTooSlowError) ||
        part.first === part.last ||
        this.overdue()
      )
        throw error;
      const days = daysBetween(part.first, part.last);
      const mid = days[Math.floor(days.length / 2)] ?? part.last;
      // The later half first, as every part goes.
      await this.runPart({ ...part, first: mid, last: part.last }, signal);
      await this.runPart(
        { ...part, first: part.first, last: addDays(mid, -1) },
        signal,
      );
    }
  }

  private async computeKept(part: Part, signal?: AbortSignal) {
    const lockKey = `dashboard|${this.ctx.tenantId}|${this.version}|${this.key}|${this.tz}|${part.family}`;
    for (;;) {
      if (signal?.aborted) return;
      const state = await this.scoped(async (db) => {
        if (!(await tryLock(db, lockKey))) return "busy" as const;
        const days = daysBetween(part.first, part.last);
        const kept = await readKept(
          db,
          { version: this.version, filterKey: this.key, tz: this.tz },
          this.sectionsOf(part.family),
          days,
        );
        for (const r of kept) this.keepRead(r);
        const missing = days.filter((d) => !this.has(part.family, d));
        const [first, last] = [missing[0], missing[missing.length - 1]];
        if (!first || !last) return () => {};
        return this.compute(db, { ...part, first, last }, true);
      });
      // In memory once kept: a part whose transaction fails is computed again, and kept, on the retry.
      if (state !== "busy") return state();
      if (this.overdue()) throw metricsTooSlow(this.deadline);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // Computes the part, keeps it when `store`, and returns what puts it in memory, for the caller to
  // run once the transaction has committed.
  private async compute(
    db: ScopedDb,
    part: Part,
    store: boolean,
  ): Promise<() => void> {
    const startedAt = Date.now();
    // When the part began by the database's clock, the one a settling batch stamps its rows with.
    const [began] = store
      ? await db.$queryRaw<{ t: Date }[]>(
          Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS t`,
        )
      : [];
    const range: Range = {
      first: part.first,
      last: part.last,
      since: dayStart(part.first, this.tz),
      until: dayStart(addDays(part.last, 1), this.tz),
    };
    const out: SectionRows = new Map();
    const wanted = new Set(this.sectionsOf(part.family));
    await COMPUTE[part.family](db, wanted, this.filter, this.tz, range, out);
    const days = daysBetween(part.first, part.last);
    for (const s of wanted) {
      const m = out.get(s) ?? new Map();
      for (const d of days) if (!m.has(d)) m.set(d, emptyOf(s));
      out.set(s, m);
    }
    const rows: { section: string; day: string; data: unknown }[] = [];
    for (const [section, m] of out)
      for (const [day, data] of m) rows.push({ section, day, data });
    const apply = () => {
      // A day computed again replaces every cell it had, not only the ones the new computation has.
      for (const [section, m] of this.rows)
        if (familyOf(section) === part.family)
          for (const d of days) m.delete(d);
      for (const r of rows) this.keep(r.section, r.day, r.data);
      for (const d of days) {
        this.whole.add(`${part.family}|${d}`);
        for (const s of this.rows.keys())
          if (familyOf(s) === part.family) this.stamps.delete(`${s}|${d}`);
      }
    };
    if (!store || this.ctx.tenantId === null) return apply;
    // Held until this part commits: a batch settling a change that commits after the check below
    // waits for these rows to be visible, and drops them.
    await publishing(db, this.settleKey());
    const changed = await changedSince(
      db,
      new Date(startedAt - SNAPSHOT_MARGIN_MS),
      this.tz,
      part.family,
      began?.t ?? new Date(startedAt),
    );
    const keepable = rows.filter(
      (r) =>
        !changed.has(`${part.family}|${r.day}`) &&
        !(part.family === "log" && r.day < this.logKeepFrom) &&
        !(part.family === "conv" && changed.has("conv-all")),
    );
    await writeKept(
      db,
      {
        tenantId: this.ctx.tenantId,
        version: this.version,
        filterKey: this.key,
        tz: this.tz,
      },
      keepable,
    );
    return apply;
  }

  // Compute every part, for a caller that answers once (the REST routes, the MCP tools), within one
  // METRICS_TIMEOUT_MS for the whole request: nothing reaches the caller until every part is in, so
  // a cold window longer than that is refused as too slow, with the parts already kept for the next
  // call to read. A caller that goes away (`signal`) stops it at the next part or batch.
  async complete(signal?: AbortSignal): Promise<this> {
    this.deadline = metricsDeadline();
    try {
      await this.prepare(signal);
      while (!signal?.aborted && (await this.step(signal)));
    } catch (error) {
      if (error instanceof MetricsTooSlowError && this.overdue())
        throw metricsTooSlow(this.deadline);
      throw error;
    }
    signal?.throwIfAborted();
    // One answer for the caller's blocks: a family that stopped refuses it.
    const [refused] = this.refused.values();
    if (refused) throw refused;
    return this;
  }
}

function runsOfParts(parts: Part[]): [string, string][] {
  const days = new Set<string>();
  for (const p of parts)
    for (const d of daysBetween(p.first, p.last)) days.add(d);
  return runsOf([...days]).reverse();
}

export function emptyOf(section: string): unknown {
  switch (section as Section) {
    case "conv.funnel":
      return { c: null, fr: { n: 0, b: {} } };
    case "conv.series":
      return { agent: {}, inbox: {} };
    case "conv.labels":
      return { l: {}, u: 0 };
    case "ledger.costs":
      return { d: null, req: 0, pt: 0, ct: 0, m: {}, bm: {}, bn: {}, p: {} };
    case "ledger.breakdown":
      return { agent: {}, inbox: {}, model: {}, node: {} };
    case "log.handoffs":
      return { d: {}, s: {}, t: {}, g: {} };
    case "log.followups":
      return { s: 0, p: {} };
    default:
      return {};
  }
}

// The window of a request that the kept days can answer, or null for one the live readers answer.
export async function loadAligned(
  ctx: TenantContext,
  filter: DashboardFilter,
  sections: Section[],
  base?: PrismaClient,
  signal?: AbortSignal,
): Promise<WindowLoad | null> {
  const w = alignedDays(filter);
  if (!w) return null;
  return new WindowLoad(ctx, filter, sections, w, base).complete(signal);
}
