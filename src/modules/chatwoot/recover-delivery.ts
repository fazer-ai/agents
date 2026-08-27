import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { chatwootThreadId, resolveGraphThreadId } from "@/graph/checkpointer";
import {
  clearTurnInFlight,
  isTurnInFlight,
  markTurnInFlight,
} from "@/graph/inflight";
import type { RuntimeDeps } from "@/graph/runtime";
import { turnOwnsThread } from "@/graph/thread-claim";
import { parseDbId } from "@/lib/db-id";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { writeFlowEvent } from "@/modules/flowlog/service";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { agentBotChatwootId, loadChatwootClient } from "./instance";
import { maxIncomingId, parseChatwootMessages } from "./messages";
import {
  controlCommand,
  isNewIncomingMessage,
  normalizeChatwootEvent,
  parseLiveConversation,
} from "./normalize";
import { reconcileMirrorFromLive } from "./reconcile";
import { buildRecoveryPayload } from "./recover-payload";
import { processChatwootDelivery } from "./webhook";

// Answering the customer whose delivery a process death stranded (issue #295).
//
// The sweep (issue #228) says a message went unanswered; it does not answer it. This does, and the
// whole design is one sentence: RUN THE DELIVERY PATH AGAIN. Not a flush, and not a re-implementation
// of the gates.
//
// WHY NOT THE FLUSH, which was the obvious answer and is wrong. `flushDebounceJob` re-checks two
// gates itself, ownership and contact authorization, and it re-reads the conversation's messages
// from Chatwoot so the event body is not needed. But three gates run only in the delivery path and
// none of their verdicts survive the process that computed them: test mode, availability /
// out-of-hours, and the channel redirect. A recovery through the flush replies out of hours, or on a
// conversation whose test mode was never activated — a message the original delivery would have
// suppressed.
//
// Re-implementing those three here was the alternative, and it is worse than it looks: they are not
// predicates. Each one DECIDES AND ACTS — the redirect gate sends the link, availability posts the
// away message, test mode posts its notice — so a second implementation would have to reproduce the
// actions and their claims, not just the verdicts. And `isTestSilenced` already has five callers; a
// sixth is the shape of defect this repo keeps paying for.
//
// Re-running the delivery path is correct by construction: every gate runs where it already runs.
// What made that look unsafe was the fear of re-firing the side effects, and it does not hold — but
// the reason is PER GATE rather than one shared property, which is what reading all three actually
// showed:
//
//   - availability posts behind a real CAS. `claimAwayMessage` is an `updateMany` guarded on the
//     watermark's previous value and it claims BEFORE it posts, so a second invocation claims
//     nothing. The comment on it names why it had to be: "The webhook dispatch is DETACHED, so a
//     customer who writes twice in a row lands two invocations that both read the same watermark
//     before either writes it".
//   - the test notice (`testNoticeSentAt`) and the redirect (`redirectSentAt`) are one-shot
//     watermarks READ before the act and WRITTEN after it, which is not the same thing. They are
//     safe for a recovery for a different reason: a recovery is serialized against a live turn by
//     the in-flight fence below and against another recovery by the claim CAS, so its read of the
//     watermark is current rather than racing one.
//
// THE RESIDUAL WINDOW, named rather than papered over: a process that died BETWEEN one of those two
// acts and its watermark write leaves the watermark null, and the recovery repeats the act — a
// duplicate private note for the test notice, and for the redirect the fixed link sent to the
// customer a second time. Both are already reachable without any recovery, because the dispatch is
// detached and two live deliveries interleave the same way; neither spends a model call or writes
// conversation state. Closing it means a claim-then-act ordering inside three gates this does not
// own, which is a change to their contract and not to this one.
//
// AT LEAST ONCE, and that is a property of the design rather than a gap in it. A process that died
// left the customer unanswered — that is why the row is DEAD — but it did not necessarily do
// NOTHING first, and nothing in the ledger records how far it got. So a turn whose tools had already
// fired is re-run and fires them again. Closing that needs a durable per-effect claim, which is a
// change to the delivery path and to every tool, not to this. What IS refused here is the one class
// where a replay is destructive rather than merely repeated: a control command (`/reset` deletes the
// memory thread), which an operator authored and can retype.
//
// WHAT THIS DOES NOT DO, and it is a bound rather than an omission: it never runs a turn beside a
// live one. The turn-in-flight fence is consulted first, and it is in-memory — safe under the
// single-replica / one-leader invariant this whole repo already runs on, and the seven other modules
// that gate on it are the precedent. A turn live on ANOTHER replica is issue #203's gap, shared with
// every one of them.

// How many recoveries one stranded row may ever get. `attempts` is the ledger column that counts
// them, unused since the ledger was introduced and written for the first time by the claim in
// `processChatwootDelivery`.
//
// THREE, and the number is a policy rather than a measurement — said plainly because the alternative
// is a reader assuming it was tuned. What is NOT arbitrary is that a bound exists at all: a recovery
// runs a real turn, which spends the model and can call side-effecting tools, and a row that fails
// for a reason recovery cannot fix (a deleted conversation, a revoked token) would otherwise be
// retried for the life of the install.
export const MAX_RECOVERY_ATTEMPTS = 3;

// How old a stranded delivery may be and still be worth answering automatically, measured from when
// the ledger row was RECEIVED — the customer's own clock, and the only one that matters here.
//
// SIX HOURS, and like the attempt cap it is policy rather than measurement. What is not arbitrary is
// that a ceiling exists, and it answers two different questions with one rule:
//
//   - a reply is a RECOVERY only while the customer is still plausibly waiting. Hours later it is
//     not a late answer, it is a stranger reopening a conversation that moved on, and the operator's
//     DEAD worklist is the better place for it.
//   - the delivery path replies FREE-FORM, and deliberately applies no WhatsApp service-window check
//     because a reactive event has just arrived — which is true for a live delivery and is exactly
//     what a stale recovery breaks. Outside the 24h window an official provider rejects the send,
//     the path catches it, and the row is marked PROCESSED with the customer still unanswered. A
//     ceiling well inside any plausible window is what keeps that unreachable, rather than a second
//     copy of `proactiveSendMode` living here.
//
// What it does NOT cover, said plainly: an agent that configures `serviceWindow.windowHours` BELOW
// this ceiling. That install can still produce a recovery outside its own window.
export const MAX_RECOVERY_AGE_MS = 6 * 60 * 60 * 1000;

// How long to wait before asking again about a conversation that was BUSY. A minute: long enough
// that a short turn is over, short enough that a customer's second stranded message is not left
// behind the first one for a scheduler interval. Nothing measures a turn's length — there is no
// timeout on the model call or the tools — so this is a cadence, not an estimate of one.
const BUSY_RETRY_MS = 60_000;

// Conversations with a recovery running IN THIS PROCESS, so a second one defers instead of starting
// a turn beside the first.
//
// The row CAS serializes recoveries of one ROW, and that is not the same fence: a conversation whose
// process death stranded two messages has two DEAD rows, and the scheduler drains its lane
// concurrently, so both are claimed in the same tick. `isTurnInFlight` cannot answer for them
// either — a turn marks itself deep inside `runAgentTurn`, several awaits after this check, so both
// recoveries read false and both go on to run one.
//
// Checked and added with NO AWAIT BETWEEN THE TWO, which is what makes it a claim rather than one
// more read-then-act: JavaScript runs that pair to completion, so of two recoveries resuming from
// the same row read, the first to resume owns the conversation and the second sees it taken.
// Process-local, which is all the Map behind `isTurnInFlight` is too (../../graph/inflight.ts):
// both answer about THIS process. What crosses replicas is the claim the turn itself takes in
// the thread's row, and the fence immediately before the handoff is where that one is asked.
const recovering = new Set<string>();

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Four outcomes because the caller has four things to do, and a narrower union would make it guess.
// The scheduler's vocabulary is what they are FOR: three of them are `done` and one is `fail`, and
// collapsing any of the three into the one would either burn a retry budget on work somebody else
// already did, or retry forever on work nobody can do.
export type RecoveryOutcome =
  // The delivery path ran. Whether it ANSWERED is the delivery path's business: the gates it applies
  // may consume the message deliberately, and that is a recovery that worked.
  | "recovered"
  // The row is not ours to recover: it is no longer DEAD, or another pass won the claim between the
  // read and the CAS. Somebody else is doing this work, so there is nothing to retry.
  | "superseded"
  // The conversation is BUSY: a turn is live on it, or another recovery holds it. Transient by
  // construction and on a timescale nothing here controls — a turn is deliberately unbounded, which
  // is why the sweep waits thirty minutes before calling one abandoned.
  | "deferred"
  // The Chatwoot account could not be READ, or answered with a snapshot that cannot be trusted.
  // Repairable by an operator, and durable until they do it, which is what makes it a different
  // answer from `deferred`: one is waited out, the other has to be given up on eventually.
  | "unreachable"
  // The row cannot be recovered, ever, and stays DEAD. Its message remains in the operator's
  // worklist, which is the honest place for it.
  | "unrecoverable";

