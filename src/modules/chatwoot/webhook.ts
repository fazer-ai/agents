import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import {
  broadcastAgentActivity,
  broadcastConversationEvent,
} from "@/api/features/realtime/realtime.service";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import ackPrisma from "@/api/lib/prisma-ack";
import {
  chatwootThreadId,
  contactInboxThreadId,
  getCheckpointer,
  resolveGraphThreadId,
} from "@/graph/checkpointer";
import { isTurnInFlight } from "@/graph/inflight";
import type { IngestRole } from "@/graph/ingest";
import { armIngest, ingestKeyPrefix } from "@/graph/ingest-job";
import { loadAgentConfig } from "@/graph/prepare";
import { type RuntimeDeps, runAgentTurn } from "@/graph/runtime";
import { threadBusyForResetOn, turnOwnsThread } from "@/graph/thread-claim";
import {
  AppError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "@/lib/errors";
import { withKeyedQueue } from "@/lib/locks";
import {
  isTransactionNeverStarted,
  retryWhileTransactionNeverStarted,
} from "@/lib/pool-retry";
import {
  asSuperAdminOn,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import { ingestsContinuously, isMonitoring } from "@/modules/agents/mode";
import { agentObservesNow, agentStillSpeaks } from "@/modules/agents/speaks";
import { shouldRunReset } from "@/modules/agents/test-mode";
import { cancelThreadAppointments } from "@/modules/appointments/reminders";
import {
  awayMessageDue,
  readAvailabilityConfig,
  renderAwayMessage,
} from "@/modules/availability/away";
import {
  isOpenAt,
  NEXT_OPEN_SCAN_DAYS,
  parseSchedule,
  type Schedule,
  scheduleCanClose,
} from "@/modules/business-hours/hours";
import { linkRedirectConversations } from "@/modules/channel-redirect/cross-link";
import { episodeTestActivatedAt } from "@/modules/channel-redirect/episode";
import {
  armRedirectChatFollowUp,
  deliverRedirectClosing,
  followUpDedupeKey,
  isRedirectFollowUpLive,
  retireRedirectFollowUp,
} from "@/modules/channel-redirect/followup";
import { runRedirectGate } from "@/modules/channel-redirect/gate";
import {
  type ChannelRedirectConfig,
  isRedirectEntryInbox,
  readChannelRedirectConfig,
} from "@/modules/channel-redirect/service";
import {
  openTranscription,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import {
  recordTurnCoverage,
  retireCoveredDeliveries,
} from "@/modules/chatwoot/delivery-sweep";
import {
  describeClosedGate,
  type GateCloseDetail,
} from "@/modules/chatwoot/gate-close";
import type { AuthContext } from "@/modules/contact-auth/check";
import {
  mediaRefusedThrough,
  recordMediaRefusal,
  recordWatcherMediaRefusal,
  refusedCovers,
  watcherMediaRefusedThrough,
} from "@/modules/contact-auth/media-refusal";
import {
  observerArmPermit,
  observerRuleVerdict,
  rememberWatcherAdmission,
  watcherAdmissionStands,
} from "@/modules/contact-auth/observer";
import {
  RULE_CONVERSATION_TYPE,
  RULE_LABEL,
  RULE_NONE_MET,
  RULE_NOT_LISTED,
  RULE_UNMET,
} from "@/modules/contact-auth/rule";
import {
  authorizeContact,
  type ContactAuthOutcome,
  type ContactAuthResult,
  type ContactAuthStage,
  contactAuthFlowEvent,
} from "@/modules/contact-auth/service";
import {
  contactAuthHasEndpointStage,
  contactAuthHasRuleStage,
  readContactAuthConfig,
} from "@/modules/contact-auth/settings";
import {
  type ContactAuthNotice,
  claimContactAuthNotice,
  contactAuthNoticeKey,
  mediaAdmissionKey,
  mediaAlreadyAdmitted,
  releaseContactAuthNotice,
  rememberMediaAdmission,
} from "@/modules/contact-auth/state";
import { recordConversationAction } from "@/modules/conversations/audit";
import {
  clearConversationError,
  recordConversationError,
} from "@/modules/conversations/error";
import {
  announceFailedTurn,
  readDirectFence,
} from "@/modules/conversations/failure-note";
import { retireNothingToAnswer } from "@/modules/conversations/nothing-to-answer";
import {
  type ReturnToAgentOutcome,
  returnConversationToAgent,
} from "@/modules/conversations/service";
import {
  armDebounce,
  debounceDedupeKey,
  resolveDebounceConfig,
} from "@/modules/debounce/service";
import {
  advanceHandledWatermark,
  dispenseMessagesFromReply,
  readAnsweredFloor,
} from "@/modules/debounce/watermark";
import { emitCommandDropped } from "@/modules/flowlog/command";
import { emitFlowEvent, writeFlowEvent } from "@/modules/flowlog/service";
import { emitUnroutedMessage } from "@/modules/flowlog/unrouted";
import { readTakeoverConfig } from "@/modules/handoff/settings";
import { armCompaction } from "@/modules/memory/compact";
import { clearContactMemory } from "@/modules/memory/reset";
import { readMemoryConfig } from "@/modules/memory/settings";
import { armObserve, observeKeyPrefix } from "@/modules/observe/job";
import { readMonitoringConfig } from "@/modules/observe/settings";
import {
  announceErasedDeaths,
  cancelPendingJob,
  cancelPendingJobsByPrefixUpToMessage,
  type ErasedDeath,
  retireJobsByDedupeKey,
  revokeJobsByKeyPrefixOn,
} from "@/modules/scheduler/service";
import { announceSpendCeilingOnConversation } from "@/modules/spend-ceiling/notice";
import {
  announceSpendCeiling,
  SPEND_CEILING_MESSAGE_WINDOW_MS,
  spendCeilingVerdict,
} from "@/modules/spend-ceiling/service";
import {
  resolveSttConfig,
  transcribeInboundAudio,
} from "@/modules/stt/service";
import {
  extractMessageVisuals,
  hasUnextractedVisual,
} from "@/modules/vision/extract-message";
import { resolveVisionConfig } from "@/modules/vision/service";
import { hashRouteToken } from "@/modules/webhooks/inbound/route-token";
import {
  channelFailureOf,
  forgetMediaFallbacks,
  handleChannelFailure,
} from "./channel-failure";
import type { ChatwootClient } from "./client";
import { type CommandRoute, commandRoute } from "./command-route";
import { resetAckSendId } from "./constants";
import {
  conversationOwnershipNow,
  openForHumanQueue,
  runHumanReplyTakeover,
} from "./human-takeover";
import {
  type AgentBotIdentity,
  agentBotChatwootId,
  loadAgentBot,
  loadChatwootClient,
} from "./instance";
import { withConversationLabels } from "./labels";
import { mirrorOncePerEvent } from "./mirror-once";
import {
  type ControlCommand,
  controlCommand,
  effectiveAssignee,
  firstAudioAttachment,
  type HumanReplyRoute,
  heldByAnotherParty,
  inboundTranscriptionOnUpdate,
  incomingRenderable,
  isIncomingMessage,
  isNewHumanReplyToCustomer,
  isNewIncomingMessage,
  mayBeNewHumanReply,
  newHumanReplyRoute,
  newHumanReplyShape,
  normalizeChatwootEvent,
  parseLiveConversation,
  shouldBotHandle,
  visualAttachments,
} from "./normalize";
import { reconcileMirrorFromLive } from "./reconcile";
import { armDeliveryRecoveryOn } from "./recover-delivery";
import { renderAttendantMessage, renderInboundMessage } from "./render";
import { responderCoversMessage } from "./responder-coverage";
import {
  awaitRouteTokenRefresh,
  readRouteTokenCache,
  routeTokenCacheGeneration,
  routeTokenRefreshDue,
  trackRouteTokenRefresh,
  writeRouteTokenCache,
} from "./route-token-cache";
import {
  CHATWOOT_DELIVERY_HEADER,
  CHATWOOT_SIGNATURE_HEADER,
  CHATWOOT_TIMESTAMP_HEADER,
  verifyChatwootSignature,
} from "./signing";
import type { NormalizedChatwootEvent } from "./types";
import { inboxWatchers, watcherMemoryOwner } from "./watchers";

// Dedicated Chatwoot Agent Bot webhook receiver: resolve tenant and instance by the opaque routeToken
// (constant-time hash probe), verify the HMAC with the bot's stored secret (auth AFTER resolution),
// record an idempotency ledger row keyed by X-Chatwoot-Delivery, ack under 5s, then process detached.
// The ledger never stores the payload (it carries PII); the normalized event travels in memory.

// The context this file's writes run under: an inbound webhook, so there is no principal to name.
// `actorType: "system"` is the attribution answer for this door: left unset, a row written from here
// (the /reset hand-back) defaults to `user` with a null actor, an unidentifiable person. Whoever typed
// /reset is the CONTACT, not a principal; that is recorded as the action and projection, never the actor.
function sysCtx(tenantId: bigint): TenantContext {
  return {
    tenantId,
    userId: null,
    role: "TENANT_ADMIN",
    actorType: "system",
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

// The runtime knobs (enabled, mode) of the agent bound to a Chatwoot inbox, or null when unbound or
// unknown. Decides, BEFORE the mirror and even for an unmirrored conversation, whether a control
// command is active (test mode only; in production it is customer text) and whether eager media runs
// (ENABLED + PRODUCTION only). Inbox config predates any conversation, so the first event resolves.
async function inboxAgentRuntime(
  tenantId: bigint,
  instanceId: bigint,
  chatwootInboxId: number | null,
  base: PrismaClient,
): Promise<{
  agentId: bigint;
  // The Inbox DB row id (what ExecutionLog.inbox_id and every local column mean by "inbox"), selected
  // here because this query already reads the row.
  inboxId: bigint;
  // The Chatwoot inbox id the row answers for. The payload path already holds it; the sparse path
  // (`conversationInboxRuntime`) recovers it from the stored row, and it is what the STT/vision
  // config resolves against, so a payload that names no inbox still gets its media analysed.
  chatwootInboxId: number;
  enabled: boolean;
  mode: string;
  // The raw settings JSON, carried so a caller can read the channel-redirect config without a second
  // query. Left `unknown`: most callers never touch it, so parsing waits for readChannelRedirectConfig.
  settings: unknown;
  // The inbox's WhatsApp provider, mirrored from the inbox-list sync. Null for a non-WhatsApp inbox
  // or one that has not synced. Read here because the takeover's device leg cannot be decided from
  // the payload alone (see providerReservesEchoIds), and this query already reads the row.
  whatsappProvider: string | null;
  // When THIS binding was made. An observer beside a responder stands down only for a binding that
  // predates the event (see `responderCoversMessage`). Null on a binding older than the column, read
  // there as older than any delivery.
  responderBoundAt: Date | null;
  // How many times the routing of this inbox has changed. Meaningless alone: only compared against the
  // generation the DELIVERY recorded at receipt, to ask whether this reading is the world the message
  // arrived in.
  bindingGeneration: number;
} | null> {
  if (chatwootInboxId == null) return null;
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const inbox = await db.inbox.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId,
        },
      },
      select: {
        id: true,
        agentId: true,
        provider: true,
        responderBoundAt: true,
        bindingGeneration: true,
      },
    });
    if (!inbox?.agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: { enabled: true, mode: true, settings: true },
    });
    if (!agent) return null;
    return {
      agentId: inbox.agentId,
      inboxId: inbox.id,
      chatwootInboxId,
      enabled: agent.enabled,
      mode: agent.mode,
      settings: agent.settings,
      whatsappProvider: inbox.provider,
      responderBoundAt: inbox.responderBoundAt,
      bindingGeneration: inbox.bindingGeneration,
    };
  });
}

type InboxRuntime = NonNullable<Awaited<ReturnType<typeof inboxAgentRuntime>>>;

// The inbox's binding generation, on its own, on a client the caller already has open, so it can be
// read inside the transaction that writes the ledger row. Used where no resolver answered: the ledger
// INSERT, and a route resolution that found no runtime at all.
async function inboxBindingGenerationIn(
  db: ScopedDb,
  instanceId: bigint,
  at: { chatwootInboxId: number | null; chatwootConversationId: number | null },
): Promise<number | null> {
  // The payload's inbox when it names one, else the conversation's mirrored inbox: the same
  // fallback every resolver makes, so the generation and the runtime come from the same row.
  const where =
    at.chatwootInboxId != null
      ? { chatwootInstanceId: instanceId, chatwootInboxId: at.chatwootInboxId }
      : at.chatwootConversationId != null
        ? {
            conversations: {
              some: {
                chatwootInstanceId: instanceId,
                chatwootConversationId: at.chatwootConversationId,
              },
            },
          }
        : null;
  if (where === null) return null;
  const row = await db.inbox.findFirst({
    where,
    select: { bindingGeneration: true },
  });
  return row?.bindingGeneration ?? null;
}

async function inboxBindingGenerationAt(
  tenantId: bigint,
  instanceId: bigint,
  at: { chatwootInboxId: number | null; chatwootConversationId: number | null },
  base: PrismaClient,
): Promise<number | null> {
  // NOTE: This throws instead of answering null: null reads as "the generation cannot say", which
  // switches the window-1 refusal OFF and settles the delivery PROCESSED with no runtime, so a transient
  // DB failure would cause the exact loss the refusal prevents. The caller retries and then rethrows,
  // leaving the row PENDING for the sweep. A null from the query itself is an inbox it cannot name.
  return runScopedOn(base, sysCtx(tenantId), (db) =>
    inboxBindingGenerationIn(db, instanceId, at),
  );
}

// The same runtime, resolved through the CONVERSATION's stored inbox when the payload named none.
// Without it a sparse payload reads as "no agent bound": the operator gates (which resolve the agent
// on their own) could post while ingestion stayed off. Asked only on that path, so the common
// delivery pays no extra query; the shape mirrors `inboxAgentRuntime` so the two cannot drift.
async function conversationInboxRuntime(
  tenantId: bigint,
  instanceId: bigint,
  chatwootConversationId: number | null,
  base: PrismaClient,
): Promise<InboxRuntime | null> {
  if (chatwootConversationId == null) return null;
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId,
        },
      },
      select: {
        inbox: {
          select: {
            id: true,
            chatwootInboxId: true,
            provider: true,
            agentId: true,
            responderBoundAt: true,
            bindingGeneration: true,
          },
        },
      },
    });
    const inbox = conv?.inbox;
    if (!inbox?.agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: { enabled: true, mode: true, settings: true },
    });
    if (!agent) return null;
    return {
      agentId: inbox.agentId,
      inboxId: inbox.id,
      chatwootInboxId: inbox.chatwootInboxId,
      enabled: agent.enabled,
      mode: agent.mode,
      settings: agent.settings,
      whatsappProvider: inbox.provider,
      responderBoundAt: inbox.responderBoundAt,
      bindingGeneration: inbox.bindingGeneration,
    };
  });
}

// The row's status as it stands, asked only where a refusal is about to be raised on it. Null when
// the row cannot be read, which is not "PENDING" and therefore not a refusal.
async function deliveryStatusOf(
  base: PrismaClient,
  tenantId: bigint,
  deliveryRowId: bigint,
): Promise<string | null> {
  // Not swallowed: read only where every other condition of the refusal holds, so answering null
  // on a failure would read an unknown state as settled and let a claim settle PROCESSED with no
  // runtime. The throw leaves the row PENDING and unclaimed, as the refusal itself would.
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootWebhookDelivery.findUnique({
      where: { id: deliveryRowId },
      select: { status: true },
    }),
  );
  return row?.status ?? null;
}

// What the responder's own delivery of this message decided, read from the sibling row's claim
// instead of the responder's mode now: the two deliveries are concurrent, so a switch flipped between
// them would make the observer stay quiet about, or duplicate, what the responder did. Null when no
// sibling has claimed; the caller then falls back to the mode reading, which stays open only while a
// sibling sits between its insert and its claim. At most one row matches (one delivery per route).
async function responderSiblingRemembers(
  tenantId: bigint,
  instanceId: bigint,
  deliveryRowId: bigint,
  responderBotId: number,
  conversationId: number | null,
  message: { id: number; column: "inbound" | "humanReply" } | null,
  // The event this delivery carries: the sibling must be the responder's delivery of the SAME event.
  // One message reaches the ledger as `message_created` and, for a voice note, as the `message_updated`
  // carrying its transcription, both under `inboundMessageId`; without the event the query could
  // answer about the other one and hand back the wrong decision if the mode moved between them.
  event: string,
  base: PrismaClient,
): Promise<boolean | null> {
  if (conversationId === null || message === null) return null;
  const sibling = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootWebhookDelivery.findFirst({
      where: {
        chatwootInstanceId: instanceId,
        conversationId,
        ...(message.column === "inbound"
          ? { inboundMessageId: message.id }
          : { humanReplyMessageId: message.id }),
        routeAgentBotId: responderBotId,
        event,
        // NOTE: One bot serves every role its agent holds, so this delivery's own row can match the
        // responder bot after a promotion.
        id: { not: deliveryRowId },
      },
      // NOTE: The status too: a `true` written by the CLAIM is an intent, not a completion (rule below).
      select: { routeRemembers: true, status: true },
      // NOTE: The NEWEST sibling, INCLUDING null. One message can emit several `message_updated` webhooks,
      // each fanned to both routes, and nothing on the row identifies its fan-out; skipping nulls would walk
      // back to an OLDER update's answer. Null means "not decided yet", and the caller's fallback (the
      // responder's current mode) is what the responder's own claim is about to read anyway.
      orderBy: { id: "desc" },
    }),
  );
  if (sibling === null) return null;
  if (sibling.routeRemembers !== true) return sibling.routeRemembers;
  // NOTE: A `true` this route has not finished acting on is an intent: a responder switched off
  // between claim and ingestion, then crashing, leaves a row that remembers a message it never folded
  // in, and a takeover recovery cannot repair it (it lacks the reply body). Asked ONLY of a colleague's
  // REPLY: there, ingesting early costs an append the dedup window refuses (same `ingest:<thread>:<message>`
  // key, same `recentAgentMessageIds`), while standing down costs the message. On an INBOUND message the
  // intent stays authoritative, since a turn-handled id never enters the dedup window. Answered `false`,
  // not null: null falls back to the responder's mode, which reads "remembers" for exactly this case.
  if (message.column === "humanReply" && sibling.status !== "PROCESSED") {
    return false;
  }
  return true;
}

// Whether a turn already covered this message, asked of the ledger instead of inferred from who owns
// the conversation now. On the `message_updated` carrying a voice note's transcription, ownership is
// read after the decision it asks about, and it errs both ways: a handover makes `!act` append a
// second copy (the dedup window never holds turn-handled ids), and a replay after the bot took the
// conversation back makes `act && !consumed` drop the words.
// Asked of the MESSAGE, not the event (only the creation's row carries a turn's verdict), and not
// narrowed by route (a turn answers the message whichever route carried it). Null means no row can
// say, and the caller falls back to the ownership reading.
async function turnCoveredMessage(
  tenantId: bigint,
  instanceId: bigint,
  deliveryRowId: bigint,
  conversationId: number | null,
  messageId: number,
  base: PrismaClient,
): Promise<boolean | null> {
  if (conversationId === null) return null;
  const sibling = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootWebhookDelivery.findFirst({
      where: {
        chatwootInstanceId: instanceId,
        conversationId,
        inboundMessageId: messageId,
        // NOTE: This row has not settled anything yet.
        id: { not: deliveryRowId },
        // NOTE: Only a row that STATED something, or a null would hide a settled sibling in the ordering.
        turnCovered: { not: null },
      },
      select: { turnCovered: true },
      // NOTE: ANY `true` wins, and receipt order decides nothing. An observer, or a route that stood down
      // for another bot, settles its row `false` (`consumed` answers nobody), and newest-first let that hide
      // the responder's `true`, folding the message in twice. Once a route answered, `true` is the fact.
      orderBy: [{ turnCovered: "desc" }, { id: "desc" }],
    }),
  );
  return sibling?.turnCovered ?? null;
}

// The route's agent as a CLASSIFIER, asked of the binding alone: a row in `InboxObserver` for this
// route's agent on this inbox. Unlike `observerRuntimeForRoute` (the reply path, which answers null
// when the route's bot holds the conversation), observation covers every conversation on the inbox,
// including ones the bot holds from before the rebind. No assignee, no mode, no attach window.
async function boundObserverRuntime(
  tenantId: bigint,
  instanceId: bigint,
  routeAgentBotId: number | null,
  at: { chatwootInboxId: number | null; chatwootConversationId: number | null },
  base: PrismaClient,
): Promise<InboxRuntime | null> {
  if (routeAgentBotId === null) return null;
  const inbox =
    at.chatwootInboxId != null
      ? { chatwootInstanceId: instanceId, chatwootInboxId: at.chatwootInboxId }
      : at.chatwootConversationId != null
        ? {
            conversations: {
              some: {
                chatwootInstanceId: instanceId,
                chatwootConversationId: at.chatwootConversationId,
              },
            },
          }
        : null;
  if (inbox === null) return null;
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const bot = await db.chatwootAgentBot.findFirst({
      where: {
        chatwootInstanceId: instanceId,
        chatwootAgentBotId: routeAgentBotId,
      },
      select: {
        agentId: true,
        agent: { select: { enabled: true, mode: true, settings: true } },
      },
    });
    if (!bot) return null;
    const row = await db.inbox.findFirst({
      where: inbox,
      select: {
        id: true,
        chatwootInboxId: true,
        provider: true,
        agentId: true,
        responderBoundAt: true,
        bindingGeneration: true,
        observers: {
          where: { agentId: bot.agentId },
          // NOTE: The STAMP as well as the row: a row with none is an attach the fork has not confirmed,
          // which counts as observing wherever it gates a refusal and is reported as the attach window here.
          select: { id: true, attachedAt: true },
        },
      },
    });
    // NOTE: The row, and only the row: the attach window is NOT inferable here. "A delivery on this
    // route with no row" is also the ordinary post-detach state, because a bot that still OWNS an older
    // conversation keeps receiving its events after the detach; reading it as an attachment would arm a
    // verdict for an agent nobody observes with, retried to DEAD on every message. The reply-route
    // answer covers the attach window where ownership does not explain the delivery.
    if (!row || row.observers.length === 0) return null;
    return {
      agentId: bot.agentId,
      inboxId: row.id,
      chatwootInboxId: row.chatwootInboxId,
      enabled: bot.agent.enabled,
      mode: bot.agent.mode,
      settings: bot.agent.settings,
      whatsappProvider: row.provider,
      responderBoundAt: row.responderBoundAt,
      bindingGeneration: row.bindingGeneration,
    };
  });
}

// The route's agent when it WATCHES the inbox rather than answering it: the observer's runtime
// (switch, settings, memory) reads this delivery, and the reply path on this route is nobody's. The
// delivery itself is the first signal (the fork delivers to a route only for the inbox's responder
// or an observer), since the `InboxObserver` row can lag the attach or never land. A monitoring agent
// on another's route is an observer by construction; a production agent with no row on an inbox it
// does not answer is a drifted mirror and keeps the responder path. Null for the responder's route.
async function observerRuntimeForRoute(
  tenantId: bigint,
  instanceId: bigint,
  routeAgentBotId: number | null,
  // The payload's inbox when it names one; otherwise the conversation, whose mirrored row names
  // the inbox — the same fallback `conversationInboxRuntime` makes for the responder.
  at: { chatwootInboxId: number | null; chatwootConversationId: number | null },
  // Who the PAYLOAD says holds the conversation, or null when it says nothing at all (a degraded
  // event carries no `meta`). When the route's own bot holds it, the route is the assigned bot's
  // whatever the mode says, and an observer is claimed only by a row — so a payload that is silent
  // is answered by the mirror below rather than read as "held by nobody".
  assignee: {
    type: string | null | undefined;
    id: number | null | undefined;
  } | null,
  // A REPLAY of a delivery the ledger records as an observer's: the role it had when the message
  // arrived, while the questions below are about now. False on every live delivery.
  recordedAsObserver: boolean,
  base: PrismaClient,
  // `attaching` says the answer came from the attach window rather than from a row, so a verdict
  // armed off it can tell "the row has not landed" from "the agent was detached".
): Promise<(InboxRuntime & { attaching: boolean }) | null> {
  if (routeAgentBotId === null) return null;
  const inbox =
    at.chatwootInboxId != null
      ? { chatwootInstanceId: instanceId, chatwootInboxId: at.chatwootInboxId }
      : at.chatwootConversationId != null
        ? {
            conversations: {
              some: {
                chatwootInstanceId: instanceId,
                chatwootConversationId: at.chatwootConversationId,
              },
            },
          }
        : null;
  if (inbox === null) return null;
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const bot = await db.chatwootAgentBot.findFirst({
      where: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootAgentBotId: routeAgentBotId,
      },
      select: {
        agentId: true,
        agent: { select: { enabled: true, mode: true, settings: true } },
      },
    });
    if (!bot) return null;
    const row = await db.inbox.findFirst({
      where: { tenantId, ...inbox },
      select: {
        id: true,
        chatwootInboxId: true,
        provider: true,
        agentId: true,
        responderBoundAt: true,
        bindingGeneration: true,
        observers: {
          where: { agentId: bot.agentId },
          // NOTE: The STAMP as well as the row: a row with none is an attach the fork has not confirmed,
          // which counts as observing wherever it gates a refusal and is reported as the attach window here.
          select: { id: true, attachedAt: true },
        },
      },
    });
    if (!row) return null;
    if (recordedAsObserver)
      return {
        // NOTE: A replay names a role it already had, so the row is the whole answer: the attach window is
        // about a binding being written now.
        attaching: false,
        agentId: bot.agentId,
        inboxId: row.id,
        chatwootInboxId: row.chatwootInboxId,
        enabled: bot.agent.enabled,
        mode: bot.agent.mode,
        settings: bot.agent.settings,
        whatsappProvider: row.provider,
        // NOTE: The inbox's responder binding, carried here too because the observer is who asks its age
        // (`responderCoversMessage`).
        responderBoundAt: row.responderBoundAt,
        bindingGeneration: row.bindingGeneration,
      };
    if (row.agentId === bot.agentId) return null;
    // The mirror answers for a payload that named no assignee: a conversation still assigned to a
    // bot that answered this inbox before is that bot's route. Read as "nobody holds it", it would go to
    // the observer's path while the new responder stands down before another bot's conversation, and
    // the customer is left unanswered.
    const held =
      assignee ??
      (at.chatwootConversationId != null
        ? await db.conversation
            .findFirst({
              where: {
                tenantId,
                chatwootInstanceId: instanceId,
                chatwootConversationId: at.chatwootConversationId,
              },
              select: { assigneeType: true, assigneeId: true },
            })
            .then((c) =>
              c === null ? null : { type: c.assigneeType, id: c.assigneeId },
            )
        : null);
    // NOTE: Holding it ends the question, row or no row: the fork also delivers to the assignee bot, and
    // that route is the assigned bot's, answered with the inbox's CURRENT responder. Read as an observer's
    // it answers nothing while the responder's route stands down, and the customer waits forever. Only
    // where there IS a responder: with none bound, the observer's memory is the only one the inbox has.
    if (
      held?.type === "AgentBot" &&
      held.id === routeAgentBotId &&
      row.agentId !== null
    )
      return null;
    // NOTE: The row, or (inside the attach window) a monitoring agent on a route that is not the
    // responder's. Here the window can be told from a detach: the branch above already sent away the
    // delivery a detached bot gets because it OWNS the conversation, so what arrives here with no row
    // came for the INBOX. Reported, because completing a resolve on a detach reading is permanent.
    if (row.observers.length === 0 && !isMonitoring(bot.agent.mode))
      return null;
    return {
      // NOTE: ...or a row the fork has not confirmed: the row is written before the Chatwoot call, so the
      // attach window states itself instead of leaning on the mode, which a concurrent promotion can move.
      attaching:
        row.observers.length === 0 ||
        row.observers.some((o) => o.attachedAt === null),
      agentId: bot.agentId,
      inboxId: row.id,
      chatwootInboxId: row.chatwootInboxId,
      enabled: bot.agent.enabled,
      mode: bot.agent.mode,
      settings: bot.agent.settings,
      whatsappProvider: row.provider,
      responderBoundAt: row.responderBoundAt,
      bindingGeneration: row.bindingGeneration,
    };
  });
}

// The agent bound to a conversation's OWN (mirrored) inbox, with the ids the same query reads, or
// null. Keyed by the conversation, like the test-mode gate in `maybeConsumeCommandOrGate`, so "is
// this command active?" and the gate that silences the conversation read the same row. It answers
// about the AGENT, not the route: Chatwoot fans one command to the inbox persona and the assigned
// bot, and `commandRoute` is the single fence that picks which one runs it. Answering the route here
// would give the losing delivery `commandActive === false`, which walks past that fence and hands the
// agent "/teste" as customer text. Called only when the payload named no inbox.
async function conversationAgent(
  tenantId: bigint,
  instanceId: bigint,
  chatwootConversationId: number | null,
  base: PrismaClient,
): Promise<{ agentId: bigint; inboxId: bigint; mode: string } | null> {
  if (chatwootConversationId == null) return null;
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId,
        },
      },
      select: { inboxId: true },
    });
    if (conv?.inboxId == null) return null;
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true },
    });
    if (!inbox?.agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: { mode: true },
    });
    if (!agent) return null;
    // NOTE: The ids come with the mode because a command line that names no agent is attributable to
    // nothing.
    return { agentId: inbox.agentId, inboxId: conv.inboxId, mode: agent.mode };
  });
}

interface ResolvedChatwootBot {
  instanceId: bigint;
  tenantId: bigint;
  // The numeric Chatwoot Agent Bot id (the gate's "our bot" identity) of the persona bot that
  // received this delivery.
  agentBotId: number;
  webhookSecret: string;
}

// Resolve the per-persona Agent Bot by its opaque route token (constant-time hash probe). The token
// namespaces the bot, so several bots on one instance never collide. Super-admin: this runs BEFORE
// tenant context.
async function resolveBotByRouteToken(
  token: string,
  base: PrismaClient,
): Promise<ResolvedChatwootBot | null> {
  // Cached in process: see route-token-cache.ts for why the ack path cannot afford this query.
  const webhookRouteTokenHash = hashRouteToken(token);
  let hit = readRouteTokenCache(webhookRouteTokenHash);
  // NOTE: A miss may be a refresh deciding this very token; waiting on it (bounded) costs one lookup
  // between the burst instead of one each, and inherits its failure rather than retrying a pool that
  // just refused.
  if (hit === undefined) {
    await awaitRouteTokenRefresh(webhookRouteTokenHash);
    hit = readRouteTokenCache(webhookRouteTokenHash);
  }
  if (hit !== undefined) {
    // NOTE: A stale entry is answered from memory, also while its refresh fails: the 200 is backed by
    // the ledger row the ack writes next, on a pool of its own, so a lookup that cannot reach the
    // shared pool must not turn every ack into a 500. The refresh runs behind the ack, one at a time
    // and backing off after a failure.
    if (hit.stale && routeTokenRefreshDue(webhookRouteTokenHash)) {
      void refreshRouteToken(webhookRouteTokenHash, base).catch((err) => {
        logger.warn("chatwoot: route token refresh failed: %s", errMsg(err));
      });
    }
    return hit.bot;
  }
  return queryRouteToken(webhookRouteTokenHash, base);
}

