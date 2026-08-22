import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { parseLiveConversation } from "@/modules/chatwoot/normalize";
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
//      (`observed`). Resolving a resolved conversation is a no-op in Chatwoot, so a close that
//      had already happened is not ours: an operator, an automation rule or `auto_resolve_after`
//      landing before our toggle deliberately leaves the origin NULL, and stamping over it would
//      credit the agent for someone else's close. It is the caller's observation and not a re-read
//      of the row here, because by then the row may already carry OUR OWN close: the mirror can
//      reflect a toggle before the turn ends (zero lag is the worst case this codebase already
//      defends against, see `mirrorOnToggle` in tests/graph/runtime.test.ts), and a re-read cannot
//      tell that apart from somebody else's. Each caller passes the freshest thing it has, and the
//      two paths that close during a model call read it live right before the toggle: the follow-up
//      ladder through its ownership probe, and `resolve_conversation`'s immediate branch on its own,
//      because a nudge's snapshot was taken a whole generation earlier.
//   3. Only when the episode has no origin yet. The same no-op reasoning within our own paths: a
//      follow-up ladder resolving after the agent already called `resolve_conversation`, the redirect
//      closing a sibling the agent already closed, an operator re-resolving through REST or MCP.
//
// What makes NULL mean "this episode has no recorded cause yet" is the clear, and that is a rule of
// its own: `clearsResolutionOrigin` in resolution-origin.ts, asked by every writer of `status`. It
// drops the stamp on three things — the conversation leaving "resolved", a close of ours losing the
// ordering, and a brand-new incoming message reopening the episode — so a reopen-then-close records
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
// The one place it fails the OTHER way is the window between `toggleStatus` returning and the UPDATE
// below: if both our resolve event and a newer inbound that reopens are mirrored inside it, the row
// is non-resolved with no origin, this write stamps it anyway, and the resolve event that would have
// been the clear is already spent. A later external close then reads as the agent's. It is not
// closable from here and it is not worth what closing it would cost: the window is one connection
// acquire and a commit, and it needs two Chatwoot webhooks dispatched and processed inside it.
//
// Refusing to stamp when the row has moved past what the caller observed is the obvious guard and it
// is wrong, measurably: it also refuses our OWN close whenever the mirror is fast, which is the
// worst case `mirrorOnToggle` in tests/graph/runtime.test.ts exists to hold us to. That stub
// advances `chatwoot_status_at` with the status precisely so the guard cannot come back quietly.
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

/**
 * The conversation as the caller saw it when it decided to close, both halves of one observation.
 * Required, not optional: `status` is the whole of rule 2, `statusAt` is the whole of the floor, and
 * a default on either would let a new call site silently claim closes it did not cause.
 */
export interface ObservedConversation {
  /** The status the caller read: the mirror's value, or the live one where the path reads it. */
  status: string | null;
  /** That reading's version (`conversation.updated_at.to_f`), null when the source carries none. */
  statusAt: number | null;
}

/**
 * The conversation as it stands right before we close it, read live.
 *
 * Both paths that close during a turn need this and for the same reason: the turn's own snapshot was
 * taken before work that can run for a long time (a model call on the nudge path, moderation plus
 * TTS plus typing-paced delivery on the reactive one). An operator, an automation rule or a timer
 * closing meanwhile makes our toggle a silent no-op in Chatwoot, and the stale non-resolved value
 * would credit the agent for their close. After the toggle it is too late: the conversation reads
 * "resolved" either way and the two are indistinguishable.
 *
 * A failed read falls back to `snapshot`, which is what both paths used to do unconditionally:
 * stale, but strictly better than refusing to record every close whenever a GET blips.
 */
export async function observeBeforeClose(
  client: Pick<ChatwootClient, "getConversation">,
  conversationId: number,
  snapshot: ObservedConversation,
): Promise<ObservedConversation> {
  try {
    const live = parseLiveConversation(
      await client.getConversation(conversationId),
    );
    if (live) return { status: live.status, statusAt: live.updatedAt };
  } catch (err) {
    logger.warn(
      { err, conversationId },
      "observeBeforeClose: live read failed, using the caller's snapshot",
    );
  }
  return snapshot;
}

export async function recordResolutionOrigin(params: {
  tenantId: bigint;
  conversation: ConversationRef;
  origin: ResolutionOrigin;
  observed: ObservedConversation;
  base?: PrismaClient;
}): Promise<void> {
  const { tenantId, conversation, origin, observed } = params;
  const base = params.base ?? basePrisma;
  if (observed.status === "resolved") return;
  try {
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      // NOTE: updateMany, not update: a conversation deleted (or never mirrored) between the toggle and
      // this write is a no-op, not a throw. Both predicates are evaluated by the database in the
      // same statement, so two closings landing at once cannot both pass them.
      db.conversation.updateMany({
        where: {
          ...("id" in conversation ? { id: conversation.id } : conversation),
          resolvedBy: null,
        },
        // NOTE: The floor is the version the CALLER observed, never the row's own at write time. Between
        // the toggle returning and this statement the row can already carry a newer reopen, and
        // copying that would record a floor describing the wrong episode: our own delayed resolve
        // event would then be judged to predate the stamp and could no longer clear it.
        data: { resolvedBy: origin, resolvedByAt: observed.statusAt },
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
