// Orders a console write that could not be versioned by the source's message sequence. Pure: the
// console stamps `consoleWriteMark`, the human-reply takeover's fence asks `consoleWriteLandedAfter`.
// A version cannot order it (a customer message advances `updated_at` on its own), a status claim
// would skip a real handover typed after the click, and a local clock dates our code, not the event.
// Every mark names a message that demonstrably existed, so the axis only ever fails low (a
// pre-click delivery let through), never high (a real handover skipped). Seed order, id allocation
// and the failed-read gap: docs/chatwoot.md, "A person answering the customer ends the attendance".

// The mark a console write leaves, from a live read it could not version. `null` (nothing to stamp)
// covers two facts the caller must not merge: the read failed, or the payload rendered no message
// list. Both leave the previous mark standing, which is safe because this axis only fails low.
export function consoleWriteMark(
  live: { latestMessageId: number | null } | null,
): number | null {
  return live?.latestMessageId ?? null;
}

// Did the console write land after the message that drove this delivery? At or below, not below:
// the mark names a message the source already had at the click, so a delivery carrying it is one the
// operator was looking at. Same boundary as `resetLandedAfter` for /reset.
export function consoleWriteLandedAfter(
  triggerMessageId: number | null,
  consoleWriteAtMessageId: number | null,
): boolean {
  // No mark is not evidence of anything: either no console write has been made unversioned here, or
  // the one that was could not read a message id. Neither says the delivery is stale.
  if (consoleWriteAtMessageId === null) return false;
  // NOTE: no trigger is a caller that named no message (a recovery of a ledger row without one, a
  // test). Refusing on an unknown would skip a takeover on no evidence at all.
  if (triggerMessageId === null) return false;
  return triggerMessageId <= consoleWriteAtMessageId;
}
