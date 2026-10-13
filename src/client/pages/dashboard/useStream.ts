import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "@/client/lib/api";
import { recoverFromRejectedTenant } from "@/client/lib/tenantSelectorRecovery";
import type { Block, Progress } from "@/modules/analytics/rollup/engine";
import type { DashboardFigures } from "@/modules/analytics/rollup/figures";
import type { Family, Section } from "@/modules/analytics/rollup/sections";
import type { StreamEvent } from "@/modules/analytics/rollup/stream";
import { failureOf } from "./Block";
import type { apiQuery } from "./filters";

// THE DASHBOARD AS IT FILLS. One stream per window (the view's, and the previous period's for the
// comparisons) carries every block's figures: what the server already keeps arrives at once, and the
// figures come again after each part it computes, today first and then back in time. A block shows
// whatever has arrived with how many of its days it covers; a new view drops the old stream at once.

type Query = ReturnType<typeof apiQuery>;

export interface StreamState {
  figures: DashboardFigures | null;
  // The coverage the figures were merged at: only a snapshot moves it, so a block never reads days
  // as in that its figures do not hold yet.
  coverage: Progress | null;
  // The server's progress as it computes, for the page-wide line: a `computing` event moves it too.
  progress: Progress | null;
  done: boolean;
  // The grace since the stream opened passed with the view still filling: only then does anything
  // read as partial. A warm opening that completes within it shows its figures as final at once.
  graced: boolean;
  failed: boolean;
  status: number | null;
  field: string | null;
}

const EMPTY: StreamState = {
  figures: null,
  coverage: null,
  progress: null,
  done: false,
  graced: false,
  failed: false,
  status: null,
  field: null,
};

// How long a view may take to complete before it shows as partial: a warm opening reads its kept days
// at once and computes today, yesterday and the cutoff's day within about a second, and a flash of
// "partial" for that second would say nothing. Mutable for tests.
export const streamGrace = { ms: 1500 };

export const CURRENT_BLOCKS: Block[] = [
  "kpis",
  "outcomes",
  "costs",
  "breakdown",
  "handoffs",
  "labels",
  "health",
  "followUps",
  "knowledge",
];
export const PREVIOUS_BLOCKS: Block[] = ["kpis", "outcomes", "costs"];

