import { CLIENT_AUDIENCES } from "@/graph/usage-sources";
import {
  CALENDAR_PRESETS,
  type CalendarPreset,
  type CalendarUnit,
  isCalendarPreset,
  presetDays,
  presetRunning,
  presetUnit,
  previousStop,
} from "@/modules/analytics/calendar";
import { type Grain, groupOf, periodWindow } from "./period";

// THE PAGE'S ONE FILTER, IN THE URL. Period, agent, inbox and source live in the query string, so a
// view can be shared as a link and Back returns to the previous view. Every block reads the window
// computed here, in the operator's own days (docs/ui.md, "A day is defined by the viewer's browser
// timezone"). A trailing window is compared with the same number of days immediately before it, a
// calendar period with the calendar period before it (src/modules/analytics/calendar.ts).

export const TRAILING_RANGES = ["7d", "30d", "90d", "12m", "all"] as const;
export const RANGES = [
  ...CALENDAR_PRESETS,
  ...TRAILING_RANGES,
  "custom",
] as const;
export type Range = (typeof RANGES)[number];
export const SOURCES = ["inbox", "playground", "client", "all"] as const;
export type Source = (typeof SOURCES)[number];
// Who the client channel served, a refinement of the client segment only.
export const AUDIENCES = ["all", ...CLIENT_AUDIENCES] as const;
export type Audience = (typeof AUDIENCES)[number];

const RANGE_DAYS: Record<
  Exclude<(typeof TRAILING_RANGES)[number], "all">,
  number
> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "12m": 365,
};

export interface DashboardFilters {
  range: Range;
  // Local days, inclusive, `YYYY-MM-DD`. Set only for a custom range.
  from: string | null;
  to: string | null;
  agentId: string | null;
  inboxId: string | null;
  source: Source;
  // Read and sent only under the client segment; anywhere else it is "all".
  audience: Audience;
}

export const DEFAULT_FILTERS: DashboardFilters = {
  range: "30d",
  from: null,
  to: null,
  agentId: null,
  inboxId: null,
  source: "inbox",
  audience: "all",
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^\d{1,19}$/;

// The years a custom day may name: no record predates the first, and a range inside them has a
// previous period whose days all keep four-digit years, which the date arithmetic below needs.
export const FIRST_CUSTOM_DAY = "1970-01-01";
const LAST_CUSTOM_YEAR = 2100;

export function validDay(s: string | null): s is string {
  if (!s || !DAY.test(s)) return false;
  const year = Number(s.split("-")[0]);
  if (year < Number(FIRST_CUSTOM_DAY.split("-")[0]) || year > LAST_CUSTOM_YEAR)
    return false;
  const d = new Date(`${s}T00:00:00`);
  return !Number.isNaN(d.getTime()) && localDayKey(d) === s;
}

// Read the filters from the query string. Whatever does not parse falls back to its default rather
// than reaching the API: a hand-edited link opens on a valid view, never on an error page.
export function readFilters(params: URLSearchParams): DashboardFilters {
  const range = params.get("range");
  const source = params.get("source");
  const from = params.get("from");
  const to = params.get("to");
  const agent = params.get("agent");
  const inbox = params.get("inbox");
  const audience = params.get("audience");
  const custom =
    range === "custom" && validDay(from) && validDay(to) && from <= to;
  const segment = (SOURCES as readonly string[]).includes(source ?? "")
    ? (source as Source)
    : DEFAULT_FILTERS.source;
  return {
    range: custom
      ? "custom"
      : (RANGES as readonly string[]).includes(range ?? "") &&
          range !== "custom"
        ? (range as Range)
        : DEFAULT_FILTERS.range,
    from: custom ? from : null,
    to: custom ? to : null,
    agentId: agent && ID.test(agent) ? agent : null,
    inboxId: inbox && ID.test(inbox) ? inbox : null,
    source: segment,
    audience:
      segment === "client" &&
      (AUDIENCES as readonly string[]).includes(audience ?? "")
        ? (audience as Audience)
        : DEFAULT_FILTERS.audience,
  };
}

// The query string for a set of filters. A value at its default is left out, so the plain page has
// a plain URL and "all agents" is the absence of the parameter.
export function writeFilters(f: DashboardFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.range !== DEFAULT_FILTERS.range) p.set("range", f.range);
  if (f.range === "custom" && f.from && f.to) {
    p.set("from", f.from);
    p.set("to", f.to);
  }
  if (f.agentId) p.set("agent", f.agentId);
  if (f.inboxId) p.set("inbox", f.inboxId);
  if (f.source !== DEFAULT_FILTERS.source) p.set("source", f.source);
  if (f.source === "client" && f.audience !== DEFAULT_FILTERS.audience)
    p.set("audience", f.audience);
  return p;
}

