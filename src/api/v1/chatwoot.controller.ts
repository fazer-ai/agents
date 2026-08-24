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
    // NOTE: read the RAW body — the HMAC signs the exact bytes Chatwoot sent; re-serializing the
    // parsed JSON would not match. We never declare/access `body`, so Elysia does not pre-parse.
    const rawBody = await request.text();
    const result = await receiveChatwootWebhook({
      routeToken: params.routeToken,
      rawBody,
      getHeader: (name) => request.headers.get(name),
    });

    // Ack fast (<5s): a slow or non-2xx ack makes Chatwoot move the conversation pending→open
    // (auto-escalate to a human). The dispatch runs detached.
    //
    // A DUPLICATE DISPATCHES TOO, and the CAS decides. `recordDelivery` calls every redelivery a
    // duplicate the moment the ledger row exists, but the row existing is not the same as the work
    // having been done: this dispatch is detached and fires AFTER the ack, so a process that dies in
    // between (deploy, OOM, restart) strands the row on PENDING with nothing running. Dropping the
    // redelivery there loses the message for good: Chatwoot, having been handed a 200, never sends
    // it again. That is the one failure here that is not recoverable, and turning the retries
    // back on upstream is what makes it reachable.
    //
    // Nothing double-processes: processChatwootDelivery opens with a CAS on `status: "PENDING"`, so
    // a row already PROCESSING or PROCESSED matches zero rows and returns "skipped". The redelivery
    // carries the same frozen payload, so a claim it wins reprocesses the same event.
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
