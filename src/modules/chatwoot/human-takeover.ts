// The human-reply takeover: a person answered the customer, so the conversation stops being the
// agent's to speak in. Mechanism and ordering: docs/chatwoot.md, "A person answering the customer
// ends the attendance".
//
// One unit for two callers in different processes: the live delivery that carried the reply and
// the recovery of a delivery a process death stranded (./recover-takeover.ts). A second copy of the
// fence is how one of its clauses goes missing. Whether a takeover is owed at all stays with the
// caller, since each answers it from different evidence (the payload, or the ledger's shape).

import type { PrismaClient } from "@/../generated/prisma/client";
import { broadcastConversationEvent } from "@/api/features/realtime/realtime.service";
import logger from "@/api/lib/logger";
import type { RuntimeDeps } from "@/graph/runtime";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { emitFlowEvent } from "@/modules/flowlog/service";
import { type ChatwootClient, ChatwootStatusConflictError } from "./client";
import { consoleWriteLandedAfter } from "./console-write-order";
import {
  describeClosedGate,
  describeHumanTakeover,
  describeRefusedTakeover,
  type GateCloseDetail,
  type TakeoverRefusal,
} from "./gate-close";
import { loadAgentBot, loadChatwootClient } from "./instance";
import {
  type HumanReplyRoute,
  heldByAnotherParty,
  parseLiveConversation,
  shouldBotHandle,
} from "./normalize";
import { reconcileMirrorFromLive } from "./reconcile";
import { announceStatusChange } from "./status-announce";
import { statusClaimDeadline } from "./status-claim";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Exactly the columns the fence asks for, named once because a test can identify this read only by
// its projection (the config load reads a superset), and a column added to the fence would
// otherwise silently stop the probes from injecting anything while they stay green. `assigneeId`
// lets `shouldBotHandle` tell our bot from another; `consoleWriteAtMessageId` is a different axis
// from the version (./console-write-order.ts).
export const OWNERSHIP_PROJECTION = {
  assigneeType: true,
  assigneeId: true,
  status: true,
  chatwootStatusAt: true,
  chatwootStatusChangedAt: true,
  consoleWriteAtMessageId: true,
} as const;

// Whether the bot still owns this conversation, read fresh from the mirror. One speller for the
// gate's fence (maybeConsumeCommandOrGate) and the human-reply takeover, which must agree. No
// resolvable persona means "we own this" is false, since there is no "we": shouldBotHandle answers
// the loose question when the id is missing (its other callers depend on that), so the strict half
// is decided here. No test separates that line (a missing persona also leaves an empty token); it
// is here so the fence is right on its own terms.
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
      // Where the status last MOVED at the source, which is what "a later decision" means. The mark
      // above also moves on a restatement, and a person's reply makes Chatwoot emit one of its own a
      // few milliseconds after the reply's snapshot. Null on rows older than the column.
      statusChangedAt: number | null;
      assigneeType: string | null;
      assigneeId: number | null;
      // A different axis, not a fourth version: where the last unversioned console write stands in
      // the source's message sequence (./console-write-order.ts). `statusAt` cannot answer for it,
      // because that write left every version mark where the pre-click state put them.
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
        statusChangedAt: conv?.chatwootStatusChangedAt ?? null,
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

/**
 * The takeover's own write: claim the mirrored row `open` for the human queue if it is still the
 * row this delivery decided about, and announce the claim in the same statement. Answers with the
 * deadline it wrote (the caller's proof it holds the claim, passed back to the reconcile as
 * `ownsStatusClaim`), or null when the compare-and-swap lost. Exported for the test that pins the
 * lock below.
 */
