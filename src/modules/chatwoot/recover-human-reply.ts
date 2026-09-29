import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { resolveGraphThreadId } from "@/graph/checkpointer";
import { INGEST_ID_WINDOW, ingestVerdict } from "@/graph/ingest-dedup";
import { armIngest } from "@/graph/ingest-job";
import { resetLandedAfter, threadResetBoundary } from "@/graph/reset-episode";
import { parseDbId } from "@/lib/db-id";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { ingestsContinuously } from "@/modules/agents/mode";
import { writeFlowEvent } from "@/modules/flowlog/service";
import { readMemoryConfig } from "@/modules/memory/settings";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { loadChatwootClient } from "./instance";
import {
  type HumanReplyRoute,
  isNewHumanReplyToCustomer,
  normalizeChatwootEvent,
  resolveHumanReplyRoute,
} from "./normalize";
import { buildRecoveryPayload } from "./recover-payload";
import { renderAttendantMessage } from "./render";
import { responderCoversMessage } from "./responder-coverage";
import { isHumanReplyShape } from "./stranded-delivery";

// Folding back into the contact's memory the colleague's reply an ingestion lost. The ledger names
// every colleague's reply at INSERT (`humanReplyMessageId`), so the words are read back over REST by
// id and rebuilt (./recover-payload.ts). A kind of its own beside the takeover recovery, never the
// delivery recovery, and the two retry independently. Re-decided NOW, like ./recover-takeover.ts: the
// route's provider half before any network, whether the route remembers at all, and the
// contact-inbox, which keys the thread. A read that comes back as anything but a colleague's reply
// is refused as `unreachable`, and there is no age ceiling. Why each: docs/chatwoot.md, "Webhook
// receiver", on the human-reply recovery.
const RECOVERY_KIND = "HUMAN_REPLY_RECOVERY" as const;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export function humanReplyRecoveryDedupeKey(deliveryRowId: bigint): string {
  return `human-reply-recovery:${deliveryRowId}`;
}

// Whether a stranded row names a colleague's reply this can rebuild, asked of the row alone.
//
// ONE definition with two callers, like `isRecoverableStrand` next door and for the same reason: the
// sweep asks it to avoid arming a job that can only say "not-owed", and the recovery re-asks it after
// reading the row, which is the only moment the row is authoritative.
//
// A type predicate rather than a boolean, so the caller that goes on to USE the two ids gets them
// narrowed by the statement that decided they are there.
export function namesRecoverableHumanReply<
  T extends {
    conversationId: number | null;
    humanReplyMessageId: number | null;
    humanReplyShape: string | null;
  },
>(
  row: T,
): row is T & {
  conversationId: number;
  humanReplyMessageId: number;
  humanReplyShape: HumanReplyRoute;
} {
  return (
    row.conversationId !== null &&
    row.humanReplyMessageId !== null &&
    isHumanReplyShape(row.humanReplyShape)
  );
}

// Arms the recovery of ONE stranded row, called by the sweep at the moment it closes the row: from
// the CAS onward the row is invisible to every later pass, so this is the only moment anything knows
// there is a reply to go back for.
//
// `rearm: "new-work"` for the reason both neighbours give: a row is closed once, so in practice this
// is armed once per row, and answering anyway keeps a re-arm from inheriting a spent budget.
export async function armHumanReplyRecovery(
  tenantId: bigint,
  deliveryRowId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: RECOVERY_KIND,
    dedupeKey: humanReplyRecoveryDedupeKey(deliveryRowId),
    runAt: new Date(),
    // A bigint does not survive JSON, and the payload column is one. Read back with parseDbId.
    payload: { deliveryRowId: String(deliveryRowId) },
    rearm: "new-work",
    base,
  });
}

