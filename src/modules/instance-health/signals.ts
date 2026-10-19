import { intRange, numberRange } from "@/lib/number-range";
import {
  JOB_DELETE_ON_DONE,
  JOB_LANE,
  type SchedulerLane,
} from "@/modules/scheduler/lanes";
import type { SchedulerJobKind } from "@/modules/scheduler/service";

// What an operator may set on a signal. The threshold is in the signal's own unit (ms, a count, a rate),
// so it has a floor and no ceiling; the duration is the "for Y seconds" half.
export const INSTANCE_THRESHOLD_RANGES = {
  threshold: numberRange(0, Number.POSITIVE_INFINITY),
  durationSeconds: intRange(0, 3600),
} as const;

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
  // Whether it alerts before a super admin says otherwise; absent means it does.
  defaultEnabled?: boolean;
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

// The kinds whose row is deleted on DONE, so the table keeps no record that they ran:
// for these the process counts what finished and failed, and how long due work has gone without a
// completion. A kind that keeps its DONE row is not here: its rows already say what ran.
export const THROUGHPUT_KINDS = (
  Object.entries(JOB_DELETE_ON_DONE) as [SchedulerJobKind, boolean][]
)
  .filter(([, deleted]) => deleted)
  .map(([kind]) => kind);

export function schedulerDoneSignal(kind: SchedulerJobKind): string {
  return `scheduler_done_per_min:${kind}`;
}

export function schedulerFailedSignal(kind: SchedulerJobKind): string {
  return `scheduler_failed_per_min:${kind}`;
}

export function schedulerStalledSignal(kind: SchedulerJobKind): string {
  return `scheduler_stalled_ms:${kind}`;
}

// The kind a throughput signal is about, and which of the three it is.
export function throughputOfSignal(
  key: string,
): { kind: SchedulerJobKind; measure: "done" | "failed" | "stalled" } | null {
  const m =
    /^scheduler_(done_per_min|failed_per_min|stalled_ms):([A-Z_]+)$/.exec(key);
  if (!m || !THROUGHPUT_KINDS.includes(m[2] as SchedulerJobKind)) return null;
  const measure =
    m[1] === "done_per_min"
      ? "done"
      : m[1] === "failed_per_min"
        ? "failed"
        : "stalled";
  return { kind: m[2] as SchedulerJobKind, measure };
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
  // Debounce flushes due and not yet claimed. Each sample counts whichever flush fell due since the
  // last claim, so steady traffic keeps it at 1 or 2 with every job claimed within a second: it is
  // there to read and starts muted. A customer actually waiting pages through the debounce lane's
  // queue age and `debounce_lane_full_ms`.
  {
    name: "debounce_waiters",
    unit: "count",
    defaultThreshold: 0,
    defaultDurationSeconds: 30,
    source: "database",
    defaultEnabled: false,
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
  // Per kind deleted on DONE: the two rates are there to read, not to page on (a busy queue completes
  // a lot, and a failure already reaches the tenant's dead-letter line once retries run out), so they
  // start muted. The stall is what tells a stuck queue from a slow one, and it alerts at the ceiling
  // of the kind's lane.
  ...THROUGHPUT_KINDS.flatMap((kind): SignalDef[] => [
    {
      name: schedulerDoneSignal(kind),
      unit: "per_minute",
      defaultThreshold: 0,
      defaultDurationSeconds: 0,
      source: "process",
      defaultEnabled: false,
    },
    {
      name: schedulerFailedSignal(kind),
      unit: "per_minute",
      defaultThreshold: 0,
      defaultDurationSeconds: 0,
      source: "process",
      defaultEnabled: false,
    },
    {
      name: schedulerStalledSignal(kind),
      unit: "ms",
      defaultThreshold: LANE_DEFAULT_MS[JOB_LANE[kind]],
      defaultDurationSeconds: 0,
      source: "database",
    },
  ]),
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
