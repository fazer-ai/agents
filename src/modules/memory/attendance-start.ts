import type { BaseMessage } from "@langchain/core/messages";
import { getCurrentTaskInput } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import { contactInboxThreadId } from "@/graph/checkpointer";
import {
  isMemoryHead,
  stampedBurstStart,
  stampedConversationId,
  stampedSentAt,
} from "@/graph/markers";
import { buildThreadStateGraph } from "@/graph/thread-state";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { selectClosedPrefix } from "./cut";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Where the CURRENT attendance starts, for a reader outside the contact's memory thread (carrying the
// customer's files into a case, ../cross-inbox-case). Read off the thread with compaction's own cut:
// the earliest instant stamped on the open attendance's messages. A summary row whose turns are still
// in the thread (its rewrite was deferred, ./compact.ts) ends an attendance too, so the open one never
// starts before the turn after its last. Not the rows' dates: those date the conversation's last event
// when the job ran, possibly after the customer came back. Null when the open attendance carries no
// instant: the whole conversation then reads as current.
export function openAttendanceStart(
  messages: BaseMessage[],
  owedLastMessageId: string | null = null,
): Date | null {
  const natural = selectClosedPrefix(messages, {
    currentAttendanceClosed: false,
  });
  const headOffset = messages[0] && isMemoryHead(messages[0]) ? 1 : 0;
  const owedIndex = owedLastMessageId
    ? messages.findIndex((m) => m.id === owedLastMessageId)
    : -1;
  const from = Math.max(
    headOffset + natural.closed.length,
    owedIndex >= headOffset ? owedIndex + 1 : 0,
  );
  let first: Date | null = null;
  for (const m of messages.slice(from)) {
    // Only a turn stamped with its conversation belongs to an attendance: a late message from an
    // earlier one is ingested with its date and without the stamp (../../graph/ingest.ts).
    if (stampedConversationId(m) === null) continue;
    // A coalesced turn starts where its burst did, not at the newest message it is dated by.
    const at = stampedBurstStart(m) ?? stampedSentAt(m);
    if (at && (first === null || at < first)) first = at;
  }
  return first;
}

// The running graph's own messages, when asked from inside one of its nodes (a tool call): the saver
// can lag the turn, which on the first turn after a compaction holds only the memory head. Null
// outside a graph run.
export function liveThreadMessages(): BaseMessage[] | null {
  try {
    const state = getCurrentTaskInput() as { messages?: unknown } | undefined;
    return Array.isArray(state?.messages)
      ? (state.messages as BaseMessage[])
      : null;
  } catch {
    return null;
  }
}

export async function attendanceStartedAt(
  deps: { checkpointer: BaseCheckpointSaver; base: PrismaClient },
  p: { tenantId: bigint; instanceId: bigint; contactInboxId: number },
): Promise<Date | null> {
  const messages =
    liveThreadMessages() ??
    (
      (
        await buildThreadStateGraph(deps.checkpointer).getState({
          configurable: {
            thread_id: contactInboxThreadId(
              p.tenantId,
              p.instanceId,
              p.contactInboxId,
            ),
          },
        })
      ).values as { messages?: BaseMessage[] } | undefined
    )?.messages ??
    [];
  const owed = await runScopedOn(deps.base, sysCtx(p.tenantId), (db) =>
    db.attendanceSummary.findFirst({
      where: {
        tenantId: p.tenantId,
        chatwootInstanceId: p.instanceId,
        contactInboxId: p.contactInboxId,
      },
      orderBy: { id: "desc" },
      select: { lastMessageId: true },
    }),
  );
  return openAttendanceStart(messages, owed?.lastMessageId ?? null);
}