function useWindowStream(
  query: Query | null,
  blocks: Block[],
): [StreamState, () => void] {
  const [state, setState] = useState<StreamState>(EMPTY);
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify([query, blocks, nonce]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` serializes everything the stream depends on.
  useEffect(() => {
    if (!query) {
      setState({ ...EMPTY, done: true });
      return;
    }
    const abort = new AbortController();
    setState(EMPTY);
    const grace = setTimeout(
      () => setState((s) => (s.done ? s : { ...s, graced: true })),
      streamGrace.ms,
    );
    const apply = (event: StreamEvent) => {
      if (event.kind === "waiting") return;
      if (event.kind === "computing") {
        setState((s) => ({ ...s, progress: event.progress }));
        return;
      }
      setState((s) => ({
        ...s,
        figures: event.figures,
        coverage: event.progress,
        progress: event.progress,
        done: event.done,
      }));
    };
    // A stream that stops before its last snapshot or a refusal (a proxy or the server closing it
    // early) has not said what is missing: it reads as failed, with its retry.
    let ended = false;
    (async () => {
      const res = await api.api.v1.metrics.stream.get({
        query: { ...query, blocks: blocks.join(",") },
        fetch: { signal: abort.signal },
      });
      if (abort.signal.aborted) return;
      if (res.error || !res.data) {
        const f = failureOf(res.error);
        setState((s) => ({
          ...s,
          failed: true,
          status: f.status ?? null,
          field: f.field ?? null,
        }));
        return;
      }
      for await (const message of res.data as AsyncIterable<{
        event?: string;
        data?: unknown;
      }>) {
        if (abort.signal.aborted) return;
        const data = message.data as
          | StreamEvent
          | {
              status: number;
              error: string;
              field?: string;
              rejectedTenantId?: string;
            }
          | undefined;
        if (!data) continue;
        if ("kind" in data) {
          if (data.kind === "snapshot" && data.done) ended = true;
          apply(data);
        } else {
          ended = true;
          if (data.rejectedTenantId)
            recoverFromRejectedTenant(data.rejectedTenantId);
          setState((s) => ({
            ...s,
            failed: true,
            status: data.status,
            field: data.field ?? null,
          }));
        }
      }
      if (!ended && !abort.signal.aborted)
        setState((s) => ({ ...s, failed: true, status: null, field: null }));
    })().catch(() => {
      if (!abort.signal.aborted)
        setState((s) => ({ ...s, failed: true, status: null, field: null }));
    });
    return () => {
      clearTimeout(grace);
      abort.abort();
    };
  }, [key]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return [state, reload];
}

interface Streams {
  current: StreamState;
  previous: StreamState;
  reload: () => void;
}

const DashboardStreams = createContext<Streams | null>(null);

export function DashboardStreamProvider({
  query,
  prevQuery,
  children,
}: {
  query: Query;
  prevQuery: Query | null;
  children: ReactNode;
}) {
  const [current, reloadCurrent] = useWindowStream(query, CURRENT_BLOCKS);
  const [previous, reloadPrevious] = useWindowStream(
    prevQuery,
    PREVIOUS_BLOCKS,
  );
  const value = useMemo(
    () => ({
      current,
      previous,
      reload: () => {
        reloadCurrent();
        reloadPrevious();
      },
    }),
    [current, previous, reloadCurrent, reloadPrevious],
  );
  return createElement(DashboardStreams.Provider, { value }, children);
}

// How much of its window a block covers: its days in, out of how many, and the flow-log days the
// retention sweep emptied before they were kept, which no request can fill any more.
export interface BlockCoverage {
  total: number;
  ready: number;
  noData: number;
  done: boolean;
  // Days with no figures yet or for good: a chart and its file leave them blank, never zero.
  gaps: [string, string][];
  // Of those, the days with no figures for good, which a chart marks apart from the ones loading.
  none: [string, string][];
  // A family that stopped on a day past the time budget.
  refused: { status: number; field?: string } | null;
  // The window's first listed day, which a chart's axis starts from while older days arrive.
  first: string | null;
  // Parts are still arriving: the stream neither finished, failed nor was refused. A provisional
  // figure pulses only while this holds.
  arriving: boolean;
  // The stream's grace passed with the view still filling (`streamGrace`): until then nothing reads
  // as partial, so a view that completes within it never flashes.
  graced: boolean;
}

const within = (runs: [string, string][], day: string) =>
  runs.some(([a, b]) => day >= a && day <= b);

export function inGap(coverage: BlockCoverage | null, day: string): boolean {
  return within(coverage?.gaps ?? [], day);
}

// What a chart draws for a day: its figures, a place held while it loads, or no data for good.
export type DayState = "ready" | "loading" | "noData";

export function dayState(
  coverage: BlockCoverage | null,
  day: string,
): DayState {
  if (!coverage) return "ready";
  if (within(coverage.none, day)) return "noData";
  return coverage.graced && within(coverage.gaps, day) ? "loading" : "ready";
}

// What a block reads: whole families, or a flow-log section, which past retention is in or out on its
// own (`Progress.sections`).
export type Source = Family | Section;

export function coverageOf(
  s: StreamState,
  families: Source[],
): BlockCoverage | null {
  if (!s.coverage) return null;
  const total = s.coverage.total;
  let ready = total;
  let noData = 0;
  let done = true;
  const gaps: [string, string][] = [];
  const none: [string, string][] = [];
  let refused: BlockCoverage["refused"] = null;
  // Each family settles on its own: days with no data in one cannot stand in for days still
  // computing in another.
  for (const source of families) {
    const c =
      s.coverage.sections?.[source as Section] ??
      s.coverage.families[source.split(".")[0] as Family];
    ready = Math.min(ready, c.ready);
    noData = Math.max(noData, c.noData);
    if (c.ready + c.noData < total) done = false;
    gaps.push(...c.gaps);
    none.push(...(c.none ?? []));
    refused = refused ?? c.refused ?? null;
  }
  return {
    total,
    ready,
    noData,
    done,
    gaps,
    none,
    refused,
    first: s.coverage.first ?? null,
    arriving: !done && !s.done && !s.failed && refused === null,
    graced: s.graced,
  };
}

// One block's figures from the page's stream, in the shape `useBlock` returns, plus its coverage.
export function useStreamBlock<T>(
  pick: (f: DashboardFigures) => T | undefined,
  families: Source[],
  which: "current" | "previous" = "current",
): {
  data: T | null;
  loading: boolean;
  error: boolean;
  status: number | null;
  field: string | null;
  reload: () => void;
  coverage: BlockCoverage | null;
} {
  const streams = useContext(DashboardStreams);
  if (!streams)
    throw new Error("useStreamBlock outside DashboardStreamProvider");
  const s = streams[which];
  const coverage = coverageOf(s, families);
  // A comparison between a period and part of the other would read as a change that is not there: the
  // previous figures count only once every day of theirs, and of the view's own, is in.
  const usable =
    which === "current" ||
    (coverage?.done === true &&
      coverageOf(streams.current, families)?.done === true);
  const data = s.figures && usable ? (pick(s.figures) ?? null) : null;
  return {
    data,
    loading: !s.failed && data === null && !s.done,
    // A stream that ended without this block's figures has nothing true to show, and one refused
    // before this block's days were all in leaves figures that would read as the whole period.
    // A family stopped on a day past the budget is refused for its blocks only, the same way.
    error:
      (coverage?.refused != null && !coverage.done) ||
      (data === null ? s.failed || s.done : s.failed && !coverage?.done),
    status: coverage?.refused?.status ?? s.status,
    field: coverage?.refused ? (coverage.refused.field ?? null) : s.field,
    reload: streams.reload,
    coverage,
  };
}

// The view's own stream and its retry, for the page-wide progress line.
export function useCurrentStream(): {
  state: StreamState;
  reload: () => void;
} | null {
  const streams = useContext(DashboardStreams);
  return streams ? { state: streams.current, reload: streams.reload } : null;
}
