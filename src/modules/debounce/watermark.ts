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

export interface AdvanceHandledWatermarkParams {
  tenantId: bigint;
  conversationDbId: bigint;
  // Chatwoot id of the newest message now considered handled.
  toMessageId: number;
  base?: PrismaClient;
}

// Returns true when this call moved the watermark (the CAS won), false when a concurrent writer
// already advanced it past `toMessageId`.
export async function advanceHandledWatermark(
  params: AdvanceHandledWatermarkParams,
): Promise<boolean> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, sysCtx(params.tenantId), async (db) => {
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
  base?: PrismaClient;
}): Promise<{ won: true } | { won: false; reason: "claimed" | "handled" }> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    const locked = await db.$queryRaw<
      Array<{ claimed: number | null; handled: number | null }>
    >`SELECT "last_replied_message_id" AS "claimed",
             "last_handled_message_id" AS "handled"
        FROM "conversations"
       WHERE "id" = ${params.conversationDbId}
         FOR UPDATE`;
    const row = locked[0];
    // No row is not this function's to explain: the conversation was deleted under a running turn,
    // and nothing may be posted for it.
    if (row === undefined) return { won: false, reason: "claimed" };
    if (row.claimed !== null && row.claimed >= params.toMessageId) {
      return { won: false, reason: "claimed" };
    }
    if (
      row.handled !== null &&
      (params.maxHandledAllowed === null ||
        row.handled > params.maxHandledAllowed)
    ) {
      return { won: false, reason: "handled" };
    }
    await db.conversation.update({
      where: { id: params.conversationDbId },
      data: { lastRepliedMessageId: params.toMessageId },
    });
    return { won: true };
  });
}

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
