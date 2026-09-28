// The writes `emitFlowEvent` only scheduled, and how a caller waits for them. The emit is
// fire-and-forget (see ./service.ts), so nothing can tell "did not happen" from "not landed yet". A
// test that empties `execution_logs` between cases needs to: a write scheduled by the previous case
// can land after the DELETE and be read first. Production never calls `settleFlowEvents` (the
// SIGTERM handler exits synchronously); this adds ORDERING for a caller that asks, as
// `writeFlowEvent` does.

const scheduledWrites = new Set<Promise<unknown>>();

// Every scheduled emit passes through here, which is what makes the set complete rather than a
// sample. The `.catch` is not decoration: `writeFlowEvent` swallows its own failures, so this only
// covers a rejection from outside that contract, and without it TRACKING a promise would turn a
// scheduled emit into an unhandled rejection — a hazard the bare `void` it replaced did not have.
export function trackFlowWrite(write: Promise<unknown>): void {
  const tracked = write
    .catch(() => undefined)
    .finally(() => {
      scheduledWrites.delete(tracked);
    });
  scheduledWrites.add(tracked);
}

// How many emits are scheduled and have not landed. Exists for the guard on the removal above, which
// is the ONLY thing that keeps the set from growing in production: nothing there settles, so a write
// that stopped removing itself would leak one entry per log line for the life of the process, and
// the settle loop's own cleanup would never run to hide it.
export function scheduledFlowWrites(): number {
  return scheduledWrites.size;
}

export async function settleFlowEvents(): Promise<void> {
  // NOTE: A loop, because settling a write can schedule another. Each pass drops the entries it
  // awaited, so the loop terminates even if an entry stops removing itself. `allSettled` because a
  // rejection is not this function's to report: the caller asked for ordering, not an outcome.
  while (scheduledWrites.size > 0) {
    const inFlight = [...scheduledWrites];
    await Promise.allSettled(inFlight);
    for (const write of inFlight) scheduledWrites.delete(write);
  }
}
