import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// `Conversation.lastHandledMessageId` marks the last inbound message the bot either responded to or
// DELIBERATELY skipped (handoff mid-turn, human-owned period, consumed /commands, guardrail
// suppression). Every writer goes through this monotonic CAS: a stale advance (target ≤ current)
// loses silently, so concurrent flushes and webhook deliveries can never move the watermark
// backwards. Advancing means "never re-ANSWER this", not "never remember it" — skipped messages
// still reach the agent's memory through ingestion. Left behind, the watermark makes the next
// debounce flush re-coalesce the whole human-era backlog (handoff reason included) after a human
// returns a conversation to the bot (issue #8).
//
// NOTE: it answers "will anything answer this again", and NOT "did anything answer this" — most
// writers below advance it precisely because no turn is running. A reader that needs the second
// question cannot get it from here, and must not try: the stranded-delivery sweep asked it this way
// through three review rounds of PR #282 and was wrong each time, and now gets its answer from the
// delivery ledger instead (../chatwoot/delivery-sweep.ts, `retireCoveredDeliveries`).

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// WHAT THIS ADVANCE CLOSED WITHOUT ANSWERING, named by the caller and never inferred here
// (issue #690).
//
// It has to be a parameter and it has to be REQUIRED, for the reason the `kind` of `undoRefusedTurn`
// is: a call site that must name it cannot inherit the wrong one by omission, and a path added later
// that forgets to dispense does not fail — it answers the customer a second time, quietly, months
// from now. The compiler asking the question is the only thing that scales to the next call site.
//
// AND IT IS WHAT THE CALLER CALCULATED, never the complement of the range it advanced over. The
// posting path passes through here too: it moves the mark from 1000 to 1002 having answered only
// 1002, so writing "dispensed" across the span would close 1001 with the fix's own hand — the exact
// defect this issue is about, one level down.
export type WatermarkDispensal =
  // Nothing to dispense: this turn's claim rows already speak for every message it closed. The
  // posting path, whose messages are in `message_reply_claims` before the send.
  | { kind: "claimed" }
  // The messages this decision consumed, by id. Every caller that has fetched the burst uses this,
  // including the ones that also post: a turn that answered `[1003,1004]` while the cap dropped
  // `[1001,1002]` names the two it dropped, and the two words live side by side on the same table.
  | { kind: "messages"; messageIds: readonly number[] }
  // The span this decision consumed, for the callers that genuinely cannot name its members: a gate
  // exit decides BEFORE any Chatwoot fetch, so the burst is not known message by message. Bounded at
  // both ends, the lower one exclusive — reaching back past the mark it read would close messages an
  // earlier decision already spoke for.
  //
  // A range is sound here and only here, and the discriminator is worth stating: it is sound when
  // the DECISION was taken over the span ("this conversation is not ours to answer right now", true
  // of every message inside it), and an approximation when the decision was taken over messages and
  // the span is merely their hull — which is the shape that reconstructs this very bug. A caller
  // that has the ids uses `messages`.
  | { kind: "range"; afterMessageId: number | null };

export interface AdvanceHandledWatermarkParams {
  tenantId: bigint;
  conversationDbId: bigint;
  // Chatwoot id of the newest message now considered handled.
  toMessageId: number;
  dispensed: WatermarkDispensal;
  base?: PrismaClient;
}

