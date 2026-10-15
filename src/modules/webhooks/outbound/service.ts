import type { Prisma } from "@/../generated/prisma/client";
import type { ScopedDb } from "@/lib/tenancy";
import {
  buildOutboundEnvelope,
  type OutboundEvent,
  subscriptionKeysFor,
} from "./events";

// Outbound webhook fan-out (enqueue side). Domain code calls emitOutbound within its
// scoped transaction; this creates one OutboundWebhookDelivery row per enabled subscription
// that listens for the event. The delivery worker (outbound/worker.ts) claims PENDING rows with
// FOR UPDATE SKIP LOCKED and POSTs them (HMAC-signed, SSRF-checked, full-jitter retry).
//
// `data` is the allowlist-sanitized projection (only ids/status/counters/money — never raw
// entities/PII/tokens); emitOutbound wraps it in the versioned envelope (buildOutboundEnvelope)
// and stores THAT as the delivery payload, so the worker POSTs the envelope verbatim.

export type { OutboundEvent } from "./events";

export async function emitOutbound(
  db: ScopedDb,
  tenantId: bigint,
  event: OutboundEvent,
  data: Record<string, unknown>,
): Promise<number> {
  const subs = await db.webhookSubscription.findMany({
    where: { enabled: true, events: { hasSome: subscriptionKeysFor(event) } },
    select: { id: true },
  });
  if (subs.length === 0) return 0;

  const envelope = buildOutboundEnvelope(tenantId, event, data);
  await db.outboundWebhookDelivery.createMany({
    data: subs.map((sub) => ({
      tenantId,
      subscriptionId: sub.id,
      event,
      payload: envelope as unknown as Prisma.InputJsonValue,
      status: "PENDING" as const,
    })),
  });
  return subs.length;
}

// One event per item, for a statement that changes many rows at once: one subscription read and one
// insert, where calling emitOutbound per item would be two round trips each inside the caller's
// transaction.
export async function emitOutboundMany(
  db: ScopedDb,
  tenantId: bigint,
  event: OutboundEvent,
  items: readonly Record<string, unknown>[],
): Promise<number> {
  if (items.length === 0) return 0;
  const subs = await db.webhookSubscription.findMany({
    where: { enabled: true, events: { hasSome: subscriptionKeysFor(event) } },
    select: { id: true },
  });
  if (subs.length === 0) return 0;
  await db.outboundWebhookDelivery.createMany({
    data: items.flatMap((data) => {
      const envelope = buildOutboundEnvelope(tenantId, event, data);
      return subs.map((sub) => ({
        tenantId,
        subscriptionId: sub.id,
        event,
        payload: envelope as unknown as Prisma.InputJsonValue,
        status: "PENDING" as const,
      }));
    }),
  });
  return subs.length * items.length;
}

// Full-jitter exponential backoff (capped). attempt is 1-based.
export function nextBackoffMs(
  attempt: number,
  baseMs = 1_000,
  capMs = 3_600_000,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 20));
  // NOTE: jitter uses a deterministic-enough spread seeded by attempt; callers that need
  // true randomness can pass their own. Math.random is fine in app runtime (not workflows).
  return Math.floor(Math.random() * exp);
}
