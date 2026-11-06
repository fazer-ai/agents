import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import instanceHealthPrisma from "@/api/lib/prisma-instance-health";
import {
  lastStatementTimeout,
  lockTimeoutsPerMinute,
  type PoolStat,
  poolStats,
  statementTimeoutsPerMinute,
} from "@/lib/pool-stats";
import { runWithWorkLabel } from "@/lib/work-label";
import { JOB_LANE, type SchedulerLane } from "@/modules/scheduler/lanes";
import type { SchedulerJobKind } from "@/modules/scheduler/service";
import {
  type JobOutcome,
  jobsPerMinute,
  lastCompletedAt,
} from "@/modules/scheduler/throughput";
import { DRIFT_SIGNAL, databaseScreenTick } from "./database/tick";
import { setSignalDetail, type TimeoutLine, timeoutDetail } from "./details";
import { evaluateSample, judge } from "./evaluator";
import { asFleetForInstanceHealth } from "./fleet-tx";
import { ingressLagP95 } from "./ingress";
import {
  FOLLOWUP_SWEEP_SIGNAL,
  POOL_NAMES,
  poolWaitersSignal,
  SIGNALS,
  schedulerDoneSignal,
  schedulerFailedSignal,
  schedulerQueueSignal,
  schedulerStalledSignal,
  THROUGHPUT_KINDS,
} from "./signals";
import { startInstanceAlertWorker, stopInstanceAlertWorker } from "./worker";

// Samples the instance's own load every 5 s (docs/logs.md, instance alerts) and keeps the last hour
// in memory, which a restart empties. In-process numbers are read on every tick; the two database
// reads run every third tick on their own one-connection client, so measuring a saturated main pool
// never waits on it. Single replica, like every other worker here.

export const SAMPLE_INTERVAL_MS = 5_000;
export const DATABASE_EVERY_TICKS = 3;
export const HISTORY_MS = 60 * 60 * 1000;

export interface SamplePoint {
  at: number;
  value: number;
}

export interface SignalSnapshot {
  signal: string;
  value: number | null;
  at: number | null;
  history: SamplePoint[];
}

// One tenant's follow-up sweep: how long since its last completed pass, in ms.
export interface FollowUpSweepReading {
  tenantId: string;
  tenantSlug: string;
  sinceCompletedMs: number;
}

export interface DatabaseReading {
  // Age in ms of the oldest due PENDING job, per kind; a kind with none is absent.
  kindAges: Partial<Record<SchedulerJobKind, number>>;
  // Every tenant's follow-up sweep row. Absent in a test that does not exercise it.
  followUpSweeps?: FollowUpSweepReading[];
  chatwootPendingOldestMs: number;
  // Debounce flushes due and not yet claimed.
  debounceWaiters?: number;
}

export interface SamplerSources {
  now: () => number;
  eventLoopP99Ms: () => number;
  modelPermitWaiters: () => number;
  modelPermitOldestMs: (now: number) => number;
  debounceLaneFullMs: (now: number) => number;
  ingressLagP95Ms: (now: number) => number;
  // Absent in a test that does not exercise them: no pools, no lock timeouts.
  pools?: (now: number) => PoolStat[];
  lockTimeoutsPerMinute?: (now: number) => number;
  // Statements cancelled by their budget in the last minute, and the last one (src/lib/pool-stats.ts).
  // Absent in a test that does not exercise them.
  statementTimeoutsPerMinute?: (now: number) => number;
  lastStatementTimeout?: (now: number) => TimeoutLine | null;
  // The database screen's share of the database half (./database/tick.ts): returns the drift
  // signal's value. Absent in a test that does not exercise it.
  databaseScreen?: (now: number) => Promise<number>;
  // What the scheduler finished and failed per kind (../scheduler/throughput.ts). Absent in a test
  // that does not exercise them: every kind reads as never having run.
  jobsPerMinute?: (
    kind: SchedulerJobKind,
    outcome: JobOutcome,
    now: number,
  ) => number;
  lastCompletedAt?: (kind: SchedulerJobKind) => number | null;
  readDatabase: () => Promise<DatabaseReading>;
}