// Returns true when this call moved the watermark (the CAS won), false when a concurrent writer
// already advanced it past `toMessageId`.
export async function advanceHandledWatermark(
  params: AdvanceHandledWatermarkParams,
): Promise<boolean> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    // THE PARENT ROW FIRST, WHENEVER THIS CALL WILL WRITE A CHILD (PR review, round 2). Both tables
    // below carry a foreign key to `conversations`, so inserting into them takes a `KEY SHARE` lock
    // on that conversation row — and `claimReplyBurst` holds `FOR UPDATE` on it, which conflicts.
    //
    // The CAS below usually takes the row lock on the way past, so the orders agree by accident. It
    // does not when the watermark ALREADY covers `toMessageId`: the `updateMany` matches nothing and
    // locks nothing, and this call then goes straight for the child. A claimant holding the parent
    // and waiting for the child's unique-index entry, against this holding that entry and waiting
    // for the parent, is a deadlock — and Postgres resolves it by killing one of the two, so a
    // customer's reply is aborted rather than refused, with an error instead of an outcome.
    //
    // Taking it explicitly costs the lock only in the case the CAS loses it, which is the stale
    // advance: rare, and already the cheapest path here. `kind: "claimed"` writes no child and needs
    // nothing.
    if (
      (params.dispensed.kind === "messages" &&
        params.dispensed.messageIds.length > 0) ||
      params.dispensed.kind === "range"
    ) {
      await db.$queryRaw`SELECT 1 FROM "conversations"
                          WHERE "id" = ${params.conversationDbId}
                            FOR UPDATE`;
    }
    const cas = await db.conversation.updateMany({
      where: {
        id: params.conversationDbId,
        OR: [
          { lastHandledMessageId: null },
          { lastHandledMessageId: { lt: params.toMessageId } },
        ],
      },
      data: { lastHandledMessageId: params.toMessageId },
    });
    // WRITTEN WHETHER OR NOT THE MARK MOVED, and the asymmetry with the CAS is deliberate. A stale
    // advance loses silently because somebody else's decision is further along; the DECISION this
    // call reports still happened, and a message it deliberately left unanswered is still one no
    // reader above the floor may treat as open. Losing the CAS and writing nothing would leave
    // exactly that message with no record at all.
    const d = params.dispensed;
    if (d.kind === "messages" && d.messageIds.length > 0) {
      const ids = [...new Set(d.messageIds)].sort((a, b) => a - b);
      // ON CONFLICT DO NOTHING is what makes first writer win in BOTH orders: a message some turn
      // already claimed stays claimed (it is spoken for, and this call is not about it), and a
      // message dispensed here cannot later be claimed. Neither needs a branch.
      await db.$executeRaw`
        INSERT INTO "message_reply_claims"
               ("tenant_id", "conversation_id", "message_id", "reason")
        SELECT ${params.tenantId}, ${params.conversationDbId}, m, 'DISPENSED'::"ReplyClaimReason"
          FROM unnest(${ids}::int[]) AS m
         ORDER BY m
            ON CONFLICT ("conversation_id", "message_id") DO NOTHING`;
    } else if (d.kind === "range") {
      await db.replyDispensal.create({
        data: {
          tenantId: params.tenantId,
          conversationId: params.conversationDbId,
          fromMessageId: d.afterMessageId,
          toMessageId: params.toMessageId,
        },
      });
    }
    return cas.count > 0;
  });
}

