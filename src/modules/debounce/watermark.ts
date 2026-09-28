import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { resetLandedAfter } from "@/graph/reset-episode";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type ChatwootMessageRow,
  pendingIncoming,
} from "@/modules/chatwoot/messages";
import {
  providerReservesEchoIds,
  SESSION_SENDER_NAME,
} from "@/modules/chatwoot/normalize";

// `Conversation.lastHandledMessageId` marks the last inbound message the bot either answered or
// deliberately skipped (handoff mid-turn, human-owned period, consumed /commands, guardrail
// suppression). Every writer goes through the monotonic CAS below, so a stale advance loses
// silently and the mark never moves backwards. Advancing means "never re-answer this", not "never
// remember it": skipped messages still reach memory through ingestion.
//
// It does NOT answer "did anything answer this": most writers advance it because no turn ran. A
// reader that needs that asks the delivery ledger (`retireCoveredDeliveries`).

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// What this advance closed without answering, named by the caller and never inferred here. Required,
// so a new call site cannot inherit the wrong value by omission. It is what the caller decided, never
// the complement of the range advanced over: the posting path moves the mark from 1000 to 1002
// having answered only 1002, and marking the whole span dispensed would close 1001.
export type WatermarkDispensal =
  // Nothing to dispense: the posting path's claim rows already cover every message it closed.
  | { kind: "claimed" }
  // The messages this decision consumed, by id. Used by every caller that fetched the burst,
  // including the posting ones: a turn that answered `[1003,1004]` while the cap dropped
  // `[1001,1002]` names the two it dropped.
  | { kind: "messages"; messageIds: readonly number[] }
  // For callers that cannot name the members: a gate exit decides before any Chatwoot fetch. The
  // lower bound is exclusive, so it never reaches back past the mark it read. Sound only when the
  // decision was taken over the span itself ("not ours to answer right now"); the hull of messages
  // decided one by one is not a range, and a caller that has the ids uses `messages`.
  | { kind: "range"; afterMessageId: number | null };

export interface AdvanceHandledWatermarkParams {
  tenantId: bigint;
  conversationDbId: bigint;
  // Chatwoot id of the newest message now considered handled.
  toMessageId: number;
  dispensed: WatermarkDispensal;
  base?: PrismaClient;
}

// Refuses the reply to these messages without moving the watermark. The conversation stays the
// bot's, so the flush that runs later would coalesce from the mark and answer what the gate
// silenced; but the memory of the message is still owed, so the mark must not cover it. A separate
// function rather than a flag on `advanceHandledWatermark`, whose result means "the CAS won".
export async function dispenseMessagesFromReply(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  messageIds: readonly number[];
  base?: PrismaClient;
}): Promise<void> {
  const wanted = [...new Set(params.messageIds)].sort((a, b) => a - b);
  if (wanted.length === 0) return;
  const base = params.base ?? basePrisma;
  await runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    // NOTE: lock the parent row first, with `FOR UPDATE` like `advanceHandledWatermark`: the child
    // insert takes `KEY SHARE` on the conversation and `claimReplyBurst` holds `FOR UPDATE` on it, so
    // both paths must take the parent the same way. Reads the same columns as `claimReplyBurst`
    // because it must also decide which side of the floor each message falls on.
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
    // NOTE: conversation deleted under the gate, nothing to attach the dispensal to (same exit as
    // `claimReplyBurst`).
    if (row === undefined) return;

    // NOTE: the dispensal opens the per-message era when it has not begun. This is the only writer
    // of a `DISPENSED` row that does not move the mark, so without a floor the row would be invisible
    // to `readSelectionState` yet still hit by the unique index in `claimReplyBurst`, which would
    // refuse every later burst containing it as `partial`, in a loop. The floor is the same max of
    // the two scalars `claimReplyBurst` computes.
    const floor = row.floor ?? Math.max(row.handled ?? 0, row.claimed ?? 0);
    // NOTE: nothing at or below the floor: the scalars already decided those (a redelivery from the
    // old era, say), and a row there would recreate the invisible conflict above.
    const ids = wanted.filter((m) => m > floor);
    if (ids.length === 0) return;
    if (row.floor === null) {
      await db.conversation.update({
        where: { id: params.conversationDbId },
        data: { replyClaimFloorMessageId: floor },
      });
    }
    // NOTE: `ON CONFLICT DO NOTHING` makes the first writer win in both orders: a message a turn
    // already claimed stays claimed.
    await db.$executeRaw`
      INSERT INTO "message_reply_claims"
             ("tenant_id", "conversation_id", "message_id", "reason")
      SELECT ${params.tenantId}, ${params.conversationDbId}, m, 'DISPENSED'::"ReplyClaimReason"
        FROM unnest(${ids}::int[]) AS m
       ORDER BY m
          ON CONFLICT ("conversation_id", "message_id") DO NOTHING`;
  });
}

