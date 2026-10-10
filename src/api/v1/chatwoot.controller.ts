import { Elysia, t } from "elysia";
import { doc, errorResponse, jsonResponse } from "@/api/lib/openapi";
import basePrisma from "@/api/lib/prisma";
import {
  admissionLaneFull,
  admitChatwootDelivery,
} from "@/modules/chatwoot/delivery-queue";
import {
  handToRecovery,
  processRecordedChatwootDelivery,
  receiveChatwootWebhook,
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

    // NOTE: The ledger row is committed by the time `receiveChatwootWebhook` returns, so this 200 is
    // backed: a death from here on leaves a PENDING row the next drain hands to the delivery recovery
    // (a customer message) or processes from its stored body (anything else). Processing waits behind
    // the admission bound rather than competing for the pool; a customer message the waiting bound turns
    // away goes to the recovery now. A redelivery of a row still PENDING is dispatched too and the CAS
    // decides; one of a settled row is not (docs/chatwoot.md, "Webhook receiver").
    if (
      result.outcome === "queued" &&
      result.dispatch === true &&
      result.tenantId !== undefined &&
      result.instanceId !== undefined &&
      result.deliveryRowId !== undefined &&
      result.normalized !== undefined
    ) {
      const {
        tenantId,
        instanceId,
        deliveryRowId,
        agentBotId = null,
        receiptBindingGeneration = null,
        normalized,
        receivedAt = Date.now(),
      } = result;
      const lane = result.recoverable === true ? "turn" : "meta";
      const admitted = admitChatwootDelivery(
        deliveryRowId,
        () =>
          processRecordedChatwootDelivery({
            tenantId,
            instanceId,
            deliveryRowId,
            agentBotId,
            normalized,
            receiptBindingGeneration,
          }),
        lane,
        receivedAt,
      );
      if (!admitted && lane === "turn" && admissionLaneFull(lane)) {
        // Failures are logged inside; the next drain hands the row over if this did not.
        void handToRecovery(basePrisma, {
          tenantId,
          instanceId,
          rowId: deliveryRowId,
          from: "PENDING",
          event: normalized.event,
          conversationId: normalized.conversationId,
          messageId: normalized.message?.id ?? null,
          reason: "waiting_bound",
        });
      }
    }

    return { ack: true, outcome: result.outcome };
  },
  {
    detail: {
      ...doc(
        "Chatwoot bot webhook",
        "Public Agent Bot webhook receiver; authenticated by the opaque per-instance route token plus the HMAC signature header (verified in-handler after tenant resolution), not by a session cookie or bearer. Records the delivery durably, then acks (<5s) and processes asynchronously; a delivery that could not be recorded is a 503, for the sender to retry. An unknown token and a bad signature collapse into the same 401, so a probe cannot tell which routes are live.",
      ),
      security: [],
      responses: {
        200: jsonResponse(
          "Returned once the caller is authenticated and the delivery is recorded; `outcome` says what happened to the event.",
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
        503: errorResponse(503),
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
