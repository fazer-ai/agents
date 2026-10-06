import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { resolveLangfuseConfig } from "@/graph/observability";
import type { UsageSource } from "@/graph/usage";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { normalizeTimeZone } from "./service";

// THE DASHBOARD'S MONEY, FROM THE LEDGER. Every billed call writes its `llm_usage` row
// synchronously, priced at capture and re-priceable after (`scripts/reprice-usage.ts`), so the cost
// is summed over the same rows and filters as the requests beside it. Langfuse is not asked for a
// figure: it samples traces on the client, prices only at ingestion and delivers best-effort, so its
// sum was a fraction of the bill on a sampled install. It stays as the place to open a trace.

export interface DashboardCosts {
  totalCostUsd: number;
  // Local days in the request's timezone, the same buckets as the calls series.
  days: { date: string; costUsd: number }[];
  byModel: { model: string; costUsd: number }[];
  // Calls the ledger could not price (null `cost_usd`), which no figure above counts.
  unpriced: { calls: number; models: string[] };
  // Where "Open in Langfuse" points, when the tenant has Langfuse configured. Never a cost source.
  langfuse: { baseUrl: string; projectUrl?: string } | null;
}

export interface CostsFilter {
  since?: Date;
  source?: UsageSource;
  tz?: string;
}

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
  const since = filter.since ?? null;
  const source = filter.source ?? null;
  const tz = normalizeTimeZone(filter.tz);
  const where = Prisma.sql`(${since}::timestamptz IS NULL OR created_at >= ${since})
        AND (${source}::text IS NULL OR source = ${source})`;
  const [figures, langfuse] = await Promise.all([
    runScopedOn(base, ctx, async (db) => {
      const days = await db.$queryRaw<
        { bucket: string; cost: Prisma.Decimal | null }[]
      >(Prisma.sql`
        SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz}::text), 'YYYY-MM-DD') AS bucket,
               SUM(cost_usd) AS cost
        FROM llm_usage
        WHERE ${where}
        GROUP BY bucket
        ORDER BY bucket ASC`);
      const models = await db.$queryRaw<
        { model: string; cost: Prisma.Decimal | null; unpriced: number }[]
      >(Prisma.sql`
        SELECT model,
               SUM(cost_usd) AS cost,
               COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced
        FROM llm_usage
        WHERE ${where}
        GROUP BY model`);
      return { days, models };
    }),
    tenantId === null
      ? Promise.resolve(null)
      : langfuseLink(base, ctx, tenantId, fetchFn),
  ]);
  const days = figures.days.map((r) => ({
    date: r.bucket,
    costUsd: usd(r.cost),
  }));
  const byModel = figures.models
    .filter((r) => r.cost !== null)
    .map((r) => ({ model: r.model, costUsd: usd(r.cost) }))
    .sort((a, b) => b.costUsd - a.costUsd);
  const unpricedModels = figures.models.filter((r) => Number(r.unpriced) > 0);
  return {
    totalCostUsd: days.reduce((sum, d) => sum + d.costUsd, 0),
    days,
    byModel,
    unpriced: {
      calls: unpricedModels.reduce((n, r) => n + Number(r.unpriced), 0),
      models: unpricedModels.map((r) => r.model).sort(),
    },
    langfuse,
  };
}
