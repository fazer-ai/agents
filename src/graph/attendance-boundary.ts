import type { BaseMessage } from "@langchain/core/messages";
import { lastStampedConversationId } from "./markers";

// Decides, for every writer of a contact's memory thread (the reactive turn in ./runtime.ts,
// ./ingest.ts, and a nudge in ./nudge.ts), whether a new attendance gets a divider, whether the
// sidecar marker advances, and which attendance just ended and is compactable. Any of the three can be
// the first activity of a new conversation, and a writer that skips this lands its message on the far
// side of the next boundary, summarized away with the previous attendance. Pure, so the decision is one
// table of cases instead of a copy inside each writer's transaction.

export interface AttendanceBoundaryInput {
  // AgentThread.lastConversationId, read BEFORE this writer takes its own in-flight claim: what
  // matters is whether some OTHER invoke is mid-flight, not this one.
  previousConversationId: number | null;
  // The conversation the message about to be written belongs to.
  conversationId: number;
  anotherInvokeIsReading: boolean;
  // Whether the channel already carries a message stamped with `conversationId`. Only consulted in
  // the case needsAttendanceStartProbe reports; pass false when it says no probe is needed.
  attendanceAlreadyStarted: boolean;
}

export interface AttendanceBoundaryClaim {
  // Prepend the fresh-attendance divider to what is being written (prompt content only).
  writeDivider: boolean;
  // Move AgentThread.lastConversationId to `conversationId`. False means leave it exactly as it is.
  advanceMarker: boolean;
  // The attendance that just ended, to arm compaction for. Null when none did.
  closedConversationId: number | null;
}

// Whether the attendance is already under way on the thread (the "already started" case of
// claimAttendanceBoundary). Asks the LAST stamped run, not the whole history: a reopened conversation
// also appears earlier, and reading that as started would present the first turn of a new attendance
// as a continuation of the conversation in between. The stamp is inert to the model; only the divider
// is read.
export function attendanceHasStarted(
  messages: BaseMessage[],
  conversationId: number,
): boolean {
  return lastStampedConversationId(messages) === conversationId;
}

// Whether this message may move the boundary at all, asked before claimAttendanceBoundary. Ingestion
// accepts out-of-order ids (./ingest-dedup.ts), so a delayed message from an attendance already over
// would otherwise write its divider, walk the marker back, and compact the conversation still served.
// The frontier is the newest mark from EITHER direction, not the writer's own role: after a takeover
// opens the next conversation, the customer's own mark still sits in the old one. Chatwoot message ids
// increase per account, so both directions compare; a null mark is absent, not zero. Known limit: a
// nudge leaves no inbound id, so an attendance opened only by a nudge can be claimed back by a delayed
// message, accepted over a fourth input that every other path would carry.
export function movesAttendanceFrontier(
  marks: readonly (number | null | undefined)[],
  messageId: number,
): boolean {
  const frontier = marks.reduce<number | null>(
    (hi, m) => (m == null ? hi : hi === null ? m : Math.max(hi, m)),
    null,
  );
  return frontier === null || messageId >= frontier;
}

export function crossesAttendanceBoundary(
  previousConversationId: number | null,
  conversationId: number,
): boolean {
  return (
    previousConversationId !== null && previousConversationId !== conversationId
  );
}

// Reading the channel to answer `attendanceAlreadyStarted` costs a checkpointer round-trip, and it
// only changes the answer in one case. Callers ask this first and skip the read otherwise.
export function needsAttendanceStartProbe(
  previousConversationId: number | null,
  conversationId: number,
  anotherInvokeIsReading: boolean,
): boolean {
  return (
    crossesAttendanceBoundary(previousConversationId, conversationId) &&
    !anotherInvokeIsReading
  );
}

export function claimAttendanceBoundary(
  input: AttendanceBoundaryInput,
): AttendanceBoundaryClaim {
  const {
    previousConversationId: previous,
    conversationId,
    anotherInvokeIsReading,
    attendanceAlreadyStarted,
  } = input;

  // NOTE: no marker yet, so nothing ended and there is nothing for a divider to separate. The row
  // still has to exist: resolve-time compaction reads it to know which attendance the thread is on.
  if (previous === null) {
    return {
      writeDivider: false,
      advanceMarker: true,
      closedConversationId: null,
    };
  }

  // NOTE: same attendance, already recorded. The marker is written only when it would change.
  if (previous === conversationId) {
    return {
      writeDivider: false,
      advanceMarker: false,
      closedConversationId: null,
    };
  }

  // NOTE: an invoke is a read-modify-write of the whole message channel, so a divider written under
  // another one is erased while the advanced marker spends the one chance to write it. Defer both and
  // let the next writer land it. Compaction is armed anyway: the cut reads each message's stamp
  // (./markers.ts), never the divider, and the ended attendance must not wait on a writer that may
  // never come. The direct webhook turn waits other invokes out instead, and the `previous ===
  // conversationId` branch keeps it from writing a second divider.
  if (anotherInvokeIsReading) {
    return {
      writeDivider: false,
      advanceMarker: false,
      closedConversationId: previous,
    };
  }

  // NOTE: a boundary deferred above leaves the marker on the old conversation, so a later writer of
  // the same conversation can find this attendance already in the thread. A divider can only be
  // appended and would mark part of the live conversation as past: a hint in the wrong place is worse
  // than none, and skipping it costs the prompt only.
  return {
    writeDivider: !attendanceAlreadyStarted,
    advanceMarker: true,
    closedConversationId: previous,
  };
}
