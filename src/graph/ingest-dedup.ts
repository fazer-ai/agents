// Whether a message reaching continuous ingestion has already been folded into the thread. Pure and
// apart from its transaction because the wrong cell is not a slow prompt: "duplicate" on a new message
// drops a customer's words from the agent's memory for good. Membership rather than a high-water mark:
// within one direction ids do not arrive in order (a media message waits on the eager STT/vision pass,
// a text one waits on nothing), so a mark would read the earlier, absent id as handled. Membership is
// exact for what it holds; what it cannot answer is anything older than its oldest id.

// How many ids each direction remembers. It has to exceed the reorder distance, the messages a
// contact sends inside one eager media round-trip; this is an order of magnitude above that, at 64
// integers on a row already read and written under the same lock. A judgement, not a measurement: a
// reorder past it drops a message on a narrow path, and the fix is this number. Raising it
// un-saturates migrated rows: the migration that introduced the window filled each to exactly 64 so
// the old watermark stays a floor, and it cannot import this constant. Lowering it is free.
export const INGEST_ID_WINDOW = 64;

export type IngestVerdict =
  // Never folded in. Append it.
  | "new"
  // Folded in already, and we still remember doing it. A genuine re-delivery.
  | "duplicate"
  // Older than the oldest id we still remember, on a window that has since forgotten things. Refused
  // rather than appended, because at this distance "not in the set" stops being evidence of anything.
  | "ancient";

export function ingestVerdict(
  recent: readonly number[],
  messageId: number,
): IngestVerdict {
  if (recent.includes(messageId)) return "duplicate";
  // NOTE: only a SATURATED window has forgotten anything. Below saturation the set is the complete
  // record, so an absent id is new even below the highest one; a floor applied unconditionally would
  // refuse a message that arrived inverted, which the first two ingests on a fresh thread can be.
  if (recent.length >= INGEST_ID_WINDOW && messageId < Math.min(...recent)) {
    return "ancient";
  }
  return "new";
}

// The window after folding `messageId` in, capped by dropping the LOWEST id, not the oldest arrival.
// The verdict's floor is this set's minimum, and evicting by arrival lets it go BACKWARDS: a delayed
// low id pushes out a high one, the ids between stop being remembered while reading as above the
// floor, and a re-delivery of one is appended twice. Keeping "the highest N ids seen" makes the floor
// monotonic: an id below it is never inserted, because `ingestVerdict` already called it `ancient`.
export function rememberIngested(
  recent: readonly number[],
  messageId: number,
): number[] {
  const next = [...recent, messageId];
  if (next.length <= INGEST_ID_WINDOW) return next;
  // Only ONE has to go, and `indexOf` on the minimum drops a single copy, which the migration's
  // saturated fill depends on, since every one of its entries is the same id.
  const lowest = Math.min(...next);
  next.splice(next.indexOf(lowest), 1);
  return next;
}