function readRouteTokenRow(webhookRouteTokenHash: string, base: PrismaClient) {
  return asSuperAdminOn(base, (db) =>
    db.chatwootAgentBot.findUnique({
      where: { webhookRouteTokenHash },
      select: {
        chatwootInstanceId: true,
        tenantId: true,
        chatwootAgentBotId: true,
        webhookSecret: true,
        // NOTE: Ignore a soft-disconnected account: its webhook route may live in Chatwoot until the unbind
        // propagates. Read through the relation, since a second findUnique is a second transaction on the
        // ack path.
        instance: { select: { disconnectedAt: true } },
      },
    }),
  );
}

// The lookup itself, with the cache write. Separated from `resolveBotByRouteToken` because the
// stale path calls it detached, where there is no caller to return to.
async function queryRouteToken(
  webhookRouteTokenHash: string,
  base: PrismaClient,
): Promise<ResolvedChatwootBot | null> {
  // Snapshotted BEFORE the read: an invalidation landing while this query is in flight has to win,
  // because the writer that invalidated already committed and this row predates that commit.
  const generation = routeTokenCacheGeneration();
  const row = await readRouteTokenRow(webhookRouteTokenHash, base);
  const bot: ResolvedChatwootBot | null =
    !row?.instance || row.instance.disconnectedAt !== null
      ? null
      : {
          instanceId: row.chatwootInstanceId,
          tenantId: row.tenantId,
          agentBotId: row.chatwootAgentBotId,
          webhookSecret: row.webhookSecret,
        };
  writeRouteTokenCache(webhookRouteTokenHash, bot, { generation });
  return bot;
}

// One refresh per token; a miss arriving meanwhile waits on it. The failure travels with the promise:
// swallowed, each waiter would take the blocking path and open its own transaction against a pool
// that is the broken thing. The log belongs to the detached starter, the one caller with nowhere to
// return it.
function refreshRouteToken(
  webhookRouteTokenHash: string,
  base: PrismaClient,
): Promise<void> {
  return trackRouteTokenRefresh(webhookRouteTokenHash, async () => {
    await queryRouteToken(webhookRouteTokenHash, base);
  });
}

export interface ReceiveChatwootResult {
  ack: true;
  // NOTE: No "duplicate": a redelivery is "received" like the first one (Chatwoot only needs that),
  // and `dispatch` says whether it still owes processing.
  outcome: "queued" | "ignored";
  tenantId?: bigint;
  instanceId?: bigint;
  // The idempotency KEY (the X-Chatwoot-Delivery header, or a body digest when absent).
  deliveryId?: string;
  // The ledger row the ack wrote (or found, on a redelivery) before answering.
  deliveryRowId?: bigint;
  // The row's own binding generation, what processing compares against (see `recordDelivery`).
  receiptBindingGeneration?: number | null;
  // Whether the row still owes its first attempt (PENDING). A redelivery of a settled row is acked
  // and not processed again; one of a row still PENDING is, and the CAS decides.
  dispatch?: boolean;
  agentBotId?: number | null;
  normalized?: NormalizedChatwootEvent;
}

export interface ReceiveChatwootParams {
  routeToken: string;
  rawBody: string;
  getHeader: (name: string) => string | null;
  base?: PrismaClient;
  // The client the ack's ledger write goes through. Production leaves both unset and writes through
  // the ack's own pool (`@/api/lib/prisma-ack`); a test that passes `base` alone writes through it.
  ackBase?: PrismaClient;
  // NOTE: injectable wall clock (seconds) for tests; forwarded to the signature verifier.
  nowSeconds?: number;
}

export async function receiveChatwootWebhook(
  params: ReceiveChatwootParams,
): Promise<ReceiveChatwootResult> {
  const base = params.base ?? basePrisma;

  const bot = await resolveBotByRouteToken(params.routeToken, base);
  // Unknown token and bad signature collapse into the SAME 401 — no oracle for which routes are live.
  if (!bot) throw new UnauthorizedError();

  const secret = decryptJson<string>(bot.webhookSecret);
  const authOk = verifyChatwootSignature({
    secret,
    rawBody: params.rawBody,
    signatureHeader: params.getHeader(CHATWOOT_SIGNATURE_HEADER),
    timestampHeader: params.getHeader(CHATWOOT_TIMESTAMP_HEADER),
    nowSeconds: params.nowSeconds,
  });
  if (!authOk) throw new UnauthorizedError();

  // Authenticated past this point — a malformed body is a 400, not a 401.
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.rawBody);
  } catch {
    throw new AppError("invalid JSON body", 400);
  }

  const normalized = normalizeChatwootEvent(parsed);
  if (!normalized) return { ack: true, outcome: "ignored" };

  // X-Chatwoot-Delivery is always present in the fork; fall back to a body digest so a
  // (theoretical) missing header still dedupes deterministically.
  const headerDelivery = params.getHeader(CHATWOOT_DELIVERY_HEADER);
  const deliveryId =
    headerDelivery ??
    `body:${createHash("sha256").update(params.rawBody).digest("hex")}`;

  // The ledger row is written HERE, with the body, and the 200 waits for its commit. Chatwoot never
  // resends a 2xx, so an ack with nothing durable behind it is a promise a restart or a full pool
  // breaks in silence. It goes through a pool of its own, so turns and jobs draining the
  // main one cannot stretch the ack past Chatwoot's budget. A write that fails is a 503, never a 2xx:
  // Chatwoot's retry ladder carries the event, and the unique key makes the retry the same row.
  const ackBase = params.ackBase ?? params.base ?? ackPrisma;
  let recorded: Awaited<ReturnType<typeof recordDeliveryOnAck>>;
  try {
    recorded = await recordDeliveryOnAck(
      ackBase,
      { tenantId: bot.tenantId, instanceId: bot.instanceId },
      deliveryId,
      ledgerFactsOf(normalized, bot.agentBotId),
      {
        chatwootInboxId: normalized.inboxId ?? null,
        chatwootConversationId: normalized.conversationId,
      },
      // Encrypted like every other sensitive value at rest: it holds what the customer wrote.
      encryptJson(params.rawBody),
    );
  } catch (err) {
    logger.warn(
      "chatwoot: the ack could not record delivery %s, answered 503 for Chatwoot to retry: %s",
      deliveryId,
      errMsg(err),
    );
    throw new ServiceUnavailableError(
      "the delivery could not be recorded; retry",
    );
  }
  return {
    ack: true,
    outcome: "queued",
    tenantId: bot.tenantId,
    instanceId: bot.instanceId,
    deliveryId,
    deliveryRowId: recorded.rowId,
    receiptBindingGeneration: recorded.bindingGeneration,
    dispatch: recorded.status === "PENDING",
    agentBotId: bot.agentBotId,
    normalized,
  };
}

export interface RecordAndProcessChatwootParams {
  tenantId: bigint;
  instanceId: bigint;
  deliveryId: string;
  agentBotId: number | null;
  normalized: NormalizedChatwootEvent;
  base?: PrismaClient;
  deps?: RuntimeDeps;
}

// A live direct turn the database pool never served, thrown out of the pass so the delivery goes to
// its recovery now instead of settling PROCESSED, the state nothing revisits.
export class TurnOwedToRecovery extends Error {
  constructor(convLabel: string, cause: unknown) {
    super(
      `chatwoot: the turn found no free database connection (conv=${convLabel}); its delivery goes to recovery`,
      { cause },
    );
    this.name = "TurnOwedToRecovery";
  }
}

// Does now what the sweep would do thirty minutes from now for this row: DEAD with the recovery
// armed, and the line that says so (the sweep's own, `stranded`, at `info` since a recovery is
// coming). The write retries a full pool, since that is why this runs. Losing the CAS means
// something else took the row; failing the write leaves it PROCESSING, to the sweep.
async function handToRecovery(
  base: PrismaClient,
  tenantId: bigint,
  instanceId: bigint,
  rowId: bigint,
  normalized: NormalizedChatwootEvent,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  // One transaction: a DEAD row with no recovery job is invisible to the sweep and to every later
  // pass, so the two commit together or the row stays PROCESSING, where the sweep finds it.
  try {
    const moved = await retryWhileTransactionNeverStarted(
      () =>
        runScopedOn(base, sysCtx(tenantId), async (db) => {
          const { count } = await db.chatwootWebhookDelivery.updateMany({
            where: { id: rowId, status: "PROCESSING" },
            data: { status: "DEAD", processedAt: new Date() },
          });
          if (count === 0) return false;
          await armDeliveryRecoveryOn(db, tenantId, rowId);
          return true;
        }),
      { label: `delivery row ${rowId} to recovery`, sleep },
    );
    if (!moved) return;
  } catch (err) {
    logger.error(
      { err },
      "chatwoot: delivery row %s could not be handed to recovery; the stranded-delivery sweep will find it",
      String(rowId),
    );
    return;
  }
  // Filed on the conversation the mirror knows, like the sweep's; unattached when the read fails.
  const conversationId = normalized.conversationId;
  const conv =
    conversationId === null
      ? null
      : await runScopedOn(base, sysCtx(tenantId), (db) =>
          db.conversation.findUnique({
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
              inbox: { select: { agentId: true } },
            },
          }),
        ).catch(() => null);
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
      level: "info",
      status: "error",
      detail: {
        outcome: "stranded",
        deliveryEvent: normalized.event,
        strandedOn: "PROCESSING",
        messageId: normalized.message?.id ?? null,
        conversationId: normalized.conversationId,
        reason: "no_free_db_connection",
        willRetry: true,
      },
    },
  );
}

// Claim a delivery in the ledger, then process it: the composition the tests drive. The live path
// splits it in two, the claim in the ack (`receiveChatwootWebhook`) and the processing behind the
// admission queue (./delivery-queue.ts). A redelivery is not dropped because the row exists: a row
// can be PENDING with nothing running it, and the CAS on `status: "PENDING"` is the real gate.
export async function recordAndProcessChatwootDelivery(
  params: RecordAndProcessChatwootParams,
): Promise<"processed" | "skipped"> {
  const base = params.base ?? basePrisma;
  const { rowId, bindingGeneration: rowGeneration } = await claimDelivery(
    base,
    { tenantId: params.tenantId, instanceId: params.instanceId },
    params.deliveryId,
    ledgerFactsOf(params.normalized, params.agentBotId),
    // NOTE: Read INSIDE the transaction that writes the row, so the two commit together.
    {
      chatwootInboxId: params.normalized.inboxId ?? null,
      chatwootConversationId: params.normalized.conversationId,
    },
  );
  return processRecordedChatwootDelivery({
    tenantId: params.tenantId,
    instanceId: params.instanceId,
    deliveryRowId: rowId,
    agentBotId: params.agentBotId,
    normalized: params.normalized,
    receiptBindingGeneration: rowGeneration,
    base,
    deps: params.deps,
  });
}

export interface ProcessRecordedChatwootParams {
  tenantId: bigint;
  instanceId: bigint;
  deliveryRowId: bigint;
  agentBotId: number | null;
  normalized: NormalizedChatwootEvent;
  // NOTE: The ROW's value, never a fresh reading: a redelivery finds a row written under the world
  // its message arrived in, while a reading belongs to this attempt. The recovery passes it too.
  receiptBindingGeneration: number | null;
  base?: PrismaClient;
  deps?: RuntimeDeps;
}

// The processing half of a delivery whose ledger row exists: what the admission queue runs for a live
// delivery and for a stored one drained after a restart.
export async function processRecordedChatwootDelivery(
  params: ProcessRecordedChatwootParams,
): Promise<"processed" | "skipped"> {
  const base = params.base ?? basePrisma;
  const rowId = params.deliveryRowId;
  try {
    return await processChatwootDelivery({
      tenantId: params.tenantId,
      instanceId: params.instanceId,
      deliveryRowId: rowId,
      agentBotId: params.agentBotId,
      normalized: params.normalized,
      receiptBindingGeneration: params.receiptBindingGeneration,
      base,
      deps: params.deps,
    });
  } catch (err) {
    if (!(err instanceof TurnOwedToRecovery)) throw err;
    await handToRecovery(
      base,
      params.tenantId,
      params.instanceId,
      rowId,
      params.normalized,
      params.deps?.sleep,
    );
    return "processed";
  }
}

// The claim's retries, for `recordAndProcessChatwootDelivery` and the transcription fill. The live ack
// does not retry: it answers 503 and Chatwoot's own ladder retries (see `receiveChatwootWebhook`).
const LEDGER_CLAIM_ATTEMPTS = 4;
const LEDGER_CLAIM_BACKOFF_MS = 300;

// The memory append's enqueue, retried like the ledger claim for the same full-pool blip, wherever no
// turn will cover the message: `retryArm`'s cases and a colleague's reply. A colleague's reply whose
// attempts are spent leaves the row to the sweep, which re-arms it by id (./recover-human-reply.ts).
// Every other ingestion keeps one attempt.
const INGEST_ARM_ATTEMPTS = 4;
const INGEST_ARM_BACKOFF_MS = 300;

// The nullable facts, named once so the fill cannot use a shorter list than the insert; `event` is
// never null and never filled. `bindingGeneration` is left out on purpose: it describes the WORLD
// when the row was first written, and filling a legacy null from a redelivery would stamp a later
// binding on it. It is read inside the insert's transaction, not derived by `ledgerFactsOf`.
const LEDGER_FILLABLE = [
  "conversationId",
  "inboundMessageId",
  "humanReplyShape",
  "routeAgentBotId",
  "humanReplyMessageId",
] as const;

// Everything the ledger keeps about one delivery, derived in one place so the insert and the fill of
// a legacy row agree. Ids and shapes only: what a person wrote is never held here.
interface LedgerFacts {
  event: string;
  conversationId: number | null;
  inboundMessageId: number | null;
  humanReplyShape: HumanReplyRoute | null;
  routeAgentBotId: number | null;
  humanReplyMessageId: number | null;
  bindingGeneration: number | null;
}

// The one late write to `inboundMessageId`, for an UPDATE whose words this process produced (a
// creation's id is decided at INSERT). Guarded on the column being null, so a redelivery cannot move
// it. Retried against a full pool, since a miss plus a crash leaves the sweep a `message_updated`
// naming nothing; not thrown when spent (that would cost the append too), logged at `error` instead.
export async function fillLedgerTranscribedMessage(
  tenantId: bigint,
  deliveryRowId: bigint | null,
  n: NormalizedChatwootEvent,
  base: PrismaClient,
  // Injected by a test so the retries cost no wall clock.
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  const messageId = n.message?.id;
  if (deliveryRowId === null || messageId == null) return;
  if (inboundTranscriptionOnUpdate(n) === null) return;
  let lastErr: unknown;
  const nap = sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; attempt <= LEDGER_CLAIM_ATTEMPTS; attempt++) {
    try {
      await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.chatwootWebhookDelivery.updateMany({
          where: { id: deliveryRowId, inboundMessageId: null },
          data: { inboundMessageId: messageId },
        }),
      );
      return;
    } catch (err) {
      lastErr = err;
      logger.warn(
        "chatwoot: ledger transcription fill attempt %d/%d failed (delivery row %s): %s",
        attempt,
        LEDGER_CLAIM_ATTEMPTS,
        String(deliveryRowId),
        errMsg(err),
      );
      if (attempt < LEDGER_CLAIM_ATTEMPTS) {
        await nap(LEDGER_CLAIM_BACKOFF_MS * attempt);
      }
    }
  }
  logger.error(
    "chatwoot: the ledger could not record the transcribed message %d (delivery row %s) in %d attempts; a process death before the ingestion is armed loses these words with nothing naming them: %s",
    messageId,
    String(deliveryRowId),
    LEDGER_CLAIM_ATTEMPTS,
    errMsg(lastErr),
  );
}

function ledgerFactsOf(
  n: NormalizedChatwootEvent,
  routeAgentBotId: number | null,
): Omit<LedgerFacts, "bindingGeneration"> {
  // Asked ONCE and read twice: the two fields are a pair, and a row saying a takeover was owed
  // while naming no message would blank the recovery's fence on exactly the rows it exists for.
  const humanReplyShape = newHumanReplyShape(n);
  return {
    event: n.event,
    conversationId: n.conversationId,
    // NOTE: Which CUSTOMER MESSAGE this delivery was working, so the sweep can tell a delivery that lost
    // one from one that lost nothing; the bot's own reply stays null. Also the transcribed UPDATE: on a
    // route where no turn ran at creation it is the message's only readable form, so ./stranded-delivery.ts
    // must see that the row owed something. An id on a `message_updated` is also the discriminator from
    // an older build's rows, which kept null there and close benign.
    inboundMessageId:
      isNewIncomingMessage(n) || inboundTranscriptionOnUpdate(n) !== null
        ? (n.message?.id ?? null)
        : null,
    // NOTE: What this delivery OWED: the payload half of the human-reply route, written before any inbox
    // is read so a process death still leaves the owed takeover behind. The recovery re-decides the
    // provider half against the inbox as it stands then.
    humanReplyShape,
    // NOTE: WHO the delivery was, which neither the payload nor the recovery can re-derive: Chatwoot fans
    // a message to up to two bot routes and only the one holding the conversation passes the gate, so a
    // recovery resolving the identity from the inbox asks a stricter question and leaves the bot on the
    // conversation the person answered.
    routeAgentBotId,
    // NOTE: WHICH message it was about, what the recovery's fence orders by. The payload is gone once
    // the row is claimed and `inboundMessageId` is null for a colleague's outgoing reply, so without
    // this the recovery could walk back a hand-back an operator made while it waited. Same condition
    // and answer as the shape.
    humanReplyMessageId:
      humanReplyShape !== null ? (n.message?.id ?? null) : null,
  };
}

async function claimDelivery(
  base: PrismaClient,
  scope: { tenantId: bigint; instanceId: bigint },
  deliveryId: string,
  facts: Omit<LedgerFacts, "bindingGeneration">,
  at: { chatwootInboxId: number | null; chatwootConversationId: number | null },
): Promise<{
  rowId: bigint;
  duplicate: boolean;
  bindingGeneration: number | null;
}> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= LEDGER_CLAIM_ATTEMPTS; attempt++) {
    try {
      return await recordDelivery(base, scope, deliveryId, facts, at);
    } catch (err) {
      lastErr = err;
      logger.warn(
        "chatwoot ledger claim attempt %d/%d failed (delivery %s): %s",
        attempt,
        LEDGER_CLAIM_ATTEMPTS,
        deliveryId,
        errMsg(err),
      );
      if (attempt < LEDGER_CLAIM_ATTEMPTS) {
        await new Promise((r) =>
          setTimeout(r, LEDGER_CLAIM_BACKOFF_MS * 2 ** (attempt - 1)),
        );
      }
    }
  }
  throw lastErr;
}

// The ack's write: the row `recordDelivery` writes, as ONE statement in a batch transaction, because
// this runs before the 200 on a process whose first limit is CPU and the interactive form costs about
// twice as much. The generation comes from a subquery of the same INSERT; the GUC scopes RLS. A
// redelivery is the conflict, answered by the same statement and with that row's status: it fills
// what the row is missing (`LEDGER_FILLABLE`, never the generation), and the body only while the row
// is PENDING, since a row an older build wrote has none and a redelivery the full queue turns away
// must leave something the drain can process.
async function recordDeliveryOnAck(
  base: PrismaClient,
  scope: { tenantId: bigint; instanceId: bigint },
  deliveryId: string,
  facts: Omit<LedgerFacts, "bindingGeneration">,
  at: { chatwootInboxId: number | null; chatwootConversationId: number | null },
  payload: string,
): ReturnType<typeof recordDelivery> {
  // The payload's inbox when it names one, else the conversation's mirrored inbox, as
  // `inboxBindingGenerationIn` resolves it.
  const generation =
    at.chatwootInboxId != null
      ? Prisma.sql`(SELECT binding_generation FROM inboxes
           WHERE tenant_id = ${scope.tenantId}
             AND chatwoot_instance_id = ${scope.instanceId}
             AND chatwoot_inbox_id = ${at.chatwootInboxId}
           LIMIT 1)`
      : at.chatwootConversationId != null
        ? Prisma.sql`(SELECT i.binding_generation FROM conversations c
             JOIN inboxes i ON i.id = c.inbox_id
             WHERE c.tenant_id = ${scope.tenantId}
               AND c.chatwoot_instance_id = ${scope.instanceId}
               AND c.chatwoot_conversation_id = ${at.chatwootConversationId}
             LIMIT 1)`
        : Prisma.sql`NULL`;
  const [, inserted] = await base.$transaction([
    base.$executeRaw`SELECT set_config('app.tenant_id', ${String(scope.tenantId)}, true)`,
    base.$queryRaw<
      {
        id: bigint;
        binding_generation: number | null;
        status: string;
        inserted: boolean;
      }[]
    >`
      INSERT INTO chatwoot_webhook_deliveries
        (tenant_id, chatwoot_instance_id, delivery_id, event, conversation_id, inbound_message_id,
         human_reply_shape, route_agent_bot_id, human_reply_message_id, binding_generation, payload)
      VALUES
        (${scope.tenantId}, ${scope.instanceId}, ${deliveryId}, ${facts.event}, ${facts.conversationId},
         ${facts.inboundMessageId}, ${facts.humanReplyShape}, ${facts.routeAgentBotId},
         ${facts.humanReplyMessageId}, ${generation}, ${payload})
      ON CONFLICT (chatwoot_instance_id, delivery_id) DO UPDATE SET
        conversation_id = COALESCE(chatwoot_webhook_deliveries.conversation_id, EXCLUDED.conversation_id),
        inbound_message_id = COALESCE(chatwoot_webhook_deliveries.inbound_message_id, EXCLUDED.inbound_message_id),
        human_reply_shape = COALESCE(chatwoot_webhook_deliveries.human_reply_shape, EXCLUDED.human_reply_shape),
        route_agent_bot_id = COALESCE(chatwoot_webhook_deliveries.route_agent_bot_id, EXCLUDED.route_agent_bot_id),
        human_reply_message_id = COALESCE(chatwoot_webhook_deliveries.human_reply_message_id, EXCLUDED.human_reply_message_id),
        payload = CASE WHEN chatwoot_webhook_deliveries.status = 'PENDING'
          THEN COALESCE(chatwoot_webhook_deliveries.payload, EXCLUDED.payload)
          ELSE chatwoot_webhook_deliveries.payload END
      RETURNING id, binding_generation, status::text AS status, (xmax = 0) AS inserted`,
  ]);
  const row = inserted[0];
  if (row === undefined) {
    throw new Error(
      `the ledger write for delivery ${deliveryId} returned no row`,
    );
  }
  return {
    rowId: row.id,
    duplicate: !row.inserted,
    status: row.status,
    bindingGeneration: row.binding_generation,
  };
}

// Idempotency ledger insert: create-then-catch across two transactions (a unique violation
// aborts its own transaction). Unique on (chatwoot_instance_id, delivery_id).
async function recordDelivery(
  base: PrismaClient,
  scope: { tenantId: bigint; instanceId: bigint },
  deliveryId: string,
  facts: Omit<LedgerFacts, "bindingGeneration">,
  at: { chatwootInboxId: number | null; chatwootConversationId: number | null },
): Promise<{
  rowId: bigint;
  duplicate: boolean;
  // The row's status as written or found, so the ack dispatches only a row that still owes its attempt.
  status: string;
  // The ROW's own generation, not the caller's reading: a redelivery's row was written under the world
  // its message arrived in, and the fresh reading belongs to this attempt. Returned from either branch.
  bindingGeneration: number | null;
}> {
  try {
    const row = await runScopedOn(base, sysCtx(scope.tenantId), async (db) => {
      // Read in the SAME transaction that writes the row: a binding committing between a separate
      // read and the insert would stamp a world the message never arrived in. Not on the receive path,
      // which stays read-free so the ack never waits on the pool; the hop from ack to here is shorter than
      // Chatwoot's own emit-to-receive hop, which no column on this side can cover.
      const bindingGeneration = await inboxBindingGenerationIn(
        db,
        scope.instanceId,
        at,
      );
      return db.chatwootWebhookDelivery.create({
        data: {
          tenantId: scope.tenantId,
          chatwootInstanceId: scope.instanceId,
          deliveryId,
          status: "PENDING",
          // NOTE: What a recovery sweep needs if this delivery strands: which conversation to flush, which
          // message the flush should answer, and what side effect was owed. Ids and shapes only; the body
          // is the ack's to store (`recordDeliveryOnAck`).
          ...facts,
          bindingGeneration,
        },
        select: { id: true, bindingGeneration: true },
      });
    });
    return {
      rowId: row.id,
      duplicate: false,
      status: "PENDING",
      bindingGeneration: row.bindingGeneration,
    };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await runScopedOn(base, sysCtx(scope.tenantId), (db) =>
      db.chatwootWebhookDelivery.findFirst({
        where: { chatwootInstanceId: scope.instanceId, deliveryId },
        // NOTE: Read before the fills, which is equivalent: they never touch `bindingGeneration`
        // (see `LEDGER_FILLABLE`).
        select: { id: true, bindingGeneration: true, status: true },
      }),
    );
    if (!existing) throw err;
    // NOTE: Fill what a legacy row is missing before handing it back: the CAS stamps `claimed_at`, which
    // the sweep reads as "this build wrote it, so its nulls mean what they say", and an empty id would
    // close a lost customer message as carrying none. Only fills, never overwrites. ONE STATEMENT PER
    // FACT: a single predicate asks for ALL to be null, and a row with the ids but no shape (written by
    // the prior build) would then never get its shape.
    for (const key of LEDGER_FILLABLE) {
      const value = facts[key];
      if (value === null) continue;
      await runScopedOn(base, sysCtx(scope.tenantId), (db) =>
        db.chatwootWebhookDelivery.updateMany({
          where: { id: existing.id, [key]: null },
          data: { [key]: value },
        }),
      );
    }
    return {
      rowId: existing.id,
      duplicate: true,
      status: existing.status,
      bindingGeneration: existing.bindingGeneration,
    };
  }
}

export interface ProcessChatwootParams {
  tenantId: bigint;
  instanceId: bigint;
  deliveryRowId: bigint;
  agentBotId: number | null;
  normalized: NormalizedChatwootEvent;
  // Which state the opening CAS claims from. Omitted = "PENDING", a delivery arriving. "DEAD" is a
  // recovery taking back a row the sweep gave up on; see the CAS for why it is one statement.
  claimFrom?: "PENDING" | "DEAD";
  // The role the route had WHEN THE DELIVERY ARRIVED, from the ledger's `routeObserved`; only a
  // recovery passes it. Bindings move, and re-deriving could replay a watcher's delivery as the
  // responder, which answers. A live delivery leaves it undefined.
  routeObserved?: boolean;
  // What the stranded pass owed, from the ledger's `owesMemoryOnly`; only a recovery passes it. The
  // pass ran while a person held the conversation or a gate had silenced the message, facts about a
  // moment that is gone: re-derived, it reflects the conversation NOW. It skips the command/gate pass
  // and the turn, clears the ingestion's `act`, joins `settlesHere` and makes the settlement wait for
  // the append. `act` itself stays as derived, so a fact that silences the reply never hides in the
  // word meaning "the bot holds this conversation".
  owesMemoryOnly?: boolean;
  // How wide that pass would have settled, from the ledger's `settleScopedToThisDelivery`. The scope
  // derives from who held the conversation (this delivery beside another AgentBot, the whole
  // conversation behind a person or gate); re-derived on a replay after ownership came back, it would
  // mark the other bot's row consumed with nobody answering. Undefined or null derives it now.
  settleScopedToThisDelivery?: boolean;
  // The inbox's binding generation when this delivery was received, as the ledger row holds it (both
  // callers pass the ROW's value; a reading now belongs to this attempt). Undefined or null means the
  // row cannot say (sparse payload, unmirrored inbox, failed read, older build), never generation zero.
  receiptBindingGeneration?: number | null;
  // What the DIRECT turn did, opt-in so the `"processed" | "skipped"` contract with every caller stays
  // unchanged. The recovery needs it: `"processed"` is about the ROW, but a recovery exists to ANSWER,
  // and closing a loss on a turn that answered nobody (the model threw, or a newer message won
  // `shouldPost`) is the lie this subsystem is built against. Not called when debounce armed instead:
  // that reply is the flush's. TAGGED, because on a union of object literals the absent key is an
  // implicit `?: undefined`, so `r.error !== undefined` narrows nothing.
  onDirectTurn?: (
    r: { kind: "outcome"; outcome: string } | { kind: "error"; error: unknown },
  ) => void;
  // What continuous ingestion answered, for a caller whose work IS the ingestion; opt-in like
  // `onDirectTurn`. Called only where ingestion ran, so "decided" differs from "no route asked" (an
  // inbox unbound, switched off or moved to test mode reaches neither branch and still returns
  // `"processed"`). "covered" is a route standing down because the responder has the message or will
  // consume it as a command: a decision, not silence, or a replay would requeue a settled row.
  // "no-reader" is a switched-on observer on an inbox with no responder of ours: nothing would read it.
  onIngest?: (outcome: IngestOutcome | "covered" | "no-reader") => void;
  base?: PrismaClient;
  // Injectable runtime deps (tests): fake model/client/checkpointer + the contact-auth fetch.
  deps?: RuntimeDeps;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Whether a turn on this message would have its WORDS, narrower than whether a turn ran over it. A
// voice note is a placeholder until STT writes back, and a flush can invoke in that window
// (docs/stt.md, "Known limits"); recording that turn as covered would suppress the ingest the
// write-back arms. `hasAudio` is the FILE TYPE, never STT eligibility: an attachment whose url has
// not landed is still a placeholder, and "could STT run" would claim its words.
export function turnHadTheWords(m: {
  hasAudio: boolean;
  transcribedText: string | null | undefined;
}): boolean {
  return !m.hasAudio || Boolean(m.transcribedText);
}

// Some transports attach the audio only after creating the message, so the first event carrying it
// is a `message_updated` (the fork re-fires it). Analyze that audio, but never let the update drive
// debounce or a second turn; the STT write-back is a no-op since it carries `transcribed_text`.
// AUDIO ONLY: the vision write-back is not serialized into webhook payloads, so a visual leg could
// not tell "never analyzed" from our own write-back and would re-run vision forever.
export function hasPendingInboundMediaUpdate(
  n: NormalizedChatwootEvent,
): boolean {
  if (n.event !== "message_updated" || !isIncomingMessage(n)) return false;
  const audio = firstAudioAttachment(n);
  return Boolean(
    audio && !audio.transcribedText && !n.message?.transcribedText,
  );
}

// The EPISODE's /teste stamp, for the resolve-triggered closing gate: the liveness predicate takes the
// stamp itself, and the gate protects a message to the WhatsApp SIBLING (`closeChat: false`), whose
// activation the widget row does not hold.
async function episodeActivationForWidget(
  tenantId: bigint,
  instanceId: bigint,
  conversationId: number,
  cfg: ChannelRedirectConfig,
  agentMode: string,
  base: PrismaClient,
): Promise<Date | null> {
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: {
        testActivatedAt: true,
        contactId: true,
        inbox: { select: { chatwootInboxId: true } },
      },
    }),
  );
  return episodeTestActivatedAt({
    tenantId,
    instanceId,
    cfg,
    agentMode,
    conv: {
      testActivatedAt: row?.testActivatedAt ?? null,
      contactId: row?.contactId ?? null,
      chatwootInboxId: row?.inbox?.chatwootInboxId ?? null,
    },
    base,
  });
}

