import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// `Conversation.lastHandledMessageId` marks the last inbound message the bot either responded to or
// DELIBERATELY skipped (handoff mid-turn, human-owned period, consumed /commands, guardrail
// suppression). Every writer goes through this monotonic CAS: a stale advance (target ≤ current)
// loses silently, so concurrent flushes and webhook deliveries can never move the watermark
// backwards. Advancing means "never re-ANSWER this", not "never remember it" — skipped messages
// still reach the agent's memory through ingestion. Left behind, the watermark makes the next
// debounce flush re-coalesce the whole human-era backlog (handoff reason included) after a human
// returns a conversation to the bot (issue #8).
//
// `lastAnsweredMessageId` is the STRICTLY SMALLER question: how far a turn actually got to the point
// of POSTING. Of the writers here, most advance the handled mark precisely because no answer is
// coming (the burst rendered to nothing, the contact was not authorized, a human took the
// conversation, a guardrail went silent), so "handled" cannot be read as "answered" — and a reader
// that does read it that way concludes a customer was served when nobody replied. Only the two post
// gates pass `answered`, and they pass it through the SAME CAS: the mark is claimed just before the
// reply goes out, which makes it an at-most-once claim rather than a receipt, and a process that
// dies in between leaves an intention nobody carried out. The stranded-delivery sweep is the reader
// that needs the distinction and treats a mark level with its own message as unanswered for exactly
// that reason (../chatwoot/stranded-delivery.ts, issue #228).

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface AdvanceHandledWatermarkParams {
  tenantId: bigint;
  conversationDbId: bigint;
  // Chatwoot id of the newest message now considered handled.
  toMessageId: number;
  // True ONLY from a post gate, where the advance is the claim on posting a reply. Everywhere else
  // the advance means the opposite — the messages are being retired unanswered — so the default is
  // false and a new caller has to say otherwise deliberately.
  answered?: boolean;
  base?: PrismaClient;
}

// Returns true when this call moved the watermark (the CAS won), false when a concurrent writer
// already advanced it past `toMessageId`.
export async function advanceHandledWatermark(
  params: AdvanceHandledWatermarkParams,
): Promise<boolean> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    const cas = await db.conversation.updateMany({
      where: {
        id: params.conversationDbId,
        OR: [
          { lastHandledMessageId: null },
          { lastHandledMessageId: { lt: params.toMessageId } },
        ],
      },
      // Both marks move in the SAME winning CAS, which is what keeps the answered mark monotonic
      // and never ahead of the handled one: it is only ever written by a writer that just won the
      // handled comparison, and the handled mark is monotonic by the `where` above.
      data: {
        lastHandledMessageId: params.toMessageId,
        ...(params.answered
          ? { lastAnsweredMessageId: params.toMessageId }
          : {}),
      },
    });
    return cas.count > 0;
  });
}

// The watermark as it stands RIGHT NOW. Read where the burst is selected, not where the flush
// started: between those two points sits an authorization round-trip to somebody else's endpoint,
// and a message that arrived and was REFUSED during it has already had the watermark advanced past
// it by its own delivery. Selecting against the older value would hand that refused message to the
// model — and the post-gate CAS below only withholds the reply, after the turn has already run its
// tools.
export async function readHandledWatermark(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  base?: PrismaClient;
}): Promise<number | null> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    const row = await db.conversation.findUnique({
      where: { id: params.conversationDbId },
      select: { lastHandledMessageId: true },
    });
    return row?.lastHandledMessageId ?? null;
  });
}
