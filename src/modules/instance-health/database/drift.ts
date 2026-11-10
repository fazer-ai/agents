// WHICH STATEMENT IS THE DRIFT SIGNAL'S VALUE (docs/logs.md, "Database"). The signal is a trend over
// many calls: a statement with fewer than DRIFT_MIN_CALLS calls in the hour is never its value, and is
// listed as left out when it would have outranked the one chosen, so the console and the MCP read do
// not present the figure as covering it. A single call that reaches its budget is already counted by
// statement_timeouts_per_min.

// The largest floor that keeps every hour in which a statement drifted for real; the call counts it
// is chosen from are in docs/logs.md.
export const DRIFT_MIN_CALLS = 3;

// How many left-out statements a read lists, the largest share first.
export const DRIFT_LEFT_OUT_TOP = 10;

export interface DriftCandidate {
  queryid: string;
  query: string;
  calls: number;
  meanMs: number;
  budgetMs: number;
  // meanMs as a share of budgetMs, in percent.
  pct: number;
}

export interface DriftPick {
  best: DriftCandidate | null;
  // Below the floor and above the chosen share, the largest first, at most DRIFT_LEFT_OUT_TOP.
  leftOut: DriftCandidate[];
  // Every statement below the floor and above the chosen share, past the cap included.
  leftOutCount: number;
}

function byShare(a: DriftCandidate, b: DriftCandidate): number {
  if (b.pct !== a.pct) return b.pct - a.pct;
  return a.queryid < b.queryid ? -1 : a.queryid > b.queryid ? 1 : 0;
}

export function pickDrift(
  candidates: readonly DriftCandidate[],
  minCalls: number = DRIFT_MIN_CALLS,
): DriftPick {
  let best: DriftCandidate | null = null;
  for (const c of candidates) {
    if (c.calls < minCalls) continue;
    if (!best || byShare(c, best) < 0) best = c;
  }
  // Whatever outranks the value has fewer calls than the floor, or it would be the value.
  const below = candidates
    .filter((c) => c.pct > (best?.pct ?? 0))
    .sort(byShare);
  return {
    best,
    leftOut: below.slice(0, DRIFT_LEFT_OUT_TOP),
    leftOutCount: below.length,
  };
}
