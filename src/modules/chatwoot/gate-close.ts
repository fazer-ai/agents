import type { HumanReplyRoute } from "./normalize";

// Why an ownership gate closed, in the one vocabulary every gate that closes has to answer in.
//
// Three gates ask `shouldBotHandle` before a customer message can be answered — the webhook on each
// event, the debounce flush before the turn, and the runtime's recheck before posting — and TWO
// different events wear that single exit. Calling both "taken_over" is what sent an incident
// investigation to the wrong half of the system (issue #225), so the runtime's recheck learned to
// separate them; the two gates that run earlier had not, and the one that matters most reaches them
// rather than the recheck (issue #271): Chatwoot escalates `pending` to `open` seconds after a slow
// ack, so the flush that fires after it finds the gate already closed and no turn ever starts.
//
// A human assignee is a real handoff and the silence is correct. Anything else means the gate closed
// with nobody on the other side, and the status is what says which: a conversation that left
// `pending` was escalated or resolved, while one still `pending` is held by another party's bot.
// That is why the status rides along instead of being re-read where the line is written — a second
// query would answer about a different moment.
export type GateCloseDetail =
  | { outcome: "taken_over" }
  | { outcome: "ownership_lost"; status: string };

// THE SAME WORD, for the moment the takeover happens rather than for the message that finds the gate
// already shut (issue #430). A person answering the customer is a real handoff, so the outcome is the
// one `describeClosedGate` gives a human assignee — but this transition assigns nobody (there is no
// Chatwoot `User` behind a reply typed on the paired phone), so the gate on the NEXT customer message
// reads the conversation as merely no longer ours and says `ownership_lost`. True about the status,
// wrong about the cause, which is the confusion issue #225 was about. `via` is what a reader needs
// next: whether to look in the CRM or at somebody's phone.
//
// Spelled HERE and nowhere else, like everything else in this vocabulary, and a test walks `src` to
// hold that.
export type HumanTakeoverDetail = {
  outcome: "taken_over";
  via: HumanReplyRoute;
};

export function describeHumanTakeover(
  via: HumanReplyRoute,
): HumanTakeoverDetail {
  return { outcome: "taken_over", via };
}

export function describeClosedGate(observed: {
  assigneeType: string | null;
  status: string | null;
}): GateCloseDetail {
  if (observed.assigneeType === "User") return { outcome: "taken_over" };
  return {
    outcome: "ownership_lost",
    status: observed.status ?? "unknown",
  };
}
