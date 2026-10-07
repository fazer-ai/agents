import type { BaseMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { stampedSentAt } from "@/graph/markers";
import { buildThreadStateGraph } from "@/graph/thread-state";
import { selectClosedPrefix } from "./cut";

// Where the CURRENT attendance starts, for a reader outside the contact's memory thread (carrying the
// customer's files into a case, ../cross-inbox-case). Read off the thread with the same cut compaction
// uses, so the two never disagree: the earliest instant stamped on the open attendance's messages.
// Not the summary rows' dates: those date the conversation's last event when the job ran, which can be
// after the customer came back. Null when the open attendance carries no instant: the whole
// conversation then reads as current.
export function openAttendanceStart(messages: BaseMessage[]): Date | null {
  const { open } = selectClosedPrefix(messages, {
    currentAttendanceClosed: false,
  });
  let first: Date | null = null;
  for (const m of open) {
    const at = stampedSentAt(m);
    if (at && (first === null || at < first)) first = at;
  }
  return first;
}

export async function attendanceStartedAt(
  checkpointer: BaseCheckpointSaver,
  p: { tenantId: bigint; instanceId: bigint; contactInboxId: number },
): Promise<Date | null> {
  const state = await buildThreadStateGraph(checkpointer).getState({
    configurable: {
      thread_id: contactInboxThreadId(
        p.tenantId,
        p.instanceId,
        p.contactInboxId,
      ),
    },
  });
  const messages =
    (state.values as { messages?: BaseMessage[] } | undefined)?.messages ?? [];
  return openAttendanceStart(messages);
}
