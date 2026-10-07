import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type DashboardFilter, logWhereSql, usageWhereSql } from "./filter";

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
  base: PrismaClient = basePrisma,
): Promise<HealthReport> {
  return runScopedOn(base, ctx, async (db) => {
    const latency = await db.$queryRaw<
      {
        model: string;
        calls: number;
        p50: number | null;
        p90: number | null;
      }[]
    >(Prisma.sql`
      SELECT u.model,
             COUNT(*)::int AS calls,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY u.duration_ms)::float8 AS p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY u.duration_ms)::float8 AS p90
        FROM llm_usage u
       WHERE ${usageWhereSql("u", filter)} AND u.duration_ms IS NOT NULL
       GROUP BY 1
       ORDER BY 2 DESC`);
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
      latency: latency.map((r) => ({
        model: r.model,
        calls: Number(r.calls),
        p50Ms: r.p50 == null ? null : Number(r.p50),
        p90Ms: r.p90 == null ? null : Number(r.p90),
      })),
      problems: problems.map((r) => ({
        stage: r.stage,
        tool: r.tool,
        level: r.level === "error" ? "error" : "warn",
        lines: Number(r.lines),
        conversations: Number(r.conversations),
      })),
    };
  });
}
