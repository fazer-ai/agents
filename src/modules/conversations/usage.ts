import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import type { TurnUsage } from "@/graph/usage";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// WHAT A CONVERSATION HAS SPENT, from the usage ledger (issue #853): the total the conversation
// screen shows in its header, and one line per agent turn in its timeline. The numbers are the
// provider's, written by `UsageCapture` as each call returned; nothing here estimates.
//
// The total is every row billed to the conversation, whatever the node: the agent, the guardrail,
// speech normalization, vision, memory compaction and the observer all cost the tenant money on
// this conversation. A row no turn owns (memory compaction runs as a job, and rows from before the
// `turnId` column carry none) counts in the total and in no turn, so the turns' lines can sum to
// less than the header, never more.
//
// Real traffic only: a playground row never names a conversation, and the filter says so anyway.

export interface ConversationTurnUsage {
  turnId: string;
  // When the turn's last billed call returned (ISO). The line sits in the timeline there, like the
  // other activity markers: an ordinary turn records no id of the messages it sent, so there is no
  // bubble to hang it under.
  at: string;
  usage: TurnUsage;
}

export interface ConversationUsage {
  total: TurnUsage;
  // Newest turns, oldest first. Capped: the screen pages its messages in from the newest, and a line
  // for a turn whose messages are not loaded has nowhere to sit.
  turns: ConversationTurnUsage[];
}

export const CONVERSATION_USAGE_TURN_CAP = 100;

export async function getConversationUsage(
  ctx: TenantContext,
  conversationId: bigint,
  base: PrismaClient = basePrisma,
): Promise<ConversationUsage> {
  const tenantId = ctx.tenantId as bigint;
  const where = { tenantId, conversationId, source: "inbox" } as const;
  const sums = {
    promptTokens: true,
    cachedReadTokens: true,
    cacheCreationTokens: true,
    completionTokens: true,
  } as const;
  const { agg, groups } = await runScopedOn(base, ctx, async (db) => ({
    agg: await db.llmUsage.aggregate({
      where,
      _count: { _all: true },
      _sum: sums,
    }),
    groups: await db.llmUsage.groupBy({
      by: ["turnId"],
      where: { ...where, turnId: { not: null } },
      _count: { _all: true },
      _sum: sums,
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: "desc" } },
      take: CONVERSATION_USAGE_TURN_CAP,
    }),
  }));
  const turns: ConversationTurnUsage[] = [];
  for (const g of groups) {
    if (!g.turnId || !g._max.createdAt) continue;
    turns.push({
      turnId: g.turnId,
      at: g._max.createdAt.toISOString(),
      usage: {
        calls: g._count._all,
        promptTokens: g._sum.promptTokens ?? 0,
        cachedReadTokens: g._sum.cachedReadTokens ?? 0,
        cacheCreationTokens: g._sum.cacheCreationTokens ?? 0,
        completionTokens: g._sum.completionTokens ?? 0,
      },
    });
  }
  turns.reverse();
  return {
    total: {
      calls: agg._count._all,
      promptTokens: agg._sum.promptTokens ?? 0,
      cachedReadTokens: agg._sum.cachedReadTokens ?? 0,
      cacheCreationTokens: agg._sum.cacheCreationTokens ?? 0,
      completionTokens: agg._sum.completionTokens ?? 0,
    },
    turns,
  };
}
