import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { emptyTurnUsage, type TurnUsage } from "@/graph/usage";
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
  // for a turn whose messages are not loaded has nowhere to sit. The total is never capped.
  turns: ConversationTurnUsage[];
}

export const CONVERSATION_USAGE_TURN_CAP = 100;

export async function getConversationUsage(
  ctx: TenantContext,
  conversationId: bigint,
  base: PrismaClient = basePrisma,
): Promise<ConversationUsage> {
  const tenantId = ctx.tenantId as bigint;
  // ONE statement, grouped by turn, and the total is the sum of its groups (the turnless rows are
  // the group whose key is null). Two reads, even in one transaction, run at READ COMMITTED and can
  // each see a different set of rows while a turn is writing its own: the lines would then add up
  // to more than the header (review round 1). A conversation's turn count is its message count, so
  // reading every group costs no more than the thread itself.
  const groups = await runScopedOn(base, ctx, (db) =>
    db.llmUsage.groupBy({
      by: ["turnId"],
      where: { tenantId, conversationId, source: "inbox" },
      _count: { _all: true },
      _sum: {
        promptTokens: true,
        cachedReadTokens: true,
        cacheCreationTokens: true,
        completionTokens: true,
      },
      _max: { createdAt: true },
    }),
  );
  const total = emptyTurnUsage();
  const turns: ConversationTurnUsage[] = [];
  for (const g of groups) {
    const usage: TurnUsage = {
      calls: g._count._all,
      promptTokens: g._sum.promptTokens ?? 0,
      cachedReadTokens: g._sum.cachedReadTokens ?? 0,
      cacheCreationTokens: g._sum.cacheCreationTokens ?? 0,
      completionTokens: g._sum.completionTokens ?? 0,
    };
    total.calls += usage.calls;
    total.promptTokens += usage.promptTokens;
    total.cachedReadTokens += usage.cachedReadTokens;
    total.cacheCreationTokens += usage.cacheCreationTokens;
    total.completionTokens += usage.completionTokens;
    if (!g.turnId || !g._max.createdAt) continue;
    turns.push({ turnId: g.turnId, at: g._max.createdAt.toISOString(), usage });
  }
  turns.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { total, turns: turns.slice(-CONVERSATION_USAGE_TURN_CAP) };
}
