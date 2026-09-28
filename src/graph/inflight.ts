// In-memory registry of agent turns currently executing, keyed by thread id. A turn marks the
// per-conversation chatwoot thread (so the follow-up handler does not fire a nudge mid-turn, racing
// the reply) and the per-contact-inbox GRAPH thread (so compaction does not rewrite the channel under
// an invoke, a read-modify-write of the WHOLE channel that would undo it). The compaction key is
// marked INSIDE the `ingest:<graphThreadId>` lock the rewrite also holds, so the two are exclusive,
// not staggered. Across processes this is only the fast half: ./thread-claim.ts keeps the claim in the
// thread's row and this Map can only say MORE; a key with no row risks at worst one raced nudge or one
// re-armed compaction. Not durable: after a restart the sweep re-reads lastEventAt / lastFollowUpAt.

// Counted, not a set: two turns overlap on one thread (two deliveries racing with debounce off, a
// nudge on a reactive turn's memory thread), and with plain membership the first to finish releases
// the other's claim, letting a compaction rewrite a thread the surviving invoke then undoes.
const inFlight = new Map<string, number>();

// Reservations: a turn about to run on this thread that has not claimed it yet (a delivery recovery
// between its fence and `runAgentTurn`, ../modules/chatwoot/recover-delivery.ts). `isTurnInFlight`
// counts them: a /reset, append or compaction in that stretch is undone by the turn. Separate from
// `inFlight` because `markTurnOwning` must NOT see them: it asks whether ANOTHER invoke is reading, to
// defer the attendance divider, and the reserving caller IS the invoke about to run, so counting it
// would run a recovered first turn against the previous attendance with no divider.
const reserved = new Map<string, number>();

export function markTurnInFlight(threadId: string): void {
  inFlight.set(threadId, (inFlight.get(threadId) ?? 0) + 1);
}

// Hold the thread for a turn that has not started yet. Balanced by `clearTurnReserved`, and for the
// reason `clearTurnInFlight` gives: an unbalanced release hands the thread to a writer the reserving
// caller is about to undo.
export function markTurnReserved(threadId: string): void {
  reserved.set(threadId, (reserved.get(threadId) ?? 0) + 1);
}

export function clearTurnReserved(threadId: string): void {
  const left = (reserved.get(threadId) ?? 0) - 1;
  if (left > 0) reserved.set(threadId, left);
  else reserved.delete(threadId);
}

// Releases ONE claim. Callers must release exactly what they took: an unbalanced release is not a
// harmless no-op, it hands the thread to a compaction while another invoke is still reading it.
export function clearTurnInFlight(threadId: string): void {
  const left = (inFlight.get(threadId) ?? 0) - 1;
  if (left > 0) inFlight.set(threadId, left);
  else inFlight.delete(threadId);
}

// A third registry, deliberately invisible to the two questions above: the debounce flush excludes
// another flush between "is this thread free" and its turn's own claim. Not `markTurnReserved`,
// because `isTurnInFlight` counts reservations: `undoRefusedTurn` would skip every debounce rollback
// (leaving undelivered answers in memory) and `claimIngestWrite` would answer busy, so
// `drainPendingIngest` would reach none of the queued messages before the reply.
const flushHolds = new Map<string, number>();

export function markFlushHold(threadId: string): void {
  flushHolds.set(threadId, (flushHolds.get(threadId) ?? 0) + 1);
}

export function clearFlushHold(threadId: string): void {
  const left = (flushHolds.get(threadId) ?? 0) - 1;
  if (left > 0) flushHolds.set(threadId, left);
  else flushHolds.delete(threadId);
}

export function isFlushHeld(threadId: string): boolean {
  return (flushHolds.get(threadId) ?? 0) > 0;
}

// Either kind of hold: an invoke that is reading the thread, or a reservation for one that is about
// to. This is the answer every writer wants.
export function isTurnInFlight(threadId: string): boolean {
  return (inFlight.get(threadId) ?? 0) > 0 || (reserved.get(threadId) ?? 0) > 0;
}

// INVOKES ONLY. One caller wants this and it is not a writer: see the note on `reserved` above.
export function isTurnRunning(threadId: string): boolean {
  return (inFlight.get(threadId) ?? 0) > 0;
}
