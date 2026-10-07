import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { usageNode } from "@/graph/usage";
import { parseDbId } from "@/lib/db-id";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type DashboardFilter, outcomeSql, usageWhereSql } from "./filter";

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
  conversations: number;
  requests: number;
  costUsd: number;
  // Requests in this row with no price (null `cost_usd`), which the cost above does not include.
  unpricedRequests: number;
  // Null when the row touched no conversation (playground traffic): there is nothing to divide by.
  costPerConversation: number | null;
  resolvedConversations: number;
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
      return Prisma.sql`u.agent_id::text`;
    case "inbox":
      return Prisma.sql`u.inbox_id::text`;
    case "model":
      return Prisma.sql`u.model`;
    case "node":
      // A row with no node is an agent turn (usageNode), so it groups with "agent".
      return Prisma.sql`COALESCE(u.node, 'agent')`;
  }
}

export async function getBreakdown(
  ctx: TenantContext,
  filter: DashboardFilter,
  dimension: BreakdownDimension,
  base: PrismaClient = basePrisma,
): Promise<BreakdownRow[]> {
  return runScopedOn(base, ctx, async (db) => {
    const rows = await db.$queryRaw<
      {
        key: string | null;
        conversations: number;
        requests: number;
        cost: Prisma.Decimal | null;
        unpriced: number;
        resolved: number;
        prompt: bigint | number;
        cached: bigint | number;
      }[]
    >(Prisma.sql`
      SELECT ${keySql(dimension)} AS key,
             COUNT(DISTINCT u.conversation_id)::int AS conversations,
             COUNT(*)::int AS requests,
             SUM(u.cost_usd) AS cost,
             COUNT(*) FILTER (WHERE u.cost_usd IS NULL)::int AS unpriced,
             COUNT(DISTINCT u.conversation_id) FILTER (WHERE ${outcomeSql("c")} = 'resolved_by_agent')::int AS resolved,
             COALESCE(SUM(u.prompt_tokens), 0)::bigint AS prompt,
             COALESCE(SUM(u.cached_read_tokens), 0)::bigint AS cached
        FROM llm_usage u
        LEFT JOIN conversations c ON c.id = u.conversation_id
       WHERE ${usageWhereSql("u", filter)}
       GROUP BY 1`);
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
        const conversations = Number(r.conversations);
        const resolved = Number(r.resolved);
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
            priced && conversations > 0 ? cost / conversations : null,
          resolvedConversations: resolved,
          resolutionRate: conversations > 0 ? resolved / conversations : null,
          promptTokens: prompt,
          cachedReadTokens: cached,
          cacheShare: prompt > 0 ? cached / prompt : null,
        };
      })
      .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
  });
}
