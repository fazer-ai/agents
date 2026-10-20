import { Elysia, sse, t } from "elysia";
import logger from "@/api/lib/logger";
import { doc, errors } from "@/api/lib/openapi";
import {
  parseQueryEnum,
  parseQueryId,
  parseQueryInstant,
} from "@/api/lib/query-filters";
import { refusalBody, refusalHeaders } from "@/api/lib/refusal";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import type { UsageSource } from "@/graph/usage";
import type { ClientAudience } from "@/graph/usage-sources";
import { REJECTED_TENANT_SELECTOR_HEADER } from "@/lib/console-params";
import {
  AppError,
  ForbiddenError,
  TenantTargetRequiredError,
} from "@/lib/errors";
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
import { getHealth, type HealthReport } from "@/modules/analytics/health";
import { getFilterOptions } from "@/modules/analytics/options";
import { fromKeptDays } from "@/modules/analytics/rollup/answer";
import type { Block } from "@/modules/analytics/rollup/engine";
import { BLOCKS, streamFigures } from "@/modules/analytics/rollup/stream";
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

// A route answers once every day of its window is in, so a cold window has a ceiling the console's
// stream does not (docs/dashboard.md, "How the console fills").
export const KEPT_DAYS_NOTE =
  "Answers once every day of the window is computed. A window with days not computed before that does not fit one METRICS_TIMEOUT_MS is refused with a 503 naming `since`; the days computed before the refusal are kept, so the same request again goes on from them. The console reads the same figures from `GET /v1/metrics/stream`, which sends them as they are computed.";

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
    tz: query.tz,
  };
}

const filterOnly = t.Object(dashboardFilterQuery);