// The local ids the eager-media stages are logged against. Every other `source: "inbox"` flow
// context in this repository fills these from values its caller already holds; this one is no
// different, and states them as a type so a new call site has to answer rather than inherit a NULL.
export interface EagerMediaOwner {
  // Conversation DB row id (mirror.conversationRowId), not the Chatwoot conversation id on `n`.
  conversationId: bigint | null;
  agentId: bigint | null;
  // Inbox DB row id, not `n.inboxId` (which is Chatwoot's).
  inboxId: bigint | null;
  // The Chatwoot inbox id the STT/vision config resolves against, for an event that names none: a
  // sparse payload reaches its agent through the mirrored conversation, and a monitoring agent's media
  // is analysed before any gate. The payload's own inbox stays primary: the stored one may be where
  // the conversation was before this event.
  chatwootInboxId: number | null;
  // The ledger row this delivery is working, so it can record what the pass PRODUCED: `ledgerFactsOf`
  // saw no words on an untranscribed audio update, and once the pass stashes a transcription the
  // delivery owes an append only this row can name. Null where there is no row to fill.
  deliveryRowId: bigint | null;
  // Injected by a test so the ledger fill's retries cost no wall clock.
  sleep?: (ms: number) => Promise<void>;
  // The delivery's injectable runtime deps (tests): the Chatwoot client and the providers' fetches.
  deps?: RuntimeDeps;
  // Where this pass stands relative to the contact authorization gate. `allowed`/`refused` is a verdict
  // the caller just got; `unverified` means none was asked, and the pass asks for itself before paying
  // a provider.
  admission: "allowed" | "refused" | "unverified";
  // The delivery's own ask of a watcher's whole gate (`observerMayObserve`), for a pass that finds
  // the inbox's agent observing: the pass and the observation's arm then share one verdict instead
  // of asking the endpoint one after the other.
  watcherPermit?: (
    agentId: bigint,
    settings: unknown,
  ) => Promise<{ askedAt: number } | null>;
}

// Whether this pass may send the message's media to a provider: the same gate, agent and request key
// the turn would use. Fail-closed.
async function mediaAdmitted(
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
  chatwootInboxId: number,
  base: PrismaClient,
  owner: EagerMediaOwner,
): Promise<boolean> {
  if (owner.admission === "refused") return false;
  const conversationId = n.conversationId as number;
  try {
    const ctx = await runScopedOn(base, sysCtx(tenantId), async (db) => {
      const inbox = await db.inbox.findFirst({
        where: { chatwootInstanceId: instanceId, chatwootInboxId },
        select: { id: true, agentId: true, channelType: true },
      });
      const agent = inbox?.agentId
        ? await db.agent.findUnique({
            where: { id: inbox.agentId },
            select: { settings: true, mode: true },
          })
        : null;
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
          contactId: true,
          mediaRefusedThroughMessageId: true,
        },
      });
      return { inbox, settings: agent?.settings, mode: agent?.mode, conv };
    });
    // The refusal mark wins over any yes, including the caller's and a gate switched off since:
    // a replayed delivery re-asks the gate, and a consent given since would answer for a file sent
    // before it.
    const messageId = n.message?.id;
    const convDbId = ctx.conv?.id ?? null;
    if (
      convDbId !== null &&
      refusedCovers(
        await mediaRefusedThrough(
          tenantId,
          convDbId,
          base,
          ctx.conv?.mediaRefusedThroughMessageId ?? null,
        ),
        messageId,
      )
    ) {
      return false;
    }
    const agentId = ctx.inbox?.agentId;
    if (!ctx.inbox || !agentId) return true;
    const cfg = readContactAuthConfig(ctx.settings);
    if (!cfg.enabled) return true;
    if (owner.admission === "allowed") return true;
    // NOTE: Chatwoot follows every voice note with a `message_updated`; the yes already given covers it.
    if (
      messageId != null &&
      mediaAlreadyAdmitted(mediaAdmissionKey(tenantId, instanceId, messageId))
    ) {
      return true;
    }
    const watcherPass = isMonitoring(ctx.mode ?? "");
    // NOTE: Another watcher's route (several can observe one inbox): its own gate already let this
    // conversation through before the pass, and the bound watcher's verdict decides only what the
    // BOUND watcher observes.
    if (watcherPass && owner.agentId !== null && owner.agentId !== agentId) {
      return true;
    }
    if (watcherPass) {
      // The watcher's whole gate, with the retirement bookkeeping an arm's ask does: the delivery's
      // own ask when the caller shares it, asked once for both, or a fresh one. It leaves its own line.
      const permitOf =
        owner.watcherPermit ??
        ((watcherId: bigint, settings: unknown) =>
          observerArmPermit({
            tenantId,
            instanceId,
            conversationId,
            agentId: watcherId,
            settings,
            base,
            fetchImpl: owner.deps?.contactAuthFetch,
            message:
              messageId != null
                ? { id: messageId, text: n.message?.content ?? null }
                : null,
          }));
      if (!(await permitOf(agentId, ctx.settings))) {
        recordWatcherMediaRefusal(tenantId, convDbId, agentId, n.message?.id);
        return false;
      }
      if (
        convDbId !== null &&
        refusedCovers(
          await mediaRefusedThrough(tenantId, convDbId, base),
          messageId,
        )
      ) {
        return false;
      }
      if (messageId != null) {
        rememberMediaAdmission(
          mediaAdmissionKey(tenantId, instanceId, messageId),
        );
      }
      return true;
    }
    const verdict = await authorizeContact({
      tenantId,
      agentId,
      contactDbId: ctx.conv?.contactId ?? null,
      conversationDbId: ctx.conv?.id ?? null,
      conversationId,
      inboxId: chatwootInboxId,
      channelType: ctx.inbox.channelType,
      messageText: n.message?.content ?? null,
      requestKey: cfg.includeMessageText
        ? `msg:${n.message?.id ?? "none"}`
        : "inbox",
      // The media pass asks at one place, so it asks the whole gate.
      stage: "both",
      cfg,
      base,
      fetchImpl: owner.deps?.contactAuthFetch,
    });
    emitFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: owner.conversationId,
        agentId,
        inboxId: ctx.inbox.id,
        threadId: chatwootThreadId(tenantId, instanceId, conversationId),
        base,
      },
      contactAuthFlowEvent(verdict),
    );
    if (verdict.outcome !== "allowed") {
      await recordMediaRefusal(
        tenantId,
        convDbId,
        n.message?.id,
        base,
        owner.sleep,
      );
      return false;
    }
    // NOTE: Re-read after the round trip: a newer message may have been refused meanwhile.
    if (
      convDbId !== null &&
      refusedCovers(
        await mediaRefusedThrough(tenantId, convDbId, base),
        messageId,
      )
    ) {
      return false;
    }
    if (messageId != null) {
      rememberMediaAdmission(
        mediaAdmissionKey(tenantId, instanceId, messageId),
      );
    }
    return true;
  } catch (err) {
    logger.warn(
      "chatwoot: media left unread, the contact authorization could not be asked (conv=%s): %s",
      String(conversationId),
      errMsg(err),
    );
    return false;
  }
}

// Eager media analysis: transcribe an incoming voice note and extract an incoming image or document
// BEFORE arming or answering, writing back to Chatwoot and stashing it on the in-memory event.
// Idempotent and cheap on text (touches only unset fields, fetches config only with an attachment),
// so the before-gate and answer-path double call never transcribes twice. The CALLER decides whether
// to run it (production+enabled always, test only on the answer path, disabled never).
export async function runEagerMedia(
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
  base: PrismaClient,
  // Where this media belongs, in LOCAL ids, for the `stt`/`vision` flow lines. Required, because an
  // omitted field writes a NULL that reads as "no conversation" and hides the failed voice note from
  // /logs?conversationId=. The caller already holds all three; null only where no agent is bound,
  // which is also where no config resolves and no line is written.
  owner: EagerMediaOwner,
): Promise<void> {
  const chatwootInboxId = n.inboxId ?? owner.chatwootInboxId;
  if (
    n.conversationId === null ||
    chatwootInboxId === null ||
    n.message?.id == null
  ) {
    return;
  }
  const convLabel = String(n.conversationId);
  const flow = () => ({
    tenantId,
    turnId: crypto.randomUUID(),
    source: "inbox" as const,
    conversationId: owner.conversationId,
    agentId: owner.agentId,
    inboxId: owner.inboxId,
    threadId: chatwootThreadId(
      tenantId,
      instanceId,
      n.conversationId as number,
    ),
    base,
  });

  // STT (audio → text). Reuse a transcription already on the attachment (re-delivered event) or
  // already stashed on the event (a prior runEagerMedia call this delivery) — never re-transcribe.
  const audio = firstAudioAttachment(n);
  const todos = visualAttachments(n);
  const visionPending =
    todos.length > 0 &&
    !n.message.imageDescription &&
    !n.message.extractedText &&
    // NOTE: Also marks the event as through the pass: without it, a message whose every extraction
    // failed pays the whole provider bill again at the second call site.
    !n.message.attachmentsUnread &&
    !n.message.bodyRead;
  // Asked at most once, and only once a provider config resolved.
  // NOTE: The verdict is asked once; the refusal mark is re-read before each later extraction, since
  // a newer message may be refused while the first one runs.
  let admittedMemo: boolean | null = null;
  const admitted = async (): Promise<boolean> => {
    if (admittedMemo === null) {
      admittedMemo = await mediaAdmitted(
        tenantId,
        instanceId,
        n,
        chatwootInboxId,
        base,
        owner,
      );
      return admittedMemo;
    }
    if (!admittedMemo || owner.conversationId === null) return admittedMemo;
    return !refusedCovers(
      await mediaRefusedThrough(tenantId, owner.conversationId, base),
      n.message?.id,
    );
  };
  if (audio && !n.message.transcribedText) {
    if (audio.transcribedText) {
      n.message.transcribedText = audio.transcribedText;
    } else {
      // Announced before the config is even read, so a debounce flush re-reading the thread in the
      // meantime waits for these words instead of rendering the audio as unheard; closed on every exit.
      const closeTranscription = openTranscription({
        tenantId,
        instanceId,
        messageId: n.message.id,
      });
      try {
        const sttCfg = await resolveSttConfig(
          tenantId,
          instanceId,
          chatwootInboxId,
          base,
          // NOTE: The route's agent, which on an observer's route is not the inbox's.
          { agentId: owner.agentId },
        );
        if (sttCfg && (await admitted())) {
          const text = await transcribeInboundAudio({
            tenantId,
            instanceId,
            conversationId: n.conversationId,
            messageId: n.message.id,
            attachmentId: audio.id,
            dataUrl: audio.dataUrl,
            cfg: sttCfg,
            base,
            flow: flow(),
            deps: {
              makeClient: owner.deps?.makeClient,
              fetchImpl: owner.deps?.sttFetch,
            },
          });
          // NOTE: the words are already stashed for the overlay; the ledger write below can retry, and a
          // waiting flush has nothing more to learn from it.
          closeTranscription();
          if (text) {
            n.message.transcribedText = text;
            // NOTE: FILL-ONLY, and immediately: the next statement can throw, and from here on the words exist
            // nowhere durable but this row. Never an overwrite: a row that names its message names the right one.
            await fillLedgerTranscribedMessage(
              tenantId,
              owner.deliveryRowId,
              n,
              base,
              owner.sleep,
            );
          }
        }
      } catch (err) {
        logger.warn("stt failed (conv=%s): %s", convLabel, errMsg(err));
      } finally {
        closeTranscription();
      }
    }
  }

  // NOTE: Vision (image/document to description/extracted text), skipped if already extracted this
  // delivery. What happens to the attachments lives in `extractMessageVisuals` (../vision/extract-message),
  // shared with the turn that re-reads a thread; this side keeps the decision to run and where results go.
  if (visionPending) {
    try {
      const visionCfg = await resolveVisionConfig(
        tenantId,
        instanceId,
        chatwootInboxId,
        base,
        // NOTE: The route's agent, which on an observer's route is not the inbox's.
        { agentId: owner.agentId },
      );
      // Only a new extraction waits for the gate; metadata already on an attachment is reused. Email
      // body images are not counted as unread: telling them from an ornament needs the download.
      const lidos = todos.filter((v) => !hasUnextractedVisual([v]));
      const visuals =
        visionCfg && lidos.length < todos.length && !(await admitted())
          ? lidos
          : todos;
      const recusados = todos.filter(
        (v) => v.id !== null && !visuals.includes(v),
      ).length;
      if (visionCfg && visuals.length > 0) {
        // Hoisted: the narrowing the guard above gives `n.message` does not survive into the call
        // below, because a mutable property can change before a deferred callback reads it.
        const conversationId = n.conversationId;
        const messageId = n.message.id;
        const r = await extractMessageVisuals({
          tenantId,
          instanceId,
          conversationId,
          messageId,
          visuals,
          cfg: visionCfg,
          stillAllowed: admitted,
          base,
          flow: flow(),
          convLabel,
          deps: {
            makeClient: owner.deps?.makeClient,
            fetchImpl: owner.deps?.visionFetch,
          },
        });
        if (r && recusados > 0)
          stashMediaAnnotation(
            { tenantId, instanceId, messageId },
            { attachmentsUnread: r.attachmentsUnread + recusados },
          );
        if (r) {
          // NOTE: The overflow is NAMED, never dropped: a model told "3 more files were not read" asks the
          // customer to resend them, while one told nothing answers as if the message had fewer files. A
          // COUNT phrased by the renderer, because it has to survive the debounce re-fetch.
          if (r.attachmentsUnread + recusados > 0)
            n.message.attachmentsUnread = r.attachmentsUnread + recusados;
          if (r.unreadFiles.length > 0) n.message.unreadFiles = r.unreadFiles;
          if (r.bodyRead) n.message.bodyRead = true;
          if (r.imageDescription)
            n.message.imageDescription = r.imageDescription;
          if (r.extractedText) n.message.extractedText = r.extractedText;
        }
      }
    } catch (err) {
      logger.warn("vision failed (conv=%s): %s", convLabel, errMsg(err));
    }
  }
}

// The contact-inbox the mirrored conversation is known by, for a payload that names none. Fails OPEN
// to null: the observer's path has already marked the message, so this only decides whether it is
// also remembered.
async function storedContactInboxId(
  tenantId: bigint,
  conversationRowId: bigint | null,
  base: PrismaClient,
): Promise<number | null> {
  if (conversationRowId === null) return null;
  try {
    const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.conversation.findUnique({
        where: { id: conversationRowId },
        select: { contactInboxId: true },
      }),
    );
    return row?.contactInboxId ?? null;
  } catch (err) {
    logger.warn(
      "chatwoot: could not read the stored contact-inbox (conversation row=%s): %s",
      String(conversationRowId),
      errMsg(err),
    );
    return null;
  }
}

// What the enqueue answered, for the observer's path, which marks on it. "nothing": nothing to
// remember; "no-thread": no contact-inbox to key memory by; "failed": the enqueue threw, logged here
// and left to the caller.
type IngestOutcome = "queued" | "nothing" | "no-thread" | "failed";