// Returns true when this call moved the watermark (the CAS won), false when a concurrent writer
// already advanced it past `toMessageId`.
export async function advanceHandledWatermark(
  params: AdvanceHandledWatermarkParams,
): Promise<boolean> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    // NOTE: lock the parent row first whenever a child row will be written. Both child tables carry
    // an FK to `conversations`, so the insert takes `KEY SHARE` on it while `claimReplyBurst` holds
    // `FOR UPDATE`. The CAS usually takes the lock on the way past, but not when the mark already
    // covers `toMessageId` (it matches nothing), and the reversed lock order then deadlocks and
    // Postgres aborts one of the two turns. `kind: "claimed"` writes no child and needs no lock.
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
    // NOTE: written whether or not the CAS won. A stale advance loses the mark to a newer decision,
    // but the decision this call reports still happened, and skipping the row would leave a message
    // it deliberately left unanswered with no record.
    const d = params.dispensed;
    if (d.kind === "messages" && d.messageIds.length > 0) {
      const ids = [...new Set(d.messageIds)].sort((a, b) => a - b);
      // NOTE: `ON CONFLICT DO NOTHING` makes the first writer win in both orders: a claimed message
      // stays claimed, and a message dispensed here cannot be claimed later.
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

// The reply claim every posting path takes, so one set of messages has one winner. Not the watermark,
// which also moves on deliberate skips and cannot say "did anything claim to answer this".
//
// Read after taking `FOR UPDATE`: an unlocked read, or a self-join `UPDATE … FROM` (which reads `old`
// from the statement snapshot), hands a second claimant the value from before the first committed.
// `maxHandledAllowed` is checked under the same lock, so a skip landing after the caller read the mark
// refuses the claim. `null` means the caller read no mark, so any mark present now refuses it: it is
// not "no ceiling".
export async function claimReplyBurst(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  toMessageId: number;
  maxHandledAllowed: number | null;
  // Exactly the messages this turn answers (what it read, not what it set out to read), already
  // filtered by the caller's reading of the channel: a foreign outgoing message closes everything
  // before it, one of ours closes only the ids it claimed.
  messageIds: readonly number[];
  // Only `"operator"` (the re-engage click) changes anything: it may overturn a dispensal, since the
  // button exists to overturn a deliberate silence. Declared rather than derived from the ids,
  // because a delayed redelivery of an old message looks the same by arithmetic and must not be
  // answered twice. Required, so a new path cannot inherit `"operator"` by omission.
  initiatedBy: "automatic" | "operator";
  base?: PrismaClient;
}): Promise<ReplyClaimOutcome> {
  const base = params.base ?? basePrisma;
  // NOTE: ascending, so two turns inserting overlapping sets wait on each other in one order instead
  // of deadlocking; deduplicated so a repeated id cannot make the insert count disagree with the set.
  let partial = false;
  const ids = [...new Set(params.messageIds)].sort((a, b) => a - b);
  const lowest = ids[0];
  const highest = ids[ids.length - 1];
  if (lowest === undefined || highest === undefined) {
    // NOTE: the caller's filter left nothing (a colleague replied under the turn): stand down as on
    // a lost claim.
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
      // NOTE: conversation deleted under a running turn: nothing may be posted for it.
      if (row === undefined) return { won: false, reason: "claimed" };

      // NOTE: the per-message floor decides which era answers. At or below it no rows exist, so the
      // scalars answer in full (which keeps a redelivery from before the table from being answered
      // twice); above it the absence of a row is evidence, because every decision there writes one.
      const floor = row.floor;
      const reachesBelowFloor = floor === null || lowest <= floor;
      const overturnsSilence = params.initiatedBy === "operator";
      if (reachesBelowFloor && row.claimed !== null) {
        if (row.claimed >= params.toMessageId) {
          return { won: false, reason: "claimed" };
        }
      }
      // NOTE: for the operator the ceiling also applies above the floor. The click ignores
      // dispensals, so a skip recorded between its read of the mark and this claim would otherwise
      // be walked over. Automatic callers get that protection from the claim rows and need only the
      // below-floor check.
      if (
        (reachesBelowFloor || overturnsSilence) &&
        row.handled !== null &&
        (params.maxHandledAllowed === null ||
          row.handled > params.maxHandledAllowed)
      ) {
        return { won: false, reason: "handled" };
      }

      // NOTE: membership of the actual ids, not overlap with the interval they span: a burst is not
      // dense, so a range can intersect its hull without covering any member. Counted per message so
      // a partial cover is reported as `partial` and the caller reschedules the rest. Ranges are
      // exclusive at the lower end, as `retireCoveredDeliveries` computes them.
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
        // NOTE: all dispensed leaves nothing owing; a subset leaves the rest with no reply and no
        // schedule, so the caller must be told `partial`.
        return {
          won: false,
          reason: dispensedCount === ids.length ? "dispensed" : "partial",
        };
      }

      // NOTE: the exclusion is the unique index, not a comparison: overlapping sets collide
      // atomically, disjoint sets both pass.
      const inserted = overturnsSilence
        ? // NOTE: the one write that overturns a row: a DISPENSED row becomes CLAIMED because the
          // operator overruled the silence, while a CLAIMED row fails the `WHERE`, is not returned,
          // and the count below refuses the whole claim. The only place `reason` decides anything.
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
        // NOTE: recorded before the rollback erases the partial inserts, the only moment "all spoken
        // for" and "some still owed" can be told apart.
        partial = inserted.length > 0;
        // NOTE: all or nothing: a turn that owns part of the tail owns none, and the rollback
        // removes the partial inserts before any send has happened.
        throw new LostReplyClaim();
      }

      await db.conversation.update({
        where: { id: params.conversationDbId },
        data: {
          // NOTE: monotonic by condition: above the floor a turn may legitimately claim below the
          // newest claim, and moving this column backwards would lower `readAnsweredFloor` and let
          // the next flush answer an already answered message again.
          ...(row.claimed === null || params.toMessageId > row.claimed
            ? { lastRepliedMessageId: params.toMessageId }
            : {}),
          // NOTE: unconditional, unlike the id: it means "the last time our side spoke here", which a
          // claim below the mark still is (the follow-up's activation fence reads it). Set at claim
          // time, not delivery, and left set when the send fails, like the id: the claim is never
          // given back (see `runLoadedTurn`), and splitting the two columns would hand the fence's
          // readers contradicting answers.
          lastRepliedAt: new Date(),
          // NOTE: the per-message era starts here, once, at the max of the two scalars (the floor
          // `readAnsweredFloor` computes): `handled` alone would leave an already claimed message
          // above the floor, where "no row" reads as open. Written only while null.
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

// Which of these messages a turn has already claimed. Read only by the operator's re-engage, which
// builds its burst from the channel (everything after the last outgoing): a claim whose send failed
// leaves a message in that tail with a row that is never removed, and since the claim is
// all-or-nothing it would roll back every future click. CLAIMED only: a dispensal is what the
// button exists to overturn.
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

// What the rows say above the per-message floor, plus the floor and the `/reset` fence from the same
// row. Above the floor every decision writes a row (a claim or a dispensal), so a message there is
// open unless one says otherwise; below it the scalars decide. `resetAt` rides along because `/reset`
// writes a dispensal for its own id only, and the burst it retires has no row at all.
export async function readSelectionState(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  messageIds: readonly number[];
  base?: PrismaClient;
}): Promise<SelectionState> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: { id: params.conversationDbId },
      select: { replyClaimFloorMessageId: true, resetAtMessageId: true },
    });
    const floor = conv?.replyClaimFloorMessageId ?? null;
    const resetAt = conv?.resetAtMessageId ?? null;
    const ids =
      floor === null ? [] : params.messageIds.filter((m) => m > floor);
    if (ids.length === 0) {
      return {
        floor,
        resetAt,
        claimed: new Set<number>(),
        dispensed: new Set<number>(),
      };
    }
    const lowest = Math.min(...ids);
    const [rows, ranges] = await Promise.all([
      db.messageReplyClaim.findMany({
        where: {
          conversationId: params.conversationDbId,
          messageId: { in: [...ids] },
        },
        // NOTE: the reason matters, not only the row: `CLAIMED` closes a message for both reply and
        // memory, `DISPENSED` only for the reply (see `SelectionState`).
        select: { messageId: true, reason: true },
      }),
      // NOTE: bounded by the lowest candidate: a range ending below it covers none of them, and a
      // conversation accumulates one of these rows per gate exit.
      db.replyDispensal.findMany({
        where: {
          conversationId: params.conversationDbId,
          toMessageId: { gte: lowest },
        },
        select: { fromMessageId: true, toMessageId: true },
      }),
    ]);
    const claimed = new Set(
      rows.filter((r) => r.reason === "CLAIMED").map((r) => r.messageId),
    );
    // NOTE: any reason other than `CLAIMED` counts as dispensed, the forgiving direction for both
    // questions: the reply stands down, and the observer re-ingests (which is deduplicated).
    const dispensed = new Set(
      rows.filter((r) => r.reason !== "CLAIMED").map((r) => r.messageId),
    );
    for (const id of ids) {
      if (
        ranges.some(
          (r) =>
            id <= r.toMessageId &&
            (r.fromMessageId === null || id > r.fromMessageId),
        )
      ) {
        dispensed.add(id);
      }
    }
    return { floor, resetAt, claimed, dispensed };
  });
}

