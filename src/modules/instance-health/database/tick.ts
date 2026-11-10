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

// What a tick left out for too few calls. It is keyed by the tick's `now`, which is the `at` of the
// point the sampler records from that tick's value, so a reader pairs a value with its own list even
// while the next tick is running or has finished and its point is not recorded yet.
export interface DriftFloorReading {
  minCalls: number;
  leftOut: DriftLeftOutDto[];
  leftOutCount: number;
}

// The recent ticks kept: a reader holding a value can be at most a tick or two behind the newest.
const FLOOR_READINGS = 3;
const FLOOR_KEY = Symbol.for("fazerai.driftFloor");

function floorReadings(): Map<number, DriftFloorReading> {
  const g = globalThis as unknown as Record<
    symbol,
    Map<number, DriftFloorReading>
  >;
  g[FLOOR_KEY] ??= new Map();
  return g[FLOOR_KEY];
}

function keepFloorReading(at: number, reading: DriftFloorReading): void {
  const m = floorReadings();
  m.set(at, reading);
  while (m.size > FLOOR_READINGS) {
    const oldest = Math.min(...m.keys());
    m.delete(oldest);
  }
}

// The list of the tick whose value was recorded at `at`; null when no kept tick produced it.
export function driftFloorReading(at: number | null): DriftFloorReading | null {
  return at === null ? null : (floorReadings().get(at) ?? null);
}

// Test-only.
export function resetDriftFloorForTest(): void {
  floorReadings().clear();
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
    return 0;
  }
  const { pct, query, meanMs, budgetMs, minCalls, leftOut, leftOutCount } =
    await slowestMeanShare(base, now, undefined, budgetUntil(deadline));
  setSignalDetail(
    DRIFT_SIGNAL,
    query ? driftFacts(query, meanMs, budgetMs) : null,
  );
  keepFloorReading(now, { minCalls, leftOut, leftOutCount });
  return pct;
}
