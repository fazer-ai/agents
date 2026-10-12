import type { SchedulerLane } from "@/modules/scheduler/lanes";

// The instance's own load, as a closed list of signals (docs/logs.md, instance alerts). Each one is
// a number sampled by ./sampler.ts and compared, "above X for Y seconds", against its threshold: the
// default below, or the super admin's override in `instance_alert_thresholds`.

export type SignalUnit = "ms" | "count" | "per_minute";

export interface SignalDef {
  name: string;
  unit: SignalUnit;
  defaultThreshold: number;
  defaultDurationSeconds: number;
  // How often the sampler refreshes it. A database read is slower than an in-process counter.
  source: "process" | "database";
}

const LANES: SchedulerLane[] = ["shared", "debounce", "compaction", "observe"];

// A scheduler lane's default ceiling follows its cadence: debounce is a customer waiting for a
// reply, the shared lane runs sweeps with minutes of slack by design.
const LANE_DEFAULT_MS: Record<SchedulerLane, number> = {
  debounce: 30_000,
  observe: 60_000,
  shared: 300_000,
  compaction: 600_000,
};

export function schedulerQueueSignal(lane: SchedulerLane): string {
  return `scheduler_queue_age_ms:${lane}`;
}

// The database pools the process opens (src/lib/pool-stats.ts registers them under these names). The
// instance health sampler's own one-connection client is not among them: it is the measuring side.
export const POOL_NAMES = [
  "main",
  "background",
  "checkpointer",
  "ack",
  "metrics",
] as const;
export type PoolName = (typeof POOL_NAMES)[number];

export function poolWaitersSignal(pool: PoolName): string {
  return `pool_waiters:${pool}`;
}

export const SIGNALS: readonly SignalDef[] = [
  {
    name: "event_loop_p99_ms",
    unit: "ms",
    defaultThreshold: 200,
    defaultDurationSeconds: 30,
    source: "process",
  },
  {
    name: "model_permit_waiters",
    unit: "count",
    defaultThreshold: 0,
    defaultDurationSeconds: 30,
    source: "process",
  },
  {
    name: "model_permit_oldest_ms",
    unit: "ms",
    defaultThreshold: 30_000,
    defaultDurationSeconds: 0,
    source: "process",
  },
  {
    name: "debounce_lane_full_ms",
    unit: "ms",
    defaultThreshold: 30_000,
    defaultDurationSeconds: 0,
    source: "process",
  },
  {
    name: "ingress_lag_p95_ms",
    unit: "ms",
    defaultThreshold: 30_000,
    defaultDurationSeconds: 0,
    source: "process",
  },
  {
    name: "chatwoot_pending_oldest_ms",
    unit: "ms",
    defaultThreshold: 60_000,
    defaultDurationSeconds: 0,
    source: "database",
  },
  // Requests queued for a connection: any at all, held for 30 s, is a pool too small for its load.
  ...POOL_NAMES.map(
    (pool): SignalDef => ({
      name: poolWaitersSignal(pool),
      unit: "count",
      defaultThreshold: 0,
      defaultDurationSeconds: 30,
      source: "process",
    }),
  ),
  {
    name: "lock_timeouts_per_min",
    unit: "per_minute",
    defaultThreshold: 0,
    defaultDurationSeconds: 0,
    source: "process",
  },
  // Debounce flushes due and not yet claimed: a customer waiting for a reply the lane has no slot for.
  {
    name: "debounce_waiters",
    unit: "count",
    defaultThreshold: 0,
    defaultDurationSeconds: 30,
    source: "database",
  },
  ...LANES.map(
    (lane): SignalDef => ({
      name: schedulerQueueSignal(lane),
      unit: "ms",
      defaultThreshold: LANE_DEFAULT_MS[lane],
      defaultDurationSeconds: 0,
      source: "database",
    }),
  ),
];

const BY_KEY = new Map(SIGNALS.map((s) => [s.name, s]));

export function poolOfSignal(key: string): PoolName | null {
  const m = /^pool_waiters:(.+)$/.exec(key);
  return m && (POOL_NAMES as readonly string[]).includes(m[1] as string)
    ? (m[1] as PoolName)
    : null;
}

export function signalDef(key: string): SignalDef | undefined {
  return BY_KEY.get(key);
}

export function isSignalKey(key: string): boolean {
  return BY_KEY.has(key);
}
