import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import {
  addUsageGroup,
  emptyTurnUsage,
  type TurnUsage,
  usdOrNull,
} from "@/graph/usage";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// WHAT A CONVERSATION HAS SPENT, from the usage ledger (issue #853): the total the conversation
// screen shows in its header, and what each agent turn spent, which the screen hangs on the last
// message the turn created (issue #858). The numbers are the provider's, written by `UsageCapture`
// as each call returned; nothing here estimates.
//
// The total is every row billed to the conversation, whatever the node: the agent, the guardrail,
// speech normalization, vision, memory compaction and the observer all cost the tenant money on
// this conversation. A row no turn owns (memory compaction runs as a job, and rows from before the
// `turnId` column carry none) counts in the total and in no turn, so the turns can sum to less than
// the header, never more.
//
// Real traffic only: a playground row never names a conversation, and the filter says so anyway.

export interface ConversationTurnUsage {
  turnId: string;
  // When the turn's last billed call returned (ISO). Where the turn sits in the timeline when none
  // of the messages it created is on screen.
  at: string;
  usage: TurnUsage;
  // The Chatwoot ids of the messages the turn created, from the line it closed on (issue #855).
  // Empty for a turn that created none, and for one from before that line existed.
  messageIds: number[];
  // The turn's wall time, from the same line; null when there is none.
  turnMs: number | null;
  // Summed over the turn's calls; null unless every one of them was timed (a row from before
  // `duration_ms` has no time, and a partial sum would read as the whole).
  modelMs: number | null;
}

export interface ConversationUsage {
  total: TurnUsage;
  // Newest turns, oldest first. Capped: the screen pages its messages in from the newest, and a turn
  // whose messages are not loaded has nowhere to sit. The total is never capped.
  turns: ConversationTurnUsage[];
}

export const CONVERSATION_USAGE_TURN_CAP = 100;

export async function getConversationUsage(
  ctx: TenantContext,
  conversationId: bigint,
  base: PrismaClient = basePrisma,
): Promise<ConversationUsage> {
  const tenantId = ctx.tenantId as bigint;
  // ONE statement for the numbers, grouped by turn and step, and the total is the sum of its groups
  // (the turnless rows are the groups whose key is null). Two reads, even in one transaction, run at
  // READ COMMITTED and can each see a different set of rows while a turn is writing its own: the
  // turns would then add up to more than the header (#853, review round 1). A conversation's turn
  // count is its message count, so reading every group costs no more than the thread itself.
  const groups = await runScopedOn(base, ctx, (db) =>
    db.llmUsage.groupBy({
      by: ["turnId", "node", "priceTable"],
      where: { tenantId, conversationId, source: "inbox" },
      _count: { _all: true, durationMs: true, costUsd: true },
      _sum: {
        promptTokens: true,
        cachedReadTokens: true,
        cacheCreationTokens: true,
        completionTokens: true,
        costUsd: true,
        durationMs: true,
      },
      _max: { createdAt: true },
    }),
  );
  const total = emptyTurnUsage();
  const byTurn = new Map<
    string,
    { usage: TurnUsage; at: number; timed: number; modelMs: number }
  >();
  for (const g of groups) {
    const group = {
      node: g.node,
      calls: g._count._all,
      promptTokens: g._sum.promptTokens,
      cachedReadTokens: g._sum.cachedReadTokens,
      cacheCreationTokens: g._sum.cacheCreationTokens,
      completionTokens: g._sum.completionTokens,
      costUsd: usdOrNull(g._sum.costUsd),
      pricedCalls: g._count.costUsd,
      priceTable: g.priceTable,
    };
    addUsageGroup(total, group);
    if (!g.turnId || !g._max.createdAt) continue;
    const turn = byTurn.get(g.turnId) ?? {
      usage: emptyTurnUsage(),
      at: 0,
      timed: 0,
      modelMs: 0,
    };
    addUsageGroup(turn.usage, group);
    turn.at = Math.max(turn.at, g._max.createdAt.getTime());
    turn.timed += g._count.durationMs;
    turn.modelMs += g._sum.durationMs ?? 0;
    byTurn.set(g.turnId, turn);
  }
  const newest = [...byTurn.entries()]
    .sort(([, a], [, b]) => a.at - b.at)
    .slice(-CONVERSATION_USAGE_TURN_CAP);
  const closing = await closingLines(
    base,
    ctx,
    conversationId,
    newest.map(([turnId]) => turnId),
  );
  return {
    total,
    turns: newest.map(([turnId, t]) => {
      const end = closing.get(turnId);
      return {
        turnId,
        at: new Date(t.at).toISOString(),
        usage: t.usage,
        messageIds: end?.messageIds ?? [],
        turnMs: end?.turnMs ?? null,
        modelMs: t.timed === t.usage.calls ? t.modelMs : null,
      };
    }),
  };
}

// The line each turn closed on (issue #855), read for the turns the screen gets. The execution log
// is retention-bounded, so an old turn may have lost it and keeps its numbers without a bubble.
async function closingLines(
  base: PrismaClient,
  ctx: TenantContext,
  conversationId: bigint,
  turnIds: string[],
): Promise<Map<string, { messageIds: number[]; turnMs: number | null }>> {
  const out = new Map<
    string,
    { messageIds: number[]; turnMs: number | null }
  >();
  if (turnIds.length === 0) return out;
  const rows = await runScopedOn(base, ctx, (db) =>
    db.executionLog.findMany({
      where: {
        conversationId,
        source: "inbox",
        stage: "generate",
        turnId: { in: turnIds },
      },
      select: { turnId: true, detail: true },
    }),
  );
  for (const r of rows) {
    const d = (r.detail ?? null) as Record<string, unknown> | null;
    if (typeof d?.turnMs !== "number") continue;
    const ids = Array.isArray(d.sentMessageIds)
      ? d.sentMessageIds.filter(
          (id): id is number =>
            typeof id === "number" && Number.isSafeInteger(id),
        )
      : [];
    out.set(r.turnId, { messageIds: ids, turnMs: d.turnMs });
  }
  return out;
}
