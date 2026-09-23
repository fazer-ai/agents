import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// Shared by the live delivery (./webhook.ts), which asks it to decide whether an observer beside a
// responder stands down, and by the human-reply recovery (./recover-human-reply.ts), which asks it to
// decide whose memory a colleague's reply is folded under (issue #742). One predicate, so the two
// paths cannot disagree about whether the responder received the message.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// DOES THE RESPONDER ACTUALLY HAVE A DELIVERY OF THIS MESSAGE? (issue #476 review, round 31.)
//
// An observer beside a responder does not fold the message into memory, because the responder's own
// delivery of the same message does — see `responderRemembers`. That is true only when Chatwoot
// FANNED the message to the responder, and Chatwoot picks a message's recipients from the bindings
// that stand when it emits the event. A responder bound after the emission gets no delivery for it,
// so standing down there omits the message from memory permanently: nothing scans a settled
// observer row again, and the responder's route never saw it.
//
// Three answers, cheapest first, and the two reads happen only in the window that needs them:
//
//  1. The binding is older than our receipt of this delivery. Then it stood when Chatwoot emitted,
//     because emission precedes receipt. Covered, with no read. A NULL `responderBoundAt` — a
//     binding made before the column existed — is read the same way, which is exactly the behaviour
//     every such inbox already had.
//  2. The binding is newer than our receipt, and a sibling delivery on the responder's route is
//     already in the ledger for this message, AND that sibling did not already run without the
//     binding. Chatwoot fanned it after all (the two routes race, and this one lost), so it is
//     covered — direct evidence, not an inference from clocks.
//  3. The binding is newer and there is no sibling, or the only sibling already ran blind. Nothing
//     is coming. NOT covered: the observer keeps the message.
//
// THE SIBLING'S OWN CLOCK is what makes (2) evidence rather than another inference (issue #476
// review, round 32). `bindInbox` calls Chatwoot BEFORE it commits `agentId`, so a message arriving
// inside that window is fanned to a responder route the local mirror does not know yet: that
// delivery resolves no runtime, answers nothing, remembers nothing, and settles. Counting it here
// hands the message to a route that already declined it, and neither route answers or remembers —
// the limbo this whole check exists to prevent, at P1 instead of P2. So the sibling counts only
// while it can still see the binding: never claimed (`claimedAt` null — it runs after this, and the
// binding is committed by then), or claimed at or after the moment the binding was made. A sibling
// claimed BEFORE that ran blind and covers nothing.
//
// HOW FAR THE BINDING HAS TO PREDATE THE EVENT for the clocks alone to settle it (issue #476 review,
// round 45). `responderBoundAt` is stamped by US and `last_activity_at` is stamped by CHATWOOT, on a
// host whose clock is its own: compared directly, a Chatwoot running ahead makes a binding that came
// AFTER the event look older than it, and the observer stands down for a sibling that does not
// exist. No timestamp available here is a lower bound on the emission in our own clock — the receipt
// is later still — so the only clock-free evidence is the sibling row itself.
//
// A margin is what makes the fast path honest rather than removing it: outside this band the answer
// does not depend on which host is ahead, and inside it the ledger is asked instead. Five minutes is
// far past the skew a synchronised fleet produces and still covers a host that drifted without NTP;
// it costs one extra read only for a binding made around the time of the event, which is exactly the
// window the check exists for.
const BINDING_CLOCK_SKEW_MS = 5 * 60_000;

