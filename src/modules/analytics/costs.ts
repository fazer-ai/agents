import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import metricsPrisma from "@/api/lib/prisma-metrics";
import { resolveLangfuseConfig } from "@/graph/observability";
import { usageNode } from "@/graph/usage";
import type { ScopedDb, TenantContext } from "@/lib/tenancy";
import { runMetricsScoped } from "./budget";
import {
  dividesByConversations,
  funnelCountsSql,
  withRunsMark,
} from "./conversation-sums";
import { type DashboardFilter, localDaySql, localDayStartSql } from "./filter";
import { type Grain, windowGrain } from "./grain";
import { ledgerCtesSql, sumsBounds } from "./ledger-sums";
import { normalizeTimeZone, type OutcomeRow } from "./service";

// The quarter hour of UTC wall-clock a `timestamp without time zone` instant falls in. Every zone's
// offset from UTC is a whole number of quarter hours, and so is every clock change, so all the
// instants of a quarter share one local day in any zone.
export function quarterSql(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(date_trunc('hour', ${column}) + floor(date_part('minute', ${column}) / 15) * interval '15 minutes')`;
}

// THE DASHBOARD'S MONEY, FROM THE LEDGER. Every billed call writes its `llm_usage` row
// synchronously, priced at capture and re-priceable after (`scripts/reprice-usage.ts`), so the cost
// is summed over the same rows and filters as the requests beside it. Langfuse is not asked for a
// figure: it holds only the turns that were traced, which can be a share of them, prices only at
// ingestion and delivers best-effort, so its sum is a fraction of the bill on a sampled install. It stays as the place to open a trace.

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
  // How `days` and its splits are grouped (./grain.ts); `date` is the first local day of its group.
  grain: Grain;
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
  // Local days in the request's timezone, or the weeks or months of `grain`: the same buckets as the
  // calls series.
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
  // One transaction, so one connection of the metrics pool: the Langfuse configuration is read after
  // the figures, in the same transaction, and a failure there leaves the figures as they are.
  const { figures, langfuse } = await runMetricsScoped(
    base,
    ctx,
    async (db) => {
      // Every figure from the view's ledger as quarter-hour sums (./ledger-sums.ts): every zone's
      // offset is a whole number of quarter hours, so a quarter falls in one local day. The sums are
      // added up per (day, model, node) first, which every grouping set below is coarser than, so the
      // sets run over a few thousand rows. Sums are decimal, so adding them up again is exact.
      const grain = await windowGrain(db, filter, tz);
      const bounds = await sumsBounds(db, filter);
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
        WITH ${ledgerCtesSql(filter, bounds, { tz, grain })},
        d AS MATERIALIZED (
          SELECT ${localDayStartSql(Prisma.sql`l.quarter`, tz, grain)} AS day, l.model, l.node,
                 SUM(l.cost_usd) AS cost,
                 SUM(l.requests) AS requests,
                 SUM(l.unpriced) AS unpriced,
                 SUM(l.prompt_tokens) AS prompt,
                 SUM(l.completion_tokens) AS completion
            FROM ledger l
           GROUP BY 1, 2, 3
        )
        SELECT GROUPING(d.day, d.model, d.node)::int AS set,
               to_char(d.day, 'YYYY-MM-DD') AS bucket, d.model, d.node,
               SUM(d.cost) AS cost,
               SUM(d.requests)::int AS requests,
               SUM(d.unpriced)::int AS unpriced,
               SUM(d.prompt)::bigint AS prompt,
               SUM(d.completion)::bigint AS completion
          FROM d
         GROUP BY GROUPING SETS ((d.day), (d.model), (d.day, d.model), (d.day, d.node), ())
         ORDER BY 1, 2, 3, 4`);
      // The divisors are the funnel's (docs/dashboard.md, "Cost"): the conversations created in the
      // period the agent ran on, and those it resolved, per local day and for the period, the same
      // counts the KPIs show. A view of other traffic than real conversations has none.
      const view = await withRunsMark(db, filter);
      const viewBounds = await sumsBounds(db, view);
      const divides = dividesByConversations(filter);
      const perDay = divides
        ? await db.$queryRaw<OutcomeRow[]>(
            funnelCountsSql(
              view,
              viewBounds,
              localDaySql(Prisma.sql`v.quarter`, tz, grain),
              { tz, grain },
            ),
          )
        : [];
      // A conversation falls in one day, so the period's counts are the days' added up.
      const periodFunnel = perDay.reduce(
        (sum, r) => ({
          involved: sum.involved + Number(r.involved),
          resolved: sum.resolved + Number(r.resolved),
        }),
        { involved: 0, resolved: 0 },
      );
      const convs = [
        ...perDay.map((r) => ({
          set: 0,
          bucket: String(r.key),
          conversations: Number(r.involved),
          resolved: Number(r.resolved),
        })),
        {
          set: 1,
          bucket: null,
          conversations: periodFunnel.involved,
          resolved: periodFunnel.resolved,
        },
      ];
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
      const langfuse =
        tenantId === null
          ? null
          : await langfuseLink(base, ctx, tenantId, fetchFn, (read) =>
              read(db),
            );
      return {
        figures: { grain, days, models, byModelDays, byNodeDays, period },
        langfuse,
      };
    },
  );
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
    grain: figures.grain,
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
