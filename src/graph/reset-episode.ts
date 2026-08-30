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
// So the fact the run is named by is the EPISODE, and the question is asked in the SOURCE's own
// order: is the message this turn is answering at or below the one that carried the command?
//
// A MESSAGE ID and not a timestamp of ours. Our ledger row is inserted on the detached path, after
// the ack (`recordAndProcessChatwootDelivery`), so two events acked in order can be recorded out of
// it — and on the two web replicas docs/deploy.md §4 sanctions, more easily still. Chatwoot's
// sequence is the order the operator and the customer actually experienced, which is the only order
// this question has ever been about. Three review rounds on #447 walked the baseline from the turn's
// own config load, to the mirror, to the delivery's insertion time, before landing here.
//
// AT OR BELOW, not below: the command's own message carries the boundary, and a turn answering that
// same id would be a turn on the command itself.
export function resetLandedAfter(
  triggerMessageId: number | null,
  resetAtMessageId: number | null,
): boolean {
  if (resetAtMessageId === null) return false;
  // No trigger is not evidence of a reset: it is a caller that named no message (the playground, a
  // test), and the fence has nothing to order.
  if (triggerMessageId === null) return false;
  return triggerMessageId <= resetAtMessageId;
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface EpisodeFenceParams {
  tenantId: bigint;
  conversationDbId: bigint;
  // The Chatwoot message id this turn is answering.
  triggerMessageId: number | null;
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
          select: { resetAtMessageId: true },
        }),
      );
      if (!row) return true;
      return !resetLandedAfter(p.triggerMessageId, row.resetAtMessageId);
    } catch (err) {
      // AN UNREADABLE MARK IS NOT A RETIREMENT, and under `strict` it must not be answered with
      // `false`. That answer is not "stop", it is "the operator withdrew this run": `runLoadedTurn`
      // reports `stale`, and the direct path settles the message as CONSUMED — taken out of the loss
      // list, no reply, no alert, nothing owed. A transient database failure would swallow a
      // customer's message quietly, which is the one outcome the whole delivery ledger exists to
      // prevent (issue #228: wrong and visible over quiet and wrong).
      //
      // So it STOPS by throwing, which is what the contract means at that seam, and what that buys
      // is exactly what every other failed turn buys — no more, and the difference is worth writing
      // down because a review round read the first version of this comment as promising a replay it
      // does not get. The delivery path catches the rejection, records the failure on the
      // conversation, posts the note that a human has to take over, and then closes the row
      // PROCESSED like any other completed delivery. The message is not answered and the sweep will
      // not come back for it; the operator is told, twice, on the conversation itself.
      //
      // That is the right side of the trade because this read is not special: a turn opens dozens of
      // scoped reads, and a database transient that takes this one is taking the others too — the
      // turn was going to fail through this same machinery either way. What the throw prevents is
      // the ONE outcome that machinery cannot express, `false`, which says the operator withdrew the
      // run and takes the message out of the loss list with nothing recorded anywhere.
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