export interface RecoverStrandedDeliveryParams {
  tenantId: bigint;
  deliveryRowId: bigint;
  base?: PrismaClient;
  deps?: RuntimeDeps;
  // Injectable clock, for the age ceiling. A test that has to make a row genuinely six hours old is
  // a test that seeds a timestamp and hopes; this makes the boundary askable directly.
  now?: Date;
}

// The turn outcomes that SETTLE the message: after one of these, nobody is owed a reply and the row
// may leave the worklist. Everything else keeps it. A SET rather than a union of the runtime's type
// on purpose: this file is asking a narrower question than "what happened", and a new outcome there
// must land on the safe side here without anyone remembering to come back.
//
// Settled is not the same as answered, which is why the name is not `TURN_ANSWERED`. Two of the
// three sent the customer nothing, and each is settled for its own reason:
//
//   `posted`      — something reached the customer.
//   `taken-over`  — a human holds the conversation and will answer it.
//   `blocked`     — a guardrail tripped with `action: "silent"`: the operator's own policy decided
//                   this message must not be answered, and the runtime calls that a consumed burst
//                   in as many words. `empty` sits on the other side of that line and the difference
//                   is WHO decided: there the model had nothing to say, which a second attempt could
//                   legitimately answer differently, while here a re-run reproduces the same refusal
//                   and the row on the worklist would ask an operator to investigate a decision
//                   their own configuration made.
const TURN_SETTLED = new Set(["posted", "taken-over", "blocked"]);

export async function recoverStrandedDelivery(
  params: RecoverStrandedDeliveryParams,
): Promise<RecoveryOutcome> {
  const base = params.base ?? basePrisma;
  const row = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.chatwootWebhookDelivery.findUnique({
      where: { id: params.deliveryRowId },
      select: {
        id: true,
        // The id an operator reads, and the one the sweep's loss line named. Carried so the closing
        // line below can be tied to that one.
        deliveryId: true,
        chatwootInstanceId: true,
        status: true,
        attempts: true,
        receivedAt: true,
        conversationId: true,
        inboundMessageId: true,
      },
    }),
  );
  // Gone, or already taken back by something else. Not a failure: the claim below would have said
  // the same thing, and saying it here spends no network.
  if (row?.status !== "DEAD") return "superseded";

  // A row the sweep reported without ids is one an older build wrote, and there is nothing to
  // rebuild a body from. It stays DEAD and stays in the worklist. Re-asked here rather than trusted
  // from the arming site: the row is only readable now, and a job armed against an older build's row
  // could have been armed before this predicate existed.
  if (!isRecoverableStrand(row)) return "unrecoverable";
  // GIVEN UP ON, and said out loud, because this is the one refusal that ends a recovery which was
  // really trying. The others are verdicts about the row (no ids, too old, already taken); this one
  // is the end of a ladder — most often a turn that kept throwing, which round 12 routes to
  // `unreachable` so the job backs off. That backoff does NOT reach the scheduler's dead-letter
  // line, because this cap is the lower of the two and fires first, so the job completes and the
  // scheduler has nothing left to report. The record an operator gets is this line plus the row,
  // which stays DEAD on the page the sweep already opened for it.
  if (row.attempts >= MAX_RECOVERY_ATTEMPTS) {
    logger.warn(
      "chatwoot recovery: %s has spent its %d attempts and is given up on (conversation %s); the row stays DEAD",
      row.deliveryId,
      MAX_RECOVERY_ATTEMPTS,
      row.conversationId ?? "unknown",
    );
    return "unrecoverable";
  }

  // Too late to be a recovery. Asked before any network, on the row's own receipt.
  const now = params.now ?? new Date();
  const age = now.getTime() - row.receivedAt.getTime();
  if (age > MAX_RECOVERY_AGE_MS) return "unrecoverable";

  const instanceId = row.chatwootInstanceId;
  const conversationId = row.conversationId;
  const messageId = row.inboundMessageId;
  const threadId = chatwootThreadId(
    params.tenantId,
    instanceId,
    conversationId,
  );

  // Both fences are about the CONVERSATION rather than the row, and for one reason: two deliveries
  // for one conversation are two rows, so the row CAS says nothing about them. The first covers a
  // turn already running; the second covers the recovery of the OTHER row, which the scheduler
  // claims in the very same tick.
  if (isTurnInFlight(threadId) || recovering.has(threadId)) return "deferred";
  recovering.add(threadId);
  try {
    return await runRecovery({
      ...params,
      base,
      row,
      instanceId,
      conversationId,
      messageId,
      now,
    });
  } finally {
    recovering.delete(threadId);
  }
}

interface LoadedRow {
  id: bigint;
  deliveryId: string;
  attempts: number;
}

// PUTTING THE ROW BACK, which is the compensating write both failure roads below take, and the one
// place a swallowed error would cost a customer.
//
// Three answers, not two, because "it did not happen" and "it had already moved" are different
// facts and only one of them is a problem. A row that MOVED was taken by something else, which is
// fine. A write that FAILED leaves the row where the delivery path put it, and what that costs
// depends on which state that is: `PROCESSING` is revisited — the sweep declares it stranded all
// over again — while `PROCESSED` is never looked at by anything, so the customer is gone from the
// worklist with nobody having answered. That is why the caller for `PROCESSED` says so at `error`.
//
// RETRIED, because the failure this guards against is a transient database blip and a second
// statement a moment later is the whole fix for it. Bounded, and the last word is the log line.
//
// WHAT IT DOES NOT FENCE, and a review round asked for a claim generation to close it: a handler
// that was merely STALLED — not dead — when the sweep judged its row abandoned can still reach
// `processChatwootDelivery`'s final settlement, which updates by id with no CAS, and write
// `PROCESSED` over a row this function has just restored to `DEAD`. If that handler's own turn also
// failed to answer, the message leaves the worklist unanswered.
//
// It is left as it is for two reasons. The first is that this PR does not create it: with or
// without a recovery, a stalled handler waking up and settling its own row takes the message off
// the `WHERE status = 'DEAD'` list exactly the same way — the recovery adds an actor, not an
// outcome. The second is that the missing CAS is a decision with its own written argument, on the
// other side of this one (see the settlement in ./webhook.ts): a turn that outlives the sweep's
// staleness threshold and then completes DID deliver, late, and winning there is what leaves the
// row saying the true thing. A generation counter would have to distinguish "completed late" from
// "woke up and failed", which is a question the delivery path does not currently answer about
// itself. That is its own piece of work, on the live path rather than here.
//
// What the round got wrong is the tail: a later recovery does not then report `superseded` and
// delete the message. It reads a row that is no longer `DEAD` and refuses before claiming anything.
export async function putRowBack(params: {
  base: PrismaClient;
  tenantId: bigint;
  rowId: bigint;
  from: "PROCESSING" | "PROCESSED";
  sleep?: (ms: number) => Promise<void>;
}): Promise<"restored" | "moved" | "failed"> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0)
      await (params.sleep ?? ((ms: number) => Bun.sleep(ms)))(100 * attempt);
    try {
      const { count } = await runScopedOn(
        params.base,
        sysCtx(params.tenantId),
        (db) =>
          db.chatwootWebhookDelivery.updateMany({
            where: { id: params.rowId, status: params.from },
            data: { status: "DEAD" },
          }),
      );
      return count === 1 ? "restored" : "moved";
    } catch (err) {
      lastErr = err;
    }
  }
  logger.error(
    "chatwoot recovery: could not put delivery row %s back to DEAD from %s: %s",
    params.rowId,
    params.from,
    lastErr instanceof Error ? lastErr.message : String(lastErr),
  );
  return "failed";
}