export type HumanReplyRecoveryOutcome =
  // The append is queued. Not "appended": the ingest job owns that decision, and it is the same job
  // the live path would have armed, including its own dedup, which is what makes a row stranded
  // AFTER a successful ingestion cost nothing (../../graph/ingest.ts, `ingestVerdict`).
  | "remembered"
  // Nothing was owed, or nothing is owed any more. Every refusal that is a VERDICT rather than a
  // failure: the row names no reply, the shape was an echo on an unreserved provider, the route
  // remembers nothing, the conversation names no contact-inbox, the message is gone from Chatwoot.
  // Retrying any of these asks the same question and gets the same answer.
  | "not-owed"
  // The mirror does not know this conversation yet, which is not a verdict: a delivery that died
  // before the mirror write leaves no row, and the next event on that conversation creates one.
  | "unresolved"
  // The account could not be read, or answered with something unusable. Repairable, and the next
  // attempt may get a different answer.
  | "unreachable"
  // Nobody can tell any more, and the recovery says so instead of guessing. The thread's dedup window
  // has moved past this id, so the append would be refused as `ancient` SUCCESSFULLY and nothing would
  // say the reply never landed. Nor can the window say which happened: a delivery that crashed after
  // arming its ingestion leaves the same row with the reply already in memory, so telling the operator
  // the words were lost would be an instruction to duplicate them.
  | "undecided"
  // The enqueue failed, which is the very failure this recovery exists for, happening again.
  | "failed";

export interface RecoverHumanReplyParams {
  tenantId: bigint;
  deliveryRowId: bigint;
  base?: PrismaClient;
  makeClient?: Parameters<typeof loadChatwootClient>[2] extends infer D
    ? D extends { makeClient?: infer M }
      ? M
      : never
    : never;
}

