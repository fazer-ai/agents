import logger from "@/api/lib/logger";
import type { GateCloseDetail } from "@/modules/chatwoot/gate-close";

// A person taking the conversation over mid-turn: asked at the graph's tool boundary, the one seam
// every tool source passes through. Only when the bot owned the conversation at turn start, never
// once this turn changed the owner itself, and an unreadable row lets the calls run (it is not
// evidence of a takeover; the post-generation recheck still holds the send). It remembers the
// refusing read's verdict because the caller cannot ask again: a second read answers about another
// moment. Rules in docs/graph.md, "The tool boundary, when the turn was called off".
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
      // NOTE: asked again after the read: calls of one batch run concurrently, so a label's ask can
      // read the `open` a sibling handoff just wrote, which is still the turn's own transfer.
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