interface SamplerState {
  series: Map<string, SamplePoint[]>;
  // The newest point per signal, kept past the hour the chart holds.
  last: Map<string, SamplePoint>;
  kindAges: Partial<Record<SchedulerJobKind, number>>;
  followUpSweeps: FollowUpSweepReading[];
  // Each pool's last reading, for the card that shows in use, idle and the oldest wait.
  pools: Record<string, Omit<PoolStat, "name">>;
  ticks: number;
  timer?: ReturnType<typeof setInterval>;
  histogram?: IntervalHistogram;
  // The database half of a tick is in flight; the process half never waits on it.
  running: boolean;
  // A database read came due while that half was busy: it runs with the next half that starts,
  // instead of waiting for the next tick that lands on the cadence.
  databaseDue: boolean;
  // When this process took its first sample: a signal that has had none since is overdue too.
  firstTickAt: number | null;
}

const KEY = Symbol.for("fazerai.instanceHealth.sampler");

function state(): SamplerState {
  const g = globalThis as unknown as Record<symbol, SamplerState | undefined>;
  g[KEY] ??= {
    series: new Map(),
    last: new Map(),
    kindAges: {},
    followUpSweeps: [],
    pools: {},
    ticks: 0,
    running: false,
    databaseDue: false,
    firstTickAt: null,
  };
  return g[KEY];
}

// Test-only: forget every point, as a restart does.
export function resetSamplerState(): void {
  const s = state();
  s.series = new Map();
  s.last = new Map();
  s.kindAges = {};
  s.followUpSweeps = [];
  s.pools = {};
  s.running = false;
  s.databaseDue = false;
  s.ticks = 0;
  s.firstTickAt = null;
}

function push(s: SamplerState, signal: string, at: number, value: number) {
  const points = s.series.get(signal) ?? [];
  points.push({ at, value });
  s.last.set(signal, { at, value });
  const cutoff = at - HISTORY_MS;
  let drop = 0;
  while (drop < points.length && (points[drop] as SamplePoint).at < cutoff) {
    drop++;
  }
  if (drop > 0) points.splice(0, drop);
  s.series.set(signal, points);
}

export function laneAgesOf(
  kindAges: Partial<Record<SchedulerJobKind, number>>,
): Record<SchedulerLane, number> {
  const out: Record<SchedulerLane, number> = {
    shared: 0,
    debounce: 0,
    compaction: 0,
    observe: 0,
  };
  for (const [kind, age] of Object.entries(kindAges)) {
    const lane = JOB_LANE[kind as SchedulerJobKind];
    if (lane && age !== undefined && age > out[lane]) out[lane] = age;
  }
  return out;
}

// How long a kind's due work has gone without a completion: 0 with nothing due, otherwise the time
// since the last completion, never longer than the oldest due row has waited (work that came due
// after the last completion has only waited since then) nor than this process has been sampling (a
// restart does not know what finished before it). A slow queue keeps it short however old its oldest
// row gets; a stuck one makes it grow with that row.
export function stalledMs(
  oldestDueMs: number | undefined,
  lastDoneAt: number | null,
  firstTickAt: number,
  now: number,
): number {
  if (oldestDueMs === undefined) return 0;
  const since = now - Math.max(lastDoneAt ?? firstTickAt, firstTickAt);
  return Math.max(0, Math.min(oldestDueMs, since));
}

