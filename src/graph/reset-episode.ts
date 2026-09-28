import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// Whether a `/reset` withdrew the turn answering `triggerMessageId`: true when that message is AT or
// below the command's own message id (a turn on the command itself is withdrawn too). Ordered by
// Chatwoot's message ids, not our timestamps: our ledger row is written on the detached path after
// the ack, so two replicas can record events out of the order the operator lived. This column says
// "the operator withdrew this", not "the memory is gone": the WITHDRAWAL fences read it, the RESTORE
// fence reads `memory_cleared_at_message_id` (`threadResetBoundary`). docs/chatwoot.md, "`/reset`
// fences"; `tests/graph/reset-fences.test.ts` pins each reader.
export function resetLandedAfter(
  triggerMessageId: number | null,
  resetAtMessageId: number | null,
): boolean {
  if (resetAtMessageId === null) return false;
  // NOTE: no trigger is a caller that named no message (the playground, a test), not a reset.
  if (triggerMessageId === null) return false;
  return triggerMessageId <= resetAtMessageId;
}

// The episode boundary of the THREAD, not of one conversation: `/reset` clears memory per
// contact-inbox but stamps only the conversation it was typed in, so a sibling conversation's
// message must be ordered by the MAXIMUM across the thread (ids are unique per account). Reads
// `memory_cleared_at_message_id`, written in the transaction that deletes the thread, because
// `reset_at_message_id` can name a clear that refused. Null (cleared before the column existed) is
// not fenced: there is nothing to restore into a memory this process never saw cleared.
export async function threadResetBoundary(
  tenantId: bigint,
  instanceId: bigint,
  contactInboxId: number,
  base: PrismaClient,
): Promise<number | null> {
  const rows = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversation.findMany({
      where: {
        tenantId,
        chatwootInstanceId: instanceId,
        contactInboxId,
        memoryClearedAtMessageId: { not: null },
      },
      select: { memoryClearedAtMessageId: true },
      orderBy: { memoryClearedAtMessageId: "desc" },
      take: 1,
    }),
  );
  return rows[0]?.memoryClearedAtMessageId ?? null;
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface EpisodeFenceParams {
  tenantId: bigint;
  conversationDbId: bigint;
  // The Chatwoot message id this turn is answering.
  triggerMessageId: number | null;
  base: PrismaClient;
}

// The `stillWanted` a direct turn hands to `runLoadedTurn`. Under `strict` (inside the critical
// section) an unreadable answer STOPS the run by throwing; at a send it lets the run continue to the
// CAS, because throwing would abandon the bookkeeping of a delivered message. A GONE conversation row
// is not a reset and never answers `false`, like `jobNotRetiredSql` for an absent job row.
export function stillInSameEpisode(
  p: EpisodeFenceParams,
): (opts: { strict: boolean }) => Promise<boolean> {
  return async ({ strict }) => {
    try {
      const row = await runScopedOn(p.base, sysCtx(p.tenantId), (db) =>
        db.conversation.findUnique({
          where: { id: p.conversationDbId },
          select: { resetAtMessageId: true },
        }),
      );
      if (!row) return true;
      return !resetLandedAfter(p.triggerMessageId, row.resetAtMessageId);
    } catch (err) {
      // NOTE: an unreadable mark is not a retirement. `false` would mean "the operator withdrew
      // this": the message is settled CONSUMED with no reply and no alert, a silent loss. Throwing
      // takes the ordinary failed-turn path instead (failure recorded, handover note posted), which
      // is where a database transient was sending the turn anyway.
      if (strict) throw err;
      // NOTE: at a send, throwing abandons the bookkeeping of a message that may already be with
      // the customer; the CAS at the end is the fence that still holds.
      logger.warn(
        { err, conversation: String(p.conversationDbId) },
        "could not read the episode mark; letting the turn reach its own fence",
      );
      return true;
    }
  };
}
