import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import type { AuditAction } from "@/lib/audit/actions";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";

// Audits an action AFTER Chatwoot applied it: no transaction of ours spans Chatwoot, and a row
// written first would claim an action Chatwoot refused. One row per apply, even when nothing
// changed, since every apply is an operator reaching into a live conversation.
//
// Best-effort: the change cannot be rolled back, so a raise would only make the caller retry and
// send twice (on /reset it would strand the delivery ledger row after the erase ran). A row that
// cannot be written is lost, logged at `error` because nothing else notices.
export async function recordConversationAction(
  ctx: TenantContext,
  base: PrismaClient,
  conversationId: bigint,
  entry: { action: AuditAction; before?: unknown; after?: unknown },
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
