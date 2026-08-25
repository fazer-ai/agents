// When the customer first spoke and when the team answered — the two ends of an attendance, decided
// once and away from the mirror's hot path so the rule can be read (and tested) as a table.
//
// Three facts make this more than "write the column if it is empty":
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
//
// The one row this deliberately treats as new is a conversation whose inbound watermark was cleared
// by `/reset` before the columns existed: it reads as never-tracked, and anchors on the next
// message. That is the start of a fresh attendance, which is what the number is about.

export interface StoredAttendance {
  firstInboundAt: Date | null;
  lastInboundAt: Date | null;
  firstHumanReplyAt: Date | null;
  lastHumanReplyAt: Date | null;
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

  // No legacy test on this side: nothing recorded a human reply before these columns, so there is
  // no stored fact to distinguish "first" from "first we saw". It costs nothing — the KPI requires
  // BOTH ends, and a legacy conversation never gets the inbound anchor above.
  if (seen.humanReplyAt !== null) {
    if (
      stored.firstHumanReplyAt === null ||
      seen.humanReplyAt < stored.firstHumanReplyAt
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