// The in-process half of a tick: read, recorded and judged at once, never behind a database await.
function sampleProcess(
  sources: SamplerSources,
  now: number,
): Record<string, number> {
  const s = state();
  s.firstTickAt ??= now;
  const values: Record<string, number> = {
    event_loop_p99_ms: sources.eventLoopP99Ms(),
    model_permit_waiters: sources.modelPermitWaiters(),
    model_permit_oldest_ms: sources.modelPermitOldestMs(now),
    debounce_lane_full_ms: sources.debounceLaneFullMs(now),
    ingress_lag_p95_ms: sources.ingressLagP95Ms(now),
    lock_timeouts_per_min: sources.lockTimeoutsPerMinute?.(now) ?? 0,
    statement_timeouts_per_min: sources.statementTimeoutsPerMinute?.(now) ?? 0,
  };
  // The alert names the work and the statement behind the count, so it says what broke.
  const lastTimeout = sources.lastStatementTimeout?.(now) ?? null;
  setSignalDetail(
    "statement_timeouts_per_min",
    lastTimeout ? timeoutDetail(lastTimeout) : null,
  );
  for (const kind of THROUGHPUT_KINDS) {
    values[schedulerDoneSignal(kind)] =
      sources.jobsPerMinute?.(kind, "done", now) ?? 0;
    values[schedulerFailedSignal(kind)] =
      sources.jobsPerMinute?.(kind, "failed", now) ?? 0;
  }
  if (sources.pools) {
    const reported = new Map(sources.pools(now).map((p) => [p.name, p]));
    for (const name of POOL_NAMES) {
      // A pool opened on first use (the checkpointer's) and not used yet holds no connection and
      // queues nothing: that is a reading of zero, not a missing one.
      const { name: _, ...rest } = reported.get(name) ?? {
        name,
        inUse: 0,
        idle: 0,
        waiting: 0,
        oldestWaitMs: 0,
      };
      s.pools[name] = rest;
      values[poolWaitersSignal(name)] = rest.waiting;
    }
  }
  for (const [signal, value] of Object.entries(values)) {
    push(s, signal, now, Math.round(value));
  }
  judge(values, now);
  return values;
}

// The database half: the two reads when due, the thresholds and the deliveries. The tick's process
// readings are judged again once the thresholds are refreshed, so a limit changed since the last
// read never sends a delivery judged against the old one (a newer tick's judgement still wins).
async function sampleDatabase(
  sources: SamplerSources,
  now: number,
  withDatabase: boolean,
  processValues: Record<string, number>,
): Promise<Record<string, number>> {
  const s = state();
  const values: Record<string, number> = {};
  if (withDatabase) {
    try {
      const db = await sources.readDatabase();
      s.kindAges = db.kindAges;
      s.followUpSweeps = db.followUpSweeps ?? [];
      values.chatwoot_pending_oldest_ms = db.chatwootPendingOldestMs;
      values[FOLLOWUP_SWEEP_SIGNAL] = Math.max(
        0,
        ...s.followUpSweeps.map((f) => f.sinceCompletedMs),
      );
      values.debounce_waiters = db.debounceWaiters ?? 0;
      const lanes = laneAgesOf(db.kindAges);
      for (const [lane, age] of Object.entries(lanes)) {
        values[schedulerQueueSignal(lane as SchedulerLane)] = age;
      }
      for (const kind of THROUGHPUT_KINDS) {
        values[schedulerStalledSignal(kind)] = stalledMs(
          db.kindAges[kind],
          sources.lastCompletedAt?.(kind) ?? null,
          s.firstTickAt ?? now,
          now,
        );
      }
    } catch (err) {
      // An unreadable database leaves those signals at their last point; the gap is the evidence.
      logger.warn({ err }, "instance health: database signals unreadable");
    }
    if (sources.databaseScreen) {
      try {
        values[DRIFT_SIGNAL] = await sources.databaseScreen(now);
      } catch (err) {
        logger.warn({ err }, "instance health: database screen tick failed");
      }
    }
  }
  for (const [signal, value] of Object.entries(values)) {
    push(s, signal, now, Math.round(value));
  }
  await evaluateSample({ ...processValues, ...values }, now);
  return values;
}

