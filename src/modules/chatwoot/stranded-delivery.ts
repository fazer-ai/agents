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
  // Which non-terminal state it is stuck in. Both strand, but only one of them carries a promise
  // about the other columns (see `claimedAt`).
  status: "PENDING" | "PROCESSING";
  receivedAt: Date;
  // When the CURRENT attempt claimed the row, or null when nothing has. A row is not stranded
  // because it is old, it is stranded because nothing has moved it for longer than the longest
  // legitimate delivery — and a redelivery is allowed to claim a row left stranded on PENDING, so an
  // attempt that started a minute ago must not be judged by a receipt from an hour ago.
  claimedAt: Date | null;
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
  // Stranded with a customer message nothing ever covered, or stranded by a build whose columns
  // cannot be read. Nothing will answer it.
  //
  // There is no "already covered" verdict, and its absence is the design rather than an omission: a
  // message a later turn ran over never reaches this function at all, because that turn retired its
  // row and the scan only sees non-terminal ones.
  | "lost";

export function classifyStrandedDelivery(
  row: StrandedDeliveryRow,
  policy: StrandedDeliveryPolicy,
): StrandedVerdict {
  const age =
    policy.now.getTime() - (row.claimedAt ?? row.receivedAt).getTime();
  if (age < policy.staleAfterMs) return "in-flight";
  // A row PROCESSING without a claim stamp was claimed by a build that predates the column, which
  // during a rolling deploy is the container still serving while the new one migrates. Its nulls are
  // UNRECORDED, not "nothing was there", so the question below cannot be asked of it: read the
  // literal way, every message the old container lost would be closed as carrying none — the exact
  // silence this sweep exists to remove, on the rows a deploy is most likely to strand.
  //
  // Only PROCESSING carries that promise. tx1 stamps the claim on every row this build works, so a
  // missing stamp there is provenance; on PENDING nothing has claimed yet and there is nothing to
  // infer from its absence.
  if (row.status === "PROCESSING" && row.claimedAt === null) return "lost";
  if (row.inboundMessageId === null) return "no-message";
  return "lost";
}
