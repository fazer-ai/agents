import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { resolveLangfuseConfig } from "@/graph/observability";
import { usageNode } from "@/graph/usage";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type DashboardFilter,
  localDaySql,
  outcomeSql,
  usageWhereSql,
} from "./filter";
import { normalizeTimeZone } from "./service";

// THE DASHBOARD'S MONEY, FROM THE LEDGER. Every billed call writes its `llm_usage` row
// synchronously, priced at capture and re-priceable after (`scripts/reprice-usage.ts`), so the cost
// is summed over the same rows and filters as the requests beside it. Langfuse is not asked for a
// figure: it samples traces on the client, prices only at ingestion and delivers best-effort, so its
// sum was a fraction of the bill on a sampled install. It stays as the place to open a trace.

export interface CostDay {
  date: string;
  costUsd: number;
  // Conversations with a billed call that day, and how many of them the agent resolved. The
  // per-conversation lines divide the day's cost by these; a playground day has none.
  conversations: number;
  resolvedConversations: number;
  costPerConversation: number | null;
  costPerResolvedConversation: number | null;
}

export interface DashboardCosts {
  totalCostUsd: number;
  // The period as a whole, from the same rows: requests, tokens, and the distinct conversations the
  // calls belonged to (and how many of them the agent resolved), so the per-conversation figures of
  // the period divide by conversations counted once, not once per day.
  requests: number;
  tokens: { prompt: number; completion: number };
  conversations: number;
  resolvedConversations: number;
  costPerConversation: number | null;
  costPerResolvedConversation: number | null;
  // Local days in the request's timezone, the same buckets as the calls series.
  days: CostDay[];
  // The same days split by model and by call type (`llm_usage.node`), so a stacked chart's segments
  // add up to the day above. Only priced rows: an unpriced call has no segment to draw.
  daysByModel: { date: string; key: string; costUsd: number }[];
  daysByNode: { date: string; key: string; costUsd: number }[];
  byModel: { model: string; costUsd: number }[];
  // Calls the ledger could not price (null `cost_usd`), which no figure above counts.
  unpriced: { calls: number; models: string[] };
  // Where "Open in Langfuse" points, when the tenant has Langfuse configured. Never a cost source.
  langfuse: { baseUrl: string; projectUrl?: string } | null;
}

export type CostsFilter = DashboardFilter;

// The Langfuse keys are project-scoped, so GET /api/public/projects returns exactly the one project
// they belong to. Cached per (baseUrl + publicKey) so the dashboard does not pay a round-trip on
// every load. Best-effort: any failure resolves to null and the link falls back to baseUrl.
const projectIdCache = new Map<string, string>();

