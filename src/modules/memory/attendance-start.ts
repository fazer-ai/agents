import type { BaseMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { isMemoryHead, stampedSentAt } from "@/graph/markers";
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
    const at = stampedSentAt(m);
    if (at && (first === null || at < first)) first = at;
  }
  return first;
}

export async function attendanceStartedAt(
  deps: { checkpointer: BaseCheckpointSaver; base: PrismaClient },
  p: { tenantId: bigint; instanceId: bigint; contactInboxId: number },
): Promise<Date | null> {
  const state = await buildThreadStateGraph(deps.checkpointer).getState({
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
