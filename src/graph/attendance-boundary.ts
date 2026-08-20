import type { BaseMessage } from "@langchain/core/messages";
import { lastStampedConversationId } from "./markers";

// WHO CONSUMES AN ATTENDANCE BOUNDARY, decided once for every writer of a contact's memory thread.
//
// Three places write that thread: the reactive turn (./runtime.ts), the ingestion of a message the
// agent did not answer (./ingest.ts), and a proactive nudge (./nudge.ts). Any of the three can be the
// FIRST activity of a new conversation on a thread that already carries the previous one, so all
// three face the same three questions: does a divider go in, does the sidecar marker advance, and
// which attendance just ended and is now compactable.
//
// The rule lived inline in two of them, in copies that had drifted in wording but not in substance.
// The third never had it, and that is the defect this module exists to make impossible: a proactive
// nudge entered the thread with no stamp and no marker advance, so the boundary of the NEXT reactive
// turn landed AFTER it and the nudge — with the reply it produced — was summarized away as part of
// the previous attendance.
//
// Pure on purpose, same reason as ./history-window.ts and ../modules/memory/cut.ts: this is a
// decision, and a decision belongs in a table of cases rather than in three copies inside three
// different transactions.
//
// THE TWO CASES THAT MAKE IT MORE THAN `previous !== current`:
//
//   1. AN INVOKE IS ALREADY READING THE THREAD. An invoke is a read-modify-write of the WHOLE message
//      channel: it saves the state it loaded plus its own messages, erasing anything that landed
//      meanwhile. A divider written under one is erased — while the marker row recording "we already
//      wrote it" would advance for good, spending the one chance to write it. So a boundary crossed
//      while another invoke is in flight is NOT consumed here: the marker stays put and the next
//      writer lands the divider with nothing in the way.
//   2. THE ATTENDANCE HAS ALREADY STARTED. A boundary deferred by case 1 leaves the marker on the OLD
//      conversation, so the next writer of the SAME conversation still sees a boundary — by which
//      time messages of this attendance are already in the thread. A divider can only be APPENDED, so
//      it would land after them and tell the model that part of the conversation it is in the middle
//      of is a past attendance. A hint in the wrong place is worse than no hint.
//
// Both cases cost the PROMPT only. The cut reads the conversation stamped on each message
// (./markers.ts), never the divider, so a divider that never lands loses a hint in one prompt and
// never an attendance. Which is also why compaction is armed in EVERY boundary case, including the
// two that write nothing: the attendance that just ended is compactable right now, and withholding
// the arm would make it wait on a next writer that may never come.

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

// Whether the attendance is already under way ON THE THREAD, which is what decides case 2 above.
// Asked of the LAST stamped run and not of the whole history: a reopened conversation appears earlier
// too, and reading that as "already started" made every writer skip the divider for an attendance
// that had genuinely just begun — presenting its first turn to the model as a continuation of the
// conversation that ran in between. The stamp itself is inert to the model; the divider is the only
// part it reads.
export function attendanceHasStarted(
  messages: BaseMessage[],
  conversationId: number,
): boolean {
  return lastStampedConversationId(messages) === conversationId;
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

  // A thread with no marker yet: nothing ended, and there is no previous attendance for a divider to
  // separate this one from. The row still has to come into existence — resolve-time compaction reads
  // it to know which attendance the thread is on, and finds nothing to do without it.
  if (previous === null) {
    return {
      writeDivider: false,
      advanceMarker: true,
      closedConversationId: null,
    };
  }

  // Same attendance, already recorded. The marker is written only when it would change.
  if (previous === conversationId) {
    return {
      writeDivider: false,
      advanceMarker: false,
      closedConversationId: null,
    };
  }

  // Case 1 in the header: defer the divider AND the marker, arm compaction anyway.
  if (anotherInvokeIsReading) {
    return {
      writeDivider: false,
      advanceMarker: false,
      closedConversationId: previous,
    };
  }

  // Case 2 in the header: consume the boundary, but a divider would land in the wrong place.
  return {
    writeDivider: !attendanceAlreadyStarted,
    advanceMarker: true,
    closedConversationId: previous,
  };
}