// One tick, both halves awaited, so a test can drive ticks without a timer. Returns what was
// recorded.
export async function sampleOnce(
  sources: SamplerSources,
  opts: { database?: boolean } = {},
): Promise<Record<string, number>> {
  const s = state();
  const now = sources.now();
  const proc = sampleProcess(sources, now);
  const withDatabase = opts.database ?? s.ticks % DATABASE_EVERY_TICKS === 0;
  s.ticks++;
  const db = await sampleDatabase(sources, now, withDatabase, proc);
  return { ...proc, ...db };
}

// What the timer runs: the process half every tick, the database half only when the previous one
// has finished, so a slow database delays its own signals and the deliveries, never the rest.
export function tick(sources: SamplerSources): Promise<void> | null {
  const s = state();
  const now = sources.now();
  const proc = sampleProcess(sources, now);
  if (s.ticks % DATABASE_EVERY_TICKS === 0) s.databaseDue = true;
  s.ticks++;
  if (s.running) return null;
  s.running = true;
  const withDatabase = s.databaseDue;
  s.databaseDue = false;
  return sampleDatabase(sources, now, withDatabase, proc)
    .then(() => undefined)
    .catch((err) => logger.error({ err }, "instance health sample failed"))
    .finally(() => {
      s.running = false;
    });
}

export function snapshot(now: number = Date.now()): {
  signals: SignalSnapshot[];
  schedulerKinds: Partial<Record<SchedulerJobKind, number>>;
  followUpSweeps: FollowUpSweepReading[];
  pools: Record<string, Omit<PoolStat, "name">>;
  firstTickAt: number | null;
} {
  const s = state();
  const cutoff = now - HISTORY_MS;
  return {
    signals: SIGNALS.map((def) => {
      const history = (s.series.get(def.name) ?? []).filter(
        (p) => p.at >= cutoff && p.at <= now,
      );
      // The last reading outlives the chart: a read failing for over an hour is still stale, not blank.
      const kept = s.last.get(def.name);
      const last = kept && kept.at <= now ? kept : history[history.length - 1];
      return {
        signal: def.name,
        value: last?.value ?? null,
        at: last?.at ?? null,
        history,
      };
    }),
    schedulerKinds: { ...s.kindAges },
    followUpSweeps: [...s.followUpSweeps],
    pools: { ...s.pools },
    firstTickAt: s.firstTickAt,
  };
}

