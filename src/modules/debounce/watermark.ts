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
// NOTE: it answers "will anything answer this again", and NOT "did anything answer this" — most
// writers below advance it precisely because no turn is running. A reader that needs the second
// question cannot get it from here, and must not try: the stranded-delivery sweep asked it this way
// through three review rounds of PR #282 and was wrong each time, and now gets its answer from the
// delivery ledger instead (../chatwoot/delivery-sweep.ts, `retireCoveredDeliveries`).

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface AdvanceHandledWatermarkParams {
  tenantId: bigint;
  conversationDbId: bigint;
  // Chatwoot id of the newest message now considered handled.
  toMessageId: number;
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
      data: { lastHandledMessageId: params.toMessageId },
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
