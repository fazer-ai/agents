import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
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

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
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
      response: errors(400, 401, 403, 404),
    },
  )
  .patch(
    "/subscriptions/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      subscription: await updateWebhookSubscription(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
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
      response: errors(400, 401, 403, 404),
    },
  )
  .delete(
    "/subscriptions/:id",
    async ({ tenantContext, params }) => {
      await deleteWebhookSubscription(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
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
        BigInt(params.id),
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
  );