// Continuous ingestion: fold into the per-contact-inbox thread what no turn handled, so the bot has
// full context when it resumes. The CALLER gates it (enabled production or monitoring), so a
// `consumed` incoming here was silenced by a gate. A failed enqueue comes back as "failed" rather
// than thrown, and the caller throws on it where the message has no other chance, leaving the row
// PROCESSING for the sweep. See docs/graph.md, "Continuous ingestion".
async function ingestUnhandledMessage(args: {
  tenantId: bigint;
  instanceId: bigint;
  // This delivery's own row, so the coverage question can exclude it from its own answer.
  deliveryRowId: bigint;
  n: NormalizedChatwootEvent;
  act: boolean;
  consumed: boolean;
  // The inbox's agent, for arming memory compaction when this message opens a new attendance: one can
  // begin on a message the agent never answers, and deployments that never resolve conversations
  // would otherwise hide that boundary until the next attendance.
  agentId: bigint;
  compactionEnabled: boolean;
  // The inbox's WhatsApp provider, for the human-reply predicate's device leg. Threaded rather than
  // re-read: the caller already holds it, and the two decisions (fold this in / step off the
  // conversation) must be made from the same answer.
  whatsappProvider: string | null;
  // The contact-inbox the mirror knows the conversation by, for a payload that names none: the
  // observer's path marks the message handled before this runs, so giving up would lose it. The
  // payload's own stays primary.
  storedContactInboxId: number | null;
  // Whether the enqueue is retried before it is reported failed: yes under an observer, whose
  // memory the append is for (see INGEST_ARM_ATTEMPTS).
  retryArm: boolean;
  sleep?: (ms: number) => Promise<void>;
  base: PrismaClient;
}): Promise<IngestOutcome> {
  const { tenantId, instanceId, n, act, consumed, base } = args;
  if (n.conversationId === null || n.message?.id == null) return "nothing";
  // The thread is keyed by the native ContactInbox id; without it we cannot address a stable thread.
  const contactInboxId = n.contactInboxId ?? args.storedContactInboxId;
  if (contactInboxId === null) return "no-thread";
  const conversationId = n.conversationId;
  const messageId = n.message.id;
  const graphThreadId = resolveGraphThreadId(
    tenantId,
    instanceId,
    conversationId,
    contactInboxId,
  );

  // What gets folded in, and as whom (docs/graph.md, "Continuous ingestion"): a customer message
  // the bot will NOT answer (`act && consumed` or `!act`), so an unlocked turn sees what was said while
  // refused; a HUMAN reply by composer or paired phone, which no turn covers; and the late update that
  // carries a voice note's transcription, read from the event or the attachment (the fork re-fires
  // after our write-back). That third arm keeps the creation's gate because the dedup window never
  // holds turn-handled ids. Audio only: see `hasPendingInboundMediaUpdate`.
  const lateTranscription = inboundTranscriptionOnUpdate(n);
  // NOTE: Hoisted like the assignment in `runEagerMedia`: the words live on the attachment, and every
  // downstream reader asks the message.
  if (lateTranscription && n.message && !n.message.transcribedText) {
    n.message.transcribedText = lateTranscription;
  }
  const lateMediaAnalyzed = lateTranscription !== null;
  // The late-transcription arm asks the LEDGER, not ownership now: `act` on a `message_updated`
  // reads a decision taken on the creation's delivery and errs both ways; null falls back to it. The
  // creation arm keeps `act`, where both questions are one fact and its own row has not settled.
  const covered = lateMediaAnalyzed
    ? await turnCoveredMessage(
        tenantId,
        instanceId,
        args.deliveryRowId,
        n.conversationId,
        messageId,
        base,
      )
    : null;
  const unhandledByOwnership = (act && consumed) || !act;
  const incomingUnhandled =
    (isNewIncomingMessage(n) || lateMediaAnalyzed) &&
    (covered === null ? unhandledByOwnership : !covered);
  const role: IngestRole | null = incomingUnhandled
    ? "customer"
    : isNewHumanReplyToCustomer(n, {
          whatsappProvider: args.whatsappProvider,
        })
      ? "human_agent"
      : null;
  if (role === null) return "nothing";
  // One renderer per direction (../chatwoot/render.ts). The attendant's names the attachment and
  // the words of an audio reply (eager media never runs on outgoing messages); the customer's markers
  // speak from the customer's side, so reused they would have the agent ask its colleague to resend.
  const text =
    role === "human_agent"
      ? renderAttendantMessage({
          text: n.message.content ?? "",
          attachmentTypes: (n.message.attachments ?? [])
            .map((a) => a.fileType)
            .filter((t): t is string => t !== null),
          transcribedText:
            n.message.transcribedText ??
            (n.message.attachments ?? []).find((a) => a.transcribedText)
              ?.transcribedText,
        })
      : // NOTE: Asked of `incomingRenderable`, the one mapping every reader
        // shares: a second copy drifts (it dropped subject-only emails).
        renderInboundMessage(incomingRenderable(n));
  if (!text.trim()) return "nothing";
  // QUEUED, not appended: a turn owning the channel erases anything written beside it, and the
  // append can say "not now" (../../graph/ingest-job.ts). The webhook keeps the RENDERING, which reads
  // eager media the job cannot re-derive. No turn reads a colleague's reply, so it retries like
  // `retryArm`'s cases, asked by ROLE rather than re-spelled at the caller. Spent attempts return
  // "failed", reported below.
  const attempts =
    args.retryArm || role === "human_agent" ? INGEST_ARM_ATTEMPTS : 1;
  const sleep =
    args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await armIngest({
        tenantId,
        instanceId,
        conversationId,
        contactInboxId,
        graphThreadId,
        messageId,
        text,
        role,
        sentAt: n.message.createdAt ?? null,
        agentId: args.agentId,
        compactionEnabled: args.compactionEnabled,
        base,
      });
      return "queued";
    } catch (err) {
      // NOTE: Reported rather than thrown: a delivery retry would re-run eager media (a second provider
      // round trip) for one append, so the caller decides which outcomes leave the row for the sweep.
      logger.warn(
        "ingest arm (%s) attempt %d/%d failed (conv=%s): %s",
        role,
        attempt,
        attempts,
        String(conversationId),
        errMsg(err),
      );
      if (attempt < attempts) {
        await sleep(INGEST_ARM_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
  }
  return "failed";
}

// Reactive availability: outside the "Disponibilidade" schedule the agent stays SILENT and the
// operator gets a one-shot private note. No schedule or empty windows means always on. Pure (now is
// injected). The CUSTOMER-facing away message is a separate decision on its own watermark
// (awayMessageDue, src/modules/availability/away.ts), so an earlier note does not suppress it.
export function outOfHoursGate(
  hours: Schedule | null,
  now: Date,
  noticeAlreadySent: boolean,
): { silence: boolean; postNote: boolean } {
  if (!scheduleCanClose(hours)) {
    return { silence: false, postNote: false };
  }
  if (isOpenAt(hours, now)) {
    return { silence: false, postNote: false };
  }
  return { silence: true, postNote: !noticeAlreadySent };
}

// Claim the day's away message with a CAS on its watermark's exact previous value (null included).
// The dispatch is DETACHED, so two messages in a row both read the same watermark; without the claim
// both post. The loser skips.
export async function claimAwayMessage(params: {
  tenantId: bigint;
  conversationId: bigint;
  previous: Date | null;
  now: Date;
  base: PrismaClient;
}): Promise<boolean> {
  const claimed = await runScopedOn(
    params.base,
    sysCtx(params.tenantId),
    (db) =>
      db.conversation.updateMany({
        where: {
          id: params.conversationId,
          awayMessageSentAt: params.previous,
        },
        data: { awayMessageSentAt: params.now },
      }),
  );
  return claimed.count === 1;
}

// Give the day back when the message never left: the watermark means "the customer heard from us
// today", and settling it on a failed claim suppresses the retry until tomorrow. Guarded on our own
// stamp; the operator note's watermark is untouched.
export async function releaseAwayMessage(params: {
  tenantId: bigint;
  conversationId: bigint;
  previous: Date | null;
  claimed: Date;
  base: PrismaClient;
}): Promise<void> {
  try {
    await runScopedOn(params.base, sysCtx(params.tenantId), (db) =>
      db.conversation.updateMany({
        where: {
          id: params.conversationId,
          awayMessageSentAt: params.claimed,
        },
        data: { awayMessageSentAt: params.previous },
      }),
    );
  } catch (err) {
    logger.warn(
      "chatwoot: away-message claim release failed (conv=%s): %s",
      String(params.conversationId),
      errMsg(err),
    );
  }
}

// pt-BR labels for the runtime's own failure codes, for the operator note below. Codes without a
// label (an endpoint's custom reason) are shown as the code itself.
const CONTACT_AUTH_ERROR_LABELS: Record<string, string> = {
  timeout: "tempo esgotado",
  network: "falha de rede",
  unsafe_url: "URL bloqueada",
  invalid_url: "URL inválida",
  not_configured: "URL não configurada",
  credential_unavailable: "credencial indisponível",
  credential_not_injectable:
    "a credencial escolhida nunca é enviada numa requisição",
  invalid_response: "resposta inválida",
  body_too_large: "resposta grande demais",
  unexpected_status: "status inesperado",
};

// What the CUSTOMER got on this refusal. Only `denied` can send a copy; `no_identity` and `error`
// are silent to the customer by design.
export type ContactAuthCopyOutcome =
  // The refusal notice reached the customer.
  | "sent"
  // No `denyMessage` configured: the customer got nothing, on purpose.
  | "none"
  // Configured, but another refusal on this conversation holds the notice window.
  | "suppressed"
  // Configured and attempted, but nothing reached the customer: the send failed, or the
  // ownership fence stood it down.
  | "failed";

// Operator-facing note for a conversation the contact-authorization gate refused (pt-BR). Reasons are
// short slugs by now, so the note carries one without anything the customer wrote; this is the ONE
// place the endpoint's own reason surfaces, on the conversation, not in the execution log.
// Which condition of the agent's own rule refused, said to the operator. Keyed by OUR reason codes.
const RULE_NOTE_LINES: Record<string, string> = {
  [RULE_NOT_LISTED]:
    "🔒 Contato não autorizado pela regra do agente: o telefone e o identificador do contato não estão na lista.",
  [RULE_UNMET]:
    "🔒 Contato não autorizado pela regra do agente: o atributo exigido não está como a regra pede.",
  [RULE_CONVERSATION_TYPE]:
    "🔒 Conversa fora da regra do agente: o tipo de conversa (grupo ou individual) não é o que a regra pede.",
  [RULE_LABEL]:
    "🔒 Conversa fora da regra do agente: a conversa não tem a etiqueta exigida.",
  [RULE_NONE_MET]:
    "🔒 Conversa fora da regra do agente: nenhuma das condições da regra foi atendida.",
};

export function contactAuthNoteText(
  verdict: {
    outcome: ContactAuthOutcome;
    status?: number;
    reason?: string;
    endpointReason?: string;
  },
  handedOff: boolean,
  // Defaults to `none` so the sentence stays true for a caller that sends no copy.
  copy: ContactAuthCopyOutcome = "none",
): string {
  const handoffLine = handedOff
    ? " A conversa foi aberta para atendimento humano."
    : "";
  if (verdict.outcome === "no_identity") {
    return (
      "🔒 Autorização do contato: não foi possível verificar porque o contato não tem telefone, e-mail nem identificador cadastrados. O agente não respondeu automaticamente." +
      handoffLine
    );
  }
  if (verdict.outcome === "denied") {
    const motivo = verdict.endpointReason ?? verdict.reason;
    const reason = motivo ? ` Motivo: ${motivo}.` : "";
    // The note carries what is NOT on screen. A copy that went out is visible right above, so the
    // note keeps only the reason code; the three cases where nothing reached the customer each ask
    // something different of the operator (configure a copy, cooldown, chase the failure).
    const copyLine = {
      sent: "",
      none: " Nenhum aviso foi enviado ao contato: não há mensagem de recusa configurada.",
      // NOTE: Says the window was TAKEN, not that a copy landed: a concurrent refusal claims the window
      // before it sends, and may still fail and give it back.
      suppressed:
        " O aviso de recusa não saiu nesta mensagem: a carência entre avisos já estava tomada por outra recusa.",
      // NOTE: Says the RESULT, not a cause: `postPublicMessage` returns the same false for a failed send
      // and for the ownership fence standing it down, so "delivery failure" would mislead on the second.
      failed: " O aviso de recusa NÃO chegou ao contato.",
    }[copy];
    // A local rule refused: no endpoint was asked, so "external check" would point the operator at
    // a service that never saw this contact. Name the rule and which of its two questions failed.
    const ruleLine = verdict.reason
      ? (RULE_NOTE_LINES[verdict.reason] ?? null)
      : null;
    if (ruleLine) return `${ruleLine}${copyLine}${handoffLine}`;
    return `🔒 Contato não autorizado pela verificação externa.${reason}${copyLine}${handoffLine}`;
  }
  const cause =
    verdict.status !== undefined
      ? `HTTP ${verdict.status}`
      : (CONTACT_AUTH_ERROR_LABELS[verdict.reason ?? ""] ??
        verdict.reason ??
        "falha desconhecida");
  return `⚠️ A verificação de autorização do contato falhou (${cause}). O agente não respondeu automaticamente; a próxima mensagem tenta novamente.`;
}

// Test-mode gate plus the /teste and /reset commands, at the TOP of the actionable branch (before
// eager STT, debounce, the turn). True when consumed here (a command ran, or a test agent stays silent
// until /teste), so the caller skips agent processing. Commands apply only to a test-mode agent
// (commandActive); for any other they are customer text.
async function maybeConsumeCommandOrGate(params: {
  tenantId: bigint;
  instanceId: bigint;
  n: NormalizedChatwootEvent;
  // The parsed control command (null = not a command) and whether it is ACTIVE (the bound agent is in
  // test mode). Both resolved by the caller before the mirror ran.
  command: ControlCommand | null;
  commandActive: boolean;
  // The bot whose webhook ROUTE this delivery arrived on. Not an ownership question — that one is
  // `stillOurs` — but a routing one: Chatwoot fans the same message out to the conversation's
  // assigned bot AND the inbox's, and a command must run on exactly one of them.
  agentBotId: number | null;
  base: PrismaClient;
  // Injectable runtime deps (tests): the Chatwoot client factory and the contact-auth fetch.
  deps?: RuntimeDeps;
  // Handed what the authorization endpoint said ABOUT the contact when the gate lets the delivery
  // through, so the direct turn can put it in the prompt. A callback because the returns here are a
  // plain "consumed?" written in many places; the verdict is asked in exactly one.
  onAuthContext: (context: AuthContext | null) => void;
  // The gate's verdict for this message, so the media pass after it does not ask again.
  onAuthVerdict?: (allowed: boolean) => void;
}): Promise<boolean> {
  const { tenantId, instanceId, n, command, commandActive, base, deps } =
    params;
  if (n.conversationId === null) return false;
  const conversationId = n.conversationId;
  const isTeste = commandActive && command === "teste";
  const isReset = commandActive && command === "reset";

  // Resolve the conversation row + the inbox's agent (mode + the availability schedule). DB only.
  const ctx = await runScopedOn(base, sysCtx(tenantId), async (db) => {
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
        contactId: true,
        contactInboxId: true,
        testActivatedAt: true,
        testNoticeSentAt: true,
        status: true,
        assigneeType: true,
        assigneeId: true,
        outOfHoursNoticeSentAt: true,
        awayMessageSentAt: true,
        redirectSentAt: true,
        redirectCount: true,
        redirectLinkedAt: true,
        redirectOriginDisplayId: true,
        chatwootRedirectOriginAt: true,
        inboxId: true,
      },
    });
    if (!conv) return null;
    let agentId: bigint | null = null;
    let inboxChatwootId: number | null = null;
    let channelType: string | null = null;
    let agentSettings: unknown = null;
    let mode = "production";
    let agentEnabled = true;
    let hours: Schedule | null = null;
    if (conv.inboxId !== null) {
      const inbox = await db.inbox.findUnique({
        where: { id: conv.inboxId },
        select: { agentId: true, chatwootInboxId: true, channelType: true },
      });
      inboxChatwootId = inbox?.chatwootInboxId ?? null;
      channelType = inbox?.channelType ?? null;
      if (inbox?.agentId) {
        agentId = inbox.agentId;
        const agent = await db.agent.findUnique({
          where: { id: inbox.agentId },
          select: {
            mode: true,
            enabled: true,
            businessHoursId: true,
            settings: true,
          },
        });
        if (agent) {
          mode = agent.mode;
          agentEnabled = agent.enabled;
          agentSettings = agent.settings;
          // The agent's "Availability" schedule (businessHoursId) gates REACTIVE replies: outside it
          // the agent stays silent (a one-shot private note tells the operator). Empty = always on.
          if (agent.businessHoursId !== null) {
            const bh = await db.businessHours.findUnique({
              where: { id: agent.businessHoursId },
              select: { windows: true, exceptions: true, timezone: true },
            });
            if (bh) hours = parseSchedule(bh);
          }
        }
      }
    }
    return {
      conv,
      agentId,
      mode,
      agentEnabled,
      hours,
      inboxChatwootId,
      channelType,
      agentSettings,
    };
  });
  if (!ctx) return false;

  // The persona bound to this conversation's inbox, resolved ONCE for both halves of every
  // customer-visible post (the token and the id the conversation knows it by). Chatwoot also dispatches
  // to the conversation's ASSIGNED bot (agent_bot_listener.rb), so the bot that received this delivery
  // is not always the sender; a fence clearing the recipient while sending as the inbox persona would
  // post into another persona's conversation.
  let personaOnce: Promise<AgentBotIdentity | null> | null = null;
  const persona = (): Promise<AgentBotIdentity | null> =>
    (personaOnce ??=
      ctx.agentId !== null
        ? loadAgentBot(tenantId, instanceId, ctx.agentId, base)
        : Promise.resolve(null));

  // A client acting AS that persona: every bot-token endpoint (send, private note, custom
  // attributes) authenticates with it. A client built without resolving the bot has an empty token,
  // which Chatwoot rejects with 401.
  const personaClient = async (): Promise<ChatwootClient> =>
    loadChatwootClient(tenantId, instanceId, {
      base,
      makeClient: deps?.makeClient,
      botToken: (await persona())?.accessToken,
    });

  // One command, one run. Chatwoot dispatches to the ASSIGNED bot and the inbox's
  // (agent_bot_listener.rb), two deliveries, so both routes would execute it. The inbox's persona runs
  // it (it is that agent's memory and that agent the conversation returns to); the other route consumes
  // the delivery, since returning false would hand "/reset" to its agent as customer text. Fails CLOSED
  // on an unresolvable identity on either side: a bot without a ChatwootAgentBot row speaks with an
  // empty token, and an unknown route is no evidence. `commandRoute` decides once, `other_route` (a
  // persona will run it) versus `no_persona` (no route will), so the report cannot disagree with it.
  const route: CommandRoute =
    command !== null && commandActive
      ? commandRoute(
          (await persona())?.chatwootAgentBotId ?? null,
          params.agentBotId,
        )
      : { reason: "ours" };
  if (command !== null && route.reason !== "ours") {
    logger.info(
      route.reason === "no_persona"
        ? "chatwoot: /%s dropped (conv=%s) — the inbox's agent has no Chatwoot bot identity, so no route can run it"
        : "chatwoot: /%s not for this route, leaving it to the inbox's persona (conv=%s)",
      command,
      String(conversationId),
    );
    emitCommandDropped({
      tenantId,
      conversationRowId: ctx.conv.id,
      agentId: ctx.agentId,
      inboxRowId: ctx.conv.inboxId,
      command,
      routeBot: params.agentBotId,
      // NOTE: The classifier's own answer, never a second look at the same two ids.
      drop: route,
      base,
    });
    return true;
  }

  // Is the conversation still the bot's RIGHT NOW? `act` came from the payload, which cannot see
  // a human who took over since (on a redelivery that gap is long); the mirror applies assignment events
  // as they arrive. Being fast is not being atomic. `closed` is null only for an unresolvable persona:
  // that answer is ours, not the row's, so a caller writing a line skips it rather than guessing.
  const ownershipNow = async (): Promise<
    { ours: true } | { ours: false; closed: GateCloseDetail | null }
  > =>
    conversationOwnershipNow({
      tenantId,
      instanceId,
      conversationId,
      ourAgentBotId: (await persona())?.chatwootAgentBotId ?? null,
      base,
    });
  const stillOurs = async (): Promise<boolean> => (await ownershipNow()).ours;

  // Read FRESH like `stillOurs`: /reset asks after a cleanup a dozen network calls long, and a
  // stale switch would hand the conversation back to an agent an operator turned off meanwhile. On a
  // failed read the initial value stands (a transient failure must not decide it), logged.
  const agentStillEnabled = async (): Promise<boolean> => {
    const agentId = ctx.agentId;
    if (agentId === null) return ctx.agentEnabled;
    try {
      const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.agent.findUnique({
          where: { id: agentId },
          select: { enabled: true },
        }),
      );
      // NOTE: A deleted row is not an agent that can answer, so the hand-back is refused rather than
      // falling back to what the lookup said before.
      return row?.enabled === true;
    } catch (err) {
      logger.warn(
        "chatwoot: could not re-read whether the agent is enabled (conv=%s): %s",
        String(conversationId),
        errMsg(err),
      );
      return ctx.agentEnabled;
    }
  };

  // `stillOurs` for callers that must not throw (/reset after its cleanup, /teste after the
  // activation commits). Unknown reads as OURS: the hand-back is the irreversible act, and the wrong
  // text is cheaper this way ("activated" is a silence the operator retries; "send /reset" would clear
  // an episode for nothing). `postPublicMessage` falls back the OPPOSITE way: unreadable withholds.
  const stillOursOrUnknown = async (): Promise<boolean> => {
    try {
      return await stillOurs();
    } catch (err) {
      logger.warn(
        "chatwoot: could not read whether the conversation is still the bot's (conv=%s): %s",
        String(conversationId),
        errMsg(err),
      );
      return true;
    }
  };

  // Pulls the mirror level with Chatwoot AND the in-memory snapshot with the mirror: `ctx.conv`
  // is what `holderAtStart` and the hand-back's baseline read. Via the VERSIONED
  // `reconcileMirrorFromLive`, so a newer webhook wins over this GET (the probe `runAgentNudge` runs
  // too). Best-effort and never in `failed`: a failed refresh leaves every decision where it stood.
  const refreshFromLive = async (
    guarding: string,
    have: ChatwootClient | null,
  ): Promise<void> => {
    try {
      const client = have ?? (await personaClient());
      const live = parseLiveConversation(
        await client.getConversation(conversationId),
      );
      if (!live) return;
      await reconcileMirrorFromLive({
        tenantId,
        instanceId,
        conversationId,
        live,
        base,
      });
      const fresh = await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.conversation.findUnique({
          where: { id: ctx.conv.id },
          select: { assigneeType: true, assigneeId: true, status: true },
        }),
      );
      if (fresh) {
        ctx.conv.assigneeType = fresh.assigneeType;
        ctx.conv.assigneeId = fresh.assigneeId;
        ctx.conv.status = fresh.status;
      }
    } catch (err) {
      logger.warn(
        "chatwoot: /reset could not refresh the conversation before %s (conv=%s): %s",
        guarding,
        String(conversationId),
        errMsg(err),
      );
    }
  };

  // Why the agent would not answer here now: not its conversation, or switched OFF. Kept apart
  // from `stillOurs`, since folding "disabled" in would make /reset hand a conversation to an agent that
  // never answers. `disabled` wins the tie: /reset returns a conversation, it cannot switch an agent on.
  const answerBlocker = async (): Promise<"none" | "ownership" | "disabled"> =>
    !(await agentStillEnabled())
      ? "disabled"
      : (await stillOursOrUnknown())
        ? "none"
        : "ownership";

  // Returns whether the message left: the away message would otherwise burn its claimed day, and
  // the redirect gate its one-shot. The command acks ignore it (their effect is committed). The fence
  // sits HERE because all four customer-visible posts of this gate ask it; private notes are exempt,
  // since a note after a handoff explains the silence instead of talking over anybody.
  const postPublicMessage = async (
    text: string,
    sendId?: string,
  ): Promise<boolean> => {
    // NOTE: Inside the try: a fence that cannot answer reports "not sent", or the away branch skips its
    // release and burns the day.
    try {
      // Built BEFORE the asks: resolving the persona is I/O, and no fence here allows I/O between an
      // ask and the write it guards.
      const client = await personaClient();
      if (!(await stillOurs())) {
        logger.info(
          "chatwoot: public message withheld (conv=%s) — the conversation is no longer the bot's",
          String(conversationId),
        );
        return false;
      }
      // NOTE: The operator's own silences, read at the send: the authorization round trip sits between
      // `ctx.mode` and the denial, so an agent flipped to monitoring or off meanwhile posts none of these.
      // Same fail-open as the turn's fence.
      if (
        ctx.agentId !== null &&
        !(await agentStillSpeaks(tenantId, ctx.agentId, base))
      ) {
        logger.info(
          "chatwoot: public message withheld (conv=%s) — the agent was switched off or flipped to monitoring",
          String(conversationId),
        );
        return false;
      }
      await client.sendMessage(conversationId, text, { sendId });
      return true;
    } catch (err) {
      logger.warn(
        "chatwoot: public message not sent (conv=%s): %s",
        String(conversationId),
        errMsg(err),
      );
      return false;
    }
  };

  // A command's answer must never vanish. `postPublicMessage` withholds anything the bot no
  // longer owns, which is right for the agent's own output and wrong here: on a human-held
  // conversation the ack is what explains the silence. The fallback is a PRIVATE note, not a bypass:
  // it reaches the operator without putting a bot message into a human's conversation.
  const postAcknowledgement = async (
    text: string,
    sendId?: string,
  ): Promise<void> => {
    if (await postPublicMessage(text, sendId)) return;
    await postPrivateNote(text, sendId);
  };

  // Private note (operator-only) posted as the persona bot, for the one-shot test-mode and
  // out-of-hours notices. Returns whether it left: both are stamped once per conversation, and a stamp
  // on a lost note spends the only shot. No ownership fence: a note after a handoff explains the silence.
  const postPrivateNote = async (
    text: string,
    sendId?: string,
  ): Promise<boolean> => {
    try {
      const client = await personaClient();
      await client.sendPrivateNote(conversationId, text, { sendId });
      return true;
    } catch (err) {
      logger.warn(
        "chatwoot: private note failed (conv=%s): %s",
        String(conversationId),
        errMsg(err),
      );
      return false;
    }
  };

  // The shared unit, bound to this gate's conversation, persona and fence.
  const openConversationForHumans = async (
    gate: string,
    teamId: number | null,
    teamUsable?: (id: number) => Promise<boolean>,
  ): Promise<boolean> =>
    // NOTE: Collapsed to a boolean here: this gate treats a fence that stood down and a call that threw
    // the same, a distinction only the scheduler job needs.
    (await openForHumanQueue({
      gate,
      conversationId,
      stillOurs,
      client: personaClient,
      teamId,
      teamUsable,
    })) === "opened";

  // ── Redirect cross-link: on the widget conversation's first inbound after the merge, link it to its
  //    WhatsApp sibling — propagate that side's /teste activation + post cross-link private notes, once.
  //    Runs BEFORE the test-mode gate so a propagated activation is honored on this same turn. ──
  if (
    ctx.agentId !== null &&
    ctx.agentSettings != null &&
    ctx.conv.redirectLinkedAt === null &&
    isNewIncomingMessage(n)
  ) {
    const redirectCfg = readChannelRedirectConfig(ctx.agentSettings);
    if (
      redirectCfg.enabled &&
      redirectCfg.widgetInboxId !== null &&
      ctx.inboxChatwootId === redirectCfg.widgetInboxId
    ) {
      const linked = await linkRedirectConversations({
        tenantId,
        instanceId,
        agentId: ctx.agentId,
        mode: ctx.mode,
        cfg: redirectCfg,
        widgetConv: {
          id: ctx.conv.id,
          displayId: conversationId,
          testActivatedAt: ctx.conv.testActivatedAt,
          contactId: ctx.conv.contactId,
          redirectOriginDisplayId: ctx.conv.redirectOriginDisplayId,
          chatwootRedirectOriginAt: ctx.conv.chatwootRedirectOriginAt,
        },
        base,
      });
      ctx.conv.testActivatedAt = linked.testActivatedAt;
    }
  }

  // NOTE: The EPISODE's activation, not this row's, for every gate below: a redirect episode is two
  // conversations of one person, and the propagation above runs once, one way. Resolved into the field
  // the gates already read, so it adds no second question; /teste writes a fresh stamp without reading
  // it. Free on the ordinary path (`needsEpisodeLookup` is false outside a test-mode redirect episode).
  if (ctx.agentSettings != null) {
    ctx.conv.testActivatedAt = await episodeTestActivatedAt({
      tenantId,
      instanceId,
      cfg: readChannelRedirectConfig(ctx.agentSettings),
      agentMode: ctx.mode,
      conv: {
        testActivatedAt: ctx.conv.testActivatedAt,
        contactId: ctx.conv.contactId,
        chatwootInboxId: ctx.inboxChatwootId,
      },
      base,
    });
  }

  // ── /teste: activate test mode for THIS conversation, ACK, consume. ──
  if (isTeste) {
    const activatedAt = new Date();
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.conversation.update({
        where: { id: ctx.conv.id },
        data: {
          testActivatedAt: activatedAt,
          // NOTE: Clean engagement slate at activation: a message from while the agent was silenced must not
          // leave a follow-up pending nor look complete, so both anchors clear to the "none" state, as /reset
          // does. lastInboundAt also anchors the 24h window; the next customer message re-anchors it.
          lastInboundAt: null,
          lastFollowUpAt: null,
          // NOTE: The silence fence reads the LATER of the customer's word and ours, so clearing only the
          // customer's lets the sweep recreate the episode this command ended.
          lastRepliedAt: null,
        },
      }),
    );
    // Defensive: cancel any follow-up job queued for the prior episode (normally none — a test-silenced
    // conversation is skipped by the sweep), mirroring /reset. Best-effort.
    try {
      await cancelPendingJob(
        tenantId,
        "FOLLOWUP",
        `followup:${chatwootThreadId(tenantId, instanceId, conversationId)}`,
        base,
      );
    } catch (err) {
      logger.warn(
        "chatwoot: /teste cancel follow-up failed (conv=%s): %s",
        String(conversationId),
        errMsg(err),
      );
    }
    // Activation only lifts the test-mode silence; ownership is a separate gate, so when it would
    // still refuse, the ack says so and names the fix. `stillOurs()`, not the caller's `act`, which was
    // decided for the bot whose route carried the delivery (Chatwoot also fans to the assigned bot). No
    // holder is named: a human, another persona's bot and an `open` status all land here. Only diagnosed
    // here; /reset acts on it, since silently pulling a conversation away is a bigger surprise.
    const testeBlocker = await answerBlocker();
    await postAcknowledgement(
      testeBlocker === "none"
        ? "🧪 Modo teste ativado para esta conversa."
        : testeBlocker === "ownership"
          ? "🧪 Modo teste ativado para esta conversa. Mas ela não está com este agente, então ele ainda não vai responder. Envie /reset para devolvê-la ao agente."
          : // NOTE: No command is named: /reset returns a conversation and this agent is
            // switched off, so it would be the same wrong instruction.
            "🧪 Modo teste ativado para esta conversa. Mas este agente está desativado, então ele não vai responder.",
    );
    logger.info("chatwoot: /teste activated (conv=%s)", String(conversationId));
    return true;
  }

  // ── /reset (only when test mode is ACTIVE for THIS conversation): clear the contact's agent memory +
  //    audio preference + this conversation's labels and custom attributes. Deliberately does NOT touch
  //    testActivatedAt (the conversation keeps answering). Every step is best-effort; consumed regardless.
  if (isReset && shouldRunReset(ctx.mode, ctx.conv.testActivatedAt)) {
    // NOTE: Refreshed BEFORE the start facts are read: the mirror lags Chatwoot by one webhook, and a
    // sparse payload carries no assignee, so a missed assignment would make the mirror say "ours" about a
    // human's conversation; the hand-back is skipped and /reset acks a slate the agent cannot answer in.
    // Asked again before the hand-back, since the answer decays over the I/O between.
    await refreshFromLive("the command's own decisions", null);
    // The handoff the command was asked about, captured before the cleanup. The hand-back undoes
    // only a handoff already in place when /reset was typed and still held by the SAME party; anything
    // else would steal a conversation from someone who took it later. The ASSIGNEE is compared, not the
    // status, which moves on its own (an inbound reopens a resolved conversation).
    const notOursAtStart = !(await stillOursOrUnknown());
    const holderAtStart = `${ctx.conv.assigneeType ?? ""}:${ctx.conv.assigneeId ?? ""}`;
    const heldBySameParty = async (): Promise<boolean> => {
      const now = await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.conversation.findUnique({
          where: { id: ctx.conv.id },
          select: { assigneeType: true, assigneeId: true },
        }),
      ).catch(() => null);
      // NOTE: Unreadable answers "unchanged": an unknown must not trigger the irreversible hand-back, and
      // here the START state already said "not ours", so this stands on the answer the command was given.
      if (!now) return true;
      // NOTE: Nobody is not a new holder. A holder who RELEASED the conversation leaves it `open` with no
      // assignee, the state the agent cannot answer in, and refusing would skip putting it back to
      // `pending` while the ack blamed a takeover by someone who left. Safe: the hand-back's baseline is
      // the START holder, so with nobody there it sends no unassign.
      if (now.assigneeType === null) return true;
      return (
        `${now.assigneeType ?? ""}:${now.assigneeId ?? ""}` === holderAtStart
      );
    };
    // Each cleanup gets its OWN try, so one failure never skips the rest. `failed` collects the
    // PT-BR name of what did not clear, so the confirmation stops claiming a full reset; `label` is what
    // the ack names, `what` the English log wording.
    const failed: string[] = [];
    const failedSteps: string[] = [];
    const step = async <T>(
      what: string,
      label: string,
      run: () => Promise<T>,
    ): Promise<T | null> => {
      try {
        return await run();
      } catch (err) {
        failed.push(label);
        // NOTE: The same failure in the AUDIT row's vocabulary: `label` is the coarse PT-BR customer-facing
        // bucket ("card do kanban" covers three calls); `what` names the step.
        failedSteps.push(what);
        logger.warn(
          "chatwoot: /reset %s failed (conv=%s): %s",
          what,
          String(conversationId),
          errMsg(err),
        );
        return null;
      }
    };

    // NOTE: Every step is scoped to this conversation, as memory is: a redirect episode keeps its anchors
    // and ladder per side, and widening /reset across sides is the operator's call. The retirements go
    // FIRST: retired late, a message arriving mid-cleanup arms next-episode work that gets killed (the
    // upsert re-arm keeps `created_at`, and `status: PENDING` revives any row armed after this); after
    // the anchors clear, a claimed ladder re-sets `redirectClosedAt`. Retired, not cancelled: a cancel
    // reaches PENDING rows only, and a claimed follow-up's second probe passes once the hand-back
    // returns the conversation. MEMORY_COMPACT goes with the memory step. See docs/chatwoot.md, "`/reset`
    // fences".
    await step("cancel follow-up", "follow-up pendente", () =>
      retireJobsByDedupeKey(
        tenantId,
        "FOLLOWUP",
        `followup:${chatwootThreadId(tenantId, instanceId, conversationId)}`,
        base,
      ),
    );
    await step(
      "cancel redirect follow-up",
      "follow-up de redirecionamento",
      () =>
        retireRedirectFollowUp(
          tenantId,
          chatwootThreadId(tenantId, instanceId, conversationId),
          base,
        ),
    );
    // NOTE: This conversation only, like every step (see the NOTE above).
    for (const convId of [conversationId]) {
      await step(
        "cancel appointment reminders",
        "lembretes de agendamento",
        () =>
          cancelThreadAppointments(
            tenantId,
            chatwootThreadId(tenantId, instanceId, convId),
            base,
          ),
      );
      // NOTE: A debounce flush is a queued TURN whose invoke recreates the thread this reset clears, reply
      // or not. Retired here, and the handler asks again before it invokes, since a CLAIMED flush is past
      // every cancel. NOTHING_TO_ANSWER is not retired here: the receiver retires it (best-effort) on the
      // command's own incoming message, and its handler stands down when `resetLandedAfter` its trigger.
      await step("cancel pending debounce", "mensagens em espera", () =>
        retireJobsByDedupeKey(
          tenantId,
          "DEBOUNCE",
          debounceDedupeKey(chatwootThreadId(tenantId, instanceId, convId)),
          base,
        ),
      );
      // NOTE: Text a channel refused as audio, waiting to go out again: a reply of the episode this command
      // closes, carrying words the reset forgets.
      await step("forget media fallbacks", "respostas em texto pendentes", () =>
        forgetMediaFallbacks({
          tenantId,
          instanceId,
          conversationId: convId,
          base,
        }),
      );
    }

    // IMMEDIATELY after the retirements (never before them, see above): a turn on a still-owned
    // conversation during the later Chatwoot calls would have its watermarks wiped, so adjacency narrows
    // that race to two DB writes. Not closed: /reset is not atomic with a turn, a named limit. Clears the
    // follow-up watermarks (no nudge until the customer writes again), the one-shot notices, this side's
    // redirect anchors (or the funnel cannot be tested twice) and `failureNoticeSentAt` (or a fresh
    // failure cannot announce itself). The command's message is the boundary this episode ends at.
    const commandMessageId = params.n.message?.id ?? null;
    const redirectAnchors = {
      redirectSentAt: null,
      // A counter, so it goes back to zero rather than to null.
      redirectCount: 0,
      redirectLinkedAt: null,
      redirectClosedAt: null,
    };
    await step("clear the conversation's watermarks", "marcadores", () =>
      runScopedOn(base, sysCtx(tenantId), async (db) => {
        // NOTE: The episode boundary is the COMMAND's message id in Chatwoot's order, not a moment of ours
        // (a message landing during the cleanup came after the reset) nor the ledger's, whose detached inserts
        // do not keep arrival order (../../graph/reset-episode.ts). Its own statement so it never moves
        // backwards: two detached /reset deliveries can finish out of order (`GREATEST` ignores NULL). The
        // previous reset's `reset_cleared_labels` is cleared in the same statement, since each SET reads the
        // OLD row; a stale set beside a new boundary would hide real removals from the observer.
        if (commandMessageId !== null) {
          await db.$executeRaw`
            UPDATE conversations
               SET reset_cleared_labels =
                     CASE WHEN reset_at_message_id IS NULL
                            OR ${commandMessageId} > reset_at_message_id
                          THEN NULL ELSE reset_cleared_labels END,
                   reset_at_message_id = GREATEST(reset_at_message_id, ${commandMessageId})
             WHERE id = ${ctx.conv.id}`;
        }
        return db.conversation.update({
          where: { id: ctx.conv.id },
          data: {
            lastInboundAt: null,
            lastFollowUpAt: null,
            // NOTE: The other axis of the silence fence: left standing, the sweep revives the sequence /reset
            // ended.
            lastRepliedAt: null,
            testNoticeSentAt: null,
            outOfHoursNoticeSentAt: null,
            awayMessageSentAt: null,
            ...redirectAnchors,
            lastError: null,
            lastErrorAt: null,
            failureNoticeSentAt: null,
          },
        });
      }),
    );

    // NOTE: Clear this channel's memory: the thread, the AgentThread marker (divider and ingestion
    // watermark) and the compacted past attendances. The contact's other channels keep their threads.
    if (ctx.conv.contactInboxId !== null) {
      const contactInboxId = ctx.conv.contactInboxId;
      // Filled INSIDE the transaction and drained after it: see the revoke below for why.
      const erasedDeaths: ErasedDeath[] = [];
      // NOTE: All three deletions in one step, under the `ingest:` queue that makes it exclusive with
      // ingestion, the turn, the nudge and compaction; a claimed compaction either finished or finds the
      // marker gone. Deliberately the one transaction held across the checkpointer: `clearContactMemory`
      // deletes the checkpoint last, so its failure rolls the rows back (../memory/reset.ts). An operator
      // action, so the held connection starves nothing. See docs/chatwoot.md, "`/reset` fences".
      await step("clear agent memory", "memória", () =>
        withKeyedQueue(
          `ingest:${contactInboxThreadId(tenantId, instanceId, contactInboxId)}`,
          () =>
            runScopedOn(base, sysCtx(tenantId), async (db) => {
              const graphThreadId = contactInboxThreadId(
                tenantId,
                instanceId,
                contactInboxId,
              );
              // NOTE: A turn already invoking saves what it LOADED, undoing a clear that lands mid-invoke
              // (src/graph/inflight.ts), and would restore the raw channel but not the summaries or the marker. So
              // the step refuses, and the ack names what did not clear. Asked INSIDE the lock the turn marks under,
              // so the two are exclusive. On `db` with the row lock: a helper transaction would wait for a
              // connection this one holds (`DB_POOL_MAX=1` is supported), and an unlocked read goes stale.
              if (
                await threadBusyForResetOn(db, {
                  tenantId,
                  instanceId,
                  contactInboxId,
                  graphThreadId,
                })
              ) {
                throw new Error(
                  `this thread (${graphThreadId}) is being written right now, by a turn or by an append; either would restore what this clears`,
                );
              }
              // NOTE: Queued ingestion is revoked here, inside the section, or a pending or claimed append lands
              // on release and rebuilds the cleared memory; a run already in memory re-checks (../../graph/ingest-job.ts,
              // stillWanted). On `db` for the pool reason above. Only UP TO the command's message: a customer
              // message queued behind this step came after the reset. Erased DEAD rows are returned, not announced
              // here, so a rollback cannot leave a line for a death it put back; a DEAD row above the boundary
              // survives and keeps its announcement owed.
              erasedDeaths.push(
                ...(
                  await revokeJobsByKeyPrefixOn(
                    db,
                    "INGEST_MESSAGE",
                    ingestKeyPrefix(graphThreadId),
                    commandMessageId ?? undefined,
                  )
                ).erasedDeaths,
              );
              // NOTE: The proof the memory was cleared, written in the transaction that clears it, so a refused
              // step leaves it unset and the append's fence never drops a reply against a clearing that did not
              // happen. BEFORE `clearContactMemory`: the checkpoint goes through a separate pool, so a failure of
              // a later statement would roll back the rows beside a checkpoint already gone. `GREATEST` as above.
              if (commandMessageId !== null) {
                await db.$executeRaw`
                  UPDATE conversations
                     SET memory_cleared_at_message_id =
                           GREATEST(memory_cleared_at_message_id, ${commandMessageId})
                   WHERE id = ${ctx.conv.id}`;
              }
              await clearContactMemory({
                db,
                checkpointer: await getCheckpointer(),
                tenantId,
                instanceId,
                contactInboxId,
                threadId: graphThreadId,
              });
            }),
        ),
      );
      // NOTE: The erased deaths, now that the transaction is over, unconditionally: the announcer checks
      // each deletion against the row, so a rollback suppresses the line by evidence. Guarding on `step`
      // returning null is unsound (an aborted block replies ROLLBACK to COMMIT without an error). A crash
      // before this loses the line, which beats a duplicate that cannot be retracted.
      await announceErasedDeaths(erasedDeaths, base);
      // NOTE: The compacted memory lives in its own table, and the PENDING compaction (waiting out its
      // grace window after a resolve) would write more of it, so it is cancelled too.
      await step("cancel pending compaction", "memória", () =>
        cancelPendingJob(
          tenantId,
          "MEMORY_COMPACT",
          contactInboxThreadId(tenantId, instanceId, contactInboxId),
          base,
        ),
      );
    }
    if (ctx.conv.contactId !== null) {
      const contactDbId = ctx.conv.contactId;
      await step("clear voiceReply", "preferência de áudio", () =>
        runScopedOn(base, sysCtx(tenantId), (db) =>
          db.contact.update({
            where: { id: contactDbId },
            data: { voiceReply: null },
          }),
        ),
      );
    }
    // Attributes and the kanban card are BOT-token calls, so this client carries the persona's
    // token. Building it is a step because it reads the DB and resolves DNS through the SSRF guard: a
    // throw outside the boundary would abandon the rest of the reset after the memory was wiped.
    const client = await step(
      "build the persona client",
      "etiquetas, atributos e card do kanban",
      personaClient,
    );
    if (client) {
      // NOTE: The watcher's pending verdicts, or a burst armed before the reset reads the untouched
      // transcript and writes back the labels just cleared (by prefix: the key carries the classifier).
      // Only UP TO the episode boundary: a message during the late cleanup armed a wanted burst. With no
      // boundary there is nothing to order against, and the tick's own fence stands them down.
      if (commandMessageId !== null)
        await step("cancel pending verdicts", "etiquetas", () =>
          cancelPendingJobsByPrefixUpToMessage(
            tenantId,
            "OBSERVE",
            observeKeyPrefix(
              chatwootThreadId(tenantId, instanceId, conversationId),
            ),
            commandMessageId,
            base,
          ),
        );
      await step("clear labels", "etiquetas", () =>
        // NOTE: In the conversation's label queue, so a clear never lands inside another read-modify-write.
        withConversationLabels(params.tenantId, conversationId, async () => {
          // What this clear removes, read inside the queue so it is the set this write replaces; the
          // observer uses it to tell the reset's own removal line from history. Best-effort: naming the labels
          // is bookkeeping, and a failed read must not abort the clear. NULL falls back to the order cut.
          let before: string[] | null = null;
          try {
            before = await client.getConversationLabels(conversationId);
          } catch (err) {
            logger.warn(
              "chatwoot: /reset could not read the labels it is about to clear (conv=%s): %s",
              String(conversationId),
              errMsg(err),
            );
          }
          // NOTE: As the ADMIN: /reset is a person peeling the episode's labels off, not the persona deciding,
          // and the activity line says so.
          await client.setConversationLabels(conversationId, [], {
            asAdmin: true,
          });
          // NOTE: Written only after the clear returns, and only by the reset that still OWNS the boundary. A
          // clear that threw leaves the labels standing, so naming them would hide live state from the
          // observer; a lost response leaves NULL and the removal line shows, the direction this fails in on
          // purpose. The `WHERE` fences an older /reset finishing last from pairing its set with a newer boundary.
          if (before !== null)
            await runScopedOn(
              base,
              sysCtx(tenantId),
              (db) =>
                db.$executeRaw`
                UPDATE conversations
                   SET reset_cleared_labels = ${JSON.stringify(before)}::jsonb
                 WHERE id = ${ctx.conv.id}
                   AND reset_at_message_id = ${commandMessageId}`,
            );
        }),
      );
      await step("clear custom attributes", "atributos", () =>
        client.clearConversationCustomAttributes(conversationId),
      );
      // The linked kanban card's scheduled dates and its ATTRIBUTES go too (`set_custom_attribute`
      // writes three scopes, and the agent would keep facts from the wiped memory); title, description
      // and step stay. Separate steps because the endpoints are independent. No card, no step.
      const taskId = await step(
        "resolve the kanban card",
        "card do kanban",
        () => client.kanbanTaskIdForConversation(conversationId),
      );
      if (taskId != null) {
        await step("clear kanban card dates", "card do kanban", () =>
          client.updateKanbanTask(taskId, { startDate: null, dueDate: null }),
        );
        await step("clear kanban card attributes", "card do kanban", () =>
          client.clearKanbanTaskCustomAttributes(taskId),
        );
      }
    }
    // NOTE: The contact's Chatwoot attributes are deliberately NOT cleared (the ack promises THIS
    // CONVERSATION's): they are shared account-wide and nothing records who wrote one, so deleting them
    // could destroy an operator's CRM field, irreversibly. `voiceReply` is ours alone, so it is cleared.
    // Before the hand-back, the mirror is refreshed: it lags Chatwoot by a webhook, and a human who took
    // over during the cleanup would let `heldBySameParty` compare a stale holder against itself. A
    // refresh, not a side read, so every fence below reads the same row; best-effort and logged.
    if (notOursAtStart) await refreshFromLive("the hand-back", client);
    const resetBlocker = await answerBlocker();
    // `undefined` = never attempted, a third answer the acknowledgement reports differently from
    // a hand-back that ran.
    let handBack: ReturnToAgentOutcome | null | undefined;
    // A turn from before the reset still running: the takeover is what keeps its stale reply quiet,
    // and a hand-back writes exactly the state its ownership recheck accepts (`pending`, no assignee), so
    // it would post over the human. The direct turn has the episode fence (../../graph/reset-episode.ts)
    // and a flush is retired; a follow-up nudge has neither. Standing down leaves the conversation as
    // found and /reset can be retried. BOTH markers: the conversation key is claimed first and covers a
    // null contact inbox; the graph key later, and it is the only one a nudge claims (../../graph/nudge.ts).
    const graphKey = resolveGraphThreadId(
      tenantId,
      instanceId,
      conversationId,
      ctx.conv.contactInboxId,
    );
    // The graph half asks the ROW when there is one, since a turn on another replica is invisible
    // to this process's registry. With a null contact inbox there is no row, and the in-process answer
    // is what the conversation key has anyway.
    const turnStillRunning =
      isTurnInFlight(chatwootThreadId(tenantId, instanceId, conversationId)) ||
      (ctx.conv.contactInboxId != null
        ? await turnOwnsThread(
            {
              tenantId,
              instanceId,
              contactInboxId: ctx.conv.contactInboxId,
              graphThreadId: graphKey,
            },
            base,
          )
        : isTurnInFlight(graphKey));
    // NOTE: The hand-back runs LAST: ownership is also what makes the next delivery actionable, so
    // returned first, a message during the cleanup would start a turn on the half-erased episode. It
    // undoes the test loop's handoff (without it only the console could), asked via `stillOurs()` from a
    // fresh read, skipped when already ours, and only for OWNERSHIP: a disabled agent would take the
    // human off a conversation nothing answers. `returnConversationToAgent` owns the call ORDER.
    if (
      notOursAtStart &&
      resetBlocker === "ownership" &&
      !turnStillRunning &&
      (await heldBySameParty())
    ) {
      handBack = await step(
        "return the conversation to the agent",
        "atribuição",
        () =>
          returnConversationToAgent(sysCtx(tenantId), ctx.conv.id, {}, base, {
            // NOTE: The holder the guards above agreed on, passed in: a re-read would answer about a later
            // moment, and somebody arriving in between would be unassigned.
            assigneeType: ctx.conv.assigneeType,
            assigneeId: ctx.conv.assigneeId,
          }),
      );
    }
    // Best-effort is the design; announcing a full reset after a partial one is not. The operator
    // typed /reset to get a clean slate, and acting on a conversation that is not clean is worse than
    // knowing what survived.
    const distinctFailed = [...new Set(failed)];
    // Say why the agent will not answer, from the state at the END (ownership has several ways to
    // change during the cleanup), only when the hand-back was actually withheld. Being SWITCHED OFF is a
    // separate reason, not a variety of ownership: a disabled agent that owns the conversation would
    // otherwise read as a clean reset.
    const leftWithSomebodyElse = !(await stillOursOrUnknown());
    const heldBack =
      resetBlocker === "disabled"
        ? leftWithSomebodyElse
          ? " Este agente está desativado, então ele não vai responder e a conversa continua com quem a atendia."
          : " Este agente está desativado, então ele não vai responder."
        : !leftWithSomebodyElse
          ? ""
          : turnStillRunning
            ? // NOTE: Never attempted, for a reason the operator can act on: the
              // conversation is with the same person, and the hand-back is a retry away.
              " Uma resposta anterior ao reset ainda está sendo gerada, então a conversa continua com quem a atendia. Digite /reset de novo quando ela terminar."
            : handBack === null
              ? // NOTE: Attempted and threw. `failed` already names the assignment,
                // and explaining it twice reads as two problems.
                ""
              : " Alguém assumiu a conversa durante o reset, então ela continua com essa pessoa.";
    await postAcknowledgement(
      distinctFailed.length === 0
        ? `🔄 Memória, preferência de áudio e etiquetas/atributos desta conversa foram limpos.${heldBack}`
        : `⚠️ Reset parcial: não consegui limpar ${distinctFailed.join(", ")}. O restante foi limpo.${heldBack}`,
      // NOTE: Named, because this row marks where the command's cleanup ends (constants.ts).
      commandMessageId === null ? undefined : resetAckSendId(commandMessageId),
    );
    logger.info(
      "chatwoot: /reset (conv=%s failed=%s)",
      String(conversationId),
      distinctFailed.length === 0 ? "none" : distinctFailed.join("|"),
    );
    // NOTE: The one record that an episode was erased. The hand-back records its own row, and without this
    // one the trail shows a return to the agent and nothing about the irreversible wipe. Written even for
    // a partial reset, naming the failed steps: the ack answering "what survived" can be deleted.
    await recordConversationAction(sysCtx(tenantId), base, ctx.conv.id, {
      action: "conversation.reset",
      after: {
        complete: distinctFailed.length === 0,
        failed: [...new Set(failedSteps)],
        // NOTE: Three outcomes, spelled, since two are absences: `undefined` (not attempted) and `null`
        // (threw). Raw, Prisma drops an undefined property on the way into jsonb.
        handBack:
          handBack === undefined
            ? "not-attempted"
            : handBack === null
              ? "failed"
              : handBack,
      },
    });
    return true;
  }
  // NOTE: A /reset before /teste must not wipe memory and must NOT return: returning false would let
  // the caller run the turn and answer pre-activation. Fall through to the test-mode gate below.
  if (isReset) {
    logger.info(
      "chatwoot: /reset with test mode not active — deferring to the test-mode gate (conv=%s)",
      String(conversationId),
    );
  }

  // Contact authorization (docs/contact-auth.md), in two stages that this function asks at two
  // positions. The identity is what Chatwoot mirrored, never customer text (under POST with
  // includeMessageText the text rides in `message`, for unlock codes). EVERY message is re-checked.
  // Denied: the operator's copy plus a handoff; cannot-tell: fail-closed silence plus a private note.
  // Copy and note sit behind a cooldown (noticeCooldownSeconds), the verdict never does. Built once
  // here, so both positions act on a verdict through the same code.
  const contactAuth = (() => {
    if (ctx.agentId === null || !ctx.agentEnabled || !isNewIncomingMessage(n)) {
      return null;
    }
    const authCfg = readContactAuthConfig(ctx.agentSettings);
    if (!authCfg.enabled) return null;
    const agentId = ctx.agentId;
    // Opens the conversation for the human queue (status `open` ends the bot's attribution; the
    // team routes it); an assignment failure never undoes the open. A Chatwoot team id belongs to ONE
    // account, and a value can arrive via REST, MCP, import or an agent moved between accounts, so the
    // account recorded with it decides; counting accounts is only the fallback for an older value.
    const teamTargetUsable = async (teamId: number): Promise<boolean> => {
      const pinnedTo = authCfg.handoffTeamInstanceId;
      if (pinnedTo !== null) {
        if (pinnedTo === Number(instanceId)) return true;
        logger.warn(
          "chatwoot: contact-auth team target ignored (conv=%s team=%s) — it was picked in Chatwoot account %s and this conversation is in %s",
          String(conversationId),
          String(teamId),
          String(pinnedTo),
          String(instanceId),
        );
        return false;
      }
      const instances = await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.inbox.findMany({
          where: { agentId },
          select: { chatwootInstanceId: true },
          distinct: ["chatwootInstanceId"],
        }),
      );
      if (instances.length <= 1) return true;
      logger.warn(
        "chatwoot: contact-auth team target ignored (conv=%s team=%s) — the agent serves %s Chatwoot accounts and a team id belongs to one",
        String(conversationId),
        String(teamId),
        String(instances.length),
      );
      return false;
    };

    const openForHumans = (teamId: number | null): Promise<boolean> =>
      openConversationForHumans("contact-auth", teamId, teamTargetUsable);
    const ask = (stage: ContactAuthStage) =>
      authorizeContact({
        tenantId,
        agentId,
        contactDbId: ctx.conv.contactId,
        conversationDbId: ctx.conv.id,
        conversationId,
        inboxId: ctx.inboxChatwootId,
        channelType: ctx.channelType,
        messageText: n.message?.content ?? null,
        // The message id under an unlock flow, where the verdict is a function of the text; the
        // source otherwise. Never the text itself: it must not reach a cache key.
        requestKey: authCfg.includeMessageText
          ? `msg:${n.message?.id ?? "none"}`
          : "inbox",
        stage,
        cfg: authCfg,
        base,
        fetchImpl: deps?.contactAuthFetch,
      });
    // Acts on a FINAL verdict: true = the delivery is consumed (refused, or the conversation left the
    // bot while asking), false = the turn goes on. `silencedByTestMode`: a refusal in a conversation
    // the test-mode gate would have kept quiet is only recorded (see the rule stage below).
    const settle = async (
      verdict: ContactAuthResult,
      silencedByTestMode = false,
    ): Promise<boolean> => {
      const line = contactAuthFlowEvent(verdict);
      emitFlowEvent(
        {
          tenantId,
          turnId: crypto.randomUUID(),
          source: "inbox",
          conversationId: ctx.conv.id,
          agentId,
          inboxId: ctx.conv.inboxId,
          threadId: chatwootThreadId(tenantId, instanceId, conversationId),
          base,
        },
        silencedByTestMode
          ? { ...line, detail: { ...line.detail, silencedBy: "test_mode" } }
          : line,
      );
      params.onAuthVerdict?.(verdict.outcome === "allowed");
      if (verdict.outcome === "allowed" && n.message?.id != null) {
        rememberMediaAdmission(
          mediaAdmissionKey(tenantId, instanceId, n.message.id),
        );
      }
      if (verdict.outcome !== "allowed") {
        await recordMediaRefusal(tenantId, ctx.conv.id, n.message?.id, base);
        if (silencedByTestMode) {
          logger.info(
            "chatwoot: contact-auth refusal silenced by test mode (conv=%s outcome=%s)",
            String(conversationId),
            verdict.outcome,
          );
          return true;
        }
        // NOTE: Coalescing the QUESTION is not coalescing the consequences: the single-flight asks once per
        // contact, but copy, handoff and note belong to a CONVERSATION, and one contact can have two; the
        // per-conversation notice claim below stops a double. Order: copy (after the open the fence would
        // withhold it), handoff, note (so it says what happened). An ERROR hands nothing off: it is
        // transient by contract, and escalating every blip would page humans the next message answers.
        {
          const cooldownMs = authCfg.noticeCooldownSeconds * 1000;
          const claim = (notice: ContactAuthNotice) =>
            claimContactAuthNotice(
              contactAuthNoticeKey(tenantId, agentId, ctx.conv.id, notice),
              cooldownMs,
            );
          // The copy's window is claimed only when a copy goes out: a shared claim let an ERROR, which
          // speaks to nobody, silence the denial after it.
          const denyMessage =
            verdict.outcome === "denied" ? authCfg.denyMessage : null;
          const copyClaim = denyMessage ? claim("copy") : false;
          // Tracked so the operator note can say what the CUSTOMER actually got, instead of
          // claiming silence on top of a refusal that was just delivered.
          let copyOutcome: ContactAuthCopyOutcome = denyMessage
            ? copyClaim
              ? "failed"
              : "suppressed"
            : "none";
          if (denyMessage && copyClaim) {
            // NOTE: Claimed before the send so two racing deliveries do not both speak, so a send that did not
            // land gives the window back instead of silencing the next refusal.
            if (await postPublicMessage(denyMessage)) {
              copyOutcome = "sent";
            } else {
              releaseContactAuthNotice(copyClaim);
            }
          }
          let handedOff = false;
          if (verdict.outcome !== "error" && authCfg.handoffEnabled) {
            // NOTE: Outside the cooldown on purpose: the open is what ends the bot's
            // attribution, and a first attempt that failed must be retried on the next refused
            // message, notice or no notice.
            handedOff = await openForHumans(authCfg.handoffTeamId);
          }
          // A DENIAL's note is the operator's to switch off (`operatorNoteEnabled`), for a gate
          // used as a scope filter. An error and an unidentified contact always write theirs: those are
          // things to fix, and the note is where the operator learns of them.
          const noteClaim =
            verdict.outcome === "denied" && !authCfg.operatorNoteEnabled
              ? false
              : claim("note");
          if (noteClaim) {
            if (
              !(await postPrivateNote(
                contactAuthNoteText(verdict, handedOff, copyOutcome),
              ))
            ) {
              releaseContactAuthNotice(noteClaim);
            }
          }
        }
        logger.info(
          "chatwoot: contact-auth silent (conv=%s outcome=%s shared=%s)",
          String(conversationId),
          verdict.outcome,
          String(verdict.shared),
        );
        return true;
      }
      // Allowed, but up to ten seconds went by inside someone else's endpoint, and `runAgentTurn`
      // re-checks ownership only after the model answers (withholding the reply, not the tools). A human
      // who took over meanwhile would find the agent's tools writing on the conversation. This does not
      // fence the turn's own window, only avoids widening it by the operator's network call.
      const now = await ownershipNow();
      if (!now.ours) {
        // NOTE: The same exit as the gate on the way in, so it leaves the same line: the one `stillOurs`
        // caller where a message that WOULD have been answered stops being answered.
        if (now.closed !== null) {
          emitFlowEvent(
            {
              tenantId,
              turnId: crypto.randomUUID(),
              source: "inbox",
              conversationId: ctx.conv.id,
              agentId,
              base,
            },
            { stage: "handoff", status: "ok", detail: now.closed },
          );
        }
        logger.info(
          "chatwoot: contact-auth allowed but the conversation is no longer the bot's (conv=%s reason=%s)",
          String(conversationId),
          now.closed?.outcome ?? "identity_unresolved",
        );
        return true;
      }
      // Allowed, and still ours: the facts the endpoint volunteered travel to the turn below.
      params.onAuthContext(verdict.context ?? null);
      return false;
    };
    return { cfg: authCfg, ask, settle };
  })();

  // NOTE: Contact authorization, RULE stage: free, so ahead of every gate that answers the customer
  // (the test-mode notice, the WhatsApp redirect, availability, the spend ceiling); after the commands
  // and the redirect cross-link, the operator's tooling. A test agent still must not speak to a real
  // lead: where the test-mode gate would keep quiet (not activated with /teste) a refusal is only
  // recorded, with no copy, handoff, note or test notice; an activated one is the operator testing the
  // gate. An allow is final only with no endpoint stage, which otherwise has the last word below.
  if (contactAuth && contactAuthHasRuleStage(contactAuth.cfg)) {
    const verdict = await contactAuth.ask("rule");
    if (
      verdict.outcome !== "allowed" ||
      !contactAuthHasEndpointStage(contactAuth.cfg)
    ) {
      const testModeSilent =
        verdict.outcome !== "allowed" &&
        ctx.mode === "test" &&
        ctx.conv.testActivatedAt === null;
      if (await contactAuth.settle(verdict, testModeSilent)) return true;
    }
  }

  // ── Test-mode gate: a "test" agent stays silent until the conversation is activated with /teste. ──
  if (ctx.mode === "test" && ctx.conv.testActivatedAt === null) {
    // One-shot private note (operator-only) so whoever watches the inbox knows WHY the bot is quiet
    // and how to activate it. Anti-spam: posted once per conversation (testNoticeSentAt watermark).
    const noticeBlocker = await answerBlocker();
    if (
      ctx.conv.testNoticeSentAt === null &&
      (await postPrivateNote(
        noticeBlocker === "none"
          ? "🧪 Este agente está em modo teste. Ele não responde automaticamente nesta conversa. Envie /teste para ativar as respostas aqui."
          : noticeBlocker === "ownership"
            ? // NOTE: /reset needs `testActivatedAt`, so pointing at it alone is a no-op
              // path the one-shot watermark then locks in: both commands, in working order.
              "🧪 Este agente está em modo teste e esta conversa não está com ele, então ele não vai responder. Envie /teste para ativar as respostas aqui e, em seguida, /reset para devolver a conversa ao agente."
            : "🧪 Este agente está desativado, então ele não vai responder nesta conversa.",
      ))
    ) {
      try {
        await runScopedOn(base, sysCtx(tenantId), (db) =>
          db.conversation.update({
            where: { id: ctx.conv.id },
            data: { testNoticeSentAt: new Date() },
          }),
        );
      } catch (err) {
        logger.warn(
          "chatwoot: test-notice flag write failed (conv=%s): %s",
          String(conversationId),
          errMsg(err),
        );
      }
    }
    logger.info(
      "chatwoot: test-mode silent (conv=%s) — awaiting /teste",
      String(conversationId),
    );
    return true;
  }

  // ── WhatsApp→chat redirect gate: on the designated entry inbox this agent NEVER runs the AI — it
  //    replies with the fixed (no-AI) link to the web chat (one-shot + resend cooldown) and consumes.
  //    Placed AFTER the test-mode gate (a test agent must not auto-redirect real leads) and BEFORE the
  //    availability gate (redirecting is fine 24/7; the widget conversation applies its own business
  //    hours). A "misconfigured" outcome (redirect enabled but provisioning incomplete) falls through so
  //    the lead is still served on WhatsApp rather than dead-ended. ──
  if (ctx.inboxChatwootId !== null && ctx.agentSettings != null) {
    const redirectCfg = readChannelRedirectConfig(ctx.agentSettings);
    if (isRedirectEntryInbox(redirectCfg, ctx.inboxChatwootId)) {
      const outcome = await runRedirectGate({
        tenantId,
        instanceId,
        conversationId,
        conv: {
          id: ctx.conv.id,
          contactId: ctx.conv.contactId,
          redirectSentAt: ctx.conv.redirectSentAt,
          redirectCount: ctx.conv.redirectCount,
        },
        cfg: redirectCfg,
        clonedMessage: n.message?.content ?? null,
        now: new Date(),
        base,
        send: postPublicMessage,
      });
      if (outcome !== "misconfigured") return true;
    }
  }

  // ── Availability gate: the agent's business hours (the "Disponibilidade" schedule) gate REACTIVE
  //    replies. Outside the configured window the agent stays silent, the operator gets a one-shot
  //    private note (same anti-spam watermark as the test-mode notice), and the CUSTOMER gets the
  //    agent's away message when one is configured. Empty/no schedule = always on. ──
  const now = new Date();
  const availability = outOfHoursGate(
    ctx.hours,
    now,
    ctx.conv.outOfHoursNoticeSentAt !== null,
  );
  if (availability.silence) {
    // The CUSTOMER-facing half, on its own watermark and cadence. A DISABLED agent still tells the
    // operator why it is quiet, but says nothing to the customer (the runtime refuses to run it).
    const awayCfg = readAvailabilityConfig(ctx.agentSettings);
    const away =
      ctx.agentEnabled &&
      ctx.hours &&
      awayMessageDue(ctx.hours, now, ctx.conv.awayMessageSentAt)
        ? renderAwayMessage({
            enabled: awayCfg.enabled,
            copy: awayCfg.awayMessage,
            schedule: ctx.hours,
            now,
          })
        : ({ send: false, reason: "disabled" } as const);
    if (!away.send && away.reason === "no_next_open") {
      logger.warn(
        "chatwoot: away message not sent (conv=%s) — it interpolates the next opening and the schedule never opens within %d days",
        String(conversationId),
        NEXT_OPEN_SCAN_DAYS,
      );
    }
    if (away.send) {
      const previous = ctx.conv.awayMessageSentAt;
      const claimed = await claimAwayMessage({
        tenantId,
        conversationId: ctx.conv.id,
        previous,
        now,
        base,
      }).catch((err) => {
        logger.warn(
          "chatwoot: away-message claim failed (conv=%s): %s",
          String(conversationId),
          errMsg(err),
        );
        return false;
      });
      if (claimed && !(await postPublicMessage(away.text))) {
        await releaseAwayMessage({
          tenantId,
          conversationId: ctx.conv.id,
          previous,
          claimed: now,
          base,
        });
      }
    }
    // ── The operator note, unchanged: one shot per conversation, stamped after it is posted. ──
    if (
      availability.postNote &&
      (await postPrivateNote(
        "🌙 Mensagem recebida fora do horário de atendimento. O agente não respondeu automaticamente; ele volta a responder no próximo horário disponível.",
      ))
    ) {
      try {
        await runScopedOn(base, sysCtx(tenantId), (db) =>
          db.conversation.update({
            where: { id: ctx.conv.id },
            data: { outOfHoursNoticeSentAt: now },
          }),
        );
      } catch (err) {
        logger.warn(
          "chatwoot: out-of-hours notice flag write failed (conv=%s): %s",
          String(conversationId),
          errMsg(err),
        );
      }
    }
    logger.info(
      "chatwoot: out-of-hours silent (conv=%s)",
      String(conversationId),
    );
    return true;
  }

  // NOTE: Spend ceiling, the tenant's monthly USD budget for the inbox. BEFORE the authorization gate:
  // past it no turn runs, so asking another's endpoint about the contact would be a wasted call, and
  // this is the cheapest gate (local reads only: the ceiling config and the polled spend snapshot,
  // `readSpendSnapshot`). Over the ceiling: the operator's sentence, a handoff and a private note, in
  // an order the spend-ceiling module owns because the debounce flush owes the same three; this caller
  // supplies the fenced primitives above.
  if (ctx.agentId !== null && ctx.agentEnabled && isNewIncomingMessage(n)) {
    const ceiling = await spendCeilingVerdict({
      tenantId,
      source: "inbox",
      base,
    });
    // NOTE: Already answered, so nothing to refuse or report. Two routes read the ledger at different
    // instants, and the first may commit the usage that puts the tenant over. The ANSWERED FLOOR is
    // max(watermark, reply claim), and the claim matters: the post gate takes it right before the send,
    // the watermark only after the turn. Read only on `over`, before the announcement. The narrow window
    // between the other route's usage write and its claim is left to the claim's CAS.
    if (ceiling.state === "over") {
      const handled = await readAnsweredFloor({
        tenantId,
        conversationDbId: ctx.conv.id,
        base,
      });
      const messageId = n.message?.id ?? null;
      if (messageId !== null && handled !== null && handled >= messageId) {
        logger.info(
          "chatwoot: spend ceiling reached (conv=%s) — message %s was already answered, so nothing is said",
          String(conversationId),
          String(messageId),
        );
        return true;
      }
      // NOTE: Nothing to answer, nothing to refuse: a message that renders to nothing makes `runAgentTurn`
      // return `skipped` before any billed call, so refusing would send the sentence, queue a human and
      // log an `error` about a message no model would see. Asked with `incomingRenderable`, like the turn.
      if (!renderInboundMessage(incomingRenderable(n))) {
        logger.info(
          "chatwoot: spend ceiling reached (conv=%s) — but the message renders to nothing, so there is no turn to refuse",
          String(conversationId),
        );
        return false;
      }
      // The agent must be RUNNABLE for the budget to be what stopped it: `loadAgentConfig` also
      // returns null for a deleted agent or an unresolvable `credentialRef`. Asked of the turn's own
      // function, only here; `skipExperiment` so the probe enrols no A/B variant. An unreadable probe does
      // not open the escape hatch: the ceiling was read as `over`, and running would SPEND past it.
      const probe = await runScopedOn(base, sysCtx(tenantId), (db) =>
        loadAgentConfig(
          db,
          {
            tenantId,
            instanceId,
            conversationId,
            agentId: ctx.agentId as bigint,
            threadId: chatwootThreadId(tenantId, instanceId, conversationId),
          },
          { skipExperiment: true },
        ),
      ).then(
        (cfg) => ({ read: true as const, cfg }),
        (err) => {
          logger.warn(
            "chatwoot: could not read whether the agent is runnable (conv=%s): %s — the ceiling stands",
            String(conversationId),
            err instanceof Error ? err.message : String(err),
          );
          return { read: false as const, cfg: null };
        },
      );
      if (probe.read && !probe.cfg) {
        logger.info(
          "chatwoot: spend ceiling reached (conv=%s) — but the agent is not runnable, so the silence is not the budget's",
          String(conversationId),
        );
        return false;
      }
    }
    announceSpendCeiling(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: ctx.conv.id,
        agentId: ctx.agentId,
        inboxId: ctx.conv.inboxId,
        threadId: chatwootThreadId(tenantId, instanceId, conversationId),
        base,
      },
      ceiling,
      "inbox",
      tenantId,
      // NOTE: One refused message, one line: Chatwoot fans a message to the assigned bot and the inbox's,
      // two concurrent deliveries, so an unkeyed announcement doubles the Logs row and the alert. Keyed by
      // the message, so nothing about a DIFFERENT message is swallowed, and by the INSTANCE, because
      // Chatwoot message ids are account-local and two instances can number two messages the same.
      n.message?.id == null
        ? undefined
        : {
            key: `message:${instanceId}:${n.message.id}`,
            windowMs: SPEND_CEILING_MESSAGE_WINDOW_MS,
          },
    );
    if (ceiling.state === "over") {
      await announceSpendCeilingOnConversation({
        tenantId,
        conversationRowId: ctx.conv.id,
        // NOTE: Two deliveries of one message coalesce, two messages do not. Without an id the delivery
        // names itself: saying it twice beats not saying it.
        occasion: `message:${n.message?.id ?? crypto.randomUUID()}`,
        cfg: ceiling.cfg,
        verdict: ceiling,
        postPublicMessage,
        postPrivateNote,
        handoff: () => openConversationForHumans("spend-ceiling", null),
      });
      logger.info(
        "chatwoot: spend ceiling reached (conv=%s used=%s ceiling=%s) — the turn did not run",
        String(conversationId),
        String(ceiling.usedUsd),
        String(ceiling.ceilingUsd),
      );
      return true;
    }
  }

  // NOTE: Contact authorization, ENDPOINT stage, last on purpose so a conversation an earlier gate
  // silenced costs no call. With no rule this is the whole gate (and `not_configured` when there is no
  // endpoint either); after a rule it decides what the rule allowed.
  if (contactAuth && contactAuthHasEndpointStage(contactAuth.cfg)) {
    return contactAuth.settle(await contactAuth.ask("endpoint"));
  }
  return false;
}

