import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import { sendAlertChannelTest } from "@/modules/flowlog/channel-test";
import {
  type AlertChannelCreate,
  type AlertChannelUpdate,
  createAlertChannel,
  deleteAlertChannel,
  listAlertChannels,
  updateAlertChannel,
} from "@/modules/flowlog/channels";
import { FLOW_STAGES } from "@/modules/flowlog/stages";

// Alert channel CRUD (external sinks for execution-flow warnings/errors). TENANT_ADMIN; RLS-scoped.
// The token-bearing `url` never crosses this surface in the clear — it goes IN on write and comes
// back only as a masked preview. GET /stages lists the closed stage vocabulary for the UI.
//
// NOTE: the channels service throws these AppError translationKeys; declared here (under src/api/**)
// so the API i18n extractor keeps them (its glob does not reach src/modules).
// translate('errors.unknownFlowStage', 'Unknown flow stage: {{stage}}')
// translate('errors.alertChannelNotFound', 'Alert channel not found')
// translate('errors.noUpdatableFields', 'No updatable fields provided')
// translate('errors.alertChannelUnknownAgent', 'Unknown agent: {{id}}')

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

export const alertChannelsController = new Elysia({
  prefix: "/v1/alert-channels",
  tags: ["Logs"],
})
  .use(tenancyPlugin)
  .get("/stages", () => ({ instance: instanceIdentity, stages: FLOW_STAGES }), {
    requireRole: "TENANT_ADMIN",
    detail: doc(
      "List flow stages",
      "Returns the closed execution-flow stage vocabulary that an alert channel can filter on.",
    ),
    response: errors(401, 403),
  })
  .get(
    "/",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      channels: await listAlertChannels(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List alert channels",
        "Returns the tenant's alert channels; the token-bearing url is returned only as a masked preview.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .post(
    "/",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      channel: await createAlertChannel(
        ctxOrThrow(tenantContext),
        body as AlertChannelCreate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Create alert channel",
        "Creates an alert channel; the token-bearing url goes in on write and is returned only as a masked preview.",
      ),
      body: t.Object({
        name: t.String({
          minLength: 1,
          maxLength: 120,
          description: "Display label for the channel (1 to 120 characters).",
        }),
        type: t.Union([t.Literal("discord"), t.Literal("webhook")], {
          description:
            "Sink type: discord (Discord webhook) or webhook (generic HTTP endpoint).",
        }),
        url: t.String({
          minLength: 1,
          maxLength: 2048,
          description:
            "Token-bearing delivery url; stored encrypted and returned only as a masked preview.",
        }),
        minLevel: t.Optional(
          t.Union([t.Literal("warn"), t.Literal("error")], {
            description:
              "Minimum severity to dispatch: warn (warnings and errors) or error (errors only).",
          }),
        ),
        stages: t.Optional(
          t.Array(t.String(), {
            description:
              "Flow stages to filter on, from GET /stages; empty matches all stages.",
          }),
        ),
        excludeAgentIds: t.Optional(
          t.Array(t.String(), {
            maxItems: 200,
            description:
              "Agent ids (BigInts as decimal strings) whose flow-log lines never alert on this channel; their lines stay in the log. Each must name an agent of this tenant.",
          }),
        ),
        secretRef: t.Optional(
          t.Nullable(
            t.String({
              minLength: 1,
              maxLength: 128,
              description:
                "Vault reference (`vault:<id>`, from GET /v1/vault) for a signing secret. Never the secret itself, and never an entry name; null for none.",
            }),
          ),
        ),
        enabled: t.Optional(
          t.Boolean({
            description: "Whether the channel receives dispatches.",
          }),
        ),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .patch(
    "/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      channel: await updateAlertChannel(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body as AlertChannelUpdate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Update alert channel",
        "Updates fields of an alert channel by id; the token-bearing url is returned only as a masked preview.",
      ),
      params: t.Object({
        id: t.String({
          description: "Alert channel id (BigInt serialized as a string).",
        }),
      }),
      body: t.Object({
        name: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 120,
            description: "New display label (1 to 120 characters).",
          }),
        ),
        type: t.Optional(
          t.Union([t.Literal("discord"), t.Literal("webhook")], {
            description:
              "New sink type: discord (Discord webhook) or webhook (generic HTTP endpoint).",
          }),
        ),
        url: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 2048,
            description:
              "New token-bearing delivery url; stored encrypted and returned only as a masked preview.",
          }),
        ),
        minLevel: t.Optional(
          t.Union([t.Literal("warn"), t.Literal("error")], {
            description:
              "New minimum severity: warn (warnings and errors) or error (errors only).",
          }),
        ),
        stages: t.Optional(
          t.Array(t.String(), {
            description:
              "New flow stages to filter on, from GET /stages; empty matches all stages.",
          }),
        ),
        excludeAgentIds: t.Optional(
          t.Array(t.String(), {
            maxItems: 200,
            description:
              "Replaces the list of agent ids (BigInts as decimal strings) whose flow-log lines never alert on this channel; [] clears it. An id the channel already holds is kept even if its agent was deleted; a new one must name an agent of this tenant.",
          }),
        ),
        secretRef: t.Optional(
          t.Nullable(
            t.String({
              minLength: 1,
              maxLength: 128,
              description:
                "New vault reference (`vault:<id>`) for a signing secret, or null to clear it.",
            }),
          ),
        ),
        enabled: t.Optional(
          t.Boolean({
            description: "Whether the channel receives dispatches.",
          }),
        ),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .delete(
    "/:id",
    async ({ tenantContext, params }) => {
      await deleteAlertChannel(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc("Delete alert channel", "Removes an alert channel by id."),
      params: t.Object({
        id: t.String({
          description: "Alert channel id (BigInt serialized as a string).",
        }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  // Synchronously POSTs a sample alert to the channel's destination, through the SAME send a queued
  // alert takes, and returns what happened. Never enqueues a delivery and never writes a flow-log
  // line, so the test cannot show up in the destination's history as an incident (issue #605).
  .post(
    "/:id/test",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      result: await sendAlertChannelTest(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Test alert channel",
        "Synchronously posts a sample alert to the channel destination, signed when the channel has a secretRef, and returns the delivery outcome (ok/status/error/signed/enabled/durationMs). Works on a disabled channel and says so in the result; writes no delivery, no flow-log entry and no audit row.",
      ),
      params: t.Object({
        id: t.String({
          description: "Alert channel id (BigInt serialized as a string).",
        }),
      }),
      response: errors(400, 401, 403, 404),
    },
  );
