import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";

// CONVERSATION CONTROL RECORDS ITSELF, AND THE ROW FOLLOWS THE EFFECT.
//
// The seam's rule is that a mutation writes its own row inside its own transaction (#392), which is
// what makes the trail cover all three transports at once. This family is the one where the second
// half of that sentence is not available: reply, handoff, return, status and reengage change state
// in CHATWOOT, and no transaction of ours spans somebody else's system.
//
// So the ordering is chosen instead of inherited, and it is: call first, record after. A row
// written before the call would claim a message the customer never got, every time Chatwoot refuses
// one, and this is the family whose whole point is that the action is not reversible, so the row
// that lies is the one nobody can check against anything. Failing the other way loses the record of
// an action that DID happen, which the operator can still see in the conversation itself.
//
// A row per apply, unconditionally, which is the other place this family parts from the
// configuration ones. There "a row only when something changed" exists because the console PATCHes a
// whole tab per save and most saves move nothing. Here every apply is a request to a third party
// with external effect: setting a conversation to `open` that Chatwoot already had as `open` is
// still an operator reaching into a live conversation, and the trail is the only place that is
// written down.
// BEST-EFFORT, and that is the second half of the same trade. The other families raise on a failed
// row because the row shares the mutation's transaction: a lost record there means a lost change, and
// the caller is right to see the error. Here the change is Chatwoot's and cannot be rolled back, so
// an error raised after the customer already has the message does not undo anything — it tells the
// caller the action failed, and the retry sends the message a second time. On the /reset path the
// throw would escape the delivery processor after the erase has run and strand its ledger row.
//
// So a row that cannot be written is LOST, loudly. `error` and not `warn`: nothing else notices, and
// this is the one failure mode of the design.
export async function recordConversationAction(
  ctx: TenantContext,
  base: PrismaClient,
  conversationId: bigint,
  entry: { action: string; before?: unknown; after?: unknown },
): Promise<void> {
  const target = `conversation:${conversationId}`;
  try {
    await runScopedOn(base, ctx, (db) =>
      auditMutation(db, ctx, { target, ...entry }),
    );
  } catch (err) {
    logger.error(
      { err, action: entry.action, target },
      "conversations: the action reached Chatwoot and its audit row did not",
    );
  }
}
