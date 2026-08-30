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
// So the fact the run is named by is the EPISODE, and the question is asked about the DELIVERY
// rather than about anything the turn read: did the command land after this message arrived?
//
// `Conversation.resetAt` is stamped by the command's first write with `now()`, and
// `ChatwootWebhookDelivery.receivedAt` is written by the same Postgres as a column default when the
// receiver first records the delivery — one clock, and the earliest moment that exists for this
// message. Anything read later (the mirror, the gates, the turn's own config load) is a moment the
// command can already have overtaken, and a baseline captured there is the operator's own write
// being compared with itself. Measured, twice, by review rounds on #447.
//
// The tie goes to STANDING DOWN: a mark stamped in the same millisecond the delivery arrived is a
// coincidence nobody can order, and refusing one message is the cheaper half of it.
export function resetLandedAfter(
  deliveredAt: Date | null,
  resetAt: Date | null,
): boolean {
  if (resetAt === null) return false;
  // No arrival time is not evidence of a reset: it is a caller that never named one (the playground,
  // a test), and the fence has nothing to order.
  if (deliveredAt === null) return false;
  return resetAt.getTime() >= deliveredAt.getTime();
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface EpisodeFenceParams {
  tenantId: bigint;
  conversationDbId: bigint;
  // When the DELIVERY this turn is answering arrived, from the ledger row the receiver wrote.
  deliveredAt: Date | null;
  base: PrismaClient;
}

// The `stillWanted` a direct turn hands to `runLoadedTurn`.
//
// `strict` is the contract that module states: inside the critical section, before anything is
// written, an unreadable answer must STOP the run, because guessing "still wanted" there recreates
// the thread /reset just cleared and no later fence catches it; at a send, an unreadable answer lets
// the run continue and be fenced by the CAS at the end, because throwing would abandon the
// bookkeeping of a message already delivered. How it stops is part of the contract too, and the
// catch below says why: `false` there would report a withdrawal that nobody made.
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
      return !resetLandedAfter(p.deliveredAt, row.resetAt);
    } catch (err) {
      // AN UNREADABLE MARK IS NOT A RETIREMENT, and under `strict` it must not be answered with
      // `false`. That answer is not "stop", it is "the operator withdrew this run": `runLoadedTurn`
      // reports `stale`, and the direct path settles the message as CONSUMED — taken out of the loss
      // list, no reply, no alert, nothing owed. A transient database failure would swallow a
      // customer's message quietly, which is the one outcome the whole delivery ledger exists to
      // prevent (issue #228: wrong and visible over quiet and wrong).
      //
      // So it STOPS by throwing, which is what the contract means at that seam: the delivery path
      // records the failure on the conversation, posts the note that a human has to take over, and
      // leaves the row for the sweep to replay — and the replay asks this question again, with an
      // answer it can read.
      if (strict) throw err;
      // At a send the contract is the opposite, and for a reason that is not symmetry: throwing here
      // abandons the bookkeeping of a message that may already be with the customer. The CAS at the
      // end is the fence that still holds.
      logger.warn(
        { err, conversation: String(p.conversationDbId) },
        "could not read the episode mark; letting the turn reach its own fence",
      );
      return true;
    }
  };
}
