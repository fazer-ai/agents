// Answering the customer whose delivery a process death stranded, by running the DELIVERY PATH
// again: not a flush, since the delivery path's gates die with the process, and not a
// re-implementation of gates that decide AND act; re-firing their side effects is safe per gate. AT
// LEAST ONCE: a turn whose tools had fired fires them again, and the one refused replay is a control
// command (`/reset` deletes the memory thread), which an operator can retype. It never runs a turn
// beside a live one in this process: the in-memory turn-in-flight fence is asked first, safe under
// docs/deploy.md §4's single-replica invariant; a turn live on ANOTHER replica is a gap every module
// gating on it shares. Why each: docs/chatwoot.md, "Webhook receiver", on the delivery recovery.

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { chatwootThreadId, resolveGraphThreadId } from "@/graph/checkpointer";
import {
  clearTurnReserved,
  isTurnInFlight,
  markTurnReserved,
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
  inboundTranscriptionOnUpdate,
  isNewIncomingMessage,
  normalizeChatwootEvent,
  parseLiveConversation,
  TURN_BEARING_EVENT,
} from "./normalize";
import { reconcileMirrorFromLive } from "./reconcile";
import { buildRecoveryPayload } from "./recover-payload";
import { processChatwootDelivery } from "./webhook";

// How many recoveries one stranded row may ever get, counted by the ledger's `attempts`, which the
// claim in `processChatwootDelivery` writes. THREE is policy, not tuning. A bound exists because a
// recovery runs a real turn (model spend, side-effecting tools), and a row failing for a reason
// recovery cannot fix (a deleted conversation, a revoked token) would retry for the life of the
// install.
export const MAX_RECOVERY_ATTEMPTS = 3;

// How old a stranded delivery may be and still be answered automatically, from when the ledger row
// was RECEIVED. SIX HOURS is policy; a ceiling exists because a reply is a recovery only while the
// customer is plausibly waiting (later it is a stranger reopening a conversation, better left on the
// DEAD worklist), and because the delivery path replies FREE-FORM with no service-window check, which
// a stale recovery breaks: an official provider rejects the send outside 24h and the row ends
// PROCESSED with the customer unanswered. A ceiling well inside any window avoids a second copy of
// `proactiveSendMode` here. Not covered: an agent whose `serviceWindow.windowHours` is below this.
export const MAX_RECOVERY_AGE_MS = 6 * 60 * 60 * 1000;

// How long to wait before asking again about a conversation that was BUSY. A minute: long enough
// that a short turn is over, short enough that a customer's second stranded message is not left
// behind the first one for a scheduler interval. Nothing measures a turn's length (there is no
// timeout on the model call or the tools), so this is a cadence, not an estimate of one.
const BUSY_RETRY_MS = 60_000;

// Conversations with a recovery running IN THIS PROCESS, so a second one defers instead of starting
// a turn beside the first. The row CAS serializes one ROW, but two stranded messages are two DEAD
// rows claimed in the same tick, and `isTurnInFlight` cannot answer for them (a turn marks itself
// deep in `runAgentTurn`, several awaits after this check). Checked and added with NO AWAIT BETWEEN,
// which makes it a claim: the first to resume owns the conversation. Process-local like the Map
// behind `isTurnInFlight` (../../graph/inflight.ts); what crosses replicas is the turn's own claim on
// the thread's row, asked by the fence just before the handoff.
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
  // construction and on a timescale nothing here controls: a turn is deliberately unbounded, which
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

