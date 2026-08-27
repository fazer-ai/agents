import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import {
  parseQueryCount,
  parseQueryId,
  parseQueryInstant,
} from "@/api/lib/query-filters";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  getWebhookDelivery,
  type ListDeliveriesOpts,
  listWebhookDeliveries,
  OUTBOUND_DELIVERY_STATUSES,
  requeueWebhookDelivery,
} from "@/modules/webhooks/outbound/deliveries";
import { OUTBOUND_EVENTS } from "@/modules/webhooks/outbound/events";
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookSubscriptions,
  updateWebhookSubscription,
  type WebhookSubscriptionCreate,
  type WebhookSubscriptionUpdate,
} from "@/modules/webhooks/outbound/subscriptions";
import { sendWebhookTest } from "@/modules/webhooks/outbound/test";

// Outbound webhook subscriptions (the fleet/integration fan-out targets). TENANT_ADMIN. The
// secret VALUE never crosses this surface — `secretRef` is a NAME into the tenant vault. `events`
// is validated against the closed OUTBOUND_EVENTS set (unknown → 400). GET /events lists the set
// so the UI can render a multiselect without hardcoding it.
//
// NOTE: the subscription service (src/modules/...) throws these AppError translationKeys; they are
// localized centrally in `onError`. Declared here (under src/api/**) so the API i18n extractor keeps
// them — its input glob does not reach src/modules.
// translate('errors.unknownWebhookEvent', 'Unknown webhook event: {{event}}')
// translate('errors.webhookSubscriptionNotFound', 'Webhook subscription not found')
// translate('errors.webhookDeliveryNotFound', 'Webhook delivery not found')
// translate('errors.webhookDeliveryNotDead', 'Only a dead delivery can be requeued; this one is {{status}}')
// translate('errors.unknownDeliveryStatus', 'Unknown delivery status: {{status}}')

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

// Exported for the drift guard: the refusal matrix is what this route promises, and a test that
// can only reach it through auth + tenancy would be testing three things to assert one.
export function parseDeliveryQuery(query: {
  status?: string;
  subscriptionId?: string;
  event?: string;
  since?: string;
  until?: string;
  limit?: string;
  cursor?: string;
}): ListDeliveriesOpts {
  return {
    status: query.status,
    subscriptionId: parseQueryId(query.subscriptionId, "subscriptionId"),
    event: query.event,
    since: parseQueryInstant(query.since, "since"),
    until: parseQueryInstant(query.until, "until"),
    limit: parseQueryCount(query.limit, "limit"),
    cursor: parseQueryId(query.cursor, "cursor"),
  };
}