export async function processChatwootDelivery(
  params: ProcessChatwootParams,
): Promise<"processed" | "skipped"> {
  const base = params.base ?? basePrisma;

  // Resolved BEFORE the claim, so the route's ROLE is written by the claim itself. A separate
  // update after it could fail in a detached task after the 200, leaving a row with no role that the
  // sweep moves to DEAD and the recovery refuses, losing the observed message; a PROCESSING row has
  // always said what it is. The reads cost a losing duplicate too, which is the rare case.
  const n = params.normalized;

  // Only message_created drives commands, debounce and the agent turn. A message_updated can still
  // carry an audio attachment that was absent at creation time; it is eligible for STT only.
  const isNewIncoming = isNewIncomingMessage(n);
  const hasLateMedia = hasPendingInboundMediaUpdate(n);

  // A human agent's reply is folded into memory too and ends the agent's attendance (the
  // takeover below), both decided by the inbox's agent; both routes a person answers by, see
  // isDeviceAttendantMessage. The SUPERSET, because the device leg reads the provider off the very
  // row this flag decides whether to read.
  const mayBeHumanReply = mayBeNewHumanReply(n);

  // Resolve the bound agent for a new message (either side), a late-media update, or the
  // write-back update carrying a transcription, which never drives a turn. A non-null `rt` on new
  // event classes can wake unreachable code, so every reader was checked: commands, eager media,
  // debounce, follow-up cancel and redirect arm all need `isNewIncoming` (or `hasLateMedia`); the
  // takeover needs a human reply; what is left is the ingestion, which `armIngest` dedupes by
  // (thread, message). The wire's answer is right here; later readers re-ask (`carriesTranscription`).
  const transcriptionOnTheWire = inboundTranscriptionOnUpdate(n) !== null;
  const wantsRuntime =
    isNewIncoming || hasLateMedia || mayBeHumanReply || transcriptionOnTheWire;
  // RETRIED, because this pair runs BEFORE the claim: a transient error rejects with the row
  // PENDING and its role unsaid, after Chatwoot's retry was spent on the ack, and the recovery refuses
  // an unstated role on a non-responder route. Same attempts, backoff and injected sleep as the ingest arm.
  const resolveRoute = async () => {
    const responder = wantsRuntime
      ? n.inboxId != null
        ? await inboxAgentRuntime(
            params.tenantId,
            params.instanceId,
            n.inboxId,
            base,
          )
        : await conversationInboxRuntime(
            params.tenantId,
            params.instanceId,
            n.conversationId,
            base,
          )
      : null;
    // The route's own agent when it OBSERVES this inbox: the runtime is the observer's, and the
    // responder is reached by its own delivery. A sparse payload resolves through the stored inbox.
    const watcher = wantsRuntime
      ? await observerRuntimeForRoute(
          params.tenantId,
          params.instanceId,
          params.agentBotId,
          {
            chatwootInboxId: n.inboxId,
            chatwootConversationId: n.conversationId,
          },
          // `undefined` is a payload that says NOTHING about the assignee (a degraded event with no
          // meta); `null` is an explicit unassignment, which is an answer and must not be replaced
          // by a mirror that has not caught up with it.
          n.assigneeType === undefined && n.assigneeId === undefined
            ? null
            : { type: n.assigneeType, id: n.assigneeId },
          params.routeObserved === true,
          base,
        )
      : null;
    // The generation this resolution read: free when either runtime answered (same row), paid only
    // when neither did, the one reading window 1 is about.
    const generation = wantsRuntime
      ? ((watcher ?? responder)?.bindingGeneration ??
        (await inboxBindingGenerationAt(
          params.tenantId,
          params.instanceId,
          {
            chatwootInboxId: n.inboxId ?? null,
            chatwootConversationId: n.conversationId,
          },
          base,
        )))
      : null;
    return { responder, watcher, generation };
  };
  const routeSleep =
    params.deps?.sleep ??
    ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let resolved: Awaited<ReturnType<typeof resolveRoute>> | null = null;
  for (let attempt = 1; attempt <= INGEST_ARM_ATTEMPTS; attempt++) {
    try {
      resolved = await resolveRoute();
      break;
    } catch (err) {
      logger.warn(
        "chatwoot: route resolution attempt %d/%d failed (conv=%s): %s",
        attempt,
        INGEST_ARM_ATTEMPTS,
        n.conversationId === null ? "?" : String(n.conversationId),
        errMsg(err),
      );
      // Spent: the row stays PENDING with no role, which is what the sweep reports. Rethrown rather
      // than swallowed, so the failure is the delivery's and not a runtime silently read as absent.
      if (attempt === INGEST_ARM_ATTEMPTS) throw err;
      await routeSleep(INGEST_ARM_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  const responderRt = resolved?.responder ?? null;
  const observer = resolved?.watcher ?? null;
  const rt = observer ?? responderRt;
  // Whether the watcher answer came from the attach window rather than a row. Only that answer
  // can: "no row" on the binding read is also the post-detach state of a bot owning an old conversation.
  const observerAttaching = observer?.attaching === true;
  // On an observer's route, the inbox's watchers (`inboxWatchers`), for the memory owner. Read once,
  // and only by a reader that runs.
  let watchersMemo: ReturnType<typeof inboxWatchers> | null = null;
  const watchers = (): ReturnType<typeof inboxWatchers> => {
    if (observer === null) return Promise.resolve(null);
    watchersMemo ??= inboxWatchers(params.tenantId, observer.inboxId, base);
    return watchersMemo;
  };

  // tx1: CAS <claimFrom> to PROCESSING; a duplicate that finds nothing to claim skips. Stamped
  // with `claimed_at`, the clock the sweep measures an attempt by. "PENDING" is a delivery arriving;
  // "DEAD" is a recovery, whose running turn outranks the sweep's inferred verdict. ONE CAS rather
  // than reclaim-then-claim, so a death between two statements cannot strand a PROCESSING row; a
  // second recovery matches nothing. `attempts` counts recoveries only. See docs/chatwoot.md,
  // "Webhook receiver".
  const claimFrom = params.claimFrom ?? "PENDING";
  // NOTE: A recorded observer role is never downgraded by its own replay: a bot reprovisioned or
  // deleted after the recovery validated it leaves `observer` null, and restating the role would write
  // `false`, let the responder path settle the row PROCESSED and lose the observed message. So the
  // replay does not run; the row stays DEAD with its role until `ensureAgentBot` re-provisions the
  // persona. `warn`, not `error`: the bot may have been deleted on purpose.
  if (params.routeObserved === true && observer === null) {
    logger.warn(
      "chatwoot: a stranded observer delivery names a route that resolves no observer runtime any more (conv=%s, bot=%s); left DEAD rather than replayed as the responder",
      n.conversationId === null ? "?" : String(n.conversationId),
      params.agentBotId === null ? "?" : String(params.agentBotId),
    );
    return "skipped";
  }
  // What this route does with a message it does not answer, resolved here so the claim states
  // it. A responder's route folds it in while switched on and ingesting continuously; an observer's
  // only beside a responder of ours (the thread's only reader is a responder's turn; the observer
  // reads Chatwoot). A row-backed observer decides this whatever its mode; only its switch is asked.
  // Reused by `routeIngests` below, so what the delivery RECORDS and what it DOES cannot drift.
  const routeRemembers =
    rt === null
      ? false
      : rt.enabled &&
        (observer !== null
          ? responderRt !== null
          : ingestsContinuously(rt.mode));
  // Window 1: the binding moved between receipt and this resolution, and the new reading
  // resolves NO runtime, so claiming would settle PROCESSED having looked at nothing. The row's receipt
  // generation makes this exact. Refuse instead of re-resolving (both readings are about now): the row
  // stays PENDING for the sweep (./stranded-delivery.ts), whose recovery re-asks every gate. Not on a
  // replay, which would only spend attempts. See docs/chatwoot.md, "Observer binding".
  const receiptGeneration = params.receiptBindingGeneration ?? null;
  const resolvedGeneration = resolved?.generation ?? null;
  if (
    claimFrom === "PENDING" &&
    wantsRuntime &&
    rt === null &&
    params.agentBotId !== null &&
    receiptGeneration !== null &&
    resolvedGeneration !== null &&
    resolvedGeneration !== receiptGeneration &&
    // NOTE: ...and the row is still there to leave: `claimFrom` is what the call EXPECTS, so a repost of
    // a settled event must reach the CAS and skip, not throw a false promise that the sweep will pick
    // it up. One read, on the refusal path only.
    (await deliveryStatusOf(base, params.tenantId, params.deliveryRowId)) ===
      "PENDING"
  ) {
    throw new Error(
      `chatwoot: the binding moved between this delivery's receipt (generation ${receiptGeneration}) and its route resolution (generation ${resolvedGeneration}), which now resolves no runtime (conv=${n.conversationId === null ? "?" : String(n.conversationId)}, bot=${params.agentBotId}); leaving the delivery for the sweep rather than settling it against a world it never arrived in`,
    );
  }
  const claimed = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.chatwootWebhookDelivery.updateMany({
      where: { id: params.deliveryRowId, status: claimFrom },
      data: {
        status: "PROCESSING",
        claimedAt: new Date(),
        // NOTE: The body the ack stored leaves with the first attempt that claims the row: from here a
        // death is the sweep's, which rebuilds from Chatwoot, so nothing reads it again.
        payload: null,
        // NOTE: The route's role, stated by the claim itself (see the note above the resolution).
        routeObserved: observer !== null,
        // NOTE: ...and what it does with an unanswered message, in the same statement: the observer beside
        // it stands down on this, and the responder's mode may have been flipped since.
        routeRemembers,
        ...(claimFrom === "DEAD" ? { attempts: { increment: 1 } } : {}),
      },
    }),
  );
  if (claimed.count === 0) return "skipped";

  const command = isNewIncoming ? controlCommand(n) : null;
  // A command is active only for a test-mode agent, and the question must be answered by the
  // row that acts on it: `rt` reads the PAYLOAD's inbox, the test-mode gate the conversation's STORED
  // inbox, and a disagreement dead-ends /teste. The payload stays primary; the stored row is read only
  // when the payload names no inbox and a command was typed, so it can only honour a dropped command.
  let commandMode: string | null = null;
  // The agent the command was decided against, from whichever reading answered, so a dropped
  // command's line names an agent even on the sparse-payload path where `rt` is null.
  let commandAgent: { agentId: bigint; inboxId: bigint } | null =
    rt !== null ? { agentId: rt.agentId, inboxId: rt.inboxId } : null;
  if (command !== null) {
    // The RESPONDER's mode decides a command even on an observer's route: the observer's would
    // call an active command inactive, mirror it as customer engagement and report a false drop.
    const commandRt =
      observer !== null && responderRt !== null ? responderRt : rt;
    if (commandRt !== null) {
      commandMode = commandRt.mode;
      commandAgent = { agentId: commandRt.agentId, inboxId: commandRt.inboxId };
    } else if (n.inboxId == null) {
      // ONLY when the payload named no inbox. A named inbox resolving to no agent is an answer:
      // falling back would decide the command against the inbox the conversation pointed at BEFORE this
      // event, and the command would be consumed without running or acknowledging, a worse silence.
      const stored = await conversationAgent(
        params.tenantId,
        params.instanceId,
        n.conversationId,
        base,
      );
      commandMode = stored?.mode ?? null;
      if (stored !== null)
        commandAgent = { agentId: stored.agentId, inboxId: stored.inboxId };
    }
  }
  const commandActive = command !== null && commandMode === "test";
  // The command is decided above the mirror because the mirror's inbound watermark depends on it
  // (see `suppressInboundWatermark`). The responder counts only while it HAS A ROUTE: a persona bot
  // deleted on Chatwoot leaves the binding and kills the route ("missing", with Reconnect), and
  // standing down for a delivery that never comes drops the message from memory. The bot row is the
  // local half this path can afford; a row naming an id Chatwoot lost is invisible here.
  const responderBotId =
    observer !== null && responderRt !== null
      ? ((
          await runScopedOn(base, sysCtx(params.tenantId), (db) =>
            db.chatwootAgentBot.findFirst({
              where: {
                tenantId: params.tenantId,
                chatwootInstanceId: params.instanceId,
                agentId: responderRt.agentId,
              },
              select: { chatwootAgentBotId: true },
            }),
          )
        )?.chatwootAgentBotId ?? null)
      : null;
  const responderHasRoute = responderBotId !== null;
  const watchingBesideResponder =
    observer !== null && responderRt !== null && responderHasRoute;
  // The responder's route remembers only while switched on and ingesting continuously; beside a
  // test or switched-off responder this route remembers. The watermark follows the answering half: a
  // switched-off responder's mark moves, a test responder keeps its own (an activated conversation
  // may then hold an answered message twice, the test mode's price). Above all, the responder must
  // ACTUALLY HAVE this message (`responderCoversMessage`, asked of the moment of emission), asked once
  // because every stand-down (memory, media pass, command) rests on it. `coveredMessage` names the
  // message both sibling questions ask about.
  const coveredMessage =
    n.message?.id == null
      ? null
      : isNewIncoming || transcriptionOnTheWire || hasLateMedia
        ? { id: n.message.id, column: "inbound" as const }
        : mayBeHumanReply
          ? { id: n.message.id, column: "humanReply" as const }
          : null;
  const responderCovers =
    watchingBesideResponder &&
    responderBotId !== null &&
    (await responderCoversMessage(
      params.tenantId,
      params.instanceId,
      params.deliveryRowId,
      responderRt?.responderBoundAt ?? null,
      responderBotId,
      n.conversationId,
      // NOTE: A customer message is named by the inbound column, a colleague's reply by the one the
      // takeover recovery reads. An UPDATE of a customer message names that same message, or a transcribed
      // update would ingest what the responder's turn handled and a raw one would pay STT twice.
      coveredMessage,
      // The START of that second, because the field is only ever epoch seconds and reading it early
      // errs toward asking the ledger for evidence rather than toward assuming coverage.
      n.lastActivityAt == null ? null : new Date(n.lastActivityAt * 1000),
      base,
    ));
  // ...and what that sibling does with it, read beside the coverage answer so both questions
  // about one sibling are adjacent. Asked only with coverage, where it can change anything.
  const siblingRemembers =
    responderCovers && responderBotId !== null
      ? await responderSiblingRemembers(
          params.tenantId,
          params.instanceId,
          params.deliveryRowId,
          responderBotId,
          n.conversationId,
          coveredMessage,
          n.event,
          base,
        )
      : null;

  // Mirror metadata (idempotent, monotonic, per-conversation locked) BEFORE the gate so the
  // runtime reads fresh state. Unconditional: applies to every event, not just actionable ones. Once
  // per event, not per route: the other route's delivery of the same payload reuses this run.
  const mirror = await mirrorOncePerEvent(
    params.tenantId,
    params.instanceId,
    n,
    base,
    {
      // NOTE: ...but never for a command THIS route will not consume: beside a responder that never
      // received it, the text is customer text, and suppressing the mark would leave the follow-up episode
      // gate and the 24h service window reading the previous inbound.
      suppressInboundWatermark:
        commandActive && (observer === null || responderCovers),
      // Which ladder goes with the episode, if this event turns out to move the pairing. Computed
      // here because the key is this module's to spell, retired in there because it has to be
      // atomic with the write that moves it.
      ...(n.conversationId !== null
        ? {
            redirectLadderDedupeKey: followUpDedupeKey(
              chatwootThreadId(
                params.tenantId,
                params.instanceId,
                n.conversationId,
              ),
            ),
          }
        : {}),
    },
  );

  // A reply the channel refused, reported on a `message_updated` for the route's own outgoing
  // message. Below the mirror so the line hangs off the conversation row; it runs no turn, no debounce,
  // no model. Best-effort: it reports a message already gone.
  const channelFailure = channelFailureOf(n, params.agentBotId);
  if (channelFailure && params.agentBotId !== null) {
    try {
      await handleChannelFailure({
        failure: channelFailure,
        tenantId: params.tenantId,
        instanceId: params.instanceId,
        agentBotId: params.agentBotId,
        flow: {
          tenantId: params.tenantId,
          turnId: crypto.randomUUID(),
          source: "inbox",
          conversationId: mirror.conversationRowId,
          base,
        },
        base,
      });
    } catch (e) {
      logger.warn(
        "chatwoot: could not act on a channel failure (conv=%s msg=%s): %s",
        String(channelFailure.conversationId),
        String(channelFailure.messageId),
        errMsg(e),
      );
    }
  }

  // NOTE: A command that will not run is otherwise indistinguishable from customer text, and past this
  // point `isTeste`/`isReset` are false. This is the only place holding all three values the
  // diagnosis needs. `mode=unresolved` means no reading named an agent. Below the mirror, because the
  // row hangs off the conversation row the mirror creates.
  if (command !== null && !commandActive) {
    // Who speaks for the command, by the fence's own rule: Chatwoot fans the message to the assigned
    // bot and the inbox's (`agent_bots_for`), so each delivery reports what IT did and the pair reads as
    // one command. With no persona both report the mode: a row twice beats a command nobody reports.
    // Best-effort and the id only: the mirror has committed and Chatwoot has its 200, so a throw here
    // would strand the row PROCESSING; an unreadable persona degrades to `no_persona`.
    const personaBot =
      commandAgent !== null
        ? await agentBotChatwootId(
            params.tenantId,
            params.instanceId,
            commandAgent.agentId,
            base,
          ).catch((err) => {
            logger.warn(
              "chatwoot: persona unreadable for the dropped-command line (conv=%s): %s",
              n.conversationId === null ? "?" : String(n.conversationId),
              err instanceof Error ? err.message : String(err),
            );
            return null;
          })
        : null;
    const route = commandRoute(personaBot, params.agentBotId);
    logger.info(
      route.reason === "other_route"
        ? "chatwoot: /%s not for this route, leaving it to the inbox's persona (conv=%s, agent mode=%s, route bot=%s)"
        : "chatwoot: /%s not run (conv=%s) — control commands apply only to a test-mode agent (agent mode=%s, route bot=%s)",
      command,
      n.conversationId === null ? "?" : String(n.conversationId),
      commandMode ?? "unresolved",
      params.agentBotId === null ? "unknown" : String(params.agentBotId),
    );
    if (mirror.conversationRowId !== null) {
      emitCommandDropped({
        tenantId: params.tenantId,
        conversationRowId: mirror.conversationRowId,
        agentId: commandAgent?.agentId ?? null,
        inboxRowId: commandAgent?.inboxId ?? mirror.inboxRowId,
        command,
        routeBot: params.agentBotId,
        drop:
          route.reason === "other_route"
            ? route
            : { reason: "inactive", mode: commandMode ?? "unresolved" },
        base,
      });
    }
  }

  // Canonical realtime fan-out: only on an applied (non-stale) change, with the
  // post-write snapshot the mirror computed. Metadata only — no PII on the wire.
  if (mirror.applied && mirror.conversationRowId !== null) {
    broadcastConversationEvent(params.tenantId, {
      conversationId: String(mirror.conversationRowId),
      status: mirror.status,
      assigneeId: mirror.assigneeId,
      assigneeType: mirror.assigneeType,
      lastEventAt: mirror.lastEventAt ? mirror.lastEventAt.toISOString() : null,
    });
  }

  // Gate, then the agent runtime, all network OUTSIDE the transaction. The payload wins when it
  // spoke (explicit null is a real unassign); silent (no meta), the mirror's EFFECTIVE state answers,
  // so a degraded event on a human-owned conversation does not read as bot-owned.
  const assigneeKnown = n.assigneeType !== undefined;
  // Named once and asked twice (the gate, and the line saying which event closed it), so the two
  // answers cannot drift. Only the assignee is lifted: the literals stay literal so the per-call-site
  // sweep still sees the `assigneeId` that makes the gate strict. Whichever witness says the
  // conversation is held wins, by `effectiveAssignee` (../chatwoot/normalize.ts, with its decision
  // table): every payload is an earlier snapshot, and a message never writes the assignee
  // (../chatwoot/state-order.ts).
  const effective = effectiveAssignee(
    {
      stated: assigneeKnown,
      assigneeType: n.assigneeType ?? null,
      assigneeId: n.assigneeId ?? null,
    },
    { assigneeType: mirror.assigneeType, assigneeId: mirror.assigneeId },
    { ourAgentBotId: params.agentBotId },
  );
  const effectiveAssigneeType = effective.assigneeType;
  const effectiveAssigneeId = effective.assigneeId;
  // The status the MIRROR settled on, not the one the payload proposed: `mirror` is the row after
  // this event, holding whichever won (a reopening message reads `pending`, a refused status reads the
  // one that outranked it). Every payload is a snapshot of an earlier instant. Not `mirror.applied`:
  // that is the event overall, while status is ordered on its own axis.
  const effectiveStatus = mirror.status ?? n.status;
  const act = shouldBotHandle(
    {
      assigneeType: effectiveAssigneeType,
      status: effectiveStatus,
      assigneeId: effectiveAssigneeId,
    },
    { ourAgentBotId: params.agentBotId },
  );
  // A MONITORING agent owns the reply path nowhere, nor does any agent on an OBSERVER's route.
  // `act` keeps meaning "the bot holds it" for its other readers, but arms nothing: no gate, command,
  // debounce or turn; the message is ingested and the watermark advances, so a later flip to
  // production does not answer the backlog. ENABLED too on the responder's half: an agent off and in
  // monitoring takes the switched-off path, unmarked. An observer's ROUTE stays the observer's.
  const observing =
    observer !== null || (rt?.enabled === true && rt.mode === "monitoring");
  // An observer beside a responder of ours: the thread is keyed by contact-inbox, so both routes
  // write the SAME thread, and appending again would double every answered message (a message a turn
  // answers is never ingested). So beside a responder this route neither moves the mark nor appends;
  // alone, it keeps only the watermark (`routeRemembers`). What the responder remembers comes from the
  // sibling's own statement when present (a switch may flip between the concurrent deliveries); null
  // falls back to the mode.
  const responderRemembers =
    responderCovers &&
    (siblingRemembers ??
      (responderRt?.enabled === true && ingestsContinuously(responderRt.mode)));
  // The mark stays the responder's whenever there is one, deliberately NOT asked of
  // `responderCovers`: an absent sibling may be in transit (the emission clock is second-granular),
  // and moving the mark would suppress its reply. Coverage may cost a duplicate memory line, never an
  // answer. On a REPLAY absence is evidence (the sweep waited half an hour), and holding the mark
  // would make a newly bound responder answer the observed backlog, so coverage decides there.
  const responderMayAnswer =
    (params.claimFrom === "DEAD" ? responderCovers : watchingBesideResponder) &&
    responderRt?.enabled === true;
  // Set by the direct turn when it stood down under an agent that observes NOW: the message is
  // then the observer's to remember.
  let handedToObserver = false;
  // The stand-down's observer read failed: thrown AFTER the turn's own catch, which would
  // otherwise swallow it as a failed turn.
  let standDownUnreadable = false;
  // O turno parou antes do invoke porque uma pessoa assumiu a conversa enquanto ele esperava o
  // thread. Nada leu a mensagem, então ela continua DEVIDA: isto impede o gate de liquidá-la e tira o
  // `act` da ingestão, como faz o observador; sem isso a mensagem some.
  let stoodDownUnread = false;
  // Who holds it, when somebody else does. A HUMAN will answer the message whichever route
  // carried it; ANOTHER BOT's own delivery may be running now (Chatwoot fans to two routes). Scopes the
  // gate tail's settlement. Asked of `heldByAnotherParty`, not `!act`, which is also false for a
  // non-pending status and would call OUR bot another on every open or resolved conversation.
  const heldByAnotherBot =
    effectiveAssigneeType === "AgentBot" &&
    heldByAnotherParty(
      {
        assigneeType: effectiveAssigneeType,
        assigneeId: effectiveAssigneeId,
      },
      { ourAgentBotId: params.agentBotId },
    );
  // O escopo da liquidação desta passada, decidido UMA vez: é lido pela liquidação e gravado na
  // linha, e as duas coisas têm que ser a mesma expressão, ou o replay regrava a derivação de agora e
  // uma segunda falha devolve a linha a `DEAD` com o escopo corrompido. O parâmetro vem primeiro: no
  // replay ele é a resposta dada quando era verdade; undefined é a entrega ao vivo.
  const settleScopedHere =
    params.settleScopedToThisDelivery ??
    (heldByAnotherBot || observer !== null);
  const convLabel = n.conversationId === null ? "?" : String(n.conversationId);

  // NOTE: The watcher's final verdict, armed off the resolve EVENT on each route (the mirror's
  // transition is applied only by the first route to mirror it; the per-conversation row folds the
  // arms). Only while the MIRROR says resolved, so a delayed `resolved` the mirror rejected cannot
  // relabel a live conversation; `effectiveStatus` falls back to the payload when nothing was stored.
  if (
    n.conversationId !== null &&
    n.status === "resolved" &&
    effectiveStatus === "resolved" &&
    (n.event === "conversation_status_changed" ||
      n.event === "conversation_resolved")
  ) {
    const conversationId = n.conversationId;
    // NOTE: Best-effort as a whole: a status-only event carries no `inboundMessageId`, so the sweep
    // cannot recover it, and a throw here would skip the compaction and redirect closing below. A late
    // label is not a lost message; a closing that never goes out is.
    try {
      let closingInboxId = n.inboxId;
      if (closingInboxId === null) {
        try {
          const stored = await runScopedOn(
            base,
            sysCtx(params.tenantId),
            (db) =>
              db.conversation.findUnique({
                where: {
                  tenantId_chatwootInstanceId_chatwootConversationId: {
                    tenantId: params.tenantId,
                    chatwootInstanceId: params.instanceId,
                    chatwootConversationId: conversationId,
                  },
                },
                select: { inbox: { select: { chatwootInboxId: true } } },
              }),
          );
          closingInboxId = stored?.inbox?.chatwootInboxId ?? null;
        } catch (err) {
          logger.warn(
            "chatwoot: resolving the inbox for the observer's final verdict failed (conv=%s): %s",
            String(conversationId),
            errMsg(err),
          );
        }
      }
      const responderRt = await inboxAgentRuntime(
        params.tenantId,
        params.instanceId,
        closingInboxId,
        base,
      );
      const observerRt = await observerRuntimeForRoute(
        params.tenantId,
        params.instanceId,
        params.agentBotId,
        {
          chatwootInboxId: closingInboxId,
          chatwootConversationId: conversationId,
        },
        // Same reading of the payload the message path makes: `undefined` on both is a degraded event
        // that says nothing and is answered by the mirror; `null` is an explicit unassignment.
        n.assigneeType === undefined && n.assigneeId === undefined
          ? null
          : { type: n.assigneeType, id: n.assigneeId },
        params.routeObserved === true,
        base,
      );
      // ...and the BOUND observer, from the binding: a watcher whose bot still holds the
      // conversation resolves to no reply route and would miss its final verdict.
      const boundRt = await boundObserverRuntime(
        params.tenantId,
        params.instanceId,
        params.agentBotId,
        {
          chatwootInboxId: closingInboxId,
          chatwootConversationId: conversationId,
        },
        base,
      );
      const seen = new Set<bigint>();
      for (const watcher of [responderRt, observerRt, boundRt]) {
        if (
          watcher?.enabled &&
          isMonitoring(watcher.mode) &&
          !seen.has(watcher.agentId) &&
          (watcher === responderRt || responderRt?.agentId !== watcher.agentId)
        ) {
          seen.add(watcher.agentId);
          const permit = await observerArmPermit({
            tenantId: params.tenantId,
            instanceId: params.instanceId,
            conversationId,
            agentId: watcher.agentId,
            settings: watcher.settings,
            base,
            fetchImpl: params.deps?.contactAuthFetch,
          });
          if (!permit) continue;
          await armObserve({
            tenantId: params.tenantId,
            instanceId: params.instanceId,
            conversationId,
            agentId: watcher.agentId,
            reason: "resolved",
            cfg: readMonitoringConfig(watcher.settings),
            // NOTE: The conversation's own version (`updated_at.to_f`) names this RESOLUTION, so the four
            // deliveries one resolve produces (two event types by two routes) buy one verdict.
            mark: n.conversationUpdatedAt,
            // NOTE: Only the reply-route answer can come from the attach window, and here it matters most: the
            // mark suppresses every later delivery of this resolution, so a lost verdict is lost for good.
            attaching: watcher === observerRt && observerRt.attaching === true,
            gateAskedAt: permit.askedAt,
            base,
          });
        }
      }
    } catch (err) {
      logger.warn(
        "chatwoot: arming the observer's final verdict failed (conv=%s): %s",
        String(conversationId),
        errMsg(err),
      );
    }
  }
  // NOTE: A conversation this agent manages just transitioned TO resolved, by anyone (the agent's
  // tool, our console, Chatwoot). Two independent consequences: memory compaction for every agent, and
  // the redirect handling for a widget inbox. Detected off the mirror's fresh prevStatus to status
  // transition, on any event carrying a status.
  if (
    mirror.applied &&
    mirror.prevStatus !== null &&
    mirror.prevStatus !== "resolved" &&
    mirror.status === "resolved" &&
    n.conversationId !== null
  ) {
    const conversationId = n.conversationId;
    // Both ids FROM THE MIRROR when the event lacks them (a conversation_* payload can omit
    // `inbox` and `contact_inbox`), or compaction is skipped and a returning customer's history stays
    // raw. In its OWN best-effort boundary: a failure here must not reach the shared catch and skip the
    // redirect's chase cancel and closing message, which a conversation that resolves once never gets back.
    let storedInboxId: number | null = null;
    let storedContactInboxId: number | null = null;
    if (n.inboxId === null || n.contactInboxId === null) {
      try {
        const stored = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
          db.conversation.findUnique({
            where: {
              tenantId_chatwootInstanceId_chatwootConversationId: {
                tenantId: params.tenantId,
                chatwootInstanceId: params.instanceId,
                chatwootConversationId: conversationId,
              },
            },
            select: {
              contactInboxId: true,
              inbox: { select: { chatwootInboxId: true } },
            },
          }),
        );
        storedInboxId = stored?.inbox?.chatwootInboxId ?? null;
        storedContactInboxId = stored?.contactInboxId ?? null;
      } catch (err) {
        logger.warn(
          "chatwoot: resolving ids for compaction on resolve failed (conv=%s): %s",
          String(conversationId),
          errMsg(err),
        );
      }
    }
    const closingInboxId = n.inboxId ?? storedInboxId;
    const closingContactInboxId = n.contactInboxId ?? storedContactInboxId;
    try {
      // The responder's alone: an observer's route keeps no memory on an inbox without one
      // (`routeRemembers`).
      const responderClosingRt = await inboxAgentRuntime(
        params.tenantId,
        params.instanceId,
        closingInboxId,
        base,
      );
      if (responderClosingRt) {
        // NOTE: Memory compaction, armed at resolve with a grace period so the thread is compacted BEFORE
        // the customer returns: the resumption turn is the one billed without cache, so compacting on
        // return would miss it. The job re-checks the status, since a resolve can be undone.
        if (closingContactInboxId !== null) {
          try {
            await armCompaction({
              tenantId: params.tenantId,
              instanceId: params.instanceId,
              contactInboxId: closingContactInboxId,
              conversationId,
              agentId: responderClosingRt.agentId,
              reason: "resolved",
              enabled: readMemoryConfig(responderClosingRt.settings).compaction
                .enabled,
              base,
            });
          } catch (err) {
            logger.warn(
              "chatwoot: arming compaction on resolve failed (conv=%s): %s",
              String(conversationId),
              errMsg(err),
            );
          }
        }
        // The redirect is the RESPONDER's, never the watcher's: it ends in customer-facing text on
        // the WhatsApp sibling, so reading it off the responder makes that structural. On a widget
        // conversation resolving: stop the ladder, and post the closing on the sibling, where
        // `deliverRedirectClosing` CAS-guards the watermark (idempotent under redelivery and against the
        // ladder's own closing stage).
        const redirectCfg = readChannelRedirectConfig(
          responderClosingRt?.settings,
        );
        // The redirect keys off the EVENT's inbox (it is the widget conversation that resolved).
        // A sparse payload carries none, and `widgetInboxId === null` would otherwise read as a
        // match on a half-configured agent.
        if (
          responderClosingRt !== null &&
          redirectCfg.enabled &&
          n.inboxId !== null &&
          redirectCfg.widgetInboxId === n.inboxId
        ) {
          // (1) Stop chasing a resolved conversation, regardless of whether closing is on.
          await cancelPendingJob(
            params.tenantId,
            "REDIRECT_FOLLOWUP",
            followUpDedupeKey(
              chatwootThreadId(
                params.tenantId,
                params.instanceId,
                conversationId,
              ),
            ),
            base,
          );
          // (2) Closing message on the WhatsApp sibling (at most once, CAS-guarded); Chatwoot is already
          // resolving the widget, so resolveWidget:false. Gated on the agent being live, as the ladder's own
          // closing stage is: this fixed-text send has no nudge behind it to ask. The cancel above stays
          // ungated: standing the chase down is not a send.
          const closingLive =
            redirectCfg.closingEnabled &&
            redirectCfg.entryInboxId !== null &&
            isRedirectFollowUpLive({
              agentEnabled: responderClosingRt.enabled,
              agentMode: responderClosingRt.mode,
              // NOTE: Only a test agent's liveness needs the stamp, and a failure here is permanent (the ladder is
              // already cancelled and a conversation resolves once), so a production agent skips the read.
              testActivatedAt:
                responderClosingRt.mode === "test"
                  ? await episodeActivationForWidget(
                      params.tenantId,
                      params.instanceId,
                      conversationId,
                      redirectCfg,
                      responderClosingRt.mode,
                      base,
                    )
                  : null,
            });
          if (closingLive && redirectCfg.entryInboxId !== null) {
            const outcome = await deliverRedirectClosing({
              // NOTE: The gate above predates the sibling lookup and client build, and this path has no job to
              // ask, so the switch is re-asked from inside at the ladder's points. One read, failing OPEN: a
              // transient error must not cost the closing.
              fence: async () => {
                const rt = await inboxAgentRuntime(
                  params.tenantId,
                  params.instanceId,
                  closingInboxId,
                  base,
                ).catch(() => undefined);
                if (rt === undefined) return "go" as const;
                if (rt === null) return "stood-down" as const;
                // NOTE: The switch is conclusive on its own, and it is read here — before the
                // stamp, which is fallible and which only a test agent needs at all.
                if (!rt.enabled) return "stood-down" as const;
                if (isMonitoring(rt.mode)) return "stood-down" as const;
                if (rt.mode !== "test") return "go" as const;
                // A test agent's answer takes a second read, not in the same snapshot as the switch. Left as
                // a residual: closing it needs agent and stamp in ONE statement, and `Inbox` has no `agent` relation
                // to select through (raw SQL or a schema change for a one-query window on a test agent).
                const testActivatedAt = await episodeActivationForWidget(
                  params.tenantId,
                  params.instanceId,
                  conversationId,
                  redirectCfg,
                  rt.mode,
                  base,
                ).catch(() => new Date());
                return isRedirectFollowUpLive({
                  agentEnabled: rt.enabled,
                  agentMode: rt.mode,
                  testActivatedAt,
                })
                  ? ("go" as const)
                  : ("stood-down" as const);
              },
              tenantId: params.tenantId,
              instanceId: params.instanceId,
              widgetConversationId: conversationId,
              entryInboxId: redirectCfg.entryInboxId,
              closingMessage: redirectCfg.closingMessage,
              // The widget conversation is already being resolved by this trigger — only the WhatsApp
              // sibling still needs the closing message.
              closeChat: false,
              base,
            });
            logger.info(
              "channel-redirect: widget resolved (conv=%s) closing=%s",
              convLabel,
              outcome,
            );
          }
        }
      }
    } catch (err) {
      logger.warn(
        "channel-redirect: closing delivery failed (conv=%s): %s",
        convLabel,
        errMsg(err),
      );
    }
  }

  // Production analyzes every new incoming message, and a late attachment on message_updated
  // without arming debounce or a second turn. Test mode keeps its cost fence and analyzes a late
  // attachment only on an activated EPISODE, the unit the other gates use; asked of the row alone, a
  // WhatsApp-side activation would leave the widget side's audio unheard.
  const activatedTestLateMedia =
    hasLateMedia &&
    rt?.enabled === true &&
    rt.mode === "test" &&
    act &&
    n.conversationId !== null &&
    (await episodeActivationForWidget(
      params.tenantId,
      params.instanceId,
      n.conversationId,
      readChannelRedirectConfig(rt.settings),
      rt.mode,
      base,
    )) !== null;
  // A WATCHER bound as the inbox's agent remembers, but analyses media only for a conversation
  // its own contact gate lets it observe. Another watcher of the inbox stands down on its pass
  // only when that is known to happen: the bound watcher's conditions allow the conversation and no
  // endpoint follows them. Otherwise this route analyses for itself, under its own gate, since one
  // watcher's refusal decides only what that watcher observes. The conditions are asked without a
  // line: the bound watcher's own route leaves it.
  const boundWatcherMayRefuseMedia =
    responderRemembers &&
    observer !== null &&
    responderRt !== null &&
    isMonitoring(responderRt.mode) &&
    n.conversationId !== null &&
    (await (async () => {
      // NOTE: An audio the bound watcher already refused is one it will not analyze, whatever its
      // gate says now, turned off included.
      if (
        refusedCovers(
          watcherMediaRefusedThrough(
            params.tenantId,
            mirror.conversationRowId,
            responderRt.agentId,
          ),
          n.message?.id,
        )
      )
        return true;
      const cfg = readContactAuthConfig(responderRt.settings);
      if (!cfg.enabled) return false;
      if (cfg.url !== null && (cfg.rule === null || cfg.askEndpointAfterRule))
        return true;
      return (
        (await observerRuleVerdict(
          {
            tenantId: params.tenantId,
            instanceId: params.instanceId,
            conversationId: n.conversationId as number,
            agentId: responderRt.agentId,
            settings: responderRt.settings,
            base,
          },
          { emit: false },
        )) !== "allowed"
      );
    })());
  // A TEST responder analyses media too, on the answer path of an activated conversation, so the
  // observer stands down there as well. Asked only on an observer route beside a test responder.
  const responderAnalysesMedia =
    (responderRemembers && !boundWatcherMayRefuseMedia) ||
    (responderCovers &&
      responderRt?.enabled === true &&
      responderRt.mode === "test" &&
      // NOTE: ...and only where that route would REACH its answer path: on a conversation a human owns or
      // its bot does not hold, the responder never analyses, and standing down leaves the audio unread.
      shouldBotHandle(
        {
          assigneeType: effectiveAssigneeType,
          status: effectiveStatus,
          assigneeId: effectiveAssigneeId,
        },
        { ourAgentBotId: responderBotId },
      ) &&
      n.conversationId !== null &&
      (await episodeActivationForWidget(
        params.tenantId,
        params.instanceId,
        n.conversationId,
        readChannelRedirectConfig(responderRt.settings),
        responderRt.mode,
        base,
      )) !== null);
  // Not from an observer's route beside a responder that remembers: both would transcribe the
  // same audio (twice the bill, and racing writes into one attachment's stash). The pass follows the
  // memory. A ROW-BACKED observer analyses whatever its mode, as its ingestion does: a watcher that
  // remembers an audio as a marker remembers nothing of it.
  const watcherReads = observer !== null;
  // The contact gate on the observer path, asked once per watcher per delivery: the media pass and
  // the arm below put the same question, and two asks would leave two lines (and, with an endpoint,
  // call it twice).
  const observeVerdicts = new Map<
    string,
    Promise<{ askedAt: number } | null>
  >();
  const observerMayObserve = (
    watcher: { agentId: bigint },
    settings: unknown,
  ): Promise<{ askedAt: number } | null> => {
    if (n.conversationId === null)
      return Promise.resolve({ askedAt: Date.now() });
    const key = String(watcher.agentId);
    let verdict = observeVerdicts.get(key);
    if (!verdict) {
      verdict = observerArmPermit({
        tenantId: params.tenantId,
        instanceId: params.instanceId,
        conversationId: n.conversationId,
        agentId: watcher.agentId,
        settings,
        base,
        fetchImpl: params.deps?.contactAuthFetch,
        message:
          n.message?.id != null
            ? { id: n.message.id, text: n.message.content ?? null }
            : null,
      });
      observeVerdicts.set(key, verdict);
    }
    return verdict;
  };
  // When the contact authorization gate runs on this message, the media pass waits for its verdict.
  const gateAsksNext =
    (act || commandActive) &&
    isNewIncoming &&
    !observing &&
    params.owesMemoryOnly !== true &&
    rt !== null &&
    readContactAuthConfig(rt.settings).enabled;
  let mediaAwaitsGate = false;
  if (
    rt?.enabled &&
    !responderAnalysesMedia &&
    ((isNewIncoming && (ingestsContinuously(rt.mode) || watcherReads)) ||
      (hasLateMedia &&
        (ingestsContinuously(rt.mode) ||
          watcherReads ||
          activatedTestLateMedia)))
  ) {
    // Chatwoot follows a voice note with a `message_updated`: the bound watcher's allow for the
    // message already covers it, so the late update does not put the question to the endpoint again
    // (the pass still honours a refusal recorded since).
    // Scoped to the watcher: that admission is its own verdict, never the responder's media gate
    // nor another agent's that held the inbox before.
    const watcherAdmission =
      observing && n.message?.id != null
        ? `${mediaAdmissionKey(params.tenantId, params.instanceId, n.message.id)}:watcher:${rt.agentId}`
        : null;
    // A message this watcher already refused stays refused for it, a refusal of a later message
    // included: its late update is not transcribed by a yes given since, nor by an allow cached for it
    // before that refusal, and its gate is not asked again.
    const refusedForWatcher =
      observing &&
      refusedCovers(
        watcherMediaRefusedThrough(
          params.tenantId,
          mirror.conversationRowId,
          rt.agentId,
        ),
        n.message?.id,
      );
    // The endpoint's answer is what is reused; the conditions are asked again, since a label
    // removed since then takes the conversation out of scope.
    const lateAdmitted =
      !refusedForWatcher &&
      !isNewIncoming &&
      watcherAdmission !== null &&
      n.conversationId !== null &&
      watcherAdmissionStands(watcherAdmission, rt.settings, {
        tenantId: params.tenantId,
        instanceId: params.instanceId,
        conversationId: n.conversationId,
        agentId: rt.agentId,
      }) &&
      (await observerRuleVerdict(
        {
          tenantId: params.tenantId,
          instanceId: params.instanceId,
          conversationId: n.conversationId,
          agentId: rt.agentId,
          settings: rt.settings,
          base,
        },
        { emit: false },
      )) === "allowed";
    const watcherPermit =
      !gateAsksNext && observing && !lateAdmitted && !refusedForWatcher
        ? await observerMayObserve(rt, rt.settings)
        : null;
    if (gateAsksNext) {
      mediaAwaitsGate = true;
    } else if (observing && !lateAdmitted && !watcherPermit) {
      // NOTE: A conversation the watcher's gate keeps it out of is not transcribed or described for
      // it: that analysis exists for the observation the gate just refused. The refusal is remembered
      // for THIS watcher only (a late update of the same audio is not transcribed by a later yes), never
      // on the conversation: another watcher of the inbox decides its own media by its own gate, and a
      // responder's media gate is the responder's.
      recordWatcherMediaRefusal(
        params.tenantId,
        mirror.conversationRowId,
        rt.agentId,
        n.message?.id,
      );
    } else {
      if (
        watcherAdmission !== null &&
        watcherPermit &&
        n.conversationId !== null
      ) {
        rememberWatcherAdmission(watcherAdmission, watcherPermit, rt.settings, {
          tenantId: params.tenantId,
          instanceId: params.instanceId,
          conversationId: n.conversationId,
          agentId: rt.agentId,
        });
      }
      await runEagerMedia(params.tenantId, params.instanceId, n, base, {
        conversationId: mirror.conversationRowId,
        agentId: rt.agentId,
        inboxId: rt.inboxId,
        chatwootInboxId: rt.chatwootInboxId,
        deliveryRowId: params.deliveryRowId,
        sleep: params.deps?.sleep,
        deps: params.deps,
        // NOTE: On the responder's route the watcher IS the inbox's agent, and its gate just
        // answered: the pass's own ask would put the same question again (to the endpoint too), and
        // leave a second line.
        admission: observing && observer === null ? "allowed" : "unverified",
      });
    }
  }

  // NOTE: A new customer message makes a pending inactivity follow-up moot, so it is cancelled
  // regardless of the bot gate, best-effort. RETIRED, not cancelled: a cancel reaches PENDING rows,
  // and a claimed run would still send; the tombstone is what `stillWanted` (../followups/handlers.ts)
  // asks before the invoke and the send, with the claim token bumped. A re-arm's upsert clears it.
  // UNCONDITIONAL even on a recovery, where the ladder may be one this message started: no ordering
  // (message time, `received_at`, the DEAD retake) tells that from a customer who just wrote. Losing
  // it is cheap: an answered recovery opens a new episode, an unanswered one is the sweep's.
  if (isNewIncoming && n.conversationId !== null) {
    const threadId = chatwootThreadId(
      params.tenantId,
      params.instanceId,
      n.conversationId,
    );
    try {
      await retireJobsByDedupeKey(
        params.tenantId,
        "FOLLOWUP",
        `followup:${threadId}`,
        base,
      );
    } catch (err) {
      logger.warn(
        "failed to cancel pending follow-up on reply (conv=%s): %s",
        convLabel,
        err instanceof Error ? err.message : String(err),
      );
    }
    // NOTE: The delayed nothing-to-answer judgement goes too: the customer wrote again (a /reset is an
    // incoming message too), and a blank message re-arms it from its own flush. Only by a NEWER message:
    // another route's delivery of the judged message must not cancel it.
    try {
      await retireNothingToAnswer({
        tenantId: params.tenantId,
        threadId,
        messageId: n.message?.id ?? null,
        base,
      });
    } catch (err) {
      logger.warn(
        "failed to cancel the nothing-to-answer close on reply (conv=%s): %s",
        convLabel,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Say on the LEDGER that this delivery settled its message (something ran over it, or a gate
  // decided nothing would) at the moment it is decided: by tx2 a process death would leave the row
  // PROCESSING for a sealed message, and the sweep would page about it. Called from each deciding
  // branch, never via a flag. "Settled" is not "answered"; an armed flush settles nothing here.
  // `scope`: "conversation" (every row for the message, whichever route; what a turn can say) or
  // "this-delivery" (only this row; what a gate for ANOTHER PARTY can say, since that party may be a
  // bot whose own delivery of the message is in flight).
  const settleDelivery = async (
    messageId: number,
    settlement: "answered" | "consumed",
    // NOTE: Whether a turn folded the message into the thread, which only the caller knows. Ignored on
    // the `this-delivery` scope.
    covered: boolean,
    scope: "conversation" | "this-delivery" = "conversation",
  ): Promise<void> => {
    // NOTE: Narrows for the call below; every caller is already inside a branch with a conversation.
    if (n.conversationId === null) return;
    try {
      await retireCoveredDeliveries({
        tenantId: params.tenantId,
        instanceId: params.instanceId,
        conversationId: n.conversationId,
        conversationRowId: mirror.conversationRowId,
        settlement,
        // NOTE: `covered` rides the wide scope only: a single-row settlement speaks for this route, not the
        // message (the union in ../chatwoot/delivery-sweep.ts enforces it).
        ...(scope === "this-delivery"
          ? { deliveryRowId: params.deliveryRowId }
          : { messageIds: [messageId], covered }),
        base,
      });
    } catch (e) {
      logger.warn(
        "chatwoot: could not settle the delivery (conv=%s): %s",
        convLabel,
        errMsg(e),
      );
    }
  };
  // Hoisted so the ingestion pass can tell a gate-silenced incoming (consumed) from an answered
  // one; false on every path that never runs the gate.
  let consumed = false;
  // What the contact-authorization gate below learned about this contact, for the direct turn's
  // prompt. Null when the gate is off, or when the delivery never reaches a turn.
  const gate: {
    authContext: AuthContext | null;
    verdict: "allowed" | "refused" | null;
  } = { authContext: null, verdict: null };
  // A verdict from the gate is final; without one the pass asks for itself.
  const admissionFromGate = (): EagerMediaOwner["admission"] =>
    gate.verdict ?? "unverified";
  // NOTE: `act || commandActive`: a control command is the OPERATOR driving the tooling, so bot
  // ownership is not its business, and a human-held conversation is exactly where /reset must work
  // (with a `User` assignee, `act` alone refuses both commands). The fence stays `commandActive`: for
  // any other agent these are customer text.

  if (
    (act || commandActive) &&
    isNewIncoming &&
    !observing &&
    // NOTE: The replay of a pass that owed memory only does not speak: only the row witnesses that a
    // person or a gate attended the message then. Not redundant with the replay's `replayPosts`, which
    // picks the recovery's page and freshness fence; the POST happens here.
    params.owesMemoryOnly !== true
  ) {
    // Test-mode gate + /teste and /reset commands — may consume the delivery (skip all agent work).
    consumed = await maybeConsumeCommandOrGate({
      tenantId: params.tenantId,
      instanceId: params.instanceId,
      n,
      command,
      commandActive,
      agentBotId: params.agentBotId,
      base,
      deps: params.deps,
      onAuthContext: (context) => {
        gate.authContext = context;
      },
      onAuthVerdict: (allowed) => {
        gate.verdict = allowed ? "allowed" : "refused";
      },
    });
    // NOTE: Consumed after the pass waited for the gate: memory reads the media only on its yes.
    if (consumed && mediaAwaitsGate) {
      await runEagerMedia(params.tenantId, params.instanceId, n, base, {
        conversationId: mirror.conversationRowId,
        agentId: rt?.agentId ?? null,
        inboxId: rt?.inboxId ?? null,
        chatwootInboxId: rt?.chatwootInboxId ?? null,
        deliveryRowId: params.deliveryRowId,
        sleep: params.deps?.sleep,
        deps: params.deps,
        admission: admissionFromGate(),
        watcherPermit: (agentId, settings) =>
          observerMayObserve({ agentId }, settings),
      });
    }
    if (!consumed) {
      // NOTE: Eager media, so the debounce re-fetch and the direct path get text. Idempotent: for a
      // production agent it already ran, so real work happens only for a test agent that just passed the
      // gate. Best-effort (a failure leaves a "please send text" marker). With `rt` null no config
      // resolves and no line is written.
      await runEagerMedia(params.tenantId, params.instanceId, n, base, {
        conversationId: mirror.conversationRowId,
        agentId: rt?.agentId ?? null,
        inboxId: rt?.inboxId ?? null,
        chatwootInboxId: rt?.chatwootInboxId ?? null,
        deliveryRowId: params.deliveryRowId,
        sleep: params.deps?.sleep,
        deps: params.deps,
        admission: admissionFromGate(),
        watcherPermit: (agentId, settings) =>
          observerMayObserve({ agentId }, settings),
      });

      // Debounce path: an incoming message on a debounce-enabled agent re-arms the durable DEBOUNCE
      // job (coalescing window) instead of replying balloon-by-balloon. The fast worker flushes it
      // (re-fetch + coalesce + one reply). Arming is best-effort: if it fails we fall back to a direct
      // turn so the customer is never left unanswered.
      //
      // NOTE: A pool that is momentarily full is retried first, because the fallback is the worse road
      // in exactly that moment: the job retries on its own and the direct turn does not, and both read
      // the same saturated database.
      let armed = false;
      if (n.conversationId !== null && n.inboxId !== null) {
        const conversationId = n.conversationId;
        const inboxId = n.inboxId;
        try {
          const arm = await retryWhileTransactionNeverStarted(
            async () => {
              const cfg = await resolveDebounceConfig(
                params.tenantId,
                params.instanceId,
                inboxId,
                base,
              );
              if (!cfg) return null;
              return {
                cfg,
                at: await armDebounce({
                  tenantId: params.tenantId,
                  threadId: chatwootThreadId(
                    params.tenantId,
                    params.instanceId,
                    conversationId,
                  ),
                  agentBotId: params.agentBotId,
                  cfg,
                  lastMessageId: n.message?.id ?? undefined,
                  reaction: n.message?.isReaction === true,
                  base,
                }),
              };
            },
            {
              label: `debounce arm (conv=${convLabel})`,
              sleep: params.deps?.sleep,
            },
          );
          if (arm) {
            const { cfg, at: flushAt } = arm;
            armed = true;
            logger.info(
              "chatwoot: debounced (conv=%s window=%ds)",
              convLabel,
              cfg.windowSeconds,
            );
            // Live "receiving messages…" indicator while the window coalesces (the flush's turn then
            // takes over with "thinking" and clears on finish). runAt drives a live countdown in the
            // UI. Best-effort; keyed by the DB id.
            if (mirror.conversationRowId !== null) {
              broadcastAgentActivity(params.tenantId, {
                conversationId: String(mirror.conversationRowId),
                phase: "started",
                stage: "debounce",
                tool: null,
                runAt: flushAt.toISOString(),
              });
            }
          }
        } catch (err) {
          logger.warn(
            "debounce arm failed (conv=%s): %s — falling back to a direct turn",
            convLabel,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      // Direct path (debounce off / not an incoming message / arm failed). Best-effort: a failed agent
      // turn must not strand the delivery. runAgentTurn no-ops for non-incoming-message events and
      // inboxes with no Agent configured.
      if (!armed) {
        // Set when a tool call starts: past it the turn may have acted, and is not one to run again.
        let toolStarted = false;
        try {
          // Whether the message ended up in the thread, reported by the runtime and written there, not
          // carried to the settlement: a TTS or send failing after the invoke jumps to the catch, tx2 closes
          // the row anyway, and the fact would be lost. Record the decision where it is made.
          let turnFoldedIn = false;
          const onFoldedIn = async (): Promise<void> => {
            // NOTE: Only the message whose WORDS the turn had: a voice note awaiting STT reaches the graph as a
            // placeholder, and claiming it (here or at the settlement, which reads this flag) suppresses the
            // ingest the write-back arms.
            if (
              n.message?.id == null ||
              n.conversationId === null ||
              !turnHadTheWords({
                // NOTE: From the FILE TYPES, not `firstAudioAttachment`, which asks whether STT could RUN: an audio
                // whose url has not landed would read as "no audio" and its words would be claimed. The debounce
                // path asks the same question.
                hasAudio: (n.message?.attachments ?? []).some(
                  (a) => a.fileType === "audio",
                ),
                transcribedText: n.message?.transcribedText,
              })
            )
              return;
            turnFoldedIn = true;
            // NOTE: Coverage only, never the settlement: a row closed mid-turn is one the sweep can no longer
            // see.
            await recordTurnCoverage({
              tenantId: params.tenantId,
              instanceId: params.instanceId,
              conversationId: n.conversationId,
              covered: true,
              messageIds: [n.message.id],
              base,
            });
          };
          // The direct turn is reported from its OWN settlement, never the enclosing catch, which also
          // wraps the bookkeeping after it: a recovery reading "error" puts the row back to DEAD and reruns
          // the whole turn, answering twice and repeating every side-effecting tool. None of that bookkeeping
          // throws today, but the contract must not rest on three unrelated call sites.
          const outcome = await runAgentTurn({
            onFoldedIn,
            onToolStart: () => {
              toolStarted = true;
            },
            tenantId: params.tenantId,
            instanceId: params.instanceId,
            agentBotId: params.agentBotId,
            event: n,
            base,
            deps: params.deps,
            authContext: gate.authContext,
          }).then(
            (o) => {
              params.onDirectTurn?.({ kind: "outcome", outcome: o });
              return o;
            },
            (err: unknown) => {
              params.onDirectTurn?.({ kind: "error", error: err });
              throw err;
            },
          );
          logger.info(
            "chatwoot agent turn: conv=%s event=%s outcome=%s mirror=%s",
            convLabel,
            n.event,
            outcome,
            mirror.applied ? "applied" : "skipped",
          );
          // The turn stood down because the operator silenced it while it ran (loaded as production,
          // fenced at send, rolled back). Read the agent again: an OBSERVER gets the message through the
          // ingestion at the bottom, which this delivery's `act` would skip; a switched-off agent keeps its
          // silence. Not settled here: the row closes at the bottom once ingestion has the message, since a
          // terminal row cannot be recovered if the enqueue fails.
          const observes =
            outcome === "agent-unavailable" && rt !== null
              ? await agentObservesNow(params.tenantId, rt.agentId, base)
              : "no";
          if (observes === "unreadable") {
            standDownUnreadable = true;
          } else if (observes === "yes") {
            handedToObserver = true;
          } else if (outcome === "taken-over-unread") {
            // NOTE: Mesmo caminho do observador, por motivo próprio: o turno parou antes do invoke, então
            // nenhum canal tem a mensagem, e liquidar aqui a tiraria da lista de perdas. Fecha lá embaixo.
            stoodDownUnread = true;
            // NOTE: A cobertura é escrita aqui, já que esta parada não chama `settleDelivery`: com a coluna
            // NULA a transcrição tardia cairia no fallback de posse atual e seria descartada. `covered: false` é
            // monotônico (só vira `true`), então não apaga cobertura de ninguém. Best-effort, como `onFoldedIn`.
            if (n.message?.id != null && n.conversationId !== null) {
              await recordTurnCoverage({
                tenantId: params.tenantId,
                instanceId: params.instanceId,
                conversationId: n.conversationId,
                covered: false,
                messageIds: [n.message.id],
                base,
              }).catch((err) => {
                logger.warn(
                  "chatwoot: could not record that no turn covered the message a person took over (conv=%s): %s; a late transcription may be read as covered and dropped",
                  n.conversationId === null ? "?" : String(n.conversationId),
                  errMsg(err),
                );
              });
            }
          } else if (n.message?.id != null) {
            // NOTE: The turn RAN over this message, so nothing is owed on it, whatever the outcome (unlike the
            // flush). `superseded`: the NEWER message's delivery carries the reply, and left open the row would
            // read as lost after any tail crash. `stale`: a /reset withdrew the episode, and left open the sweep
            // would replay pre-reset text into the cleared conversation. `posted-partial` answers: part of the
            // reply is with the customer. No `isNewIncoming` check: the enclosing block requires it.
            await settleDelivery(
              n.message.id,
              outcome === "posted" || outcome === "posted-partial"
                ? "answered"
                : "consumed",
              // NOTE: Not the same reading as the outcome: `graph.invoke` persists the channel, so a silent turn
              // still folded the message in, and guardrails straddle the invoke both ways. The runtime's own
              // answer, repeated because `onFoldedIn`'s write is best-effort and a hardcoded `false` would lie.
              turnFoldedIn,
            );
          }
          // NOTE: The turn had nowhere to go: no agent is bound to this inbox. One line per customer message
          // nothing will answer, the same unit as the gate's line below. The outcome is the WHOLE condition:
          // `runAgentTurn` classifies `no-agent` versus `agent-unavailable` (switched off, deliberate, no line)
          // from one scoped read, while a re-read here could answer about a later rebind.
          if (outcome === "no-agent" && mirror.conversationRowId !== null) {
            emitUnroutedMessage({
              tenantId: params.tenantId,
              conversationRowId: mirror.conversationRowId,
              inboxRowId: mirror.inboxRowId,
              chatwootInboxId: n.inboxId,
              base,
            });
          }
          // NOTE: Recovered: a successful answer clears any previously surfaced turn error.
          if (outcome === "posted" && n.conversationId !== null) {
            await clearConversationError({
              tenantId: params.tenantId,
              instanceId: params.instanceId,
              chatwootConversationId: n.conversationId,
              base,
            });
          }
        } catch (err) {
          logger.error(
            "chatwoot agent turn failed (conv=%s): %s",
            convLabel,
            err instanceof Error ? err.message : String(err),
          );
          // A live turn the pool never gave a connection to, before any tool could act, is not a turn
          // that failed: the same turn a little later answers it, so it goes to the delivery's
          // recovery, which retries and hands over when it gives up. A model call alone has no effect
          // outside; once a tool started, a replay could repeat it, so that one fails here like any other.
          const owedToRecovery =
            claimFrom === "PENDING" &&
            !toolStarted &&
            isTransactionNeverStarted(err);
          // NOTE: Surface the failure to the operator (sanitized) so they can re-engage.
          if (n.conversationId !== null) {
            await recordConversationError({
              tenantId: params.tenantId,
              instanceId: params.instanceId,
              chatwootConversationId: n.conversationId,
              error: err,
              base,
            });
          }
          if (owedToRecovery) throw new TurnOwedToRecovery(convLabel, err);
          // A recovery's own pass announces nothing: its caller puts the row back for the next
          // attempt, and a hand-over now would make that attempt stand down. The recovery hands the
          // conversation over when it gives up (`announceUnanswered`).
          if (n.conversationId !== null && claimFrom === "PENDING") {
            // When nothing else is coming, say so INSIDE Chatwoot and hand the conversation over: there is
            // no retry here, so only a newer message's turn can still answer. Read by the announcer, so it
            // describes the moment of the hand-over.
            const conversationId = n.conversationId;
            const triggerId = n.message?.id ?? null;
            await announceFailedTurn({
              tenantId: params.tenantId,
              instanceId: params.instanceId,
              chatwootConversationId: conversationId,
              assess: async () => ({
                path: "direct",
                fence: await readDirectFence({
                  tenantId: params.tenantId,
                  instanceId: params.instanceId,
                  chatwootConversationId: conversationId,
                  triggerId,
                  base,
                }),
              }),
              aboutMessageId: triggerId,
              error: err,
              base,
            });
          }
          // NOTE: A turn that THREW after the flip leaves through here, and the message is the observer's just
          // the same; asked here so the ingestion and watermark treat it as observed. An answer nobody got
          // fails the delivery for the sweep, as on the stand-down above.
          if (rt !== null) {
            const observes = await agentObservesNow(
              params.tenantId,
              rt.agentId,
              base,
            );
            if (observes === "unreadable") {
              throw new Error(
                `chatwoot: the turn failed and whether the agent observes could not be read (conv=${convLabel}); leaving the delivery for the sweep`,
              );
            }
            if (observes === "yes") handedToObserver = true;
          }
        }
        if (standDownUnreadable) {
          throw new Error(
            `chatwoot: the turn stood down and whether the agent observes could not be read (conv=${convLabel}); leaving the delivery for the sweep`,
          );
        }
      }

      // NOTE: Redirect follow-up: (re)arm the cross-channel ladder now that this message's turn was
      // dispatched, ONLY for a message on the WIDGET conversation of a channelRedirect agent (its
      // widgetInboxId, never the WhatsApp entry inbox). Reuses `rt`. Re-arming on every message is the
      // cancel-on-reply (armRedirectChatFollowUp). Not for a message handed to the observer: nothing is
      // owed, and the ladder is retired at the bottom instead. Best-effort.
      if (
        rt &&
        !handedToObserver &&
        n.inboxId !== null &&
        n.conversationId !== null
      ) {
        const redirectCfg = readChannelRedirectConfig(rt.settings);
        if (redirectCfg.enabled && redirectCfg.widgetInboxId === n.inboxId) {
          try {
            await armRedirectChatFollowUp({
              tenantId: params.tenantId,
              instanceId: params.instanceId,
              widgetThreadId: chatwootThreadId(
                params.tenantId,
                params.instanceId,
                n.conversationId,
              ),
              agentId: rt.agentId,
              entryInboxId: redirectCfg.entryInboxId,
              // NOTE: From the EVENT, not the mirrored row: a mirror write whose ladder retirement was rejected
              // holds the pairing back, and reading the row would stamp the episode being left behind.
              originDisplayId: n.redirectOriginDisplayId,
              cfg: redirectCfg,
              base,
            });
          } catch (err) {
            logger.warn(
              "channel-redirect: arm chat follow-up failed (conv=%s): %s",
              convLabel,
              errMsg(err),
            );
          }
        }
      }
    }
  } else if (act) {
    // Actionable conversation, but NOT a new incoming message: a message_updated (e.g. our own
    // STT/vision write-back, re-dispatched by the fork) or a conversation event. The mirror already
    // applied above; the agent must not act, or the write-back → update cycle would loop.
    logger.info(
      "chatwoot: no agent action (conv=%s event=%s) — mirror only (not a new incoming message)",
      convLabel,
      n.event,
    );
  } else {
    // The same two readings the gate decided on: a line explaining a decision names its inputs.
    // `n.status` is the payload's proposal, a different moment, and would report a status-closed gate as
    // `ownership_lost` at `pending`.
    const closed = describeClosedGate({
      assigneeType: effectiveAssigneeType,
      status: effectiveStatus,
    });
    logger.info(
      "chatwoot: bot silent by gate (conv=%s event=%s newIncoming=%s reason=%s status=%s)",
      convLabel,
      n.event,
      isNewIncoming,
      closed.outcome,
      effectiveStatus ?? "unknown",
    );
    // NOTE: The operator's trail, narrower than this branch: ONE line per customer message the bot did
    // not answer, never per event. Refused messages reach only this gate, so without it the silence has
    // nothing behind it. A `message_updated` is usually our own write-back, and a switched-off agent was
    // never going to answer, so lines there would give the wrong reason.
    if (
      isNewIncoming &&
      rt?.enabled &&
      !observing &&
      mirror.conversationRowId !== null
    ) {
      emitFlowEvent(
        {
          tenantId: params.tenantId,
          turnId: crypto.randomUUID(),
          source: "inbox",
          conversationId: mirror.conversationRowId,
          agentId: rt.agentId,
          base,
        },
        { stage: "handoff", status: "ok", detail: closed },
      );
    }
  }

  // NOTE: A new inbound message the bot deliberately leaves unanswered (human-owned, or consumed by a
  // gate) still advances the handled watermark: it is context, not a pending task, or the first flush
  // after a hand-back re-answers the human-era backlog. When a turn WILL run, the turn owns the advance.
  // A consumed exit asks the mode fresh (`rt` predates the gate): flipped to monitoring, the message
  // must wait for the observer's ingestion instead of being marked and settled ahead of it.
  if (consumed && !handedToObserver && isNewIncoming && rt !== null) {
    const observes = await agentObservesNow(params.tenantId, rt.agentId, base);
    if (observes === "unreadable") {
      throw new Error(
        `chatwoot: the gate consumed the message and whether the agent observes could not be read (conv=${convLabel}); leaving the delivery for the sweep`,
      );
    }
    if (observes === "yes") handedToObserver = true;
  }
  // NOTE: The eager media pass for a consumed message newly handed to the observer: a test agent's
  // consuming gate ran neither pass, so the ingestion would remember an audio as a marker. The
  // memory-only replay enters the same way (it suppresses the turn, where a test agent's pass lives).
  // Idempotent, and asked only where no pass ran.
  if (
    rt !== null &&
    !(rt.enabled && ingestsContinuously(rt.mode)) &&
    ((handedToObserver && consumed) || params.owesMemoryOnly === true)
  ) {
    await runEagerMedia(params.tenantId, params.instanceId, n, base, {
      conversationId: mirror.conversationRowId,
      agentId: rt.agentId,
      inboxId: rt.inboxId,
      chatwootInboxId: rt.chatwootInboxId,
      deliveryRowId: params.deliveryRowId,
      sleep: params.deps?.sleep,
      deps: params.deps,
      // NOTE: A consumption whose cause this line does not know, or a replay that asked no gate.
      admission: admissionFromGate(),
      watcherPermit: (agentId, settings) =>
        observerMayObserve({ agentId }, settings),
    });
  }
  // The observer marks only after its ingestion has the message (queued, or nothing to queue):
  // marked ahead, a missing thread or a failed enqueue loses it for good. No thread: unmarked and
  // unsettled; a FAILED enqueue fails the delivery for the sweep's recovery (./recover-delivery.ts).
  // The other two reasons (human-held context, a deliberate consume) mark ahead of the ingestion,
  // except under an observer, where every mark follows the enqueue's answer.
  const observerHolds = (observing || handedToObserver) && isNewIncoming;
  // NOTE: A watched reply on the widget conversation still retires the redirect ladder: an observer
  // never reaches the re-arm that doubles as cancel-on-reply, and a later flip to production would
  // send a template to a lead who answered. Compared against the RUNTIME's inbox (a sparse payload
  // names none), and asked once the hand-over is known.
  if (observerHolds && rt !== null && n.conversationId !== null) {
    const redirectCfg = readChannelRedirectConfig(rt.settings);
    if (
      redirectCfg.enabled &&
      redirectCfg.widgetInboxId === rt.chatwootInboxId
    ) {
      try {
        await retireRedirectFollowUp(
          params.tenantId,
          chatwootThreadId(
            params.tenantId,
            params.instanceId,
            n.conversationId,
          ),
          base,
        );
      } catch (err) {
        logger.warn(
          "channel-redirect: retiring the ladder on a watched reply failed (conv=%s): %s",
          convLabel,
          errMsg(err),
        );
      }
    }
  }
  const markHandledAndSettle = async (opts: {
    // NOTE: What a FAILED watermark advance means for the settlement. "settle" for the marks that never
    // depended on ingestion (a miss only widens a re-coalesce). Under an observer the mark IS the
    // hand-over's closing write, so the settlement waits and the sweep reruns the path (the queued
    // ingestion is idempotent by message id).
    onWatermarkFailure: "settle" | "leave-for-sweep";
  }): Promise<void> => {
    const messageId = n.message?.id;
    const conversationRowId = mirror.conversationRowId;
    if (messageId == null || conversationRowId === null) return;
    // NOTE: The fact the watermark records, on the ledger: a human owns the conversation or a gate
    // consumed the message, so a crash did not lose it. Scoped to this delivery when another BOT holds
    // it (that bot's row may be live), wider otherwise. THE WATERMARK FIRST: two writes, no transaction,
    // and settled first a crash leaves a terminal row below the mark, so a later flush ANSWERS a message
    // a gate suppressed, silently; mark first leaves a wrong but VISIBLE loss line. Wrong and visible
    // beats quiet and wrong. The mark belongs to the reply path: beside a responder, or on the replay of
    // a stand-down beside another bot (`settleScopedToThisDelivery`), moving it would get that route's
    // turn refused by `claimReplyBurst`. Alone, the observer keeps it so a later responder skips the backlog.
    if (!responderMayAnswer && params.settleScopedToThisDelivery !== true) {
      try {
        await advanceHandledWatermark({
          tenantId: params.tenantId,
          conversationDbId: conversationRowId,
          toMessageId: messageId,
          // NOTE: One message, by id: a webhook delivery carries exactly one, so this exit names its dispensal.
          dispensed: { kind: "messages", messageIds: [messageId] },
          base,
        });
      } catch (err) {
        logger.warn(
          "chatwoot: advance handled watermark failed (conv=%s): %s",
          convLabel,
          errMsg(err),
        );
        if (opts.onWatermarkFailure === "leave-for-sweep") {
          throw new Error(
            `chatwoot: the observed message's watermark could not be advanced (conv=${convLabel}); leaving the delivery for the sweep`,
          );
        }
      }
    }
    await settleDelivery(
      messageId,
      "consumed",
      // NOTE: No turn takes this path, so nothing invoked a graph.
      false,
      // NOTE: From the row when it says so: on a replay, the stand-down may have happened beside another
      // AgentBot, and the wider scope now would retire that bot's own row with nobody having answered.
      settleScopedHere ? "this-delivery" : "conversation",
    );
  };
  // When the ingestion is what will hold the message, the settlement waits for it: this code
  // runs long before the continuous ingestion, and a failed enqueue behind a closed row and an advanced
  // mark leaves the message in no memory and in no later turn. Both halves (`!act` and a gate's
  // `consumed`) wait, since `owes_memory_only` keeps a replay from answering over the gate. A replay
  // that owes memory only enters as `!act` would, or the next burst answers it. `!observerHolds` keeps
  // this disjoint from the observer's stop below. See docs/graph.md, "Continuous ingestion".
  const settlesHere =
    isNewIncoming &&
    (!act || consumed || params.owesMemoryOnly === true) &&
    !observerHolds;
  // Waits in both halves, and for the recorded duty too (`owesMemoryOnly`, replay only), not just
  // `routeRemembers`: otherwise a test-mode route's replay would enqueue the append without the row
  // waiting for it. Narrow otherwise: a route that never attempts ingestion (test, off, no runtime)
  // settles at once, or every such delivery would strand and go DEAD.
  const settleAwaitsIngest =
    settlesHere && (routeRemembers || params.owesMemoryOnly === true);
  // NOTE: What this pass owes, recorded where it is decided and BEFORE the arm that can fail: the
  // column is read only on passes where the arm failed, so a write beside the arm would be null
  // exactly when it matters. Without it the replay rebuilds ownership half an hour later, finds the
  // bot back, and posts a reply nobody is owed. Best-effort: a missed write reads null, as before.
  if (settlesHere) {
    await runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.chatwootWebhookDelivery.updateMany({
        where: { id: params.deliveryRowId },
        // NOTE: Both facts at the one instant both are true, with the scope from the expression
        // `markHandledAndSettle` settles with.
        data: {
          owesMemoryOnly: true,
          settleScopedToThisDelivery: settleScopedHere,
        },
      }),
    ).catch((err) => {
      logger.warn(
        "chatwoot: could not record that this delivery owes memory only (conv=%s): %s; a replay of it may answer a message nobody is waiting on",
        n.conversationId === null ? "?" : String(n.conversationId),
        errMsg(err),
      );
    });
  }
  if (settlesHere && !settleAwaitsIngest) {
    await markHandledAndSettle({ onWatermarkFailure: "settle" });
  } else if (settlesHere && consumed) {
    // A recusa de resposta sai agora, só a linha espera: na metade do PORTÃO a conversa segue do
    // bot, e o flush que roda quando o portão abre coalesce a partir da marca; o `dispensed` é o que
    // tira esta mensagem daquela rajada. Não vale para `!act`: atrás de uma pessoa nenhum flush roda.
    // A linha continua não terminal, então a memória segue devida e visível. Sem linha do espelho ou
    // sem id não há o que dispensar (as guardas de `markHandledAndSettle`).
    const dispensaConv = mirror.conversationRowId;
    const dispensaMsg = n.message?.id;
    await (dispensaConv === null || dispensaMsg == null
      ? Promise.resolve()
      : dispenseMessagesFromReply({
          tenantId: params.tenantId,
          conversationDbId: dispensaConv,
          messageIds: [dispensaMsg],
          base,
        })
    ).catch((err) => {
      // NOTE: Best-effort e não lançado: o trabalho da entrega é a ingestão. Uma dispensa que falha só
      // devolve a exposição de o flush responder a mensagem calada; a linha não terminal segue cobrando a
      // memória.
      logger.warn(
        "chatwoot: could not record that a gate refused a reply to this message (conv=%s): %s; a later burst may answer it",
        convLabel,
        errMsg(err),
      );
    });
  }

  // A person answered the customer: end the agent's attendance by moving the conversation to the
  // human queue, since Chatwoot itself leaves it `pending` (docs/chatwoot.md, "A person answering the
  // customer ends the attendance"). `act` is only the fence's first half; the shared unit's versioned
  // CAS on the mirrored row is the second, or the toggle could overwrite a fresh resolve or hand-back.
  // Idempotent by the gate. Production only, not "enabled only": a takeover is a fact about the
  // conversation. Test agents are excluded (an operator mid-test would silence it). Best-effort.
  const humanReplyBy = newHumanReplyRoute(n, {
    whatsappProvider: rt?.whatsappProvider ?? null,
  });
  if (
    humanReplyBy !== null &&
    act &&
    rt?.mode === "production" &&
    n.conversationId !== null &&
    readTakeoverConfig(rt.settings).onHumanReply
  ) {
    const conversationId = n.conversationId;
    await runHumanReplyTakeover({
      tenantId: params.tenantId,
      instanceId: params.instanceId,
      conversationId,
      route: humanReplyBy,
      // NOTE: The ROUTE's bot, the identity `act` asked about: asking the inbox persona instead makes a
      // stricter second gate that neither fanned delivery passes, leaving the answered conversation
      // `pending`. The token stays the inbox persona's: the fence asks whether THIS DELIVERY may act, the
      // token who we are on this instance.
      ourAgentBotId: params.agentBotId,
      agentId: rt.agentId,
      decidedAtVersion: n.conversationUpdatedAt ?? null,
      decidedAtMessageId: n.message?.id ?? null,
      conversationRowId: mirror.conversationRowId,
      lastEventAt: mirror.lastEventAt,
      base,
      makeClient: params.deps?.makeClient,
    });
  }

  // Continuous ingestion (enabled production or monitoring) folds what no turn handled into the
  // memory thread. A monitoring agent, or a message handed to the observer inside the turn, passes
  // `act` as false (no turn covers it). Not beside a responder of ours that remembers it (the
  // duplicate), nor a control command that responder handles: folded in, a racing /reset could be
  // appended back after the reset. Only where the responder REALLY handles it (test mode, a route,
  // switch not required since a disabled test agent still consumes /reset); otherwise it is text.
  const responderCommand =
    command !== null &&
    observer !== null &&
    responderRt !== null &&
    responderRt.mode === "test" &&
    responderHasRoute &&
    // NOTE: ...and only if that responder's route actually RECEIVED it (not bound after emission).
    responderCovers;
  // Asked again, after the analysis: the top's value is the wire's, and the eager pass may have
  // produced the words since. Read from the top, the retry and failure guard below would stand down
  // on the very delivery that paid for the transcription.
  const carriesTranscription = inboundTranscriptionOnUpdate(n) !== null;
  let ingested: IngestOutcome = "nothing";
  // Whether this route ingests at all, hoisted so a route that cannot (silent, which a
  // memory-only recovery reads as "nobody looked") differs from one that stands down for the responder
  // (which must say so). `routeRemembers` is the recorded fact; `handedToObserver` corrects it below;
  // `stoodDownUnread` is a message's last chance on a test agent that does not ingest continuously; and
  // `owesMemoryOnly` is the recorded duty of the pass a replay repeats, whose turn is suppressed.
  const routeIngests =
    rt !== null &&
    (routeRemembers ||
      handedToObserver ||
      stoodDownUnread ||
      // NOTE: `rt.enabled` survives the duty: the recorded duty only waives the continuous mode, and
      // enqueueing against a switch just turned off would declare success over it; the row stays
      // recoverable until the agent is back.
      (rt.enabled && params.owesMemoryOnly === true));
  // NOTE: The record follows the hand-over: a claim that recorded `false` and then handed the message
  // to a watcher must say `true`, or the observer beside it, trusting the record, appends a duplicate.
  // Guarded on the value it corrects (only `false` to `true`); best-effort, since failing the delivery
  // would trade a duplicate line for a missing one.
  if (routeIngests && !routeRemembers) {
    await runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.chatwootWebhookDelivery.updateMany({
        where: { id: params.deliveryRowId, routeRemembers: false },
        data: { routeRemembers: true },
      }),
    ).catch((err) => {
      logger.warn(
        "chatwoot: could not record that this delivery handed the message to a watcher (conv=%s): %s; an observer beside it may append the same message a second time",
        n.conversationId === null ? "?" : String(n.conversationId),
        errMsg(err),
      );
    });
  }
  // NOTE: For the type checker: the narrowing from `routeIngests` does not survive the const.
  if (rt !== null && routeIngests && !responderRemembers && !responderCommand) {
    // Whose memory the append is filed under, which decides whose compaction settings summarise
    // the attendance. Both routes can arm the same job (the observer appends a colleague's reply until
    // the responder's delivery finishes) and the later arm wins, so it is the responder whenever it
    // received the message and remembers continuously; beside other watchers, the first of them
    // (`inboxWatchers`), the same answer on every watcher's route; otherwise the route's own agent.
    const memoryOwner: { agentId: bigint; settings: unknown } =
      observer !== null &&
      responderRt !== null &&
      responderCovers &&
      responderRt.enabled &&
      ingestsContinuously(responderRt.mode)
        ? responderRt
        : observer !== null
          ? watcherMemoryOwner(await watchers(), rt)
          : rt;
    ingested = await ingestUnhandledMessage({
      tenantId: params.tenantId,
      instanceId: params.instanceId,
      deliveryRowId: params.deliveryRowId,
      n,
      // NOTE: `act` means "a turn covered this" from here on, and for `stoodDownUnread` and a memory-only
      // replay none did (the replay's turn gate silenced it). Left true, the ingestion returns "nothing"
      // and the replay closes the row as recovered with nothing enqueued, a silent loss.
      act:
        act &&
        !observing &&
        !handedToObserver &&
        !stoodDownUnread &&
        params.owesMemoryOnly !== true,
      consumed,
      agentId: memoryOwner.agentId,
      compactionEnabled: readMemoryConfig(memoryOwner.settings).compaction
        .enabled,
      whatsappProvider: rt.whatsappProvider,
      // NOTE: Read only when the payload names none, from the row the mirror just wrote; a failed read
      // leaves the message where a payload without a contact-inbox always did.
      storedContactInboxId:
        n.contactInboxId ??
        (await storedContactInboxId(
          params.tenantId,
          mirror.conversationRowId,
          base,
        )),
      // NOTE: ...and a LATE TRANSCRIPTION on any route: the words come around once, on the write-back,
      // and no turn will cover them.
      retryArm:
        observing ||
        handedToObserver ||
        carriesTranscription ||
        // NOTE: The append is the last chance here too: no turn will cover it.
        stoodDownUnread,
      sleep: params.deps?.sleep,
      base,
    });
    // NOTE: Inside the branch, so silence means the ingestion never ran rather than that it ran and
    // found nothing. That is the distinction the recovery reads (see `onIngest`).
    params.onIngest?.(ingested);
    // NOTE: The record follows the OUTCOME: `failed` and `no-thread` break the promise the claim wrote,
    // and left `true` the row would tell the observer beside it, and the recovery of a strand
    // (./recover-human-reply.ts re-arms the append), that the append happened. `nothing` breaks no
    // promise. Guarded to move only `true` to `false`; best-effort like its twin above.
    if (ingested === "failed" || ingested === "no-thread") {
      await runScopedOn(base, sysCtx(params.tenantId), (db) =>
        db.chatwootWebhookDelivery.updateMany({
          where: { id: params.deliveryRowId, routeRemembers: true },
          data: { routeRemembers: false },
        }),
      ).catch((err) => {
        logger.warn(
          "chatwoot: could not record that this delivery failed to fold the message in (conv=%s): %s; an observer beside it may stay quiet about a message nothing remembers",
          n.conversationId === null ? "?" : String(n.conversationId),
          errMsg(err),
        );
      });
    }
  } else if (routeIngests) {
    // NOTE: A route that INGESTS, standing down on purpose (the responder has the message or will
    // consume it as a command). Reported: a deliberate stand-down answers the recovery's "did anything
    // look at this message", and silence would requeue a handled row until its attempts ran out.
    params.onIngest?.("covered");
  } else if (observer?.enabled === true && responderRt === null) {
    // NOTE: A switched-on observer with no responder to remember for: a decision, reported for the same
    // reason, or every replay would read "no route asked" and return to DEAD. A switched-off observer
    // stays silent: the message waits for its switch.
    params.onIngest?.("no-reader");
  }
  // NOTE: A colleague's reply nobody could remember (`failed`: retries spent; `no-thread`: nowhere to
  // hold it, permanent) is reported as an `error` line on the conversation, on EVERY route: this is the
  // business half of a handed-off attendance, and `warn` would file its loss below what an operator
  // reads. The record stands even though the sweep may still recover it. Keyed on the RESOLVED
  // `humanReplyBy`, the role the ingestion uses, not the payload's shape: on a provider that does not
  // reserve echo ids that shape includes our own reply echoing back, which reaches `no-thread` before
  // the role is computed and would page about a reply no person wrote.
  if (
    (ingested === "failed" || ingested === "no-thread") &&
    humanReplyBy !== null &&
    rt !== null &&
    mirror.conversationRowId !== null
  ) {
    logger.error(
      ingested === "failed"
        ? "chatwoot: a colleague's reply could not be remembered (conv=%s): the ingest job was not queued"
        : "chatwoot: a colleague's reply could not be remembered (conv=%s): the conversation names no contact-inbox thread to hold it",
      convLabel,
    );
    emitFlowEvent(
      {
        tenantId: params.tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: mirror.conversationRowId,
        agentId: rt.agentId,
        base,
      },
      {
        stage: "memory",
        level: "error",
        status: "error",
        detail: {
          reason:
            ingested === "failed"
              ? "human_reply_not_remembered"
              : "human_reply_no_thread",
          messageId: n.message?.id ?? null,
          ...(ingested === "failed" ? { attempts: INGEST_ARM_ATTEMPTS } : {}),
        },
      },
    );
  }
  // NOTE: E a linha fica para a varredura, que arma a recuperação por id da resposta
  // (./recover-human-reply.ts). Lança em vez de re-armar aqui porque o enfileiramento acabou de falhar
  // quatro vezes; a varredura roda meia hora depois. `no-thread` não entra: a releitura acharia o
  // mesmo nada, e a perda já foi relatada acima. A recuperação é só de memória: não posta nem mexe na posse.
  if (
    ingested === "failed" &&
    humanReplyBy !== null &&
    rt !== null &&
    mirror.conversationRowId !== null
  ) {
    throw new Error(
      `chatwoot: a colleague's reply could not be remembered (conv=${convLabel}); leaving the delivery for the sweep`,
    );
  }
  // NOTE: A late transcription holds the delivery the same way, on every route: `observerHolds` is
  // inbound-only, so a failed enqueue would settle the row PROCESSED and lose the words for good.
  // There is no turn here by construction (an update drives none); where a turn did answer, the
  // ingestion returns "nothing". The throws here leave the row PROCESSING on purpose: the sweep
  // declares it `owed-transcription` and the replay re-runs this path.
  if (carriesTranscription && ingested === "failed") {
    throw new Error(
      `chatwoot: the late transcription could not be armed for ingestion (conv=${convLabel}); leaving the delivery for the sweep`,
    );
  }
  // NOTE: "no-thread" is left to settle: with no contact-inbox the words have nowhere to go and a
  // replay would find the same nothing. Logged at `warn`, like the observer's inbound branch.
  if (carriesTranscription && ingested === "no-thread") {
    logger.warn(
      "chatwoot: a late transcription arrived (conv=%s) but the conversation names no contact-inbox thread to hold it",
      convLabel,
    );
  }
  // NOTE: A liquidação que esperou a ingestão acontece aqui: fecha com a ingestão segurando a mensagem,
  // ou com `"nothing"` (nada a lembrar) e `"no-thread"` (sem onde guardar); um enfileiramento que
  // falha lança e deixa a linha em PROCESSING para a varredura. O replay não responde de novo porque
  // `owesMemoryOnly` desarma o turno, o `act` da ingestão e o avanço da marca.
  if (settleAwaitsIngest) {
    if (ingested === "failed") {
      // NOTE: A causa vai na mensagem: as duas metades chegam aqui (uma pessoa na conversa, ou um portão
      // que calou a mensagem), e o operador precisa saber qual.
      throw new Error(
        `chatwoot: ${
          consumed
            ? "a gate silenced the customer's message"
            : "a person owns the conversation"
        } (conv=${convLabel}) and the ingestion of the customer's message could not be armed; leaving the delivery for the sweep`,
      );
    }
    await markHandledAndSettle({ onWatermarkFailure: "leave-for-sweep" });
  }
  // A parada por posse (uma pessoa assumiu enquanto o turno esperava) só fecha com a ingestão
  // SEGURANDO a mensagem: `"queued"` é a única saída assim, e a única que prova que a ingestão correu.
  // Todo o resto fica para a varredura: enfileiramento que falhou; ingestão que nem correu (uma
  // vinculação entre as duas leituras deixa `rt` nulo, e o throw da janela 1 não cobre replay); e
  // `"no-thread"`, aqui um desacordo transitório entre leituras, já que no caminho direto nenhuma
  // marca guarda a mensagem. `"nothing"` não chega aqui: `act` vai falso e o papel é `customer`.
  const standDownKept = ingested === "queued";
  if (stoodDownUnread && !standDownKept) {
    // NOTE: O que esta passada devia, gravado antes do throw: uma pessoa que assume DURANTE o turno
    // deixa `settlesHere` falso, e sem a coluna o replay re-derivaria a posse, acharia o bot de volta e
    // rodaria o turno inteiro, postando. Best-effort (o throw leva a linha à varredura de todo modo), com
    // a largura da mesma expressão da liquidação.
    await runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.chatwootWebhookDelivery.updateMany({
        where: { id: params.deliveryRowId },
        data: {
          owesMemoryOnly: true,
          settleScopedToThisDelivery: settleScopedHere,
        },
      }),
    ).catch((err) => {
      logger.warn(
        "chatwoot: could not record that the stood-down delivery owes memory only (conv=%s): %s; a replay of it may answer a message a person already took over",
        convLabel,
        errMsg(err),
      );
    });
    throw new Error(
      `chatwoot: a person took the conversation over while the turn waited (conv=${convLabel}) and ${
        ingested === "failed"
          ? "the ingestion of the message could not be armed"
          : ingested === "no-thread"
            ? "the ingestion found no thread to put the message in"
            : "no ingestion ran over the message, so nothing holds it"
      }; leaving the delivery for the sweep`,
    );
  }
  // NOTE: The observer's settlement follows the enqueue (see the note above the mark); a failed one
  // throws and leaves the row PROCESSING for the sweep's recovery.
  if (observerHolds) {
    if (ingested === "failed") {
      throw new Error(
        `chatwoot: the observer's ingestion could not be armed (conv=${convLabel}); leaving the delivery for the sweep`,
      );
    }
    // NOTE: A SWITCHED-OFF observer marks nothing: its ingestion refuses, so a mark would hide the
    // message behind the watermark with no memory. Unmarked, it stays ABOVE the watermark, where the
    // flush after a flip to production reads (`promotedToProduction`) and where an operator sees the
    // silence began. Re-enabling monitoring arms nothing, so that gap stays until such a flip.
    if (observer !== null && !observer.enabled && !responderRemembers) {
      logger.warn(
        "chatwoot: the observer is switched off (conv=%s); the message is neither remembered nor marked",
        convLabel,
      );
    } else if (ingested === "no-thread") {
      logger.warn(
        "chatwoot: the agent observes (conv=%s) but the conversation has no contact-inbox thread; leaving the message unmarked",
        convLabel,
      );
    } else {
      await markHandledAndSettle({ onWatermarkFailure: "leave-for-sweep" });
    }
  }
  // NOTE: A parada por posse fecha a contabilidade depois que a ingestão pegou a mensagem: sem a marca
  // ela fica ACIMA dela já estando na memória, e o próximo flush a selecionaria de novo. Com
  // `leave-for-sweep` como o observador: a marca é a escrita que fecha esta parada. O throw acima já
  // garantiu que a mensagem está guardada.
  if (stoodDownUnread) {
    await markHandledAndSettle({ onWatermarkFailure: "leave-for-sweep" });
  }
  // NOTE: The watcher's verdict: a customer message on an observed conversation arms the OBSERVE row,
  // best-effort (a late label is not a lost message). Only while the watcher is SWITCHED ON, or a
  // disabled observer's message gets relabelled once re-enabled. Who classifies is asked of the
  // BINDING, separately from who answers (`rt` is null for an observer whose bot holds the
  // conversation), deduplicated by agent. Not for a control command: it is the operator talking, and
  // after /reset the verdict would put the cleared labels back.
  if (
    isNewIncoming &&
    !commandActive &&
    n.conversationId !== null &&
    ingested !== "failed"
  ) {
    const conversationId = n.conversationId;
    const bound = await boundObserverRuntime(
      params.tenantId,
      params.instanceId,
      params.agentBotId,
      {
        chatwootInboxId: n.inboxId,
        chatwootConversationId: conversationId,
      },
      base,
    ).catch((err) => {
      logger.warn(
        "chatwoot: reading the inbox's observer binding for the verdict failed (conv=%s): %s",
        String(conversationId),
        errMsg(err),
      );
      return null;
    });
    // The hand-over answer, not the snapshot's `enabled`: `handedToObserver` comes from a FRESH read
    // (enabled and monitoring), and gating it on the loaded `rt.enabled` would reject an agent switched
    // on inside this delivery, which `bound` cannot cover (a responder holds no observer row).
    const watchers =
      rt !== null && (handedToObserver || (rt.enabled && observing))
        ? [rt]
        : [];
    if (bound?.enabled && !watchers.some((w) => w.agentId === bound.agentId))
      watchers.push(bound);
    // Only the reply-route answer can be an attach-window one: `bound` IS the row, and "no row"
    // there is as often the post-detach state.
    const attachingAgentId =
      observerHolds && rt !== null && observerAttaching ? rt.agentId : null;
    // A hand-over means `rt.settings` predates the flip, and the edit that flips the mode usually
    // adds the label groups, so the old bag would answer `off`. `boundObserverRuntime` cannot cover it
    // (a responder holds no observer row). One read on a rare path; unreadable keeps the snapshot.
    const freshSettings =
      handedToObserver && !observing && rt !== null
        ? await runScopedOn(base, sysCtx(params.tenantId), (db) =>
            db.agent.findUnique({
              where: { id: rt.agentId },
              select: { settings: true },
            }),
          )
            .then((a) => a?.settings ?? null)
            .catch((err) => {
              logger.warn(
                "chatwoot: re-reading the handed-over watcher's settings failed (conv=%s): %s",
                String(conversationId),
                errMsg(err),
              );
              return null;
            })
        : null;
    for (const watcher of watchers) {
      const settings =
        freshSettings !== null && watcher.agentId === rt?.agentId
          ? freshSettings
          : watcher.settings;
      const permit = await observerMayObserve(watcher, settings);
      if (!permit) continue;
      await armObserve({
        tenantId: params.tenantId,
        instanceId: params.instanceId,
        conversationId,
        agentId: watcher.agentId,
        reason: "burst",
        cfg: readMonitoringConfig(settings),
        // The message this burst is about, in Chatwoot's own sequence: the reset fence the tick is
        // held to is asked in that order and in no other.
        atMessageId: n.message?.id ?? null,
        attaching: watcher.agentId === attachingAgentId,
        gateAskedAt: permit.askedAt,
        base,
      });
    }
  }

  // tx2: mark processed. NOTE: a crash between tx1 and tx2 strands the row in PROCESSING; the stranded
  // delivery sweep (./delivery-sweep.ts) reports it and arms a recovery, which comes back through this
  // function with `claimFrom: "DEAD"` (./recover-delivery.ts), so the payload is not kept past the
  // claim. By ID with no CAS on purpose: a turn outliving the sweep's threshold finds its row DEAD,
  // and winning here leaves it true. See docs/chatwoot.md, "Webhook receiver" (the two windows left open).
  await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.chatwootWebhookDelivery.update({
      where: { id: params.deliveryRowId },
      data: { status: "PROCESSED", processedAt: new Date() },
    }),
  );
  return "processed";
}
