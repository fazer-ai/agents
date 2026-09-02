// THE HUMAN-REPLY TAKEOVER: a person answered the customer, so the conversation stops being the
// agent's to speak in (issue #430).
//
// It lives here rather than inline in the delivery because it now has TWO callers that are not the
// same process. The live one is the delivery that carried the reply; the other is the recovery for a
// delivery a process death stranded before this ever ran (issue #439, ./recover-takeover.ts). The
// second caller is the whole reason for the file: re-implementing these steps there would be a
// second copy of a fence whose every clause was paid for by a measurement, and the repo's own record
// says which way that goes — a second spelling is how one of the clauses comes to be missing from
// one of the two.
//
// WHAT THE CALLER STILL DECIDES, and it is deliberately not in here: whether a takeover is owed at
// all. That question is about the EVENT (a person wrote it, by which route) and about the AGENT
// (production, the switch in its settings), and the two callers answer it from different evidence —
// the live one from the payload it holds, the recovery from the shape the ledger kept. What is in
// here is what happens once the answer is yes, which is identical for both.
//
// The three primitives below moved with it, unchanged: they are the fence, the local handover and
// the toggle, and the gate's own gate-close path calls two of them.

import type { PrismaClient } from "@/../generated/prisma/client";
import { broadcastConversationEvent } from "@/api/features/realtime/realtime.service";
import logger from "@/api/lib/logger";
import type { RuntimeDeps } from "@/graph/runtime";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { emitFlowEvent } from "@/modules/flowlog/service";
import type { ChatwootClient } from "./client";
import { consoleWriteLandedAfter } from "./console-write-order";
import {
  describeClosedGate,
  describeHumanTakeover,
  type GateCloseDetail,
} from "./gate-close";
import { loadAgentBot, loadChatwootClient } from "./instance";
import {
  type HumanReplyRoute,
  heldByAnotherParty,
  parseLiveConversation,
  shouldBotHandle,
} from "./normalize";
import { reconcileMirrorFromLive } from "./reconcile";
import { statusClaimDeadline } from "./status-claim";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// WHETHER THE BOT STILL OWNS THIS CONVERSATION, read fresh from the mirror.
//
// One speller, because two callers ask it and they must agree: the gate's own fence
// (maybeConsumeCommandOrGate) and the human-reply takeover at the tail of handleDelivery. A second
// copy is how one of them comes to be missing a clause — this one has two that are not obvious.
//
// No resolvable persona means nothing can speak here, and "an AgentBot owns this" cannot be narrowed
// to "the sender owns this" without an id to compare against. shouldBotHandle answers the loose
// attribution question when the id is missing (its other callers depend on that), so the strict half
// is decided here, where the absence is known.
//
// NOTE: no test distinguishes that line today, and that is not an oversight: a persona that failed to
// resolve also leaves the client with an empty bot token, which never reaches the network. The line
// is here because the fence's answer must be right on its own terms — "we own this" is false when
// there is no "we" — rather than right because a lookup two layers down happens to fail too.
// EXACTLY THE COLUMNS THE FENCE ASKS FOR, named here because a test cannot identify this read any
// other way: the config load reads the same row with a superset of them, so a probe that wanted to
// stand in the fence's shoes has to match the projection WHOLE. Kept as one definition rather than
// copied into each probe, because a column added to the fence would otherwise silently stop three
// tests from injecting anything while leaving them green — and the projection was never the rule,
// only the proxy for "this is the fence's read".
//
// `assigneeId` is part of the question and not decoration: without it `shouldBotHandle` cannot tell
// OUR bot from another one. `consoleWriteAtMessageId` is a different axis from the version beside
// it (issue #469, ./console-write-order.ts).
export const OWNERSHIP_PROJECTION = {
  assigneeType: true,
  assigneeId: true,
  status: true,
  chatwootStatusAt: true,
  consoleWriteAtMessageId: true,
} as const;