async function runRecovery(params: {
  tenantId: bigint;
  base: PrismaClient;
  deps?: RuntimeDeps;
  row: LoadedRow;
  instanceId: bigint;
  conversationId: number;
  messageId: number;
  now: Date;
}): Promise<RecoveryOutcome> {
  const { base, row, instanceId, conversationId, messageId } = params;

  const conv = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId: params.tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: {
        // The mirror's own row id, for filing the closing line against the conversation — the same
        // place the sweep filed the loss it closes.
        id: true,
        contactInboxId: true,
        // The one field the live read cannot answer (see recover-payload.ts).
        redirectOriginDisplayId: true,
        chatwootRedirectOriginAt: true,
        status: true,
        assigneeType: true,
        assigneeId: true,
        assigneeName: true,
        inbox: {
          select: {
            chatwootInboxId: true,
            name: true,
            agentId: true,
          },
        },
      },
    }),
  );
  // The mirror does not know this conversation, so nothing here can say who should answer it or
  // whether they still may. A row this old with no mirror row is not going to grow one.
  if (!conv) return "unrecoverable";

  // TWO READS OFF THE ACCOUNT, and the first one exists because a review round refuted the premise
  // the other half of this file was written on.
  //
  // The conversation's own state cannot come from the mirror, and the reason is the strand itself:
  // the delivery that would have mirrored this message is the one that died, so the mirror holds the
  // state from BEFORE it. MEASURED at the fork's source and live against it — an incoming message on
  // a `resolved` conversation reopens it (`Message#reopen_resolved_conversation`: `pending` on a
  // bot inbox, `open` otherwise), so the mirror still says `resolved` while Chatwoot says otherwise.
  // Copied into the body, that stale `resolved` makes `shouldBotHandle` refuse, the row is marked
  // PROCESSED, this function reports a recovery, and the customer is never answered. A customer
  // writing again after a conversation was resolved is the ordinary way a new episode starts, so
  // this is not an exotic path.
  //
  // The live snapshot goes through `reconcileMirrorFromLive`, not straight into the body, and that
  // is the more useful of the two: it REPAIRS the mirror under the same ordering rule the webhook
  // mirror uses, so the gates downstream — which read the mirror, not this — see the truth too, and
  // a webhook committed between the GET and the write still outranks the snapshot. The row it
  // returns is what the body is built from.
  //
  // The message read stays what it was: the one thing no mirror holds. `before` anchors the page
  // that ENDS at this id, so the message is in it whatever the conversation's length.
  let raw: unknown;
  let recent: ReturnType<typeof parseChatwootMessages> = [];
  let live: ReturnType<typeof parseLiveConversation> = null;
  let reconciled: Awaited<ReturnType<typeof reconcileMirrorFromLive>> | null =
    null;
  try {
    const client = await loadChatwootClient(params.tenantId, instanceId, {
      base,
      // The same seam every other caller uses, so a test drives a fake account rather than mocking
      // the module.
      ...(params.deps?.makeClient
        ? { makeClient: params.deps.makeClient }
        : {}),
    });
    live = parseLiveConversation(await client.getConversation(conversationId));
    // APPLIED IMMEDIATELY, before the two message reads, and that ordering is the rule rather than a
    // preference: a snapshot is evidence about the instant it was READ, and every moment it is held
    // is a moment something newer can land under it. The reconcile orders by the conversation's own
    // version where both sides have one, and falls back to `last_activity_at` where they do not —
    // and that fallback cannot see a handoff or a resolve, because neither advances that field. Held
    // across two network round trips, a takeover committed inside them was written to the mirror and
    // then walked back by this older bot-owned snapshot, and the rebuilt delivery answered over the
    // human. MEASURED at the anchored read, which is inside that stretch.
    //
    // The other two callers already do it this way (../../graph/nudge.ts probes and reconciles in
    // consecutive statements; the console's buttons write and read back). This was the only one
    // holding the snapshot, and it held it the longest.
    reconciled = live
      ? await reconcileMirrorFromLive({
          tenantId: params.tenantId,
          instanceId,
          conversationId,
          live,
          base,
        })
      : null;
    raw = await client.getMessages(conversationId, { before: messageId + 1 });
    // The NEWEST page, unanchored, and it answers a different question from the one above: whether
    // the customer has written again since. Two reads because one page cannot hold both ends — the
    // anchored page ends at the stranded message and says nothing about what came after, and the
    // newest page need not contain the stranded message at all (MEASURED: on a 30-message
    // conversation the default page of 20 did not).
    recent = parseChatwootMessages(await client.getMessages(conversationId));
  } catch (e) {
    // The account is unreachable or the token no longer works. Both are repairable by an operator,
    // so this is a DEFERRAL rather than a verdict: the row keeps its attempt budget and the next
    // pass tries again.
    logger.warn(
      "chatwoot recovery: could not read conversation %d (delivery=%s): %s",
      conversationId,
      String(row.id),
      e instanceof Error ? e.message : String(e),
    );
    return "unreachable";
  }
  // Unreadable rather than absent: `parseLiveConversation` returns null for a snapshot it cannot
  // trust (no status, or an AgentBot assignee with no id — unverifiable ownership). Deferring is
  // what the live gate does with the same answer, and for the same reason: proceeding would mean
  // falling back to the mirror, which is the value this read exists to distrust.
  if (!live) {
    logger.warn(
      "chatwoot recovery: conversation %d did not parse as a live snapshot (delivery=%s)",
      conversationId,
      String(row.id),
    );
    return "unreachable";
  }
  // The row AFTER the reconcile, which is the truth in both directions: the live snapshot where it
  // won, and whatever outranked it where it lost. Null only if the mirror row vanished between the
  // two reads, and the row read above is then the best thing left.
  //
  // Read from the reconcile above rather than re-read here, so what the body states is the row that
  // call decided — a second read would answer about a different moment, and the two message reads
  // sit between them.
  const state = reconciled?.state ?? conv;

  // A CUSTOMER WHO WROTE AGAIN CANNOT BE ANSWERED ABOUT THE OLDER MESSAGE, and the delivery path is
  // what decides that rather than this: `shouldPost` re-fetches immediately before posting, sees a
  // newer incoming id and withholds the reply, and the turn comes back "superseded". The path still
  // settles the row — correctly, for a LIVE delivery, because there the newer message's own delivery
  // carries the reply. For a recovery that premise is gone: the newer message's delivery already
  // ran, and it answered the newer message. A direct turn feeds the graph its OWN trigger text, so
  // the stranded one was never seen — its ingestion is the turn its delivery died before reaching.
  //
  // Left to run, the recovery spends a model call, posts nothing, marks the row PROCESSED and writes
  // a closing line saying the loss ended. So it is asked HERE, before the claim: no attempt, no
  // turn, and the row stays DEAD in the worklist, which is the honest place for a message this
  // design cannot answer.
  //
  // `unrecoverable` rather than a deferral, because a newer message never un-arrives. Asked through
  // `maxIncomingId`, the delivery path's OWN predicate, so the two cannot start disagreeing about
  // what counts — an outgoing away message or an operator's note moves the conversation forward
  // without answering anything, and must not block a recovery.
  // AND THE PAGE HAS TO REACH BACK TO THE MESSAGE, or it cannot answer that question at all. One
  // unanchored page is the newest twenty, and twenty outgoing or activity messages since the strand
  // would push a newer CUSTOMER message off it — `maxIncomingId` would then find nothing and this
  // would replay a message the customer has long since passed. The page reaches back exactly when it
  // holds something at or below the stranded id; when it does not, the conversation moved more than
  // a page since, which is not a state a later attempt walks back.
  //
  // A page that comes back EMPTY is a different answer: the account rendered nothing where the
  // anchored read just found this message, which is a degraded read rather than a busy conversation.
  const oldestSeen = recent.reduce<number | null>(
    (a, m) => (a === null || m.id < a ? m.id : a),
    null,
  );
  if (oldestSeen === null) {
    logger.warn(
      "chatwoot recovery: %s got an empty newest page on conversation %d; the REST read is degraded",
      row.deliveryId,
      conversationId,
    );
    return "unreachable";
  }
  if (oldestSeen > messageId) {
    logger.info(
      "chatwoot recovery: %s is more than a page behind on conversation %d; not answered",
      row.deliveryId,
      conversationId,
    );
    return "unrecoverable";
  }
  const newest = maxIncomingId(recent, messageId);
  if (newest > messageId) {
    // WHICH of the two cases this is, said out loud, because they read the same from the row and an
    // operator does different things about them.
    //
    //   the newer message has a delivery of its own that is NOT dead — the ordinary case, and the
    //   premise this refusal rests on: that delivery ran or is running, and it carries the reply.
    //
    //   the newer message's row is DEAD TOO — one process death stranded a BURST. Nothing has
    //   answered anything yet; the newest row's own recovery will answer the conversation, and this
    //   older message's TEXT is never handed to a model, because a direct turn carries its own
    //   trigger text and nothing back-fills the channel. This row stays DEAD and stays on the
    //   operator's page, which is the whole signal they get that a customer said something nobody
    //   read. Measured, not inferred, and tracked separately: recovering a burst together is the
    //   flush's job and re-implementing it here is what the head of this file refuses to do.
    const covering = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.chatwootWebhookDelivery.findFirst({
        where: {
          tenantId: params.tenantId,
          chatwootInstanceId: instanceId,
          conversationId,
          inboundMessageId: newest,
        },
        select: { status: true },
      }),
    );
    logger.info(
      "chatwoot recovery: %s is behind message %d on conversation %d; not answered (%s)",
      row.deliveryId,
      newest,
      conversationId,
      covering?.status === "DEAD"
        ? "that message is stranded too, so this one is part of a burst its own recovery answers"
        : `that message's delivery is ${covering?.status ?? "not in the ledger"}`,
    );
    return "unrecoverable";
  }

  const message = findRawMessage(raw, messageId);
  // Chatwoot no longer has the message: deleted, or the conversation was. There is nothing to
  // answer, and no number of retries will change that.
  if (!message) return "unrecoverable";

  // THE ROUTE, AND IT COMES FROM THE MESSAGE RATHER THAN THE MIRROR. `Conversation.inboxId` is
  // nullable, and the mirror writes it null for every event that named no inbox — `upsertInbox`
  // returns null and the create stores that — so a conversation whose first mirrored event was
  // sparse holds no route at all, and the delivery that would have taught it one is the row being
  // recovered. A body rebuilt from that mirror carries no `inbox_id`, and `runAgentTurn` returns
  // "skipped" on its first line: no turn, row marked PROCESSED, closing line saying the loss ended,
  // customer still waiting. The same quiet failure a missing `message_type` produces.
  //
  // The message answers it and we already hold the page: every message the index serializes renders
  // `inbox_id` beside `message_type` (MEASURED at the fork's `api/v1/models/_message.json.jbuilder`),
  // and it is the message's OWN inbox — which is what `Message#webhook_data` builds the body's
  // `inbox` from, so this reproduces the wire rather than approximating it. The mirror stays as a
  // second reading for an account that renders no such scalar.
  //
  // NOT A HISTORICAL ROUTE, and a review round read it as one: the message's inbox looks older than
  // the conversation's, so a conversation transferred between inboxes after the strand would be
  // answered on the inbox it left. MEASURED at the fork, and that transfer does not exist.
  // `Conversation#inbox_id` is `not null`, set once by `ConversationBuilder` from the contact inbox,
  // and NOTHING in `app/`, `enterprise/` or `lib/` ever updates it — the `clone_inbox` rake task
  // creates new conversations on the destination rather than moving any. What Chatwoot does transfer
  // is the ASSIGNEE, agent or team, which is a different column and a gate this module already runs.
  // So the two readings cannot describe different inboxes for one conversation: a message belongs to
  // the conversation's inbox by construction. What CAN differ is one of them being absent, which is
  // exactly what the fallback answers and what the mirror repair below is for.
  const routeInboxId =
    typeof message.inbox_id === "number"
      ? message.inbox_id
      : (conv.inbox?.chatwootInboxId ?? null);
  // Neither reading can name the route. The rebuild is degraded, and closing the row on it would be
  // the failure above with an extra step. `unreachable` for the same reason a degraded message shape
  // is: the account answered with something unusable, which the next attempt may not.
  if (routeInboxId === null) {
    logger.warn(
      "chatwoot recovery: %s names no inbox on either reading (conversation %d); the REST read is degraded",
      row.deliveryId,
      conversationId,
    );
    return "unreachable";
  }
  // The local row for THAT inbox, which is where the bound agent, its mode and the name live.
  //
  // ALWAYS RE-READ, never the snapshot loaded with the conversation, even when the route id matches
  // what the mirror already said. The id matching does not make the BINDING the same: an operator
  // can rebind the very same inbox to a different agent while the two REST reads are running, and
  // the snapshot would then hand this recovery the old persona's bot while the delivery path
  // resolves the new one — the ownership gate reads that as another party and consumes the message
  // without replying. The saving it replaces was one scoped query on a path that already makes two
  // REST calls.
  //
  // The agent's MODE comes back with it, in the same scoped transaction rather than a query beside
  // it: whether a control command is ACTIVE at all is that mode, and the binding and the mode have
  // to answer about the same moment or the refusal below is decided against an agent this replay
  // would never have reached. `Inbox` carries the agent as a bare column, so it is two statements,
  // and one transaction is what makes them one reading.
  const route = await runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    const found = await db.inbox.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootInboxId: {
          tenantId: params.tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: routeInboxId,
        },
      },
      select: { id: true, chatwootInboxId: true, name: true, agentId: true },
    });
    const agent =
      found?.agentId == null
        ? null
        : await db.agent.findUnique({
            where: { id: found.agentId },
            select: { mode: true },
          });
    return { inbox: found, mode: agent?.mode ?? null };
  });
  const inbox = route.inbox;
  const agentId = inbox?.agentId ?? null;
  const agentMode = route.mode;

  // THE MIRROR LEARNS THE ROUTE, and this is a repair rather than a convenience. Rebuilding the body
  // from the live message answers `runAgentTurn`, which resolves the agent from the inbox the EVENT
  // carries — and nothing else in the delivery path reads it from there. `maybeConsumeCommandOrGate`
  // resolves it from `Conversation.inboxId`, the mirror's own column, and when that column is null it
  // finds no agent and returns having run NOTHING: not the test-mode gate, not availability, not
  // contact authorization. The turn then runs anyway, on the route this module supplied.
  //
  // MEASURED, and it is the worst outcome this module can produce: a conversation whose mirror never
  // learned its inbox, on an agent in TEST mode, never activated — the recovery built a turn and
  // posted a reply to a real customer, which is the one thing test mode exists to prevent.
  //
  // Ordinary events write this column too, but only when they win the ordering
  // (`decision.unversioned` in ./mirror.ts), and the rebuilt body is stale by construction whenever
  // the conversation moved on after the strand. So the repair cannot be left to the mirror write the
  // handoff performs; it happens here, on the row, before the gates read it.
  //
  // Only from NULL. A column that already names an inbox is a statement, and this module has no
  // standing to overrule it: a conversation that moved between inboxes is the mirror's business, and
  // the route the body carries is about this MESSAGE.
  //
  // The `if` is the cheap answer and the WHERE is the one that holds: they are not the same check,
  // and no test can separate them, because what the WHERE refuses is a route arriving between the
  // read at the top and this write. It is the shape every other guarded write here uses.
  if (conv.inbox === null && inbox != null) {
    await runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.conversation.updateMany({
        where: { id: conv.id, inboxId: null },
        data: { inboxId: inbox.id },
      }),
    );
  }

  // RE-READ rather than carried from the load at the top. `contactInboxId` is one of the fields a
  // webhook arriving during the two REST reads and the reconcile can move (./mirror.ts writes it on
  // an unversioned event), and TWO things downstream are built from it: the body this recovery hands
  // the delivery path, and the graph key the fence below asks about. They have to be the same
  // reading or the recovery fences one thread and runs on another — and a body carrying the OLD
  // pairing is not inert, because the mirror write it drives can put that pairing back.
  //
  // One read for both, taken here because nothing between this line and the fence awaits anything
  // that could move it again.
  //
  // The REDIRECT PAIRING comes back on the same reading, and it is a second consumer that makes it
  // matter rather than the mirror. The mirror does order this one: the body states the pairing WITH
  // its version, so a re-entry that replaced it while the REST reads ran wins and the old value is
  // rejected as stale. `armRedirectChatFollowUp` is not the mirror — it takes the pairing off the
  // normalized event and UPSERTS a scheduler payload keyed by the episode, so a body carrying the
  // old pairing re-arms a follow-up for an episode the customer already left, on top of the one they
  // are in.
  const mirrorNow = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.conversation.findUnique({
      where: { id: conv.id },
      select: {
        contactInboxId: true,
        redirectOriginDisplayId: true,
        chatwootRedirectOriginAt: true,
        // The conversation's own STATE, taken from HERE rather than from `reconciled.state` above.
        // Both are the same row and neither is the live snapshot — that distinction was measured
        // when a review round asked for a re-read on the grounds that the body carried the snapshot,
        // and it does not. This is the later of the two readings, which is the only thing that
        // separates them: a handoff or a resolve landing while the route queries run is in this one
        // and not in that one. ONE reading is stated, not two, so there is no second source to drift.
        status: true,
        assigneeType: true,
        assigneeId: true,
        assigneeName: true,
      },
    }),
  );
  const contactInboxId = mirrorNow?.contactInboxId ?? null;

  const normalized = normalizeChatwootEvent(
    buildRecoveryPayload({
      conversation: {
        chatwootConversationId: conversationId,
        // From the mirror, and only this one: the REST conversation renders no `contact_inbox`
        // (MEASURED). Re-read immediately above rather than taken from the load at the top, because
        // the pairing DOES move — see there.
        contactInboxId,
        redirectOriginDisplayId: mirrorNow?.redirectOriginDisplayId ?? null,
        redirectOriginAt: mirrorNow?.chatwootRedirectOriginAt ?? null,
        // A RESOLVE THAT LANDS AFTER THIS READ is not ordered away by anything here, and that is the
        // delivery path's rule rather than this module's. A brand-new incoming message is the one
        // event allowed to move a stored `resolved` back to `pending` (../chatwoot/state-order.ts),
        // because in Chatwoot it really does reopen the conversation — which is the measurement round
        // 8 rests on and the reason this module reads the account at all. A live delivery has the
        // same exposure and a wider one: Chatwoot freezes the payload at enqueue, so a webhook
        // enqueued before an operator's resolve and delivered after it carries `pending` too.
        // MEASURED here at the nearest seam a test can reach — a resolve landing at the delivery
        // path's own client build — and the conversation stayed `resolved` with nothing sent.
        //
        // Neither of these is the live snapshot: `reconciled.state` is the row after the reconcile,
        // and `mirrorNow` is that same row read again, later. The later one is stated, because the
        // only difference between them is what landed while the route queries ran. `state` remains
        // the fallback for the row vanishing under us, which the load at the top already refuses —
        // per FIELD it would be wrong, since a mirror that says `null` is STATING that nobody holds
        // the conversation and `??` would read that statement as an absence.
        ...(mirrorNow
          ? {
              status: mirrorNow.status,
              assigneeType: mirrorNow.assigneeType,
              assigneeId: mirrorNow.assigneeId,
              assigneeName: mirrorNow.assigneeName,
            }
          : {
              status: state.status,
              assigneeType: state.assigneeType,
              assigneeId: state.assigneeId,
              assigneeName: state.assigneeName,
            }),
      },
      inboxId: routeInboxId,
      // The name is the mirror's copy of what the wire carried, and it is the one field here that
      // nothing observable turns on: its only consumer is the inbox upsert, which would write this
      // value back onto the very row it was read from. Carried because the rebuild reproduces the
      // body — null where the mirror has no row for the route, which is the placeholder case named
      // on the parameter.
      inboxName: inbox?.name ?? null,
      message: {
        id: messageId,
        content: typeof message.content === "string" ? message.content : null,
        messageType: message.message_type,
        private: message.private === true,
        createdAt:
          typeof message.created_at === "number" ? message.created_at : null,
        contentAttributes: isRecord(message.content_attributes)
          ? message.content_attributes
          : null,
        sender: isRecord(message.sender) ? message.sender : null,
        attachments: Array.isArray(message.attachments)
          ? message.attachments
          : [],
      },
    }),
  );
  // Unreachable in practice — the body above is built to normalize — and not an assertion: a
  // recovery that cannot produce an event has nothing to hand the delivery path, and saying so is
  // cheaper than a throw nobody catches.
  if (!normalized) return "unrecoverable";

  // THE AGE, ASKED AGAIN ON THE CUSTOMER'S OWN CLOCK. The check at the top is on `receivedAt`, which
  // is when THIS application inserted the ledger row — not when the customer wrote. A webhook
  // delayed by a Chatwoot retry or an outage on our side inserts late, so a message hours older than
  // the ceiling can pass that first check. The REST read is what finally supplies the true instant,
  // and it is asked BEFORE the claim so a refusal spends no attempt.
  const sentAt =
    typeof message.created_at === "number" ? message.created_at : null;
  // A MESSAGE WITH NO CLOCK IS A DEGRADED READ, and it is refused rather than replayed. The body's
  // `last_activity_at` comes from this field, and without it the mirror falls back to the moment the
  // rebuilt event arrives — which is the whole point of carrying the customer's own clock: the
  // fallback moves `lastInboundAt` forward by however long the row sat stranded, and that column
  // anchors BOTH the follow-up episode gate and the WhatsApp 24h service window, so a proactive send
  // made later reads as in-window when it is not.
  //
  // `unreachable` for the same reason a body that can name no inbox is: the account answered with
  // something unusable, which the next attempt may not. The fork renders `created_at` on every
  // message the index serializes, so reaching this means the read is degraded, not that the message
  // is odd.
  if (sentAt === null) {
    logger.warn(
      "chatwoot recovery: %s came back without a created_at (conversation %d); the REST read is degraded",
      row.deliveryId,
      conversationId,
    );
    return "unreachable";
  }
  if (params.now.getTime() - sentAt * 1000 > MAX_RECOVERY_AGE_MS) {
    return "unrecoverable";
  }

  // STILL AN INBOUND MESSAGE, or the read was degraded. The ledger row is the proof it ever was one:
  // `inboundMessageId` is written for nothing else. So a rebuild that comes out as anything but a
  // new incoming message describes a REST response that lost something — a missing `message_type`
  // normalizes to "other" — and handing that to the delivery path is the quiet failure this whole
  // issue is about: no turn runs, the row is marked PROCESSED, a closing line says the loss ended,
  // and the customer is still waiting. `unreachable` rather than `unrecoverable` for the same reason
  // an untrusted conversation snapshot is: the account answered with something unusable, which the
  // next attempt may not.
  if (!isNewIncomingMessage(normalized)) {
    logger.warn(
      "chatwoot recovery: %s rebuilt as a %s message, not a new incoming one; the REST read is degraded",
      row.deliveryId,
      normalized.message?.messageType ?? "unknown",
    );
    return "unreachable";
  }

  // A CONTROL COMMAND IS NOT REPLAYED, and this is the one place a recovery refuses work it could
  // technically do.
  //
  // The premise of re-running the delivery path is that the path did not complete. It does not
  // follow that it did NOTHING: a process can die after an effect and before settling its row, and
  // `/reset` performs its deletion before the tail settles. Replayed, a second `/reset` deletes the
  // memory the conversation has accumulated SINCE the first one — a destructive effect, applied to a
  // thread that had already been reset once and moved on.
  //
  // Refused rather than made idempotent, because the two things a command has that a customer
  // message does not both point the same way: its author is an operator who is present and can
  // retype it, and its effect is destructive rather than a reply. The row stays DEAD and stays in
  // the worklist, which is exactly the operator-facing record that lets them do that.
  //
  // NOT a general answer to replayed effects, and the rest of that is stated at the head of this
  // file: an agent turn can call side-effecting tools, and a recovery re-runs it at least once.
  //
  // A COMMAND ONLY WHERE ONE IS ACTIVE, which is a TEST-mode agent and nowhere else. `/reset` typed
  // at a production agent is not a command at all: ./webhook.ts decides that with
  // `commandMode === "test"` and hands the text to the turn like any other, so the customer gets a
  // reply. Refusing it here would make the recovery answer a question the delivery path does not ask
  // and leave that customer with nothing — the one divergence from "run the delivery path again"
  // that costs a reply rather than saving an effect.
  //
  // TWO READS OF THE MODE, and they are not made atomic, which is a deliberate choice between two
  // races rather than an oversight. This one reads it with the BINDING, in one transaction, because
  // round 14's defect was the opposite mistake: a mode read against a different agent than the one
  // that answers refuses the wrong message. The delivery path then reads it again for itself, so an
  // operator who flips production -> test in the few queries between them has a `/reset` pass here
  // and execute there.
  //
  // Left open rather than closed by passing the decision down, because closing it means widening
  // `processChatwootDelivery`'s contract for every caller to cover a window a handful of queries
  // wide, entered only when the stranded message is exactly a command, the original process already
  // executed it, and an operator changes the mode inside it. Written up in the PR rather than
  // implied away here.
  if (agentMode === "test" && controlCommand(normalized) !== null) {
    logger.info(
      "chatwoot recovery: %s carries a control command; not replayed (conversation %d)",
      row.deliveryId,
      conversationId,
    );
    return "unrecoverable";
  }

  // Asked AGAIN, immediately before the handoff. The check at the top spends no network on a
  // conversation that is already busy; this one is about the several awaits since — two REST reads
  // and a reconcile — during which a live delivery can have started a turn, and a live delivery does
  // not consult the recovery claim.
  //
  // BOTH KEYS, because a turn claims two and neither alone is the question — the same pair
  // `/reset` asks in ./webhook.ts before it hands a conversation back. The per-conversation key is
  // taken at the top of the turn and is the only one a turn caught before the ingest lock holds; the
  // GRAPH key is the one a follow-up NUDGE claims (../../graph/nudge.ts) while posting into this
  // very conversation, so a recovery asking only the conversation key would build a turn beside a
  // nudge that is mid-reply and the customer would be answered twice.
  //
  // The graph half is asked of the ROW, because issue #203 shipped and put the answer there:
  // `runAgentTurn` claims the thread in `agent_threads` on every turn, and `turnOwnsThread` reads
  // it. The Map alone says "free" for a turn running on another replica. That reader is also where
  // an unreadable answer is turned into "held", stated there rather than at each call site on the
  // grounds that the next caller is the one that would arrive without the guard — this module is
  // that caller. With a null contact inbox the graph thread IS the conversation thread and has no
  // row, so that key keeps the in-process answer, which is what the conversation key has anyway.
  //
  // It NARROWS the window and does not close it: the last one is `processChatwootDelivery`'s own
  // path down to where `runAgentTurn` claims the thread, and the durable claim COUNTS turns rather
  // than refusing a second one, deliberately, because two deliveries for one conversation really do
  // overlap whenever debounce is off.
  //
  // TWO different things can arrive in that window, and only one of them is bounded by what came
  // before. A live DELIVERY is running because the customer wrote again, which is already the case
  // the newest-message check answers `unrecoverable` to. A follow-up NUDGE needs no new message at
  // all, so nothing above says anything about it — and it posts into this very conversation. What
  // covers that one is the mark taken below, which is the key `followUpHandler` reads before it
  // fires: held from here to the handoff, a nudge in this process reschedules instead of running
  // beside the turn. In this process, which under the single-replica invariant docs/deploy.md §4
  // states is every one of them; a nudge on another replica is issue #203's remaining edge and is
  // written up in the PR rather than implied away here.
  const graphKey = resolveGraphThreadId(
    params.tenantId,
    instanceId,
    conversationId,
    contactInboxId,
  );
  // WHICH BOT answers, derived rather than stored, and the derivation is the more correct of the
  // two. The ledger does not record the route a delivery arrived on, and adding a column would
  // answer the wrong question: Chatwoot fans one message to up to two bot routes (`agent_bots_for`:
  // the conversation's assignee bot and the inbox's, each with its own delivery id — MEASURED), so
  // "the route it came from" is not "who should answer it now". The inbox's agent's bot is, and if
  // the conversation has since moved to a different bot the ownership gate closes on that fact,
  // which is the right outcome rather than a missed one.
  //
  // Asked of `agentBotChatwootId`, which is the repo's existing answer to it: it reads the unique
  // (tenant, instance, agent) row and deliberately does NOT decrypt the token, which a caller that
  // merely wants to know WHICH bot cannot survive doing. A second reader here would be the same
  // question in one more place, which is the defect this repo keeps paying for.
  //
  // Asked ABOVE THE FENCE, which costs a deferred pass one query and is the point: nothing may await
  // between the fence answering "free" and the mark that holds it, or a nudge starting inside that
  // await is exactly the thing neither the check nor the hold sees. This query used to sit in that
  // gap. The refusal below moves up with it, so a route with no persona answers `unrecoverable`
  // instead of `deferred` on a conversation that is also busy — the better of the two, since
  // retrying never finds a persona that an operator has not bound.
  const agentBotId =
    agentId === null
      ? null
      : await agentBotChatwootId(params.tenantId, instanceId, agentId, base);
  // A ROUTE THAT NAMES AN AGENT WITH NO BOT IDENTITY IS NOT A RECOVERY, and this is the one place
  // where passing a null onward is worse than refusing. `heldByAnotherParty` compares ids, so with
  // `ourAgentBotId` null it cannot: the gate goes LOOSE and a conversation another AgentBot holds
  // reads as ours, which is precisely the state the gate exists to refuse. A live delivery never
  // reaches that — its `agentBotId` is the route token's bot, and the route exists because the bot
  // does — so this null is the recovery's own, and it must not be handed on.
  //
  // Nothing could come of it anyway: the reply is posted with the persona's token, and a client
  // built without one refuses the call by name rather than sending (issue #79). So the whole pass
  // would spend a model call to post nothing and then report a recovery.
  //
  // Not narrowed to "the assignee is another bot", because the identity is what is missing rather
  // than the comparison: an unassigned conversation on this inbox cannot be answered either.
  // `unrecoverable` rather than a deferral: the repair is an operator binding the inbox (which
  // provisions the persona), not something the next attempt finds different — and the row stays in
  // the worklist, which is where they will read it. The agent bound to NOTHING is a different state
  // and deliberately still runs: the delivery path is what writes the operator's `no_agent` line.
  if (agentId !== null && agentBotId === null) {
    logger.warn(
      "chatwoot recovery: %s routes to inbox %d, whose agent has no Chatwoot bot; not answered",
      row.deliveryId,
      routeInboxId,
    );
    return "unrecoverable";
  }
  // The key a follow-up nudge reads before it fires, asked here and then HELD to the handoff.
  const handoffKey = chatwootThreadId(
    params.tenantId,
    instanceId,
    conversationId,
  );
  // Asked in three steps, because the middle one AWAITS and the other two cannot.
  //
  // The Map first, so a conversation already busy costs no query. Then the row, which is the only
  // reader that crosses replicas. Then the Map AGAIN — and that last ask is the one that decides:
  // `turnOwnsThread` reads a row, and a turn starting while that read is in flight marks the Map
  // and returns a row-read describing the instant before it did. Two Map lookups are what that
  // costs, and they are also the last thing before the mark, so nothing suspends between the answer
  // and the hold.
  if (isTurnInFlight(handoffKey) || isTurnInFlight(graphKey)) {
    return "deferred";
  }
  const durablyHeld =
    contactInboxId != null &&
    (await turnOwnsThread(
      {
        tenantId: params.tenantId,
        instanceId,
        contactInboxId,
        graphThreadId: graphKey,
      },
      base,
    ));
  if (durablyHeld || isTurnInFlight(handoffKey) || isTurnInFlight(graphKey)) {
    return "deferred";
  }

  // THE ROW IS PUT BACK IF THE DELIVERY PATH THROWS, and the reason is that the claim has already
  // happened by then. `processChatwootDelivery` catches its own turn, media and mirror failures, but
  // a scoped query that cannot reach the database escapes — and it escapes AFTER the CAS, leaving
  // the row on PROCESSING with nothing holding it. The next attempt reads that and answers
  // `superseded`, completing the job; the row then waits for the sweep to declare it stranded all
  // over again, which is thirty minutes it may not have against the age ceiling.
  //
  // Restoring is safe because this pass OWNS the row: it won the CAS, and the write is guarded on
  // the state it left it in, so a late tx2 that got through is never overwritten. `unreachable`
  // rather than a rethrow, so the scheduler's own backoff runs and the retry finds a DEAD row it can
  // claim.
  let outcome: Awaited<ReturnType<typeof processChatwootDelivery>>;
  // A TURN THAT THREW IS NOT AN ANSWER, and the delivery path cannot say so in its return value:
  // `"processed"` is about the ROW, and for a live delivery it is the honest word — the failure is
  // recorded on the conversation and announced inside Chatwoot, and there is no retry to arm. A
  // recovery exists to answer, so the same word there would close the loss on a customer nobody
  // replied to and take the row out of the worklist. MEASURED before this: with the model throwing,
  // the recovery returned `recovered`, the row went `PROCESSED`, and nothing was sent.
  //
  // Asked for explicitly (`onDirectTurn`) rather than read back off the world afterwards. The two
  // readings available here — the conversation's recorded error, the absence of an outgoing message
  // — both answer about a MOMENT rather than about this turn: an error recorded by a previous
  // failure is still there, and an operator can post a reply of their own between the throw and any
  // read this side could make.
  // WHAT THE CLAIM DOES NOT DO IS REVOKE THE ORIGINAL HANDLER, and that is worth saying rather than
  // implying. `DEAD` is the sweep's verdict on a row nothing has moved for thirty minutes, and the
  // one shape it can be wrong about is a handler that is merely stalled: it holds no lock this side
  // can take away, so claiming the row from `DEAD` takes the LEDGER back and nothing else. If that
  // handler resumes, its own tx2 CAS finds the row gone and settles nothing — but whatever it did
  // before then is done.
  //
  // The overlap that matters is two INVOKES, and that one is fenced: a handler already inside
  // `runAgentTurn` holds the thread's durable claim (issue #203), which is exactly what the fence
  // above asks the row for, so the recovery defers rather than running beside it. What is left is a
  // handler stalled for half an hour BEFORE its turn — every await between the claim and
  // `runAgentTurn` is a scoped query or a REST read with its own deadline, so reaching that state
  // means the process is pathological rather than slow — and there the two turns overlap the way two
  // live deliveries for one conversation already can. The head of this file states the standing cost
  // that leaves: a recovery re-runs a turn that may call side-effecting tools.
  let turnThrew = false;
  // The outcome the DIRECT turn reported, or null when no turn ran at all. Null is not a third kind
  // of failure: it is the gate having decided before any turn — a human holding the conversation, a
  // status that is not `pending`, a control command consumed — and the gate's decision IS the answer
  // to whether this message is still owed a reply.
  let turnOutcome: string | null = null;
  // HELD ACROSS THE HANDOFF, not merely probed before it. The fence above answers about the moment
  // it ran; this makes the answer stay true until the turn takes its own claim. Balanced in the
  // `finally`, because an unbalanced mark is not a harmless leak — every reader of this key would
  // defer on this conversation until the process restarts (../../graph/inflight.ts).
  markTurnInFlight(handoffKey);
  try {
    outcome = await processChatwootDelivery({
      tenantId: params.tenantId,
      instanceId,
      deliveryRowId: row.id,
      agentBotId,
      normalized,
      claimFrom: "DEAD",
      onDirectTurn: (r) => {
        if (r.kind === "error") turnThrew = true;
        // Recorded, not judged. `TURN_ANSWERED` below is what decides, and it is a POSITIVE list
        // for a reason this hook cannot enforce on its own: an outcome nobody has considered yet
        // must not close a loss by defaulting into the good half.
        else turnOutcome = r.outcome;
      },
      base,
      deps: params.deps,
    });
  } catch (e) {
    // The row is on PROCESSING here, which the sweep revisits, so a write that cannot land is
    // recoverable without anyone: the row is declared stranded again thirty minutes later.
    const put = await putRowBack({
      base,
      tenantId: params.tenantId,
      rowId: row.id,
      from: "PROCESSING",
      sleep: params.deps?.sleep,
    });
    logger.error(
      "chatwoot recovery: the delivery path threw on %s (conversation %d); row put back to DEAD: %s — %s",
      row.deliveryId,
      conversationId,
      put === "restored"
        ? "yes"
        : put === "moved"
          ? "no, it had moved"
          : "NO, the write failed; the sweep will report it stranded again",
      e instanceof Error ? e.message : String(e),
    );
    return "unreachable";
  } finally {
    clearTurnInFlight(handoffKey);
  }
  // "skipped" means the claim matched nothing: another recovery took the row between the read above
  // and the CAS. The winner is running it, so this pass has nothing left to do and nothing to retry.
  if (outcome !== "processed") return "superseded";

  // The row goes BACK to DEAD, which is the same repair the throw above makes and for the same
  // reason: it left the worklist at the claim, and the customer is still owed a reply. The attempt
  // stays spent — the claim stamped it — so `MAX_RECOVERY_ATTEMPTS` bounds the retrying without
  // anything else counting. `unreachable`, so the job backs off and eventually dead-letters: a model
  // or provider that keeps throwing is a condition an operator has to see, exactly like an account
  // that cannot be reached. No closing line, because nothing closed.
  // The turn ran and left this message UNSETTLED. A POSITIVE list, because the question is "is this
  // customer still owed a reply", and the honest default for an outcome this file has not thought
  // about is yes. What settles it is `TURN_SETTLED` above, with the reasoning for each of the three.
  //
  // What does not, and each for its own reason:
  //
  //   `superseded` — `shouldPost` found a message the customer sent after this one and stood down.
  //                  For a LIVE delivery that is right: the newer message's own delivery carries the
  //                  reply. A recovery cannot lean on that — the newer delivery can have finished
  //                  before this turn ingested the stranded text, and then nothing is coming at all.
  //                  The same race the freshness check before the claim narrows, arriving in the
  //                  sliver it leaves.
  //   `empty`      — the turn reached the end and delivered neither text nor an attachment. For a
  //                  live delivery the event is handled and the row is settled; here the row exists
  //                  BECAUSE the customer was left waiting, and an empty second attempt leaves them
  //                  waiting with nothing else on the way. Not the same as `blocked`, which is a
  //                  policy deciding rather than a model running dry — see `TURN_SETTLED`.
  //   `no-agent` / `agent-unavailable` — the route cannot answer at all. Both write their own
  //                  operator-facing line, and both need an operator; what they must not do is take
  //                  the message off the worklist that operator reads.
  const turnUnsettled = turnOutcome !== null && !TURN_SETTLED.has(turnOutcome);
  if (turnThrew || turnUnsettled) {
    // From PROCESSED, and that is the state nothing revisits: the sweep reads PENDING and PROCESSING
    // only. A write that cannot land here leaves the customer out of the worklist with nobody having
    // answered, which is the exact loss this whole subsystem exists to make impossible — so it is
    // said at `error`, naming the row, rather than folded into the line below.
    const put = await putRowBack({
      base,
      tenantId: params.tenantId,
      rowId: row.id,
      from: "PROCESSED",
      sleep: params.deps?.sleep,
    });
    if (put === "failed") {
      logger.error(
        "chatwoot recovery: %s (conversation %d) is left PROCESSED with nobody answered — nothing revisits that state, so it needs an operator",
        row.deliveryId,
        conversationId,
      );
    }
    logger.warn(
      "chatwoot recovery: the turn %s on %s (conversation %d), so the loss is NOT closed; row put back to DEAD: %s",
      turnThrew ? "threw" : `came back "${turnOutcome}"`,
      row.deliveryId,
      conversationId,
      put === "restored"
        ? "yes"
        : put === "moved"
          ? "no, it had moved"
          : "NO, the write failed",
    );
    // Two roads, because the two are waiting on different things. A THROW is a model or provider
    // that could not answer, which is a condition an operator may have to fix, so it backs off
    // toward the dead-letter line like an unreachable account. Every SETTLED non-answer is nothing
    // broken and nothing a retry improves — the message lost its race, or the turn had nothing to
    // say, or the route cannot answer — so the job completes and the row stays DEAD on the
    // operator's page, which is the only honest record left of a customer message nothing replied
    // to.
    return turnThrew ? "unreachable" : "superseded";
  }

  // THE LINE THAT CLOSES THE LOSS, and it has to be written HERE rather than left to
  // `retireCoveredDeliveries`. That function writes its correction only for rows it moves out of
  // `DEAD` itself, and this row left `DEAD` at the claim above — so by the time the turn settles it,
  // the row reads `PROCESSING` and takes the ordinary branch, which writes nothing. Without this the
  // row simply leaves the worklist and an operator is left holding a page about a customer nobody
  // can find any more, which is the exact failure the sweep's correction exists to prevent.
  //
  // "recovered" rather than "answered" or "consumed", because that is what this place knows. The
  // delivery path decides which of those happened, and with coalescing on it has not happened yet —
  // the reply is the flush's, minutes from now. Reporting an answer here would be the same class of
  // lie the settlement vocabulary was split to avoid.
  //
  // `warn`, matching the correction it stands in for, and it does not page the channel the loss
  // paged: a channel's `minLevel` defaults to `error`, so this is read on the Logs page. That gap is
  // the existing correction's too, and the reason is written where that one is.
  const closed = await writeFlowEvent(
    {
      tenantId: params.tenantId,
      turnId: crypto.randomUUID(),
      source: "inbox",
      conversationId: conv.id,
      agentId,
      base,
    },
    {
      stage: "delivery",
      level: "warn",
      status: "ok",
      detail: {
        outcome: "recovered",
        deliveryEvent: "message_created",
        // The three the sweep's own loss line carries, so the two can be read as one story, plus
        // the delivery id its log line named.
        deliveryId: row.deliveryId,
        messageId,
        conversationId,
      },
    },
  );
  // `writeFlowEvent` swallows its own failure and reports it, the same shape the sweep's own lines
  // use. Loud, because nothing retries this one: the row has already left DEAD, so the loss is out
  // of the worklist with the page an operator received still open, and this log line is the only
  // remaining trace of how it ended.
  if (!closed.delivered) {
    logger.error(
      "chatwoot recovery: %s was recovered but its closing line could not be written; the loss reported for conversation %d has nothing closing it",
      row.deliveryId,
      conversationId,
    );
  }
  return "recovered";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The raw page item for one message id. Raw on purpose: `parseChatwootMessages` returns the shape
