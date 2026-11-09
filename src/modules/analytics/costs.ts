import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import metricsPrisma from "@/api/lib/prisma-metrics";
import { resolveLangfuseConfig } from "@/graph/observability";
import { usageNode } from "@/graph/usage";
import type { ScopedDb, TenantContext } from "@/lib/tenancy";
import { runMetricsScoped } from "./budget";
import {
  type DashboardFilter,
  localDaySql,
  outcomeSql,
  usageWhereSql,
} from "./filter";
import { normalizeTimeZone } from "./service";

// The quarter hour of UTC wall-clock a `timestamp without time zone` instant falls in. Every zone's
// offset from UTC is a whole number of quarter hours, and so is every clock change, so all the
// instants of a quarter share one local day in any zone.
export function quarterSql(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(date_trunc('hour', ${column}) + floor(date_part('minute', ${column}) / 15) * interval '15 minutes')`;
}

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
export async function langfuseLink(
  base: PrismaClient,
  ctx: TenantContext,
  tenantId: bigint,
  fetchFn: typeof fetch,
  // The transaction the configuration is read in: the request's metrics budget unless the caller
  // gives it one of its own.
  scoped: <T>(fn: (db: ScopedDb) => Promise<T>) => Promise<T> = (fn) =>
    runMetricsScoped(base, ctx, fn),
): Promise<DashboardCosts["langfuse"]> {
  try {
    const cfg = await scoped((db) => resolveLangfuseConfig(db, tenantId));
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
  base: PrismaClient = metricsPrisma,
  fetchFn: typeof fetch = fetch,
): Promise<DashboardCosts> {
  const tenantId = ctx.tenantId;
  const tz = normalizeTimeZone(filter.tz);
  const where = usageWhereSql("u", filter);
  const [figures, langfuse] = await Promise.all([
    runMetricsScoped(base, ctx, async (db) => {
      // Two reads of the window's ledger rows, every figure from them. The rows are first summed per
      // quarter hour of UTC (`quarterSql`): every zone's offset is a whole number of quarter hours,
      // so a quarter falls in one local day, and the zone's day is worked out once per quarter instead
      // of once per call, which is most of what grouping a month of calls by day costs. Sums are
      // decimal, so adding them up again is exact.
      const sums = await db.$queryRaw<
        {
          set: number;
          bucket: string | null;
          model: string | null;
          node: string | null;
          cost: Prisma.Decimal | null;
          requests: number;
          unpriced: number;
          prompt: bigint | number | null;
          completion: bigint | number | null;
        }[]
      >(Prisma.sql`
        WITH q AS MATERIALIZED (
          SELECT ${quarterSql(Prisma.sql`u.created_at`)} AS quarter, u.model,
                 COALESCE(u.node, 'agent') AS node,
                 SUM(u.cost_usd) AS cost,
                 COUNT(*) AS requests,
                 COUNT(*) FILTER (WHERE u.cost_usd IS NULL) AS unpriced,
                 SUM(u.prompt_tokens) AS prompt,
                 SUM(u.completion_tokens) AS completion
            FROM llm_usage u
           WHERE ${where}
           GROUP BY 1, 2, 3
        ), d AS (
          SELECT ${localDaySql(Prisma.sql`q.quarter`, tz)} AS bucket, q.model, q.node, q.cost,
                 q.requests, q.unpriced, q.prompt, q.completion
            FROM q
        )
        SELECT GROUPING(d.bucket, d.model, d.node)::int AS set,
               d.bucket, d.model, d.node,
               SUM(d.cost) AS cost,
               SUM(d.requests)::int AS requests,
               SUM(d.unpriced)::int AS unpriced,
               SUM(d.prompt)::bigint AS prompt,
               SUM(d.completion)::bigint AS completion
          FROM d
         GROUP BY GROUPING SETS ((d.bucket), (d.model), (d.bucket, d.model), (d.bucket, d.node), ())
         ORDER BY 1, 2, 3, 4`);
      // The conversations: each one once per quarter it was billed in, then once per local day.
      const convs = await db.$queryRaw<
        {
          set: number;
          bucket: string | null;
          conversations: number;
          resolved: number;
        }[]
      >(Prisma.sql`
        WITH q AS MATERIALIZED (
          SELECT DISTINCT ${quarterSql(Prisma.sql`u.created_at`)} AS quarter, u.conversation_id
            FROM llm_usage u
           WHERE ${where} AND u.conversation_id IS NOT NULL
        ), d AS (
          SELECT DISTINCT ${localDaySql(Prisma.sql`q.quarter`, tz)} AS bucket, q.conversation_id
            FROM q
        )
        SELECT GROUPING(d.bucket)::int AS set, d.bucket,
               COUNT(DISTINCT d.conversation_id)::int AS conversations,
               COUNT(DISTINCT d.conversation_id) FILTER (WHERE ${outcomeSql("c")} = 'resolved_by_agent')::int AS resolved
          FROM d
          LEFT JOIN conversations c ON c.id = d.conversation_id
         GROUP BY GROUPING SETS ((d.bucket), ())
         ORDER BY 1, 2`);
      // GROUPING's bits are (bucket, model, node), set where the column is NOT a key of the row.
      const of = (set: number) => sums.filter((r) => r.set === set);
      const byDay = new Map(
        convs.filter((r) => r.set === 0).map((r) => [r.bucket, r]),
      );
      const days = of(0b011).map((r) => ({
        bucket: r.bucket as string,
        cost: r.cost,
        conversations: Number(byDay.get(r.bucket)?.conversations ?? 0),
        resolved: Number(byDay.get(r.bucket)?.resolved ?? 0),
      }));
      const models = of(0b101).map((r) => ({
        model: r.model as string,
        cost: r.cost,
        unpriced: Number(r.unpriced),
      }));
      // Only priced rows have a segment: a group whose every call is unpriced has no sum.
      const split = (set: number, key: (r: (typeof sums)[number]) => string) =>
        of(set)
          .filter((r) => r.cost !== null)
          .map((r) => ({
            bucket: r.bucket as string,
            key: key(r),
            cost: r.cost,
          }));
      const byModelDays = split(0b001, (r) => r.model as string);
      const byNodeDays = split(0b010, (r) => r.node as string);
      const [whole] = of(0b111);
      const [wholeConvs] = convs.filter((r) => r.set === 1);
      const period = {
        requests: Number(whole?.requests ?? 0),
        prompt: whole?.prompt ?? 0,
        completion: whole?.completion ?? 0,
        conversations: Number(wholeConvs?.conversations ?? 0),
        resolved: Number(wholeConvs?.resolved ?? 0),
      };
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
    // A day with no priced call has no known cost, so nothing to divide; a priced zero (a free
    // model) is a cost of zero, and divides like any other.
    const priced = r.cost !== null;
    return {
      date: r.bucket,
      costUsd,
      conversations,
      resolvedConversations,
      costPerConversation:
        priced && conversations > 0 ? costUsd / conversations : null,
      costPerResolvedConversation:
        priced && resolvedConversations > 0
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
  const priced = figures.days.some((r) => r.cost !== null);
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
      priced && conversations > 0 ? totalCostUsd / conversations : null,
    costPerResolvedConversation:
      priced && resolvedConversations > 0
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
