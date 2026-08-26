import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { NON_AGENT_TURN_NODES, type UsageSource } from "@/graph/usage";
import { badQueryParam } from "@/lib/query-param";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { classifyOutcome } from "@/modules/conversations/resolution-origin";

// Instance metrics for the operational dashboard. LLM tokens/calls are aggregated FROM THE LOCAL
// LlmUsage table (captured at the source in the model callback), never mirrored from Langfuse —
// so the figures are RLS-isolated, fleet-aggregable, and survive Langfuse being down/optional.
// Cost is no longer stored locally; it comes from Langfuse (see langfuse-costs.ts).
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

export interface MetricsFilter {
  since?: Date;
  // Usage segment. Omitted → all sources ("Todos"). The dashboard defaults to "inbox" so test
  // turns don't inflate the real figures.
  source?: UsageSource;
  // IANA timezone (e.g. "America/Sao_Paulo") used to bucket the daily timeseries. Omitted/invalid
  // → UTC. Only `getTimeseries` reads it; aggregate KPIs are timezone-agnostic (absolute sums).
  tz?: string;
}

// Validate an IANA timezone before interpolating it into `AT TIME ZONE` (an unknown zone makes
// Postgres throw). `Intl.DateTimeFormat` throws RangeError for bad zones.
//
// A zone the caller SENT and this cannot read is refused, not replaced (issue #372). The fallback
// this replaces is the worst shape of the family: `tz=America/Sao_Paolo` (one typo) silently
// bucketed the dashboard in UTC, so a 21h local turn showed up on tomorrow — the exact bug the
// zone parameter exists to prevent, with numbers that look right. ABSENT still means UTC, because
// absent is not a value; `""` is one, and it is what a cleared select submits.
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
  base: PrismaClient = basePrisma,
): Promise<InstanceMetrics> {
  const sinceWhere = filter.since ? { createdAt: { gte: filter.since } } : {};
  const usageWhere = {
    ...sinceWhere,
    ...(filter.source ? { source: filter.source } : {}),
  };

  return runScopedOn(base, ctx, async (db) => {
    const sumSelect = {
      promptTokens: true,
      completionTokens: true,
      cachedReadTokens: true,
      cacheCreationTokens: true,
    } as const;

    const totals = await db.llmUsage.aggregate({
      where: usageWhere,
      _sum: sumSelect,
      _count: { _all: true },
    });

    const perAgent = await db.llmUsage.groupBy({
      by: ["agentId"],
      where: usageWhere,
      _sum: { promptTokens: true, completionTokens: true },
      _count: { _all: true },
      orderBy: { _sum: { promptTokens: "desc" } },
    });

    const perInbox = await db.llmUsage.groupBy({
      by: ["inboxId"],
      where: { ...usageWhere, inboxId: { not: null } },
      _sum: { promptTokens: true, completionTokens: true },
      _count: { _all: true },
      orderBy: { _sum: { promptTokens: "desc" } },
    });

    const perModel = await db.llmUsage.groupBy({
      by: ["model"],
      where: usageWhere,
      _sum: {
        promptTokens: true,
        completionTokens: true,
        cachedReadTokens: true,
      },
      _count: { _all: true },
      orderBy: { _sum: { promptTokens: "desc" } },
    });

    // The real-vs-playground split: ALWAYS across every source (only the `since` window applies),
    // so the segmented control can label each option independent of the current selection.
    const perSource = await db.llmUsage.groupBy({
      by: ["source"],
      where: sinceWhere,
      _sum: { promptTokens: true, completionTokens: true },
      _count: { _all: true },
    });

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

    const byStatus = await db.conversation.groupBy({
      by: ["status"],
      _count: { _all: true },
    });

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

// Operational KPIs (the AI-support-agent standard: Intercom Fin / OpenAI). "Involved" = the bot
// actually ran on the conversation (it produced LlmUsage). Resolution = of those, how many the AGENT
// itself closed. Automation = Involvement × Resolution = resolved-by-bot / total. All computed from
// local data (LlmUsage + the Conversation mirror), RLS-scoped inside the tx.
//
// Resolution used to read `status === "resolved" && assigneeType !== "User"`, which counted six
// closings that are not the agent's — including a follow-up ladder closing out a lead that never
// answered, and Chatwoot's own `auto_resolve_after`. Both make the number RISE as engagement gets
// worse. It now reads `Conversation.resolvedBy`, recorded where we close a conversation; the whole
// argument is in src/modules/conversations/resolution-origin.ts.
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
  // MEDIAN seconds from the conversation's creation to the team's first reply — Chatwoot's own
  // first-response SLA, mirrored (`chatwootCreatedAt` / `chatwootFirstReplyAt`) rather than
  // recomputed, so this reports the same number the operator reads on the Chatwoot dashboard.
  // Median and not mean: one conversation opened on a Friday night and answered on Monday moves a
  // mean by hours and says nothing about the week.
  //
  // This is the only KPI here that does not go through LlmUsage, and it is the only one that still
  // answers on an inbox the agent never touched. NULL when no conversation in the window carries
  // both readings — a conversation nobody has answered yet has no response time, and one no event
  // has been seen for since the columns existed has not been mirrored yet. Hence the sample count
  // beside it: a median over four conversations is not a service level, and the caller has to be
  // able to tell that apart from a median over four hundred.
  //
  // A conversation the BUSINESS opened counts its own opening message as the reply, because that is
  // what `first_reply_created_at` means to Chatwoot. Timing the customer's wait instead is a
  // different metric (Chatwoot answers it with `waiting_since`) and a different decision.
  firstResponseSeconds: number | null;
  firstResponseSampled: number;
}

export async function getKpis(
  ctx: TenantContext,
  filter: MetricsFilter = {},
  base: PrismaClient = basePrisma,
): Promise<DashboardKpis> {
  return runScopedOn(base, ctx, async (db) => {
    const totalConversations = await db.conversation.count({
      where: filter.since ? { createdAt: { gte: filter.since } } : {},
    });
    const involvedRows = await db.llmUsage.findMany({
      where: {
        // KPIs are always about real customer conversations: playground turns never create a
        // mirror conversation (conversationId stays null), and source="inbox" makes that explicit.
        conversationId: { not: null },
        source: "inbox",
        // A billed call is not the same claim as "the agent took this conversation", and this is
        // the only reader that makes the second one. Vision runs on the incoming attachment before
        // the bot-ownership gate decides anything, so an image sent into a conversation a human
        // handled start to finish would otherwise land here as bot involvement.
        //   The null arm is not a formality: Prisma renders `notIn` as plain SQL `NOT IN`, which
        // drops NULL rows rather than keeping them (measured), and a legacy row with no node is an
        // agent turn. Without it this filter would quietly shrink every historical figure.
        OR: [{ node: null }, { node: { notIn: [...NON_AGENT_TURN_NODES] } }],
        ...(filter.since ? { createdAt: { gte: filter.since } } : {}),
      },
      select: { conversationId: true },
      distinct: ["conversationId"],
    });
    const involvedIds = involvedRows
      .map((r) => r.conversationId)
      .filter((x): x is bigint => x !== null);
    const involved = involvedIds.length;
    let resolvedByBot = 0;
    let handoff = 0;
    let resolvedBeforeTracking = 0;
    if (involved > 0) {
      const convs = await db.conversation.findMany({
        where: { id: { in: involvedIds } },
        select: { status: true, assigneeType: true, resolvedBy: true },
      });
      for (const c of convs) {
        switch (classifyOutcome(c)) {
          case "handoff":
            handoff += 1;
            break;
          case "resolved_by_agent":
            resolvedByBot += 1;
            break;
          case "resolved_before_tracking":
            resolvedBeforeTracking += 1;
            break;
          // NOTE: resolved_by_other / unresolved: neither a resolution nor a handoff.
        }
      }
    }
    // Raw SQL for percentile_cont (no Prisma builder), inside the scoped tx so RLS fences the rows —
    // never filter tenant_id by hand. EPOCH of the difference: both columns are mirrored from the
    // same Chatwoot row, so the subtraction is between two readings of one source rather than
    // across two clocks.
    const [responseRow] = await db.$queryRaw<
      { median: number | null; sampled: number }[]
    >(Prisma.sql`
      SELECT percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (chatwoot_first_reply_at - chatwoot_created_at))
             )::float8 AS median,
             COUNT(*)::int AS sampled
        FROM conversations
       WHERE chatwoot_created_at IS NOT NULL
         AND chatwoot_first_reply_at IS NOT NULL
         -- A reply cannot precede the conversation that carries it: a clock skew or a hand-written
         -- row would otherwise contribute a negative "response time".
         AND chatwoot_first_reply_at >= chatwoot_created_at
         -- The window is the one the other KPIs use — OUR row's createdAt — so a filtered dashboard
         -- counts the same conversations here as it does above.
         AND (${filter.since ?? null}::timestamptz IS NULL OR created_at >= ${filter.since ?? null})`);
    // COUNT and the percentile come from ONE aggregate over the same rows, so they cannot
    // disagree: no row in the sample means `sampled` is 0 and `median` is NULL together.
    const sampled = Number(responseRow?.sampled ?? 0);

    return {
      totalConversations,
      involved,
      resolvedByBot,
      handoff,
      resolvedBeforeTracking,
      firstResponseSeconds:
        responseRow?.median != null ? Number(responseRow.median) : null,
      firstResponseSampled: sampled,
      involvementRate:
        totalConversations > 0 ? involved / totalConversations : 0,
      resolutionRate: involved > 0 ? resolvedByBot / involved : 0,
      automationRate:
        totalConversations > 0 ? resolvedByBot / totalConversations : 0,
    };
  });
}

export interface TimeseriesPoint {
  // Local day key (YYYY-MM-DD) in the requested timezone. See getTimeseries.
  bucket: string;
  calls: number;
  // Distinct conversations that had LLM usage that local day (COUNT DISTINCT conversation_id, NULLs
  // ignored). Feeds the cost-per-conversation line on the dashboard chart.
  conversations: number;
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
}

// Daily LLM usage series for the dashboard chart. Raw SQL (date_trunc has no Prisma builder)
// runs INSIDE the scoped tx so RLS fences llm_usage to the tenant — never filter tenant_id by hand.
// Respects `filter.source` (omitted → all sources) so the chart tracks the selected segment.
//
// `bucket` is a LOCAL day key (YYYY-MM-DD) in `filter.tz`, not a UTC ISO instant, so a 22h-BRT turn
// (01h UTC) lands on the right local day instead of leaking into "tomorrow" in UTC. Returning the
// key as text (to_char) keeps it unambiguous on the client (no Date/timezone round-trip).
//   created_at is `timestamp WITHOUT time zone` (Prisma's default) holding the UTC wall-clock, so we
// double-shift: `AT TIME ZONE 'UTC'` reads the naive value AS UTC → a real instant (timestamptz),
// then `AT TIME ZONE $tz` renders that instant as wall-clock in the target zone. A single shift
// would (wrongly) interpret the stored value as already being in $tz.
export async function getTimeseries(
  ctx: TenantContext,
  filter: MetricsFilter = {},
  base: PrismaClient = basePrisma,
): Promise<TimeseriesPoint[]> {
  const since = filter.since ?? null;
  const source = filter.source ?? null;
  const tz = normalizeTimeZone(filter.tz);
  return runScopedOn(base, ctx, async (db) => {
    const rows = await db.$queryRaw<
      {
        bucket: string;
        calls: number;
        conversations: number;
        prompt: number;
        completion: number;
        cached: number;
      }[]
    >(Prisma.sql`
      SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz}::text), 'YYYY-MM-DD') AS bucket,
             COUNT(*)::int AS calls,
             COUNT(DISTINCT conversation_id)::int AS conversations,
             COALESCE(SUM(prompt_tokens), 0)::int AS prompt,
             COALESCE(SUM(completion_tokens), 0)::int AS completion,
             COALESCE(SUM(cached_read_tokens), 0)::int AS cached
      FROM llm_usage
      WHERE (${since}::timestamptz IS NULL OR created_at >= ${since})
        AND (${source}::text IS NULL OR source = ${source})
      GROUP BY bucket
      ORDER BY bucket ASC`);
    return rows.map((r) => ({
      bucket: r.bucket,
      calls: Number(r.calls),
      conversations: Number(r.conversations),
      promptTokens: Number(r.prompt),
      completionTokens: Number(r.completion),
      cachedReadTokens: Number(r.cached),
    }));
  });
}
