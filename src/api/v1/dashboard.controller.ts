import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import {
  parseQueryEnum,
  parseQueryId,
  parseQueryInstant,
} from "@/api/lib/query-filters";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import config from "@/config";
import type { UsageSource } from "@/graph/usage";
import type { ClientAudience } from "@/graph/usage-sources";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  getFollowUpActivity,
  getHandoffReasons,
  getKnowledgeActivity,
  getLabelOutcomes,
} from "@/modules/analytics/activity";
import {
  BREAKDOWN_DIMENSIONS,
  getBreakdown,
} from "@/modules/analytics/breakdown";
import { type DashboardFilter, flowLogFloor } from "@/modules/analytics/filter";
import { getHealth } from "@/modules/analytics/health";
import { getFilterOptions } from "@/modules/analytics/options";
import { normalizeTimeZone } from "@/modules/analytics/service";
import { getOutcomeTrend } from "@/modules/analytics/trends";

// translate('errors.metricsTooSlow', 'The metrics for this period took longer than {{seconds}}s to compute. Try a shorter period, or try again in a moment.')

// The dashboard's blocks past the headline figures. Every route takes the page's one
// filter (`dashboardFilterQuery`), so the blocks of a view always read the same rows; what each block
// sums is mapped in docs/dashboard.md. RLS-scoped through the tenant context.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

// Every block is computed when it is asked for, within the request's budget (docs/dashboard.md,
// "How the console loads").
export const METRICS_NOTE =
  "Computed from the records when asked, within METRICS_TIMEOUT_MS counted from the request's arrival; a window that does not fit is refused with a 503 naming `since`.";

const INSTANT =
  "ISO instant (2026-01-01T00:00:00Z). A value that is not one is refused with a 400 naming the parameter.";

// The query every dashboard route accepts. Shared with the headline routes in v1.controller.ts.
export const dashboardFilterQuery = {
  since: t.Optional(
    t.String({ description: `Start of the window, inclusive. ${INSTANT}` }),
  ),
  until: t.Optional(
    t.String({ description: `End of the window, exclusive. ${INSTANT}` }),
  ),
  source: t.Optional(
    t.Union(
      [t.Literal("inbox"), t.Literal("playground"), t.Literal("client")],
      {
        description:
          "Usage segment for ledger figures: inbox (real traffic), playground, or client (a host application's users, through the client channel); omit for all. Conversation figures are real traffic regardless.",
      },
    ),
  ),
  audience: t.Optional(
    t.Union([t.Literal("identified"), t.Literal("anonymous")], {
      description:
        "Client-channel traffic of one audience only: identified (a host's signed-in users) or anonymous (anonymous visitors' sessions). Implies the client source; omit for both.",
    }),
  ),
  agentId: t.Optional(
    t.String({
      description:
        "Only this agent: its ledger rows, and the conversations whose inbox is bound to it or that it ran on.",
    }),
  ),
  inboxId: t.Optional(
    t.String({ description: "Only this inbox (its database id)." }),
  ),
  tz: t.Optional(
    t.String({
      description:
        "IANA timezone (e.g. America/Sao_Paulo) the daily buckets are cut in; an unknown zone is refused with a 400.",
    }),
  ),
};

export function parseDashboardFilter(query: {
  since?: string;
  until?: string;
  source?: UsageSource;
  audience?: ClientAudience;
  agentId?: string;
  inboxId?: string;
  tz?: string;
}): DashboardFilter {
  return {
    since: parseQueryInstant(query.since, "since"),
    until: parseQueryInstant(query.until, "until"),
    source: query.source,
    audience: query.audience,
    agentId: parseQueryId(query.agentId, "agentId"),
    inboxId: parseQueryId(query.inboxId, "inboxId"),
    // Refused here, for every route that takes the filter: a read that buckets no days (the KPIs,
    // the breakdown, the labels) never looks at the zone, and must not accept one it cannot read.
    tz: query.tz === undefined ? undefined : normalizeTimeZone(query.tz),
  };
}

// The flow log's floor for this request, taken once: the read starts there, and the answer carries it
// so the console marks as no data exactly the days the read left out, whatever the clock said when
// the view was opened.
function withFlowLogFloor(filter: DashboardFilter): {
  filter: DashboardFilter;
  flowLogFrom: string;
} {
  const now = Date.now();
  return {
    filter: { ...filter, flowLogNow: now },
    flowLogFrom: flowLogFloor(filter.tz ?? "UTC", now).toISOString(),
  };
}

const filterOnly = t.Object(dashboardFilterQuery);