export async function conversationOwnershipNow(p: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  ourAgentBotId: number | null;
  base: PrismaClient;
}): Promise<
  // The OWNED answer carries the row it was read off, because a caller that acts on this reading has
  // to be able to write CONDITIONALLY on it, and a second read to fetch those columns would answer
  // about a different moment — the same rule `describeClosedGate` states from its own side. All
  // three: `statusAt` is the status version (`chatwoot_status_at`), and the assignee comes along
  // beside it because status and assignee are ordered INDEPENDENTLY (state-order.ts keeps a mark per
  // axis), so the status version says nothing about who holds the conversation.
  | {
      ours: true;
      statusAt: number | null;
      assigneeType: string | null;
      assigneeId: number | null;
      // The fourth is a different axis, not a fourth version: where the last UNVERSIONED console
      // write on this row stands in the source's message sequence (issue #469,
      // ./console-write-order.ts). `statusAt` cannot answer for it, because that write left every
      // version mark where the pre-click state put them.
      consoleWriteAtMessageId: number | null;
    }
  | { ours: false; closed: GateCloseDetail | null }
> {
  const conv = await runScopedOn(p.base, sysCtx(p.tenantId), (db) =>
    db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId: p.tenantId,
          chatwootInstanceId: p.instanceId,
          chatwootConversationId: p.conversationId,
        },
      },
      select: OWNERSHIP_PROJECTION,
    }),
  );
  if (p.ourAgentBotId === null && conv?.assigneeType === "AgentBot") {
    return { ours: false, closed: null };
  }
  const ours = shouldBotHandle(
    {
      assigneeType: conv?.assigneeType ?? null,
      assigneeId: conv?.assigneeId ?? null,
      status: conv?.status ?? null,
    },
    { ourAgentBotId: p.ourAgentBotId },
  );
  return ours
    ? {
        ours: true,
        statusAt: conv?.chatwootStatusAt ?? null,
        assigneeType: conv?.assigneeType ?? null,
        assigneeId: conv?.assigneeId ?? null,
        consoleWriteAtMessageId: conv?.consoleWriteAtMessageId ?? null,
      }
    : {
        ours: false,
        closed: describeClosedGate({
          assigneeType: conv?.assigneeType ?? null,
          status: conv?.status ?? null,
        }),
      };
}

// OPENING A CONVERSATION FOR THE HUMAN QUEUE, for every path that ends the bot's attendance on one:
// the gates that refuse a turn before it runs, and a person answering the customer (issue #430).
//
// Status `open` is what ends the bot's attribution, so this IS the handoff; the optional team
// assignment only routes it, and a routing miss must never undo the open. Shared rather than written
// per caller (issue #146): the fence below is the part that is easy to leave out, and a second copy
// of it would be the copy that forgets.
//
// The fence: deciding to hand over can take time — a gate waits on somebody else's endpoint, and
// building the client resolves DNS — and a human can claim, resolve or reassign the conversation
// while it does. Without the re-check the copy was correctly withheld and the conversation was
// reopened and re-routed anyway, pulling a human's conversation back out of their hands by a gate
// that had already decided to stay quiet.
//
// THE CLIENT IS BUILT FIRST, and the fence answered after it, which is the whole point of the order.
// `assertSafeOutboundUrl` resolves the base URL's host, so constructing the client is a network round
// trip; asking first and building second puts that trip BETWEEN the answer and the write it guards,
// which is the window the fence exists to close. Nothing is written while the client is built, so
// moving it ahead costs nothing.
/**
 * The takeover's own write: claim the mirrored row `open` for the human queue, if it is still the row
 * this delivery decided about (issue #430), and announce the claim in the same statement (issue
 * #436). Answers whether the claim was taken.
 *
 * Answers with the deadline it wrote, which is the caller's proof it holds this claim and the value
 * its reconcile passes back as `ownsStatusClaim`. Null when the compare-and-swap lost.
 *
 * Exported for the test that pins the lock below; the call site is the human-reply gate, which has
 * asked Chatwoot first and is about to toggle.
 */
