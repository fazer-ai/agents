import type { SchedulerJobKind } from "./service";

// What the scheduler finished and failed, per kind, over the last minute. A kind whose
// row is deleted on DONE (JOB_DELETE_ON_DONE) leaves nothing in `scheduler_jobs` once it ran, so
// without this a queue draining slowly and one that stopped look the same: both are just an aging
// oldest row. Per process, like the instance health sampler that reads it, and the scheduler runs on
// one replica (docs/deploy.md). Counted per second, so a burst costs one bucket and not one entry per
// job.

export type JobOutcome = "done" | "failed";

const WINDOW_MS = 60_000;
const BUCKET_MS = 1_000;

interface KindCounts {
  // Second (epoch ms / 1000) to count.
  done: Map<number, number>;
  failed: Map<number, number>;
  lastDoneAt: number | null;
}

const KEY = Symbol.for("fazerai.scheduler.throughput");

function registry(): Map<string, KindCounts> {
  const g = globalThis as unknown as Record<
    symbol,
    Map<string, KindCounts> | undefined
  >;
  g[KEY] ??= new Map();
  return g[KEY];
}

function countsOf(kind: string): KindCounts {
  const r = registry();
  let c = r.get(kind);
  if (!c) {
    c = { done: new Map(), failed: new Map(), lastDoneAt: null };
    r.set(kind, c);
  }
  return c;
}

function prune(buckets: Map<number, number>, now: number): void {
  const oldest = Math.floor((now - WINDOW_MS) / BUCKET_MS);
  // At most one entry per second of the window, so a full pass is cheap and needs no ordering.
  for (const second of buckets.keys()) {
    if (second <= oldest) buckets.delete(second);
  }
}

// A run that settled under its own claim: `done` when its outcome was written as finished, `failed`
// for a failure written or a claim the reaper took back. A superseded run or a revoked row is not an
// outcome of this kind's work and is never recorded.
export function recordJobOutcome(
  kind: SchedulerJobKind,
  outcome: JobOutcome,
  now: number = Date.now(),
): void {
  const c = countsOf(kind);
  const buckets = outcome === "done" ? c.done : c.failed;
  const second = Math.floor(now / BUCKET_MS);
  buckets.set(second, (buckets.get(second) ?? 0) + 1);
  prune(buckets, now);
  if (outcome === "done" && (c.lastDoneAt === null || now > c.lastDoneAt)) {
    c.lastDoneAt = now;
  }
}

export function jobsPerMinute(
  kind: SchedulerJobKind,
  outcome: JobOutcome,
  now: number = Date.now(),
): number {
  const c = registry().get(kind);
  if (!c) return 0;
  const buckets = outcome === "done" ? c.done : c.failed;
  prune(buckets, now);
  let n = 0;
  for (const count of buckets.values()) n += count;
  return n;
}

// When this process last finished a job of the kind; null before the first.
export function lastCompletedAt(kind: SchedulerJobKind): number | null {
  return registry().get(kind)?.lastDoneAt ?? null;
}

// Test-only: forget every count, as a restart does.
export function resetJobThroughput(): void {
  registry().clear();
}
