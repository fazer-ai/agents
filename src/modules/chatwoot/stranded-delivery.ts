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
  // How far a TURN THAT RAN got on this conversation (`Conversation.lastAnsweredMessageId`), or null
  // when none has, INCLUDING when the mirror does not know the conversation at all. Null is treated
  // as "nothing covered it": the safe reading of a question that cannot be answered is the one that
  // puts the row in front of an operator instead of closing it quietly.
  //
  // NOT the handled watermark, and the difference is the whole reliability of this verdict. That
  // mark means "never re-ANSWER this", and most of its writers advance it precisely because no turn
  // is running — an unauthorized contact, a human taking the conversation mid-turn, a message that
  // arrived while the conversation was already human-owned. Read as proof that something processed
  // the message it says a customer was served when nothing looked at it, which for this sweep means
  // closing a real loss quietly.
  //
  // What it proves is narrower than "the customer got a reply", and deliberately so: the claim has
  // to precede the send to be at-most-once, so an empty model reply or a guardrail suppression
  // claims the mark and posts nothing. That is the right line for this reader. The question here is
  // whether a message was lost to a PROCESS DEATH, and a burst a turn ran over and answered with
  // silence was not lost — the silence was a decision, and it has its own trail.
  //
  // STRICTLY PAST the message, never level with it, and that difference is a real crash window. The
  // mark is an at-most-once CLAIM taken in `shouldPost` BEFORE the reply is sent, so a process that
  // dies in between leaves a mark recording an intention nobody carried out. A mark level with this
  // row's own message is that case: nothing else could have put it exactly there, because a later
  // burst claims a LATER message. Strictly past means another burst went by, and that burst
  // re-fetched everything above the handled watermark — which this message was above, its own
  // delivery having died before advancing it — so it was in that burst.
  //
  // The granularity that buys is the CONVERSATION, not the message. If that later burst died before
  // posting too, its own row is stranded and level with the mark, so the conversation is reported —
  // by one row instead of two, which is enough for the only action there is.
  answeredMessageId: number | null;
  // Whether this conversation's agent COALESCES. It decides what a later watermark proves, which is
  // not the same question as how far the watermark got.
  //
  // With debouncing on, a flush re-fetches every message above the handled watermark and hands them
  // to the model together, so an answered mark past the stranded message means that message WAS in
  // the burst that got answered. With it off, each delivery answers its own message directly: a
  // later message moves the mark past the stranded one without the model ever having seen it, and
  // reading that as "answered" would close a real loss (measured on this repo's direct path, which
  // is the one an agent with `settings.debounce.enabled = false` takes).
  //
  // The sweep reads this from the agent's CURRENT settings, which is the one thing here that is not
  // exact — see the note at its call site for which direction that can be wrong in.
  coalesces: boolean;
}

export type StrandedVerdict =
  // Received recently enough that a live process may still be working it. Left alone.
  | "in-flight"
  // Stranded, but carried no inbound message. Terminal and benign: nothing a customer sent is at
  // stake, so it must NOT appear in the list of lost messages.
  | "no-message"
  // Stranded, and a later turn on the conversation ran over the message it carried. Terminal and
  // benign: nothing was lost to the crash.
  | "already-answered"
  // Stranded with a customer message no turn ever covered. Nothing will answer it.
  | "lost";

export function classifyStrandedDelivery(
  row: StrandedDeliveryRow,
  policy: StrandedDeliveryPolicy,
): StrandedVerdict {
  const age = policy.now.getTime() - row.attemptStartedAt.getTime();
  if (age < policy.staleAfterMs) return "in-flight";
  if (row.inboundMessageId === null) return "no-message";
  // NOTE: the null check answers the COMPILER, not the runtime — `null > id` is already false for
  // every Chatwoot id, so removing it changes no behaviour and no test can kill that mutation. It
  // stays because without it this does not typecheck (TS18047), which is the stronger guarantee of
  // the two.
  if (
    policy.coalesces &&
    policy.answeredMessageId !== null &&
    policy.answeredMessageId > row.inboundMessageId
  ) {
    return "already-answered";
  }
  return "lost";
}