// The turn outcomes that SETTLE the message: nobody is owed a reply and the row may leave the
// worklist; anything else keeps it. A SET rather than the runtime's union, so a new outcome lands on
// the safe side without anyone coming back. Settled is not answered: `posted`, `taken-over` (a human
// holds it), `answered-elsewhere` (a person already replied), `blocked` (the operator's silent
// guardrail; unlike `empty`, a re-run reproduces it), `posted-partial` (the turn's CAS already moved
// the watermark, so a re-run posts nothing; the missing half goes to `notePartialDelivery`) and
// `taken-over-unread` (the receiver throws when it cannot arm the ingestion, so this alone means the
// message is kept). Why each: docs/chatwoot.md, "Mirror sync".
const TURN_SETTLED = new Set([
  "posted",
  "posted-partial",
  "taken-over",
  "answered-elsewhere",
  "blocked",
  "taken-over-unread",
]);

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
        // NOTE: which event the delivery carried, so the rebuild reproduces it instead of asserting
        // one: a customer message's creation or the `message_updated` carrying its transcription.
        // Rebuilt as a creation, the second would drive a turn and answer an answered message again.
        event: true,
        conversationId: true,
        inboundMessageId: true,
        // NOTE: which route this delivery arrived on, so the recovery re-runs the same one. For an
        // OBSERVER's delivery the inbox names no responder, so the identity derived below is null and
        // the re-run would resolve no runtime and lose the message the observer's ingestion owed. The
        // takeover recovery reads the column for the neighbouring reason: two routes, two answers.
        routeAgentBotId: true,
        routeObserved: true,
        // NOTE: the world the message arrived in: the inbox's binding generation at receipt, written
        // by the INSERT rather than the claim, so it is readable on the rows that stranded before a
        // role was stated.
        bindingGeneration: true,
        // NOTE: what that pass owed: true where the receiver decided no turn would run before arming
        // the ingestion that then failed, the one fact the replay cannot re-derive (everything else it
        // rebuilds describes the conversation NOW).
        owesMemoryOnly: true,
        // NOTE: and the scope that pass would have settled with, derived from who held the
        // conversation: rebuilt now, it would describe ownership as it stands and not the stand-down
        // being replayed.
        settleScopedToThisDelivery: true,
      },
    }),
  );
  // Gone, or already taken back by something else. Not a failure: the claim below would have said
  // the same thing, and saying it here spends no network.
  if (row?.status !== "DEAD") return "superseded";

  // NOTE: a row the sweep reported without ids is one an older build wrote, and there is nothing to
  // rebuild a body from. It stays DEAD and stays in the worklist. Re-asked here rather than trusted
  // from the arming site: the row is only readable now, and the arming build may not have asked.
  if (!isRecoverableStrand(row)) return "unrecoverable";
  // NOTE: given up on, and said out loud: this is the one refusal that ends a recovery which was
  // really trying (most often a turn that kept throwing, routed to `unreachable` so the job backs
  // off). That backoff never reaches the scheduler's dead-letter line, since this cap is the lower of
  // the two and fires first, so this line plus the DEAD row is the operator's whole record.
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
  // The Chatwoot event name this delivery carried, replayed verbatim.
  event: string;
  // When the delivery was RECEIVED, which is what a binding is compared against: a row created after
  // it says nothing about the route the message arrived on.
  receivedAt: Date;
  // The route this delivery arrived on, so the re-run takes the same one: an observer's route
  // resolves from nothing else. Null on a row an older build wrote.
  routeAgentBotId: number | null;
  // Whether that route was the OBSERVER's, as the receiver recorded it. Null = never asked.
  routeObserved: boolean | null;
  // The inbox's binding generation when this delivery was received. Null on a row an older build
  // wrote, on a payload that named no inbox, and where the read failed: all three mean "this row
  // cannot say", never generation zero.
  bindingGeneration: number | null;
  // Whether the pass that stranded owed memory and nothing else, as the receiver wrote it before
  // arming. Null on a row an older build wrote and on one whose pass did run a turn: both read as
  // "this row cannot say", and the replay falls back to the event and the role.
  owesMemoryOnly: boolean | null;
  // How wide that pass would have settled. Null reads as "this row cannot say" and leaves the scope to
  // be derived from ownership now.
  settleScopedToThisDelivery: boolean | null;
}