// The id of the newest public reply somebody else wrote (0 if none): every incoming message at or
// below it was answered by a person or another bot, which nothing in this runtime records.
// "Somebody else" needs evidence: a `user`, an AgentBot other than ours, or a sender-less row marked
// as sent from the paired phone, trusted only where the provider reserves echo ids (same rule as
// `isDeviceAttendantMessage`). An unattributed outgoing is NOT a boundary: our own reply whose send
// response was lost looks like that, and would silence a customer nobody answered.
// Exported for the post gates, which cannot use `selectOpenMessages`: they must not stand down on a
// message another turn claimed.
export function foreignReplyBoundary(
  page: readonly ChatwootMessageRow[],
  opts: ReplyIdentity,
): number {
  const deviceCounts = providerReservesEchoIds(opts.whatsappProvider);
  let boundary = 0;
  for (const m of page) {
    const somebodyElse =
      m.senderType === "user" ||
      (m.senderType === "agent_bot" &&
        (opts.managedBotId === null || m.senderId !== opts.managedBotId)) ||
      (m.senderType === null &&
        m.externalSenderName === SESSION_SENDER_NAME &&
        deviceCounts);
    if (
      (m.messageType === "outgoing" || m.messageType === "template") &&
      !m.private &&
      // NOTE: a reaction is not a reply. The fork stores an operator's emoji react as a public
      // outgoing `user` message; same exclusion as `isHumanAgentMessage`.
      !m.isReaction &&
      // NOTE: an imported row is not a reply to anything live: the importer writes old history with
      // new ids, so an old phone answer sorts above today's customer message. Same exclusion as
      // `hasDeviceAttendantShape`, applied here because this page comes from the database.
      !m.imported &&
      somebodyElse &&
      m.id > boundary
    ) {
      boundary = m.id;
    }
  }
  return boundary;
}

