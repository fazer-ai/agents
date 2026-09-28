import { z } from "zod";
import {
  GENERIC_TEXT_MAX_CHARS,
  type InboundMapper,
  type MapResult,
} from "./types";

// Registry of inbound mappers keyed by catalogType. Pure functions only. Adding a real
// integration = one entry here + its zod schema; the receptor (route-token, auth, ack/async,
// idempotency, correlation, dispatch) is untouched. GENERIC and Asaas are the inbound integrations
// (Calendar/Drive/Resend are outbound-only); a catalog entry without a mapper fails closed.

const REGISTRY = new Map<string, InboundMapper>();

export function registerMapper(mapper: InboundMapper): void {
  REGISTRY.set(mapper.catalogType, mapper);
}

export function getMapper(catalogType: string): InboundMapper | undefined {
  return REGISTRY.get(catalogType);
}

// ── GENERIC ──
// The operator's own system, calling back about a conversation an HTTP tool handed it. The body IS
// our documented normalized shape, so this only validates it. `conversation_ref` is the correlation
// key the tool minted (IntegrationExternalRef, kind `conversation_ref`), `event_id` is the sender's
// idempotency key, `text` is what the agent passes on. Unknown keys are ignored, so a sender can
// carry its own.
const genericSchema = z.object({
  event_id: z.string().min(1),
  conversation_ref: z.string().min(1),
  // Refused past the cap, never clipped: see GENERIC_TEXT_MAX_CHARS.
  text: z
    .string()
    .max(GENERIC_TEXT_MAX_CHARS)
    .refine((t) => t.trim().length > 0),
  status: z.string().min(1).max(64).optional(),
});

const genericMapper: InboundMapper = {
  catalogType: "GENERIC",
  map(raw: unknown): MapResult {
    const parsed = genericSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, reason: "invalid", detail: issuePaths(parsed.error) };
    }
    const { event_id, conversation_ref, text, status } = parsed.data;
    return {
      ok: true,
      event: {
        kind: "agent_nudge",
        externalId: conversation_ref,
        dedupeKey: event_id,
        text,
        ...(status ? { status } : {}),
      },
    };
  },
};

registerMapper(genericMapper);

// ── ASAAS ──
// Brazilian payments. PAYMENT_RECEIVED and PAYMENT_CONFIRMED are a CONVERSION; PAYMENT_OVERDUE is
// an AGENT_NUDGE. `externalReference` (the token toolpacks/asaas.ts sent) is preferred over
// payment.id, since a link-generated payment has its own id; payment.id is the fallback and ALWAYS
// drives dedupeKey (one reference may span installments). Optional fields are `.nullish()` because
// Asaas sends explicit nulls; min(1) makes an empty string invalid, not a broken correlation.
// `summary` is OUR text, not the payload.
// TODO: confirm a paid link payment echoes externalReference, else correlate by `paymentLink`.
const asaasSchema = z.object({
  event: z.string().min(1),
  payment: z
    .object({
      id: z.string().min(1),
      value: z.number().finite().nullish(),
      status: z.string().max(64).nullish(),
      externalReference: z.string().min(1).max(128).nullish(),
      // The payment link id (doc-confirmed field on link-paid payments). Captured for the
      // correlation contingency above; not currently used for the lookup.
      paymentLink: z.string().min(1).max(128).nullish(),
    })
    .optional(),
});

// Schema drift the receptor must surface (warn + durable record): issue PATHS only, never the
// received values. ASCII by construction, so the cap cuts no character in half.
function issuePaths(error: z.ZodError): string {
  return error.issues
    .map((i) => i.path.join(".") || "(root)")
    .join(", ")
    .slice(0, 200);
}

const ASAAS_CONVERSION_EVENTS = new Set([
  "PAYMENT_RECEIVED",
  "PAYMENT_CONFIRMED",
]);

const asaasMapper: InboundMapper = {
  catalogType: "ASAAS",
  map(raw: unknown): MapResult {
    const parsed = asaasSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, reason: "invalid", detail: issuePaths(parsed.error) };
    }
    if (!parsed.data.payment) return { ok: false, reason: "unhandled" };
    const { event, payment } = parsed.data;
    const base = {
      externalId: payment.externalReference ?? payment.id,
      dedupeKey: `${event}:${payment.id}`,
      status: payment.status ?? undefined,
      // Carry the link id for the correlation contingency + observability (never the raw payload).
      ...(payment.paymentLink
        ? { metadata: { paymentLink: payment.paymentLink } }
        : {}),
    };
    if (ASAAS_CONVERSION_EVENTS.has(event)) {
      return {
        ok: true,
        event: {
          ...base,
          kind: "conversion",
          value: payment.value ?? undefined,
          currency: "BRL",
          summary: "Payment received",
        },
      };
    }
    if (event === "PAYMENT_OVERDUE") {
      return {
        ok: true,
        event: { ...base, kind: "agent_nudge", summary: "Payment is overdue" },
      };
    }
    return { ok: false, reason: "unhandled" }; // other lifecycle events are ignored
  },
};

registerMapper(asaasMapper);
