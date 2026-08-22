import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { ResolutionOrigin } from "@/modules/conversations/resolution-origin";

// Records who closed a conversation, on the four paths where WE close one. The dashboard reads this
// instead of inferring the origin from status + assignee; the reasoning is in resolution-origin.ts.
//
// ## What the column can honestly mean
//
// Not "we provably caused the transition". Chatwoot's `toggle_status` answers `{success, conversation_id,
// current_status, snoozed_until}` — `success` is `save!`'s return, so it is true whether or not
// anything changed, and nothing in the payload reports a transition. Our mirror cannot substitute for
// it either: it trails the webhook.
//
// So the column means exactly this, and the three rules below are that sentence and nothing more:
//
//   **the first closing WE asked for in this resolved episode, issued while the conversation was, as
//   far as we could tell, still open.**
//
//   1. Written only after a successful `toggleStatus`. A stamp written ahead of the call would
//      survive a toggle that threw, and the next person to resolve that conversation — possibly an
//      operator, months later — would be credited to the agent.
//   2. Only when the caller OBSERVED a non-resolved conversation before deciding to close it
//      (`observedStatus`). Resolving a resolved conversation is a no-op in Chatwoot, so a close that
//      had already happened is not ours: an operator, an automation rule or `auto_resolve_after`
//      landing before our toggle deliberately leaves the origin NULL, and stamping over it would
//      credit the agent for someone else's close. It is the caller's observation and not a re-read
//      of the row here, because by then the row may already carry OUR OWN close: the mirror can
//      reflect a toggle before the turn ends (zero lag is the worst case this codebase already
//      defends against, see `mirrorOnToggle` in tests/graph/runtime.test.ts), and a re-read cannot
//      tell that apart from somebody else's. Each caller passes the freshest thing it has, which on
//      the follow-up path is a live GET.
//   3. Only when the episode has no origin yet. The same no-op reasoning within our own paths: a
//      follow-up ladder resolving after the agent already called `resolve_conversation`, the redirect
//      closing a sibling the agent already closed, an operator re-resolving through REST or MCP.
//
// What makes NULL mean "this episode has no recorded cause yet" is the clear: every writer of
// `status` drops the stamp when the conversation LEAVES "resolved", so a reopen-then-close records
// the new cause normally.
//
// Both predicates are evaluated by the database in the same statement, not read-then-written, so two
// closings landing at once cannot both pass them.
//
// ## Where it is still approximate, and in which direction
//
// Rule 2 is only as fresh as the caller's observation. An external close landing between that
// observation and our toggle is invisible, and there our toggle no-ops while the stamp still lands.
// The follow-up path narrows that to milliseconds (`probeLiveOwnership` does a live GET and
// `shouldBotHandle` requires `pending` immediately before the close); the reactive path is bounded
// by its own ownership recheck. The residual is not closable from here: it would take a transition
// flag Chatwoot does not return.
//
// The reverse error would be worse. Every rule above fails toward NOT counting a resolution, which
// is the safe direction for a metric whose whole point is that it stopped over-counting.
//
// Best-effort, never throws. The status change is already live in Chatwoot and the callers are all
// on paths where a message has gone out, so raising here would fail a job whose retry would
// double-post. A missing stamp costs one uncounted resolution; a thrown error costs a duplicate
// customer message.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

/** Either our own row id, or the Chatwoot coordinates every caller can produce. */
export type ConversationRef =
  | { id: bigint }
  | { chatwootInstanceId: bigint; chatwootConversationId: number };

export async function recordResolutionOrigin(params: {
  tenantId: bigint;
  conversation: ConversationRef;
  origin: ResolutionOrigin;
  /**
   * The conversation's status as the caller saw it when it decided to close — the mirror's value,
   * or the live one where the path already reads it. Required, not optional: it is the whole of
   * rule 2, and a default would let a new call site silently claim closes it did not cause.
   */
  observedStatus: string | null;
  base?: PrismaClient;
}): Promise<void> {
  const { tenantId, conversation, origin, observedStatus } = params;
  const base = params.base ?? basePrisma;
  if (observedStatus === "resolved") return;
  try {
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      // updateMany, not update: a conversation deleted (or never mirrored) between the toggle and
      // this write is a no-op, not a throw.
      db.conversation.updateMany({
        where: {
          ...("id" in conversation ? { id: conversation.id } : conversation),
          resolvedBy: null,
        },
        data: { resolvedBy: origin },
      }),
    );
  } catch (err) {
    logger.warn(
      {
        err,
        origin,
        conversation: JSON.stringify(conversation, bigintToString),
      },
      "recordResolutionOrigin failed",
    );
  }
}

function bigintToString(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? String(v) : v;
}