export async function recoverStrandedHumanReply(
  params: RecoverHumanReplyParams,
): Promise<HumanReplyRecoveryOutcome> {
  const base = params.base ?? basePrisma;
  const { tenantId } = params;

  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootWebhookDelivery.findUnique({
      where: { id: params.deliveryRowId },
      select: {
        deliveryId: true,
        chatwootInstanceId: true,
        conversationId: true,
        humanReplyShape: true,
        humanReplyMessageId: true,
        // NOTE: which route the delivery arrived on, so the recovery asks about the SAME agent the
        // live path did; it is what separates a watcher's lost append from a responder's.
        routeObserved: true,
        routeAgentBotId: true,
        // WHEN THE MESSAGE ARRIVED, which is what dates the evidence used to recover an unstated
        // role: a binding younger than the delivery describes another moment.
        receivedAt: true,
      },
    }),
  );
  // Re-read rather than trusted from the payload, because the job outlives the pass that armed it:
  // the row is what says there was a reply, and a row that cannot answer is not one to act on.
  if (!row || !namesRecoverableHumanReply(row)) return "not-owed";
  const instanceId = row.chatwootInstanceId;
  const conversationId = row.conversationId;
  const messageId = row.humanReplyMessageId;

  // The conversation's own inbox and the agent bound to it, keyed by the CONVERSATION rather than by
  // a payload inbox id, because there is no payload: the same read the takeover recovery makes.
  const bound = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: {
        id: true,
        inboxId: true,
        contactInboxId: true,
        // WHO HOLDS IT, which is half of the answer to "was this an observer's route?"; see the
        // exception below. The mirror is the only source here: there is no payload to prefer, which
        // is the same fallback the receiver makes for a silent one.
        assigneeType: true,
        assigneeId: true,
      },
    });
    if (!conv) return null;
    // NOTE: the mirror knows the conversation and not its inbox, a THIRD state and not the absence
    // of an inbox: `upsertInbox` answers null for an event whose payload names none, and a later event
    // fills it in. Folded into "no route" it would resolve `not-owed`, terminal, on a mirror Chatwoot
    // could complete a minute later.
    if (conv.inboxId === null) return "sparse" as const;
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: {
        id: true,
        agentId: true,
        provider: true,
        // NOTE: when the responder was bound, which `responderCoversMessage` dates the message against
        // below.
        responderBoundAt: true,
      },
    });
    if (!inbox?.agentId) return null;
    // `routeObserved` has a third value: the claim states the role, so a delivery stranded
    // before its claim carries null, and `role-unstated` is one of the verdicts that arm this. Read as
    // `false`, an observer's append beside a `test` or switched-off responder would be discarded for
    // good. The role is recovered from what survives: `routeAgentBotId` (written at INSERT) and whether
    // that bot's agent OBSERVES this inbox, the row `observerRuntimeForRoute` requires; a pending
    // attachment counts, since it may already be live upstream.
    const routeBotAgentId =
      row.routeAgentBotId === null
        ? null
        : ((
            await db.chatwootAgentBot.findFirst({
              where: {
                tenantId,
                chatwootInstanceId: instanceId,
                chatwootAgentBotId: row.routeAgentBotId,
              },
              select: { agentId: true },
            })
          )?.agentId ?? null);
    // Holding the conversation ends the question, row or no row. The fork delivers to the
    // conversation's assignee bot too, and an agent that answered this inbox before becoming its
    // watcher keeps what it was assigned; `observerRuntimeForRoute` refuses to call that route an
    // observer's whenever the inbox has a responder, as it does here by construction. Recovered as an
    // observer's, the reply would be folded in on a route the live path resolves to the inbox's
    // responder.
    const heldByRouteBot =
      conv.assigneeType === "AgentBot" &&
      conv.assigneeId !== null &&
      conv.assigneeId === row.routeAgentBotId;
    const observed =
      row.routeObserved ??
      (!heldByRouteBot &&
        routeBotAgentId !== null &&
        routeBotAgentId !== inbox.agentId &&
        (await db.inboxObserver.count({
          where: {
            tenantId,
            inboxId: inbox.id,
            agentId: routeBotAgentId,
            // NOTE: and older than the delivery: bot equality is evidence about the role only while
            // the binding is OLDER than the delivery (docs/chatwoot.md, "Observer binding"). An
            // observer attached after this message arrived says nothing about its route, and the sweep
            // runs half an hour later, so that window is real. The other direction stays conservative:
            // an attachment the fork had not confirmed when the message landed reads as the responder's.
            createdAt: { lte: row.receivedAt },
          },
        })) > 0);
    // The route's own agent, resolved the way the receiver's `resolveRoute` does: a WATCHER's
    // runtime comes from the bot the delivery arrived on (the bot IS the route), a RESPONDER's from the
    // INBOX, never the bot. Chatwoot fans a message to the conversation's assigned bot and the inbox's,
    // so `routeAgentBotId` can name another persona that holds the conversation; asked through the bot
    // on both routes, a `test` or switched-off assigned agent (or a responder rebind) would discard an
    // append the inbox's responder owed.
    const routeAgentId = observed ? routeBotAgentId : inbox.agentId;
    if (routeAgentId === null) return null;
    const agent = await db.agent.findUnique({
      where: { id: routeAgentId },
      select: { mode: true, enabled: true, settings: true },
    });
    if (!agent) return null;
    // Whether a responder of ours answers this inbox, the other half of the watcher's own
    // condition: an observer beside a responder shares its memory and folds into it; one with none
    // folds nothing. Asked of the inbox's binding, the same reading `routeRemembers` makes.
    const responder = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: { enabled: true, mode: true, settings: true },
    });
    // The responder's bot, which names its route in the ledger: whether it received this
    // message is asked of its own delivery row. Read only on a watcher's route, the one place it
    // decides anything.
    const responderBotId =
      observed && responder !== null
        ? ((
            await db.chatwootAgentBot.findFirst({
              where: {
                tenantId,
                chatwootInstanceId: instanceId,
                agentId: inbox.agentId,
              },
              select: { chatwootAgentBotId: true },
            })
          )?.chatwootAgentBotId ?? null)
        : null;
    return {
      contactInboxId: conv.contactInboxId,
      // The MIRROR's row id, which is what a flow-log line hangs on: the reports an operator reads
      // are keyed by it, not by Chatwoot's display id.
      conversationRowId: conv.id,
      agentId: routeAgentId,
      whatsappProvider: inbox.provider,
      mode: agent.mode,
      enabled: agent.enabled,
      settings: agent.settings,
      responderExists: responder !== null,
      responder:
        responder === null
          ? null
          : {
              agentId: inbox.agentId,
              enabled: responder.enabled,
              mode: responder.mode,
              settings: responder.settings,
              botId: responderBotId,
              boundAt: inbox.responderBoundAt,
            },
      // The role as this recovery RESOLVED it, which is the ledger's when the claim stated one and
      // the binding's when it did not.
      observed,
    };
  });
  // NOTE: the mirror has the conversation and not the inbox: a row another event completes, so the
  // same answer the unknown conversation gets.
  if (bound === "sparse") {
    logger.warn(
      "chatwoot human-reply recovery: %s names conversation %d, whose mirrored row carries no inbox yet; retrying",
      row.deliveryId,
      conversationId,
    );
    return "unresolved";
  }
  // TWO CAUSES, and only one of them is an answer. An inbox bound to no agent owes nothing and never
  // will; a conversation the mirror has never seen is a row that does not exist YET.
  if (!bound) {
    const known = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.conversation.count({
        where: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      }),
    );
    if (known === 0) {
      logger.warn(
        "chatwoot human-reply recovery: %s names conversation %d, which the mirror does not know yet; retrying",
        row.deliveryId,
        conversationId,
      );
      return "unresolved";
    }
    return "not-owed";
  }

  // THE HALF THE COLUMN COULD NOT ANSWER, and it is asked BEFORE the network on purpose: a `device`
  // shape on a provider that does not reserve its send ids is the echo of our OWN reply, and the
  // cheapest place to refuse it is the one that spends nothing. Reading the message first and
  // deciding after would cost a REST round trip per echo on every unreserved-provider install.
  if (
    resolveHumanReplyRoute(row.humanReplyShape, {
      whatsappProvider: bound.whatsappProvider,
    }) === null
  ) {
    return "not-owed";
  }
  // Whether this route remembers at all, asked of the agent and not of the row (see the
  // header), and per route like the receiver's `routeRemembers`. On a WATCHER's route the mode is not
  // asked, only the switch, plus whether a responder of ours answers the inbox (its thread is the
  // memory the watcher folds into); on the responder's own route it is the mode. Read as the
  // responder's on both, a watcher's append would be discarded for good whenever the responder is in
  // `test` or switched off. A `test` responder leaves a row like a failed enqueue's, and only this
  // tells "owed and failed" from "never owed".
  const routeRemembers =
    bound.enabled &&
    (bound.observed ? bound.responderExists : ingestsContinuously(bound.mode));
  if (!routeRemembers) return "not-owed";
  // NO THREAD TO HOLD IT, which is the ingestion's own `"no-thread"` answer arriving by the other
  // road. The receiver already reported that case as the permanent loss it is and settled the row;
  // a recovery armed on one anyway has nothing to key a thread by.
  if (bound.contactInboxId === null) return "not-owed";
  const contactInboxId = bound.contactInboxId;
  // NOTE: the episode boundary, the one refusal here that prevents ACTIVE HARM. `/reset` clears the
  // thread and revokes every queued `INGEST_MESSAGE` for it, but it cannot revoke this job (a kind of
  // its own, armed before the command and running after it), and deleting the thread takes the append
  // dedup with it. Asked with the tree's own predicate against Chatwoot's sequence, the order the
  // operator experienced; a verdict, since the boundary only moves forward (`GREATEST`). This is the
  // cheap half: the fence is the second reading just before the arm, the only one that sees a
  // `/reset` landing during the REST round trip. What this saves is the round trip itself, so its
  // test asserts the ABSENCE of that call; the verdict alone is the same either way.
  if (
    resetLandedAfter(
      messageId,
      await threadResetBoundary(tenantId, instanceId, contactInboxId, base),
    )
  ) {
    logger.info(
      "chatwoot human-reply recovery: %s names message %d on conversation %d, which a /reset has since cleared; not restoring it",
      row.deliveryId,
      messageId,
      conversationId,
    );
    return "not-owed";
  }

  // Whether the append can still land at all. The thread remembers the last `INGEST_ID_WINDOW`
  // ids per direction, and once that window is SATURATED an id below its floor is `ancient`:
  // `ingestMessageIntoThread` refuses it SUCCESSFULLY, so the job completes and nothing says the
  // words never landed. Asked HERE, where it can still be said: `duplicate` is the happy answer for a
  // row stranded after the append, `ancient` gets a line an operator can act on. Before the network,
  // since those are the answers a backlog produces in bulk and the thread row alone decides them.
  // Evidence, not a guarantee: the window can move before the job re-asks under the thread's lock.
  const thread = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.agentThread.findUnique({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { recentAgentMessageIds: true },
    }),
  );
  const verdict =
    thread === null
      ? "new"
      : ingestVerdict(thread.recentAgentMessageIds, messageId);
  if (verdict === "duplicate") return "not-owed";
  if (verdict === "ancient") {
    logger.error(
      "chatwoot human-reply recovery: %s names message %d on conversation %d, which is older than everything that thread's memory still remembers; whether the reply reached the agent cannot be decided from here and a person has to read the conversation",
      row.deliveryId,
      messageId,
      conversationId,
    );
    // NOTE: a durable line, where an operator actually looks: a process log is not queryable by
    // conversation and dies with the container, and the receiver's `human_reply_not_remembered` says
    // a retry is coming, which is no longer true. It reports UNCERTAINTY, not a loss: past the floor
    // the set cannot tell a reply that never landed from one that landed sixty-four messages ago (a
    // delivery that armed its ingestion and crashed before settling), and calling it lost would tell
    // an operator to re-type words that may already be in memory. At `error` because this is where
    // the machinery stops and a person has to read the conversation.
    await writeFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: bound.conversationRowId,
        agentId: bound.agentId,
        base,
      },
      {
        stage: "memory",
        level: "error",
        status: "error",
        detail: {
          reason: "human_reply_recovery_undecidable",
          messageId,
          window: INGEST_ID_WINDOW,
        },
      },
    );
    return "undecided";
  }

  let raw: unknown;
  try {
    const client = await loadChatwootClient(tenantId, instanceId, {
      base,
      // The same seam every other caller uses, so a test drives a fake account rather than mocking
      // the module.
      ...(params.makeClient ? { makeClient: params.makeClient } : {}),
    });
    // `before` anchors the page that ENDS at this id, so the message is in it whatever the
    // conversation's length, the same read the delivery recovery makes for the same reason.
    raw = await client.getMessages(conversationId, { before: messageId + 1 });
  } catch (e) {
    logger.warn(
      "chatwoot human-reply recovery: %s could not read conversation %d from the account: %s",
      row.deliveryId,
      conversationId,
      e instanceof Error ? e.message : String(e),
    );
    return "unreachable";
  }

  const page = readMessagePage(raw);
  if (page === null) {
    logger.warn(
      "chatwoot human-reply recovery: %s read conversation %d back and the account answered with something that is not a message page; deferring",
      row.deliveryId,
      conversationId,
    );
    return "unreachable";
  }
  const message = findRawMessage(page, messageId);
  // NOTE: Chatwoot no longer has the message (deleted, or the conversation was): nothing to fold in,
  // and retries change nothing. Logged because one other cause gives this exact answer, a page that
  // ignores `before`; the verdict is the same either way, so a process log rather than a durable line
  // (a deleted message is nothing an operator can act on), which keeps the second cause findable.
  if (!message) {
    logger.warn(
      "chatwoot human-reply recovery: %s read conversation %d back and the page did not carry message %d; treating it as gone from the account",
      row.deliveryId,
      conversationId,
      messageId,
    );
    return "not-owed";
  }

  // REBUILT THROUGH THE SAME BUILDER THE OTHER RECOVERY USES, so the two cannot drift about what a
  // webhook body looks like: the REST and webhook spellings differ in both fields this depends on
  // (`message_type` is an integer there and an enum string on the wire), and `normalizeChatwootEvent`
  // is the one reader that reconciles them.
  //
  // The conversation block is minimal on purpose: nothing below reads ownership, status or the
  // pairing. What this needs from the body is the message and the contact-inbox the thread is keyed
  // by, and every field invented beyond that is a field a later reader could start trusting.
  const normalized = normalizeChatwootEvent(
    buildRecoveryPayload({
      event: "message_created",
      conversation: {
        chatwootConversationId: conversationId,
        status: "open",
        assigneeType: null,
        assigneeId: null,
        assigneeName: null,
        contactInboxId,
        redirectOriginDisplayId: null,
        redirectOriginAt: null,
      },
      inboxId: null,
      inboxName: null,
      message: {
        id: messageId,
        content: typeof message.content === "string" ? message.content : null,
        messageType: message.message_type ?? null,
        private: message.private === true,
        contentAttributes: isRecord(message.content_attributes)
          ? message.content_attributes
          : null,
        sender: isRecord(message.sender) ? message.sender : null,
        attachments: Array.isArray(message.attachments)
          ? message.attachments
          : [],
        createdAt: null,
      },
    }),
  );
  // NOTE: still a colleague's reply, or the read was degraded: the ledger row proves it was one, so a
  // rebuild that comes back as anything else is a REST response that lost something. Appending it
  // would put words nobody wrote in a contact's permanent memory, attributed to an attendant.
  // `unreachable` rather than `not-owed`: the account answered with something unusable, which the
  // next attempt may not.
  if (
    normalized === null ||
    !isNewHumanReplyToCustomer(normalized, {
      whatsappProvider: bound.whatsappProvider,
    })
  ) {
    logger.warn(
      "chatwoot human-reply recovery: %s rebuilt message %d on conversation %d as something other than a colleague's reply; the REST read is degraded",
      row.deliveryId,
      messageId,
      conversationId,
    );
    return "unreachable";
  }

  // The ATTENDANT's renderer, the one the receiver picks for this role: the eager media pass
  // never runs on an outgoing message, and the customer-facing markers would tell the agent to ask
  // its own colleague to retype a file. A voice note gets its words folded in: an audio reply carries
  // its own transcription, and the marker alone reads as an attendant who sent a file in silence.
  const text = renderAttendantMessage({
    text: normalized.message?.content ?? "",
    attachmentTypes: (normalized.message?.attachments ?? [])
      .map((a) => a.fileType)
      .filter((t): t is string => t !== null),
    transcribedText:
      normalized.message?.transcribedText ??
      (normalized.message?.attachments ?? []).find((a) => a.transcribedText)
        ?.transcribedText,
  });
  // An empty reply is nothing to remember, and the receiver's ingestion answers the same way.
  if (!text.trim()) return "not-owed";

  // ASKED AGAIN, IMMEDIATELY BEFORE THE ARM, because the read above happened before a REST round
  // trip and a `/reset` inside that stretch is exactly the one this fence exists for: the command
  // revokes what is queued, and this would queue after it. It does not CLOSE the window: the reset
  // can still land between this read and the enqueue, and what bounds that residue is the command's
  // own critical section, which holds the thread row and refuses while an append is in flight
  // (`threadBusyForResetOn`). Narrowing the gap from a network round trip to two statements is what
  // is available here; claiming it is closed would be the lie.
  const clearedSince = await threadResetBoundary(
    tenantId,
    instanceId,
    contactInboxId,
    base,
  );
  if (resetLandedAfter(messageId, clearedSince)) {
    logger.info(
      "chatwoot human-reply recovery: %s was cleared by a /reset while its message was being read back (conversation %d); not restoring it",
      row.deliveryId,
      conversationId,
    );
    return "not-owed";
  }

  // Whose memory it is filed under, the rule the live path applies (`memoryOwner` in
  // ./webhook.ts). Both stranded rows of one reply arm the same job, the later arm replacing the
  // payload, and the payload's agent decides whose compaction settings summarise the attendance.
  // Under the responder whenever it received the message and remembers continuously, so both rows
  // arm the same payload; otherwise the route's own agent (a responder in `test`, switched off, or
  // bound after the message holds no part of it).
  const responder = bound.responder;
  const ownedByResponder =
    bound.observed &&
    responder !== null &&
    responder.botId !== null &&
    responder.enabled &&
    ingestsContinuously(responder.mode) &&
    (await responderCoversMessage(
      tenantId,
      instanceId,
      params.deliveryRowId,
      responder.boundAt,
      responder.botId,
      conversationId,
      { id: messageId, column: "humanReply" },
      // NOTE: when Chatwoot EMITTED it, which is when it chose the recipients: the message's own
      // `created_at`, the clock the live path reads from the payload, with the receipt as fallback
      // only where the page names none. Dated by the receipt, a reply emitted before the responder was
      // bound would read as covered and be filed under a responder that never received it.
      messageCreatedAt(message),
      base,
    ));
  const owner =
    ownedByResponder && responder !== null
      ? { agentId: responder.agentId, settings: responder.settings }
      : { agentId: bound.agentId, settings: bound.settings };

  try {
    await armIngest({
      tenantId,
      instanceId,
      conversationId,
      contactInboxId,
      graphThreadId: resolveGraphThreadId(
        tenantId,
        instanceId,
        conversationId,
        contactInboxId,
      ),
      messageId,
      text,
      role: "human_agent",
      sentAt: messageCreatedAt(message),
      agentId: owner.agentId,
      compactionEnabled: readMemoryConfig(owner.settings).compaction.enabled,
      base,
    });
  } catch (e) {
    // THE FAILURE THIS RECOVERY EXISTS FOR, HAPPENING AGAIN, which is exactly the case to retry: the
    // scheduler was down when the delivery ran and is down again now. The job's own ladder is the
    // right waiting room for it, and running out reaches the dead-letter line where an operator
    // learns the reply never made it.
    logger.warn(
      "chatwoot human-reply recovery: %s could not arm the ingestion of message %d on conversation %d: %s",
      row.deliveryId,
      messageId,
      conversationId,
      e instanceof Error ? e.message : String(e),
    );
    return "failed";
  }
  logger.info(
    "chatwoot human-reply recovery: %s was stranded owing a colleague's reply (message %d) and it is queued for conversation %d's memory",
    row.deliveryId,
    messageId,
    conversationId,
  );
  return "remembered";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The page, or null for a body that is not one. Chatwoot answers with a bare array or