export async function claimOpenForHumanQueue(p: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  /** The row this delivery decided about, which the compare-and-swap pins. */
  seen: {
    statusAt: number | null;
    statusChangedAt: number | null;
    assigneeType: string | null;
    assigneeId: number | null;
    // The fourth term: ordered independently of the status version, so a console write can move it
    // while status, version and assignee stay unchanged (setting a bot-owned `pending` conversation
    // back to `pending`). Without it the swap would win against a newer decision.
    consoleWriteAtMessageId: number | null;
  };
  base: PrismaClient;
}): Promise<Date | null> {
  return runScopedOn(p.base, sysCtx(p.tenantId), (db) =>
    // NOTE: under the conversation's own lock (the one `mirrorChatwootEvent` and
    // `reconcileMirrorFromLive` take): the predicate orders this against a write already committed,
    // the lock against a transaction that has read the row and not yet written, which would
    // otherwise commit its claim-less decision over this `open`. One statement, no round trip.
    withEntityLock(
      db,
      `${p.tenantId}:${p.instanceId}:${p.conversationId}`,
      async () => {
        // The countdown starts past the lock and the connection: everything before is
        // queueing, not fencing, and a deadline stamped earlier would spend part of the window
        // waiting. The TTL is sized off the round trips that all follow this line.
        const claimUntil = statusClaimDeadline(new Date());
        const { count } = await db.conversation.updateMany({
          where: {
            tenantId: p.tenantId,
            chatwootInstanceId: p.instanceId,
            chatwootConversationId: p.conversationId,
            status: "pending",
            // The change mark when the row has one, not the status mark: the reply's own
            // conversation_updated moves the status mark between this delivery's read and this
            // write, so pinning it would lose the swap to a restatement. A status that really moved
            // in between moves the change mark too. A row from before the column has only the status
            // mark, and keeps it.
            ...(p.seen.statusChangedAt !== null
              ? { chatwootStatusChangedAt: p.seen.statusChangedAt }
              : { chatwootStatusAt: p.seen.statusAt }),
            assigneeType: p.seen.assigneeType,
            assigneeId: p.seen.assigneeId,
            consoleWriteAtMessageId: p.seen.consoleWriteAtMessageId,
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
        if (count === 0) return null;
        // The claim moves the status, so it announces it (./status-announce.ts): Chatwoot's own
        // event for our toggle finds the row already `open` and says nothing.
        const row = await db.conversation.findUnique({
          where: {
            tenantId_chatwootInstanceId_chatwootConversationId: {
              tenantId: p.tenantId,
              chatwootInstanceId: p.instanceId,
              chatwootConversationId: p.conversationId,
            },
          },
          select: { id: true, inboxId: true },
        });
        if (row) {
          await announceStatusChange(db, p.tenantId, {
            conversationId: row.id,
            inboxId: row.inboxId,
            status: "open",
            previousStatus: "pending",
            assigneeType: p.seen.assigneeType,
          });
        }
        return claimUntil;
      },
    ),
  );
}

// What happened, not just whether it worked: a fence that stood down is a verdict about the
// conversation, a call that threw is an unknown. The live delivery treats both alike; the recovery
// is a scheduler job, and mapping a refusal to `fail` would spend a backoff ladder and dead-letter a
// job for a conversation that owes nothing.
export type HumanQueueOutcome = "opened" | "refused" | "failed";

// Opens a conversation for the human queue, for every path that ends the bot's attendance (the gates
// that refuse a turn, and a person answering); a team assignment only routes it. The fence re-checks
// ownership, with the client built first so its DNS round trip is not between answer and write. The
// toggle is conditional on the status the fence read (`expectedStatus`, default `pending`): Chatwoot
// refuses it when anything moved the conversation in between, and that conflict is a refusal.
export async function openForHumanQueue(p: {
  // Names the caller in every line this writes; it is what an operator reads to know which path
  // handed the conversation over.
  gate: string;
  conversationId: number;
  stillOurs: () => Promise<boolean>;
  // Asked after `stillOurs` answered true, so a fence that read the live status can name it.
  expectedStatus?: () => string;
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
    try {
      await client.toggleStatus(p.conversationId, "open", {
        expectedStatus: p.expectedStatus?.() ?? "pending",
      });
    } catch (err) {
      if (!(err instanceof ChatwootStatusConflictError)) throw err;
      logger.info(
        "chatwoot: %s handoff skipped (conv=%s) — the conversation moved on before the toggle",
        p.gate,
        String(p.conversationId),
      );
      return "refused";
    }
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
  // The source version the decision was made on (epoch seconds), or null. It lets a hand-back that
  // landed after the reply outrank this write; null skips the ordering check, as for a Chatwoot that
  // sends no `updated_at`.
  decidedAtVersion: number | null;
  // The Chatwoot message id this decision is about (the colleague's reply), which orders it against
  // an unversioned console write (./console-write-order.ts). Null where the caller cannot name one (a
  // recovery of a ledger row without it): the fence then has nothing to order and does not refuse.
  decidedAtMessageId: number | null;
  // The mirror's own row id and event clock, for the console broadcast and the flow line. Null where
  // the mirror does not know the conversation, in which case neither is written.
  conversationRowId: bigint | null;
  lastEventAt: Date | null;
  base: PrismaClient;
  // The client factory, injectable exactly the way the runtime injects it, so a test drives this
  // unit against a fake Chatwoot without a second seam.
  makeClient?: RuntimeDeps["makeClient"];
  // Finishing a takeover whose remote half did not land, rather than deciding a new one. Present
  // (even `null`) selects that mode. The claim is written before the toggle, so a death between them
  // leaves the row `open` with Chatwoot never told; then exactly two steps do not apply (the mirror
  // ownership read, which would see our own `open`, and the claim CAS, already done), and everything
  // else is the same code. The value is the row's stored deadline, compared for equality by the
  // reconcile to prove ownership; it is not a liveness test (the claim lasts 45s, the sweep waits
  // 30 minutes), and the live read is what authorises the write.
  heldClaimUntil?: Date | null;
}

// Without a version to order by, only the status the claim wrote is put back, and only while the row is
// exactly as it stood before the read (still this claim's `open`, written by nobody since): the claim
// owns that status and nothing else, and any write in between is newer than the read.
async function withdrawClaimStatusOnly(p: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  claimUntil: Date;
  status: string;
  seenUpdatedAt: Date;
  base: PrismaClient;
}): Promise<{
  id: bigint;
  assigneeType: string | null;
  assigneeId: number | null;
  lastEventAt: Date | null;
} | null> {
  return runScopedOn(p.base, sysCtx(p.tenantId), (db) =>
    withEntityLock(
      db,
      `${p.tenantId}:${p.instanceId}:${p.conversationId}`,
      async () => {
        const where = {
          tenantId: p.tenantId,
          chatwootInstanceId: p.instanceId,
          chatwootConversationId: p.conversationId,
          status: "open",
          statusClaimUntil: p.claimUntil,
          updatedAt: p.seenUpdatedAt,
        };
        const row = await db.conversation.findFirst({
          where,
          select: {
            id: true,
            inboxId: true,
            assigneeType: true,
            assigneeId: true,
            lastEventAt: true,
          },
        });
        if (!row || p.status === "open") return null;
        // The lock does not order every writer of the row (the handled watermark moves `updatedAt`
        // without it), so the read above does not guarantee the write: only a write that landed is
        // announced and broadcast.
        const { count } = await db.conversation.updateMany({
          where,
          data: { status: p.status },
        });
        if (count === 0) return null;
        await announceStatusChange(db, p.tenantId, {
          conversationId: row.id,
          inboxId: row.inboxId,
          status: p.status,
          previousStatus: "open",
          assigneeType: row.assigneeType,
        });
        return row;
      },
    ),
  );
}

// Puts the row of a takeover Chatwoot refused back on the source's state, through the claim it owns.
// A versioned read reconciles; an unversioned one moves the status alone (above). An unreadable
// Chatwoot leaves the claim to run out, as a failed open does.
async function withdrawClaim(
  p: HumanReplyTakeoverParams & {
    claimUntil: Date;
    client: () => Promise<ChatwootClient>;
  },
): Promise<void> {
  // The row as it stood BEFORE the read, so a write landing between the read and the withdrawal (an
  // operator reopening what the read saw resolved) cancels the unversioned write-back below.
  const before = await runScopedOn(p.base, sysCtx(p.tenantId), (db) =>
    db.conversation.findFirst({
      where: {
        tenantId: p.tenantId,
        chatwootInstanceId: p.instanceId,
        chatwootConversationId: p.conversationId,
      },
      select: { updatedAt: true },
    }),
  );
  const live = parseLiveConversation(
    await (await p.client()).getConversation(p.conversationId),
  );
  if (live === null) return;
  if (live.updatedAt === null) {
    if (!before) return;
    const written = await withdrawClaimStatusOnly({
      ...p,
      status: live.status,
      seenUpdatedAt: before.updatedAt,
    });
    if (written) {
      broadcastConversationEvent(p.tenantId, {
        conversationId: String(written.id),
        status: live.status,
        assigneeId: written.assigneeId,
        assigneeType: written.assigneeType,
        lastEventAt: written.lastEventAt
          ? written.lastEventAt.toISOString()
          : null,
      });
    }
    return;
  }
  const reconciled = await reconcileMirrorFromLive({
    tenantId: p.tenantId,
    instanceId: p.instanceId,
    conversationId: p.conversationId,
    live,
    ownsStatusClaim: p.claimUntil,
    base: p.base,
  });
  if (reconciled.state && p.conversationRowId !== null) {
    broadcastConversationEvent(p.tenantId, {
      conversationId: String(p.conversationRowId),
      status: reconciled.state.status,
      assigneeId: reconciled.state.assigneeId,
      assigneeType: reconciled.state.assigneeType,
      lastEventAt: reconciled.state.lastEventAt
        ? reconciled.state.lastEventAt.toISOString()
        : null,
    });
  }
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
  // Hoisted out of the try so the caller can be told. Every road that does not reach the open
  // leaves the initial failure; only the persona lookup reaches the catch, and it throws.
  let outcome: HumanQueueOutcome = "failed";
  // Why the fence stood down, set where it decides, for the operator's line below. Null on a refusal
  // that came from the toggle itself (Chatwoot's conflict), which `openForHumanQueue` decides.
  let refusal: TakeoverRefusal | null = null;
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
    // NOTE: the fence and the local handover are one write: everything that decides whether the
    // agent may speak reads this row, so writing it after the toggle leaves a window for a running
    // turn to post over the person. Three questions on one read: still the bot's, still the latest
    // decision, still the same row (the CAS); `pending` alone answers none (a hand-back writes it).
    // NOTE: no persona, no takeover, decided before anything is written: every call would go out
    // with an empty token, and learning it from the toggle throwing would leave the row `open` on a
    // conversation Chatwoot never moved. Keeping a claim is right for an unknown outcome; this is known.
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
    // The status the fence read, which the toggle is conditional on: `pending` when deciding, and when
    // finishing whatever Chatwoot showed (`open` if only the first attempt's response was lost).
    let expected = "pending";
    // NO PERSONA IS A REFUSAL, not a failure: it is decided here, from the row, before anything is
    // written or called, which is exactly what makes it a verdict.
    if (!bot) refusal = "no_bot";
    outcome = !bot
      ? "refused"
      : await openForHumanQueue({
          gate: `human reply (${p.route})`,
          conversationId,
          stillOurs: async () => {
            // Chatwoot first, because the mirror can be behind it: an attendant who answers
            // and immediately resolves or hands back does both before this detached delivery runs.
            // A gate only, not a reconcile: stamping this read would give the row a version newer
            // than the deciding message, and the ordering check below would refuse every takeover.
            // Unreadable (a throw, or a 200 that is not a conversation) does not block when deciding
            // (the mirror fence below still answers), and blocks by throwing when finishing, where
            // our own `open` leaves no mirror fence and a blind write is the thing to prevent.
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
            if (finishing && live !== null) expected = live.status;
            // The same ownership question in both modes: a conversation reassigned while the
            // row sat stranded is still `pending`, and a status-only check would take it from another
            // bot's or person's queue. Only the status half differs: finishing also accepts `open`,
            // which our own first attempt leaves if only its response was lost.
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
              refusal = "moved_on";
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
              // NOTE: the route's bot, the identity `act` asked about. Chatwoot fans a message to the
              // conversation's assigned bot and the inbox's, so asking about the inbox persona would
              // reject the assigned-bot delivery on a conversation another persona's bot holds, and
              // neither delivery would take over. The token stays the inbox persona's: the fence asks
              // whether this delivery may act, the token asks who we are on this instance.
              ourAgentBotId: p.ourAgentBotId,
              base: p.base,
            });
            if (!now.ours) {
              refusal = "not_ours";
              return false;
            }
            // Where the status last moved; the version on a row from before the change mark.
            const decidedAgainst = now.statusChangedAt ?? now.statusAt;
            // NOTE: and is this decision still the most recent one? A hand-back ("Return to AI")
            // leaves the conversation `pending` and bot-owned too, so the two are told apart by
            // version (state-order.ts): a row whose status moved after the deciding payload holds a
            // later answer, and a later answer wins.
            if (
              decidedAgainst !== null &&
              p.decidedAtVersion != null &&
              p.decidedAtVersion < decidedAgainst
            ) {
              refusal = "later_decision";
              logger.info(
                "chatwoot: %s handoff skipped (conv=%s) — the status changed after this reply (%s < %s)",
                `human reply (${p.route})`,
                convLabel,
                String(p.decidedAtVersion),
                String(decidedAgainst),
              );
              return false;
            }
            // NOTE: and the hand-back that could not be versioned, which the comparison above cannot
            // see: an unversioned console write leaves the pre-click marks, so a delivery frozen
            // before the click compares equal. Ordered by the source's message sequence instead: at
            // or below the mark the reply predates the click, above it the handover is genuine. A
            // deadline would skip both. ./console-write-order.ts has why no version or clock works.
            if (
              consoleWriteLandedAfter(
                p.decidedAtMessageId ?? null,
                now.consoleWriteAtMessageId,
              )
            ) {
              refusal = "handed_back";
              logger.info(
                "chatwoot: %s handoff skipped (conv=%s) — an operator handed the conversation back after this message (msg=%s <= %s)",
                `human reply (${p.route})`,
                convLabel,
                String(p.decidedAtMessageId),
                String(now.consoleWriteAtMessageId),
              );
              return false;
            }
            // Unversioned, only the field the action changed (as mirrorConsoleWrite does), so
            // a truly newer event still outranks it; the reconcile below earns it a version. The four
            // observed columns make it a compare-and-swap across the read above and this write,
            // since another replica can commit between them: assignee and the console mark are
            // ordered independently of the status version, so a status-and-version predicate would
            // open the conversation anyway. No test can pry that window open, so the mutations that
            // drop these terms survive the suite. The write announces its claim in the same
            // statement (../../modules/chatwoot/status-claim.ts has why a version or flag cannot).
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
            if (claimUntil === null) {
              refusal = "claim_lost";
              return false;
            }
            claimHeld = claimUntil;
            // NOTE: the consoles hear about it from the write that happened. The snapshot this
            // delivery already broadcast still said `pending`, and after a failed open no Chatwoot
            // event would ever correct it. The assignee is the one the fence just read, not a re-read:
            // this write moved status only.
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
          expectedStatus: () => expected,
          client,
        });
    // A refusal after the claim is Chatwoot's conflict: the conversation moved on between the fence and
    // the toggle, nothing changed at the source, and the row says `open` where Chatwoot never will. The
    // row takes the source's state through our own claim, and the status it moves is announced there.
    if (outcome === "refused" && claimHeld !== null) {
      await withdrawClaim({ ...p, claimUntil: claimHeld, client }).catch(
        (err) =>
          logger.warn(
            "chatwoot: correcting the mirror after a refused takeover failed (conv=%s): %s",
            convLabel,
            errMsg(err),
          ),
      );
    }
    // NOTE: a failed open keeps the claim. A failed call is an unknown outcome (Chatwoot can commit
    // and lose the response), and rolling back would put the agent back on a conversation the
    // platform may have handed over. The claim stays on the row until the reconcile stamps it,
    // because deliveries are never serialized and anything committing in between would walk the
    // unversioned `open` back. On a failed open it costs a delay: the conversation returns to the
    // agent when the claim expires. Details: docs/chatwoot.md, "A person answering the customer
    // ends the attendance". Refused or failed, nothing below runs; not a `return`, because the
    // delivery still arms memory ingestion and marks its row processed.
    if (outcome === "opened") {
      // NOTE: then a live read claims a version for it (the toggle renders no `updated_at`). The
      // version buys ordering: a delayed conversation event with an older status can no longer win,
      // and a webhook that landed meanwhile outranks the GET. A read with no version is discarded
      // rather than written blind; the row already says `open`.
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
    // A person answered and the agent did NOT step off: the one outcome an operator has to be able
    // to see, because what follows is the agent answering the customer's next message on top of the
    // person. A failed open is reported by the warning it already writes and settles on the claim.
    if (outcome === "refused" && p.conversationRowId !== null) {
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
          status: "skipped",
          detail: describeRefusedTakeover(
            p.route,
            refusal ?? "status_conflict",
          ),
        },
      );
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
