import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import instanceHealthPrisma from "@/api/lib/prisma-instance-health";
import { driftFacts, setSignalDetail } from "../details";
import { budgetUntil } from "./budget";
import { type DriftLeftOutDto, slowestMeanShare } from "./read";
import { lastAvailability, snapshotIfDue } from "./snapshot";
import { flushStatementTimeouts } from "./timeouts";

// The database screen's part of the sampler's database half: store the captured timeouts, take the
// snapshot when due, and return the drift signal. One deadline for the tick, nothing cached between
// ticks, and any failure throws so no point is recorded (docs/logs.md, "Database").

export const DRIFT_SIGNAL = "statement_mean_budget_pct";

// What one tick may take, all of its statements together: under the sampler's 15 s database cadence.
export const TICK_BUDGET_MS = 10_000;
// The part of it the timeout flush may use.
const FLUSH_SHARE_MS = 3_000;

// What the tick that produced the drift signal's current value left out for too few calls, kept
// beside that value so the screen and the MCP read describe the same reading.
export interface DriftFloorReading {
  minCalls: number;
  leftOut: DriftLeftOutDto[];
  leftOutCount: number;
}

const FLOOR_KEY = Symbol.for("fazerai.driftFloor");

function floorSlot(): { reading: DriftFloorReading | null } {
  const g = globalThis as unknown as Record<
    symbol,
    { reading: DriftFloorReading | null }
  >;
  g[FLOOR_KEY] ??= { reading: null };
  return g[FLOOR_KEY];
}

export function driftFloorReading(): DriftFloorReading | null {
  return floorSlot().reading;
}

// Test-only.
export function resetDriftFloorForTest(): void {
  floorSlot().reading = null;
}

export async function databaseScreenTick(
  now: number,
  base: PrismaClient = instanceHealthPrisma,
): Promise<number> {
  const deadline = Date.now() + TICK_BUDGET_MS;
  try {
    await flushStatementTimeouts(
      base,
      undefined,
      undefined,
      Math.min(FLUSH_SHARE_MS, Math.max(1, deadline - Date.now())),
    );
  } catch (err) {
    // The flush keeps what it could not store; it is not what the drift signal measures.
    logger.warn({ err }, "database screen: statement timeouts not stored");
  }
  await snapshotIfDue(base, now, { budget: budgetUntil(deadline) });
  const availability = lastAvailability();
  if (availability?.available === false) {
    if (availability.reason === "unreadable") {
      // The extension is there and the read failed: a failure like any other, not an absence.
      throw new Error("pg_stat_statements could not be read");
    }
    // Nothing to measure without the extension: the signal reads 0 and names nothing.
    setSignalDetail(DRIFT_SIGNAL, null);
    floorSlot().reading = null;
    return 0;
  }
  const { pct, query, meanMs, budgetMs, minCalls, leftOut, leftOutCount } =
    await slowestMeanShare(base, now, undefined, budgetUntil(deadline));
  setSignalDetail(
    DRIFT_SIGNAL,
    query ? driftFacts(query, meanMs, budgetMs) : null,
  );
  floorSlot().reading = { minCalls, leftOut, leftOutCount };
  return pct;
}