// the RENDERER wants (transcriptions, attachment types, reply ids) and drops the sender object and
// the attachment records, which is precisely what a body has to carry.
function findRawMessage(
  raw: unknown,
  id: number,
): Record<string, unknown> | null {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.payload)
      ? raw.payload
      : [];
  for (const item of list) {
    if (isRecord(item) && item.id === id) return item;
  }
  return null;
}

// ── The job ──────────────────────────────────────────────────────────────────────────────────────
//
// A kind of its own rather than work the sweep does inline, and lanes.ts states the reason as a
// rule: the sweep spends no provider capacity and this spends a whole turn. Folded into the sweep,
// one pass over a backlog would start a batch's worth of agent turns inside a job whose lane is
// sized for indexed queries.

export function deliveryRecoveryDedupeKey(deliveryRowId: bigint): string {
  return `delivery-recovery:${deliveryRowId}`;
}

// Whether a stranded row is worth arming a recovery FOR, asked of the row alone. A row that names no
// conversation or no message is one an older build wrote, and there is nothing to rebuild a body
// from — no pass will ever change that.
//
// ONE definition with two callers, and that is the point of it being here rather than a second
// condition at the sweep: the recovery re-asks it after claiming (the row can only be read then),
// and a copy at the arming site is the same question in one more place, which is the defect this
// repo keeps paying for. What the arming site buys by asking is real, though — a job that can only
// say "unrecoverable" still takes a claim, and these are armed for `now` on the traffic-proportional
// share of the batch, so on an upgrade's backfill they would be the OLDEST rows and would push the
// recoveries that can work behind them.
// A type predicate rather than a plain boolean, so the caller that goes on to USE the two ids gets
// them narrowed by the same statement that decided they are there — the alternative is a second
// null check written only to satisfy the compiler, which is a check nobody can tell from a real one.
export function isRecoverableStrand<
  T extends { conversationId: number | null; inboundMessageId: number | null },
