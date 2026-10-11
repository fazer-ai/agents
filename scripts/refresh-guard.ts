// Import-free on purpose: scripts/refresh-model-prices.ts regenerates the price table, so nothing it
// loads may depend on that table existing or parsing.

// Whether a refresh that kept `kept` priced models, where the table had `previous`, is a real read.
// A real refresh moves a handful of rows; an empty or truncated source file loses most of them, and
// writing that would have the scheduled job propose removing every model it lost.
export function plausibleRefresh(kept: number, previous: number): boolean {
  return kept > 0 && kept >= previous / 2;
}

export type SourceCounts = { litellm: number; openrouter: number };

// The source whose read is not a real one, named for the error, or null when both are. Each source is
// held to its own rows, so one broken read cannot hide behind the other's.
export function implausibleSource(
  kept: SourceCounts,
  previous: SourceCounts,
): "LiteLLM" | "OpenRouter" | null {
  if (!plausibleRefresh(kept.litellm, previous.litellm)) return "LiteLLM";
  if (!plausibleRefresh(kept.openrouter, previous.openrouter))
    return "OpenRouter";
  return null;
}
