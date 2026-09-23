import logger from "@/api/lib/logger";
import type { GateCloseDetail } from "@/modules/chatwoot/gate-close";

// A PERSON TAKING THE CONVERSATION OVER MID-TURN (issue #717). The turn's own gates ask ownership
// BEFORE the invoke (#711) and AFTER it (the post-generation recheck that suppresses the send), and
// between the two the model runs and so does every tool it chooses: a label, a handoff to a pinned
// agent, a kanban card, an outgoing HTTP call, all written over the person who is now answering.
//
// So the question rides the fence the graph already asks at the tool boundary (./graph.ts, the
// `/reset` one from #449), which is the one place every tool source passes through, and which
// refuses the pending calls and ENDS the turn without leaving an unanswered `tool_calls` behind.
//
// Three rules shape it:
//
//   - asked only when the conversation was the bot's when the turn started. What it detects is the
//     conversation CHANGING hands during the turn; a turn that started on a conversation that was
//     not the bot's (a follow-up that may only note) keeps doing what it did;
//   - not asked once THIS turn changed the owner itself (its own transfer, or the follow-up's
//     immediate close): the calls after it in the same answer (a label after the handoff) are the
//     turn's intent, not a write over somebody;
//   - a read that fails lets the calls run, the rule #711's gate keeps for the same reason: an
//     unreadable row is not evidence that anybody took the conversation, and the post-generation
//     recheck still holds the send.
//
// The cost is one local Postgres read per tool-calling hop, and only on a turn that calls tools.
//
// It also REMEMBERS the verdict that refused, from the read that refused, because the caller reads
// the refusal off the result (`turnWasCalledOff`) and cannot ask the fence again to learn why: a turn
// withdrawn by `/reset` is "stale", one that a person took over is "taken-over", and the two settle
// the customer's message differently. A second read would answer about another moment, and could
// fail or find the conversation back with the bot (review round 2).
export type OwnershipVerdict =
  | { ours: true }
  | { ours: false; closed: GateCloseDetail | null };

export interface OwnershipFence {
  ask: () => Promise<boolean>;
  // The refusing read's verdict, or null when the owner never refused.
  lost: () => { closed: GateCloseDetail | null } | null;
}

export function withOwnershipFence(
  fence: () => Promise<boolean>,
  opts: {
    ownedAtStart: boolean;
    ownerChangedByThisTurn: () => boolean;
    ownsNow: () => Promise<OwnershipVerdict>;
    conversationId: number;
  },
): OwnershipFence {
  let lost: { closed: GateCloseDetail | null } | null = null;
  return {
    lost: () => lost,
    ask: async () => {
      if (!(await fence())) return false;
      if (!opts.ownedAtStart || opts.ownerChangedByThisTurn()) return true;
      const verdict = await opts.ownsNow().catch((err: unknown) => {
        logger.warn(
          { err, conv: opts.conversationId },
          "turn: ownership at the tool boundary could not be read; letting the tool calls run",
        );
        return { ours: true } as const;
      });
      if (verdict.ours) return true;
      // ASKED AGAIN AFTER THE READ: calls of one batch run concurrently, so a label's own ask can
      // start before the handoff beside it completed and read the `open` that handoff wrote. That is
      // still the turn's own transfer (review round 2).
      if (opts.ownerChangedByThisTurn()) return true;
      lost ??= { closed: verdict.closed };
      logger.info(
        "turn: conversation %s changed hands mid-turn, so its remaining tool calls are refused",
        String(opts.conversationId),
      );
      return false;
    },
  };
}