export async function readDatabaseSignals(
  base: PrismaClient = instanceHealthPrisma,
): Promise<DatabaseReading> {
  // Every age subtracts from `now() AT TIME ZONE 'UTC'`: the columns are UTC timestamps without a zone,
  // and `now() - <timestamp>` reads them in the session's zone, off by its offset outside UTC.
  return asFleetForInstanceHealth(base, async (db) => {
    const kinds = await db.$queryRaw<{ kind: string; age_ms: number }[]>`
      SELECT kind::text AS kind,
             (extract(epoch FROM (now() AT TIME ZONE 'UTC') - min(run_at)) * 1000)::float8 AS age_ms
        FROM scheduler_jobs
       WHERE status = 'PENDING' AND run_at <= now()
       GROUP BY kind`;
    const [pending] = await db.$queryRaw<{ age_ms: number | null }[]>`
      SELECT (extract(epoch FROM (now() AT TIME ZONE 'UTC') - min(received_at)) * 1000)::float8 AS age_ms
        FROM chatwoot_webhook_deliveries
       WHERE status = 'PENDING'`;
    const [debounce] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM scheduler_jobs
       WHERE kind = 'DEBOUNCE' AND status = 'PENDING' AND run_at <= now()`;
    // The pass's own completion stamp (../followups/handlers.ts writes `completedAt` on every pass that
    // finishes); a row from before the stamp existed counts from its last write when its budget is
    // whole (a completed pass clears it, and both a failure and a reaped claim spend it), else from its
    // creation. A DEAD row is never completing.
    const sweeps = await db.$queryRaw<
      { tenant_id: string; slug: string; since_ms: number }[]
    >`
      SELECT j.tenant_id::text AS tenant_id, t.slug,
             (extract(epoch FROM (now() AT TIME ZONE 'UTC') - COALESCE(
                CASE WHEN jsonb_typeof(j.payload->'completedAt') = 'number'
                     THEN to_timestamp((j.payload->>'completedAt')::float8 / 1000) AT TIME ZONE 'UTC' END,
                CASE WHEN j.attempts = 0 AND j.status <> 'DEAD' THEN j.updated_at END,
                j.created_at)) * 1000)::float8 AS since_ms
        FROM scheduler_jobs j
        JOIN tenants t ON t.id = j.tenant_id
       WHERE j.kind = 'FOLLOWUP_SWEEP'`;
    const kindAges: Partial<Record<SchedulerJobKind, number>> = {};
    for (const k of kinds) {
      kindAges[k.kind as SchedulerJobKind] = Math.max(0, Number(k.age_ms));
    }
    return {
      kindAges,
      followUpSweeps: sweeps.map((r) => ({
        tenantId: r.tenant_id,
        tenantSlug: r.slug,
        sinceCompletedMs: Math.max(0, Number(r.since_ms)),
      })),
      chatwootPendingOldestMs: Math.max(0, Number(pending?.age_ms ?? 0)),
      debounceWaiters: Number(debounce?.n ?? 0),
    };
  });
}

function defaultSources(histogram: IntervalHistogram): SamplerSources {
  return {
    now: () => Date.now(),
    eventLoopP99Ms: () => {
      // Nanoseconds, and reset per sample so each point is that interval's p99.
      const p99 = histogram.percentile(99) / 1e6;
      histogram.reset();
      return Number.isFinite(p99) ? p99 : 0;
    },
    modelPermitWaiters: () => modelSem().waiting,
    modelPermitOldestMs: (now) => modelSem().oldestWaitMs(now),
    debounceLaneFullMs: (now) => debounceFull(now),
    ingressLagP95Ms: (now) => ingressLagP95(now),
    pools: (now) => poolStats(now),
    lockTimeoutsPerMinute: (now) => lockTimeoutsPerMinute(now),
    statementTimeoutsPerMinute: (now) => statementTimeoutsPerMinute(now),
    lastStatementTimeout: (now) => lastStatementTimeout(now),
    databaseScreen: (now) => databaseScreenTick(now),
    jobsPerMinute: (kind, outcome, now) => jobsPerMinute(kind, outcome, now),
    lastCompletedAt: (kind) => lastCompletedAt(kind),
    readDatabase: () => readDatabaseSignals(),
  };
}

// Resolved lazily, so importing this module does not build the model semaphore or the debounce
// worker's state before config is read.
let modelSem: () => { waiting: number; oldestWaitMs(now: number): number } =
  () => ({ waiting: 0, oldestWaitMs: () => 0 });
let debounceFull: (now: number) => number = () => 0;

// The sampler's ticks run as `instance-health:sampler`: the label is entered where the timer is created, so every pass
// inherits it, and a statement that times out in one names this work (docs/logs.md, "Database").
export function startInstanceHealthSampler(): Promise<void> {
  return runWithWorkLabel("instance-health:sampler", async () => {
    const s = state();
    if (s.timer) return;
    const { modelSemaphore } = await import("@/graph/model-limit");
    const { debounceLaneFullMs } = await import("@/modules/debounce/worker");
    modelSem = modelSemaphore;
    debounceFull = debounceLaneFullMs;
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    s.histogram = histogram;
    const sources = defaultSources(histogram);
    s.timer = setInterval(() => {
      try {
        void tick(sources);
      } catch (err) {
        logger.error({ err }, "instance health sample failed");
      }
    }, SAMPLE_INTERVAL_MS);
    s.timer.unref?.();
    startInstanceAlertWorker();
    logger.info(
      "Instance health sampler started (every %dms)",
      SAMPLE_INTERVAL_MS,
    );
  });
}

export function stopInstanceHealthSampler(): void {
  stopInstanceAlertWorker();
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = undefined;
  s.histogram?.disable();
  s.histogram = undefined;
}