// `{ payload: [...] }`; anything else (an empty body, `{}`, an error object rendered with a 200) is
// unreadable, and reading it as an EMPTY page would turn a degraded account into a verdict that the
// message was deleted, settling the row for good. An unreadable answer is the account failing, which
// a later attempt can find repaired.
function readMessagePage(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.payload)) return raw.payload;
  return null;
}

// Chatwoot's REST page dates a message in epoch seconds; an ISO string is read as well, and anything
// else is no clock at all, which leaves the caller on the receipt.
function messageCreatedAt(message: Record<string, unknown>): Date | null {
  const v = message.created_at;
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000);
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t);
  }
  return null;
}

function findRawMessage(
  page: unknown[],
  id: number,
): Record<string, unknown> | null {
  for (const item of page) {
    if (isRecord(item) && item.id === id) return item;
  }
  return null;
}

function readDeliveryRowId(payload: unknown): bigint | null {
  if (typeof payload !== "object" || payload === null) return null;
  const v = (payload as { deliveryRowId?: unknown }).deliveryRowId;
  // NOTE: `parseDbId` and not a local digits check, because the tree has ONE answer to "is this an
  // id?" and a scheduler payload is a transport like any other.
  return typeof v === "string" ? parseDbId(v) : null;
}

async function humanReplyRecoveryHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const deliveryRowId = readDeliveryRowId(job.payload);
  if (deliveryRowId === null) {
    logger.error(
      "chatwoot human-reply recovery: job %s carries no delivery row id; nothing to recover",
      String(job.id),
    );
    return { outcome: "done" };
  }
  const outcome = await recoverStrandedHumanReply({
    tenantId: job.tenantId,
    deliveryRowId,
    base,
  });
  // THREE OUTCOMES RETRY AND THEY ARE THE THREE THAT CAN CHANGE ON THEIR OWN: the scheduler that
  // refused the arm, the account that could not be read or answered with a degraded body, and the
  // mirror row another event will create. `not-owed` is a verdict about facts that do not move, and
  // retrying it would ask the same rows the same question until the ladder runs out.
  if (outcome === "failed" || outcome === "unreachable") {
    return {
      outcome: "fail",
      error: "human-reply recovery: the reply could not be queued for memory",
    };
  }
  if (outcome === "unresolved") {
    return {
      outcome: "fail",
      error: "human-reply recovery: the mirror does not know this conversation",
    };
  }
  // `undecided` COMPLETES, and that is not the same as succeeding: the uncertainty is already
  // reported at `error` by the line above, on the conversation and the message. Retrying it would
  // ask a window that only moves further away, and dead-lettering would announce the same thing a
  // second time through a channel that says "a job died" rather than "a person has to look".
  return { outcome: "done" };
}

// NO DEAD-LETTER HOOK OF ITS OWN, for the reason both neighbours state: `dispatchDeadLetter` already
// announces every kind's death with the kind, the job id and the dedupe key (which here IS the
// ledger row id), and takes its level from `JOB_DEATH_LEVEL`.
let registered = false;
export function registerHumanReplyRecoveryHandler(): void {
  if (registered) return;
  registerJobHandler(RECOVERY_KIND, humanReplyRecoveryHandler);
  registered = true;
}
