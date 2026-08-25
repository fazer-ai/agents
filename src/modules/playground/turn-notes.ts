import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import type { TraceGuardrail } from "@/graph/trace";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// What the OPERATOR saw for one playground turn, when that differs from what the agent remembers.
//
// The playground rebuilds its transcript from the checkpointer, which works only while the two are
// the same thing. Moderation is the first feature where they legitimately differ, and production
// already treats them as two stores: an output trip posts the template to Chatwoot and leaves the
// model's own words in the graph thread, and an input trip never lets the message reach the thread
// at all. Copying the screened text into the checkpointer would make the playground diverge from
// the production it exists to reproduce, so the transcript gets its own row instead (issue #136).
//
// Written for every turn the guardrail RAN on, the clean verdicts included, because the toggle is
// per turn and a reload with no clean mark cannot tell an approved reply from an unscreened one.
// Turns it never ran on still come from the checkpointer alone, and a note that fails to write
// costs the reload its annotation, never the turn.

// NOTE: There is deliberately no per-tenant cap here, unlike the media store. Bytes are what the
// media cap exists to bound, and a screened session writes one short row per turn, bounded by an
// operator typing turns by hand. Pruning one while its session is still reloadable would silently
// put the transcript back to the raw reply the guardrail removed, which is the failure the row
// exists to prevent. The note's life is the session's, and so is the checkpointer thread's:
// `deletePlaygroundSession` deletes all three.

export interface PlaygroundTurnNote {
  // The AIMessage this overrides, or null for a turn the thread has no record of. Set but no longer
  // rendered when the agent's reply was empty, which the fold treats as a placement, not a loss.
  messageId: string | null;
  // Where a thread-less turn belongs: the last message the transcript SHOWED at the time, which is
  // not always the last message in the thread. Null = the thread was empty, so it goes first.
  anchorMessageId: string | null;
  // This turn's human message, minted for every turn. The media saved for a blocked turn joins back
  // on it, and an annotation whose reply the rebuild dropped is placed after it.
  userMessageId: string | null;
  userText: string | null;
  reply: string;
  guardrails: TraceGuardrail[];
}

export async function savePlaygroundTurnNote(
  base: PrismaClient,
  params: PlaygroundTurnNote & {
    ctx: TenantContext;
    agentId: bigint;
    threadId: string;
  },
): Promise<void> {
  try {
    await runScopedOn(base, params.ctx, async (db) => {
      await db.playgroundTurnNote.create({
        data: {
          tenantId: params.ctx.tenantId as bigint,
          agentId: params.agentId,
          threadId: params.threadId,
          messageId: params.messageId,
          anchorMessageId: params.anchorMessageId,
          userMessageId: params.userMessageId,
          userText: params.userText,
          reply: params.reply,
          guardrails: params.guardrails as never,
        },
        select: { id: true },
      });
    });
  } catch (e) {
    logger.warn(
      "playground: turn note not saved: %s",
      e instanceof Error ? e.message : String(e),
    );
  }
}

export interface LoadedTurnNote extends PlaygroundTurnNote {
  createdAt: Date;
}

export async function listThreadTurnNotes(
  base: PrismaClient,
  ctx: TenantContext,
  threadId: string,
): Promise<LoadedTurnNote[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.playgroundTurnNote.findMany({
      where: { threadId },
      orderBy: { id: "asc" },
      select: {
        messageId: true,
        anchorMessageId: true,
        userMessageId: true,
        userText: true,
        reply: true,
        guardrails: true,
        createdAt: true,
      },
    }),
  );
  return rows.map((r) => ({
    messageId: r.messageId,
    anchorMessageId: r.anchorMessageId,
    userMessageId: r.userMessageId,
    userText: r.userText,
    reply: r.reply,
    guardrails: Array.isArray(r.guardrails)
      ? (r.guardrails as unknown as TraceGuardrail[])
      : [],
    createdAt: r.createdAt,
  }));
}
