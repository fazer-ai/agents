// When the customer first spoke and when the team answered — the two ends of an attendance, decided
// once and away from the mirror's hot path so the rule can be read (and tested) as a table.
//
// Four facts make this more than "write the column if it is empty":
//
//   1. A conversation that already existed when these columns were added has traffic we never
//      watermarked. Its next customer message is NOT its first, and dating it as one would drop a
//      mid-conversation interval into the response-time sample. `lastInboundAt` non-null with
//      `firstInboundAt` still null is exactly that row: every conversation seen from the start
//      writes the two together, so the pair distinguishes "not tracked yet" from "no inbound yet".
//   2. Chatwoot retries deliver out of order, and `decideConversationWrites` refuses a stale event
//      for the CONVERSATION STATE it carries. A message it mentions still happened, so the earliest
//      reading has to win even when it arrives last — otherwise the anchor is whichever delivery got
//      through first, and a set-once column never revises it.
//   3. "First" and "last" are an ordering, not an arrival order: first takes the EARLIEST reading
//      seen, last the LATEST.
//   4. A conversation can be opened by the BUSINESS. The team's message then precedes any customer
//      message, and is not an answer to one — so the first response is the first team message at or
//      after the inbound anchor, never simply the first one seen.
//
// Facts 2 and 4 pull in opposite directions, and that is why a team message is recorded TWICE. An
// anchorless team message is either the business opening the conversation (where a value would be
// measured backwards) or the customer's first message still in the retry ladder (where a value is
// exactly right), and nothing on this side tells the two rows apart. So the anchored reading answers
// "what was the first response" and the unanchored one answers "what is the earliest we saw"; the
// KPI prefers the first and falls back to the second only when the second is itself after the
// anchor, which is the condition that makes it an answer rather than an opener.
//
// WHERE THIS STOPS, and why it stops there. One shape survives both readings: a conversation the
// business opened AND whose first customer message was delivered after a reply. The opener is then
// the earliest team message, it is before the anchor, and the answer that followed it was never
// stored as anything but the team's LAST word — so the attendance is left out of the sample.
// Recovering it would mean keeping every team message reading until the anchor stops moving, and the
// anchor never provably stops moving; two columns is where an approximation of an event log ends and
// the event log itself begins. The failure is an omission and never a wrong duration, and it is
// visible: `firstResponseSampled` is reported beside the median so a sample smaller than the
// conversation count can be seen rather than assumed away.

export interface StoredAttendance {
  firstInboundAt: Date | null;
  lastInboundAt: Date | null;
  firstHumanReplyAt: Date | null;
  lastHumanReplyAt: Date | null;
  firstHumanMessageAt: Date | null;
}

export interface SeenAttendance {
  // The event's inbound reading, already gated by the caller (a brand-new incoming message that is
  // not a suppressed control command). Null when this event is not one.
  inboundAt: Date | null;
  // The event's human-reply reading (`isNewHumanAgentMessage`), or null.
  humanReplyAt: Date | null;
}

// Only the columns that must MOVE. An empty object means this event teaches the attendance nothing,
// and the caller can skip the write entirely.
export interface AttendanceWrites {
  firstInboundAt?: Date;
  firstHumanReplyAt?: Date;
  lastHumanReplyAt?: Date;
  firstHumanMessageAt?: Date;
}

export function decideAttendanceWatermarks(
  stored: StoredAttendance,
  seen: SeenAttendance,
): AttendanceWrites {
  const writes: AttendanceWrites = {};

  if (seen.inboundAt !== null) {
    if (stored.firstInboundAt !== null) {
      // Anchored already: an earlier reading lowers it, a later one is just another message.
      if (seen.inboundAt < stored.firstInboundAt)
        writes.firstInboundAt = seen.inboundAt;
    } else if (stored.lastInboundAt === null) {
      // Never watermarked an inbound on this conversation: this one is the first.
      writes.firstInboundAt = seen.inboundAt;
    }
    // else: fact 1 — traffic predates the columns, so this conversation gets no anchor, ever.
  }

  // What a reply is measured against. The stored anchor and nothing else: one event cannot carry
  // both readings — `inboundAt` is a new INCOMING message and `humanReplyAt` an OUTGOING one — so an
  // anchor written by this same call could never be the one a reply in it needs.
  const anchor = stored.firstInboundAt;

  if (seen.humanReplyAt !== null) {
    // Unanchored, and it is the record of WHAT WAS SEEN rather than a judgement about it: the
    // earliest team message, whatever it answered. It is what lets a conversation whose first
    // inbound was delivered late still be measured — see the KPI's fallback in analytics/service.ts.
    if (
      stored.firstHumanMessageAt === null ||
      seen.humanReplyAt < stored.firstHumanMessageAt
    ) {
      writes.firstHumanMessageAt = seen.humanReplyAt;
    }
    // Anchored: a first response is the first team message AT OR AFTER the customer's first, and a
    // BUSINESS-INITIATED conversation is why that has to be said: an operator writes first, the
    // customer answers a day later. Taking the opener would date the response before the message it
    // answers — and because the column is an anchor, every real answer afterwards is then too late
    // to replace it, so the conversation leaves the sample for good rather than for a day.
    if (
      anchor !== null &&
      seen.humanReplyAt >= anchor &&
      (stored.firstHumanReplyAt === null ||
        seen.humanReplyAt < stored.firstHumanReplyAt)
    ) {
      writes.firstHumanReplyAt = seen.humanReplyAt;
    }
    if (
      stored.lastHumanReplyAt === null ||
      seen.humanReplyAt > stored.lastHumanReplyAt
    ) {
      writes.lastHumanReplyAt = seen.humanReplyAt;
    }
  }

  return writes;
}
