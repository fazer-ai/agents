// What a ledger row still stuck on PENDING or PROCESSING means, long after the attempt that claimed
// it started.
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
// A pure function of the row alone, and it got there by DELETION. What used to live here was a
// comparison against the conversation's watermarks, meant to tell a message a later burst covered
// from one nothing covered. Three review rounds each found a different way that fails, for one
// shared reason: a watermark is a per-CONVERSATION high-water mark and this is a per-MESSAGE
// question, so every scalar reading of it either closes a real loss or reports a covered message.
// The fact now comes from the only place that holds it — a turn that runs over a message retires
// that message's ledger row itself, so a row still non-terminal is one nothing covered. The sweep
// and that retirement are both in ./delivery-sweep.ts.

export interface StrandedDeliveryRow {
  // Wall clock the CURRENT attempt started at: when the row was claimed, or when it was received if
  // nothing has claimed it. A row is not stranded because it is old, it is stranded because nothing
  // has moved it for longer than the longest legitimate delivery — and a redelivery is allowed to
  // claim a row left stranded on PENDING, so an attempt that started a minute ago must not be judged
  // by a receipt from an hour ago.
  attemptStartedAt: Date;
  // The INBOUND message this delivery carried, when it carried one. Null on every event that is not
  // a customer message — a conversation update, the bot's own reply coming back around — and those
  // are the rows where nothing was lost no matter how long they sat.
  inboundMessageId: number | null;
}

export interface StrandedDeliveryPolicy {
  now: Date;
  // How long a row may sit non-terminal before it counts as abandoned rather than in flight.
  staleAfterMs: number;
}

export type StrandedVerdict =
  // The current attempt started recently enough that a live process may still be working it. Left
  // alone.
  | "in-flight"
  // Stranded, but carried no inbound message. Terminal and benign: nothing a customer sent is at
  // stake, so it must NOT appear in the list of lost messages.
  | "no-message"
  // Stranded with a customer message nothing ever covered. Nothing will answer it.
  //
  // There is no "already covered" verdict, and its absence is the design rather than an omission: a
  // message a later turn ran over never reaches this function at all, because that turn retired its
  // row and the scan only sees non-terminal ones.
  | "lost";

export function classifyStrandedDelivery(
  row: StrandedDeliveryRow,
  policy: StrandedDeliveryPolicy,
): StrandedVerdict {
  const age = policy.now.getTime() - row.attemptStartedAt.getTime();
  if (age < policy.staleAfterMs) return "in-flight";
  if (row.inboundMessageId === null) return "no-message";
  return "lost";
}