>(row: T): row is T & { conversationId: number; inboundMessageId: number } {
  return row.conversationId !== null && row.inboundMessageId !== null;
}

// Arms the recovery of ONE stranded row. Called by the sweep at the moment it declares the row DEAD,
// which is the only moment anything knows the row just became recoverable: the sweep's own query
// reads PENDING and PROCESSING, so a DEAD row is invisible to every later pass.
//
// `rearm: "new-work"` because that is what a second arming would be. A row can only be declared DEAD
// once — `finish` is a CAS — so in practice this is armed once per row and the question is
// hypothetical; answered anyway, because the row it upserts carries the failure budget, and a row
// re-armed as the same work would hand a recovery that keeps failing a fresh five every time.
export async function armDeliveryRecovery(
  tenantId: bigint,
  deliveryRowId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "DELIVERY_RECOVERY",
    dedupeKey: deliveryRecoveryDedupeKey(deliveryRowId),
    // Now. The message has already waited out the staleness window; what it is waiting on next is
    // the shared tick, which is the delay this design accepts (lanes.ts).
    runAt: new Date(),
    // A bigint does not survive JSON, and the payload column is one. Read back with parseDbId.
    payload: { deliveryRowId: String(deliveryRowId) },
    rearm: "new-work",
    base,
  });
}

