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
// call is not a post, and at the time nothing between the model and Chatwoot asked the question at
// all. Issue #449 put the ask at the tool boundary, which is the one seam INSIDE the invoke: this
// fence is handed down to `buildAgentGraph` and asked once per tool-calling hop, and a turn that was
// called off gets its calls answered with a refusal instead of run.
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
//
// AND THE BOUNDARY IS NOT PROOF THAT THE MEMORY WAS CLEARED — true, and it is not supposed to be.
// This paragraph used to say the opposite, that all four readers of the column were wrong for the
// same reason, and issue #743 was opened on the strength of it. Measured, only ONE of them was, and
// the correction is this: the column answers "the operator withdrew this", not "the memory is gone",
// and the two questions have different readers.
//
// `/reset` does two things. It clears the memory, and it WITHDRAWS the work the conversation had in
// flight. The clearing can refuse — a turn already invoking holds the thread, `step()` catches it and
// the acknowledgement names what did not clear — but the withdrawal happened the moment the operator
// typed the command, and nothing can refuse it afterwards.
//
// So:
//   - the three WITHDRAWAL fences read this column, because what they ask is whether the operator
//     took this work back: the direct turn (`stillInSameEpisode` below), the debounce selection
//     (`readSelectionState`) and the observe tick's `atMessageId`. Issue #449 is the measurement that
//     settles it — there the memory step DID refuse, and the stale turn's `set_custom_attribute`
//     wrote the attribute back onto the conversation the operator had just been told about, with
//     nothing anywhere saying it came back. `tests/modules/chatwoot-reset-stale-turn.test.ts` is that
//     suite, and pointing this fence at the clearing column makes it fail;
//   - the one RESTORE fence reads `memory_cleared_at_message_id`, because what it asks is whether
//     there is a cleared memory to restore text INTO: the ingestion append (`threadResetBoundary`,
//     issue #728). There the column has to be the one the clearing itself writes, and it is.
//
// The observer's LABEL boundary (`observe/job.ts`, beside `resetClearedLabels`) is a fifth reader and
// also belongs here, for a third reason: the label cleanup is its own step and succeeds even when the
// memory step refuses, so a verdict filtered by the clearing column would write back the very labels
// the operator watched the command strip.
//
// `tests/graph/reset-fences.test.ts` pins each of these, so the next reader of this file does not
// have to re-derive it from the column name.
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

// THE EPISODE BOUNDARY OF THE THREAD, WHICH IS NOT THE BOUNDARY OF ONE CONVERSATION (review r2, and
// r4 for the second caller).
//
// `/reset` clears the memory by CONTACT-INBOX — `clearContactMemory` deletes the `AgentThread` row
// and the attendance summaries keyed by it — and stamps `reset_at_message_id` on the single
// conversation the command was typed in (`WHERE id = ctx.conv.id`). A contact who wrote on the same
// channel twice has two conversations sharing one thread, so a reset in the NEWER one wipes the
// memory an older conversation's message belongs to while leaving that older row unstamped. Asked of
// the message's own conversation, the fence then sees nothing and restores text from before the
// clear — into a thread whose dedup history was deleted with it, so nothing downstream catches the
// duplicate either.
//
// The MAXIMUM across the thread's conversations, because the boundary is a fact about the MEMORY and
// Chatwoot's ids are unique per account: a stamp on any conversation of this contact-inbox orders
// the message the same way its own would. What that costs is a late arrival on a sibling being
// refused by a reset it predates, which is the answer this fence exists to give.
//
// AND IT READS THE COLUMN THE CLEARING ITSELF WRITES (review r7/r8). `reset_at_message_id` records
// that the operator typed the command: the command commits it in an earlier, independent statement,
// and the memory-clearing step that follows refuses by design when a turn is already writing the
// thread, so that column can name a boundary whose memory was never emptied. Every append refused on
// the strength of it would then be a colleague's reply dropped from a memory nobody cleared.
// `memory_cleared_at_message_id` is written inside the transaction that deletes the thread, the
// summaries and the checkpoint, so it cannot exist without them.
//
// A conversation cleared before that column existed carries null and is not fenced, which is the
// permissive side on purpose: the fence exists to stop a restore, and there is nothing to restore
// into a memory this process never saw cleared.
export async function threadResetBoundary(
  tenantId: bigint,
  instanceId: bigint,
  contactInboxId: number,
  base: PrismaClient,
): Promise<number | null> {
  const rows = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversation.findMany({
      where: {
        tenantId,
        chatwootInstanceId: instanceId,
        contactInboxId,
        memoryClearedAtMessageId: { not: null },
      },
      select: { memoryClearedAtMessageId: true },
      orderBy: { memoryClearedAtMessageId: "desc" },
      take: 1,
    }),
  );
  return rows[0]?.memoryClearedAtMessageId ?? null;
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
