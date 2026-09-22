// MAY THIS TURN ACT ON A DEFERRED `resolve_conversation`?
//
// A pure decision, extracted because it was answered in three places and got a different answer in
// each. The three are the shapes a turn can take — a reply, attachments and a reply, attachments
// alone — and the review loop found the same defect in them one at a time, which is the signal that
// the question belongs to a function and not to a call site (issue #429).
//
// THE RULE IS ONE SENTENCE: an attendance the customer did not fully receive is not finished, so it
// does not close. `resolved` is what tells an operator there is nothing left to do here, and a
// customer holding the first of three balloons, or one of two promised files, is the opposite of
// that. The model asked to close believing it had answered; only the delivery knows whether it did.
//
// NOT the same question as "was the turn posted?", and the two are deliberately separate: a partial
// delivery still counts as posted, because the customer HAS part of it and re-running the turn would
// send that part a second time. What differs is what the platform may do NEXT.
//
// The rule was previously kept by accident on the reply path — a send that failed mid-reply threw,
// and a throw discards the deferred intent — which is exactly why it survived being unwritten for so
// long, and why reporting instead of throwing (#429) woke it up.
export interface DeliveryOutcome {
  // Part of the reply text did not reach the customer.
  replyPartial: boolean;
  // At least one queued attachment was attempted and did not get through. A document the operator
  // revoked is NOT this: nothing was attempted, and the withdrawal was their own decision.
  attachmentFailed: boolean;
}

export function mayCloseConversation(o: DeliveryOutcome): boolean {
  return !o.replyPartial && !o.attachmentFailed;
}

// The SECOND consequence of the same two bits, and derived from the first rather than restated so
// the two can never drift: an attendance the customer did not fully receive does not close, AND it
// is not the outcome that clears the operator's error badge.
//
// Both are "posted" for retry bookkeeping — the customer HAS part of it, and re-running would send
// that part twice. What separates them is what the callers may do next, and the live exercise is
// what made the distinction load-bearing: the turn's own `shouldPost` claims the burst with a
// monotonic CAS immediately before the first balloon, so a partial delivery is never re-answered by
// anyone. Nothing will complete this reply. Reported as plain "posted" it also CLEARS `lastError`,
// which leaves a customer holding half an answer on a conversation whose badge says the last turn
// went fine — measured against a real Chatwoot, and the reason this outcome exists.
export type PostedOutcome = "posted" | "posted-partial";

export function postedOutcomeFor(o: DeliveryOutcome): PostedOutcome {
  return mayCloseConversation(o) ? "posted" : "posted-partial";
}

// THE THIRD WAY A TURN CAN END WITH NOTHING, and the one the two bits above cannot see: not a
// delivery that failed, but a completion that came back empty while nobody chose that (issue #773).
//
// The model called a tool — `set_labels`, typically — and then produced no final text. Downstream
// this is indistinguishable from the legitimate silence `skip_reply` exists to declare, so the
// deferred resolve closes the conversation as handled and the operator sees a case the agent dealt
// with. Measured on 115 replayed conversations: 6 turns produced nothing, 3 of them correctly
// (through `skip_reply`) and 3 by this accident, one of them on a customer who had written in to
// say no e-mail had arrived.
//
// WHY IT IS ONE QUESTION AND NOT A CONDITION AT THE CALL SITE: the same bit decides two different
// things — whether the deferred resolve may act, and whether the turn owes the operator a warning —
// and the second one applies even when there is no resolve intent at all, which is the exit where
// the conversation stays `pending` with no owner and a label that says the opposite of what
// happened. Asking it twice at one site is how the three sites above drifted apart (issue #429).
//
// NOT A THIRD BIT ON `DeliveryOutcome`: the other two sites carry a reply, so the customer heard
// something by construction and the answer there is always `false`. A field they must fill in to say
// "not applicable" is a field that will be filled in wrong.
export interface SilentTurn {
  // Something reached the customer this turn — an attachment, on the branch that has no text.
  delivered: boolean;
  // A handoff completed, so a person owns the conversation and the silence is explained.
  handedOff: boolean;
  // The model called `skip_reply` this turn: the silence is a decision, not an accident. Read from
  // the tool's own mark (`silenceWasChosen`), never from the tool's name.
  silenceChosen: boolean;
}

export function silenceIsUnexplained(t: SilentTurn): boolean {
  return !t.delivered && !t.handedOff && !t.silenceChosen;
}
