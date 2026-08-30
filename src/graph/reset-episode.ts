import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// WHAT CALLS OFF A TURN NOTHING QUEUED.
//
// Every other caller of `runLoadedTurn` runs from a scheduler job, so `/reset` retires the job and
// the turn asks whether it is still wanted at four points on its way through. The DIRECT webhook
// turn has no job: the delivery IS the trigger, so there was nothing to retire and nothing to ask,
// and it passed `stillWanted: null`.
//
// MEASURED (issue #428), against the test database with the command landing in the delivery path's
// own client build: the operator types /reset, the acknowledgement says the conversation was
// cleared, and the turn that was already running then calls `set_custom_attribute` and writes
// `qualificado` back onto the conversation the operator was just told was clean. The REPLY is
// stopped — the /reset message is itself an incoming message, so its own delivery advances the
// handled watermark past this turn's trigger and the supersede gate refuses the post — but a tool
// call is not a post, and nothing between the model and Chatwoot asks the question at all.
//
// So the fact the run is named by is the EPISODE: `Conversation.resetAt`, stamped by the command's
// first write. A turn carries the value its config load read and asks whether the conversation is
// still in it.
//
// BY VALUE, never as an ordering. "Changed since I started" needs no clock agreement between two
// replicas and no monotonicity from the column: the run captured one reading and compares it with
// another. A NULL on both sides is a conversation nothing has ever reset, which is the ordinary case
// and the one that must never trip.
export function sameEpisode(startedAt: Date | null, now: Date | null): boolean {
  if (startedAt === null || now === null) return startedAt === now;
  return startedAt.getTime() === now.getTime();
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface EpisodeFenceParams {
  tenantId: bigint;
  conversationDbId: bigint;
  // What the turn's own config load read. `null` is a conversation no reset has ever cleared, and
  // it is a value like any other: the fence trips when the command stamps the first one.
  startedAt: Date | null;
  base: PrismaClient;
}

// The `stillWanted` a direct turn hands to `runLoadedTurn`.
//
// `strict` is the contract that module states: inside the critical section, before anything is
// written, an unreadable answer must STOP the run, because guessing "still wanted" there recreates
// the thread /reset just cleared and no later fence catches it; at a send, an unreadable answer lets
// the run continue and be fenced by the CAS at the end, because throwing would abandon the
// bookkeeping of a message already delivered.
//
// A conversation row that is GONE is not a reset and never answers `false`. The two are different
// unknowns and only one of them is this fence's question — the same rule `jobNotRetiredSql` writes
// for an absent job row, that an unknown is not a retirement.
export function stillInSameEpisode(
  p: EpisodeFenceParams,
): (opts: { strict: boolean }) => Promise<boolean> {
  return async ({ strict }) => {
    try {
      const row = await runScopedOn(p.base, sysCtx(p.tenantId), (db) =>
        db.conversation.findUnique({
          where: { id: p.conversationDbId },
          select: { resetAt: true },
        }),
      );
      if (!row) return true;
      return sameEpisode(p.startedAt, row.resetAt);
    } catch (err) {
      logger.warn(
        { err, conversation: String(p.conversationDbId) },
        strict
          ? "could not read the episode mark before writing; standing the turn down"
          : "could not read the episode mark; letting the turn reach its own fence",
      );
      return !strict;
    }
  };
}
