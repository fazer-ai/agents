import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "@/client/lib/api";
import { failureOf } from "./Block";
import { type apiQuery, daysOf, localDayKey, type Window } from "./filters";
import { useBlock } from "./useBlock";

// EVERY BLOCK FETCHES ITS OWN FIGURES (docs/dashboard.md, "How the console loads"). The page holds
// the view (its query, the previous period's, the instant it was opened) and each block asks its own
// route for it, so a fast block shows at once and a slow one holds only itself. Two blocks that read
// the same route with the same query share one request.

type Query = ReturnType<typeof apiQuery>;

export type MetricsRoute =
  | "kpis"
  | "outcomes"
  | "costs"
  | "breakdown"
  | "handoffs"
  | "labels"
  | "health"
  | "follow-ups"
  | "knowledge";

interface Answer {
  data: unknown;
  status?: number | null;
  field?: string | null;
}

async function fetchRoute(
  route: MetricsRoute,
  query: Record<string, string>,
): Promise<Answer> {
  const m = api.api.v1.metrics;
  const res =
    route === "kpis"
      ? await m.kpis.get({ query })
      : route === "outcomes"
        ? await m.outcomes.get({ query })
        : route === "costs"
          ? await m.costs.get({ query })
          : route === "breakdown"
            ? await m.breakdown.get({ query })
            : route === "handoffs"
              ? await m.handoffs.get({ query })
              : route === "labels"
                ? await m.labels.get({ query })
                : route === "health"
                  ? await m.health.get({ query })
                  : route === "follow-ups"
                    ? await m["follow-ups"].get({ query })
                    : await m.knowledge.get({ query });
  if (res.error || !res.data) {
    const f = failureOf(res.error);
    return { data: null, status: f.status ?? null, field: f.field ?? null };
  }
  return { data: res.data };
}

// The flow log keeps `FLOWLOG_RETENTION_DAYS`: a day of a flow-log block before the day the retention
// cutoff falls in has no lines left, and reads as no data, never as zero. The cutoff's own day is
// partly swept and is read as the reader reads it.
export interface BlockCoverage {
  // The window's days, and how many of them have no data for good.
  total: number;
  noData: number;
  // Those days, as runs of first and last day inclusive.
  none: [string, string][];
}

export function inGap(coverage: BlockCoverage | null, day: string): boolean {
  return (coverage?.none ?? []).some(([a, b]) => day >= a && day <= b);
}

export type DayState = "ready" | "noData";

export function dayState(
  coverage: BlockCoverage | null,
  day: string,
): DayState {
  return inGap(coverage, day) ? "noData" : "ready";
}

// Where a flow-log chart's axis starts in an all-time view: its first day with lines, or the first
// day with none for good, whichever is earlier, so the days retention emptied keep their band.
export function axisStart(
  coverage: BlockCoverage | null,
  firstWithData: string | null | undefined,
): string | null {
  const gone = coverage?.none[0]?.[0] ?? null;
  if (!gone) return firstWithData ?? null;
  if (!firstWithData) return gone;
  return gone < firstWithData ? gone : firstWithData;
}

export function hasNoData(coverage: BlockCoverage | null | undefined): boolean {
  return (coverage?.noData ?? 0) > 0;
}

export function flowLogCoverage(
  win: Window,
  openedAt: Date,
  retentionDays: number | null,
  earliest?: string | null,
): BlockCoverage | null {
  if (retentionDays === null) return null;
  const cutoffDay = localDayKey(
    new Date(openedAt.getTime() - retentionDays * 86_400_000),
  );
  const days = daysOf(win, earliest);
  const gone = days.filter((d) => d < cutoffDay);
  return {
    total: days.length,
    noData: gone.length,
    none: gone.length > 0 ? [[gone[0] as string, gone.at(-1) as string]] : [],
  };
}

interface View {
  query: Query;
  prevQuery: Query | null;
  win: Window;
  openedAt: Date;
  retentionDays: number | null;
  // The tenant's first day, where an all-time window starts.
  firstDay: string | null;
  // What a block's retry and a new view key their requests on.
  opening: number;
  shared: Map<string, Promise<Answer>>;
}

const DashboardView = createContext<View | null>(null);

export function DashboardMetricsProvider({
  query,
  prevQuery,
  win,
  openedAt,
  retentionDays,
  firstDay = null,
  children,
}: {
  query: Query;
  prevQuery: Query | null;
  win: Window;
  openedAt: Date;
  retentionDays: number | null;
  firstDay?: string | null;
  children: ReactNode;
}) {
  const opening = openedAt.getTime();
  // A new opening starts with nothing shared: the previous view's answers are not this one's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new opening is a new set of requests.
  const shared = useMemo(() => new Map<string, Promise<Answer>>(), [opening]);
  const value = useMemo(
    () => ({
      query,
      prevQuery,
      win,
      openedAt,
      retentionDays,
      firstDay,
      opening,
      shared,
    }),
    [query, prevQuery, win, openedAt, retentionDays, firstDay, opening, shared],
  );
  return createElement(DashboardView.Provider, { value }, children);
}

// One block's figures: `route` asked with the page's query (or the previous period's) plus `params`,
// and `pick` reading what the block shows out of the answer. `flowLog` marks a block that reads the
// flow log, whose days past retention are no data.
export function useMetricsBlock<T>(
  route: MetricsRoute,
  pick: (body: never) => T | undefined,
  opts: {
    which?: "current" | "previous";
    params?: Record<string, string>;
    flowLog?: boolean;
  } = {},
): {
  data: T | null;
  loading: boolean;
  error: boolean;
  status: number | null;
  field: string | null;
  reload: () => void;
  coverage: BlockCoverage | null;
} {
  const view = useContext(DashboardView);
  if (!view)
    throw new Error("useMetricsBlock outside DashboardMetricsProvider");
  const which = opts.which ?? "current";
  const base = which === "current" ? view.query : view.prevQuery;
  const query = base
    ? ({ ...base, ...(opts.params ?? {}) } as Record<string, string>)
    : null;
  const [retries, setRetries] = useState(0);
  const key = JSON.stringify([route, query, view.opening, retries]);
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const shared = view.shared;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` serializes the route and the query.
  const load = useCallback(async () => {
    if (!query) return { data: null };
    let pending = shared.get(key);
    if (!pending) {
      pending = fetchRoute(route, query);
      shared.set(key, pending);
    }
    const answer = await pending;
    // A failed answer is not kept: the retry asks again.
    if (answer.data === null) shared.delete(key);
    return answer;
  }, [key, shared]);
  const block = useBlock<unknown>(key, load);
  const reload = useCallback(() => setRetries((n) => n + 1), []);
  const data =
    block.data === null
      ? null
      : ((pickRef.current as (b: unknown) => T | undefined)(block.data) ??
        null);
  const coverage = opts.flowLog
    ? flowLogCoverage(
        view.win,
        view.openedAt,
        view.retentionDays,
        view.firstDay,
      )
    : null;
  return {
    data,
    // No previous period ("all") is nothing to load.
    loading: query !== null && block.loading,
    error: query !== null && block.error,
    status: block.status,
    field: block.field,
    reload,
    coverage,
  };
}
