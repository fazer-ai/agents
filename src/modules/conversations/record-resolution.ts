import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { parseLiveConversation } from "@/modules/chatwoot/normalize";
import type { ResolutionOrigin } from "@/modules/conversations/resolution-origin";

// Records who closed a conversation, on the paths where WE close one (the clearing rule is in
// resolution-origin.ts, the model in docs/chatwoot.md). The stamp is the first close WE asked for in
// this resolved episode, issued while the conversation looked open: written only after a successful
// `toggleStatus`, only when the caller OBSERVED it non-resolved, and only when the episode has no
// origin yet, in one statement. The caller's observation, never a re-read or a guard on the row having
// moved: the mirror can apply our own close before this runs (`mirrorOnToggle` in
// tests/graph/runtime.test.ts). Every rule fails toward not counting. Best-effort, never throws: the
// close is already live in Chatwoot and a retried job would double-post.

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
 * The conversation as it stands right before we close it, read live. The turn's own snapshot predates
 * long work (a model call, or moderation, TTS and paced delivery), and a close by someone else
 * meanwhile makes our toggle a silent no-op that the stale value would credit to the agent. A failed
 * read falls back to `snapshot`: stale, but better than recording no close whenever a GET blips.
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
