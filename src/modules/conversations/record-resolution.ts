import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { ResolutionOrigin } from "@/modules/conversations/resolution-origin";

// Records who closed a conversation, on the four paths where WE close one. The dashboard reads this
// instead of inferring the origin from status + assignee; the reasoning is in resolution-origin.ts.
//
// Called AFTER a successful `toggleStatus(..., "resolved")`, never before: a stamp written ahead of
// the call would survive a toggle that threw, and the next person to resolve that conversation —
// possibly an operator, months later — would be credited to the agent. Recording only what actually
// happened is the whole point of the column.
//
// Best-effort, never throws. The status change is already live in Chatwoot and the callers are all
// on paths where a message has gone out, so raising here would fail a job whose retry would
// double-post. A missing stamp costs one uncounted resolution; a thrown error costs a duplicate
// customer message.
//
// KNOWN RACE, deliberately not defended against: the mirror clears the stamp whenever it applies a
// status other than "resolved" (a reopen), and it can process that reopen between the toggle
// returning and this write landing. The row then reads open + "agent", which classifies as
// unresolved and counts as nothing — harmless until that same conversation is later resolved by
// someone else, when the stale stamp would be read as the agent's. It takes a customer replying in
// the same instant AND a later third-party resolve, and the cost is one over-counted conversation,
// which is not worth a version stamp of its own.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

/** Either our own row id, or the Chatwoot coordinates every caller can produce. */
export type ConversationRef =
  | { id: bigint }
  | { chatwootInstanceId: bigint; chatwootConversationId: number };

export async function recordResolutionOrigin(params: {
  tenantId: bigint;
  conversation: ConversationRef;
  origin: ResolutionOrigin;
  base?: PrismaClient;
}): Promise<void> {
  const { tenantId, conversation, origin } = params;
  const base = params.base ?? basePrisma;
  try {
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      // updateMany, not update: a conversation deleted (or never mirrored) between the toggle and
      // this write is a no-op, not a throw.
      db.conversation.updateMany({
        where: "id" in conversation ? { id: conversation.id } : conversation,
        data: { resolvedBy: origin },
      }),
    );
  } catch (err) {
    logger.warn(
      {
        err,
        origin,
        conversation: JSON.stringify(conversation, bigintToString),
      },
      "recordResolutionOrigin failed",
    );
  }
}

function bigintToString(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? String(v) : v;
}