export async function claimOpenForHumanQueue(p: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  /** The row this delivery decided about, which the compare-and-swap pins. */
  seen: {
    statusAt: number | null;
    assigneeType: string | null;
    assigneeId: number | null;
  };
  base: PrismaClient;
}): Promise<Date | null> {
  return runScopedOn(p.base, sysCtx(p.tenantId), (db) =>
    // UNDER THE CONVERSATION'S OWN LOCK, the same one `mirrorChatwootEvent` and
    // `reconcileMirrorFromLive` take, because the compare-and-swap alone does not order this against
    // a transaction that has ALREADY READ the row and has not written yet. That mirror would then
    // commit its decision — computed from a row with no claim on it — straight over this `open`, and
    // the agent answers over the person (issue #468, round 8). The predicate is what orders it
    // against a write that has already committed; the lock is what orders it against one that has
    // not. Safe to hold here and nowhere near the toggle: this is one statement and no round trip.
    withEntityLock(
      db,
      `${p.tenantId}:${p.instanceId}:${p.conversationId}`,
      async () => {
        // THE COUNTDOWN STARTS HERE, past the lock and the connection, because everything before this
        // point is queueing rather than fencing: a deadline stamped ahead of it spends part of the
        // window on the wait and reports a fence it is no longer giving (issue #468, round 9). The TTL
        // is sized off the round trips that follow, and they all follow this line.
        const claimUntil = statusClaimDeadline(new Date());
        const { count } = await db.conversation.updateMany({
          where: {
            tenantId: p.tenantId,
            chatwootInstanceId: p.instanceId,
            chatwootConversationId: p.conversationId,
            status: "pending",
            chatwootStatusAt: p.seen.statusAt,
            assigneeType: p.seen.assigneeType,
            assigneeId: p.seen.assigneeId,
          },
          data: {
            status: "open",
            statusClaimUntil: claimUntil,
            // The status this write replaced, which the predicate above pins to `pending`, and the two
            // columns the claim starts EMPTY: the source has stamped no version for this transition
            // yet, and nothing has been refused on its account. A stale pair from an earlier claim
            // would otherwise be read as this one's (../../modules/chatwoot/status-claim.ts).
            statusClaimFrom: "pending",
            statusClaimStampedAt: null,
            statusClaimRefusedAt: null,
          },
        });
        return count > 0 ? claimUntil : null;
      },
    ),
  );
}

// WHAT HAPPENED, not just whether it worked, and the distinction is the caller's to act on: a fence
// that stood down is a VERDICT about the conversation, while a call that threw is an unknown. The
// live delivery does the same thing with both (nothing), which is why this was a boolean for as long
// as it had one caller; the recovery is a scheduler job, and mapping a refusal to `fail` spends a
// backoff ladder and dead-letters a job for a conversation that simply owes nothing.
export type HumanQueueOutcome = "opened" | "refused" | "failed";

export async function openForHumanQueue(p: {
  // Names the caller in every line this writes; it is what an operator reads to know which path
  // handed the conversation over.
  gate: string;
  conversationId: number;
  stillOurs: () => Promise<boolean>;
  client: () => Promise<ChatwootClient>;
  teamId?: number | null;
  teamUsable?: (id: number) => Promise<boolean>;
}): Promise<HumanQueueOutcome> {
  const teamId = p.teamId ?? null;
  try {
    const client = await p.client();
    if (!(await p.stillOurs())) {
      logger.info(
        "chatwoot: %s handoff skipped (conv=%s) — the conversation is no longer the bot's",
        p.gate,
        String(p.conversationId),
      );
      return "refused";
    }
    await client.toggleStatus(p.conversationId, "open");
    if (teamId !== null && (await (p.teamUsable?.(teamId) ?? true))) {
      try {
        await client.assignTeam(p.conversationId, teamId);
      } catch (err) {
        logger.warn(
          "chatwoot: %s team assignment failed (conv=%s): %s",
          p.gate,
          String(p.conversationId),
          errMsg(err),
        );
      }
    }
    return "opened";
  } catch (err) {
    logger.warn(
      "chatwoot: %s handoff failed (conv=%s): %s",
      p.gate,
      String(p.conversationId),
      errMsg(err),
    );
    return "failed";
  }
}