// THE CLOCK IS THE EMISSION, NOT THE RECEIPT (issue #476 review, round 36). Chatwoot chose the
// recipients when it emitted, and a receipt is that moment plus a network hop plus however long the
// delivery waited — so a binding made anywhere in that stretch read as covering a message it never
// reached. The payload's own `last_activity_at` is that moment for a `message_created` (the
// conversation's activity IS this message), and it is read at the START of its second: it is only
// ever epoch seconds, and rounding early is the direction that errs toward asking for evidence
// rather than toward assuming coverage. A payload that carries none falls back to the receipt,
// which is the reading every delivery had before this.
//
// What remains is bounded by the sibling check rather than by a clock: erring toward "the binding is
// newer" costs a duplicate line in the shared thread when the sibling is genuinely still in flight,
// and erring the other way costs the message. Wrong and visible over quiet and wrong, the rule this
// whole subsystem is built on.
export async function responderCoversMessage(
  tenantId: bigint,
  instanceId: bigint,
  deliveryRowId: bigint,
  responderBoundAt: Date | null,
  responderBotId: number,
  conversationId: number | null,
  // WHICH MESSAGE, and on WHICH COLUMN the sibling records it (issue #476 review, round 46). A
  // customer message is the ledger's `inboundMessageId`; a COLLEAGUE'S REPLY is outgoing, so that
  // column is null on it by construction and the row names the message through
  // `humanReplyMessageId` instead. Asked with the inbound column alone, a reply found no sibling
  // ever — the check returned "not covered" without looking — and both routes appended the same
  // line to the shared thread, which is the duplication this whole predicate exists to prevent.
  message: { id: number; column: "inbound" | "humanReply" } | null,
  // When the source EMITTED this event, from the payload's own clock; null when it carries none.
  emittedAt: Date | null,
  base: PrismaClient,
): Promise<boolean> {
  if (responderBoundAt === null) return true;
  // ...and only by a margin the clocks cannot invent (round 45): the two stamps come from different
  // hosts, so "just before" is not an answer either of them can give.
  if (
    emittedAt !== null &&
    responderBoundAt.getTime() <= emittedAt.getTime() - BINDING_CLOCK_SKEW_MS
  )
    return true;
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const self = await db.chatwootWebhookDelivery.findUnique({
      where: { id: deliveryRowId },
      select: { receivedAt: true },
    });
    // Our own row not being readable is not evidence that the responder is missing the message;
    // keep the answer this path has always given rather than double what the responder remembers.
    if (self === null) return true;
    // The receipt only answers where the payload named no emission of its own — and there it is OUR
    // clock on both sides, so it needs no margin.
    if (emittedAt === null && responderBoundAt <= self.receivedAt) return true;
    // Without both coordinates the sibling cannot be named, and an unnamed sibling is not one that
    // was found. The binding is newer than the delivery here, so the message is the observer's.
    if (conversationId === null || message === null) return false;
    const sibling = await db.chatwootWebhookDelivery.count({
      where: {
        chatwootInstanceId: instanceId,
        conversationId,
        ...(message.column === "inbound"
          ? { inboundMessageId: message.id }
          : { humanReplyMessageId: message.id }),
        routeAgentBotId: responderBotId,
        // ONLY A SIBLING THAT CAN STILL SEE THE BINDING. Never claimed, so it runs after this read
        // with the binding committed; or claimed at or after the binding was made, since
        // `bindInbox` calls Chatwoot BEFORE it commits `agentId` and a message landing in that gap
        // reaches a responder route the mirror does not name yet, whose delivery resolves no
        // runtime, answers nothing and settles. Counting that one hands the message to a route that
        // already declined it, and neither route answers or remembers.
        //
        // THE CLAIM NARROWS THAT GAP AND DOES NOT CLOSE IT (issue #476 review, round 52), because
        // the route is resolved BEFORE the row is claimed: a sibling that read the inbox before the
        // commit and claimed after it passes this predicate while the runtime it froze saw no
        // responder. It is the same missing fact as the other windows this feature names — the
        // delivery does not record the generation its route resolution read — and closing it is
        // issue #540's own change, a resolution stamp on the ledger. The two read-only alternatives
        // were measured and are worse: `routeObserved` is `false` for a route that resolved NOTHING
        // exactly as it is for the responder's, and comparing the sibling's RECEIPT to the binding
        // guts the check — the sibling is a fan-out of the same message, so its receipt straddles
        // the binding just as ours does, and the observer would double-remember every message whose
        // binding is newer than it, which rounds 31 and 33 exist to prevent. What is left costs an
        // inbox with an observer and NO responder (with one bound, the sibling resolves the
        // OUTGOING responder and the message IS handled), a bind concurrent to the millisecond with
        // an inbound message, and the two fanned deliveries straddling the commit in opposite
        // directions: one observation tick, and a control command typed in that instant.
        OR: [{ claimedAt: null }, { claimedAt: { gte: responderBoundAt } }],
        // NEVER THIS ROW (issue #476 review, round 33). One bot serves every role its agent holds,
        // so an observer unobserved and bound as the responder makes `responderBotId` equal to the
        // bot THIS delivery arrived on — and a recovery's own claim stamps `claimedAt` after the
        // binding. The row would then match itself and prove a responder handled a message no
        // responder delivery ever carried, closing the recovered row with nothing remembering it.
        // A sibling is another row by definition.
        id: { not: deliveryRowId },
      },
    });
    return sibling > 0;
  });
}
