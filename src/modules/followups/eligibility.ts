import { isMonitoring } from "@/modules/agents/mode";
import { isTestSilenced } from "@/modules/agents/test-mode";
import { shouldBotHandle } from "@/modules/chatwoot/normalize";

// Whether a follow-up for this conversation is still live: if `followUpHandler` claimed its job now,
// would it send or drop it? A job can outlive the state it was armed under (the SAME row is
// rescheduled step after step), so the handler re-checks at claim time, and the console's indicator
// must agree before promising a countdown. Same rules, different EVIDENCE: hence `mirrorHolder`.
// Freshness, the activation fence and cadence are left out: they decide WHICH step, not liveness.
export interface FollowUpLiveness {
  // Agent.enabled — a disabled agent sends nothing.
  agentEnabled: boolean;
  // followUp.enabled from the agent's settings.
  followUpEnabled: boolean;
  // This conversation's inbox is the entry or widget side of a channelRedirect, which owns
  // re-engagement itself; the generic follow-up stays out of it.
  managedByRedirect: boolean;
  // Agent.mode + Conversation.testActivatedAt: a test agent is silent until /teste, and a
  // monitoring agent never speaks (an explicit arm: nothing else here excludes a third mode).
  agentMode: string;
  testActivatedAt: Date | null;
  // The bot only follows up while it still owns the conversation (pending, no human assignee).
  status: string | null;
  assigneeType: string | null;
  // Who the mirror says is HOLDING the conversation (one account can front several Agent Bots).
  // Required, so no reader omits it. "ours": unassigned or verifiably this inbox's bot. "not-ours":
  // someone else, or a bot it cannot identify. "not-asked": reads as LIVE, sound ONLY for a reader
  // that re-asks Chatwoot before sending, since the mirror's assignee is often stale.
  mirrorHolder: MirrorHolder;
  // Whether anybody on our side has ever spoken here (`ourSideHasSpoken` below). A `skip_reply`
  // leaves the conversation pending and bot-owned, and its correct silence must not become a
  // follow-up.
  ourSideHasSpoken: boolean;
}

export type MirrorHolder = "ours" | "not-ours" | "not-asked";

// Whether our side has spoken, from three marks on the conversation row; every reader calls THIS.
// The agent's reply claim; `chatwootFirstReplyAt`, which an AgentBot never sets, so a PERSON spoke;
// and `lastProactiveAt`, stamped once a nudge reached the customer. A false "no" costs a follow-up,
// never a wrong message: a reply from before the claim column existed stays unseen until healed.
export function ourSideHasSpoken(c: {
  lastRepliedMessageId: number | null;
  chatwootFirstReplyAt: Date | null;
  lastProactiveAt: Date | null;
}): boolean {
  return (
    c.lastRepliedMessageId !== null ||
    c.chatwootFirstReplyAt !== null ||
    // NOTE: Loose on purpose: a reader that forgot to select the column hands `undefined`, and that must
    // read as "not spoken", never as the opposite.
    c.lastProactiveAt != null
  );
}

export function isFollowUpLive(s: FollowUpLiveness): boolean {
  return (
    s.agentEnabled &&
    s.followUpEnabled &&
    !s.managedByRedirect &&
    !isMonitoring(s.agentMode) &&
    !isTestSilenced(s.agentMode, s.testActivatedAt) &&
    s.mirrorHolder !== "not-ours" &&
    s.ourSideHasSpoken &&
    shouldBotHandle({ status: s.status, assigneeType: s.assigneeType })
  );
}
