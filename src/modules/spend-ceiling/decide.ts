import type { UsageSource } from "@/graph/usage";
import type { SpendCeilingConfig } from "./settings";

// THE RULE, on its own, so it can be proved by a decision table instead of by a database (issue
// #146). Everything that reads the ledger, posts the copy or hands the conversation off is wiring
// around this function.

export type SpendVerdict =
  // Under the ceiling, or no ceiling applies to this source.
  | { state: "allowed"; usedTokens: number; ceilingTokens: number | null }
  // At or over the ceiling. The turn does not run.
  | { state: "over"; usedTokens: number; ceilingTokens: number }
  // Under the ceiling and past the warning fraction: the turn runs, and the operator is told once.
  | { state: "warning"; usedTokens: number; ceilingTokens: number };

export interface SpendDecisionInput {
  cfg: SpendCeilingConfig;
  source: UsageSource;
  usedTokens: number;
}

// WHICH CEILING A SOURCE ANSWERS TO. Two numbers rather than one, because the ledger already tells
// the two kinds of traffic apart and an operator burning the month in the playground must not be
// able to silence the agent for customers.
export function ceilingFor(
  cfg: SpendCeilingConfig,
  source: UsageSource,
): number | null {
  const configured =
    source === "playground"
      ? cfg.monthlyPlaygroundTokens
      : cfg.monthlyInboxTokens;
  // 0 IS "NO CEILING ON THIS HALF", not "refuse everything". An operator who wants to bound only
  // the playground leaves the other at zero, and reading that as a ceiling of zero tokens would
  // switch the agent off for every customer the moment the block is enabled.
  return configured > 0 ? configured : null;
}

export function decideSpend(input: SpendDecisionInput): SpendVerdict {
  const { cfg, source, usedTokens } = input;
  const ceilingTokens = cfg.enabled ? ceilingFor(cfg, source) : null;
  if (ceilingTokens === null) {
    return { state: "allowed", usedTokens, ceilingTokens: null };
  }
  // AT the ceiling is over it: the number is what the tenant is allowed to spend, and the next call
  // would spend past it. A turn is not free, and it cannot be sized before it runs.
  if (usedTokens >= ceilingTokens) {
    return { state: "over", usedTokens, ceilingTokens };
  }
  if (
    cfg.warnAtPercent > 0 &&
    usedTokens * 100 >= ceilingTokens * cfg.warnAtPercent
  ) {
    return { state: "warning", usedTokens, ceilingTokens };
  }
  return { state: "allowed", usedTokens, ceilingTokens };
}

// The window the ceiling is counted over: the CALENDAR month, in UTC, which is the cycle the
// provider's invoice follows and the number an operator compares this against. A rolling window
// measures consumption more honestly and never zeroes at once, which is the thing that would have
// to be explained to whoever signs the invoice.
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// The other end of the same window, EXCLUSIVE: the first instant of the next month, so the pair is
// `[monthStart, monthEnd)` and no row belongs to two months. It exists because the window has two
// ends and the query only ever carried one — see `sumUsageInMonth`, which is the only place the
// pair is built. `Date.UTC` normalises month 12 into January of the next year on its own.
export function monthEnd(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
