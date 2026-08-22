// Whether a message reaching continuous ingestion has already been folded into the thread.
//
// Pure and separate from the transaction around it, for the same reason as ./attendance-boundary.ts:
// it is a decision, and the wrong cell here is not a slow prompt. "Duplicate" on a message that is
// actually new is a customer's words missing from the memory the agent reads for the next twenty
// attendances, and nothing re-delivers them.
//
// WHY NOT A HIGH-WATER MARK, which is what this replaces (issue #194). A monotonic mark answers
// "have we seen this?" only while the ids reaching it arrive in order, and within one direction they
// do not: a message with media waits on the eager pass (a provider round-trip for STT/vision) before
// reaching ingestion and a text one waits on nothing, so the later message can be folded in first.
// The mark had then advanced past the earlier id, which read as already handled. It was not late, it
// was ABSENT.
//
// Membership answers exactly, for what it holds. What it cannot answer is anything older than the
// oldest id it still remembers, and that is the second verdict below.

// How many ids each direction remembers. The window has to exceed the reorder distance, which is
// bounded by the mechanism that causes it: the eager media pass is one provider round-trip, so the
// messages that can overtake a waiting one are the ones a contact sends inside that call. This is
// an order of magnitude above that, and its cost is 64 integers on a row already being read and
// written under the same lock.
//
// NOT chosen by measurement, and saying so is the point: if a reorder ever exceeds it, the symptom
// is the #194 symptom again on a much narrower path, and the fix is this number.
// RAISING THIS UN-SATURATES already-migrated rows. The migration that introduced the window filled
// each existing row to exactly 64 so the old watermark would keep acting as a floor, and a window
// wider than that reads those rows as partial again — which is the upgrade hazard that fill exists
// to close, returning for threads that have not yet ingested a cap's worth of messages. Lowering it
// is free. The migration cannot import this constant (it is frozen at the value that was true when
// it ran), so this note is the link between them.
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
  // Only a SATURATED window has forgotten anything, and only then does a low id become ambiguous.
  // Below saturation the set is the complete record of what this direction ingested, so anything
  // absent from it is genuinely new — including an id below the highest one, which is the whole
  // point. Using the minimum as a floor unconditionally would refuse exactly the message #194 is
  // about: the first two ingests on a fresh thread can already arrive inverted.
  if (recent.length >= INGEST_ID_WINDOW && messageId < Math.min(...recent)) {
    return "ancient";
  }
  return "new";
}

// The window after folding `messageId` in, capped by dropping the LOWEST id it holds.
//
// The first version of this dropped the oldest ARRIVAL instead, which reads better and is wrong. The
// floor `ingestVerdict` uses is the minimum of this set, and evicting by arrival lets that floor go
// BACKWARDS: a delayed low id (the case this whole change exists to accept) pushes out the highest
// id that happened to arrive first, and the floor drops to the delayed one. Every id between the two
// then stops being remembered while still reading as above the floor, so a re-delivery of one is
// classified `new` and appended a second time — the ordering fix handing the deduplication bug back.
//
// Dropping the lowest keeps the set equal to "the highest N ids seen", which makes the floor
// monotonic: inserting above it evicts the old minimum and raises the floor, and an id below the
// floor never gets inserted at all, because `ingestVerdict` already called it `ancient`.
export function rememberIngested(
  recent: readonly number[],
  messageId: number,
): number[] {
  const next = [...recent, messageId];
  if (next.length <= INGEST_ID_WINDOW) return next;
  // Only ONE has to go, and `indexOf` on the minimum drops a single copy — which is what the
  // migration's saturated fill depends on, since every one of its entries is the same id.
  const lowest = Math.min(...next);
  next.splice(next.indexOf(lowest), 1);
  return next;
}
