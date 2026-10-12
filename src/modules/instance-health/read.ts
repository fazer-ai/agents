import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { ForbiddenError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { listInstanceThresholds } from "./channels";
import { firingSignals } from "./evaluator";
import {
  DATABASE_EVERY_TICKS,
  HISTORY_MS,
  SAMPLE_INTERVAL_MS,
  type SamplePoint,
  snapshot,
} from "./sampler";
import {
  schedulerDoneSignal,
  schedulerFailedSignal,
  schedulerStalledSignal,
  signalDef,
  THROUGHPUT_KINDS,
} from "./signals";

// What the "Instance health" screen, the REST route and the MCP tool read: every signal's last
// value, its last hour, and the threshold it is held to.

export interface InstanceSignalDto {
  signal: string;
  unit: string;
  value: number | null;
  at: string | null;
  threshold: number;
  durationSeconds: number;
  enabled: boolean;
  firing: boolean;
  // The last value is older than its cadence allows: the read behind it is failing, so it is not current.
  stale: boolean;
  history: SamplePoint[];
}

export interface InstanceHealthDto {
  sampleIntervalMs: number;
  historyMs: number;
  // Whether this process samples at all (the sampler rides ALERT_WORKER_ENABLED).
  sampling: boolean;
  signals: InstanceSignalDto[];
  // Oldest due job per scheduler kind, in ms, for each lane card's breakdown.
  schedulerKinds: Record<string, number>;
  // Each pool's last reading beside its waiters signal: connections in use, idle, and how long the
  // oldest request for one has waited, in ms.
  pools: Record<
    string,
    { inUse: number; idle: number; waiting: number; oldestWaitMs: number }
  >;
  // Per kind deleted on DONE: what it finished and failed in the last minute, how
  // overdue its oldest due job is (null with none due), how long that due work has gone without a
  // completion, and the reading of the three together.
  schedulerThroughput: Record<string, KindThroughputDto>;
}

export type KindThroughputState = "idle" | "draining" | "stuck" | "unknown";

export interface KindThroughputDto {
  donePerMin: number | null;
  failedPerMin: number | null;
  oldestDueMs: number | null;
  stalledMs: number | null;
  state: KindThroughputState;
}

// A kind is stuck once due work has gone a whole rate window (the minute the per-minute counts cover)
// without a completion: zero completions with jobs due. Whether that alerts is the stalled signal's
// threshold, which waits longer by default.
export const STUCK_AFTER_MS = 60_000;

export function kindThroughputState(
  oldestDueMs: number | null,
  stalledMs: number | null,
): KindThroughputState {
  if (stalledMs === null) return "unknown";
  if (oldestDueMs === null) return "idle";
  return stalledMs >= STUCK_AFTER_MS ? "stuck" : "draining";
}

// A signal is stale after this many of its own refreshes went by without a new value.
const STALE_AFTER_MISSED = 3;

export function staleAfterMs(signal: string): number {
  const every =
    signalDef(signal)?.source === "database"
      ? SAMPLE_INTERVAL_MS * DATABASE_EVERY_TICKS
      : SAMPLE_INTERVAL_MS;
  return every * STALE_AFTER_MISSED;
}

// Old once its refresh is overdue, counted from its last reading, or from the sampler's first tick
// for a signal that never had one (a database read failing since boot), so it is not shown as fine.
function isStale(
  sampling: boolean,
  since: number | null,
  now: number,
  signal: string,
): boolean {
  return sampling && since !== null && now - since > staleAfterMs(signal);
}

// Every instance-level surface is the fleet's: a tenant principal is refused here as well as by
// the transport's role gate.
export function requireFleet(ctx: TenantContext | null): TenantContext {
  if (ctx?.role !== "SUPER_ADMIN") throw new ForbiddenError();
  return ctx;
}

export async function readInstanceHealth(
  sampling: boolean,
  base: PrismaClient = basePrisma,
  now: number = Date.now(),
): Promise<InstanceHealthDto> {
  const thresholds = await listInstanceThresholds(base);
  const snap = snapshot(now);
  const firing = new Set(firingSignals());
  const byKey = new Map(thresholds.map((t) => [t.signal, t]));
  return {
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    historyMs: HISTORY_MS,
    sampling,
    signals: snap.signals.map((s) => {
      const t = byKey.get(s.signal);
      return {
        signal: s.signal,
        unit: t?.unit ?? "count",
        value: s.value,
        at: s.at === null ? null : new Date(s.at).toISOString(),
        threshold: t?.threshold ?? 0,
        durationSeconds: t?.durationSeconds ?? 0,
        enabled: t?.enabled ?? true,
        firing: firing.has(s.signal),
        stale: isStale(sampling, s.at ?? snap.firstTickAt, now, s.signal),
        history: s.history,
      };
    }),
    schedulerKinds: Object.fromEntries(
      Object.entries(snap.schedulerKinds).map(([k, v]) => [
        k,
        Math.round(v ?? 0),
      ]),
    ),
    pools: snap.pools,
    schedulerThroughput: Object.fromEntries(
      THROUGHPUT_KINDS.map((kind) => {
        const value = (signal: string) =>
          snap.signals.find((s) => s.signal === signal)?.value ?? null;
        const stalledMs = value(schedulerStalledSignal(kind));
        const age = snap.schedulerKinds[kind];
        const oldestDueMs = age === undefined ? null : Math.round(age);
        return [
          kind,
          {
            donePerMin: value(schedulerDoneSignal(kind)),
            failedPerMin: value(schedulerFailedSignal(kind)),
            oldestDueMs,
            stalledMs,
            state: kindThroughputState(oldestDueMs, stalledMs),
          },
        ];
      }),
    ),
  };
}
