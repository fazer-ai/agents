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
// Returns whether this call won, and the value it displaced — which the release below needs.
//
// UNDER THE ROW LOCK, and both halves of that matter. `FOR UPDATE` is taken BEFORE the value is
// read, so a claimant that arrives second waits here and then reads what its predecessor committed:
// read-then-write without it (and a self-join `UPDATE … FROM`, which reads `old` from the statement
// snapshot rather than from the row it waits on) can hand B the value that predated A, and B's
// release would then restore a mark A had already moved — handing a burst A answered back to a
// later retry.
//
// `requireUnhandled` is the second question the same lock has to answer atomically: "was this
// message already handled", read off the WATERMARK. The direct turn and the flush both need it —
// a late delivery for a message an earlier turn answered or skipped must stand down, and the losing
// CAS used to say so — and asking it outside this transaction leaves the window where a deliberate
// skip lands between the read and the claim. The manual re-engage passes `false`, and that is the
// whole of issue #452: it is the one path that answers a tail the watermark already covers.
export async function claimReplyBurst(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  toMessageId: number;
  requireUnhandled: boolean;
  base?: PrismaClient;
}): Promise<
  | { won: true; previous: number | null }
  | { won: false; reason: "claimed" | "handled"; previous?: never }
> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    const locked = await db.$queryRaw<
      Array<{ previous: number | null; handled: number | null }>
    >`SELECT "last_replied_message_id" AS "previous",
             "last_handled_message_id" AS "handled"
        FROM "conversations"
       WHERE "id" = ${params.conversationDbId}
         FOR UPDATE`;
    const row = locked[0];
    // No row is not this function's to explain: the conversation was deleted under a running turn,
    // and nothing may be posted for it.
    if (row === undefined) return { won: false, reason: "claimed" };
    if (row.previous !== null && row.previous >= params.toMessageId) {
      return { won: false, reason: "claimed" };
    }
    if (
      params.requireUnhandled &&
      row.handled !== null &&
      row.handled >= params.toMessageId
    ) {
      return { won: false, reason: "handled" };
    }
    await db.conversation.update({
      where: { id: params.conversationDbId },
      data: { lastRepliedMessageId: params.toMessageId },
    });
    // A LOSER HAS NO `previous`, and the type says so: it displaced nothing, and handing it the
    // column's current value is what would let a release roll back somebody else's claim.
    return { won: true, previous: row.previous };
  });
}

// GIVE THE CLAIM BACK when the turn threw before delivering anything. The claim is taken immediately
// BEFORE the send, so a Chatwoot failure leaves a burst nothing answered under a claim saying
// somebody did, and the retry the scheduler runs finds it and stands down — which is the behaviour
// docs/debounce.md already promised was not happening ("an LLM/Chatwoot error retries against the
// same burst"). Conditional on the claim still being ours: a later claimant that moved the column on
// is not to be rolled back.
export async function releaseReplyBurst(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  toMessageId: number;
  previous: number | null;
  base?: PrismaClient;
}): Promise<void> {
  const base = params.base ?? basePrisma;
  await runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    await db.conversation.updateMany({
      where: {
        id: params.conversationDbId,
        lastRepliedMessageId: params.toMessageId,
      },
      data: { lastRepliedMessageId: params.previous },
    });
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