function readDeliveryRowId(payload: unknown): bigint | null {
  if (!isRecord(payload)) return null;
  const v = payload.deliveryRowId;
  // `parseDbId` and not a local digits check, because the tree has ONE answer to "is this an id?"
  // and a scheduler payload is a transport like any other (#371). The range half it adds is not
  // load-bearing here: an id past 2^63-1 was measured to reach the CAS and match nothing, exactly
  // as a wrong-but-in-range id would. What IS load-bearing is the digits check, and that one has a
  // test — `BigInt` reads "0x10" as sixteen, which recovers a DIFFERENT row.
  return typeof v === "string" ? parseDbId(v) : null;
}

async function deliveryRecoveryHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const deliveryRowId = readDeliveryRowId(job.payload);
  // Nothing to work on, and no attempt can produce one. Failing would spend five attempts and then
  // announce a lost message that this job never identified in the first place.
  if (deliveryRowId === null) {
    logger.error(
      "chatwoot recovery: job %s carries no delivery row id; nothing to recover",
      String(job.id),
    );
    return { outcome: "done" };
  }

  const outcome = await recoverStrandedDelivery({
    tenantId: job.tenantId,
    deliveryRowId,
    base,
  });
  // The mapping the five outcomes exist for, and the two retrying ones take DIFFERENT roads because
  // they are waiting on different things.
  //
  // BUSY reschedules, which CLEARS the failure budget. A turn is deliberately unbounded — the sweep
  // waits thirty minutes before calling one abandoned — while the scheduler's five backoffs are
  // spent in about a minute. Mapped to `fail`, a conversation's SECOND stranded message would burn
  // its whole ladder while the first message's turn was still legitimately running, and lose its
  // recovery for good. Unbounded rescheduling is bounded anyway, by the one thing that does not
  // depend on the conversation: `MAX_RECOVERY_AGE_MS` turns the row `unrecoverable`, and the job
  // completes.
  //
  // UNREACHABLE fails, which spends the budget and backs off. An account that stays unreadable is a
  // durable condition an operator has to fix, so this one has to be given up on and SAID — and
  // `fail` is what reaches the dead-letter line at the scheduler's cap. Rescheduling it instead
  // would retry for the life of the install with nothing ever announcing it.
  if (outcome === "deferred") {
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + BUSY_RETRY_MS),
    };
  }
  if (outcome === "unreachable") {
    return {
      outcome: "fail",
      error: "recovery: the Chatwoot account could not be read",
    };
  }
  return { outcome: "done" };
}

// NO DEAD-LETTER HOOK OF ITS OWN, and that is a decision rather than an omission. `dispatchDeadLetter`
// already announces every kind's death (issue #356), and its generic line carries what this one
// would: the kind, the job id, and the dedupe key — which for this kind IS the delivery row id
// (`delivery-recovery:<id>`). A hook here would restate that and lose two things the generic path
// does: it re-reads the row so a re-armed job is not announced as a loss, and it takes its level
// from `JOB_DEATH_LEVEL`, where the answer is written next to the other twelve.
//
// That answer is `warn`, and the rule the map states is what decides it: `warn` where the operator
// has their own way back to the work. Here they do, twice over — the sweep already announced this
// exact delivery at `error`, and the row is still in the `WHERE status = 'DEAD'` worklist that is
// the whole point of #228. A second `error` is the same message paging somebody twice.

let registered = false;
export function registerDeliveryRecoveryHandler(): void {
  if (registered) return;
  registerJobHandler("DELIVERY_RECOVERY", deliveryRecoveryHandler);
  registered = true;
}
