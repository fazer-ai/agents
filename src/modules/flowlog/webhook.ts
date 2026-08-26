import type { PrismaClient } from "@/../generated/prisma/client";
import { emitFlowEvent } from "./service";

// AN OUTBOUND DELIVERY THE BUS GAVE UP ON, AND THE ONE LINE THAT SAYS SO.
//
// A delivery that reaches `DEAD` is an event the operator asked to receive and never will. Before
// issue #325 the only trace was the tick's summary line (`… dead=%d`), which counts the deaths
// without naming any of them and is not a channel anyone subscribes to: measured against the real
// worker with an enabled channel at `minLevel: warn` and no stage allowlist, two deliveries died —
// one on the eighth attempt, one on a URL the SSRF guard refused — and produced 0 `ExecutionLog`
// rows and 0 `AlertDelivery` rows. The only way to see a dead delivery was to read the deliveries
// table directly, which #305 answered is not a surface we can promise to keep.
//
// `error`, never `warn`. The two are the difference between "look when you can" and "something
// failed", and a DEAD delivery is a permanent loss of data the receiver was told it would get.
// It is also the level a channel gets by DEFAULT (`AlertChannel.minLevel` defaults to `error`, and
// `info` is not even a value it accepts), so anything softer would reach nobody who had not gone
// and widened their channel first — which is the state this issue reports.
//
// A broken receiver produces one death per event, so the flood risk is real and already handled one
// layer down: `dispatchAlertsForEvent` bumps `count` on a PENDING delivery for the same
// (channel, stage, level) instead of inserting another, and the alert worker drains that on a
// debounced window. A burst of a thousand dead deliveries is one alert that says a thousand.
//
// `detail` carries what the operator needs to FIND the delivery (its id, the subscription and the
// event name) and what tells them how it died (`attempts`, which is 8 on an exhausted budget and 1
// on a refused URL). The payload never travels: it is the customer's data, and a dead-letter alert
// is read by whoever runs the tenant, not by whoever the event was about. The error string is
// already sanitized where it is stored (`sanitizeErrorMessage`, issue #243) and is sanitized again
// on the way into the row.
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

// THE SAME DELIVERY, PUT BACK IN THE QUEUE BY AN OPERATOR (issue #305).
//
// It sits next to the death line for one reason: without it, the requeue is a silent mutation of
// the very row whose silence #325 was about. The ledger has to read "gave up after 8 attempts" and
// then "sent back to the queue", or the operator who did neither cannot tell a delivery that was
// never retried from one that was retried and died again.
//
// `info`, and that is not a softer `warn`: a requeue is somebody doing their job, not a failure.
// The level also decides the blast radius, because `dispatchAlertsForEvent` only routes `warn` and
// `error` — an `info` line lands in the Logs page and pages nobody, which is what an operator
// clearing a hundred dead deliveries needs it to do.
//
// `attemptsBefore` is the count the row died at, and the line is where it survives: the requeue
// resets `attempts` to 0 so the retry ladder starts over, so a minute later the row itself can no
// longer say how hard the bus already tried. `subscriptionEnabled` is here because a requeue into
// a disabled subscription is legal and does nothing until it is re-enabled (the worker's claim
// joins `enabled = true`) — the one case where a correct requeue looks like an ignored one.
//
// WHO did it is deliberately absent. This line is the delivery's history, not the actor's; the
// actor ledger is `audit_logs`, and that REST mutations do not reach it is issue #306, not
// something to patch one endpoint at a time.
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
