import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// Shared by the live delivery (./webhook.ts), which asks it to decide whether an observer beside a
// responder stands down, and by the human-reply recovery (./recover-human-reply.ts), which asks it to
// decide whose memory a colleague's reply is folded under. One predicate, so the two
// paths cannot disagree about whether the responder received the message.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Does the responder actually have a delivery of this message? An observer beside a responder does
// not fold the message into memory because the responder's delivery does (`responderRemembers`), but
// Chatwoot picks recipients from the bindings standing when it EMITS the event, so a responder bound
// afterwards never gets it and standing down would lose the message from memory for good. Covered
// when the binding predates the emission by the margin (a NULL `responderBoundAt` predates
// everything), or when a sibling delivery on the responder's route that could still see the binding
// is in the ledger; otherwise the observer keeps it. See docs/chatwoot.md, "Observer binding".

// The margin: `responderBoundAt` is OUR clock and `last_activity_at` is CHATWOOT's, so compared
// directly a Chatwoot running ahead makes a later binding look older. Outside five minutes the answer
// does not depend on which host is ahead (far past a synchronised fleet's skew, still covering a host
// without NTP); inside it the ledger is asked, one extra read only in the window that matters.
const BINDING_CLOCK_SKEW_MS = 5 * 60_000;

// The clock is the EMISSION, not the receipt: Chatwoot chose the recipients when it emitted, and a
// receipt adds a network hop and any delivery wait. `last_activity_at` is that moment for a
// `message_created`, read at the START of its second (epoch seconds; rounding early errs toward asking
// for evidence); a payload carrying none falls back to the receipt. Erring toward "the binding is
// newer" costs a duplicate memory line when the sibling is still in flight, the other way costs the
// message: wrong and visible over quiet and wrong.
export async function responderCoversMessage(
  tenantId: bigint,
  instanceId: bigint,
  deliveryRowId: bigint,
  responderBoundAt: Date | null,
  responderBotId: number,
  conversationId: number | null,
  // Which message, and on which column the sibling records it: a customer message is the ledger's
  // `inboundMessageId`, while a colleague's reply is outgoing and named by `humanReplyMessageId`.
  // Asked with the inbound column alone, a reply never finds its sibling and both routes append it.
  message: { id: number; column: "inbound" | "humanReply" } | null,
  // When the source EMITTED this event, from the payload's own clock; null when it carries none.
  emittedAt: Date | null,
  base: PrismaClient,
): Promise<boolean> {
  if (responderBoundAt === null) return true;
  // NOTE: only by a margin the clocks cannot invent: the two stamps come from different hosts, so
  // "just before" is not an answer either of them can give.
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
    // NOTE: our own row not being readable is not evidence that the responder is missing the message;
    // answer covered rather than double what the responder remembers.
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
        // NOTE: only a sibling that can still see the binding: never claimed (it runs after this read,
        // binding committed), or claimed at or after the binding. `bindInbox` calls Chatwoot BEFORE it
        // commits `agentId`, so a delivery in that gap resolves no runtime and settles, and counting it
        // hands the message to a route that declined it. The claim narrows that gap without closing it
        // (the route resolves before the claim). Comparing the sibling's RECEIPT instead guts the check,
        // and `routeObserved` cannot tell "resolved nothing" from the responder's route. See
        // docs/chatwoot.md, "Observer binding".
        OR: [{ claimedAt: null }, { claimedAt: { gte: responderBoundAt } }],
        // NOTE: never this row. One bot serves every role its agent holds, so an observer re-bound as
        // the responder arrives on `responderBotId` itself, and a recovery's own claim postdates the
        // binding: the row would match itself and close with nothing remembering the message.
        id: { not: deliveryRowId },
      },
    });
    return sibling > 0;
  });
}