// Putting the row back: the compensating write both failure roads below take, retried (the failure
// guarded against is a transient database blip) and bounded, with the log as the last word. A row
// that MOVED was taken by something else, which is fine; a write that FAILED leaves the row where the
// delivery path put it, and `PROCESSED`, unlike `PROCESSING`, is never swept again, so the caller
// says so at `error`. Not fenced: a handler merely STALLED past the sweep's threshold can still
// settle its row `PROCESSED` by id over one restored here, as it would with no recovery (why that
// write has no CAS: ./webhook.ts). A later recovery then reads a row that is no longer `DEAD` and
// refuses before claiming anything.
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
  // Whether this replay could post a reply, which decides three reads and refusals below. It
  // cannot on an OBSERVER's route (it posts nothing by construction), on a `message_updated` (no turn
  // anywhere, so memory only), or where the stranded pass owed memory only because a person held the
  // conversation or a gate had silenced the message; that last one is read off the row, where the
  // receiver wrote it, since the conversation read here may be back with the bot by now. Where no
  // reply is coming, the newest page and the freshness fence (which reasons about a reply arriving
  // late) are neither asked nor paid for. Decided off the ledger's event rather than the rebuild,
  // because the rebuild is two REST reads further down and one of them is what this decides.
  const replayPosts =
    row.routeObserved !== true &&
    row.event === TURN_BEARING_EVENT &&
    row.owesMemoryOnly !== true;

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
        // The mirror's own row id, for filing the closing line against the conversation, the same
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

  // Two reads off the account. The conversation's state cannot come from the mirror: the
  // delivery that would have mirrored this message is the one that died. An incoming message on a
  // `resolved` conversation reopens it (`pending` on a bot inbox, `open` otherwise) while the mirror
  // still says `resolved`, and a stale `resolved` in the body makes `shouldBotHandle` refuse, the row
  // PROCESSED and the customer never answered. The live snapshot goes through
  // `reconcileMirrorFromLive`, which REPAIRS the mirror under the webhook's ordering rule (a webhook
  // committed in between still outranks it), and its row is what the body is built from. The message
  // read is the one thing no mirror holds; `before` anchors the page that ENDS at this id.
  let raw: unknown;
  let recent: ReturnType<typeof parseChatwootMessages> = [];
  // What the catch-up read below found past the stranded message, when it was asked.
  let caughtUp: ReturnType<typeof parseChatwootMessages> = [];
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
    // NOTE: applied immediately, before the two message reads: a snapshot is evidence about the
    // instant it was READ. The reconcile falls back to `last_activity_at` where versions are missing,
    // and that fallback cannot see a handoff or a resolve, so held across two round trips a takeover
    // committed inside them would be walked back by this older bot-owned snapshot and the rebuilt
    // delivery would answer over the human. The other callers (../../graph/nudge.ts, the console's
    // buttons) also reconcile in consecutive statements.
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
    // NOTE: a reaction the anchored page cannot carry. The fork pages by the messages that are not
    // reactions and keeps a reaction only when its target is in the same page of the same
    // conversation, so a reaction to an older message is on no `before` page and would read as
    // deleted. The catch-up read lists by id with no such window.
    if (findRawMessage(raw, messageId) === null) {
      const caught = await client.getMessages(conversationId, {
        after: messageId - 1,
      });
      if (findRawMessage(caught, messageId) !== null) {
        raw = caught;
        caughtUp = parseChatwootMessages(caught);
      }
    }
    // NOTE: the NEWEST page, unanchored, answers whether the customer has written again since: the
    // anchored page ends at the stranded message, and the newest page need not contain it (the
    // default page holds 20). Not fetched on a replay that posts nothing, the only reader of this
    // page: an observation or a memory append is not an answer, and a failed read here would return
    // `unreachable` and spend the budget over a page nothing reads. What the catch-up read found
    // counts too: a newer reaction the default page leaves out is still the customer writing again.
    // A read that came back FULL is refused below before it is trusted as coverage.
    recent = replayPosts
      ? mergeById(
          parseChatwootMessages(await client.getMessages(conversationId)),
          caughtUp,
        )
      : [];
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
  // trust (no status, or an AgentBot assignee with no id: unverifiable ownership). Deferring is
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
  // call decided; a second read would answer about a different moment, and the two message reads
  // sit between them.
  const state = reconciled?.state ?? conv;

  // NOTE: the page has to reach back to the message: twenty outgoing or activity messages since the
  // strand would push a newer CUSTOMER message off the newest page, and this would replay a message
  // the customer has passed. Not reaching back means the conversation moved more than a page since,
  // which a later attempt does not walk back; an EMPTY page is a degraded read instead. Only where the
  // replay would answer: an observer's or a transcription replay owes the words reaching memory, and
  // an ingest job carries its own message only, so a newer message does not cover this one and
  // refusing it would lose the words for good.
  if (replayPosts) {
    // NOTE: a FULL catch-up read (a hundred messages at or past this one) stops short of the newest
    // page and cannot say what sits in the gap: merged as coverage it would hide a newer message
    // there, discarded it would hide the newer reactions it carried. Either way the message is a
    // hundred behind, further than the page rule below answers, so it is not answered.
    if (caughtUp.length >= CATCH_UP_PAGE) {
      logger.info(
        "chatwoot recovery: %s has a full catch-up read behind it on conversation %d; not answered",
        row.deliveryId,
        conversationId,
      );
      return "unrecoverable";
    }
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
    // A customer who wrote again cannot be answered about the older message. Live,
    // `shouldPost` withholds the reply and the newer message's delivery carries it; for a recovery
    // that delivery already ran and answered the newer message only (a direct turn feeds the graph
    // its OWN trigger text), so the replay would spend a model call, post nothing and close the loss
    // falsely. Asked HERE, before the claim, as `unrecoverable` (a newer message never un-arrives),
    // through `maxIncomingId`, the delivery path's own predicate: an away message or an operator's
    // note moves the conversation forward without answering anything.
    const newest = maxIncomingId(recent, messageId);
    if (newest > messageId) {
      // Which of the two cases, said out loud, because they read the same from the row and an
      // operator does different things about them. The newer message's delivery is NOT dead: it ran
      // or is running and carries the reply. Or its row is DEAD TOO, a stranded BURST: the newest
      // row's recovery answers the conversation, and this older message's TEXT never reaches a model
      // (a direct turn carries its own trigger text), so this row stays DEAD on the operator's page,
      // their only signal. Recovering a burst together is the flush's job, not this module's.
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
  }

  const message = findRawMessage(raw, messageId);
  // Chatwoot no longer has the message: deleted, or the conversation was. There is nothing to
  // answer, and no number of retries will change that.
  if (!message) return "unrecoverable";

  // The route comes from the MESSAGE rather than the mirror. `Conversation.inboxId` is null
  // for a conversation whose first mirrored event named no inbox, and the delivery that would have
  // taught it one is the row being recovered; a body with no `inbox_id` makes `runAgentTurn` return
  // "skipped", closing the loss with the customer still waiting. Every message the index serializes
  // renders its OWN `inbox_id` (the fork's `_message.json.jbuilder`), which is what
  // `Message#webhook_data` builds the body's `inbox` from; the mirror is the fallback. Not a stale
  // route: a conversation never changes inbox (docs/chatwoot.md, "Known limitations"), so the two
  // readings can differ only by one being absent.
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
  // The local row for THAT inbox, where the bound agent, its mode and the name live. Always
  // re-read, never the snapshot loaded with the conversation: an operator can rebind the same inbox
  // during the two REST reads, and the stale persona's bot would make the ownership gate consume the
  // message without replying. The agent's MODE comes in the same scoped transaction, because whether
  // a control command is ACTIVE is that mode, and binding and mode must answer about one moment.
  const route = await runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    const found = await db.inbox.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootInboxId: {
          tenantId: params.tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: routeInboxId,
        },
      },
      select: {
        id: true,
        chatwootInboxId: true,
        name: true,
        agentId: true,
        // When THIS binding was made. A role the row never stated cannot be read off a binding
        // younger than the delivery; see the refusal below.
        responderBoundAt: true,
        // NOTE: ...and whether any binding has moved since, which the stamp above cannot answer: an
        // observer attached or detached leaves `responderBoundAt` where it was.
        bindingGeneration: true,
      },
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

  // The route's role, as the receiver recorded it. An observer's delivery is nameable by
  // nothing else (the inbox names the responder, or nobody), and nothing after the fact can answer:
  // the observer row is written only once Chatwoot agrees, and a binding that moved since is about a
  // different moment. A row with no role takes the inbox's own derivation. A Chatwoot bot id is
  // mutable, so it is checked against the bot rows: an observer bot re-provisioned since would
  // resolve no runtime and consume the message, so the row is left DEAD for an operator instead.
  let observerRouteBotId: number | null = null;
  const routeBotId = row.routeAgentBotId;
  if (row.routeObserved === true && routeBotId !== null) {
    const known = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.chatwootAgentBot.findFirst({
        where: {
          tenantId: params.tenantId,
          chatwootInstanceId: instanceId,
          chatwootAgentBotId: routeBotId,
        },
        select: { id: true },
      }),
    );
    if (known === null) {
      logger.warn(
        "chatwoot recovery: %s arrived on observer bot %d, which no persona of ours carries any more; not replayed",
        row.deliveryId,
        routeBotId,
      );
      return "unrecoverable";
    }
    observerRouteBotId = routeBotId;
  }
  // Which bot answers, derived rather than stored: Chatwoot fans one message to up to two bot
  // routes (the conversation's assignee bot and the inbox's), so the route it came from is not who
  // should answer now; if the conversation moved to another bot, the ownership gate closes on that.
  // `agentBotChatwootId` is the repo's one answer, and it does not decrypt the token. Asked HERE,
  // above the mirror re-read: nothing may await between the fence answering "free" and the mark that
  // holds it, and the re-read is the one reading the body and the fence's graph key both come from.
  // The refusal it feeds stays below the body and above the fence, so a route with no persona
  // answers `unrecoverable` rather than `deferred`.
  const responderBotId =
    agentId === null
      ? null
      : await agentBotChatwootId(params.tenantId, instanceId, agentId, base);
  // NOTE: a null role is "nobody decided", not "the responder's": the row stranded between the claim
  // and the receiver's statement, or predates the column. Asked only where the answer can differ: a
  // route that IS the inbox's responder bot is the responder's whatever the column says (refusing
  // those would kill every ordinary strand). Any other route is an observer's or a drifted mirror,
  // and replaying it as the responder loses an observation or answers a message twice, so it is left
  // DEAD for an operator, as with the re-provisioned bot above.
  if (
    row.routeObserved === null &&
    routeBotId !== null &&
    routeBotId !== responderBotId
  ) {
    logger.warn(
      "chatwoot recovery: %s arrived on bot %d, which does not answer this inbox, and names no route role; it stranded before the receiver could state one and this module does not guess — not replayed",
      row.deliveryId,
      routeBotId,
    );
    return "unrecoverable";
  }
  // And bot equality is evidence only while the binding is OLDER than the delivery: one bot
  // serves every role its agent holds, so an observer re-bound as the responder keeps its Chatwoot
  // id, and the test above would read the responder's role off a binding that did not exist at
  // receipt, ending in a late reply. It refuses only where TWO facts agree: the stamp alone refuses
  // too much (any inbox bound while its traffic was in flight), and the generation (which moves on
  // EVERY binding write) alone would refuse the responder's own deliveries after any observe. A row
  // with no generation, as every older build's, keeps the stamp alone; the migration leaves it null.
  const bindingMovedSinceReceipt =
    row.bindingGeneration !== null && inbox?.bindingGeneration != null
      ? inbox.bindingGeneration !== row.bindingGeneration
      : true;
  if (
    row.routeObserved === null &&
    routeBotId !== null &&
    inbox?.responderBoundAt != null &&
    inbox.responderBoundAt > row.receivedAt &&
    bindingMovedSinceReceipt
  ) {
    logger.warn(
      "chatwoot recovery: %s arrived on bot %d and names no route role, and the responder binding it would be read against was made after the delivery — the role at receipt is not knowable from here; not replayed",
      row.deliveryId,
      routeBotId,
    );
    return "unrecoverable";
  }
  // And the ledger's own route, for a replay that only remembers. A transcription replay passes
  // the identity fence below because it posts nothing, but the id is also the left-hand side of the
  // ownership comparison: null, it goes LOOSE, a conversation another AgentBot holds reads as ours,
  // and the delivery path skips the ingestion this replay exists for. Replaying who the delivery
  // arrived as follows the rule used for the role: bindings move, and the question is about receipt
  // time. Only where the persona is gone and only for a replay that cannot answer; a reply-producing
  // one is refused below, since a bot id its persona no longer carries would post as nobody.
  const agentBotId =
    observerRouteBotId ?? responderBotId ?? (replayPosts ? null : routeBotId);

  // NOTE: the mirror learns the route, as a repair: `runAgentTurn` resolves the agent from the
  // EVENT's inbox, but `maybeConsumeCommandOrGate` resolves it from `Conversation.inboxId`, and on null
  // it runs NOTHING (not test mode, availability or contact authorization) while the turn still runs,
  // so a never-activated test agent would post to a real customer. Ordinary events write this column
  // only when they win the ordering (./mirror.ts) and the rebuilt body is stale by construction, so it
  // is done here, before the gates read it. Only from NULL: a column naming an inbox is a statement
  // this module cannot overrule. The `if` is the cheap answer and the WHERE the one that holds.
  if (conv.inbox === null && inbox != null) {
    await runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.conversation.updateMany({
        where: { id: conv.id, inboxId: null },
        data: { inboxId: inbox.id },
      }),
    );
  }

  // Re-read rather than carried from the load at the top: a webhook during the REST reads can
  // move `contactInboxId` (./mirror.ts writes it on an unversioned event), and the body and the
  // fence's graph key must come from the SAME reading, or the recovery fences one thread and runs on
  // another, and the old pairing in the body can be written back. Nothing between here and the fence
  // awaits, which is why the route's bot query sits above. The redirect pairing comes back too: the
  // mirror orders it by version, but `armRedirectChatFollowUp` UPSERTS a scheduler payload from the
  // event, so an old pairing would re-arm a follow-up for an episode the customer already left.
  const mirrorNow = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.conversation.findUnique({
      where: { id: conv.id },
      select: {
        contactInboxId: true,
        redirectOriginDisplayId: true,
        chatwootRedirectOriginAt: true,
        // NOTE: the conversation's own STATE, from HERE rather than `reconciled.state`: both are the
        // same row and neither is the live snapshot, and this is the later reading, so a handoff or
        // resolve landing while the route queries ran is in it. ONE reading is stated, not two.
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
      event: row.event,
      conversation: {
        chatwootConversationId: conversationId,
        // NOTE: from the mirror, and only this one: the REST conversation renders no
        // `contact_inbox`. Re-read immediately above rather than taken from the load at the top,
        // because the pairing DOES move.
        contactInboxId,
        redirectOriginDisplayId: mirrorNow?.redirectOriginDisplayId ?? null,
        redirectOriginAt: mirrorNow?.chatwootRedirectOriginAt ?? null,
        // NOTE: a resolve that lands after this read is not ordered away here, by the delivery path's
        // rule: a brand-new incoming message is the one event allowed to move a stored `resolved`
        // back to `pending` (./state-order.ts), because in Chatwoot it really does reopen it. A live
        // delivery has the same exposure and a wider one (the payload is frozen at enqueue). The later
        // reading (`mirrorNow`) is stated; `state` is the fallback only for a vanished row, never per
        // FIELD, since a mirror `null` STATES that nobody holds the conversation and `??` would read
        // that statement as an absence.
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
      // body; null where the mirror has no row for the route, which is the placeholder case named
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
  // Unreachable in practice (the body above is built to normalize), and not an assertion: a
  // recovery that cannot produce an event has nothing to hand the delivery path, and saying so is
  // cheaper than a throw nobody catches.
  if (!normalized) return "unrecoverable";

  // THE AGE, ASKED AGAIN ON THE CUSTOMER'S OWN CLOCK. The check at the top is on `receivedAt`, which
  // is when THIS application inserted the ledger row, not when the customer wrote. A webhook
  // delayed by a Chatwoot retry or an outage on our side inserts late, so a message hours older than
  // the ceiling can pass that first check. The REST read is what finally supplies the true instant,
  // and it is asked BEFORE the claim so a refusal spends no attempt.
  const sentAt =
    typeof message.created_at === "number" ? message.created_at : null;
  // NOTE: a message with no clock is a degraded read, refused rather than replayed. The body's
  // `last_activity_at` comes from it, and without it the mirror falls back to the arrival of the
  // rebuilt event, moving `lastInboundAt` (the anchor of the follow-up episode gate and the WhatsApp
  // 24h window) forward by the time the row sat stranded. `unreachable`, like a body naming no inbox:
  // the fork renders `created_at` on every message the index serializes, so the read is degraded.
  if (sentAt === null) {
    logger.warn(
      "chatwoot recovery: %s came back without a created_at (conversation %d); the REST read is degraded",
      row.deliveryId,
      conversationId,
    );
    return "unreachable";
  }
  // NOTE: and only where a reply is coming. A transcription replay answers nobody, and its words
  // arrive on the write-back of an audio CREATED before them, so this cutoff would refuse exactly the
  // class it cannot help. Its bound is the row's own receipt, checked before any network against the
  // same ceiling. Asked of the EVENT alone and not of `replayPosts`, so an observer's replay of a
  // creation keeps the ceiling.
  if (
    row.event === TURN_BEARING_EVENT &&
    params.now.getTime() - sentAt * 1000 > MAX_RECOVERY_AGE_MS
  ) {
    return "unrecoverable";
  }

  // Still an inbound message, or the read was degraded: `inboundMessageId` is written for
  // nothing else, so a rebuild that comes out as anything else (a missing `message_type` normalizes
  // to "other") is a REST response that lost something, and handing it on would run no turn yet close
  // the loss. Either shape the ledger can name, asked as the classifier asks it: a creation must
  // rebuild as a new incoming message, a transcription strand must still carry its words.
  // `unreachable`: the account answered with something unusable, which the next attempt may not.
  const rebuiltInbound = isNewIncomingMessage(normalized)
    ? true
    : inboundTranscriptionOnUpdate(normalized) !== null;
  if (!rebuiltInbound) {
    logger.warn(
      "chatwoot recovery: %s rebuilt as a %s message with nothing to replay, not the %s it was; the REST read is degraded",
      row.deliveryId,
      normalized.message?.messageType ?? "unknown",
      row.event,
    );
    return "unreachable";
  }

  // NOTE: a control command is not replayed: `/reset` deletes before the tail settles its row, so a
  // replay would delete the memory gathered SINCE; its author, an operator, can retype it, and the
  // row stays DEAD for them. Only where a command is ACTIVE, a TEST-mode agent (elsewhere `/reset` is
  // text the turn answers, ./webhook.ts), with the mode read here with the BINDING in one
  // transaction. Not on an OBSERVER's route, which never executes one and whose ingestion is what
  // stranded the row; only of a CREATION, as the live path asks. Why each, and the mode-flip window
  // left open: docs/chatwoot.md, "Webhook receiver", on the delivery recovery.
  if (
    isNewIncomingMessage(normalized) &&
    observerRouteBotId === null &&
    agentMode === "test" &&
    controlCommand(normalized) !== null
  ) {
    logger.info(
      "chatwoot recovery: %s carries a control command; not replayed (conversation %d)",
      row.deliveryId,
      conversationId,
    );
    return "unrecoverable";
  }

  // The fence is asked AGAIN just before the handoff (below): two REST reads and a reconcile
  // gave a live delivery, which does not consult the recovery claim, time to start a turn. BOTH keys,
  // the pair `/reset` asks in ./webhook.ts: the conversation key a turn takes at its top, and this
  // GRAPH key, which a follow-up NUDGE claims while posting (../../graph/nudge.ts). The graph half is
  // also asked of the ROW (`turnOwnsThread`, unreadable reads as "held"), since the Map says "free"
  // for a turn on another replica. It narrows the window without closing it; what covers the rest is
  // the mark held to the handoff, in this process, which under docs/deploy.md §4 is every one of
  // them. The rest of the argument: docs/chatwoot.md, "Webhook receiver", on the delivery recovery.
  const graphKey = resolveGraphThreadId(
    params.tenantId,
    instanceId,
    conversationId,
    contactInboxId,
  );
  // NOTE: a route whose agent has no bot identity is not recovered where the replay would post:
  // `heldByAnotherParty` compares ids, so with `ourAgentBotId` null the gate goes LOOSE and a
  // conversation another AgentBot holds reads as ours. The identity is what is missing, so this is not
  // narrowed to "held by another bot"; `unrecoverable`, the repair being an operator binding the inbox.
  // A transcription replay posts nothing and still runs, ownership asked with the ledger's route id;
  // where even that is missing, a loose comparison mis-answers only when an AGENT BOT holds the
  // conversation, so that case is refused. An agent bound to NOTHING still runs (its `no_agent` line).
  if (agentId !== null && agentBotId === null) {
    const heldByABot = (mirrorNow ?? state).assigneeType === "AgentBot";
    if (replayPosts || heldByABot) {
      logger.warn(
        "chatwoot recovery: %s routes to inbox %d, whose agent has no Chatwoot bot%s; not replayed",
        row.deliveryId,
        routeInboxId,
        heldByABot
          ? " and the conversation is held by an AgentBot this pass cannot name"
          : "",
      );
      return "unrecoverable";
    }
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
  // reader that crosses replicas. Then the Map AGAIN, and that last ask is the one that decides:
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

  // The row is put back if the delivery path throws, because the claim has already happened: a
  // scoped query that cannot reach the database escapes AFTER the CAS and leaves the row PROCESSING
  // with nothing holding it, so the next attempt answers `superseded` and the row waits thirty
  // minutes for the sweep, time it may not have against the age ceiling. Safe because this pass OWNS
  // the row (it won the CAS, and the write is guarded on the state it left), and `unreachable` rather
  // than a rethrow, so the scheduler's backoff runs and the retry finds a DEAD row to claim.
  let outcome: Awaited<ReturnType<typeof processChatwootDelivery>>;
  // A turn that threw is not an answer, and the delivery path's `"processed"` is about the ROW:
  // honest live, where the failure is recorded and announced, but for a recovery it would close the
  // loss on a customer nobody replied to. Asked for explicitly (`onDirectTurn`) rather than read back
  // off the world, since a recorded error or a missing outgoing message describes a MOMENT, not this
  // turn.
  let turnThrew = false;
  // The outcome the DIRECT turn reported, or null when no turn ran at all. Null is not a third kind
  // of failure: it is the gate having decided before any turn (a human holding the conversation, a
  // status that is not `pending`, a control command consumed), and the gate's decision IS the answer
  // to whether this message is still owed a reply.
  let turnOutcome: string | null = null;
  // What the ingestion answered; null means it never ran. A memory-only replay reports no turn,
  // so `turnOutcome` stays null and passes every settlement test below, which is wrong for one that
  // also remembered nobody: an inbox unbound, switched off or flipped to test mode during the wait
  // reaches no ingestion branch, and the delivery still comes back `"processed"`.
  let ingestOutcome: string | null = null;
  // NOTE: held across the handoff, not merely probed, so the fence's answer stays true until the
  // turn takes its own claim; balanced in the `finally`, since an unbalanced mark defers every reader
  // of the key until restart (../../graph/inflight.ts). BOTH keys: the conversation key keeps
  // `followUpHandler` and a second recovery off, and the GRAPH key keeps `/reset`
  // (`threadBusyForResetOn`) from clearing a memory this turn then restores. RESERVATIONS, not
  // invokes: counted as one, `markTurnOwning` would skip the attendance divider on a new
  // conversation. Process-local, left on docs/deploy.md §4's single-replica invariant; the window
  // and why the durable claim is not taken here: docs/chatwoot.md, "Mirror sync".
  markTurnReserved(handoffKey);
  markTurnReserved(graphKey);
  try {
    outcome = await processChatwootDelivery({
      tenantId: params.tenantId,
      instanceId,
      deliveryRowId: row.id,
      agentBotId,
      normalized,
      // NOTE: the role the delivery arrived with, so the replay does not re-derive it from bindings
      // that have moved since.
      routeObserved: observerRouteBotId !== null,
      // NOTE: the world the message arrived in, from the row rather than re-read: the replay resolves
      // the route against the binding as it stands now, and this lets that resolution say whether it
      // describes the same world.
      receiptBindingGeneration: row.bindingGeneration,
      // NOTE: what that pass owed. The row is the only witness that no turn was going to run on it,
      // and without this the re-execution decides from ownership as it stands now.
      owesMemoryOnly: row.owesMemoryOnly === true,
      // And its settlement scope, passed as the row holds it rather than coerced: `undefined` is
      // "the row does not say", which is a different instruction from `false`, and collapsing the
      // two would hand the widest scope to every row an older build wrote.
      settleScopedToThisDelivery: row.settleScopedToThisDelivery ?? undefined,
      // NOTE: the claim does not revoke the original handler: `DEAD` is the sweep's verdict, and a
      // stalled handler holds no lock this side can take, so claiming from `DEAD` takes back the
      // LEDGER only (its own tx2 CAS then settles nothing). Two INVOKES are fenced: a handler in
      // `runAgentTurn` holds the thread's durable claim, which the fence above asks. What is left is
      // a handler stalled half an hour BEFORE its turn (every await there has its own deadline, so
      // the process is pathological), overlapping as two live deliveries can.
      claimFrom: "DEAD",
      onIngest: (o) => {
        ingestOutcome = o;
      },
      onDirectTurn: (r) => {
        if (r.kind === "error") turnThrew = true;
        // NOTE: recorded, not judged. `TURN_SETTLED` below is what decides, and it is a POSITIVE list
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
    // Both, in the same place, for the reason the mark states: an unbalanced one makes every reader
    // of that key defer on this conversation until the process restarts, and for the graph key that
    // reader is the reset command, which would refuse for good.
    clearTurnReserved(handoffKey);
    clearTurnReserved(graphKey);
  }
  // "skipped" means the claim matched nothing: another recovery took the row between the read above
  // and the CAS. The winner is running it, so this pass has nothing left to do and nothing to retry.
  if (outcome !== "processed") return "superseded";

  // The turn ran and left this message UNSETTLED unless its outcome is in `TURN_SETTLED`, a
  // POSITIVE list because the honest default for an outcome nobody considered is "still owed".
  // `superseded` does not settle: live, the newer message's delivery carries the reply, but here it
  // can have finished before this turn ingested the stranded text. `empty` does not: the row exists
  // because the customer was left waiting. `no-agent` / `agent-unavailable` write their own
  // operator-facing line and must not take the message off that operator's worklist.
  const turnUnsettled = turnOutcome !== null && !TURN_SETTLED.has(turnOutcome);
  // And the memory-only replay is unsettled when nothing looked at the message: a route with
  // continuous ingestion must have decided (`queued` remembered it, `nothing` is the gate needing
  // nothing, `no-thread` has nowhere to hold it, `covered` is the responder already having it).
  // Silence is no route having asked, so the row goes back to DEAD for an inbox bound and switched
  // on again. Only for the replay that posts nothing; where a turn was owed, `TURN_SETTLED` answers.
  const memoryUnsettled = !replayPosts && ingestOutcome === null;
  if (turnThrew || turnUnsettled || memoryUnsettled) {
    // The row goes BACK to DEAD, the same repair as for a throw: it left the worklist at the
    // claim and the customer is still owed. The attempt stays spent, so `MAX_RECOVERY_ATTEMPTS`
    // bounds the retrying. From PROCESSED, the state nothing revisits (the sweep reads PENDING and
    // PROCESSING), so a write that cannot land is said at `error`, naming the row. No closing line,
    // because nothing closed.
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
      turnThrew
        ? "threw"
        : memoryUnsettled
          ? "never ran and no route ingested the message either"
          : `came back "${turnOutcome}"`,
      row.deliveryId,
      conversationId,
      put === "restored"
        ? "yes"
        : put === "moved"
          ? "no, it had moved"
          : "NO, the write failed",
    );
    // NOTE: two roads, because they wait on different things. A THROW (a model or provider that
    // could not answer) and the memory-only case (an inbox unbound or switched off) are conditions
    // an operator repairs, so they back off toward the dead-letter line. Every SETTLED non-answer is
    // nothing a retry improves, so the job completes and the row stays DEAD on the operator's page.
    return turnThrew || memoryUnsettled ? "unreachable" : "superseded";
  }

  // The line that closes the loss, written HERE: `retireCoveredDeliveries` corrects only rows
  // it moves out of `DEAD` itself, and this row left `DEAD` at the claim, so without this it leaves
  // the worklist with the operator's page about it still open. "recovered" rather than "answered" or
  // "consumed", because with coalescing on the reply is the flush's, minutes from now. `warn`, like
  // the correction it stands in for, so it lands on the Logs page (a channel's `minLevel` defaults
  // to `error`) rather than paging.
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
        deliveryEvent: row.event,
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

// Whether a stranded row is worth arming a recovery FOR, asked of the row alone: one naming no
// conversation or no message was written by an older build and has nothing to rebuild a body from.
// ONE definition with two callers: the recovery re-asks it after claiming (the row is readable only
// then), and the sweep asks it before arming, because a job that can only say "unrecoverable" still
// takes a claim, and on an upgrade's backfill those would be the OLDEST rows, pushing the recoveries
// that can work behind them. A type predicate, so the caller that USES the two ids gets them
// narrowed by the statement that decided they are there, not by a second null check.
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
// once (`finish` is a CAS), so in practice this is armed once per row and the question is
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
  // NOTE: `parseDbId` and not a local digits check, because the tree has ONE answer to "is this an
  // id?" and a scheduler payload is a transport like any other. The digits check is what matters
  // here, and it has a test: `BigInt` reads "0x10" as sixteen, which recovers a DIFFERENT row. An id
  // past 2^63-1 reaches the CAS and matches nothing, like any wrong in-range id.
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
  // NOTE: Every outcome that ends the job without retrying it is where the loss is decided: a row
  // still DEAD now stays DEAD, and the sweep's line about it was `info` because this job was coming.
  if (outcome !== "deferred" && outcome !== "unreachable") {
    await announceUnanswered(job.tenantId, deliveryRowId, base);
  }
  // NOTE: the two retrying outcomes take DIFFERENT roads. BUSY reschedules, which CLEARS the failure
  // budget: a turn is deliberately unbounded (the sweep waits thirty minutes) while this kind's
  // backoffs are spent in eighteen (`JOB_RETRY_BASE_MS`), so as `fail` a conversation's second
  // stranded message would burn its ladder behind the first's legitimate turn; `MAX_RECOVERY_AGE_MS`
  // bounds the rescheduling. UNREACHABLE fails, spending the budget, because an account that stays
  // unreadable has to be given up on and SAID at the dead-letter line.
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

// The line that alerts on a stranded message nobody answered, written when its recovery ends with
// the row still DEAD. Once per delivery: a re-run of the same job finds the line and writes nothing.
// Best-effort, like every line here: the DEAD row stays on the worklist either way.
export async function announceUnanswered(
  tenantId: bigint,
  deliveryRowId: bigint,
  base: PrismaClient,
): Promise<void> {
  try {
    const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.chatwootWebhookDelivery.findUnique({
        where: { id: deliveryRowId },
        select: {
          status: true,
          deliveryId: true,
          event: true,
          chatwootInstanceId: true,
          conversationId: true,
          inboundMessageId: true,
        },
      }),
    );
    if (row?.status !== "DEAD") return;
    const [already, conv] = await runScopedOn(base, sysCtx(tenantId), (db) =>
      Promise.all([
        db.executionLog.findFirst({
          where: {
            stage: "delivery",
            AND: [
              { detail: { path: ["outcome"], equals: "unanswered" } },
              { detail: { path: ["deliveryId"], equals: row.deliveryId } },
            ],
          },
          select: { id: true },
        }),
        row.conversationId === null
          ? null
          : db.conversation.findUnique({
              where: {
                tenantId_chatwootInstanceId_chatwootConversationId: {
                  tenantId,
                  chatwootInstanceId: row.chatwootInstanceId,
                  chatwootConversationId: row.conversationId,
                },
              },
              select: {
                id: true,
                inboxId: true,
                inbox: { select: { agentId: true } },
              },
            }),
      ]),
    );
    if (already) return;
    await writeFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: conv?.id ?? null,
        agentId: conv?.inbox?.agentId ?? null,
        inboxId: conv?.inboxId ?? null,
        base,
      },
      {
        stage: "delivery",
        level: "error",
        status: "error",
        detail: {
          outcome: "unanswered",
          deliveryEvent: row.event,
          deliveryId: row.deliveryId,
          messageId: row.inboundMessageId,
          conversationId: row.conversationId,
        },
        errorMessage:
          "The customer's message went unanswered: its recovery ended and the delivery stays DEAD.",
      },
    );
  } catch (err) {
    logger.error(
      { err },
      "chatwoot recovery: could not write the unanswered line for delivery row %s",
      String(deliveryRowId),
    );
  }
}

// No dead-letter hook of its own: `dispatchDeadLetter` already announces every kind's death with the
// kind, the job id and the dedupe key (here the delivery row id), re-reads the row so a re-armed job
// is not announced as a loss, and takes its level from `JOB_DEATH_LEVEL`. That level is `error`: a job
// that died never reached `announceUnanswered`, and the sweep's own line was `info`.

let registered = false;
export function registerDeliveryRecoveryHandler(): void {
  if (registered) return;
  registerJobHandler("DELIVERY_RECOVERY", deliveryRecoveryHandler);
  registered = true;
}

// The fork's `MessageFinder::CATCH_UP_LIMIT`: a full catch-up read may have more behind it.
const CATCH_UP_PAGE = 100;

function mergeById(
  page: ReturnType<typeof parseChatwootMessages>,
  more: ReturnType<typeof parseChatwootMessages>,
): ReturnType<typeof parseChatwootMessages> {
  if (more.length === 0) return page;
  const known = new Set(page.map((m) => m.id));
  return [...page, ...more.filter((m) => !known.has(m.id))];
}