export async function resolveLangfuseProjectId(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const cacheKey = `${baseUrl}|${publicKey}`;
  const cached = projectIdCache.get(cacheKey);
  if (cached) return cached;
  try {
    const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString(
      "base64",
    );
    const res = await fetchFn(`${baseUrl}/api/public/projects`, {
      headers: { Authorization: `Basic ${credentials}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const id = body.data?.[0]?.id;
    if (typeof id !== "string" || !id) return null;
    projectIdCache.set(cacheKey, id);
    return id;
  } catch (err) {
    logger.warn({ err }, "langfuse project id resolution failed");
    return null;
  }
}

// The link only, and it never waits on Langfuse: the project id comes from the cache, and on a miss
// the base URL is returned now while the id is resolved in the background for the next load. So a
// slow or unreachable Langfuse delays no figure. Never throws.
async function langfuseLink(
  base: PrismaClient,
  ctx: TenantContext,
  tenantId: bigint,
  fetchFn: typeof fetch,
): Promise<DashboardCosts["langfuse"]> {
  try {
    const cfg = await runScopedOn(base, ctx, (db) =>
      resolveLangfuseConfig(db, tenantId),
    );
    if (!cfg) return null;
    const baseUrl = cfg.baseUrl ?? "https://cloud.langfuse.com";
    const projectId = projectIdCache.get(`${baseUrl}|${cfg.publicKey}`);
    if (projectId) {
      return { baseUrl, projectUrl: `${baseUrl}/project/${projectId}` };
    }
    void resolveLangfuseProjectId(
      baseUrl,
      cfg.publicKey,
      cfg.secretKey,
      fetchFn,
    );
    return { baseUrl };
  } catch (err) {
    logger.warn({ err, tenantId }, "langfuse link resolution failed");
    return null;
  }
}

function usd(v: Prisma.Decimal | string | number | null): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// Runs inside the scoped tx, so RLS fences `llm_usage` to the tenant. `created_at` holds UTC
// wall-clock without a zone, hence the double shift into the operator's day (see `getTimeseries`).
export async function getDashboardCosts(
  ctx: TenantContext,
  filter: CostsFilter,
  base: PrismaClient = basePrisma,
  fetchFn: typeof fetch = fetch,
): Promise<DashboardCosts> {
  const tenantId = ctx.tenantId;
  const tz = normalizeTimeZone(filter.tz);
  const where = usageWhereSql("u", filter);
  const day = localDaySql(Prisma.sql`u.created_at`, tz);
  const [figures, langfuse] = await Promise.all([
    runScopedOn(base, ctx, async (db) => {
      const days = await db.$queryRaw<
        {
          bucket: string;
          cost: Prisma.Decimal | null;
          conversations: number;
          resolved: number;
        }[]
      >(Prisma.sql`
        SELECT ${day} AS bucket,
               SUM(u.cost_usd) AS cost,
               COUNT(DISTINCT u.conversation_id)::int AS conversations,
               COUNT(DISTINCT u.conversation_id) FILTER (WHERE ${outcomeSql("c")} = 'resolved_by_agent')::int AS resolved
        FROM llm_usage u
        LEFT JOIN conversations c ON c.id = u.conversation_id
        WHERE ${where}
        GROUP BY bucket
        ORDER BY bucket ASC`);
      const models = await db.$queryRaw<
        { model: string; cost: Prisma.Decimal | null; unpriced: number }[]
      >(Prisma.sql`
        SELECT u.model,
               SUM(u.cost_usd) AS cost,
               COUNT(*) FILTER (WHERE u.cost_usd IS NULL)::int AS unpriced
        FROM llm_usage u
        WHERE ${where}
        GROUP BY u.model`);
      const split = (key: Prisma.Sql) =>
        db.$queryRaw<
          { bucket: string; key: string; cost: Prisma.Decimal | null }[]
        >(Prisma.sql`
          SELECT ${day} AS bucket, ${key} AS key, SUM(u.cost_usd) AS cost
          FROM llm_usage u
          WHERE ${where} AND u.cost_usd IS NOT NULL
          GROUP BY 1, 2
          ORDER BY 1, 2`);
      const [period] = await db.$queryRaw<
        {
          requests: number;
          prompt: bigint | number;
          completion: bigint | number;
          conversations: number;
          resolved: number;
        }[]
      >(Prisma.sql`
        SELECT COUNT(*)::int AS requests,
               COALESCE(SUM(u.prompt_tokens), 0)::bigint AS prompt,
               COALESCE(SUM(u.completion_tokens), 0)::bigint AS completion,
               COUNT(DISTINCT u.conversation_id)::int AS conversations,
               COUNT(DISTINCT u.conversation_id) FILTER (WHERE ${outcomeSql("c")} = 'resolved_by_agent')::int AS resolved
        FROM llm_usage u
        LEFT JOIN conversations c ON c.id = u.conversation_id
        WHERE ${where}`);
      const byModelDays = await split(Prisma.sql`u.model`);
      const byNodeDays = await split(Prisma.sql`COALESCE(u.node, 'agent')`);
      return { days, models, byModelDays, byNodeDays, period };
    }),
    tenantId === null
      ? Promise.resolve(null)
      : langfuseLink(base, ctx, tenantId, fetchFn),
  ]);
  const days = figures.days.map((r) => {
    const costUsd = usd(r.cost);
    const conversations = Number(r.conversations);
    const resolvedConversations = Number(r.resolved);
    return {
      date: r.bucket,
      costUsd,
      conversations,
      resolvedConversations,
      costPerConversation:
        conversations > 0 && costUsd > 0 ? costUsd / conversations : null,
      costPerResolvedConversation:
        resolvedConversations > 0 && costUsd > 0
          ? costUsd / resolvedConversations
          : null,
    };
  });
  const byModel = figures.models
    .filter((r) => r.cost !== null)
    .map((r) => ({ model: r.model, costUsd: usd(r.cost) }))
    .sort((a, b) => b.costUsd - a.costUsd);
  const unpricedModels = figures.models.filter((r) => Number(r.unpriced) > 0);
  const daySplit = (
    rows: { bucket: string; key: string; cost: Prisma.Decimal | null }[],
    name: (k: string) => string,
  ) =>
    rows.map((r) => ({
      date: r.bucket,
      key: name(r.key),
      costUsd: usd(r.cost),
    }));
  const totalCostUsd = days.reduce((sum, d) => sum + d.costUsd, 0);
  const conversations = Number(figures.period?.conversations ?? 0);
  const resolvedConversations = Number(figures.period?.resolved ?? 0);
  return {
    totalCostUsd,
    requests: Number(figures.period?.requests ?? 0),
    tokens: {
      prompt: Number(figures.period?.prompt ?? 0),
      completion: Number(figures.period?.completion ?? 0),
    },
    conversations,
    resolvedConversations,
    costPerConversation:
      conversations > 0 && totalCostUsd > 0
        ? totalCostUsd / conversations
        : null,
    costPerResolvedConversation:
      resolvedConversations > 0 && totalCostUsd > 0
        ? totalCostUsd / resolvedConversations
        : null,
    days,
    daysByModel: daySplit(figures.byModelDays, (k) => k),
    daysByNode: daySplit(figures.byNodeDays, usageNode),
    byModel,
    unpriced: {
      calls: unpricedModels.reduce((n, r) => n + Number(r.unpriced), 0),
      models: unpricedModels.map((r) => r.model).sort(),
    },
    langfuse,
  };
}
