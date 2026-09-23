import { Elysia, t } from "elysia";
import logger from "@/api/lib/logger";
import { doc, errorResponse, jsonResponse } from "@/api/lib/openapi";
import {
  processInboundDelivery,
  receiveInbound,
} from "@/modules/webhooks/inbound/service";

// Public, JWT-less inbound receptor for integrations (the n8n-style webhook node). It is NOT
// behind tenancyPlugin/requireAuth: the opaque routeToken resolves the tenant and the
// per-instance auth strategy authenticates the call. Mounted under /api → the path is
// /api/v1/integrations/inbound/:routeToken. POST only, so the GET 404 guards and the SPA
// catch-all never apply.
export const integrationsController = new Elysia({
  prefix: "/v1/integrations",
  tags: ["Integrations"],
}).post(
  "/inbound/:routeToken",
  async ({ params, request }) => {
    // NOTE: read the RAW body (HMAC strategies sign the exact bytes; re-serializing the parsed
    // JSON would not match). We never declare/access `body`, so Elysia does not pre-parse it.
    const rawBody = await request.text();
    const result = await receiveInbound({
      routeToken: params.routeToken,
      rawBody,
      getHeader: (name) => request.headers.get(name),
    });

    // Ack fast (<5s, e.g. Chatwoot auto-escalates pending→open on a slow/non-2xx ack); the
    // dispatch runs detached. processInboundDelivery is idempotent (status CAS) and reclaims a
    // PROCESSING row stranded by a crash once it is stale, so re-firing on a duplicate POST is safe.
    if (
      result.deliveryId !== undefined &&
      result.tenantId !== undefined &&
      (result.outcome === "queued" || result.outcome === "duplicate")
    ) {
      const { deliveryId, tenantId } = result;
      void processInboundDelivery({ deliveryId, tenantId }).catch((err) => {
        logger.error(
          "inbound async dispatch failed (delivery %s): %s",
          String(deliveryId),
          err instanceof Error ? err.message : String(err),
        );
      });
    }

    return { ack: true, outcome: result.outcome };
  },
  {
    detail: {
      ...doc(
        "Generic inbound webhook",
        "Public inbound receptor for integrations (n8n-style webhook node); authenticated by the opaque per-instance route token plus the per-instance auth strategy (e.g. HMAC or static header, verified in-handler after tenant resolution), not by a session cookie or bearer. Acks fast (<5s) and dispatches asynchronously; an unknown token and failed auth collapse into the same 401, so a probe cannot tell which routes are live. A GENERIC integration takes `{event_id, conversation_ref, text (at most 4000 characters, line breaks kept), status?}`: `conversation_ref` is the value an HTTP tool of the agent sent as `{{conversation_ref}}`, `event_id` is the idempotency key, and the agent passes `text` on to the customer of that conversation (or leaves a private note when a person holds it). HMAC_SHA256 signs the raw body as hex in `x-webhook-signature` (optionally `sha256=`-prefixed).",
      ),
      security: [],
      responses: {
        200: jsonResponse(
          "Returned once the caller is authenticated; `outcome` says what happened to the delivery.",
          t.Object({
            ack: t.Literal(true),
            outcome: t.Union(
              [
                t.Literal("queued"),
                t.Literal("duplicate"),
                t.Literal("ignored"),
                t.Literal("no-mapper"),
                t.Literal("invalid"),
                t.Literal("uncorrelated"),
              ],
              {
                description:
                  "queued = accepted for async dispatch; duplicate = replay of an already-recorded delivery; ignored = deliberately-unhandled lifecycle event; no-mapper = the integration has no inbound mapper registered; invalid = the payload failed the mapper schema (recorded for inspection); uncorrelated = a GENERIC event whose `conversation_ref` does not name a conversation on this integration (unknown, minted by another integration, or its integration deleted): nothing was recorded and nothing will act on it, so stop sending events for that ref.",
              },
            ),
          }),
        ),
        400: errorResponse(400),
        401: errorResponse(401),
      },
    },
    params: t.Object({
      routeToken: t.String({
        description:
          "Opaque per-instance route token (not a BigInt id) that resolves the tenant and integration instance and selects its inbound auth strategy.",
      }),
    }),
  },
);
