import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import {
  addUsageGroup,
  emptyTurnUsage,
  type TurnUsage,
  usdOrNull,
} from "@/graph/usage";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// What a conversation has spent, from the usage ledger: the total in the conversation header, and
// what each agent turn spent (shown on the last message the turn created). The numbers are the
// provider's, written by `UsageCapture`; nothing here estimates. The total is every row billed to
// the conversation, whatever the node. A row no turn owns (memory compaction runs as a job, and
// older rows carry no `turnId`) counts in the total and in no turn, so the turns can sum to less
// than the header, never more.

export interface ConversationTurnUsage {
  turnId: string;
  // When the turn's last billed call returned (ISO). Where the turn sits in the timeline when none
  // of the messages it created is on screen.
  at: string;
  usage: TurnUsage;
  // The Chatwoot ids of the messages the turn created, from the line it closed on. Empty for a turn
  // that created none, or whose closing line carries no ids.
  messageIds: number[];
  // The turn's wall time, from the same line; null when there is none.
  turnMs: number | null;
  // Summed over the turn's calls; null unless every one of them was timed (a partial sum would read
  // as the whole).
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
  // ONE statement, and the total is the sum of its groups (turnless rows are the null-key
  // groups). Two reads at READ COMMITTED can each see a different set of rows while a turn writes,
  // and the turns would add up to more than the header.
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

// The line each turn closed on, read for the turns the screen gets. The execution log is
// retention-bounded, so an old turn may have lost it and keeps its numbers without a bubble.
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
