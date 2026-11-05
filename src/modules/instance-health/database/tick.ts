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
  // A failed read must not look like a fresh value: it is rethrown after the rest of the tick ran,
  // so the sampler records no point and the signal ages to stale (docs/logs.md, instance health).
  let failure: unknown = null;
  let took = false;
  try {
    took = await snapshotIfDue(base, now);
  } catch (err) {
    logger.warn({ err }, "database screen: snapshot failed");
    failure = err;
  }
  if (took || s.drift === null) {
    // Unknown until this process's first snapshot, which after a restart can be minutes away: the
    // drift reads only the stored snapshots, so it is computed from them meanwhile instead of reading
    // 0 until then.
    const availability = lastAvailability();
    if (
      availability?.available === false &&
      availability.reason === "unreadable"
    ) {
      // The extension is there and the read failed: a failure like any other, not an absence.
      s.drift = null;
      failure ??= new Error("pg_stat_statements could not be read");
    } else if (availability?.available !== false) {
      try {
        const { pct, query } = await slowestMeanShare(base, now);
        s.drift = pct;
        setSignalDetail(
          DRIFT_SIGNAL,
          query ? `Slowest over the last hour: ${statementLine(query)}` : null,
        );
      } catch (err) {
        logger.warn({ err }, "database screen: drift not computed");
        // Recomputed on the next tick instead of serving the last value as if it were new.
        s.drift = null;
        failure ??= err;
      }
    } else {
      // Nothing to measure without the extension: the signal reads 0 and names nothing.
      s.drift = 0;
      setSignalDetail(DRIFT_SIGNAL, null);
    }
  }
  if (failure !== null) throw failure;
  return s.drift ?? 0;
}