export interface HumanReplyTakeoverParams {
  tenantId: bigint;
  instanceId: bigint;
  // Chatwoot's per-account DISPLAY id.
  conversationId: number;
  // WHICH route the person answered by. Reported, never re-derived: the caller that acted and the
  // line that says why must not be able to disagree.
  route: HumanReplyRoute;
  // The Chatwoot Agent Bot id the ownership question compares against — "our bot", for this caller.
  // The live delivery passes the ROUTE's bot (see the fence below); the recovery has no route and
  // passes the inbox persona's, which is the same identity the token belongs to.
  ourAgentBotId: number | null;
  // The agent this conversation's inbox is bound to, for the flow line.
  agentId: bigint;
  // The SOURCE version the decision was made on, in epoch seconds, or null when there was none. It
  // is what lets a hand-back that landed after the reply outrank this write; a caller with nothing
  // to compare passes null and the ordering check is skipped, exactly as it is for a Chatwoot that
  // sends no `updated_at` (issue #77).
  decidedAtVersion: number | null;
  // The Chatwoot message id this decision is ABOUT — the colleague's own reply — which is what
  // orders it against a console write that could not be versioned (issue #469,
  // ./console-write-order.ts). Null where the caller cannot name one: a ledger row an older build
  // wrote, on the recovery path. The fence then has nothing to order and does not refuse.
  decidedAtMessageId: number | null;
  // The mirror's own row id and event clock, for the console broadcast and the flow line. Null where
  // the mirror does not know the conversation, in which case neither is written.
  conversationRowId: bigint | null;
  lastEventAt: Date | null;
  base: PrismaClient;
  // The client factory, injectable exactly the way the runtime injects it, so a test drives this
  // unit against a fake Chatwoot without a second seam.
  makeClient?: RuntimeDeps["makeClient"];
  // FINISHING A TAKEOVER WHOSE REMOTE HALF DID NOT LAND, rather than deciding a new one. Present
  // (even as `null`) puts this in that mode; absent is the ordinary live delivery.
  //
  // The claim is written before the toggle (#430), so a process that died between the two — the
  // widest gap in the block, and therefore the likeliest death — left the row `open` from `pending`
  // with Chatwoot never told. Two steps then do not apply and exactly two: the mirror's ownership
  // read, which would see our own `open` and call it somebody else's, and the claim CAS, which would
  // find the row already moved. Everything else is the same code, because everything else is the
  // same question — and a version of this that reimplemented "just the toggle and the reconcile"
  // spent three review rounds rediscovering, one at a time, the things the fence does that it did
  // not: the live ownership check, the flow line, and the fact that it could never run at all.
  //
  // The value is the row's stored deadline, expired or not, and it travels only to the reconcile,
  // which compares it for EQUALITY to know the write is the claim's owner. It is NOT a liveness
  // test: the claim stands for 45 seconds (STATUS_CLAIM_TTL_MS) and the sweep does not call a
  // delivery stranded for 30 minutes (STALE_AFTER_MS), so anything finishing one arrives long after
  // the deadline. What authorises the write is the live read, as it is in the other mode.
  heldClaimUntil?: Date | null;
}

