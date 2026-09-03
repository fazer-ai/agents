import type { UsageSource } from "@/graph/usage";
import type { SpendCeilingConfig } from "./settings";

// THE RULE, on its own, so it can be proved by a decision table instead of by a database (issue
// #146). Everything that reads the snapshot, posts the copy or hands the conversation off is wiring
// around this function.

export type SpendVerdict =
  // Under the ceiling, or no ceiling applies to this source.
  | { state: "allowed"; usedUsd: number; ceilingUsd: number | null }
  // At or over the ceiling. The turn does not run.
  | { state: "over"; usedUsd: number; ceilingUsd: number }
  // Under the ceiling and past the warning fraction: the turn runs, and the operator is told once.
  | { state: "warning"; usedUsd: number; ceilingUsd: number };

export interface SpendDecisionInput {
  cfg: SpendCeilingConfig;
  source: UsageSource;
  usedUsd: number;
}

// WHICH CEILING A SOURCE ANSWERS TO. Two numbers rather than one, because the ledger already tells
// the two kinds of traffic apart and an operator burning the month in the playground must not be
// able to silence the agent for customers.
export function ceilingFor(
  cfg: SpendCeilingConfig,
  source: UsageSource,
): number | null {
  const configured =
    source === "playground" ? cfg.monthlyPlaygroundUsd : cfg.monthlyInboxUsd;
  // 0 IS "NO CEILING ON THIS HALF", not "refuse everything". An operator who wants to bound only
  // the playground leaves the other at zero, and reading that as a ceiling of zero dollars would
  // switch the agent off for every customer the moment the block is enabled.
  return configured > 0 ? configured : null;
}

// Money is compared in CENTS. `0.1 + 0.2` is not `0.3` to a double, and a ceiling of thirty cents
// met exactly by three dimes has to read as reached rather than as a hair under it.
function cents(usd: number): number {
  return Math.round(usd * 100);
}

export function decideSpend(input: SpendDecisionInput): SpendVerdict {
  const { cfg, source, usedUsd } = input;
  const ceilingUsd = cfg.enabled ? ceilingFor(cfg, source) : null;
  if (ceilingUsd === null) {
    return { state: "allowed", usedUsd, ceilingUsd: null };
  }
  const used = cents(usedUsd);
  const ceiling = cents(ceilingUsd);
  // AT the ceiling is over it: the number is what the tenant is allowed to spend, and the next call
  // would spend past it. A turn is not free, and it cannot be priced before it runs.
  if (used >= ceiling) {
    return { state: "over", usedUsd, ceilingUsd };
  }
  if (cfg.warnAtPercent > 0 && used * 100 >= ceiling * cfg.warnAtPercent) {
    return { state: "warning", usedUsd, ceilingUsd };
  }
  return { state: "allowed", usedUsd, ceilingUsd };
}

// The window the ceiling is counted over: the CALENDAR month, in UTC, which is the cycle the
// provider's invoice follows and the number an operator compares this against. A rolling window
// measures consumption more honestly and never zeroes at once, which is the thing that would have
// to be explained to whoever signs the invoice.
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// The other end of the same window, EXCLUSIVE: the first instant of the next month, so the pair is
// `[monthStart, monthEnd)` and no instant belongs to two months. `Date.UTC` normalises month 12
// into January of the next year on its own. The snapshot is keyed by `monthStart`, so the gate
// never builds the pair; the console's ledger count and the poll's Langfuse window do.
export function monthEnd(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
