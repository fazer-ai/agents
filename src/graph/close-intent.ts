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
