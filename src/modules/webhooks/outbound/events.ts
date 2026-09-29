import { instanceIdentity } from "@/lib/instance";

// Closed set of outbound webhook event types. The union below is the SINGLE source of truth:
// emitOutbound is typed to it, the REST CRUD validates each subscribed event against it, and
// the UI lists it. Adding an event = add one literal here (and emit it at a seam).
//
// The wire payload is always a versioned envelope (buildOutboundEnvelope): the receiver can
// branch on `event` and trust `version`/`instance_id`/`tenant_id` to attribute it to a fleet
// instance. `data` is an allowlisted projection per event — only ids, status, counters and
// money values. NEVER message bodies, contact PII (name/phone/email), tokens, or raw entities.

// "heartbeat" is a periodic liveness ping. Unlike the other events (emitted at a domain seam),
// it is produced by a self-re-arming per-tenant SchedulerJob (kind HEARTBEAT) in outbound/heartbeat.ts,
// armed lazily only while the tenant has an enabled "heartbeat" subscription (see syncTenantHeartbeat)
// and self-terminating otherwise. Cadence: config.heartbeat.intervalMs (HEARTBEAT_INTERVAL_MS).
export const OUTBOUND_EVENTS = [
  "conversation.created",
  "conversation.status_changed",
  "conversation.handoff",
  "kanban.card_moved",
  "llm.usage",
  "tenant.created",
  "heartbeat",
] as const;

export type OutboundEvent = (typeof OUTBOUND_EVENTS)[number];

const OUTBOUND_EVENT_SET = new Set<string>(OUTBOUND_EVENTS);

export function isOutboundEvent(value: string): value is OutboundEvent {
  return OUTBOUND_EVENT_SET.has(value);
}

export const OUTBOUND_ENVELOPE_VERSION = 1 as const;

export interface OutboundEnvelope {
  version: typeof OUTBOUND_ENVELOPE_VERSION;
  instance_id: string;
  event: OutboundEvent;
  occurred_at: string;
  tenant_id: string;
  data: Record<string, unknown>;
}

// Centralizes envelope construction so every emit shares one shape. `data` MUST already be the
// sanitized projection (the caller is responsible for the allowlist). occurred_at is stamped at
// emit time (when the event happened), not at delivery time.
export function buildOutboundEnvelope(
  tenantId: bigint,
  event: OutboundEvent,
  data: Record<string, unknown>,
  now: () => number = () => Date.now(),
): OutboundEnvelope {
  return {
    version: OUTBOUND_ENVELOPE_VERSION,
    instance_id: instanceIdentity.instanceId,
    event,
    occurred_at: new Date(now()).toISOString(),
    tenant_id: String(tenantId),
    data,
  };
}
