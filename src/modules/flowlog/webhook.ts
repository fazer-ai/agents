import type { PrismaClient } from "@/../generated/prisma/client";
import { emitFlowEvent } from "./service";

// An outbound delivery that reached `DEAD`: an event the operator asked to receive and never will.
// `error`, never `warn`: it is a permanent loss, and `error` is the level a channel gets by
// default. A burst coalesces one layer down (`dispatchAlertsForEvent` bumps `count` on a PENDING
// delivery). `detail` carries what finds the delivery (id, subscription, event) and how it died
// (`attempts`: 8 on an exhausted budget, 1 on a refused URL), never the payload; the error string
// is sanitized again.
export function emitDeliveryDead(args: {
  tenantId: bigint;
  deliveryId: bigint;
  subscriptionId: bigint;
  event: string;
  // The attempt count AFTER this one, i.e. what the row now stores. Named rather than derived so
  // the two roads to DEAD report the same number the deliveries table does.
  attempts: number;
  error: string;
  base?: PrismaClient;
}): void {
  emitFlowEvent(
    {
      tenantId: args.tenantId,
      // A delivery is not a turn and has no conversation to hang off, so this correlates the one
      // line with itself. It is still required: `turnId` is what the Logs page groups by.
      turnId: crypto.randomUUID(),
      source: "inbox",
      base: args.base,
    },
    {
      stage: "webhook",
      level: "error",
      status: "error",
      detail: {
        deliveryId: String(args.deliveryId),
        subscriptionId: String(args.subscriptionId),
        event: args.event,
        attempts: args.attempts,
      },
      errorMessage: args.error,
    },
  );
}

// The same delivery, put back in the queue by an operator, logged beside the death line so the
// ledger shows a retry rather than a silent mutation. `info`: a requeue is not a failure, and only
// warn/error page anyone. `attemptsBefore` survives here because the requeue resets `attempts` to
// 0; `subscriptionEnabled` because a requeue into a disabled subscription does nothing until
// re-enabled. No actor: that belongs in `audit_logs`.
export function emitDeliveryRequeued(args: {
  tenantId: bigint;
  deliveryId: bigint;
  subscriptionId: bigint;
  event: string;
  attemptsBefore: number;
  subscriptionEnabled: boolean;
  base?: PrismaClient;
}): void {
  emitFlowEvent(
    {
      tenantId: args.tenantId,
      turnId: crypto.randomUUID(),
      source: "inbox",
      base: args.base,
    },
    {
      stage: "webhook",
      level: "info",
      status: "ok",
      detail: {
        deliveryId: String(args.deliveryId),
        subscriptionId: String(args.subscriptionId),
        event: args.event,
        action: "requeued",
        attemptsBefore: args.attemptsBefore,
        subscriptionEnabled: args.subscriptionEnabled,
      },
    },
  );
}
