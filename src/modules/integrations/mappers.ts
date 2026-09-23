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

// ── GENERIC (issue #818) ──
// The operator's own system, calling back about a conversation an HTTP tool handed it. There is no
// third-party shape to translate: the body IS our documented normalized shape, so this only
// validates it. `conversation_ref` is the correlation key the tool minted (IntegrationExternalRef,
// kind `conversation_ref`), `event_id` is the sender's idempotency key, `text` is what the agent
// passes on. Unknown keys are ignored rather than refused, so a sender can carry its own fields.
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
// Brazilian payments. Webhook shape (doc-confirmed, docs.asaas.com → "Webhook para cobranças",
// 2026-06): { event: "PAYMENT_RECEIVED", payment: { id, value, status, externalReference,
// paymentLink, … } }. A received/confirmed payment is a CONVERSION; an overdue payment is an
// AGENT_NUDGE (let the agent decide on a gentle reminder). Event names PAYMENT_RECEIVED /
// PAYMENT_CONFIRMED / PAYMENT_OVERDUE are all confirmed in the docs.
//
// Correlation: the outbound toolpack (toolpacks/asaas.ts) sends an opaque correlation token as the
// payment link's `externalReference` (a doc-confirmed accepted field on POST /paymentLinks) and
// stores it as IntegrationExternalRef.externalId. We read it back here PREFERENTIALLY over
// payment.id — a link-generated payment has a different id than the link but carries the
// externalReference, the exact tie back to the conversation. payment.id is the fallback (direct
// charges) and ALWAYS drives dedupeKey (the charge is the idempotency unit; one externalReference
// may span installment charges).
//
// OPEN (needs Asaas sandbox e2e, creds-gated): confirm a link-generated payment actually ECHOES the
// link's externalReference. If it does NOT, the contingency is to correlate by `payment.paymentLink`
// (the link id, already stored on the ref as metadata.paymentLinkId) — we capture paymentLink in the
// schema/metadata below for that, but DO NOT wire it into the lookup yet (speculative until the
// sandbox capture says so).
//
// `summary` is OUR text, never the raw payload (injection boundary).
// NOTE: the optional payment fields are `.nullish()`, not `.optional()` — Asaas SENDS them as
// explicit nulls (paymentLink is always present, null on direct/non-link charges;
// externalReference is null on charges created outside our tools). `.optional()` alone rejects
// null and used to silently drop real paid-payment webhooks. min(1) stays deliberate: an empty
// string would corrupt the correlation key silently (`"" ?? payment.id` does not coalesce), so
// it must surface as invalid instead.
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
