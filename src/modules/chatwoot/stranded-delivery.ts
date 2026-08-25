// What to do with a ledger row that is still `PROCESSING` long after it was claimed.
//
// `processChatwootDelivery` brackets its work between two writes: a CAS `PENDING -> PROCESSING` and
// a final `-> PROCESSED`. A process that dies in between (deploy, OOM, restart) leaves the row on
// PROCESSING with nothing running, and nothing ever moves it again — the ack is spent, so Chatwoot
// will not redeliver, and a redelivery would CAS against `PENDING` and match nothing anyway. The
// customer's message is then never answered and the only trace is the stranded row (issue #228).
//
// Measured, on this repo's own code: an interruption injected between the two CAS points leaves
// `status = PROCESSING, attempts = 0`, and a second call for the same row returns "skipped". An
// ordinary exception does NOT reach here — the agent turn, the eager media and the mirror write are
// each caught, so the delivery still reaches PROCESSED. The window this classifies is a death
// between the two writes, not a failure inside them.
//
// The verdict is a pure function of the row so the RULE is testable without a database and without
// the network call the recovery makes. The sweep that consumes it is in ./delivery-sweep.ts.

export interface StrandedDeliveryRow {
  // Wall clock the row was claimed at. A row is not stale because it is old, it is stale because
  // nothing has moved it for longer than the longest legitimate delivery.
  receivedAt: Date;
  // How many sweeps have already tried to recover this row. Bounds a poisoned delivery: the column
  // exists in the schema since the ledger was introduced and, until this sweep, was never written.
  attempts: number;
  // The Chatwoot display id this delivery was about, `null` on an event that names no conversation.
  conversationId: number | null;
}

export interface StrandedDeliveryPolicy {
  now: Date;
  // How long a row may sit on PROCESSING before it counts as abandoned rather than in flight.
  staleAfterMs: number;
  // How many recovery attempts a single row gets before it is given up on.
  maxAttempts: number;
}

export type StrandedVerdict =
  // Claimed recently enough that a live process may still be working it. Left alone.
  | "in-flight"
  // Stale, names a conversation, and has attempts left: re-arm that conversation's flush.
  | "recover"
  // Stale and names no conversation, so there is nothing to re-arm. Terminal, and not a failure:
  // an event with no conversation carries no customer message to lose.
  | "unrecoverable"
  // Stale and out of attempts: recovery has been tried and keeps failing. Terminal.
  | "exhausted";

// NOTE: `unrecoverable` is asked BEFORE `exhausted` on purpose. A row that names no conversation can
// never be recovered no matter how many attempts remain, so reporting it as "out of attempts" would
// name a retry budget it never spent and send an operator looking for a transient fault.
export function classifyStrandedDelivery(
  row: StrandedDeliveryRow,
  policy: StrandedDeliveryPolicy,
): StrandedVerdict {
  const age = policy.now.getTime() - row.receivedAt.getTime();
  if (age < policy.staleAfterMs) return "in-flight";
  if (row.conversationId === null) return "unrecoverable";
  if (row.attempts >= policy.maxAttempts) return "exhausted";
  return "recover";
}
