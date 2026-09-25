// Import-free on purpose: scripts/refresh-model-prices.ts regenerates the price table, so nothing it
// loads may depend on that table existing or parsing (review round 4 of #869).

// Whether a refresh that kept `kept` priced models, where the table had `previous`, is a real read.
// A real refresh moves a handful of rows; an empty or truncated source file loses most of them, and
// writing that would have the weekly job propose removing every model it lost.
export function plausibleRefresh(kept: number, previous: number): boolean {
  return kept > 0 && kept >= previous / 2;
}
