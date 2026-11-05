import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import instanceHealthPrisma from "@/api/lib/prisma-instance-health";
import { setSignalDetail, statementLine } from "../details";
import { slowestMeanShare } from "./read";
import { lastAvailability, snapshotIfDue } from "./snapshot";
import { flushStatementTimeouts } from "./timeouts";

// The database screen's part of the instance health sampler's database half (docs/logs.md,
// "Database"): store the statement timeouts captured since the last tick (with their plans), take the
// pg_stat_statements snapshot when it is due, and recompute the drift signal after each one. Returns
// the drift signal's value, as a share of the budget.

export const DRIFT_SIGNAL = "statement_mean_budget_pct";

interface TickState {
  drift: number | null;
}

const KEY = Symbol.for("fazerai.instanceHealth.dbTick");

function state(): TickState {
  const g = globalThis as unknown as Record<symbol, TickState>;
  g[KEY] ??= { drift: null };
  return g[KEY];
}

// Test-only.
export function resetDatabaseTickState(): void {
  state().drift = null;
}

export async function databaseScreenTick(
  now: number,
  base: PrismaClient = instanceHealthPrisma,
): Promise<number> {
  const s = state();
  try {
    await flushStatementTimeouts(base);
  } catch (err) {
    logger.warn({ err }, "database screen: statement timeouts not stored");
  }
  let took = false;
  try {
    took = await snapshotIfDue(base, now);
  } catch (err) {
    logger.warn({ err }, "database screen: snapshot failed");
  }
  if (took || s.drift === null) {
    // Unknown until this process's first snapshot, which after a restart can be minutes away: the
    // drift reads only the stored snapshots, so it is computed from them meanwhile instead of reading
    // 0 until then.
    if (lastAvailability()?.available !== false) {
      try {
        const { pct, query } = await slowestMeanShare(base, now);
        s.drift = pct;
        setSignalDetail(
          DRIFT_SIGNAL,
          query ? `Slowest over the last hour: ${statementLine(query)}` : null,
        );
      } catch (err) {
        logger.warn({ err }, "database screen: drift not computed");
      }
    } else {
      // Nothing to measure without the extension: the signal reads 0 and names nothing.
      s.drift = 0;
      setSignalDetail(DRIFT_SIGNAL, null);
    }
  }
  return s.drift ?? 0;
}
