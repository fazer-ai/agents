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
  "document.approval_requested",
  "document.approval_decided",
  "document.approval_outcome",
  "channel.connected",
  "channel.disconnected",
  "heartbeat",
] as const;

export type OutboundEvent = (typeof OUTBOUND_EVENTS)[number];

const OUTBOUND_EVENT_SET = new Set<string>(OUTBOUND_EVENTS);

export function isOutboundEvent(value: string): value is OutboundEvent {
  return OUTBOUND_EVENT_SET.has(value);
}

// An event's family is the name before its first dot (`document` for `document.approval_decided`);
// `heartbeat` has none. A subscription may hold `<family>.*`, stored as written, which receives every
// event of that family including ones added later (docs/api-and-fleet.md, Outbound webhooks).
export function outboundEventFamily(event: string): string | null {
  const dot = event.indexOf(".");
  return dot > 0 ? event.slice(0, dot) : null;
}

export const OUTBOUND_EVENT_FAMILIES: readonly string[] = [
  ...new Set(
    OUTBOUND_EVENTS.map(outboundEventFamily).filter(
      (f): f is string => f !== null,
    ),
  ),
];

const OUTBOUND_FAMILY_SET = new Set<string>(OUTBOUND_EVENT_FAMILIES);

export function familyWildcard(family: string): string {
  return `${family}.*`;
}

// A name a subscription may hold: an event of the closed set, or the wildcard of a family that has at
// least one. Nothing else: `*`, `.*`, `conversation*` and `conversation.created.*` are refused.
export function isSubscribableEvent(value: string): boolean {
  if (isOutboundEvent(value)) return true;
  if (!value.endsWith(".*")) return false;
  return OUTBOUND_FAMILY_SET.has(value.slice(0, -2));
}

// The subscription entries that receive `event`: its own name and its family's wildcard.
export function subscriptionKeysFor(event: OutboundEvent): string[] {
  const family = outboundEventFamily(event);
  return family ? [event, familyWildcard(family)] : [event];
}

export interface OutboundEventGroup {
  // null for the events with no family (`heartbeat`), which have no wildcard either.
  family: string | null;
  wildcard: string | null;
  events: OutboundEvent[];
}

// The catalog grouped by family, in the order the events are declared, with the family-less events
// last in one group of their own.
export function outboundEventGroups(): OutboundEventGroup[] {
  const groups = new Map<string | null, OutboundEvent[]>();
  for (const event of OUTBOUND_EVENTS) {
    const family = outboundEventFamily(event);
    groups.set(family, [...(groups.get(family) ?? []), event]);
  }
  const out: OutboundEventGroup[] = [];
  for (const [family, events] of groups) {
    if (family !== null)
      out.push({ family, wildcard: familyWildcard(family), events });
  }
  const loose = groups.get(null);
  if (loose) out.push({ family: null, wildcard: null, events: loose });
  return out;
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
