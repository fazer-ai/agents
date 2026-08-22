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
// Only turns the guardrail touched get one. Everything else still comes from the checkpointer, and
// a note that fails to write costs the reload its annotation, never the turn.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// The playground is a test surface, not an archive; the same reasoning as the media cap.
const NOTE_RETENTION_PER_TENANT = 500;

export interface PlaygroundTurnNote {
  // The AIMessage this overrides, or null for a turn the thread has no record of.
  messageId: string | null;
  // Where a thread-less turn belongs: the last message id at the time. Null = the thread was empty.
  anchorMessageId: string | null;
  userText: string | null;
  reply: string;
  guardrails: TraceGuardrail[];
}

export async function savePlaygroundTurnNote(
  base: PrismaClient,
  params: PlaygroundTurnNote & {
    tenantId: bigint;
    agentId: bigint;
    threadId: string;
  },
): Promise<void> {
  try {
    await runScopedOn(base, sysCtx(params.tenantId), async (db) => {
      await db.playgroundTurnNote.create({
        data: {
          tenantId: params.tenantId,
          agentId: params.agentId,
          threadId: params.threadId,
          messageId: params.messageId,
          anchorMessageId: params.anchorMessageId,
          userText: params.userText,
          reply: params.reply,
          guardrails: params.guardrails as never,
        },
        select: { id: true },
      });
      const cutoff = await db.playgroundTurnNote.findMany({
        orderBy: { id: "desc" },
        skip: NOTE_RETENTION_PER_TENANT,
        take: 1,
        select: { id: true },
      });
      const floor = cutoff[0]?.id;
      if (floor !== undefined) {
        await db.playgroundTurnNote.deleteMany({
          where: { id: { lte: floor } },
        });
      }
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
  tenantId: bigint,
  threadId: string,
): Promise<LoadedTurnNote[]> {
  const rows = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.playgroundTurnNote.findMany({
      where: { threadId },
      orderBy: { id: "asc" },
      select: {
        messageId: true,
        anchorMessageId: true,
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
    userText: r.userText,
    reply: r.reply,
    guardrails: Array.isArray(r.guardrails)
      ? (r.guardrails as unknown as TraceGuardrail[])
      : [],
    createdAt: r.createdAt,
  }));
}