// WHO WE ARE ON THIS CONVERSATION, which is what the boundary above compares against: the Chatwoot
// id of this tenant's agent bot, and the WhatsApp provider of the inbox it answers on. Both halves
// are REQUIRED of the caller rather than defaulted, for the reason `isDeviceAttendantMessage` gives
// about its own: a caller that forgot would lose the fence silently on one route and turn it on
// where it is unsafe on the other.
export interface ReplyIdentity {
  managedBotId: number | null;
  whatsappProvider: string | null;
}

// What the rows say about a set of messages. Two sets because only one is about replying: a claim
// means a turn took the message into memory, a dispensal only that nobody will reply to it. The
// split is by `reason`, not by table: `message_reply_claims` holds both words and
// `reply_dispensals` holds ranges of the second.
export interface SelectionState {
  floor: number | null;
  resetAt: number | null;
  claimed: Set<number>;
  dispensed: Set<number>;
}

// "May I reply?": a reply somebody else wrote closes a message, and so does a dispensal.
// "Should I remember?": neither does, since memory holds what the customer said. A claim closes
// both, and so does `/reset`. A union rather than a flag, so the reply identity is required exactly
// where the boundary is computed.
export type SelectionPurpose =
  | ({ purpose: "reply" } & ReplyIdentity)
  | { purpose: "memory" };
