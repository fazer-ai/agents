import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import {
  parseQueryEnum,
  parseQueryId,
  parseQueryInstant,
} from "@/api/lib/query-filters";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
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
import type { DashboardFilter } from "@/modules/analytics/filter";
import { getHealth } from "@/modules/analytics/health";
import { getOutcomeTrend } from "@/modules/analytics/trends";

// The dashboard's blocks past the headline figures. Every route takes the page's one
// filter (`dashboardFilterQuery`), so the blocks of a view always read the same rows; what each block
// sums is mapped in docs/dashboard.md. RLS-scoped through the tenant context.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

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
    t.Union([t.Literal("inbox"), t.Literal("playground")], {
      description:
        "Usage segment for ledger figures: inbox (real traffic) or playground; omit for both. Conversation figures are real traffic regardless.",
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
  source?: "inbox" | "playground";
  agentId?: string;
  inboxId?: string;
  tz?: string;
}): DashboardFilter {
  return {
    since: parseQueryInstant(query.since, "since"),
    until: parseQueryInstant(query.until, "until"),
    source: query.source,
    agentId: parseQueryId(query.agentId, "agentId"),
    inboxId: parseQueryId(query.inboxId, "inboxId"),
    tz: query.tz,
  };
}

const filterOnly = t.Object(dashboardFilterQuery);

export const dashboardController = new Elysia({
  prefix: "/v1/metrics",
  tags: ["Dashboard"],
})
  .use(tenancyPlugin)
  .get(
    "/outcomes",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      trend: await getOutcomeTrend(
        ctxOrThrow(tenantContext),
        parseDashboardFilter(query),
        parseQueryEnum(query.breakdown, "breakdown", ["agent", "inbox"]),
      ),
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
        "Involvement, resolution and handoff counts per local day over the conversations of the view, with totals, optionally repeated per agent or inbox.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/breakdown",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      rows: await getBreakdown(
        ctxOrThrow(tenantContext),
        parseDashboardFilter(query),
        parseQueryEnum(query.dimension, "dimension", BREAKDOWN_DIMENSIONS) ??
          "agent",
      ),
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
        "The view's ledger rows grouped by agent, inbox, model or call type: conversations, requests, cost, cost per conversation, resolution rate and cache share.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/handoffs",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      handoffs: await getHandoffReasons(
        ctxOrThrow(tenantContext),
        parseDashboardFilter(query),
      ),
    }),
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Handoff reasons",
        "Conversations handed over per cause per local day (the agent, a skip_reply by reason, a guardrail, a person), and skip_reply calls by reason.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/labels",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      labels: await getLabelOutcomes(
        ctxOrThrow(tenantContext),
        parseDashboardFilter(query),
      ),
    }),
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Outcome by label",
        "Volume and outcome of the view's conversations per Chatwoot label, and how many carry none.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/health",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      health: await getHealth(
        ctxOrThrow(tenantContext),
        parseDashboardFilter(query),
      ),
    }),
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Health",
        "Model call latency p50/p90 by model, and warn/error flow-log lines by stage and tool.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/follow-ups",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      followUps: await getFollowUpActivity(
        ctxOrThrow(tenantContext),
        parseDashboardFilter(query),
      ),
    }),
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Follow-up activity",
        "Follow-up steps delivered in the window, the conversations they reached, how many customers wrote back and how many the last step closed.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/knowledge",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      knowledge: await getKnowledgeActivity(
        ctxOrThrow(tenantContext),
        parseDashboardFilter(query),
      ),
    }),
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Knowledge suggestions",
        "Knowledge suggestions proposed in the window and where each stands: waiting, discarded by the reviewer, approved, rejected.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  );
