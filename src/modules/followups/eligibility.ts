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
// The readers agree on the RULES and differ on the EVIDENCE, which is why `mirrorHolder` is an input
// and not a second predicate (issue #214). The handler has a live probe behind it and says
// "not-asked" because deciding ownership from the mirror there would drop real follow-ups; the
// indicator has nothing behind it, so it answers with the bot id in hand and gets the strict answer.
// Same function, same rules, and each reader states what it actually knows.
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
  // Who the mirror says is HOLDING the conversation — the ownership axis attribution alone cannot
  // answer, because one Chatwoot account can front several Agent Bots and every one of them reads as
  // "a bot has it". Required rather than optional: the two readers answer it from different evidence
  // (below), and a field a reader can omit is a divergence nobody has to notice.
  //
  //   "ours"       — nobody else is holding it: unassigned, or verifiably this inbox's own bot.
  //   "not-ours"   — somebody else is holding it, OR the mirror names a bot it cannot identify.
  //                  Unverifiable is not ours: with no id to compare, a conversation owned by
  //                  ANOTHER bot reads as ours, which is the same call `parseLiveConversation` makes
  //                  when it refuses an "AgentBot" with no numeric id on the live payload.
  //   "not-asked"  — this reader does not decide ownership from the mirror at all. It reads as LIVE,
  //                  so it is sound ONLY for a reader that re-asks Chatwoot before it sends: the
  //                  assignee is the field the mirror is most often stale on (`syncConversationState`
  //                  repairs it from the live snapshot), and refusing on a stale value drops a
  //                  follow-up the customer should have received.
  mirrorHolder: MirrorHolder;
}

export type MirrorHolder = "ours" | "not-ours" | "not-asked";

export function isFollowUpLive(s: FollowUpLiveness): boolean {
  return (
    s.agentEnabled &&
    s.followUpEnabled &&
    !s.managedByRedirect &&
    !isTestSilenced(s.agentMode, s.testActivatedAt) &&
    s.mirrorHolder !== "not-ours" &&
    shouldBotHandle({ status: s.status, assigneeType: s.assigneeType })
  );
}