export const webhooksController = new Elysia({
  prefix: "/v1/webhooks",
  tags: ["Webhooks"],
})
  .use(tenancyPlugin)
  .get(
    "/events",
    () => ({ instance: instanceIdentity, events: OUTBOUND_EVENTS }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List outbound events",
        "Returns the closed set of outbound webhook event names a subscription can subscribe to.",
      ),
      response: errors(401, 403),
    },
  )
  .get(
    "/subscriptions",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      subscriptions: await listWebhookSubscriptions(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List webhook subscriptions",
        "Returns the tenant's outbound webhook subscriptions; the secret value never crosses this surface.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .post(
    "/subscriptions",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      subscription: await createWebhookSubscription(
        ctxOrThrow(tenantContext),
        body as WebhookSubscriptionCreate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Create webhook subscription",
        "Creates an outbound webhook subscription; events are validated against the closed OUTBOUND_EVENTS set and the secret value never crosses this surface.",
      ),
      body: t.Object({
        url: t.String({
          minLength: 1,
          maxLength: 2048,
          description:
            "Delivery url for the outbound webhook (1 to 2048 characters).",
        }),
        events: t.Array(t.String(), {
          minItems: 1,
          description:
            "Event names to subscribe to, from GET /events; an unknown name is rejected with 400.",
        }),
        secretRef: t.Optional(
          t.Nullable(
            t.String({
              minLength: 1,
              maxLength: 128,
              description:
                "Vault reference (`vault:<id>`, from GET /v1/vault) for the signing secret. Never the secret itself, and never an entry name; null for none.",
            }),
          ),
        ),
        enabled: t.Optional(
          t.Boolean({
            description: "Whether the subscription receives deliveries.",
          }),
        ),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .patch(
    "/subscriptions/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      subscription: await updateWebhookSubscription(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body as WebhookSubscriptionUpdate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Update webhook subscription",
        "Updates fields of an outbound webhook subscription by id; events are validated against the closed OUTBOUND_EVENTS set.",
      ),
      params: t.Object({
        id: t.String({
          description:
            "Webhook subscription id (BigInt serialized as a string).",
        }),
      }),
      body: t.Object({
        url: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 2048,
            description: "New delivery url (1 to 2048 characters).",
          }),
        ),
        events: t.Optional(
          t.Array(t.String(), {
            minItems: 1,
            description:
              "New event names to subscribe to, from GET /events; an unknown name is rejected with 400.",
          }),
        ),
        secretRef: t.Optional(
          t.Nullable(
            t.String({
              minLength: 1,
              maxLength: 128,
              description:
                "New vault reference (`vault:<id>`) for the signing secret, or null to clear it.",
            }),
          ),
        ),
        enabled: t.Optional(
          t.Boolean({
            description: "Whether the subscription receives deliveries.",
          }),
        ),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .delete(
    "/subscriptions/:id",
    async ({ tenantContext, params }) => {
      await deleteWebhookSubscription(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Delete webhook subscription",
        "Removes an outbound webhook subscription by id.",
      ),
      params: t.Object({
        id: t.String({
          description:
            "Webhook subscription id (BigInt serialized as a string).",
        }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  // Synchronously POSTs a sample `webhook.test` payload to the subscription's URL (signed if it has a
  // secretRef) and returns the delivery outcome — a reachability probe, not a queued event.
  .post(
    "/subscriptions/:id/test",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      result: await sendWebhookTest(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Test webhook subscription",
        "Synchronously posts a sample webhook.test payload to the subscription url, signed if it has a secretRef, and returns the delivery outcome.",
      ),
      params: t.Object({
        id: t.String({
          description:
            "Webhook subscription id (BigInt serialized as a string).",
        }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  // ── deliveries ──
  // The delivery ledger, read-only plus one requeue. Before issue #305 there was no delivery-facing
  // route at all, so an integrator watching for events that never arrived had to read
  // `outbound_webhook_deliveries` in Postgres — a table whose columns the worker owns and changes.
  // Keyset pagination by id desc, same shape as /v1/logs. The payload is never returned.
  .get(
    "/deliveries",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      ...(await listWebhookDeliveries(
        ctxOrThrow(tenantContext),
        parseDeliveryQuery(query),
      )),
    }),
    {
      requireRole: "TENANT_ADMIN",
      query: t.Object({
        status: t.Optional(
          t.String({
            description: `Filter by delivery status: ${OUTBOUND_DELIVERY_STATUSES.join(", ")}. An unknown value is rejected with 400.`,
          }),
        ),
        subscriptionId: t.Optional(
          t.String({
            description:
              "Filter by webhook subscription id (BigInt serialized as a string).",
          }),
        ),
        event: t.Optional(
          t.String({ description: "Filter by event name (from GET /events)." }),
        ),
        since: t.Optional(
          t.String({
            description:
              "Lower bound on enqueue time, as an ISO 8601 instant with an offset (2026-01-01T00:00:00Z). A date alone is rejected with 400.",
          }),
        ),
        until: t.Optional(
          t.String({
            description:
              "Upper bound on enqueue time, as an ISO 8601 instant with an offset (2026-01-01T00:00:00Z). A date alone is rejected with 400.",
          }),
        ),
        limit: t.Optional(
          t.String({
            description:
              "Max rows to return (positive integer string, default 50, capped at 200).",
          }),
        ),
        cursor: t.Optional(
          t.String({
            description:
              "Keyset cursor (id of the last row from the previous page).",
          }),
        ),
      }),
      detail: doc(
        "List webhook deliveries",
        "Lists this tenant's outbound webhook deliveries newest first, with keyset pagination. Returns delivery state (status, attempts, last error, the event and subscription it belongs to) and never the payload.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .get(
    "/deliveries/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      delivery: await getWebhookDelivery(
        ctxOrThrow(tenantContext),
        requireDbId(params.id, "deliveryId"),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Webhook delivery id (BigInt serialized as a string).",
        }),
      }),
      detail: doc(
        "Get webhook delivery",
        "Returns one outbound webhook delivery by id; the payload is never included.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  // Puts a DEAD delivery back in the worker's queue: status PENDING, `attempts` reset to 0 so the
  // retry ladder starts over, next attempt due immediately. Only DEAD can be requeued — a delivery
  // the worker is currently posting (SENDING) would be at risk of a double delivery, and anything
  // else is either already queued or already delivered. The refusal names the current status (409).
  .post(
    "/deliveries/:id/requeue",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      delivery: (
        await requeueWebhookDelivery(
          ctxOrThrow(tenantContext),
          requireDbId(params.id, "deliveryId"),
        )
      ).delivery,
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Webhook delivery id (BigInt serialized as a string).",
        }),
      }),
      detail: doc(
        "Requeue webhook delivery",
        "Returns a dead delivery to the worker queue with its attempt count reset. Only a delivery in DEAD is accepted; any other status is refused with 409 naming it.",
      ),
      response: errors(400, 401, 403, 404, 409),
    },
  );