// Says WHICH of the three happened, because the two callers need different amounts of it. The live
// delivery does the same thing with `refused` and `failed` — nothing — while the recovery is a
// scheduler job, and a refusal mapped to a failure spends its backoff ladder and dead-letters a job
// about a conversation that owes nothing.
export async function runHumanReplyTakeover(
  p: HumanReplyTakeoverParams,
): Promise<HumanQueueOutcome> {
  const conversationId = p.conversationId;
  const convLabel = String(conversationId);
  // Hoisted out of the try only so the caller can be told, which the inline version had no need to
  // do. Every road that does not reach the open leaves it at the failure it started on: the one
  // thing that can reach the catch below is the persona lookup, which throws rather than refusing.
  let outcome: HumanQueueOutcome = "failed";
  // Present at all — `null` included — is the finishing mode. A boolean of its own would be a second
  // thing to keep in step with the value it describes.
  const finishing = p.heldClaimUntil !== undefined;
  try {
    // Resolved ONCE and handed to both halves: the token the client speaks with, and the id the
    // ownership question compares against. They are the same lookup for the reason the gate's own
    // persona resolution states — a fence that answers about one identity while the client posts as
    // another is not a fence.
    const bot = await loadAgentBot(p.tenantId, p.instanceId, p.agentId, p.base);
    // Memoized, because two things need it and building it resolves the base URL's host. A second
    // construction would be a second DNS round trip for one delivery.
    let clientOnce: Promise<ChatwootClient> | null = null;
    const client = (): Promise<ChatwootClient> =>
      (clientOnce ??= loadChatwootClient(p.tenantId, p.instanceId, {
        base: p.base,
        botToken: bot?.accessToken,
        makeClient: p.makeClient,
      }));
    // THE FENCE AND THE LOCAL HANDOVER ARE ONE WRITE, and that ordering is the decision here.
    // Everything that decides whether the agent may still speak reads `shouldBotHandle` off THIS
    // ROW and never off Chatwoot: the runtime's recheck after the model call, the debounce flush
    // before its turn, the follow-up ladder's eligibility, the nudge's own checks. The row is what
    // silences them, so until it moves they all still answer "the bot owns this".
    //
    // Writing it after the toggle left that window open for the toggle's own duration, plus the
    // DNS resolution that building the client costs. A turn already running when the person
    // replied reaches its recheck inside that window, reads `pending`, and posts on top of them —
    // the very bug this block exists to prevent, surviving as a narrower one. So the row moves at
    // the instant the fence answers, in one statement, with nothing that waits on a network
    // between the two.
    //
    // Three questions, asked of one read so none of them can answer about a different moment: is
    // the conversation still the bot's, is this decision still the most recent one about it, and
    // is the row still the one all of that was true of. The first is ownership, the second is
    // ordering, and the third is the compare-and-swap that carries them into the write. `pending`
    // alone answers none of them — a hand-back writes `pending` too.
    // NO PERSONA, NO TAKEOVER — decided HERE, rather than discovered from the toggle throwing.
    // Without a bot row on this instance every call this path makes goes out with an empty token
    // (issue #79), so the open cannot succeed; and since the claim is written before the toggle,
    // learning that from the exception would leave the row `open` on a conversation Chatwoot never
    // moved. Keeping the claim is right for an UNKNOWN outcome, which is what a failed call is.
    // This one is known before anything is written.
    if (!bot) {
      logger.info(
        "chatwoot: %s handoff skipped (conv=%s) — the agent has no bot on this instance",
        `human reply (${p.route})`,
        convLabel,
      );
    }
    // The claim this delivery took, or null if it never got to write one. Held out here because
    // the two halves that need it are on the other side of the fence closure: the release below,
    // and the reconcile, which is the one write allowed THROUGH a claim it owns.
    let claimHeld: Date | null = null;
    // NO PERSONA IS A REFUSAL, not a failure: it is decided here, from the row, before anything is
    // written or called, which is exactly what makes it a verdict.
    outcome = !bot
      ? "refused"
      : await openForHumanQueue({
          gate: `human reply (${p.route})`,
          conversationId,
          stillOurs: async () => {
            // CHATWOOT FIRST, because the mirror can be BEHIND it and the act guarded here is a
            // write to Chatwoot. An attendant who answers and then immediately resolves or hands
            // the conversation back does both before this detached delivery runs; the resolve's own
            // webhook is still in flight, so the row still says `pending` and the toggle would
            // reopen the conversation the operator just closed. The same shape /reset guards with
            // `refreshFromLive` before its own irreversible half.
            //
            // A GATE ONLY, deliberately not a reconcile. Writing this read onto the row would stamp
            // it with a version newer than the message that decided this takeover, and the ordering
            // check below — which exists to let a hand-back's `pending` outrank ours — would then
            // refuse every takeover there is.
            //
            // An UNREADABLE answer does not block: silence is not evidence that somebody took the
            // conversation, and the mirror fence below is the reading this path had before.
            //
            // AN UNREADABLE ANSWER DOES NOT BLOCK when a takeover is being DECIDED: silence is not
            // evidence that somebody took the conversation, and the mirror fence below is the
            // reading this path had before. When one is being FINISHED it does block, and it blocks
            // by throwing: there is no mirror fence left to fall back on in that mode — our own
            // `open` is what it would read — so a blind write is the one thing left to prevent, and
            // an unknown is a `failed` for the scheduler rather than a verdict.
            //
            // TWO SHAPES OF "no answer", and only one of them is an exception. A refused or timed
            // out request throws on its own here (no `.catch` in this mode). A 200 whose body is not
            // a conversation — a proxy's error page, a truncated response — parses to `null`, and
            // that is what the guard below is for.
            const live = parseLiveConversation(
              finishing
                ? await (await client()).getConversation(conversationId)
                : await (await client())
                    .getConversation(conversationId)
                    .catch(() => null),
            );
            if (finishing && live === null) {
              throw new Error("Chatwoot did not answer");
            }
            // THE SAME OWNERSHIP QUESTION IN BOTH MODES, which is the whole of round 4's P1: a
            // conversation Chatwoot reassigned while the row sat stranded is still `pending` there,
            // and a check that read only the STATUS would toggle it out of another bot's or
            // person's queue.
            //
            // The STATUS half is where the two modes legitimately differ, and it is the only place
            // they do. Deciding a takeover means the conversation must still be `pending` — that is
            // `shouldBotHandle`, unchanged. FINISHING one also accepts `open`, because that is what
            // our own first attempt would have left if it reached Chatwoot and only its response was
            // lost. The POSSESSION half is literally the same predicate in both, not a second
            // spelling of it.
            const stillPossible =
              live === null ||
              (finishing
                ? (live.status === "pending" || live.status === "open") &&
                  !heldByAnotherParty(
                    {
                      assigneeType: live.assigneeType,
                      assigneeId: live.assigneeId,
                    },
                    { ourAgentBotId: p.ourAgentBotId },
                  )
                : shouldBotHandle(
                    {
                      assigneeType: live.assigneeType,
                      assigneeId: live.assigneeId,
                      status: live.status,
                    },
                    { ourAgentBotId: p.ourAgentBotId },
                  ));
            if (live !== null && !stillPossible) {
              logger.info(
                "chatwoot: %s handoff skipped (conv=%s) — Chatwoot already moved the conversation on (%s)",
                `human reply (${p.route})`,
                convLabel,
                live.status,
              );
              return false;
            }
            // THE TWO STEPS THAT DO NOT APPLY WHEN FINISHING, and nothing else is skipped. The
            // mirror says `open` because WE wrote it, so the ownership read would answer about our
            // own write; and the claim CAS is a `pending -> open` that has already happened.
            if (finishing) {
              claimHeld = p.heldClaimUntil ?? null;
              if (p.conversationRowId !== null && live !== null) {
                broadcastConversationEvent(p.tenantId, {
                  conversationId: String(p.conversationRowId),
                  status: "open",
                  assigneeId: live.assigneeId,
                  assigneeType: live.assigneeType,
                  lastEventAt: p.lastEventAt
                    ? p.lastEventAt.toISOString()
                    : null,
                });
              }
              return true;
            }
            const now = await conversationOwnershipNow({
              tenantId: p.tenantId,
              instanceId: p.instanceId,
              conversationId,
              // THE ROUTE's bot, which is the identity `act` asked about, and asking a different
              // one here turns the re-check into a second, stricter gate. Measured: Chatwoot fans a
              // message to the conversation's assigned bot AND the inbox's, so on a conversation
              // held by another persona's bot the assigned-bot delivery passes `act` and this fence
              // — asked about the inbox persona — would reject it, while the inbox-bot delivery
              // never passes `act` at all. Neither takes over, and the conversation a person just
              // answered stays `pending`.
              //
              // The TOKEN below stays the inbox persona's, and the two are not in conflict because
              // they answer different questions: the fence asks whether THIS DELIVERY may still act,
              // and the token asks who we are on this instance. The write is a conversation's state,
              // not a persona's utterance.
              ourAgentBotId: p.ourAgentBotId,
              base: p.base,
            });
            if (!now.ours) return false;
            // AND IS THIS DECISION STILL THE MOST RECENT ONE? Ownership alone cannot answer that,
            // because the state that would overrule us is `pending` and bot-owned too: a hand-back
            // ("Return to AI", conversations/service.ts) puts the conversation back exactly there. So
            // the two `pending`s are told apart the way every other out-of-order question in this
            // module is — by version, with the rule state-order.ts states: a row stamped AHEAD of the
            // payload that drove this decision is a later answer about the same conversation, and a
            // later answer wins. Without it the operator who just asked for the agent back watches the
            // request undone by a reply they had already sent.
            //
            if (
              now.statusAt !== null &&
              p.decidedAtVersion != null &&
              p.decidedAtVersion < now.statusAt
            ) {
              return false;
            }
            // AND THE HAND-BACK THAT COULD NOT BE VERSIONED, which the comparison above is blind to
            // by construction (issue #469). `mirrorConsoleWrite` falls back to a write that stamps
            // no version whenever its live read fails or carries none (issue #77), so the row still
            // names the pre-click state and a delivery frozen BEFORE the click compares equal and
            // passes — putting the agent back on a conversation the operator had just asked for it
            // to leave, one click ago.
            //
            // The axis is the SOURCE's message sequence, which is the one coordinate both sides can
            // hold: the console reads the newest message Chatwoot has, and this delivery IS a
            // message. At or below it, the reply already existed when the operator clicked; above
            // it, the reply was written afterwards and is a genuine handover this must still act
            // on — the property that made a deadline-based claim the wrong instrument here, since
            // it would skip both. ./console-write-order.ts carries why no version and no clock of
            // ours can answer instead.
            if (
              consoleWriteLandedAfter(
                p.decidedAtMessageId ?? null,
                now.consoleWriteAtMessageId,
              )
            ) {
              logger.info(
                "chatwoot: %s handoff skipped (conv=%s) — an operator handed the conversation back after this message (msg=%s <= %s)",
                `human reply (${p.route})`,
                convLabel,
                String(p.decidedAtMessageId),
                String(now.consoleWriteAtMessageId),
              );
              return false;
            }
            // UNVERSIONED, and only the field the action changed — the same fallback the console
            // takes when its live read cannot be ordered (mirrorConsoleWrite, issue #77). Claiming no
            // version is what lets a conversation event that really is newer still outrank this write
            // when it lands; the reconcile below is what earns it one.
            //
            // The three observed columns in the predicate are what make this a compare-and-swap
            // rather than a check-then-act: the read above and this write are two statements, and
            // another replica can commit between them. The assignee is in there for its own reason —
            // status and assignee carry SEPARATE ordering marks, so an assignment that lands in this
            // window leaves the conversation `pending` at the same `chatwoot_status_at` while it is no
            // longer the bot's, and a status-and-version predicate would open it anyway.
            //
            // No test in this process can pry that window open — there is nothing to await between the
            // two statements — so the mutations that drop these terms survive the suite. They stay
            // because the window is real, not because a test asks for them.
            //
            // AND THE WRITE ANNOUNCES ITSELF, in the same statement that makes it, because that is
            // the whole of issue #436: this `open` claims no version, so until the reconcile earns
            // one for it every payload still in flight compares greater and walks it back — a
            // customer message through the reopen exception, a delayed `conversation_*` event
            // through the ordinary ordered path. The claim says which status this write replaced and
            // how long it refuses that status, and ../../modules/chatwoot/status-claim.ts holds why
            // it can be neither a version nor a permanent flag.
            //
            const claimUntil = await claimOpenForHumanQueue({
              tenantId: p.tenantId,
              instanceId: p.instanceId,
              conversationId,
              seen: now,
              base: p.base,
            });
            // A LOST CAS IS A CLOSED FENCE, reported by the shared unit exactly like an ownership
            // refusal, because that is what it is: something newer than the state this delivery
            // decided on now holds the row.
            if (claimUntil === null) return false;
            claimHeld = claimUntil;
            // AND THE CONSOLES HEAR ABOUT IT, from the write that happened rather than from the
            // call that may not. This delivery already broadcast the mirror's post-write snapshot
            // upstream, and that one still said `pending` — the claim had not been taken yet — so
            // without this every open Conversations page keeps naming the bot as the owner while
            // the row and the gate say a person is on it. After a successful open Chatwoot's own
            // conversation event corrects it a moment later; after a failed one nothing ever does,
            // and a failed open deliberately keeps the claim.
            //
            // The assignee is the one the fence just read, not a re-read: this write moved status
            // and nothing else, so anything else would be describing a different moment.
            if (p.conversationRowId !== null) {
              broadcastConversationEvent(p.tenantId, {
                conversationId: String(p.conversationRowId),
                status: "open",
                assigneeId: now.assigneeId,
                assigneeType: now.assigneeType,
                lastEventAt: p.lastEventAt ? p.lastEventAt.toISOString() : null,
              });
            }
            return true;
          },
          client,
        });
    // AND A FAILED OPEN KEEPS THE CLAIM. The tempting compensation is to hand it back — the row
    // says `open` while Chatwoot may still say `pending`, and nobody was handed anything — but a
    // failed call is an UNKNOWN outcome, not a refusal: Chatwoot commits the transition and then
    // the response times out, is lost in a proxy, or fails to parse, and there is nothing in the
    // error that tells that apart from a request the server never applied. Rolling back on the
    // unknown puts the agent back to speaking into a conversation the platform HAS handed over,
    // which is the defect this whole block exists to prevent, reintroduced by the recovery.
    //
    // So the claim stands and the agent stays quiet, which is the direction a fence must fail in.
    // The disagreement is not durable either: the next customer message carries the reopen
    // exception (state-order.ts), so a conversation Chatwoot really did leave `pending` comes back
    // to the agent on its own, and one Chatwoot really did open stays open.
    //
    // AND THE CLAIM SAYS SO ON THE ROW UNTIL THE RECONCILE STAMPS IT (issue #436). Deliveries for
    // a conversation are dispatched detached and never serialized (chatwoot.controller.ts), so
    // anything committing between the write above and the reconcile below does so against a row
    // whose `chatwoot_status_at` still names the state before the claim — and the three ways in
    // were measured, not supposed:
    //
    //   - a customer message serialized before Chatwoot committed the toggle carries the old
    //     `pending`, and the reopen exception lets a message move status;
    //   - a delayed or companion `conversation_*` event carrying that same pre-takeover `pending`
    //     wins on version, because the claim advanced none;
    //   - on a deployment that sends no `updated_at` at all, the ordering check above is skipped
    //     and a hand-back committed while the client is built is captured as the current state.
    //
    // In each the row went back to `pending` and a turn passed its recheck and answered over the
    // person. What closes all three is the claim: it is refused by name, by the same rule and in
    // the same place every other ordering question is decided (state-order.ts), and it needs no
    // version, which is what the third way in has none of.
    //
    // AND A FAILED OPEN KEEPS IT, which is the same answer #430 already gives to the claim itself.
    // A toggle that throws is an UNKNOWN outcome, not a refusal — Chatwoot commits the transition
    // and the response is lost — so releasing here would let a payload frozen before the toggle put
    // the agent straight back into a conversation the platform HAS handed over. What the deadline
    // costs on this path is a delay rather than the recovery: the conversation Chatwoot really did
    // leave `pending` comes back to the agent when the claim runs out, instead of on the next
    // customer message.
    //
    // Refused by the fence, or the write failed: both are already reported by the shared unit, and
    // neither is a takeover — so nothing below runs. NOT a `return`: the delivery still has its
    // memory ingestion to arm and its row to mark processed.
    if (outcome === "opened") {
      // AND THEN FROM A LIVE READ, which is what claims a version for it — the toggle endpoint
      // renders a status blob and no `updated_at`, so there is none to write from the call itself
      // (mirrorConsoleWrite, issue #77).
      //
      // The write above already makes a re-delivery a no-op through the gate (`act` reads that row
      // and a message payload moves no status of its own — state-order.ts: only a brand-new
      // INCOMING message carries the reopen exception). What the version buys is ORDERING: an
      // unversioned `open` leaves `chatwootStatusAt` where it was, so a delayed conversation event
      // carrying an older status can still win over it. The reconcile stamps the row with the
      // version Chatwoot actually produced for this change, and a webhook that landed meanwhile
      // outranks the GET instead of being overwritten by it.
      //
      // A read with no version is DISCARDED rather than written blind: a snapshot nothing can place
      // in time cannot be ordered against the events still in flight, and the row already says
      // `open` without it.
      try {
        const live = parseLiveConversation(
          await (await client()).getConversation(conversationId),
        );
        if (live && live.updatedAt !== null) {
          await reconcileMirrorFromLive({
            tenantId: p.tenantId,
            instanceId: p.instanceId,
            conversationId,
            live,
            // THROUGH OUR OWN CLAIM, which is the one write that must not be fenced by it: this
            // read is what earns the claim the version it was taken without, and refusing it would
            // leave the row unversioned for the claim's whole life and then hand it back to the
            // ordering that could not decide it.
            ownsStatusClaim: claimHeld,
            base: p.base,
          });
        }
      } catch (err) {
        logger.warn(
          "chatwoot: reconciling the mirror after the takeover failed (conv=%s): %s",
          convLabel,
          errMsg(err),
        );
      }
      logger.info(
        "chatwoot: a person answered the customer (%s) — conversation opened for the human queue (conv=%s)",
        p.route,
        convLabel,
      );
      // The operator's trail, at the moment it happened. Without it the agent simply stops
      // answering and the only line anywhere is on the NEXT customer message, where the gate
      // reports `ownership_lost` — true about the status and wrong about the cause. The word and
      // the reason both live in ./gate-close.ts, the one speller of this vocabulary.
      if (p.conversationRowId !== null) {
        emitFlowEvent(
          {
            tenantId: p.tenantId,
            turnId: crypto.randomUUID(),
            source: "inbox",
            conversationId: p.conversationRowId,
            agentId: p.agentId,
            base: p.base,
          },
          {
            stage: "handoff",
            status: "ok",
            detail: describeHumanTakeover(p.route),
          },
        );
      }
    }
  } catch (err) {
    // Only the persona lookup can reach here: the open and the reconcile report their own. Left
    // best-effort for the same reason they are — a takeover that could not be written must not
    // strand the delivery that carried the reply.
    logger.warn(
      "chatwoot: the human-reply takeover could not run (conv=%s): %s",
      convLabel,
      errMsg(err),
    );
  }
  return outcome;
}