// The messages on the page still open for the question `purpose` names. Every gate that asks it
// (the flush's burst, both supersede gates, the observer) calls this one function so they cannot
// drift. `scalarFloor` is `max(last_handled, last_replied)` and decides below the per-message floor;
// above it a message is open unless a row or a fence closes it (see `docs/debounce.md`).
export function selectOpenMessages(
  params: {
    page: readonly ChatwootMessageRow[];
    scalarFloor: number | null;
    state: SelectionState;
  } & SelectionPurpose,
): ChatwootMessageRow[] {
  const { page, scalarFloor, state } = params;
  const perMessage = state.floor;
  const pageArray = [...page];
  const forReply = params.purpose === "reply";
  const closedByOther = forReply ? foreignReplyBoundary(pageArray, params) : 0;
  if (perMessage === null) {
    // NOTE: the foreign-reply fence applies before the per-message era too: the scalars never see
    // outgoing messages, and a burst carrying a message a person answered would be refused whole by
    // the post gate, including the newer message nobody touched, on every later flush.
    const floorHere =
      scalarFloor === null
        ? closedByOther > 0
          ? closedByOther
          : null
        : Math.max(scalarFloor, closedByOther);
    // NOTE: imports are fenced here too: a backfill that landed above the mark has no row to close
    // it.
    const desta = pendingIncoming(pageArray, floorHere);
    return forReply ? desta.filter((m) => !m.imported) : desta;
  }
  // NOTE: a reply a person wrote is the fence the rows cannot carry (it writes no row). Asymmetric on
  // purpose: an outgoing of ours closes only what its turn claimed, which the rows already say; one
  // that is not ours closes everything before it, because that person read the thread.
  return pendingIncoming(pageArray, null).filter((m) => {
    if (m.id <= perMessage) {
      return scalarFloor === null || m.id > scalarFloor;
    }
    if (state.claimed.has(m.id)) return false;
    // NOTE: a backfilled question is not an unanswered one. The importer writes no webhook, so the
    // row has no claim or dispensal, and above the floor that reads as owed: reopened, old requests
    // would run the model and its tools again. For the reply only: import is how history reaches
    // memory.
    if (forReply && m.imported) return false;
    // NOTE: a dispensal closes the message for the reply only. The spend-ceiling refusal names every
    // member of its burst, and a flip to monitoring before the hand-over must still let the observer
    // remember them (the scalar half of this is `watermarkPastBurst` in ./handler.ts).
    if (forReply && state.dispensed.has(m.id)) return false;
    if (forReply && m.id <= closedByOther) return false;
    // NOTE: `/reset` writes a dispensal for its own id only, so the burst it retired carries no row
    // and would be offered again. Holds for both purposes: the memory it cleared must stay cleared.
    if (resetLandedAfter(m.id, state.resetAt)) return false;
    return true;
  });
}

export type ReplyClaimOutcome =
  | { won: true }
  | {
      won: false;
      // `partial`: part of the set was free and part was not. The refusal is still whole, but nothing
      // is coming for the unclaimed messages, so the flush reschedules on this reason and no other.
      reason: "claimed" | "handled" | "dispensed" | "partial";
    };

// The rollback signal for the all-or-nothing insert above. A thrown error is what aborts the
// interactive transaction; returning early would COMMIT the partial rows, which is the one outcome
// that must not happen: they would close messages for a turn that then sends nothing.
class LostReplyClaim extends Error {}

// The floor a flush must not re-answer below: the max of the watermark and the reply claim. The
// claim is written just before the send and the mark only after the turn returns, so a reply whose
// mark write failed (or a process exit) leaves the claim ahead, and the mark alone would let the
// next flush answer that message again. The mark is the half that covers deliberate skips.
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
// model, and the post-gate CAS only withholds the reply after the turn has already run its tools.
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