// THE REPLY CLAIM, and it is a column of its own for one reason: the watermark above is advanced by
// deliberate SKIPS, not only by answers. A human-owned stretch moves it without ever writing an
// outgoing message of ours, so the moment the conversation comes back to the bot the watermark
// stands AHEAD of the tail the manual re-engage answers (incoming after the last outgoing), and a
// CAS against it can never win again — with nothing concurrent anywhere. Reported as "superseded",
// which names a race that did not happen, and permanent, because no new inbound means no new target
// (issue #452). It is the second question the note above says this file cannot answer: not "will
// anything answer this again", but "did anything claim to answer this".
//
// EVERY POSTING PATH CLAIMS HERE, which is what keeps them exclusive. Two flushes racing one burst,
// a flush retry and an operator's click on the same failed burst, two clicks on the same tail: one
// column, one winner. A claim per caller would have made the flush and the button contend on
// different rows and both send.
//
// Returns whether this call won, and why not when it lost — the two reasons are different facts and
// the log line distinguishes them.
//
// UNDER THE ROW LOCK, and both halves of that matter. `FOR UPDATE` is taken BEFORE the value is
// read, so a claimant that arrives second waits here and then reads what its predecessor committed:
// read-then-write without it (and a self-join `UPDATE … FROM`, which reads `old` from the statement
// snapshot rather than from the row it waits on) can hand B the value that predated A, and B's
// release would then restore a mark A had already moved — handing a burst A answered back to a
// later retry.
//
// `maxHandledAllowed` is the second question the same lock has to answer atomically: "has the WATERMARK
// moved past what this caller is entitled to answer over". Asking it outside this transaction leaves
// the window where a deliberate skip lands between the read and the claim. The direct turn and the
// flush answer above the mark and pass `target - 1`; the manual re-engage answers a tail the mark
// already covers — the whole of issue #452 — and passes the mark it read on the way IN, so a skip
// landing WHILE it runs still refuses it.
//
// NULL IS A CEILING, NOT THE ABSENCE OF ONE: it says the caller read NO mark, so the highest value
// it may answer over is nothing at all, and any mark standing here now was written after that read
// by somebody else. Read as "no ceiling" instead, it would let the click post over a deliberate
// skip on exactly the conversation where it has the least evidence the tail is still unanswered —
// the one that never had a mark to compare against. There is no caller for "no ceiling", and this
// is why the parameter is not optional.
export async function claimReplyBurst(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  toMessageId: number;
  maxHandledAllowed: number | null;
  // EXACTLY THE MESSAGES THIS TURN ANSWERS, and the whole fix for issue #690 rests on this list being
  // what the turn actually read rather than what it set out to read. The direct path answers ONE
  // message, its own trigger; a flush answers the burst it rendered. Neither is "everything in the
  // channel": a turn that loaded `[MSG-B, RESP-B, MSG-A]` answers MSG-A, and saying otherwise would
  // close MSG-B a second time.
  //
  // The caller filters this list by its own reading of the channel before it gets here, which is
  // where the asymmetric rule lives: an outgoing message that is NOT ours closes everything before
  // it, because we cannot know what a colleague's reply addressed, while an outgoing of ours closes
  // only the ids it claimed. Shaping the SET is how that reading reaches this function — never a
  // boolean, which is a fail-open read wearing a parameter.
  messageIds: readonly number[];
  // WHO ASKED FOR THIS REPLY, and the only value that changes anything is the operator's own click
  // (issue #452, kept honest by issue #690).
  //
  // A dispensal is the record of a deliberate silence, and the button exists to overturn one: the
  // flush that answered nothing, the guardrail that went quiet, the human-owned stretch that ended.
  // Refusing the click on the strength of that record would take away the product's only escape from
  // a turn that said nothing, and answer a person pressing a button with "superseded".
  //
  // DECLARED, AND NOT DERIVED FROM THE NUMBERS, which is a correction of the first shape this took.
  // The re-engage is recognisable by answering a tail the mark already covers — and so is a delayed
  // REDELIVERY of a message answered long ago, which reaches the direct path with a target below the
  // mark and is exactly what must not be answered twice. The two are indistinguishable by arithmetic
  // and opposite in kind, so the caller says which it is. Required rather than defaulted, for the
  // reason every other required word in this change is: a path added later that inherits "operator"
  // by omission posts over a silence somebody chose on purpose.
  initiatedBy: "automatic" | "operator";
  base?: PrismaClient;
}): Promise<ReplyClaimOutcome> {
  const base = params.base ?? basePrisma;
  // ASCENDING, AND NOT FOR TIDINESS: two turns inserting overlapping sets in opposite orders wait on
  // each other's uncommitted rows, one per direction, which is a deadlock Postgres resolves by
  // killing one of them. Inserting in one agreed order makes the loser wait and then lose cleanly.
  // De-duplicated because a burst can carry the same id twice through a re-fetch, and a repeat would
  // make the count below disagree with the set for a reason that is not contention.
  let partial = false;
  const ids = [...new Set(params.messageIds)].sort((a, b) => a - b);
  const lowest = ids[0];
  const highest = ids[ids.length - 1];
  if (lowest === undefined || highest === undefined) {
    // NOTHING LEFT TO ANSWER once the caller's own reading has filtered the tail — a colleague
    // replied under the turn, and every message it was going to speak for is closed by that. Not an
    // error and not contention: the turn stands down exactly as it does on a lost claim.
    return { won: false, reason: "claimed" };
  }
  return runScopedOn(
    base,
    sysCtx(params.tenantId),
    async (db): Promise<ReplyClaimOutcome> => {
      const locked = await db.$queryRaw<
        Array<{
          claimed: number | null;
          handled: number | null;
          floor: number | null;
        }>
      >`SELECT "last_replied_message_id" AS "claimed",
             "last_handled_message_id" AS "handled",
             "reply_claim_floor_message_id" AS "floor"
        FROM "conversations"
       WHERE "id" = ${params.conversationDbId}
         FOR UPDATE`;
      const row = locked[0];
      // No row is not this function's to explain: the conversation was deleted under a running turn,
      // and nothing may be posted for it.
      if (row === undefined) return { won: false, reason: "claimed" };

      // THE FLOOR DECIDES WHICH ERA ANSWERS, and it answers per message rather than per conversation.
      // At or below it there are no rows and there never will be, so the scalars are the only thing
      // that knows anything and they answer in full — unrelaxed, which is what keeps a redelivery of a
      // message from before this table from being answered a second time. Above it, absence of a row
      // is evidence, because every decision taken up there wrote one.
      const floor = row.floor;
      const reachesBelowFloor = floor === null || lowest <= floor;
      const overturnsSilence = params.initiatedBy === "operator";
      if (reachesBelowFloor && row.claimed !== null) {
        if (row.claimed >= params.toMessageId) {
          return { won: false, reason: "claimed" };
        }
      }
      // THE CEILING SURVIVES THE FLOOR FOR THE OPERATOR, and only for the operator (PR review,
      // round 1). Above the floor the scalars answer nothing, because every decision up there wrote
      // a row and the rows are read directly — for an automatic caller that is the whole point of
      // this change. The click is different in one specific way: it IGNORES dispensals on purpose,
      // so a skip recorded between the moment it read the mark and the moment it claims is a
      // decision it would walk straight over.
      //
      // That window is the whole of issue #452: `docs/debounce.md` requires a skip landing while the
      // model runs to refuse the reply, and `claimHandledCeiling: () => floorAtEntry` is how the
      // re-engage states what it read on the way in. Asked only below the floor, the ceiling stopped
      // covering the click on any conversation whose per-message era had begun, which is every
      // conversation a turn has run on.
      //
      // It is not a second answer to the same question: the rows say "this message is spoken for",
      // and this says "something settled this tail after I looked". An automatic caller gets the
      // first from the insert below and does not need the second; the click waives the first and
      // still needs it.
      if (
        (reachesBelowFloor || overturnsSilence) &&
        row.handled !== null &&
        (params.maxHandledAllowed === null ||
          row.handled > params.maxHandledAllowed)
      ) {
        return { won: false, reason: "handled" };
      }

      // A DISPENSAL THAT COVERS ANY OF THEM CLOSES THE WHOLE SET, and the answer is all-or-nothing for
      // the same reason the insert below is: this turn speaks for its tail or for none of it, and
      // answering half a burst is the shape that makes a customer read a reply to their second message
      // and nothing about their first. Ranges are exclusive at the lower end, which is how
      // `retireCoveredDeliveries` already states the bound it calculated.
      // MEMBERSHIP OF THE ACTUAL IDS, not overlap with the interval they span (PR review, round 1).
      // A burst is not dense — the selection drops what renders to nothing — so `[1001, 1005]` spans
      // four ids it does not contain, and a dispensal of `(1002, 1004]` would intersect that span
      // while having dispensed neither message. Asked as overlap, the whole reply was suppressed as
      // superseded over messages this turn was never speaking for.
      //
      // It is the same distinction the dispensal side of this change is built on, applied to the
      // read: the hull of a set is not the set, and the gap inside it is exactly where this issue's
      // defect lives.
      // COUNTED PER MESSAGE, not per dispensal (PR review, round 5). How many of these ids a range
      // covers is the question, because covering SOME of them is a different situation from covering
      // all: the ones it does not cover are still owed to somebody, and the caller has to be told so
      // it can come back for them. Asked as "does any dispensal touch this set", a range over
      // `(1000,1001]` refused a burst of `[1001,1002]` whole and left 1002 with nothing scheduled.
      const dispensed = await db.$queryRaw<Array<{ hit: bigint }>>`
      SELECT count(*) AS "hit"
        FROM unnest(${ids}::int[]) AS m
       WHERE EXISTS (
               SELECT 1 FROM "reply_dispensals" d
                WHERE d."conversation_id" = ${params.conversationDbId}
                  AND m <= d."to_message_id"
                  AND (d."from_message_id" IS NULL OR m > d."from_message_id"))`;
      const dispensedCount = Number(dispensed[0]?.hit ?? 0n);
      if (!overturnsSilence && dispensedCount > 0) {
        // Same distinction the claim conflict below draws, and for the same reason: a burst refused
        // because every one of its messages was dispensed has nothing left owing, while one refused
        // over a subset leaves the rest with no reply, no watermark move and no schedule.
        return {
          won: false,
          reason: dispensedCount === ids.length ? "dispensed" : "partial",
        };
      }

      // THE EXCLUSION ITSELF, and it is the unique index rather than a comparison. Overlapping sets
      // collide there, atomically, with no lock written by hand; disjoint sets both pass, which is
      // exactly what issue #690 asks for and what a single number could never express.
      const inserted = overturnsSilence
        ? // THE ONE WRITE THAT OVERTURNS A ROW, and the condition on the update is what keeps it
          // narrow: a DISPENSED row becomes CLAIMED because an operator decided the silence was
          // wrong, and a CLAIMED row is left exactly as it is, because another turn is speaking for
          // that message and no button may take it away. The row that fails the condition is not
          // returned, so the count below still refuses the whole claim.
          //
          // This is the only place `reason` is read to decide anything, and deliberately on the WRITE
          // side. A decision that branched on it would reopen every message the cap dropped and every
          // turn that chose silence, which is the defect this table was built to close.
          await db.$queryRaw<Array<{ message_id: number }>>`
          INSERT INTO "message_reply_claims"
                 ("tenant_id", "conversation_id", "message_id", "reason")
          SELECT ${params.tenantId}, ${params.conversationDbId}, m, 'CLAIMED'::"ReplyClaimReason"
            FROM unnest(${ids}::int[]) AS m
           ORDER BY m
              ON CONFLICT ("conversation_id", "message_id") DO UPDATE
                 SET "reason" = 'CLAIMED'::"ReplyClaimReason"
               WHERE "message_reply_claims"."reason" = 'DISPENSED'::"ReplyClaimReason"
           RETURNING "message_id"`
        : await db.$queryRaw<Array<{ message_id: number }>>`
          INSERT INTO "message_reply_claims"
                 ("tenant_id", "conversation_id", "message_id", "reason")
          SELECT ${params.tenantId}, ${params.conversationDbId}, m, 'CLAIMED'::"ReplyClaimReason"
            FROM unnest(${ids}::int[]) AS m
           ORDER BY m
              ON CONFLICT ("conversation_id", "message_id") DO NOTHING
           RETURNING "message_id"`;
      if (inserted.length !== ids.length) {
        // Recorded before the rollback takes the partial inserts with it: afterwards nothing
        // distinguishes "every message was already spoken for" from "one was, and the rest are still
        // owed to somebody".
        partial = inserted.length > 0;
        // ALL OR NOTHING. Fewer rows back means somebody else owns part of this tail, and a turn that
        // owns part of it owns none: the rollback takes the partial inserts with it, and the caller is
        // one statement short of a send that has not happened yet, which is the contract
        // `runLoadedTurn` documents and this preserves word for word.
        throw new LostReplyClaim();
      }

      await db.conversation.update({
        where: { id: params.conversationDbId },
        data: {
          // MONOTONIC, AND THAT IS NOT FREE ANY MORE. It used to be a consequence of the guard
          // above: a claim behind the mark was refused, so the write could only move forward. Above
          // the floor that guard no longer runs — the whole point of issue #690 being that a turn
          // may legitimately claim a message BELOW the newest claim — and an unconditional write
          // would drag the column backwards. Everything reading it as "answered up to here" then
          // reopens what the newer turn answered: `readAnsweredFloor` lowers, and the next flush
          // coalesces an answered message into its burst and answers it a second time.
          ...(row.claimed === null || params.toMessageId > row.claimed
            ? { lastRepliedMessageId: params.toMessageId }
            : {}),
          // THE ERA STARTS HERE, once, at the highest message the old era had already decided —
          // which is the MAX of the two scalars and not either alone, the same floor
          // `readAnsweredFloor` computes below and for the same reason: one of them carries
          // deliberate skips and the other carries claims, and a message closed by either is
          // closed. Taking `handled` alone would leave a message some turn had already claimed
          // sitting ABOVE the floor, where "no row" reads as open and the bot answers it again.
          //
          // Written only when it is null, so a later claim cannot move a floor that has already
          // decided which messages belong to which era.
          ...(floor === null
            ? {
                replyClaimFloorMessageId: Math.max(
                  row.handled ?? 0,
                  row.claimed ?? 0,
                ),
              }
            : {}),
        },
      });
      return { won: true };
    },
  ).catch((e): ReplyClaimOutcome => {
    if (e instanceof LostReplyClaim) {
      return { won: false, reason: partial ? "partial" : "claimed" };
    }
    throw e;
  });
}

