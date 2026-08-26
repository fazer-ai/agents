// THE WRITES AN EMIT ONLY SCHEDULED, AND HOW A CALLER WAITS FOR THEM (issue #375).
//
// `emitFlowEvent` is fire-and-forget by design (see the header of ./service.ts): the hot WhatsApp
// path must not pay write latency for six log lines, and losing a line at process shutdown is
// acceptable for operational logging. The cost is that nothing downstream can tell "the write did
// not happen" from "the write has not landed yet", and one caller genuinely needs to: a test that
// EMPTIES `execution_logs` between cases. Its DELETE clears the rows that exist and nothing more, so
// the write the previous case only scheduled lands afterwards, into a table the current case
// believes it owns, and a reader ordered by `id asc` is handed that row FIRST.
//
// Measured on 8 full-suite runs of the base: one failure, in a case asserting what a REQUEUE logged,
// reading the death line of the case above it verbatim (`{ attempts: 9, deliveryId, event,
// subscriptionId }`). The same file passes 3 of 3 in isolation, because the write only loses the
// race on a loaded machine — so the symptom is a defect reported against a path where nothing is
// wrong, which is the expensive kind to diagnose from a CI log.
//
// Nothing in production calls `settleFlowEvents`, and that is a decision rather than an omission:
// the SIGTERM handler in src/index.ts exits synchronously. What this module adds is ORDERING for a
// caller that asks for it, exactly as `writeFlowEvent` does for a single line.

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
  // A loop rather than one `Promise.all`: settling a write can schedule another (a caller emitting
  // from a `.then`, an alert path that emits), and a set snapshotted once would return with that
  // second write still in flight — the exact state this exists to rule out.
  //
  // Each pass drops the entries it awaited, which is what makes the loop TERMINATE rather than
  // merely usually terminate: the removal above is then a fast path and not the only remover, so the
  // set shrinks by at least the snapshot on every pass. Written as a bare `while (size > 0)` it
  // spins forever the moment anything stops removing itself, and that was measured, not imagined —
  // with the removal deleted, the settle tests do not finish at all instead of failing.
  //
  // `allSettled` rather than `all` so this does not depend on the `.catch` above still being there:
  // a rejection is not this function's to report either way, because the caller asked for ordering
  // and not an outcome.
  while (scheduledWrites.size > 0) {
    const inFlight = [...scheduledWrites];
    await Promise.allSettled(inFlight);
    for (const write of inFlight) scheduledWrites.delete(write);
  }
}