export const dashboardController = new Elysia({
  prefix: "/v1/metrics",
  tags: ["Dashboard"],
})
  .use(tenancyPlugin)
  .get(
    "/filter-options",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      ...(await getFilterOptions(ctxOrThrow(tenantContext))),
      flowLogRetentionDays: config.flowlog.retentionDays,
    }),
    {
      requireAuth: true,
      detail: doc(
        "Dashboard filter options",
        "Every agent and inbox of the tenant, by id and name, for the dashboard's agent and inbox filters; an inbox whose name another inbox also has carries its Chatwoot account (`account: {id, name}`). Whole, not paged. `flowLogRetentionDays` is how many days the flow log keeps (`FLOWLOG_RETENTION_DAYS`): a day of a flow-log block before the cutoff has no data, never zero. `firstRecordAt` is the tenant's first conversation or ledger row, where an all-time view starts.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/outcomes",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      trend: await (async () => {
        const ctx = ctxOrThrow(tenantContext);
        const filter = parseDashboardFilter(query);
        const breakdown = parseQueryEnum(query.breakdown, "breakdown", [
          "agent",
          "inbox",
        ]);
        return getOutcomeTrend(ctx, filter, breakdown);
      })(),
    }),
    {
      requireAuth: true,
      query: t.Object({
        ...dashboardFilterQuery,
        breakdown: t.Optional(
          t.String({
            description:
              "Repeat the funnel per agent or per inbox: agent | inbox.",
          }),
        ),
      }),
      detail: doc(
        "Outcome trend",
        `Involvement, resolution and handoff counts per local day over the conversations of the view, with totals, optionally repeated per agent or inbox. ${METRICS_NOTE}`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/breakdown",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      rows: await (async () => {
        const ctx = ctxOrThrow(tenantContext);
        const filter = parseDashboardFilter(query);
        const dimension =
          parseQueryEnum(query.dimension, "dimension", BREAKDOWN_DIMENSIONS) ??
          "agent";
        return getBreakdown(ctx, filter, dimension);
      })(),
    }),
    {
      requireAuth: true,
      query: t.Object({
        ...dashboardFilterQuery,
        dimension: t.Optional(
          t.String({
            description:
              "Row dimension: agent (default) | inbox | model | node (call type).",
          }),
        ),
      }),
      detail: doc(
        "Usage breakdown",
        `The view's ledger rows grouped by agent, inbox, model or call type: conversations, requests, cost, cost per conversation, resolution rate and cache share. ${METRICS_NOTE}`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/handoffs",
    async ({ tenantContext, query }) => {
      const ctx = ctxOrThrow(tenantContext);
      const { filter, flowLogFrom } = withFlowLogFloor(
        parseDashboardFilter(query),
      );
      return {
        instance: instanceIdentity,
        handoffs: await getHandoffReasons(ctx, filter),
        flowLogFrom,
      };
    },
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Handoff reasons",
        `Conversations handed over per cause per local day (the agent, a skip_reply by reason, a guardrail, a person), and skip_reply calls by reason. ${METRICS_NOTE}`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/labels",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      labels: await (async () => {
        const ctx = ctxOrThrow(tenantContext);
        const filter = parseDashboardFilter(query);
        return getLabelOutcomes(ctx, filter);
      })(),
    }),
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Outcome by label",
        `Volume and outcome of the view's conversations per Chatwoot label, and how many carry none. ${METRICS_NOTE}`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/health",
    async ({ tenantContext, query }) => {
      const ctx = ctxOrThrow(tenantContext);
      const { filter, flowLogFrom } = withFlowLogFloor(
        parseDashboardFilter(query),
      );
      return {
        instance: instanceIdentity,
        health: await getHealth(ctx, filter),
        flowLogFrom,
      };
    },
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Health",
        `Model call latency p50/p90 by model, and warn/error flow-log lines by stage and tool. ${METRICS_NOTE}`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/follow-ups",
    async ({ tenantContext, query }) => {
      const ctx = ctxOrThrow(tenantContext);
      const { filter, flowLogFrom } = withFlowLogFloor(
        parseDashboardFilter(query),
      );
      return {
        instance: instanceIdentity,
        followUps: await getFollowUpActivity(ctx, filter),
        flowLogFrom,
      };
    },
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Follow-up activity",
        `Follow-up steps delivered in the window, the conversations they reached, how many customers wrote back and how many the last step closed. ${METRICS_NOTE}`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/knowledge",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      knowledge: await (async () => {
        const ctx = ctxOrThrow(tenantContext);
        const filter = parseDashboardFilter(query);
        return getKnowledgeActivity(ctx, filter);
      })(),
    }),
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Knowledge suggestions",
        `Knowledge suggestions proposed in the window and where each stands: waiting, discarded by the reviewer, approved, rejected. ${METRICS_NOTE}`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  );