// WHICH OF THESE MESSAGES A TURN HAS ALREADY SPOKEN FOR (issue #690, PR review round 1).
//
// Read by the operator's re-engage and by nothing else, because it is the one caller that builds its
// burst from the CHANNEL rather than from a watermark: it takes everything after the last outgoing
// message, and a claim whose send failed leaves a message sitting in that tail with a row on it. The
// claim below is all-or-nothing, so one such message would roll back the whole click — including the
// newer message beside it that nobody has answered — and it would do so on every future click, since
// nothing ever removes that row. Before this table the newer target simply proceeded.
//
// CLAIMED only. A dispensal is exactly what the button exists to overturn, so a message a turn chose
// to stay silent about stays in the tail and gets answered.
export async function readClaimedMessageIds(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  messageIds: readonly number[];
  base?: PrismaClient;
}): Promise<Set<number>> {
  if (params.messageIds.length === 0) return new Set();
  const base = params.base ?? basePrisma;
  const rows = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.messageReplyClaim.findMany({
      where: {
        conversationId: params.conversationDbId,
        messageId: { in: [...params.messageIds] },
        reason: "CLAIMED",
      },
      select: { messageId: true },
    }),
  );
  return new Set(rows.map((r) => r.messageId));
}

export type ReplyClaimOutcome =
  | { won: true }
  | {
      won: false;
      // PART of this set was free and part was not (PR review, round 4). The refusal is still whole —
      // a turn that owns part of a tail owns none of it — but the CONSEQUENCE differs, and only the
      // caller can act on it: a burst refused because a newer message arrived has that newer
      // message's own turn coming for it, while one refused on a conflict has nothing coming for the
      // messages nobody claimed. The flush reschedules on this word and on no other.
      reason: "claimed" | "handled" | "dispensed" | "partial";
    };

