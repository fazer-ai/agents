// THE PAGE'S ONE FILTER, IN THE URL. Period, agent, inbox and source live in the query string, so a
// view can be shared as a link and Back returns to the previous view. Every block reads the window
// computed here, in the operator's own days (docs/ui.md, "A day is defined by the viewer's browser
// timezone"), and the previous period is the same number of days immediately before it.

export const RANGES = ["7d", "30d", "90d", "all", "custom"] as const;
export type Range = (typeof RANGES)[number];
export const SOURCES = ["inbox", "playground", "all"] as const;
export type Source = (typeof SOURCES)[number];

const RANGE_DAYS: Record<Exclude<Range, "custom" | "all">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export interface DashboardFilters {
  range: Range;
  // Local days, inclusive, `YYYY-MM-DD`. Set only for a custom range.
  from: string | null;
  to: string | null;
  agentId: string | null;
  inboxId: string | null;
  source: Source;
}

export const DEFAULT_FILTERS: DashboardFilters = {
  range: "30d",
  from: null,
  to: null,
  agentId: null,
  inboxId: null,
  source: "inbox",
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^\d{1,19}$/;

function validDay(s: string | null): s is string {
  if (!s || !DAY.test(s)) return false;
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
  const custom =
    range === "custom" && validDay(from) && validDay(to) && from <= to;
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
    source: (SOURCES as readonly string[]).includes(source ?? "")
      ? (source as Source)
      : DEFAULT_FILTERS.source,
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
  return p;
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

// The period before: the same number of days, ending where this one starts. None for "all".
export function previousWindow(w: Window): Window | null {
  if (!w.since || w.days === null) return null;
  const since = addDays(w.since, -w.days);
  const lastDay = localDayKey(addDays(w.since, -1));
  return {
    since,
    until: w.since,
    firstDay: localDayKey(since),
    lastDay,
    days: w.days,
  };
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

export const OPERATOR_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// The API query for a window and the filters: the same object for every block of the page.
export function apiQuery(
  f: DashboardFilters,
  w: Window,
): {
  since?: string;
  until: string;
  tz: string;
  source?: "inbox" | "playground";
  agentId?: string;
  inboxId?: string;
} {
  return {
    ...(w.since ? { since: w.since.toISOString() } : {}),
    until: w.until.toISOString(),
    tz: OPERATOR_TZ,
    ...(f.source === "all" ? {} : { source: f.source }),
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

// One local day as a window, for the drill-down of a point.
export function dayWindow(key: string): { since: Date; until: Date } {
  const since = startOfLocalDay(key);
  return { since, until: addDays(since, 1) };
}
