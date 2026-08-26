import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { chatwootThreadId } from "@/graph/checkpointer";
import { isTurnInFlight } from "@/graph/inflight";
import type { RuntimeDeps } from "@/graph/runtime";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { writeFlowEvent } from "@/modules/flowlog/service";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { agentBotChatwootId, loadChatwootClient } from "./instance";
import {
  controlCommand,
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
// Process-local, the same invariant the seven other in-flight callers already run under.
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
  if (row.attempts >= MAX_RECOVERY_ATTEMPTS) return "unrecoverable";

  // Too late to be a recovery. Asked before any network, on the row's own receipt.
  const age = (params.now ?? new Date()).getTime() - row.receivedAt.getTime();
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

async function runRecovery(params: {
  tenantId: bigint;
  base: PrismaClient;
  deps?: RuntimeDeps;
  row: LoadedRow;
  instanceId: bigint;
  conversationId: number;
  messageId: number;
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
  const agentId = conv.inbox?.agentId ?? null;
  const agentBotId =
    agentId === null
      ? null
      : await agentBotChatwootId(params.tenantId, instanceId, agentId, base);

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
  let live: ReturnType<typeof parseLiveConversation> = null;
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
    raw = await client.getMessages(conversationId, { before: messageId + 1 });
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
  const reconciled = await reconcileMirrorFromLive({
    tenantId: params.tenantId,
    instanceId,
    conversationId,
    live,
    base,
  });
  // The row AFTER the reconcile, which is the truth in both directions: the live snapshot where it
  // won, and whatever outranked it where it lost. Null only if the mirror row vanished between the
  // two reads, and the row read above is then the best thing left.
  const state = reconciled.state ?? conv;

  const message = findRawMessage(raw, messageId);
  // Chatwoot no longer has the message: deleted, or the conversation was. There is nothing to
  // answer, and no number of retries will change that.
  if (!message) return "unrecoverable";

  const normalized = normalizeChatwootEvent(
    buildRecoveryPayload({
      conversation: {
        chatwootConversationId: conversationId,
        // From the mirror, and only this one: the REST conversation renders no `contact_inbox`
        // (MEASURED), and the pairing does not move anyway.
        contactInboxId: conv.contactInboxId,
        redirectOriginDisplayId: conv.redirectOriginDisplayId,
        status: state.status,
        assigneeType: state.assigneeType,
        assigneeId: state.assigneeId,
        assigneeName: state.assigneeName,
      },
      inboxId: conv.inbox?.chatwootInboxId ?? null,
      inboxName: conv.inbox?.name ?? null,
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
  if (controlCommand(normalized) !== null) {
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
  // It NARROWS the window and does not close it: the last one is `processChatwootDelivery`'s own
  // path down to where `runAgentTurn` marks the thread. What is left is the same overlap two live
  // deliveries for one conversation already have, which the post-response supersede and the
  // monotonic watermark CAS are what bound. Closing it properly means an exclusion both entry paths
  // take at the turn boundary, which is issue #203's durable fence and not this issue.
  if (
    isTurnInFlight(
      chatwootThreadId(params.tenantId, instanceId, conversationId),
    )
  ) {
    return "deferred";
  }

  const outcome = await processChatwootDelivery({
    tenantId: params.tenantId,
    instanceId,
    deliveryRowId: row.id,
    agentBotId,
    normalized,
    claimFrom: "DEAD",
    base,
    deps: params.deps,
  });
  // "skipped" means the claim matched nothing: another recovery took the row between the read above
  // and the CAS. The winner is running it, so this pass has nothing left to do and nothing to retry.
  if (outcome !== "processed") return "superseded";

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
      agentId: conv.inbox?.agentId ?? null,
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
    // A bigint does not survive JSON, and the payload column is one. Read back with BigInt().
    payload: { deliveryRowId: String(deliveryRowId) },
    rearm: "new-work",
    base,
  });
}

function readDeliveryRowId(payload: unknown): bigint | null {
  if (!isRecord(payload)) return null;
  const v = payload.deliveryRowId;
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
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
