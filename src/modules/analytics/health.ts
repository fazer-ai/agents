import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import metricsPrisma from "@/api/lib/prisma-metrics";
import type { TenantContext } from "@/lib/tenancy";
import { runMetricsScoped } from "./budget";
import { type DashboardFilter, logWhereSql } from "./filter";
import {
  type HistogramBucket,
  histogramPercentile,
  latencyCtesSql,
  sumsBounds,
} from "./ledger-sums";

// IS IT HEALTHY: how long the model calls take, and what went wrong where. Latency is the ledger's
// own timing of each call (`llm_usage.duration_ms`); the problems are the flow log's warn and error
// lines, grouped by stage and, for tool lines, by tool, so each row opens the Logs page on exactly
// those lines (docs/dashboard.md).

export interface ModelLatency {
  model: string;
  // Calls with a timing. Rows from before the column carry none and are not in the percentiles.
  calls: number;
  p50Ms: number | null;
  p90Ms: number | null;
}

export interface ProblemRow {
  stage: string;
  // The tool, for a tool line; null for every other stage.
  tool: string | null;
  level: "warn" | "error";
  lines: number;
  conversations: number;
}

export interface HealthReport {
  latency: ModelLatency[];
  problems: ProblemRow[];
}

export async function getHealth(
  ctx: TenantContext,
  filter: DashboardFilter,
  base: PrismaClient = metricsPrisma,
): Promise<HealthReport> {
  return runMetricsScoped(base, ctx, async (db) => {
    // The latency from the histogram of 5%-wide buckets (./ledger-sums.ts): each percentile is
    // within 2.5% of the exact one, and `calls` is exact.
    const bounds = await sumsBounds(db, filter);
    const histogram = await db.$queryRaw<
      {
        model: string;
        bucket: number;
        calls: number;
        min_ms: number;
        max_ms: number;
      }[]
    >(Prisma.sql`
      WITH ${latencyCtesSql(filter, bounds)}
      SELECT model, bucket, SUM(calls)::int AS calls, MIN(min_ms)::int AS min_ms, MAX(max_ms)::int AS max_ms
        FROM latency GROUP BY 1, 2`);
    const byModel = new Map<string, HistogramBucket[]>();
    for (const r of histogram) {
      const list = byModel.get(r.model) ?? [];
      list.push({
        bucket: Number(r.bucket),
        calls: Number(r.calls),
        min: Number(r.min_ms),
        max: Number(r.max_ms),
      });
      byModel.set(r.model, list);
    }
    const latency = [...byModel.entries()]
      .map(([model, buckets]) => ({
        model,
        calls: buckets.reduce((n, b) => n + b.calls, 0),
        p50: histogramPercentile(buckets, 0.5),
        p90: histogramPercentile(buckets, 0.9),
      }))
      .sort((a, b) => b.calls - a.calls);
    const problems = await db.$queryRaw<
      {
        stage: string;
        tool: string | null;
        level: string;
        lines: number;
        conversations: number;
      }[]
    >(Prisma.sql`
      SELECT l.stage,
             CASE WHEN l.stage = 'tool' THEN l.detail->>'tool' END AS tool,
             l.level,
             COUNT(*)::int AS lines,
             COUNT(DISTINCT l.conversation_id)::int AS conversations
        FROM execution_logs l
       WHERE ${logWhereSql("l", filter)} AND l.level IN ('warn', 'error')
       GROUP BY 1, 2, 3
       ORDER BY 4 DESC`);
    return {
      latency: latency
        .map((r) => ({
          model: r.model,
          calls: Number(r.calls),
          p50Ms: r.p50 == null ? null : Number(r.p50),
          p90Ms: r.p90 == null ? null : Number(r.p90),
        }))
        .sort(latencyOrder),
      problems: problems
        .map(
          (r): ProblemRow => ({
            stage: r.stage,
            tool: r.tool,
            level: r.level === "error" ? "error" : "warn",
            lines: Number(r.lines),
            conversations: Number(r.conversations),
          }),
        )
        .sort(problemOrder),
    };
  });
}

// Rows that tie keep one fixed order, the one the console always showed: Postgres hands tied groups
// back in whatever order its plan produced them, which changes with the volume.
export function problemOrder(a: ProblemRow, b: ProblemRow): number {
  return (
    b.lines - a.lines ||
    a.stage.localeCompare(b.stage) ||
    String(a.tool).localeCompare(String(b.tool)) ||
    a.level.localeCompare(b.level)
  );
}

export function latencyOrder(
  a: { calls: number; model: string },
  b: { calls: number; model: string },
): number {
  return b.calls - a.calls || a.model.localeCompare(b.model);
}