// The filters that narrow the view, in the band's order: a chip each. A filter at its default, or at
// a value that narrows nothing (every agent, every inbox, every source), is none, and the audience
// counts only under the client segment it refines.
export type NarrowingFilter = "agent" | "inbox" | "source" | "audience";
export function narrowingFilters(f: DashboardFilters): NarrowingFilter[] {
  const out: NarrowingFilter[] = [];
  if (f.agentId) out.push("agent");
  if (f.inboxId) out.push("inbox");
  if (f.source === "playground" || f.source === "client") out.push("source");
  if (f.source === "client" && f.audience !== DEFAULT_FILTERS.audience)
    out.push("audience");
  return out;
}

// Local day key (YYYY-MM-DD) of a Date in the browser's zone.
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfLocalDay(key: string): Date {
  return new Date(`${key}T00:00:00`);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export interface Window {
  // Instants, half-open [since, until). `since` null for "all".
  since: Date | null;
  until: Date;
  // The local days the window covers, first and last inclusive; null first day for "all".
  firstDay: string | null;
  lastDay: string;
  days: number | null;
  // A calendar period: the unit its previous period is one of.
  unit?: CalendarUnit;
}

function dayCountOf(first: string, last: string): number {
  return (
    Math.round(
      (Date.UTC(ymd(last)[0], ymd(last)[1], ymd(last)[2]) -
        Date.UTC(ymd(first)[0], ymd(first)[1], ymd(first)[2])) /
        86_400_000,
    ) + 1
  );
}

function ymd(day: string): [number, number, number] {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return [y, m - 1, d];
}

// A preset that is still under way where `now` is: today, this week, this month, this quarter, this
// year. The page says so beside the selector.
export function rangeRunning(range: Range): boolean {
  return isCalendarPreset(range) && presetRunning(range);
}

// How far a running calendar preset has gone at `now`: the day it is on, out of the days it holds, and
// the share of it already past, counting today's elapsed hours. Null for any other range.
export function periodProgress(
  range: Range,
  now: Date = new Date(),
): { day: number; total: number; fraction: number } | null {
  if (!rangeRunning(range) || !isCalendarPreset(range)) return null;
  const today = localDayKey(now);
  const { first, end } = presetDays(range, today);
  const total = dayCountOf(first, end) - 1;
  const day = dayCountOf(first, today);
  const midnight = startOfLocalDay(today).getTime();
  const dayLength = addDays(startOfLocalDay(today), 1).getTime() - midnight;
  const sinceMidnight = now.getTime() - midnight;
  const done = day - 1 + sinceMidnight / dayLength;
  const fraction = done / total;
  return { day, total, fraction: Math.min(1, Math.max(0, fraction)) };
}

// The local days a window's figures are read over, as the screen names them: they end inside a day when
// the window is cut at the read's time of day (`partial`), else on the day before its exclusive end.
// Null for no window, all time, or an empty one (the first instant of a running period).
export function daysRead(
  prev: Window | null,
): { first: string; last: string; partial: boolean } | null {
  if (!prev?.firstDay || !prev.since || prev.until <= prev.since) return null;
  const untilDay = localDayKey(prev.until);
  const partial = prev.until.getTime() > startOfLocalDay(untilDay).getTime();
  return {
    first: prev.firstDay,
    last: partial ? untilDay : localDayKey(new Date(prev.until.getTime() - 1)),
    partial,
  };
}

// The window a set of filters names, at `now`. A preset ends today and covers N local days; a custom
// range covers its two days inclusive.
export function windowOf(f: DashboardFilters, now: Date = new Date()): Window {
  if (f.range === "custom" && f.from && f.to) {
    const since = startOfLocalDay(f.from);
    const until = addDays(startOfLocalDay(f.to), 1);
    const days = Math.round((until.getTime() - since.getTime()) / 86_400_000);
    return { since, until, firstDay: f.from, lastDay: f.to, days };
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const until = addDays(today, 1);
  if (isCalendarPreset(f.range)) return calendarWindow(f.range, today);
  if (f.range === "all") {
    return {
      since: null,
      until,
      firstDay: null,
      lastDay: localDayKey(today),
      days: null,
    };
  }
  const n = RANGE_DAYS[f.range as keyof typeof RANGE_DAYS];
  const since = addDays(today, -(n - 1));
  return {
    since,
    until,
    firstDay: localDayKey(since),
    lastDay: localDayKey(today),
    days: n,
  };
}

// A calendar preset on the local day `today`. A running one ends after today, like a trailing window,
// and is read up to the moment of the read (`readUpTo`); a closed one ends at the midnight after its
// last day.
function calendarWindow(p: CalendarPreset, today: Date): Window {
  const { first, end } = presetDays(p, localDayKey(today));
  const lastDay = presetRunning(p)
    ? localDayKey(today)
    : localDayKey(addDays(startOfLocalDay(end), -1));
  return {
    since: startOfLocalDay(first),
    until: addDays(startOfLocalDay(lastDay), 1),
    firstDay: first,
    lastDay,
    days: dayCountOf(first, lastDay),
    unit: presetUnit(p),
  };
}

// `now`'s time of day on the local day `day`. A time the day skips (the hour a clock jumps over)
// is the instant the clock jumps to, not the time an hour later the Date constructor gives: the cut
// never moves back as the read moves on, and one skipped at the day's end stays out of the next day.
function wallClockOn(day: string, now: Date): Date {
  const [y, m, d] = ymd(day);
  const at = new Date(
    y,
    m,
    d,
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds(),
  );
  const asked = Date.UTC(
    y,
    m,
    d,
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds(),
  );
  const got = Date.UTC(
    at.getFullYear(),
    at.getMonth(),
    at.getDate(),
    at.getHours(),
    at.getMinutes(),
    at.getSeconds(),
    at.getMilliseconds(),
  );
  if (got === asked) return at;
  let lo = at.getTime() - (got - asked);
  let hi = at.getTime();
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (new Date(mid).getTimezoneOffset() === at.getTimezoneOffset()) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

// A calendar period's previous one: the unit before, whole when the period is over, and up to the same
// day and time of day when it is still running (April 1 to 10 at 10:00 against March 1 to 10 at
// 10:00). A day the unit before does not have (March 31 against February) compares with all of it.
function previousCalendarWindow(
  w: Window & { since: Date; firstDay: string; unit: CalendarUnit },
  now: Date,
): Window {
  const running =
    w.since.getTime() <= now.getTime() && now.getTime() < w.until.getTime();
  const prev = previousStop(
    w.firstDay,
    w.unit,
    running ? { today: localDayKey(now) } : null,
  );
  const since = startOfLocalDay(prev.first);
  // At the period's first instant nothing has elapsed, and the comparison is as empty, even where
  // that instant is not a midnight (a clock that skips it starts the day at 01:00).
  const until =
    prev.stop.at !== "time"
      ? startOfLocalDay(prev.stop.day)
      : now.getTime() === w.since.getTime()
        ? since
        : wallClockOn(prev.stop.day, now);
  const lastDay =
    prev.stop.at === "time"
      ? prev.stop.day
      : localDayKey(addDays(startOfLocalDay(prev.stop.day), -1));
  return {
    since,
    until,
    firstDay: prev.first,
    lastDay,
    days: dayCountOf(prev.first, lastDay),
    unit: w.unit,
  };
}

// The period before: a calendar period's is the calendar period before (previousCalendarWindow); a
// trailing window's is the same number of days, starting that many days earlier. A window still
// running at `now` is compared up to the same local time of day, N days back: the last 7 days at
// 10:00 against the 7 before them up to 10:00, never against whole days, which would read as a drop
// every morning. None for "all".
export function previousWindow(
  w: Window,
  now: Date = new Date(),
): Window | null {
  if (!w.since || w.days === null) return null;
  if (w.unit && w.firstDay)
    return previousCalendarWindow(
      { ...w, since: w.since, firstDay: w.firstDay, unit: w.unit },
      now,
    );
  const since = addDays(w.since, -w.days);
  const until =
    w.since.getTime() <= now.getTime() && now.getTime() < w.until.getTime()
      ? new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() - w.days,
          now.getHours(),
          now.getMinutes(),
          now.getSeconds(),
          now.getMilliseconds(),
        )
      : w.since;
  return {
    since,
    until,
    firstDay: localDayKey(since),
    lastDay: localDayKey(addDays(w.since, -1)),
    days: w.days,
  };
}

// The window as the API reads it at `now`: one still running ends at `now`, the instant its previous
// period is cut at, so both periods cover the same elapsed time however long the streams take to
// start. Its days, and the drill-down links, keep the whole window.
export function readUpTo(w: Window, now: Date): Window {
  const running =
    (!w.since || w.since.getTime() <= now.getTime()) &&
    now.getTime() < w.until.getTime();
  return running ? { ...w, until: now } : w;
}

// Every local day of a window, for charts that show the days with no data as zero. "All" starts at
// the earliest day any series has.
export function daysOf(w: Window, earliest?: string | null): string[] {
  const first = w.firstDay ?? earliest ?? w.lastDay;
  const out: string[] = [];
  let cur = startOfLocalDay(first);
  const end = startOfLocalDay(w.lastDay);
  while (cur.getTime() <= end.getTime()) {
    out.push(localDayKey(cur));
    cur = addDays(cur, 1);
  }
  return out;
}

// Every group of a window, in order (./period.ts), for charts that show the groups with no data as
// zero. "All" starts at the earliest key any series has.
export function periodsOf(
  w: Window,
  grain: Grain,
  earliest?: string | null,
): string[] {
  const out: string[] = [];
  for (const d of daysOf(w, earliest)) {
    const g = groupOf(d, grain);
    if (out[out.length - 1] !== g) out.push(g);
  }
  return out;
}

export const OPERATOR_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// The API query for a window and the filters: the same object for every block of the page.
export function apiQuery(
  f: DashboardFilters,
  w: Window,
): {
  since?: string;
  until: string;
  tz: string;
  source?: Exclude<Source, "all">;
  audience?: Exclude<Audience, "all">;
  agentId?: string;
  inboxId?: string;
} {
  return {
    ...(w.since ? { since: w.since.toISOString() } : {}),
    until: w.until.toISOString(),
    tz: OPERATOR_TZ,
    ...(f.source === "all" ? {} : { source: f.source }),
    ...(f.source === "client" && f.audience !== "all"
      ? { audience: f.audience }
      : {}),
    ...(f.agentId ? { agentId: f.agentId } : {}),
    ...(f.inboxId ? { inboxId: f.inboxId } : {}),
  };
}

// The conversation list opened on a figure: the same view, the day (or the whole window) and the
// outcome the figure counts.
export function drillDownHref(
  f: DashboardFilters,
  w: Pick<Window, "since" | "until">,
  outcome: "all" | "involved" | "resolved_by_agent" | "handoff",
): string {
  const p = new URLSearchParams();
  if (w.since) p.set("createdSince", w.since.toISOString());
  p.set("createdUntil", w.until.toISOString());
  p.set("outcome", outcome);
  if (f.agentId) p.set("agentId", f.agentId);
  if (f.inboxId) p.set("inboxId", f.inboxId);
  return `/conversations?${p.toString()}`;
}

export type TrendMetric =
  | "involvement"
  | "resolution"
  | "automation"
  | "handoff";

// The conversations behind each rate: its numerator's outcome.
export const METRIC_DRILL: Record<
  TrendMetric,
  "involved" | "resolved_by_agent" | "handoff"
> = {
  involvement: "involved",
  resolution: "resolved_by_agent",
  automation: "resolved_by_agent",
  handoff: "handoff",
};

// A point of the funnel-over-time chart. On the total chart each line is a rate, so a hit line names
// its outcome; on a split chart each line is an agent or inbox, so a hit line narrows the view to it
// and the selected rate names the outcome. A click between lines is the whole day: every conversation
// on the total chart, the selected rate's on a split one.
export function trendPointHref(
  f: DashboardFilters,
  day: string,
  breakdown: "none" | "agent" | "inbox",
  metric: TrendMetric,
  seriesKey?: string,
  // A point of a grouped chart is its week or month: the days of it inside the window.
  group?: {
    grain: Grain;
    bounds: { first: string | null; last: string };
  },
): string {
  const w = group
    ? periodWindow(day, group.grain, group.bounds)
    : dayWindow(day);
  if (breakdown === "none") {
    const hit = seriesKey as TrendMetric | undefined;
    return drillDownHref(
      f,
      w,
      hit && hit in METRIC_DRILL ? METRIC_DRILL[hit] : "all",
    );
  }
  const id = seriesKey?.startsWith("s") ? seriesKey.slice(1) : null;
  const view =
    id === null
      ? f
      : breakdown === "agent"
        ? { ...f, agentId: id }
        : { ...f, inboxId: id };
  return drillDownHref(view, w, METRIC_DRILL[metric]);
}

// The previous period's groups, paired by position with the window's. None when the two answers are
// grouped differently (this year at 92 days, by day, against the same stretch of a leap year, 93
// days, by week): a week drawn against a day compares nothing.
export function previousPeriodsOf(
  prev: Window | null,
  grain: Grain,
  prevGrain: Grain | undefined,
): string[] {
  return prev && (prevGrain ?? grain) === grain ? periodsOf(prev, grain) : [];
}

// One local day as a window, for the drill-down of a point.
export function dayWindow(key: string): { since: Date; until: Date } {
  const since = startOfLocalDay(key);
  return { since, until: addDays(since, 1) };
}
