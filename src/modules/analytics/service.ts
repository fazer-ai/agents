import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import metricsPrisma from "@/api/lib/prisma-metrics";
import { badQueryParam } from "@/lib/query-param";
import type { TenantContext } from "@/lib/tenancy";
import { runMetricsScoped } from "./budget";
import {
  dividesByConversations,
  funnelCountsSql,
  responsesCtesSql,
  withRunsMark,
} from "./conversation-sums";
import {
  agentRanSql,
  cohortWhereSql,
  type DashboardFilter,
  localDaySql,
  outcomeSql,
} from "./filter";
import { histogramPercentile, ledgerCtesSql, sumsBounds } from "./ledger-sums";

// Instance metrics for the operational dashboard. LLM tokens/calls are aggregated FROM THE LOCAL
// LlmUsage table (captured at the source in the model callback), never mirrored from Langfuse —
// so the figures are RLS-isolated, fleet-aggregable, and survive Langfuse being down/optional.
// The cost figures are read from the same ledger by ./costs.ts.
// All aggregation runs INSIDE the scoped tx (GUC active) so RLS fences it to the tenant; a raw
// query outside the tx would leak or zero out. The $extends auto-scopes writes only, so reads
// rely on RLS here — which is exactly the boundary we want.

export interface AgentUsage {
  agentId: string | null;
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface InboxUsage {
  inboxId: string;
  name: string | null;
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface ModelUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
  calls: number;
}

export interface SourceUsage {
  source: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface InstanceMetrics {
  llm: {
    promptTokens: number;
    completionTokens: number;
    // Cached input (a discounted SUBSET of promptTokens, not additive).
    cachedReadTokens: number;
    cacheCreationTokens: number;
    calls: number;
    byAgent: AgentUsage[];
    byInbox: InboxUsage[];
    byModel: ModelUsage[];
    // The real-vs-playground split, ALWAYS computed across every source (ignores `filter.source`)
    // so the UI can show the breakdown regardless of which segment is selected.
    bySource: SourceUsage[];
  };
  conversations: {
    total: number;
    byStatus: { status: string; count: number }[];
  };
}

// The page's filter (./filter.ts). Kept under this name for the MCP readers that import it.
export type MetricsFilter = DashboardFilter;

// Validate an IANA timezone before interpolating it into `AT TIME ZONE` (an unknown zone makes
// Postgres throw). A zone the caller sent and this cannot read is refused, not replaced: falling back
// to UTC would shift a late local turn onto tomorrow with numbers that look right. Absent means UTC;
// `""` is a value (what a cleared select submits) and is refused.
export function normalizeTimeZone(tz: string | undefined): string {
  if (tz === undefined) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    badQueryParam("tz");
  }
}

export async function getInstanceMetrics(
  ctx: TenantContext,
  filter: MetricsFilter = {},
  base: PrismaClient = metricsPrisma,
): Promise<InstanceMetrics> {
  return runMetricsScoped(base, ctx, async (db) => {
    // Every ledger figure from the view's quarter-hour sums (./ledger-sums.ts), grouped once.
    const bounds = await sumsBounds(db, filter);
    type Grouped = {
      set: number;
      agent_id: bigint | null;
      inbox_id: bigint | null;
      model: string | null;
      prompt: bigint | number;
      completion: bigint | number;
      cached: bigint | number;
      creation: bigint | number;
      calls: number;
    };
    const grouped = await db.$queryRaw<Grouped[]>(Prisma.sql`
      WITH ${ledgerCtesSql(filter, bounds)}
      SELECT GROUPING(l.agent_id, l.inbox_id, l.model)::int AS set, l.agent_id, l.inbox_id, l.model,
             COALESCE(SUM(l.prompt_tokens), 0)::bigint AS prompt,
             COALESCE(SUM(l.completion_tokens), 0)::bigint AS completion,
             COALESCE(SUM(l.cached_read_tokens), 0)::bigint AS cached,
             COALESCE(SUM(l.cache_creation_tokens), 0)::bigint AS creation,
             COALESCE(SUM(l.requests), 0)::int AS calls
        FROM ledger l
       GROUP BY GROUPING SETS ((l.agent_id), (l.inbox_id), (l.model), ())`);
    // GROUPING's bits are (agent, inbox, model), set where the column is NOT a key of the row.
    const of = (set: number) =>
      grouped
        .filter((r) => r.set === set)
        .sort(
          (x, y) =>
            Number(y.prompt) - Number(x.prompt) ||
            String(x.agent_id ?? x.inbox_id ?? x.model).localeCompare(
              String(y.agent_id ?? y.inbox_id ?? y.model),
            ),
        );
    const [whole] = of(0b111);
    const totals = {
      _sum: {
        promptTokens: Number(whole?.prompt ?? 0),
        completionTokens: Number(whole?.completion ?? 0),
        cachedReadTokens: Number(whole?.cached ?? 0),
        cacheCreationTokens: Number(whole?.creation ?? 0),
      },
      _count: { _all: Number(whole?.calls ?? 0) },
    };
    const sumsOf = (r: Grouped) => ({
      _sum: {
        promptTokens: Number(r.prompt),
        completionTokens: Number(r.completion),
        cachedReadTokens: Number(r.cached),
      },
      _count: { _all: Number(r.calls) },
    });
    const perAgent = of(0b011).map((r) => ({
      agentId: r.agent_id,
      ...sumsOf(r),
    }));
    // A filtered inbox already excludes the rows with none.
    const perInbox = of(0b101)
      .filter((r) => r.inbox_id !== null)
      .map((r) => ({ inboxId: r.inbox_id, ...sumsOf(r) }));
    const perModel = of(0b110).map((r) => ({
      model: r.model as string,
      ...sumsOf(r),
    }));

    // The real-vs-playground split: ALWAYS across every source (the window, the agent and the inbox
    // apply), so the segmented control can label each option independent of the current selection.
    const everySource = {
      ...filter,
      source: undefined,
      audience: undefined,
    };
    const perSource = (
      await db.$queryRaw<
        {
          source: string;
          prompt: bigint | number;
          completion: bigint | number;
          calls: number;
        }[]
      >(Prisma.sql`
        WITH ${ledgerCtesSql(everySource, await sumsBounds(db, everySource))}
        SELECT l.source, COALESCE(SUM(l.prompt_tokens), 0)::bigint AS prompt,
               COALESCE(SUM(l.completion_tokens), 0)::bigint AS completion,
               COALESCE(SUM(l.requests), 0)::int AS calls
          FROM ledger l
         GROUP BY 1
         ORDER BY 1`)
    ).map((r) => ({
      source: r.source,
      _sum: {
        promptTokens: Number(r.prompt),
        completionTokens: Number(r.completion),
      },
      _count: { _all: Number(r.calls) },
    }));

    // Resolve inbox names by id (RLS-scoped), mirroring how getKpis resolves conversations by id.
    const inboxIds = perInbox
      .map((r) => r.inboxId)
      .filter((x): x is bigint => x !== null);
    const inboxNames = new Map<string, string>();
    if (inboxIds.length > 0) {
      const inboxes = await db.inbox.findMany({
        where: { id: { in: inboxIds } },
        select: { id: true, name: true },
      });
      for (const ib of inboxes) inboxNames.set(String(ib.id), ib.name);
    }

    // Where the conversations stand now, so the window does not apply (it never did: a status is
    // today's, not the period's). The agent and the inbox do, by the same rule as every
    // conversation figure, or one inbox's usage would sit beside every inbox's conversations.
    const byStatus = (
      await db.$queryRaw<{ status: string; count: number }[]>(Prisma.sql`
        SELECT c.status::text AS status, COUNT(*)::int AS count
          FROM conversations c
         WHERE ${cohortWhereSql("c", { agentId: filter.agentId, inboxId: filter.inboxId, runsMark: (await withRunsMark(db, filter)).runsMark })}
         GROUP BY 1`)
    ).map((r) => ({ status: r.status, _count: { _all: r.count } }));

    const convTotal = byStatus.reduce((acc, s) => acc + s._count._all, 0);

    return {
      llm: {
        promptTokens: totals._sum.promptTokens ?? 0,
        completionTokens: totals._sum.completionTokens ?? 0,
        cachedReadTokens: totals._sum.cachedReadTokens ?? 0,
        cacheCreationTokens: totals._sum.cacheCreationTokens ?? 0,
        calls: totals._count._all,
        byAgent: perAgent.map((a) => ({
          agentId: a.agentId === null ? null : String(a.agentId),
          promptTokens: a._sum.promptTokens ?? 0,
          completionTokens: a._sum.completionTokens ?? 0,
          calls: a._count._all,
        })),
        byInbox: perInbox.map((r) => {
          const id = String(r.inboxId);
          return {
            inboxId: id,
            name: inboxNames.get(id) ?? null,
            promptTokens: r._sum.promptTokens ?? 0,
            completionTokens: r._sum.completionTokens ?? 0,
            calls: r._count._all,
          };
        }),
        byModel: perModel.map((m) => ({
          model: m.model,
          promptTokens: m._sum.promptTokens ?? 0,
          completionTokens: m._sum.completionTokens ?? 0,
          cachedReadTokens: m._sum.cachedReadTokens ?? 0,
          calls: m._count._all,
        })),
        bySource: perSource.map((s) => ({
          source: s.source,
          promptTokens: s._sum.promptTokens ?? 0,
          completionTokens: s._sum.completionTokens ?? 0,
          calls: s._count._all,
        })),
      },
      conversations: {
        total: convTotal,
        byStatus: byStatus.map((s) => ({
          status: s.status,
          count: s._count._all,
        })),
      },
    };
  });
}

// Operational KPIs (the AI-support-agent standard: Intercom Fin / OpenAI), over the conversations of
// the view (`cohortWhereSql`: created in the window, in the filtered inbox, of the filtered agent).
// "Involved" = the agent took a turn on it (an agent-turn ledger row). Resolution = of those, how many
// the AGENT itself closed, read from `Conversation.resolvedBy` (not from status and assignee, which
// counts follow-up and Chatwoot auto-resolve closings; see resolution-origin.ts). Automation =
// Involvement × Resolution. Every count is over ONE set of conversations, so no rate passes 100% and
// a day's point on the trend is the tile of a one-day window (docs/dashboard.md).
export interface DashboardKpis {
  totalConversations: number;
  involved: number;
  resolvedByBot: number;
  handoff: number;
  // Involved conversations already resolved when this instance started recording the origin. They
  // cannot be attributed either way, so they are reported instead of counted, and the dashboard says
  // so — otherwise the funnel steps down on upgrade day and reads as the agent getting worse.
  resolvedBeforeTracking: number;
  involvementRate: number;
  resolutionRate: number;
  automationRate: number;
  handoffRate: number;
  // Seconds from creation to the team's first reply, Chatwoot's own first-response SLA mirrored
  // rather than recomputed: the median and the 90th percentile, because one weekend conversation
  // moves a mean by hours. NULL when no conversation of the view carries both readings, hence the
  // sample count beside them. A conversation the business opened counts its own opening message as
  // the reply, as Chatwoot does.
  firstResponseSeconds: number | null;
  firstResponseP90Seconds: number | null;
  firstResponseSampled: number;
}

export interface OutcomeCounts {
  total: number;
  involved: number;
  resolvedByBot: number;
  handoff: number;
  resolvedBeforeTracking: number;
}

export function outcomeRates(c: OutcomeCounts) {
  return {
    involvementRate: c.total > 0 ? c.involved / c.total : 0,
    resolutionRate: c.involved > 0 ? c.resolvedByBot / c.involved : 0,
    automationRate: c.total > 0 ? c.resolvedByBot / c.total : 0,
    handoffRate: c.total > 0 ? c.handoff / c.total : 0,
  };
}

// The counts behind the funnel, as SQL aggregates over the view's conversations. `group` adds one
// grouping column (a local day, an agent, an inbox); without it the result is a single row. Each
// conversation's outcome and "the agent ran on it" are worked out once, in the materialized rows, and
// the five counts read them: written into each FILTER, the ledger probe ran once per figure.
export function outcomeCountsSql(
  f: DashboardFilter,
  group?: { key: Prisma.Sql },
): Prisma.Sql {
  return Prisma.sql`
    WITH v AS MATERIALIZED (
      SELECT ${group ? Prisma.sql`${group.key} AS key,` : Prisma.empty}
             ${outcomeSql("c")} AS outcome,
             ${agentRanSql("c", f.agentId)} AS ran
        FROM conversations c
       WHERE ${cohortWhereSql("c", f)}
    )
    SELECT ${group ? Prisma.sql`v.key,` : Prisma.empty}
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE v.ran)::int AS involved,
           COUNT(*) FILTER (WHERE v.ran AND v.outcome = 'resolved_by_agent')::int AS resolved,
           COUNT(*) FILTER (WHERE v.ran AND v.outcome = 'handoff')::int AS handoff,
           COUNT(*) FILTER (WHERE v.ran AND v.outcome = 'resolved_before_tracking')::int AS untracked
      FROM v
     ${group ? Prisma.sql`GROUP BY 1` : Prisma.empty}`;
}

export interface OutcomeRow {
  key?: string | null;
  total: number;
  involved: number;
  resolved: number;
  handoff: number;
  untracked: number;
}

export function toCounts(r: OutcomeRow | undefined): OutcomeCounts {
  return {
    total: Number(r?.total ?? 0),
    involved: Number(r?.involved ?? 0),
    resolvedByBot: Number(r?.resolved ?? 0),
    handoff: Number(r?.handoff ?? 0),
    resolvedBeforeTracking: Number(r?.untracked ?? 0),
  };
}

// The conversations a first-response time is read from, as `c`.
export const FIRST_RESPONSE_SAMPLE_SQL = Prisma.sql`c.chatwoot_created_at IS NOT NULL
         AND c.chatwoot_first_reply_at IS NOT NULL
         -- A reply cannot precede the conversation that carries it: a clock skew or a hand-written
         -- row would otherwise contribute a negative "response time".
         AND c.chatwoot_first_reply_at >= c.chatwoot_created_at
         -- A first reply the platform posted is not a person answering. Compared exactly, and to
         -- the second only when the stored reading has no fraction: the REST partial renders it as
         -- epoch seconds, and then a person and the platform in the same second cannot be told apart.
         AND NOT (
           c.chatwoot_platform_reply_at IS NOT NULL
           AND (c.chatwoot_platform_reply_at = c.chatwoot_first_reply_at
                OR date_trunc('second', c.chatwoot_platform_reply_at) = c.chatwoot_first_reply_at)
         )`;

export async function getKpis(
  ctx: TenantContext,
  filter: DashboardFilter = {},
  base: PrismaClient = metricsPrisma,
): Promise<DashboardKpis> {
  return runMetricsScoped(base, ctx, async (db) => {
    // A billed call is not the same claim as "the agent took this conversation", and this is
    // the reader that makes the second one. Vision runs on the incoming attachment before the
    // bot-ownership gate decides anything, so an image sent into a conversation a human handled start
    // to finish must not land here as bot involvement: `agentRanSql` counts agent turns only.
    const view = await withRunsMark(db, filter);
    const bounds = await sumsBounds(db, view);
    const [row] = await db.$queryRaw<OutcomeRow[]>(
      funnelCountsSql(view, bounds),
    );
    const counts = toCounts(row);
    // The first response percentiles from the histogram of 5%-wide buckets (./conversation-sums.ts),
    // within 2.5% of the exact ones; the sample size is exact.
    const histogram = (
      await db.$queryRaw<
        {
          bucket: number;
          conversations: number;
          min_seconds: number;
          max_seconds: number;
        }[]
      >(
        Prisma.sql`WITH ${responsesCtesSql(view, bounds)}
          SELECT bucket, SUM(conversations)::int AS conversations, MIN(min_seconds) AS min_seconds,
                 MAX(max_seconds) AS max_seconds
            FROM responses GROUP BY 1`,
      )
    ).map((r) => ({
      bucket: Number(r.bucket),
      calls: Number(r.conversations),
      min: Number(r.min_seconds),
      max: Number(r.max_seconds),
    }));
    const sampledTotal = histogram.reduce((n, h) => n + h.calls, 0);
    const responseRow = {
      median: histogramPercentile(histogram, 0.5),
      p90: histogramPercentile(histogram, 0.9),
      sampled: sampledTotal,
    };
    // An empty sample has no percentile: both are null together with `sampled` 0.
    const sampled = responseRow.sampled;
    return {
      totalConversations: counts.total,
      involved: counts.involved,
      resolvedByBot: counts.resolvedByBot,
      handoff: counts.handoff,
      resolvedBeforeTracking: counts.resolvedBeforeTracking,
      firstResponseSeconds:
        responseRow?.median != null ? Number(responseRow.median) : null,
      firstResponseP90Seconds:
        responseRow?.p90 != null ? Number(responseRow.p90) : null,
      firstResponseSampled: sampled,
      ...outcomeRates(counts),
    };
  });
}

export interface TimeseriesPoint {
  // Local day key (YYYY-MM-DD) in the requested timezone. See getTimeseries.
  bucket: string;
  calls: number;
  // The funnel's conversations created that local day that the agent ran on. Feeds the
  // cost-per-conversation line on the dashboard chart.
  conversations: number;
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
}

// Daily LLM usage series for the dashboard chart, run INSIDE the scoped tx so RLS fences llm_usage
// (never filter tenant_id by hand). `bucket` is a local day key (YYYY-MM-DD, as text) in `filter.tz`.
// created_at is `timestamp WITHOUT time zone` holding UTC wall-clock, so it is double-shifted:
// `AT TIME ZONE 'UTC'` makes it an instant, then `AT TIME ZONE $tz` renders it in the target zone.
// A single shift would read the stored value as already being in $tz.
export async function getTimeseries(
  ctx: TenantContext,
  filter: MetricsFilter = {},
  base: PrismaClient = metricsPrisma,
): Promise<TimeseriesPoint[]> {
  const tz = normalizeTimeZone(filter.tz);
  return runMetricsScoped(base, ctx, async (db) => {
    const bounds = await sumsBounds(db, filter);
    const rows = await db.$queryRaw<
      {
        bucket: string;
        calls: number;
        prompt: number;
        completion: number;
        cached: number;
      }[]
    >(Prisma.sql`
      WITH ${ledgerCtesSql(filter, bounds)}
      SELECT ${localDaySql(Prisma.sql`l.quarter`, tz)} AS bucket,
             COALESCE(SUM(l.requests), 0)::int AS calls,
             COALESCE(SUM(l.prompt_tokens), 0)::bigint AS prompt,
             COALESCE(SUM(l.completion_tokens), 0)::bigint AS completion,
             COALESCE(SUM(l.cached_read_tokens), 0)::bigint AS cached
        FROM ledger l
       GROUP BY 1
       ORDER BY 1 ASC`);
    // The conversations of each day are the funnel's (the day's conversations the agent ran on),
    // the divisor of the cost-per-conversation line (docs/dashboard.md). A view of other traffic
    // than real conversations has none.
    const view = await withRunsMark(db, filter);
    const funnel = dividesByConversations(filter)
      ? await db.$queryRaw<{ key: string; involved: number }[]>(
          funnelCountsSql(
            view,
            await sumsBounds(db, view),
            localDaySql(Prisma.sql`v.quarter`, tz),
          ),
        )
      : [];
    const convByDay = new Map(funnel.map((r) => [r.key, Number(r.involved)]));
    const days = [
      ...new Set([...rows.map((r) => r.bucket), ...convByDay.keys()]),
    ].sort();
    const byDay = new Map(rows.map((r) => [r.bucket, r]));
    return days.map((day) => {
      const r = byDay.get(day);
      return {
        bucket: day,
        calls: Number(r?.calls ?? 0),
        conversations: convByDay.get(day) ?? 0,
        promptTokens: Number(r?.prompt ?? 0),
        completionTokens: Number(r?.completion ?? 0),
        cachedReadTokens: Number(r?.cached ?? 0),
      };
    });
  });
}
