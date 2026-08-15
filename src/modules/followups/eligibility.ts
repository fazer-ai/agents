import { isTestSilenced } from "@/modules/agents/test-mode";
import { shouldBotHandle } from "@/modules/chatwoot/normalize";

// Whether a follow-up for this conversation is still live, meaning: if `followUpHandler` claimed its
// job right now, would it send, or would it drop the job?
//
// The handler re-reads all of this at claim time and returns `done` (dropping the job silently) on
// any of it, because a job can outlive the state it was armed under: a multi-step sequence leaves a
// PENDING row whose runAt is hours or days out (`handlers.ts` reschedules the SAME row after each
// step), and nothing cancels it when a human takes the conversation, when the agent is disabled, or
// when follow-up is switched off. Only /teste, /reset and a new inbound message cancel it.
//
// It lives here as one predicate because it has two readers that MUST agree. The handler acts on it;
// the console's follow-up indicator reads it to decide whether to promise a countdown. Issue #72 was
// the second reader not having it: the indicator trusted the pending row and counted down for a
// follow-up the handler was going to drop, telling the operator the customer would be re-engaged when
// nobody was.
//
// NOT included, on purpose: whether the episode is fresh, the activation fence, and the cadence.
// Those decide WHICH step is next rather than whether the sequence is alive at all, and they differ
// between an armed job (a later step legitimately has `lastFollowUpAt` set) and an estimate.
export interface FollowUpLiveness {
  // Agent.enabled — a disabled agent sends nothing.
  agentEnabled: boolean;
  // followUp.enabled from the agent's settings.
  followUpEnabled: boolean;
  // This conversation's inbox is the entry or widget side of a channelRedirect, which owns
  // re-engagement itself; the generic follow-up stays out of it.
  managedByRedirect: boolean;
  // Agent.mode + Conversation.testActivatedAt: a test agent is silent until /teste.
  agentMode: string;
  testActivatedAt: Date | null;
  // The bot only follows up while it still owns the conversation (pending, no human assignee).
  status: string | null;
  assigneeType: string | null;
}

export function isFollowUpLive(s: FollowUpLiveness): boolean {
  return (
    s.agentEnabled &&
    s.followUpEnabled &&
    !s.managedByRedirect &&
    !isTestSilenced(s.agentMode, s.testActivatedAt) &&
    shouldBotHandle({ status: s.status, assigneeType: s.assigneeType })
  );
}
