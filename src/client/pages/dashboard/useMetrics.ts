import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
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
  signal: AbortSignal,
): Promise<Answer> {
  const m = api.api.v1.metrics;
  const o = { query, fetch: { signal } };
  const res =
    route === "kpis"
      ? await m.kpis.get(o)
      : route === "outcomes"
        ? await m.outcomes.get(o)
        : route === "costs"
          ? await m.costs.get(o)
          : route === "breakdown"
            ? await m.breakdown.get(o)
            : route === "handoffs"
              ? await m.handoffs.get(o)
              : route === "labels"
                ? await m.labels.get(o)
                : route === "health"
                  ? await m.health.get(o)
                  : route === "follow-ups"
                    ? await m["follow-ups"].get(o)
                    : await m.knowledge.get(o);
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
  opening: string;
  shared: Map<string, Promise<Answer>>;
  // Aborted when the view is replaced or the page leaves: its requests stop, in the browser and on
  // the server (a read not started yet does not start).
  signal: AbortSignal;
  // The flow log's retention could not be read: a flow-log block cannot tell no data from none.
  retentionFailed: boolean;
  retryRetention: () => void;
}

const DashboardView = createContext<View | null>(null);

export function DashboardMetricsProvider({
  query,
  prevQuery,
  win,
  openedAt,
  retentionDays,
  firstDay = null,
  retentionFailed = false,
  retryRetention = () => {},
  children,
}: {
  query: Query;
  prevQuery: Query | null;
  win: Window;
  openedAt: Date;
  retentionDays: number | null;
  firstDay?: string | null;
  retentionFailed?: boolean;
  retryRetention?: () => void;
  children: ReactNode;
}) {
  const opening = openedAt.getTime();
  const viewKey = `${opening}|${JSON.stringify(query)}`;
  // A new opening starts with nothing shared: the previous view's answers are not this one's, and
  // its requests still running are aborted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new view is a new set of requests.
  const shared = useMemo(() => new Map<string, Promise<Answer>>(), [viewKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one controller per view.
  const controller = useMemo(() => new AbortController(), [viewKey]);
  useEffect(() => () => controller.abort(), [controller]);
  const value = useMemo(
    () => ({
      query,
      prevQuery,
      win,
      openedAt,
      retentionDays,
      firstDay,
      opening: viewKey,
      shared,
      signal: controller.signal,
      retentionFailed,
      retryRetention,
    }),
    [
      query,
      prevQuery,
      win,
      openedAt,
      retentionDays,
      firstDay,
      viewKey,
      shared,
      controller,
      retentionFailed,
      retryRetention,
    ],
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
  // A retry belongs to the view it was asked in: a new view starts every block at the same key, so
  // two blocks on one route share their request again.
  const [retry, setRetry] = useState({ view: view.opening, n: 0 });
  const retries = retry.view === view.opening ? retry.n : 0;
  const key = JSON.stringify([route, query, view.opening, retries]);
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const shared = view.shared;
  const signal = view.signal;
  // A flow-log block waits for the retention, which tells its days with no data from days with none.
  const waiting = opts.flowLog === true && view.retentionDays === null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` serializes the route and the query.
  const load = useCallback(async () => {
    if (!query) return { data: null };
    let pending = shared.get(key);
    if (!pending) {
      pending = fetchRoute(route, query, signal).catch(() => ({ data: null }));
      shared.set(key, pending);
    }
    const answer = await pending;
    // A failed answer is not kept: the retry asks again.
    if (answer.data === null) shared.delete(key);
    return answer;
  }, [key, shared]);
  const block = useBlock<unknown>(key, load);
  const opening = view.opening;
  const retryRetention = view.retryRetention;
  const reload = useCallback(() => {
    if (waiting) retryRetention();
    else
      setRetry((r) => ({
        view: opening,
        n: (r.view === opening ? r.n : 0) + 1,
      }));
  }, [waiting, retryRetention, opening]);
  // Nothing of a flow-log block shows before the retention is known: an empty answer could be days
  // retention emptied, and its skeleton holds until then.
  const data =
    waiting || block.data === null
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
    loading:
      query !== null && (waiting ? !view.retentionFailed : block.loading),
    error: query !== null && (waiting ? view.retentionFailed : block.error),
    status: block.status,
    field: block.field,
    reload,
    coverage,
  };
}

type MetricsBlock<T> = ReturnType<typeof useMetricsBlock<T>>;

// A block that compares against the previous period shows both or neither: figures whose comparison
// failed are not final, so the block shows its failure, and its retry asks again whichever of the two
// requests failed (or the current one, when neither did).
export function withComparison<T, P>(
  current: MetricsBlock<T>,
  previous: MetricsBlock<P>,
): MetricsBlock<T> {
  const failed = [current, previous].filter((b) => b.error);
  const first = failed[0];
  if (!first) return current;
  return {
    ...current,
    data: null,
    loading: false,
    error: true,
    status: first.status,
    field: first.field,
    reload: () => {
      for (const b of failed) b.reload();
    },
  };
}