// The rollback signal for the all-or-nothing insert above. A thrown error is what aborts the
// interactive transaction — returning early would COMMIT the partial rows, which is the one outcome
// that must not happen: they would close messages for a turn that then sends nothing.
class LostReplyClaim extends Error {}

// WHAT A FLUSH MUST NOT RE-ANSWER, which is not the watermark alone (issue #452). The claim is
// written immediately before the send and the watermark only after the turn returns, so between the
// two there is a real gap: a reply that lands and then loses its watermark write (the direct path
// catches that failure and logs it; a process exit does the same) leaves the message answered, the
// claim recording it, and the mark behind. Selecting from the mark alone, the next flush coalesces
// that answered message with the newer one and — the target being higher — wins the claim and
// answers it again.
//
// So the floor is the max of the two. The claim is the half that says "something answered this"; the
// watermark is the half that also covers deliberate skips, which the claim never records.
export async function readAnsweredFloor(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  base?: PrismaClient;
}): Promise<number | null> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    const row = await db.conversation.findUnique({
      where: { id: params.conversationDbId },
      select: { lastHandledMessageId: true, lastRepliedMessageId: true },
    });
    if (!row) return null;
    const { lastHandledMessageId: handled, lastRepliedMessageId: replied } =
      row;
    if (handled === null) return replied;
    if (replied === null) return handled;
    return Math.max(handled, replied);
  });
}

// The watermark as it stands RIGHT NOW. Read where the burst is selected, not where the flush
// started: between those two points sits an authorization round-trip to somebody else's endpoint,
// and a message that arrived and was REFUSED during it has already had the watermark advanced past
// it by its own delivery. Selecting against the older value would hand that refused message to the
// model — and the post-gate CAS below only withholds the reply, after the turn has already run its
// tools.
export async function readHandledWatermark(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  base?: PrismaClient;
}): Promise<number | null> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    const row = await db.conversation.findUnique({
      where: { id: params.conversationDbId },
      select: { lastHandledMessageId: true },
    });
    return row?.lastHandledMessageId ?? null;
  });
}
