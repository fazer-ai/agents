import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import metricsPrisma from "@/api/lib/prisma-metrics";
import { usageNode } from "@/graph/usage";
import { parseDbId } from "@/lib/db-id";
import type { TenantContext } from "@/lib/tenancy";
import { runMetricsScoped } from "./budget";
import { funnelByKey } from "./conversation-sums";
import type { DashboardFilter } from "./filter";
import { ledgerCtesSql, sumsBounds } from "./ledger-sums";

// THE ONE DIMENSION TABLE that replaced "usage by agent / inbox / model": the view's ledger rows
// grouped by the dimension asked, with the conversations they touched, the requests, the money and
// how many of those conversations the agent resolved. A row's key is what the page applies as its
// filter when the row is clicked (agent and inbox), so the table and the filter share one id.

export const BREAKDOWN_DIMENSIONS = [
  "agent",
  "inbox",
  "model",
  "node",
] as const;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

export interface BreakdownRow {
  // The agent or inbox id, the model name or the call type. Null when the ledger row carries none
  // (a playground call has no inbox, a legacy row no agent).
  key: string | null;
  // Display name for an agent or inbox; the key itself for model and call type.
  label: string | null;
  // The funnel's conversations of the row's agent or inbox (the period's conversations the agent ran
  // on), and how many of them it resolved. Null on a model or call-type row, which has no
  // conversations of its own.
  conversations: number | null;
  requests: number;
  costUsd: number;
  // Requests in this row with no price (null `cost_usd`), which the cost above does not include.
  unpricedRequests: number;
  // Null when the row touched no conversation (playground traffic): there is nothing to divide by.
  costPerConversation: number | null;
  resolvedConversations: number | null;
  resolutionRate: number | null;
  promptTokens: number;
  cachedReadTokens: number;
  // cached_read / prompt. Null when the row sent no prompt tokens, never 0: "nothing to cache" is
  // not "nothing was cached".
  cacheShare: number | null;
}

function keySql(d: BreakdownDimension): Prisma.Sql {
  switch (d) {
    case "agent":
      return Prisma.sql`l.agent_id::text`;
    case "inbox":
      return Prisma.sql`l.inbox_id::text`;
    case "model":
      return Prisma.sql`l.model`;
    case "node":
      // The sums already carry a row with no node as "agent" (usageNode).
      return Prisma.sql`l.node`;
  }
}

// The dimensions whose rows carry the conversation columns: a conversation has an agent and an inbox,
// and no model or call type of its own (docs/dashboard.md, "Where the usage goes").
const CONVERSATION_DIMENSIONS: readonly BreakdownDimension[] = [
  "agent",
  "inbox",
];

export async function getBreakdown(
  ctx: TenantContext,
  filter: DashboardFilter,
  dimension: BreakdownDimension,
  base: PrismaClient = metricsPrisma,
): Promise<BreakdownRow[]> {
  return runMetricsScoped(base, ctx, async (db) => {
    const bounds = await sumsBounds(db, filter);
    const rows = await db.$queryRaw<
      {
        key: string | null;
        requests: number;
        cost: Prisma.Decimal | null;
        unpriced: number;
        prompt: bigint | number;
        cached: bigint | number;
      }[]
    >(Prisma.sql`
      WITH ${ledgerCtesSql(filter, bounds)}
      SELECT ${keySql(dimension)} AS key,
             SUM(l.requests)::int AS requests,
             SUM(l.cost_usd) AS cost,
             SUM(l.unpriced)::int AS unpriced,
             COALESCE(SUM(l.prompt_tokens), 0)::bigint AS prompt,
             COALESCE(SUM(l.cached_read_tokens), 0)::bigint AS cached
        FROM ledger l
       GROUP BY 1`);
    const funnel = CONVERSATION_DIMENSIONS.includes(dimension)
      ? await funnelByKey(db, filter, dimension as "agent" | "inbox")
      : null;
    const ids = rows
      .map((r) => (r.key === null ? null : parseDbId(r.key)))
      .filter((id): id is bigint => id !== null);
    const names = new Map<string, string>();
    if (dimension === "agent" && ids.length > 0) {
      for (const a of await db.agent.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      }))
        names.set(String(a.id), a.name);
    }
    if (dimension === "inbox" && ids.length > 0) {
      for (const i of await db.inbox.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      }))
        names.set(String(i.id), i.name);
    }
    return rows
      .map((r) => {
        // No priced call in the group is no known cost: nothing to divide (a priced zero divides).
        const priced = r.cost !== null && r.cost !== undefined;
        const cost = Number(r.cost ?? 0);
        const counted = funnel?.get(r.key ?? "") ?? null;
        const conversations = funnel
          ? Number(counted?.conversations ?? 0)
          : null;
        const resolved = funnel ? Number(counted?.resolved ?? 0) : null;
        const prompt = Number(r.prompt);
        const cached = Number(r.cached);
        const key = r.key;
        const label =
          key === null
            ? null
            : dimension === "agent" || dimension === "inbox"
              ? (names.get(key) ?? null)
              : dimension === "node"
                ? usageNode(key)
                : key;
        return {
          key,
          label,
          conversations,
          requests: Number(r.requests),
          costUsd: Number.isFinite(cost) ? cost : 0,
          unpricedRequests: Number(r.unpriced),
          costPerConversation:
            priced && conversations !== null && conversations > 0
              ? cost / conversations
              : null,
          resolvedConversations: resolved,
          resolutionRate:
            conversations !== null && resolved !== null && conversations > 0
              ? resolved / conversations
              : null,
          promptTokens: prompt,
          cachedReadTokens: cached,
          cacheShare: prompt > 0 ? cached / prompt : null,
        };
      })
      .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
  });
}