function parseBlocks(s: string | undefined): Block[] {
  if (s === undefined) return BLOCKS;
  const asked = s.split(",").map((b) => b.trim());
  for (const b of asked) parseQueryEnum(b, "blocks", BLOCKS);
  return BLOCKS.filter((b) => asked.includes(b));
}

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
    }),
    {
      requireAuth: true,
      detail: doc(
        "Dashboard filter options",
        "Every agent and inbox of the tenant, id and name only, for the dashboard's agent and inbox filters. Whole, not paged.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/outcomes",
    async ({ tenantContext, query, request }) => ({
      instance: instanceIdentity,
      trend: await (async () => {
        const ctx = ctxOrThrow(tenantContext);
        const filter = parseDashboardFilter(query);
        const breakdown = parseQueryEnum(query.breakdown, "breakdown", [
          "agent",
          "inbox",
        ]);
        return fromKeptDays(
          ctx,
          filter,
          "outcomes",
          (f) =>
            breakdown && f.trend && f.series
              ? { ...f.trend, series: f.series[breakdown] }
              : (f.trend as NonNullable<typeof f.trend>),
          () => getOutcomeTrend(ctx, filter, breakdown),
          undefined,
          request.signal,
        );
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
        `Involvement, resolution and handoff counts per local day over the conversations of the view, with totals, optionally repeated per agent or inbox. ${KEPT_DAYS_NOTE}`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/breakdown",
    async ({ tenantContext, query, request }) => ({
      instance: instanceIdentity,
      rows: await (async () => {
        const ctx = ctxOrThrow(tenantContext);
        const filter = parseDashboardFilter(query);
        const dimension =
          parseQueryEnum(query.dimension, "dimension", BREAKDOWN_DIMENSIONS) ??
          "agent";
        return fromKeptDays(
          ctx,
          filter,
          "breakdown",
          (f) => f.breakdown?.[dimension] ?? [],
          () => getBreakdown(ctx, filter, dimension),
          undefined,
          request.signal,
        );
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
        `The view's ledger rows grouped by agent, inbox, model or call type: conversations, requests, cost, cost per conversation, resolution rate and cache share. ${KEPT_DAYS_NOTE}`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/handoffs",
    async ({ tenantContext, query, request }) => ({
      instance: instanceIdentity,
      handoffs: await (async () => {
        const ctx = ctxOrThrow(tenantContext);
        const filter = parseDashboardFilter(query);
        return fromKeptDays(
          ctx,
          filter,
          "handoffs",
          (f) => f.handoffs as NonNullable<typeof f.handoffs>,
          () => getHandoffReasons(ctx, filter),
          undefined,
          request.signal,
        );
      })(),
    }),
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Handoff reasons",
        `Conversations handed over per cause per local day (the agent, a skip_reply by reason, a guardrail, a person), and skip_reply calls by reason. ${KEPT_DAYS_NOTE}`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/labels",
    async ({ tenantContext, query, request }) => ({
      instance: instanceIdentity,
      labels: await (async () => {
        const ctx = ctxOrThrow(tenantContext);
        const filter = parseDashboardFilter(query);
        return fromKeptDays(
          ctx,
          filter,
          "labels",
          (f) => f.labels as NonNullable<typeof f.labels>,
          () => getLabelOutcomes(ctx, filter),
          undefined,
          request.signal,
        );
      })(),
    }),
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Outcome by label",
        `Volume and outcome of the view's conversations per Chatwoot label, and how many carry none. ${KEPT_DAYS_NOTE}`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/health",
    async ({ tenantContext, query, request }) => ({
      instance: instanceIdentity,
      health: await (async () => {
        const ctx = ctxOrThrow(tenantContext);
        const filter = parseDashboardFilter(query);
        return fromKeptDays(
          ctx,
          filter,
          "health",
          (f) => f.health as HealthReport,
          () => getHealth(ctx, filter),
          undefined,
          request.signal,
        );
      })(),
    }),
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Health",
        `Model call latency p50/p90 by model, and warn/error flow-log lines by stage and tool. ${KEPT_DAYS_NOTE}`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/follow-ups",
    async ({ tenantContext, query, request }) => ({
      instance: instanceIdentity,
      followUps: await (async () => {
        const ctx = ctxOrThrow(tenantContext);
        const filter = parseDashboardFilter(query);
        return fromKeptDays(
          ctx,
          filter,
          "followUps",
          (f) => f.followUps as NonNullable<typeof f.followUps>,
          () => getFollowUpActivity(ctx, filter),
          undefined,
          request.signal,
        );
      })(),
    }),
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Follow-up activity",
        `Follow-up steps delivered in the window, the conversations they reached, how many customers wrote back and how many the last step closed. ${KEPT_DAYS_NOTE}`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/stream",
    async function* ({ tenantContext, query, request }) {
      const ctx = ctxOrThrow(tenantContext);
      const filter = parseDashboardFilter(query);
      const blocks = parseBlocks(query.blocks);
      try {
        for await (const event of streamFigures(
          ctx,
          filter,
          blocks,
          request.signal,
        ))
          yield sse({ event: event.kind, data: event });
      } catch (error) {
        // NOTE: past the first event the status is sent; a refusal is the stream's last event. An
        // error that is no refusal (the database out of connections, say) ends the stream the same
        // way, as a 500 the page offers a retry for: thrown, it would cut the response mid-chunk and
        // leave every block with nothing to say.
        if (!(error instanceof AppError)) {
          logger.error({ err: error }, "metrics stream failed");
          yield sse({
            event: "refused",
            data: { status: 500, error: "Internal server error" },
          });
          return;
        }
        yield sse({
          event: "refused",
          data: {
            status: error.statusCode,
            ...refusalBody(error, request.headers.get("accept-language")),
            // The header a refused tenant selector is named in on a plain response; the client
            // recovers from it the same way.
            ...(refusalHeaders(error)[REJECTED_TENANT_SELECTOR_HEADER]
              ? {
                  rejectedTenantId:
                    refusalHeaders(error)[REJECTED_TENANT_SELECTOR_HEADER],
                }
              : {}),
          },
        });
      }
    },
    {
      requireAuth: true,
      query: t.Object({
        ...dashboardFilterQuery,
        blocks: t.Optional(
          t.String({
            description: `Comma-separated blocks to compute (${BLOCKS.join(", ")}); omit for all of them.`,
          }),
        ),
      }),
      detail: doc(
        "Dashboard, as it fills",
        "Server-sent events with the figures of every requested block for the window. A `snapshot` comes first with what is already kept, then after each part of at most 30 days is computed (today and yesterday first, then the most recent days), each carrying the coverage per family; `computing` names the days about to be computed; the last snapshot has `done: true`. A refusal after the first event arrives as a `refused` event with the status and the sentence. The figures are the ones the per-block routes return.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/knowledge",
    async ({ tenantContext, query, request }) => ({
      instance: instanceIdentity,
      knowledge: await (async () => {
        const ctx = ctxOrThrow(tenantContext);
        const filter = parseDashboardFilter(query);
        return fromKeptDays(
          ctx,
          filter,
          "knowledge",
          (f) => f.knowledge as NonNullable<typeof f.knowledge>,
          () => getKnowledgeActivity(ctx, filter),
          undefined,
          request.signal,
        );
      })(),
    }),
    {
      requireAuth: true,
      query: filterOnly,
      detail: doc(
        "Knowledge suggestions",
        `Knowledge suggestions proposed in the window and where each stands: waiting, discarded by the reviewer, approved, rejected. ${KEPT_DAYS_NOTE}`,
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  );
