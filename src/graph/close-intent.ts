// Whether a turn may act on a deferred `resolve_conversation`: one pure decision, because each shape a
// turn can take (a reply, attachments and a reply, attachments alone) must answer it the same way. An
// attendance the customer did not fully receive is not finished and does not close: `resolved` tells
// an operator nothing is left to do, and the model asked to close believing it had answered, while
// only the delivery knows. A send that fails mid-reply reports rather than throws, so the deferred
// intent survives and this check is what stops it. Separate from "was the turn posted?": a partial
// delivery still counts as posted, since re-running the turn would send the delivered part twice.
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

// The second consequence of the same two bits, derived from the first so the two cannot drift: a
// partial delivery is also not the outcome that clears the operator's error badge. `shouldPost`
// claims the burst with a monotonic CAS right before the first balloon, so nothing re-answers a
// partial delivery; reported as plain "posted" it would clear `lastError` and leave a customer holding
// half an answer under a badge saying the last turn went fine.
export type PostedOutcome = "posted" | "posted-partial";

export function postedOutcomeFor(o: DeliveryOutcome): PostedOutcome {
  return mayCloseConversation(o) ? "posted" : "posted-partial";
}

// The third way a turn ends with nothing, which the two bits above cannot see: a completion that came
// back empty while nobody chose silence (typically after a tool call such as `set_labels`). Downstream
// it looks like the silence `skip_reply` declares, so the deferred resolve would close it as handled.
// One predicate, not a condition per call site, because it decides two things: whether the deferred
// resolve may act, and whether the turn owes the operator a warning, which applies even with no
// resolve intent. Not a third bit on `DeliveryOutcome`: the other sites carry a reply, so a "not
// applicable" field there would be filled in wrong.
export interface SilentTurn {
  // Something reached the customer this turn: an attachment, on the branch that has no text.
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
