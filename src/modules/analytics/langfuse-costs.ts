import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import {
  environmentForSource,
  resolveLangfuseConfig,
} from "@/graph/observability";
import type { UsageSource } from "@/graph/usage";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// Real LLM cost from Langfuse (which maintains an up-to-date price table and calculates cost
// per actual usage). Tokens and calls stay local in LlmUsage for KPI calculations; only cost
// is fetched here. Returns disabled/error status so the caller can surface the right UI state
// without throwing.

export type LangfuseCosts =
  | { status: "disabled" }
  | { status: "error" }
  | {
      status: "ok";
      totalCostUsd: number;
      days: { date: string; costUsd: number }[];
      byModel: { model: string; costUsd: number }[];
      // The Langfuse instance URL, so the dashboard can offer an "open in Langfuse" link (item 13).
      baseUrl: string;
      // Deep link straight to the tenant's project (item 6): `${baseUrl}/project/${id}`. Best-effort
      // — omitted when the project id couldn't be resolved, so the dashboard falls back to baseUrl.
      projectUrl?: string;
    };

// The Langfuse keys are project-scoped, so GET /api/public/projects returns exactly the one project
// they belong to. Cache the id per (baseUrl + publicKey) so we don't pay an extra round-trip on
// every dashboard load. Best-effort: any failure resolves to null (the link falls back to baseUrl).
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

// Parses the temporal key from a Langfuse metrics row defensively: tries `time_dimension` first,
// then falls back to the first key whose value looks like a date string.
function extractDateKey(row: Record<string, unknown>): string | null {
  if (typeof row.time_dimension === "string") {
    const d = new Date(row.time_dimension);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  for (const v of Object.values(row)) {
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) {
      return new Date(v).toISOString().slice(0, 10);
    }
  }
  return null;
}

async function fetchMetrics(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
  query: object,
  fetchFn: typeof fetch,
): Promise<Record<string, unknown>[]> {
  // v1 metrics endpoint: same query/response shape as v2, but v2 is Langfuse-CLOUD-only — on a
  // self-hosted instance it 404s after auth, so use v1 (supported on both cloud and self-hosted).
  const url = `${baseUrl}/api/public/metrics?query=${encodeURIComponent(JSON.stringify(query))}`;
  const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString(
    "base64",
  );
  const res = await fetchFn(url, {
    headers: { Authorization: `Basic ${credentials}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Langfuse metrics API responded with ${res.status}`);
  }
  const body = (await res.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new Error("Langfuse metrics response missing data array");
  }
  return body.data as Record<string, unknown>[];
}

// WHAT THE PROJECT HOLDS IS NOT WHAT THIS TENANT SPENT (issue #427). A Langfuse project is shared
// by every tenant of the install and by anything else the operator points at it, so a cost query
// without a fence answers with other people's money. Every trace we write carries the tenant's slug
// as the `userId` and one of our two environments, which is exactly what the spend ceiling's poll
// filters by: the same filters here are what let the dashboard's figure and the ceiling's bar be
// two readings of one number instead of two numbers.
//
// Measured on a local Langfuse during this rodada: the unfenced 30-day total was $7.71, of which
// $2.70 belonged to two other tenants and was being shown to the third as its own cost.
//
// `any of` needs `type: "stringOptions"`; asked as `"string"` Langfuse refuses the whole request.
function costFilters(
  tenantSlug: string,
  source: UsageSource | undefined,
): Record<string, unknown>[] {
  const environment = source
    ? {
        column: "environment",
        operator: "=",
        value: environmentForSource(source),
        type: "string",
      }
    : {
        column: "environment",
        operator: "any of",
        value: [
          environmentForSource("inbox"),
          environmentForSource("playground"),
        ],
        type: "stringOptions",
      };
  return [
    environment,
    { column: "type", operator: "=", value: "GENERATION", type: "string" },
    { column: "userId", operator: "=", value: tenantSlug, type: "string" },
  ];
}

export async function getLangfuseCosts(
  ctx: TenantContext,
  filter: { since?: Date; source?: UsageSource },
  base: PrismaClient = basePrisma,
  fetchFn: typeof fetch = fetch,
): Promise<LangfuseCosts> {
  if (!ctx.tenantId) return { status: "disabled" };
  const tenantId = ctx.tenantId;
  // Config resolution must run inside a scoped tx (RLS + vault decryption).
  const cfg = await runScopedOn(base, ctx, (db) =>
    resolveLangfuseConfig(db, tenantId),
  );
  if (!cfg) return { status: "disabled" };
  // No slug, no fence, no query. An unfenced read would answer with the project's total, which is
  // not this tenant's; the poll refuses for the same reason. Unreachable while `tenants.slug` is
  // filled, and reachable enough that the database would take an empty one.
  if (!cfg.tenantSlug) {
    logger.warn(
      { tenantId },
      "langfuse cost fetch skipped: the tenant has no slug to fence the query by",
    );
    return { status: "error" };
  }

  const apiBase = cfg.baseUrl ?? "https://cloud.langfuse.com";
  const fromTimestamp = (
    filter.since ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  ).toISOString();
  const toTimestamp = new Date().toISOString();

  const baseQuery = {
    view: "observations",
    metrics: [{ measure: "totalCost", aggregation: "sum" }],
    filters: costFilters(cfg.tenantSlug, filter.source),
    fromTimestamp,
    toTimestamp,
  };

  try {
    // projectId resolution runs concurrently; it's internally best-effort (never throws) so it can't
    // fail the cost fetch, and it's cached after the first load (no extra round-trip thereafter).
    const [dailyRows, modelRows, projectId] = await Promise.all([
      fetchMetrics(
        apiBase,
        cfg.publicKey,
        cfg.secretKey,
        {
          ...baseQuery,
          dimensions: [],
          timeDimension: { granularity: "day" },
        },
        fetchFn,
      ),
      fetchMetrics(
        apiBase,
        cfg.publicKey,
        cfg.secretKey,
        {
          ...baseQuery,
          dimensions: [{ field: "providedModelName" }],
        },
        fetchFn,
      ),
      resolveLangfuseProjectId(apiBase, cfg.publicKey, cfg.secretKey, fetchFn),
    ]);

    const days = dailyRows
      .map((r) => {
        const date = extractDateKey(r);
        if (!date) return null;
        return { date, costUsd: Number(r.sum_totalCost ?? 0) };
      })
      .filter((d): d is { date: string; costUsd: number } => d !== null);

    const totalCostUsd = days.reduce((sum, d) => sum + d.costUsd, 0);

    const byModel = modelRows
      .map((r) => ({
        model:
          typeof r.providedModelName === "string" && r.providedModelName
            ? r.providedModelName
            : "unknown",
        costUsd: Number(r.sum_totalCost ?? 0),
      }))
      .sort((a, b) => b.costUsd - a.costUsd);

    return {
      status: "ok",
      totalCostUsd,
      days,
      byModel,
      baseUrl: apiBase,
      projectUrl: projectId ? `${apiBase}/project/${projectId}` : undefined,
    };
  } catch (err) {
    logger.warn({ err, tenantId: ctx.tenantId }, "langfuse cost fetch failed");
    return { status: "error" };
  }
}
