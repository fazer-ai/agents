import logger from "@/api/lib/logger";

// Graceful shutdown. On SIGTERM/SIGINT the lanes stop claiming, the work already started gets until the
// drain bound to finish, and what is still running at the bound is CUT: a claimed job is failed for
// retry through its own deadline path (src/modules/scheduler/worker.ts), so its row is PENDING when the
// process exits instead of CLAIMED until the reaper's stale window. The bound has to fit inside the
// orchestrator's stop grace period, or the SIGKILL lands first (docs/deploy.md, "Shutdown drains").
//
// The registry lives on globalThis, like the workers' holders, so `bun --hot` does not split it.

// Why a run was ended at the bound: written as the job's `last_error`.
export class ShutdownCutError extends Error {
  constructor(boundMs: number) {
    super(`shutdown: drain bound of ${boundMs}ms reached`);
    this.name = "ShutdownCutError";
  }
}

// How long the cut work gets to record its failure before the process exits anyway. One CAS update per
// job; past this the row is left to the reaper, which is where it would have been without the cut.
export const CUT_SETTLE_MS = 1_500;

interface Work {
  kind: string;
  cut?: (reason: Error) => void;
}

interface Holder {
  draining: boolean;
  seq: number;
  work: Map<number, Work>;
  idle: Set<() => void>;
  installed: boolean;
  options?: ShutdownOptions;
  // Set once the bound is reached: work registered after it is cut as it registers.
  cutReason?: Error;
}

const KEY = Symbol.for("fazerai.shutdown");

function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder>;
  g[KEY] ??= {
    draining: false,
    seq: 0,
    work: new Map(),
    idle: new Set(),
    installed: false,
  };
  return g[KEY];
}

// Registers one unit of work and returns its release, which is idempotent. `cut` is how the drain ends
// it at the bound; work without one is waited on and then abandoned.
export function beginWork(
  kind: string,
  cut?: (reason: Error) => void,
): () => void {
  const h = holder();
  const id = ++h.seq;
  h.work.set(id, { kind, cut });
  const reason = h.cutReason;
  if (reason && cut) queueMicrotask(() => cut(reason));
  return () => {
    if (!h.work.delete(id) || h.work.size > 0) return;
    for (const notify of [...h.idle]) notify();
  };
}

export async function trackWork<T>(
  kind: string,
  run: () => Promise<T>,
): Promise<T> {
  const end = beginWork(kind);
  try {
    return await run();
  } finally {
    end();
  }
}

// True from the signal on. The lane claims read it, so a tick already past its stop check claims
// nothing new.
export function isDraining(): boolean {
  return holder().draining;
}

export interface InFlight {
  total: number;
  byKind: Record<string, number>;
}

export function inFlightWork(): InFlight {
  const byKind: Record<string, number> = {};
  for (const { kind } of holder().work.values())
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  return { total: holder().work.size, byKind };
}

// Resolves true once nothing is registered, false when `ms` runs out first.
function waitIdle(ms: number): Promise<boolean> {
  const h = holder();
  if (h.work.size === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (idle: boolean) => {
      clearTimeout(timer);
      h.idle.delete(onIdle);
      resolve(idle);
    };
    const onIdle = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    h.idle.add(onIdle);
  });
}

export interface DrainResult {
  drained: boolean;
  waitedMs: number;
  // What was still running when the bound was reached (empty when it drained).
  stillRunning: InFlight;
  // Of those, what had not even recorded its cut when the process gave up waiting.
  unsettled: number;
}

export async function drainInFlight(opts: {
  boundMs: number;
  settleMs?: number;
}): Promise<DrainResult> {
  const h = holder();
  h.draining = true;
  const startedAt = Date.now();
  if (await waitIdle(opts.boundMs))
    return {
      drained: true,
      waitedMs: Date.now() - startedAt,
      stillRunning: { total: 0, byKind: {} },
      unsettled: 0,
    };
  const stillRunning = inFlightWork();
  const reason = new ShutdownCutError(opts.boundMs);
  h.cutReason = reason;
  for (const work of [...h.work.values()]) {
    try {
      work.cut?.(reason);
    } catch (err) {
      logger.warn({ err, kind: work.kind }, "shutdown: cutting a run failed");
    }
  }
  await waitIdle(opts.settleMs ?? CUT_SETTLE_MS);
  return {
    drained: false,
    waitedMs: Date.now() - startedAt,
    stillRunning,
    unsettled: h.work.size,
  };
}

export interface ShutdownOptions {
  // Stops every lane's timer. Runs first, before the drain.
  stop: () => void;
  boundMs: number;
  settleMs?: number;
  exit?: (code: number) => void;
}

function describe(inFlight: InFlight): string {
  return Object.entries(inFlight.byKind)
    .map(([kind, n]) => `${kind}=${n}`)
    .join(", ");
}

export async function shutdown(
  signal: string,
  opts: ShutdownOptions | undefined = holder().options,
): Promise<void> {
  const h = holder();
  if (!opts) return;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  if (h.draining) {
    const left = inFlightWork();
    logger.warn(
      "shutdown: %s during the drain, exiting now with %d still running (%s)",
      signal,
      left.total,
      describe(left),
    );
    exit(0);
    return;
  }
  opts.stop();
  const before = inFlightWork();
  logger.info(
    "shutdown: %s received, draining %d in flight (%s), bound %dms",
    signal,
    before.total,
    describe(before),
    opts.boundMs,
  );
  const result = await drainInFlight({
    boundMs: opts.boundMs,
    settleMs: opts.settleMs,
  });
  if (result.drained) {
    logger.info("shutdown: drained in %dms", result.waitedMs);
  } else {
    logger.warn(
      {
        stillRunning: result.stillRunning.total,
        byKind: result.stillRunning.byKind,
        unsettled: result.unsettled,
      },
      "shutdown: drain bound of %dms reached with %d still running (%s); cut for retry",
      opts.boundMs,
      result.stillRunning.total,
      describe(result.stillRunning),
    );
  }
  exit(0);
}

// Reached through the EventEmitter surface because `process.on("SIGTERM", …)` does not
// type-check. @types/node 25 declares `Process extends InternalEventEmitter<ProcessEventMap>`, so
// the signal handlers are INHERITED from an event map rather than declared as overloads, and
// bun-types 1.4.0 augments `NodeJS.Process` with an explicit `on(event: "memoryPressure", …)`. A
// member declared on the interface shadows the inherited one, so `on` narrows to "memoryPressure"
// alone. Under this tsconfig the literal call, `node:process`, a `NodeJS.Signals` cast,
// `addListener` and `once` all fail; only the EventEmitter surface compiles. Upstream bug in
// bun-types, not in this code — drop the cast once it declares these as overloads.
const processEvents = process as NodeJS.EventEmitter;

// Idempotent across `bun --hot` reloads: the listeners are added once and read the latest options.
export function installShutdownHandlers(opts: ShutdownOptions): void {
  const h = holder();
  h.options = opts;
  if (h.installed) return;
  h.installed = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    processEvents.on(signal, () => {
      void shutdown(signal);
    });
  }
}

// Tests share one process: put the registry back to a process that never received a signal.
export function resetShutdownForTest(): void {
  const h = holder();
  h.draining = false;
  h.cutReason = undefined;
  h.work.clear();
  h.idle.clear();
  h.options = undefined;
}
