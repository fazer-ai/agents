// What a ledger row still stuck on PENDING or PROCESSING means, long after it was received.
//
// `processChatwootDelivery` brackets its work between a CAS `PENDING -> PROCESSING` and a final
// `-> PROCESSED`, and the 200 is already out before either runs. A process that dies anywhere in
// there leaves a non-terminal row with nothing working it: Chatwoot will not redeliver, and a
// redelivery would CAS against `PENDING` and match nothing. The customer's message is never
// answered, and the only trace is a row nobody reads (issue #228).
//
// Measured, on this repo's own code: an interruption injected between the two CAS points leaves
// `status = PROCESSING, attempts = 0`, and a second call for the same row returns "skipped". An
// ordinary exception does NOT reach here — the agent turn, the eager media pass and the mirror write
// are each caught, so the delivery still reaches PROCESSED.
//
// This says whether a customer message was LOST, and nothing else. It does not answer, and the sweep
// that consumes it does not either — recovering the turn needs the gates the delivery path applies
// before a flush (test mode, availability, redirect) and none of them survive the process that died.
// That is issue #295.
//
// A pure function of the row plus one number from the mirror, so the rule is testable without a
// database. The sweep is in ./delivery-sweep.ts.

export interface StrandedDeliveryRow {
  // Wall clock the row was written at. A row is not stranded because it is old, it is stranded
  // because nothing has moved it for longer than the longest legitimate delivery.
  receivedAt: Date;
  // The INBOUND message this delivery carried, when it carried one. Null on every event that is not
  // a customer message — a conversation update, the bot's own reply coming back around — and those
  // are the rows where nothing was lost no matter how long they sat.
  inboundMessageId: number | null;
}

export interface StrandedDeliveryPolicy {
  now: Date;
  // How long a row may sit non-terminal before it counts as abandoned rather than in flight.
  staleAfterMs: number;
  // The conversation's handled watermark, or null when the mirror does not know the conversation.
  // Null is treated as "not answered": the safe reading of a question that cannot be answered is
  // the one that puts the row in front of an operator instead of closing it quietly.
  handledMessageId: number | null;
}

export type StrandedVerdict =
  // Received recently enough that a live process may still be working it. Left alone.
  | "in-flight"
  // Stranded, but carried no inbound message. Terminal and benign: nothing a customer sent is at
  // stake, so it must NOT appear in the list of lost messages.
  | "no-message"
  // Stranded, and the message it carried is at or below the handled watermark — something else
  // answered it (a redelivery, a later burst's flush). Terminal and benign.
  | "already-answered"
  // Stranded with a customer message still above the watermark. Nothing will answer it.
  | "lost";

export function classifyStrandedDelivery(
  row: StrandedDeliveryRow,
  policy: StrandedDeliveryPolicy,
): StrandedVerdict {
  const age = policy.now.getTime() - row.receivedAt.getTime();
  if (age < policy.staleAfterMs) return "in-flight";
  if (row.inboundMessageId === null) return "no-message";
  if (
    policy.handledMessageId !== null &&
    policy.handledMessageId >= row.inboundMessageId
  ) {
    return "already-answered";
  }
  return "lost";
}
