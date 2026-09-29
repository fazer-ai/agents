import { Elysia, t } from "elysia";
import logger from "@/api/lib/logger";
import { doc, errorResponse, jsonResponse } from "@/api/lib/openapi";
import {
  receiveChatwootWebhook,
  recordAndProcessChatwootDelivery,
} from "@/modules/chatwoot/webhook";

// Public, JWT-less Chatwoot Agent Bot webhook receiver. Not behind tenancyPlugin/requireAuth:
// the opaque routeToken resolves the tenant and the per-instance HMAC secret authenticates the
// call. Mounted under /api → the effective path is /api/v1/chatwoot/webhook/:routeToken, which
// MUST equal CHATWOOT_WEBHOOK_MOUNT (asserted in tests). POST only, so the GET 404 guards and
// the SPA catch-all never apply.
export const chatwootController = new Elysia({
  prefix: "/v1/chatwoot",
  tags: ["Channels"],
}).post(
  "/webhook/:routeToken",
  async ({ params, request }) => {
    // Read the RAW body: the HMAC signs the exact bytes Chatwoot sent; re-serializing the
    // parsed JSON would not match. We never declare/access `body`, so Elysia does not pre-parse.
    const rawBody = await request.text();
    const result = await receiveChatwootWebhook({
      routeToken: params.routeToken,
      rawBody,
      getHeader: (name) => request.headers.get(name),
    });

    // NOTE: ack fast (<5s): a slow or non-2xx ack makes Chatwoot move the conversation pending→open
    // (auto-escalate to a human), so the dispatch runs detached. A redelivery dispatches too and the
    // CAS in processChatwootDelivery decides: the row existing does not mean the work was done, and
    // dropping it would lose a message Chatwoot never resends (docs/chatwoot.md, Idempotency ledger).
    if (
      result.outcome === "queued" &&
      result.tenantId !== undefined &&
      result.instanceId !== undefined &&
      result.deliveryId !== undefined &&
      result.normalized !== undefined
    ) {
      const {
        tenantId,
        instanceId,
        deliveryId,
        agentBotId = null,
        normalized,
      } = result;
      void recordAndProcessChatwootDelivery({
        tenantId,
        instanceId,
        deliveryId,
        agentBotId,
        normalized,
      }).catch((err) => {
        logger.error(
          "chatwoot async dispatch failed (delivery %s): %s",
          deliveryId,
          err instanceof Error ? err.message : String(err),
        );
      });
    }

    return { ack: true, outcome: result.outcome };
  },
  {
    detail: {
      ...doc(
        "Chatwoot bot webhook",
        "Public Agent Bot webhook receiver; authenticated by the opaque per-instance route token plus the HMAC signature header (verified in-handler after tenant resolution), not by a session cookie or bearer. Acks fast (<5s) and processes asynchronously; an unknown token and a bad signature collapse into the same 401, so a probe cannot tell which routes are live.",
      ),
      security: [],
      responses: {
        200: jsonResponse(
          "Returned once the caller is authenticated; `outcome` says what happened to the event.",
          t.Object({
            ack: t.Literal(true),
            outcome: t.Union(
              [
                t.Literal("queued"),
                t.Literal("duplicate"),
                t.Literal("ignored"),
              ],
              {
                description:
                  "queued = accepted for async handling; duplicate = replay of an already-recorded event; ignored = an event shape the receiver does not handle.",
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
          "Opaque per-instance route token (not a BigInt id) that resolves the tenant and instance and binds the HMAC secret.",
      }),
    }),
  },
);
