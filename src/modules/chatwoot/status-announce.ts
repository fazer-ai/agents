import logger from "@/api/lib/logger";
import type { ScopedDb } from "@/lib/tenancy";
import { emitOutbound } from "@/modules/webhooks/outbound/service";

// The durable `conversation.status_changed`, emitted by whichever write moves the mirror's status
// first: the source's event for that transition reaches the mirror afterwards and finds nothing to
// announce, so this keeps it to one per transition. Best-effort inside the caller's transaction, under
// a savepoint: a failed statement aborts the whole transaction in Postgres, so catching the error alone
// would still roll back the write being announced. Ids and statuses only. docs/chatwoot.md has the writers.
export async function announceStatusChange(
  db: ScopedDb,
  tenantId: bigint,
  p: {
    conversationId: bigint;
    inboxId: bigint | null;
    status: string;
    previousStatus: string;
    assigneeType: string | null;
  },
): Promise<void> {
  if (p.status === p.previousStatus) return;
  await db.$executeRawUnsafe("SAVEPOINT announce_status_change");
  try {
    await emitOutbound(db, tenantId, "conversation.status_changed", {
      conversation_id: String(p.conversationId),
      inbox_id: p.inboxId != null ? String(p.inboxId) : null,
      status: p.status,
      previous_status: p.previousStatus,
      assignee_type: p.assigneeType,
    });
    await db.$executeRawUnsafe("RELEASE SAVEPOINT announce_status_change");
  } catch (err) {
    await db.$executeRawUnsafe("ROLLBACK TO SAVEPOINT announce_status_change");
    logger.warn(
      "outbound emit failed (event=conversation.status_changed): %s",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// The handoff a status write's sibling: the bot-to-person edge of the holder, announced by whichever
// writer moves it, for the same reason. The webhook mirror announces it when its own event moves the
// holder; a read-back that moved it first leaves that event finding `User` already stored, and the
// edge would otherwise reach no subscriber. Same savepoint discipline as above.
export async function announceHandoff(
  db: ScopedDb,
  tenantId: bigint,
  p: {
    conversationId: bigint;
    inboxId: bigint | null;
    previousAssigneeType: string | null;
    assigneeType: string | null;
  },
): Promise<void> {
  if (p.previousAssigneeType === "User" || p.assigneeType !== "User") return;
  await db.$executeRawUnsafe("SAVEPOINT announce_handoff");
  try {
    await emitOutbound(db, tenantId, "conversation.handoff", {
      conversation_id: String(p.conversationId),
      inbox_id: p.inboxId != null ? String(p.inboxId) : null,
    });
    await db.$executeRawUnsafe("RELEASE SAVEPOINT announce_handoff");
  } catch (err) {
    await db.$executeRawUnsafe("ROLLBACK TO SAVEPOINT announce_handoff");
    logger.warn(
      "outbound emit failed (event=conversation.handoff): %s",
      err instanceof Error ? err.message : String(err),
    );
  }
}
