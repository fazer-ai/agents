import type { HumanReplyRoute } from "./normalize";

// Why an ownership gate closed, in the one vocabulary every closing gate answers in. The webhook,
// the debounce flush and the runtime's post-LLM recheck all ask `shouldBotHandle`, and two
// different events share that exit. A human assignee is a real handoff; anything else means the
// gate closed with nobody on the other side (a conversation that left `pending` was escalated or
// resolved, one still `pending` is held by another party's bot). The status rides along instead of
// being re-read where the line is written, because a second query answers about another moment.
export type GateCloseDetail =
  | { outcome: "taken_over" }
  | { outcome: "ownership_lost"; status: string };

// The same word for the moment a person takes over by answering the customer. That transition
// assigns nobody (no Chatwoot `User` behind a reply typed on the paired phone), so the next gate
// would read `ownership_lost`, true about the status and wrong about the cause. `via` tells the
// reader whether to look in the CRM or at somebody's phone. Spelled here and nowhere else, like the
// rest of this vocabulary; a test walks `src` to hold that.
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
