import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import {
  broadcastAgentActivity,
  broadcastConversationEvent,
} from "@/api/features/realtime/realtime.service";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import {
  chatwootThreadId,
  contactInboxThreadId,
  getCheckpointer,
  resolveGraphThreadId,
} from "@/graph/checkpointer";
import { isTurnInFlight } from "@/graph/inflight";
import type { IngestRole } from "@/graph/ingest";
import { armIngest } from "@/graph/ingest-job";
import { loadAgentConfig } from "@/graph/prepare";
import { type RuntimeDeps, runAgentTurn } from "@/graph/runtime";
import { threadBusyForResetOn, turnOwnsThread } from "@/graph/thread-claim";
import { AppError, UnauthorizedError } from "@/lib/errors";
import { withKeyedQueue } from "@/lib/locks";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
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
import { retireCoveredDeliveries } from "@/modules/chatwoot/delivery-sweep";
import {
  describeClosedGate,
  type GateCloseDetail,
} from "@/modules/chatwoot/gate-close";
import type { AuthContext } from "@/modules/contact-auth/check";
import {
  authorizeContact,
  type ContactAuthOutcome,
  contactAuthFlowEvent,
} from "@/modules/contact-auth/service";
import { readContactAuthConfig } from "@/modules/contact-auth/settings";
import {
  type ContactAuthNotice,
  claimContactAuthNotice,
  contactAuthNoticeKey,
  releaseContactAuthNotice,
} from "@/modules/contact-auth/state";
import {
  clearConversationError,
  recordConversationError,
} from "@/modules/conversations/error";
import {
  announceFailedTurn,
  readDirectFence,
} from "@/modules/conversations/failure-note";
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
  readHandledWatermark,
} from "@/modules/debounce/watermark";
import { emitCommandDropped } from "@/modules/flowlog/command";
import { emitFlowEvent } from "@/modules/flowlog/service";
import { emitUnroutedMessage } from "@/modules/flowlog/unrouted";
import { armCompaction } from "@/modules/memory/compact";
import { clearContactMemory } from "@/modules/memory/reset";
import { readMemoryConfig } from "@/modules/memory/settings";
import {
  cancelPendingJob,
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
  extractInboundFile,
  resolveVisionConfig,
} from "@/modules/vision/service";
import { hashRouteToken } from "@/modules/webhooks/inbound/route-token";
import type { ChatwootClient } from "./client";
import { type CommandRoute, commandRoute } from "./command-route";
import {
  type AgentBotIdentity,
  agentBotChatwootId,
  loadAgentBot,
  loadChatwootClient,
} from "./instance";
import { mirrorChatwootEvent } from "./mirror";
import {
  type ControlCommand,
  controlCommand,
  effectiveAssignee,
  firstAudioAttachment,
  firstLocationAttachment,
  firstVisualAttachment,
  heldByAnotherParty,
  incomingRenderable,
  isIncomingMessage,
  isNewHumanAgentMessage,
  isNewIncomingMessage,
  normalizeChatwootEvent,
  parseLiveConversation,
  shouldBotHandle,
} from "./normalize";
import { reconcileMirrorFromLive } from "./reconcile";
import { renderAttendantMessage, renderInboundMessage } from "./render";
import {
  awaitRouteTokenRefresh,
  noteRouteTokenLookup,
  type RouteTokenCacheHit,
  readRouteTokenCache,
  routeTokenCacheGeneration,
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

// Dedicated Chatwoot Agent Bot webhook receiver. Resolve tenant+instance by the opaque
// routeToken (constant-time hash probe) → verify the Agent Bot HMAC with the instance's stored
// secret (auth AFTER tenant resolution) → record an idempotency ledger row keyed by the
// X-Chatwoot-Delivery UUID → ack <5s. processChatwootDelivery runs detached and hands the
// normalized event to the runtime seam. The ledger does NOT store the payload (it is
// PII-bearing); the normalized event is passed in-memory to the detached processor.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

// Resolve the runtime knobs (enabled + mode) of the agent bound to a Chatwoot inbox (by its chatwoot
// inbox id), or null when the inbox is unbound/unknown. Used to decide — BEFORE the mirror, and even
// for a not-yet-mirrored conversation — whether a control command is "active" (commands /teste,/reset
// only apply to a test-mode agent; in production they are ordinary customer text) AND whether eager
// media analysis (STT/vision) should run on a message the agent may not reply to: that runs only for an
// ENABLED + PRODUCTION agent (disabled → nothing; test → only on the answer path). Inbox config exists
// long before any conversation, so this resolves correctly on a conversation's very first event.
async function inboxAgentRuntime(
  tenantId: bigint,
  instanceId: bigint,
  chatwootInboxId: number | null,
  base: PrismaClient,
): Promise<{
  agentId: bigint;
  // The Inbox DB row id, not the Chatwoot one the caller passed in: it is what ExecutionLog.inbox_id
  // and every other local column mean by "inbox". Selected here because this query already reads the
  // row — a caller that needs it otherwise pays for a second lookup of the same record.
  inboxId: bigint;
  enabled: boolean;
  mode: string;
  // The agent's raw settings JSON, carried through so a caller that already pays for this query can
  // read the channel-redirect config (widgetInboxId, closingEnabled, …) WITHOUT a second one — used
  // by the redirect follow-up arm (on a new incoming message) and the closing detection (on a
  // resolve). Left as `unknown`: most callers (the test-mode/eager-media gate) never touch it, so
  // parsing is deferred to readChannelRedirectConfig at the point of use.
  settings: unknown;
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
      select: { id: true, agentId: true },
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
      enabled: agent.enabled,
      mode: agent.mode,
      settings: agent.settings,
    };
  });
}

// The agent bound to a conversation's OWN (mirrored) inbox — its mode, and the two ids the same
// query already reads — or null when nothing resolves. Deliberately keyed by the conversation rather
// than by a payload inbox id: it is the
// reading `maybeConsumeCommandOrGate` already uses for the test-mode gate, and it exists so the
// question "is this command active?" and the gate that silences the conversation cannot be answered
// by two different rows (issue #270).
//
// It answers about the AGENT and says nothing about the route, which is the split that keeps this
// safe. Chatwoot fans one command out to the inbox's persona and to the conversation's assigned bot,
// so more than one delivery can reach here with the same command; `commandRoute` downstream is
// the single fence that picks which one runs it and consumes the rest. Answering the route question
// here too would give the losing delivery `commandActive === false`, which does not defer to that
// fence — it walks past it and hands the agent "/teste" as ordinary customer text.
//
// Only ever called on the path where the payload named no inbox, so the common delivery pays for no
// extra query.
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
    // NOTE: the ids come back with the mode because this query already read them, and the caller needs
    // them for the same reason it needs the mode: a sparse payload answered by this reading has an
    // agent, and a line that reports the command without naming it is attributable to nothing.
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

// Resolve the per-persona Agent Bot by its opaque route token (constant-time hash probe). The bot
// carries its own HMAC secret and instance — the route token namespaces the bot, so multiple bots on
// one instance (one per persona) never collide. Runs as super-admin: this is BEFORE tenant context.
async function resolveBotByRouteToken(
  token: string,
  base: PrismaClient,
): Promise<ResolvedChatwootBot | null> {
  // Cached in process: see route-token-cache.ts for why the ack path cannot afford this query.
  const webhookRouteTokenHash = hashRouteToken(token);
  // NOTE: A refresh already in flight means this entry is being questioned right now. Waiting on it costs a
  // millisecond on a healthy database and is what keeps an outage from being acked: without it every
  // request arriving before the refresh reports back would be served stale and lost, since Chatwoot
  // does not redeliver a 2xx. The request that STARTED the refresh is still served stale, and that
  // one event is the residual this design cannot close without a durable payload store (issue #228).
  //
  // BOUNDED, because a lookup that hangs is not a lookup that fails: an unbounded wait would put every
  // later delivery for this token behind a promise that never answers, which is the whole bot rather
  // than one event. Overrunning it throws, and the ack fails the same way rule three fails.
  // TWICE, and the second pass is what makes the coalescing hold under a BURST. Deliveries that
  // arrive together all find no refresh in flight and clear the wait as one; the first then registers
  // the refresh, and the cache withholds a stale answer while a refresh decides — so every other one
  // reads a miss and would fall through to open its own transaction. N deliveries, N-1 needless
  // interactive transactions, at exactly the moment the pool is tightest, which is the burst this
  // module exists to keep off Postgres. A miss that finds a refresh registered means somebody else
  // asked between our wait and our read: wait for THAT one instead of starting another.
  let cached = await servedFromCache(webhookRouteTokenHash, base);
  // A miss can mean somebody registered a refresh between our wait and our read, so look once more.
  // The second wait costs nothing when there is no refresh to wait on: it returns immediately.
  if (cached === undefined) {
    cached = await servedFromCache(webhookRouteTokenHash, base);
  }
  if (cached !== undefined) return cached.bot;

  return queryRouteToken(webhookRouteTokenHash, base);
}

// One pass of "wait for whoever is deciding, then read". Returns undefined on a miss, which is the
// caller's cue to look again or to go to Postgres itself.
async function servedFromCache(
  webhookRouteTokenHash: string,
  base: PrismaClient,
): Promise<RouteTokenCacheHit | undefined> {
  await awaitRouteTokenRefresh(webhookRouteTokenHash);
  const hit = readRouteTokenCache(webhookRouteTokenHash);
  // NOTE: A STALE ENTRY IS ANSWERED FROM MEMORY AND REFRESHED BEHIND THE ACK. Expiring into a blocking
  // query would put the lookup back inside the 5s budget on exactly the traffic that cannot
  // afford it: an instance quiet for longer than the TTL is cold on EVERY message, so the
  // first message of every conversation, the one that starts the turn, would pay for it.
  // The cache only reports `stale` while the last lookup reached Postgres, so this never acks on
  // the strength of a row the detached half will not be able to act on.
  if (hit?.stale) {
    void refreshRouteToken(webhookRouteTokenHash, base).catch((err) => {
      logger.warn("chatwoot: route token refresh failed: %s", errMsg(err));
    });
  }
  return hit;
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
        // Ignore a soft-disconnected account: the bot's webhook route may still exist in Chatwoot
        // until the unbind propagates, but we must stop handling its traffic (the rows are kept only
        // for history). Read through the relation: as a second findUnique it was a second
        // transaction on the one path that cannot afford one.
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
  // NOTE: Snapshotted BEFORE the read: an invalidation landing while this query is in flight has to win,
  // because the writer that invalidated already committed and this row predates that commit.
  const generation = routeTokenCacheGeneration();
  let row: Awaited<ReturnType<typeof readRouteTokenRow>>;
  try {
    row = await readRouteTokenRow(webhookRouteTokenHash, base);
    noteRouteTokenLookup(true);
  } catch (err) {
    // NOTE: A lookup that could not reach Postgres closes the stale window for EVERY token, so the next
    // ack blocks and fails instead of promising a 200 nothing can honour.
    noteRouteTokenLookup(false);
    throw err;
  }
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

// One refresh per token, and later arrivals wait on it rather than starting their own. THE FAILURE
// TRAVELS WITH THE PROMISE, because the waiters resume into a cache the failure just closed: swallow
// it here and each of them takes the blocking path and opens its own transaction, which is a burst
// against the pool at the moment the pool is what is broken. Inheriting it costs them one shared
// lookup and puts every one of their events on Chatwoot's retry ladder. The log belongs to the
// detached starter, which is the one caller with nowhere to return the failure to.
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
  // NOTE: no "duplicate" here any more. Deduping is a property of PROCESSING, not of acking, and it
  // now happens where the work does (recordAndProcessChatwootDelivery). Whether this exact delivery
  // was seen before does not change the answer Chatwoot needs, which is only "received".
  outcome: "queued" | "ignored";
  tenantId?: bigint;
  instanceId?: bigint;
  // The idempotency KEY (the X-Chatwoot-Delivery header, or a body digest when it is absent), not a
  // row id: the ledger row is written on the detached path now.
  deliveryId?: string;
  agentBotId?: number | null;
  normalized?: NormalizedChatwootEvent;
}

export interface ReceiveChatwootParams {
  routeToken: string;
  rawBody: string;
  getHeader: (name: string) => string | null;
  base?: PrismaClient;
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

  // NOTHING IS WRITTEN HERE. The ledger insert used to sit on this path, which made the ack wait on
  // an interactive transaction and therefore on the health of a pool it shares with every turn,
  // ingest and compaction in the process. Chatwoot escalates the conversation when the ack is slow,
  // so a busy pool anywhere in the system could take the bot off a conversation it had nothing to do
  // with. The insert moved to the detached path (`recordAndProcessChatwootDelivery`), where being
  // slow costs latency instead of the turn.
  return {
    ack: true,
    outcome: "queued",
    tenantId: bot.tenantId,
    instanceId: bot.instanceId,
    deliveryId,
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

// The detached half of a delivery: claim it in the ledger, then process it. Runs AFTER the ack, so
// everything expensive or fragile belongs here rather than upstream of the 5s budget.
//
// A redelivery is not dropped on the strength of the ledger row alone. `recordDelivery` reports the
// row as a duplicate the moment it exists, but the row existing is not the same as the work having
// been done: this path is detached and a process that dies right after the insert (deploy, OOM,
// restart) strands the row on PENDING with nothing running. Since Chatwoot already has its 200, that
// message would never come back. So both branches go on to `processChatwootDelivery`, whose CAS on
// `status: "PENDING"` is the real gate: a row already PROCESSING or PROCESSED matches nothing and the
// call returns "skipped".
export async function recordAndProcessChatwootDelivery(
  params: RecordAndProcessChatwootParams,
): Promise<"processed" | "skipped"> {
  const base = params.base ?? basePrisma;
  const { rowId } = await claimDelivery(
    base,
    { tenantId: params.tenantId, instanceId: params.instanceId },
    params.deliveryId,
    params.normalized.event,
    params.normalized.conversationId,
    // Only a NEW INBOUND message, which is the exact set that drives a turn: the sweep uses this to
    // tell a delivery that lost a customer's message from one that lost nothing (issue #228). The
    // bot's own reply comes back as a `message_created` too, and an incoming `message_updated` is
    // usually our own media write-back coming around — neither is a customer waiting for an answer,
    // so neither may put a row in the loss list.
    isNewIncomingMessage(params.normalized)
      ? (params.normalized.message?.id ?? null)
      : null,
  );
  return processChatwootDelivery({
    tenantId: params.tenantId,
    instanceId: params.instanceId,
    deliveryRowId: rowId,
    agentBotId: params.agentBotId,
    normalized: params.normalized,
    base,
    deps: params.deps,
  });
}

// THE 200 IS ALREADY OUT WHEN THIS RUNS, so a throw here is not a delivery that gets retried: it is
// a message that never existed. Chatwoot was told we have the event, and the upstream retry ladder
// that would otherwise redeliver it is spent. That makes the ledger claim the one step on this path
// with nothing behind it, and the failure it actually meets is the one this whole design is about, a
// pool momentarily full (`maxWait` is 2s). Retrying turns a blip into a delay instead of a lost turn.
//
// What this does NOT cover is the process dying between the ack and the claim, which takes the
// in-memory payload with it. That is the durability the fast ack trades away, and closing it needs
// the payload stored before the 200, not a longer retry here.
const LEDGER_CLAIM_ATTEMPTS = 4;
const LEDGER_CLAIM_BACKOFF_MS = 300;

async function claimDelivery(
  base: PrismaClient,
  scope: { tenantId: bigint; instanceId: bigint },
  deliveryId: string,
  event: string,
  conversationId: number | null,
  inboundMessageId: number | null,
): Promise<{ rowId: bigint; duplicate: boolean }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= LEDGER_CLAIM_ATTEMPTS; attempt++) {
    try {
      return await recordDelivery(
        base,
        scope,
        deliveryId,
        event,
        conversationId,
        inboundMessageId,
      );
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

// Idempotency ledger insert: create-then-catch across two transactions (a unique violation
// aborts its own transaction). Unique on (chatwoot_instance_id, delivery_id).
async function recordDelivery(
  base: PrismaClient,
  scope: { tenantId: bigint; instanceId: bigint },
  deliveryId: string,
  event: string,
  conversationId: number | null,
  inboundMessageId: number | null,
): Promise<{ rowId: bigint; duplicate: boolean }> {
  try {
    const row = await runScopedOn(base, sysCtx(scope.tenantId), (db) =>
      db.chatwootWebhookDelivery.create({
        data: {
          tenantId: scope.tenantId,
          chatwootInstanceId: scope.instanceId,
          deliveryId,
          event,
          status: "PENDING",
          // What a recovery sweep needs if this delivery is stranded on PROCESSING by a process
          // death (issue #228): which conversation to flush, and which message that flush was
          // supposed to answer. Two ids, and nothing else about the event — the flush re-reads the
          // messages from Chatwoot, so no column here can hold what the customer wrote.
          conversationId,
          inboundMessageId,
        },
        select: { id: true },
      }),
    );
    return { rowId: row.id, duplicate: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await runScopedOn(base, sysCtx(scope.tenantId), (db) =>
      db.chatwootWebhookDelivery.findFirst({
        where: { chatwootInstanceId: scope.instanceId, deliveryId },
        select: { id: true },
      }),
    );
    if (!existing) throw err;
    // Fill what the row is missing before handing it back. A row inserted by a build that predates
    // these columns carries neither id, and the CAS that follows stamps `claimed_at` on it — which
    // is precisely the signature the sweep reads as "this build wrote it, so its nulls mean what
    // they say". Left empty, a redelivery of a legacy row turns a lost customer message into a row
    // the sweep closes as carrying none (issue #228).
    //
    // Only ever fills, never overwrites: a row this build already wrote has the right values, and a
    // redelivery of it must not be able to change them.
    if (conversationId !== null || inboundMessageId !== null) {
      await runScopedOn(base, sysCtx(scope.tenantId), (db) =>
        db.chatwootWebhookDelivery.updateMany({
          where: {
            id: existing.id,
            ...(conversationId !== null ? { conversationId: null } : {}),
            ...(inboundMessageId !== null ? { inboundMessageId: null } : {}),
          },
          data: {
            ...(conversationId !== null ? { conversationId } : {}),
            ...(inboundMessageId !== null ? { inboundMessageId } : {}),
          },
        }),
      );
    }
    return { rowId: existing.id, duplicate: true };
  }
}

export interface ProcessChatwootParams {
  tenantId: bigint;
  instanceId: bigint;
  deliveryRowId: bigint;
  agentBotId: number | null;
  normalized: NormalizedChatwootEvent;
  // Which state the opening CAS claims from. Omitted = "PENDING", a delivery arriving. "DEAD" is a
  // recovery taking back a row the sweep gave up on (issue #295); see the CAS for why it is one
  // statement and not two.
  claimFrom?: "PENDING" | "DEAD";
  // What the DIRECT turn did, told to nobody who does not ask. The return union is a contract with
  // every caller (`"processed" | "skipped"`), and widening it would silently change what the live
  // delivery reads; this is opt-in, so only the caller for whom the distinction exists pays for it.
  //
  // The distinction is the recovery's (#295). For a live delivery `"processed"` is the honest word:
  // it is about the ROW, a failed turn is surfaced on the conversation and announced inside
  // Chatwoot, and a withheld reply means the NEWER message's own delivery is carrying it. A recovery
  // exists to ANSWER, and closing the loss on a turn that answered nobody is the lie the whole
  // subsystem is built against — twice measured, once with the model throwing and once with a newer
  // message landing between the recovery's own freshness read and `shouldPost`.
  //
  // Not called at all when debounce armed instead, which is the case the recovery must NOT read as
  // "nobody answered": the reply is the flush's, minutes from now.
  //
  // TAGGED, not distinguished by which key is present: TypeScript gives the absent sibling an
  // implicit `?: undefined` on a union of object literals, so `r.error !== undefined` narrows
  // nothing and the outcome side stops type-checking. The tag is the discriminant.
  onDirectTurn?: (
    r: { kind: "outcome"; outcome: string } | { kind: "error"; error: unknown },
  ) => void;
  base?: PrismaClient;
  // Injectable runtime deps (tests): fake model/client/checkpointer + the contact-auth fetch.
  deps?: RuntimeDeps;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A few Chatwoot transports persist the attachment only after creating the message. In that shape,
// message_created arms the turn without media and message_updated is the first event that carries
// the audio (the fork re-fires the update after a late audio attach). Analyze that late audio, but
// never let the update drive debounce or a second turn. The STT write-back update is a no-op because
// it carries `transcribed_text` in the payload. AUDIO ONLY on purpose: the vision write-back is not
// serialized into webhook payloads (the fork's Attachment#push_event_data exposes no
// image_description/extracted_text on any file type), so a visual leg here could not tell "never
// analyzed" from "our own write-back" and would re-run vision on its own write-back event forever.
export function hasPendingInboundMediaUpdate(
  n: NormalizedChatwootEvent,
): boolean {
  if (n.event !== "message_updated" || !isIncomingMessage(n)) return false;
  const audio = firstAudioAttachment(n);
  return Boolean(
    audio && !audio.transcribedText && !n.message?.transcribedText,
  );
}

// The EPISODE's /teste stamp, for the resolve-triggered closing gate. Its own read rather than the
// boolean above, because the liveness predicate takes the stamp itself — and the episode's answer
// rather than this row's, because what this gate protects is a message to the WhatsApp SIBLING
// (`closeChat: false`), a conversation whose activation the widget row does not hold (issue #249).
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
}

// Eager media analysis: transcribe an incoming voice note (STT) and extract an incoming image/document
// (vision) BEFORE arming/answering, writing the result back to Chatwoot and stashing it on the
// in-memory event (the direct path reads it; the debounce flush re-reads from the attachment meta).
// Idempotent and cheap on text: it only touches a field still unset, and only fetches config when the
// relevant attachment is present. The CALLER decides WHETHER to run this (production+enabled always;
// test only on the answer path; disabled never) — this function does not gate on the agent. Exported
// for unit-testing the idempotency/reuse contract that makes the before-gate + answer-path double call
// safe (no double transcription).
export async function runEagerMedia(
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
  base: PrismaClient,
  // Where this media belongs, in LOCAL ids, for the `stt`/`vision` flow lines below. Required
  // rather than optional: an omitted field here writes a NULL column that reads exactly like "this
  // line has no conversation", and the operator's only route into a turn's trail
  // (/logs?conversationId=) then cannot show the voice note that failed. The caller already holds
  // all three — the mirror wrote the conversation row before this runs, and `inboxAgentRuntime`
  // resolved the agent and its inbox — so nothing here re-queries for them. Null members are for
  // the case where the caller genuinely has no answer (no agent bound to the inbox), which is also
  // the case where no config resolves and no line is written at all.
  owner: EagerMediaOwner,
): Promise<void> {
  if (
    n.conversationId === null ||
    n.inboxId === null ||
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
  if (audio && !n.message.transcribedText) {
    if (audio.transcribedText) {
      n.message.transcribedText = audio.transcribedText;
    } else {
      try {
        const sttCfg = await resolveSttConfig(
          tenantId,
          instanceId,
          n.inboxId,
          base,
        );
        if (sttCfg) {
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
          });
          if (text) n.message.transcribedText = text;
        }
      } catch (err) {
        logger.warn("stt failed (conv=%s): %s", convLabel, errMsg(err));
      }
    }
  }

  // Vision (image/document → description/extracted text). Skip if already extracted this delivery.
  const visual = firstVisualAttachment(n);
  if (visual && !n.message.imageDescription && !n.message.extractedText) {
    try {
      const visionCfg = await resolveVisionConfig(
        tenantId,
        instanceId,
        n.inboxId,
        base,
      );
      if (visionCfg) {
        const extracted = await extractInboundFile({
          tenantId,
          instanceId,
          conversationId: n.conversationId,
          messageId: n.message.id,
          attachmentId: visual.id,
          dataUrl: visual.dataUrl,
          cfg: visionCfg,
          base,
          flow: flow(),
        });
        if (extracted) {
          if (extracted.kind === "image")
            n.message.imageDescription = extracted.text;
          else n.message.extractedText = extracted.text;
        }
      }
    } catch (err) {
      logger.warn("vision failed (conv=%s): %s", convLabel, errMsg(err));
    }
  }
}

// Continuous ingestion: fold into the agent's per-contact-inbox memory thread the messages a
// turn did NOT handle, so the bot has full context when it resumes — a customer message it stayed
// silent on (out of hours, a refused contact, or a human took over), and a HUMAN agent's reply sent
// while it was silent.
// Our own bot's outgoing reply is already in the thread (from the turn) and is skipped; so are
// notes/activities/templates. The CALLER gates this on an ENABLED + PRODUCTION agent (test/disabled
// never ingest — no cost), so a `consumed` incoming here is a message some gate silenced. Eager
// media (run before the gate for production) means the rendered customer text carries its
// transcription/extraction. Best-effort: a failure never strands the delivery.
async function ingestUnhandledMessage(args: {
  tenantId: bigint;
  instanceId: bigint;
  n: NormalizedChatwootEvent;
  act: boolean;
  consumed: boolean;
  // The inbox's agent, for arming memory compaction when this message opens a new attendance. The
  // caller already resolved it (inboxAgentRuntime) to decide whether to ingest at all.
  agentId: bigint;
  compactionEnabled: boolean;
  base: PrismaClient;
}): Promise<void> {
  const { tenantId, instanceId, n, act, consumed, base } = args;
  // The thread is keyed by the native ContactInbox id; without it we cannot address a stable thread.
  if (
    n.conversationId === null ||
    n.contactInboxId === null ||
    n.message?.id == null
  ) {
    return;
  }
  const conversationId = n.conversationId;
  const contactInboxId = n.contactInboxId;
  const messageId = n.message.id;
  const graphThreadId = resolveGraphThreadId(
    tenantId,
    instanceId,
    conversationId,
    contactInboxId,
  );

  // A new attendance can begin on a message the agent never answers (out of hours, a human on the
  // conversation, or the agent reaching out first). Without this arm, that boundary would be invisible
  // to compaction until the attendance AFTER it, which is exactly the deployment that never resolves
  // conversations — the population the whole feature exists for.
  // WHAT gets folded in, and AS WHOM. Two disjoint cases:
  //
  //  - a customer incoming message the bot will NOT answer: silenced by a gate (act && consumed —
  //    out of hours, or a contact the authorization gate refused) or not bot-handled (!act — a
  //    human owns it, or it is not pending). An answered/debounced message is covered by its own
  //    turn and is NOT re-ingested here. A refusal ingests for the same reason out-of-hours does,
  //    and it is what makes the unlock flow read as one conversation: when the code finally lands
  //    and the turn runs, the agent sees what the customer said while it was refused, instead of
  //    answering a code out of nowhere.
  //  - a HUMAN agent's reply to the customer, whatever the gate decided. No turn ever covers one:
  //    the bot did not write it. On the most ordinary shape of a real deployment — the agent
  //    qualifies a lead, a human takes over, the human closes the sale — this is the entire business
  //    half of the attendance, and without it the memory of that attendance is a conversation in
  //    which only the customer spoke (issue #187).
  const incomingUnhandled =
    isNewIncomingMessage(n) && ((act && consumed) || !act);
  const role: IngestRole | null = incomingUnhandled
    ? "customer"
    : isNewHumanAgentMessage(n)
      ? "human_agent"
      : null;
  if (role === null) return;
  // One renderer per direction (../chatwoot/render.ts). The customer's folds in transcription,
  // vision and quoted context; the attendant's only has to name an attachment, because the eager
  // media pass never runs on an outgoing message — and every marker on the customer's side is
  // written from the customer's point of view, so reusing it would tell the agent to ask its own
  // colleague to retype the file they just sent.
  const text =
    role === "human_agent"
      ? renderAttendantMessage({
          text: n.message.content ?? "",
          attachmentTypes: (n.message.attachments ?? [])
            .map((a) => a.fileType)
            .filter((t): t is string => t !== null),
        })
      : renderInboundMessage({
          text: n.message.content ?? "",
          transcribedText: n.message.transcribedText,
          imageDescription: n.message.imageDescription,
          extractedText: n.message.extractedText,
          attachmentTypes: (n.message.attachments ?? [])
            .map((a) => a.fileType)
            .filter((t): t is string => t !== null),
          location: firstLocationAttachment(n.message.attachments),
          inReplyTo: n.message.inReplyTo,
        });
  if (!text.trim()) return;
  // QUEUED, not appended. The append itself has to be able to say "not now" — a turn owning the
  // channel erases anything written beside it — and an ack we must return in under five seconds is
  // no place to wait for one (issue #194, ../../graph/ingest-job.ts). What the webhook still owns is
  // the RENDERING above: it reads the eager media pass, which the job cannot re-derive later.
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
      agentId: args.agentId,
      compactionEnabled: args.compactionEnabled,
      base,
    });
  } catch (err) {
    // Only the ENQUEUE can fail here, and failing it must not fail the delivery: the alternative is
    // a webhook retry that re-runs the eager media pass (a second provider round-trip) to recover
    // one memory append.
    logger.warn(
      "ingest arm (%s) failed (conv=%s): %s",
      role,
      String(conversationId),
      errMsg(err),
    );
  }
}

// Reactive availability decision: the agent's business hours (the "Disponibilidade" schedule) gate
// replies to the customer. Outside the configured window the agent stays SILENT; the operator gets a
// one-shot private note (postNote true only the first time, mirroring the test-mode notice). No
// schedule / empty windows → always on (never silenced). Pure (now injected) so it is unit-testable.
//
// The CUSTOMER-facing half of the same closure is a separate decision on a separate watermark
// (awayMessageDue, src/modules/availability/away.ts): the two answer different questions on different
// clocks, and a conversation whose note went out earlier today must still receive the message the
// first time an operator writes one.
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

// Claim the day's away message with a compare-and-swap on its watermark's exact previous value (null
// included). The webhook dispatch is DETACHED, so a customer who writes twice in a row lands two
// invocations that both read the same watermark before either writes it; without the claim both would
// post and the customer would see the message twice. The loser skips: the winner is already posting.
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

// Give the day back when the message never left. The watermark means "the customer heard from us
// today", and a claim that delivered nothing must not settle it, or the retry the next message would
// have made is suppressed until tomorrow. Guarded on our own stamp, so a claim that has since moved on
// is never clobbered. The operator note has its own watermark and is untouched either way.
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

// Operator-facing note for a conversation the contact-authorization gate refused (pt-BR, the same
// register as the one-shot test-mode / out-of-hours notices). Reasons are short codes by the time
// they get here (the slug guard upstream drops prose), so the note can carry one without carrying
// anything the customer wrote. This is also the ONE place the endpoint's own reason surfaces: the
// note sits in the operator's Chatwoot, on the conversation it is about, unlike the execution log
// that alert channels read.
export function contactAuthNoteText(
  verdict: {
    outcome: ContactAuthOutcome;
    status?: number;
    reason?: string;
    endpointReason?: string;
  },
  handedOff: boolean,
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
    return `🔒 Contato não autorizado pela verificação externa.${reason} O agente não respondeu automaticamente.${handoffLine}`;
  }
  const cause =
    verdict.status !== undefined
      ? `HTTP ${verdict.status}`
      : (CONTACT_AUTH_ERROR_LABELS[verdict.reason ?? ""] ??
        verdict.reason ??
        "falha desconhecida");
  return `⚠️ A verificação de autorização do contato falhou (${cause}). O agente não respondeu automaticamente; a próxima mensagem tenta novamente.`;
}

// Test-mode gate + the /teste and /reset commands (item 1 + 2). Runs at the TOP of the actionable
// branch, before eager STT / debounce / the agent turn. Returns true when the delivery is consumed
// here — a command was handled, or a "test" agent must stay silent because this conversation hasn't
// been activated with /teste yet — so the caller skips all agent processing (the mirror already ran).
// Control commands ONLY apply to a test-mode agent (commandActive, resolved by the caller); for any
// other agent /teste and /reset are ordinary customer text and fall through to normal processing.
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
  // Handed what the authorization endpoint said ABOUT the contact when this gate lets the delivery
  // through, so the direct turn can put it in the prompt (issue #190). A callback rather than a
  // second return value because the returns here are a plain "was this delivery consumed", written
  // in two dozen places and in nested closures of their own; the verdict is a different question
  // asked in exactly one of them.
  onAuthContext: (context: AuthContext | null) => void;
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

  // The persona bound to this conversation's inbox, resolved ONCE and used for both halves of every
  // customer-visible post: the token it speaks with, and the id the conversation knows it by. They are
  // deliberately the same lookup. Chatwoot also dispatches an event to the conversation's ASSIGNED
  // agent bot (agent_bot_listener.rb), so the bot that RECEIVED this delivery is not always the one
  // that would send the reply — and a fence that clears the recipient while the client sends as the
  // inbox's persona posts one persona's message into another's conversation.
  let personaOnce: Promise<AgentBotIdentity | null> | null = null;
  const persona = (): Promise<AgentBotIdentity | null> =>
    (personaOnce ??=
      ctx.agentId !== null
        ? loadAgentBot(tenantId, instanceId, ctx.agentId, base)
        : Promise.resolve(null));

  // A client that acts AS that persona. Every bot-token endpoint (send, private note, custom
  // attributes) authenticates with it; admin-token ones (labels, kanban) ignore it. Building the
  // client without resolving the bot yields an empty token, which Chatwoot rejects with 401 — issue
  // #79, where /reset did exactly that and reported success anyway.
  const personaClient = async (): Promise<ChatwootClient> =>
    loadChatwootClient(tenantId, instanceId, {
      base,
      makeClient: deps?.makeClient,
      botToken: (await persona())?.accessToken,
    });

  // NOTE: One command, one run. Chatwoot dispatches an incoming message to the conversation's
  // ASSIGNED agent bot and to the inbox's (agent_bot_listener.rb), and those are two deliveries with
  // two ids — so on a conversation assigned to another persona's bot, the gate that lets a command
  // through regardless of ownership let BOTH routes execute it. Two resets, two acknowledgements,
  // and the second one clearing state the first had just rebuilt.
  //
  // The inbox's persona is the one that runs it, because the command is about the agent bound to
  // THIS inbox: it is that agent's memory being cleared and that agent the conversation goes back
  // to. The other route consumes the delivery and does nothing — returning false there would hand
  // "/reset" to its own agent as ordinary customer text.
  // Fails CLOSED on an unresolvable identity, on either side. An inbox whose agent has no
  // ChatwootAgentBot row cannot answer anywhere — every bot-token call it makes goes out with an
  // empty token and comes back 401 (issue #79) — so treating "we have no id" as "this route is ours"
  // let a command arriving on ANOTHER persona's route unassign that working bot and hand the
  // conversation to one that cannot speak. The same for a delivery whose own route bot is unknown:
  // an unattributed route is not evidence that this is the right one.
  //
  // The two closed answers are not the same fact, and `commandRoute` is where that distinction is
  // made once: `other_route` leaves the command to a persona that will run it, `no_persona` means
  // there is no such persona and NO route will. Asking the question as a boolean here and again for
  // the line that reports it is the #270 shape — one fact, two readings that can disagree.
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
      // The classifier's own answer, carried through: what the row says about the route is the
      // value that decided it, never a second look at the same two ids.
      drop: route,
      base,
    });
    return true;
  }

  // Is the conversation still the bot's, RIGHT NOW? `act` upstream was decided from the payload
  // Chatwoot sent, so a human who took the conversation between that event and this post is invisible
  // to it — and on a re-delivered webhook that gap is not milliseconds. The mirror applies assignment
  // events as they arrive, so a fresh read can see the handoff the payload could not. Same fence the
  // runtime puts before its own reply; it needs one because a model call is slow, this path needs one
  // because being fast is not being atomic.
  //
  // `closed` is the same reading every other gate reports, and it is null on exactly one
  // branch: an unresolvable persona. That answer comes from OUR side, not from the row, so labelling
  // it with the row's state would be the #225 conflation in a third costume — and the caller that
  // writes a line skips it rather than guessing.
  const ownershipNow = async (): Promise<
    { ours: true } | { ours: false; closed: GateCloseDetail | null }
  > => {
    const conv = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.conversation.findUnique({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: conversationId,
          },
        },
        // assigneeId is part of the question, not decoration: without it shouldBotHandle cannot tell
        // OUR bot from another one, and a conversation handed to a different bot reads as ours.
        select: { assigneeType: true, assigneeId: true, status: true },
      }),
    );
    // No resolvable persona means nothing can speak here, and "an AgentBot owns this" cannot be
    // narrowed to "the sender owns this" without an id to compare against. shouldBotHandle answers the
    // loose attribution question when the id is missing (its other callers depend on that), so the
    // strict half is decided here, where the absence is known.
    //
    // NOTE: no test distinguishes this line today, and that is not an oversight: a persona that failed
    // to resolve also leaves the client with an empty bot token, which never reaches the network. The
    // line is here because the fence's answer must be right on its own terms — "we own this" is false
    // when there is no "we" — rather than right because a lookup two layers down happens to fail too.
    const ourBotId = (await persona())?.chatwootAgentBotId ?? null;
    if (ourBotId === null && conv?.assigneeType === "AgentBot") {
      return { ours: false, closed: null };
    }
    const ours = shouldBotHandle(
      {
        assigneeType: conv?.assigneeType ?? null,
        assigneeId: conv?.assigneeId ?? null,
        status: conv?.status ?? null,
      },
      { ourAgentBotId: ourBotId },
    );
    return ours
      ? { ours: true }
      : {
          ours: false,
          closed: describeClosedGate({
            assigneeType: conv?.assigneeType ?? null,
            status: conv?.status ?? null,
          }),
        };
  };
  const stillOurs = async (): Promise<boolean> => (await ownershipNow()).ours;

  // Why the agent would not answer in this conversation right now. Two independent reasons, and the
  // three texts below have to name the right one: the conversation is not the agent's (a human or
  // another persona holds it, or it is not `pending`), or the agent is switched OFF entirely.
  //
  // Kept apart from `stillOurs`, which answers ownership and nothing else. Folding "disabled" into it
  // would invert /reset: that command returns the conversation precisely when the answer is "not
  // ours", and a disabled agent would then be handed a conversation it will never answer in.
  //
  // `disabled` wins the tie because it is the reason /reset cannot help: the command returns a
  // conversation, it does not switch an agent back on.
  //
  // Both halves are read FRESH, for the same reason `stillOurs` is: /reset asks this question after
  // its cleanup, which is a dozen network calls long. `ctx.agentEnabled` came from the lookup at the
  // top of this function, and pairing a fresh ownership read with a stale switch is how the
  // hand-back would still reach an agent an operator turned off while the command ran. On a read
  // that fails, the initial value stands — that is the answer this had before the re-read existed,
  // and a transient failure must not decide it — but it is logged rather than swallowed.
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
      // NOTE: A row that is GONE is not an agent that can answer, so the hand-back is refused rather than
      // falling back to what the lookup said before it was deleted. Only `findUnique` on a deleted
      // row lands here, which is narrow — and it is the same harm this whole predicate exists to
      // prevent, so the narrow case gets the same answer as the loud one.
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

  // `stillOurs`, for the callers that must not throw. /reset asks about ownership AFTER its cleanup
  // has run, so a rejection there loses the acknowledgement of work that DID happen and leaves the
  // delivery mid-flight; /teste asks after the activation is committed.
  //
  // Unknown reads as OURS, and the two consumers want that for opposite-looking reasons that agree:
  // the hand-back is the irreversible act, so an unknown answer must not trigger it, and the wrong
  // text is cheaper in this direction too — "activated" on a conversation a human holds is a silence
  // the operator retries out of, while "send /reset" on a conversation the agent already owns talks
  // them into clearing an episode for nothing.
  //
  // `postPublicMessage` keeps its own catch with the OPPOSITE fallback on purpose: there the question
  // is "may this text go to the customer", and an unreadable answer has to withhold it.
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

  // Pulls the mirror level with Chatwoot and, crucially, the in-memory snapshot with the mirror:
  // `ctx.conv` is what `holderAtStart` and the hand-back's baseline read, so reconciling the row and
  // leaving the snapshot behind would move the fence without moving what it fences.
  //
  // `reconcileMirrorFromLive` and not a plain write: it is the VERSIONED path, so a webhook that
  // landed with something newer wins instead of being overwritten by this GET, and it is the same
  // probe `runAgentNudge` runs before ITS irreversible act, for the same reason.
  //
  // Best-effort, and never collected into `failed`. Failing to refresh leaves every decision exactly
  // where it stood without this call; it is not a step of the reset that the operator can be told
  // succeeded or not. `have` lets a caller that already built a client reuse it.
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

  const answerBlocker = async (): Promise<"none" | "ownership" | "disabled"> =>
    !(await agentStillEnabled())
      ? "disabled"
      : (await stillOursOrUnknown())
        ? "none"
        : "ownership";

  // Returns whether the message actually left. Whoever records that it was sent has to read this: the
  // away message would otherwise burn the day it just claimed, and the redirect gate would close its
  // one-shot and spend a resend on a link nobody received. The two command acks ignore it on purpose —
  // their effect (test mode on, memory cleared) is already committed and a lost ack undoes none of it.
  //
  // The fence lives HERE, not at the away branch, because all four customer-visible posts of this gate
  // (test-mode notice, its reminder, the redirect link, the away message) ask the same question and
  // none of them was asking it. Private notes are deliberately exempt: only the operator sees one, and
  // a note that lands after a handoff explains the silence instead of talking over anybody.
  const postPublicMessage = async (text: string): Promise<boolean> => {
    // Inside the try, deliberately: a fence that cannot answer must report "not sent" like any other
    // failure. Thrown, it would skip the away branch's release and burn the day it just claimed on a
    // message the customer never got.
    try {
      if (!(await stillOurs())) {
        logger.info(
          "chatwoot: public message withheld (conv=%s) — the conversation is no longer the bot's",
          String(conversationId),
        );
        return false;
      }
      const client = await personaClient();
      await client.sendMessage(conversationId, text);
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

  // A command's answer, which must never vanish. `postPublicMessage` withholds anything the bot no
  // longer owns, and that fence is right for the agent's own output ("never talk over a human") and
  // wrong here: the operator typed this command IN this conversation, and on a human-held one the
  // acknowledgement is precisely the text explaining why nothing else will happen. Withheld, they
  // type /teste and get total silence, which is the symptom this whole change is about.
  //
  // The fallback is a PRIVATE note rather than a bypass: it reaches the operator, stays invisible to
  // the customer, and does not put a bot message into a conversation a human is handling — the same
  // trade the test-mode notice already makes.
  const postAcknowledgement = async (text: string): Promise<void> => {
    if (await postPublicMessage(text)) return;
    await postPrivateNote(text);
  };

  // Private note (operator-only, invisible to the customer) posted as the persona bot. Used for the
  // one-shot "agent is in test mode" and "agent is out of hours" notices on a silenced conversation.
  // Returns whether it left, for the same reason the public post does: both notices are stamped once
  // per conversation, and a stamp on a note that never arrived spends the only shot the operator gets.
  // The fence does NOT apply here — a note that lands after a handoff explains the silence to whoever
  // took over instead of talking over them.
  const postPrivateNote = async (text: string): Promise<boolean> => {
    try {
      const client = await personaClient();
      await client.sendPrivateNote(conversationId, text);
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

  // OPENING A CONVERSATION FOR THE HUMAN QUEUE, for every gate that refuses a turn before it runs.
  //
  // Status `open` is what ends the bot's attribution, so this IS the handoff; the optional team
  // assignment only routes it, and a routing miss must never undo the open. Shared rather than
  // written per gate (issue #146): the fence below is the part that is easy to leave out, and a
  // second copy of it would be the copy that forgets.
  //
  // The fence: a gate can take time to decide (contact-auth waits on somebody else's endpoint), and
  // a human can claim the conversation while it does. Without the re-check the copy was correctly
  // withheld and the conversation was reopened and re-routed anyway, pulling a human's conversation
  // back out of their hands by a gate that had already decided to stay quiet.
  const openConversationForHumans = async (
    gate: string,
    teamId: number | null,
    teamUsable?: (id: number) => Promise<boolean>,
  ): Promise<boolean> => {
    try {
      if (!(await stillOurs())) {
        logger.info(
          "chatwoot: %s handoff skipped (conv=%s) — the conversation is no longer the bot's",
          gate,
          String(conversationId),
        );
        return false;
      }
      const client = await personaClient();
      await client.toggleStatus(conversationId, "open");
      if (teamId !== null && (await (teamUsable?.(teamId) ?? true))) {
        try {
          await client.assignTeam(conversationId, teamId);
        } catch (err) {
          logger.warn(
            "chatwoot: %s team assignment failed (conv=%s): %s",
            gate,
            String(conversationId),
            errMsg(err),
          );
        }
      }
      return true;
    } catch (err) {
      logger.warn(
        "chatwoot: %s handoff failed (conv=%s): %s",
        gate,
        String(conversationId),
        errMsg(err),
      );
      return false;
    }
  };

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

  // NOTE: The EPISODE's activation, not this row's, for every gate below (issue #261). `/teste` means "this
  // is me, testing", and a redirect episode is two conversations of one person: the stamp lands on the
  // row it was typed in, and the one bridge that copies it (above) runs ONCE, at link time, in one
  // direction. Outside that instant the two halves disagree, and the gates below — `/reset` and the
  // test-mode silence — judged by whichever row they happened to hold.
  //
  // Resolved into the field the gates already read, which is what the propagation directly above does
  // too, so this adds a source of truth rather than a second question. Safe for `/teste` itself: that
  // branch writes a fresh stamp without reading this value.
  //
  // Costs nothing on the ordinary path — `needsEpisodeLookup` is false for a production agent, for a
  // row already stamped, and for any conversation outside a redirect episode — and this gate runs on
  // every inbound message.
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
          // Clean engagement slate at activation: a message received while the agent was silenced
          // (pre-activation) must not leave a follow-up pending NOR look like a completed sequence.
          // Clearing both anchors yields the "none" indicator state (not "pending", not "complete");
          // a genuine customer message AFTER activation re-opens a fresh episode. Mirrors /reset's
          // anchor handling. lastInboundAt also anchors the 24h window — acceptable: the next customer
          // message re-anchors it, and there is no proactive send pending at the instant of activation.
          lastInboundAt: null,
          lastFollowUpAt: null,
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
    // Activation is not the same as being able to answer. /teste only lifts the test-mode silence;
    // the ownership gate is separate, and a conversation the agent does not hold stays silent with
    // test mode fully on. Saying "activated" and nothing else is what made that read as a bug — so
    // when the gate would still refuse, the acknowledgement says so and names the command that fixes
    // it.
    //
    // `stillOurs()` and not the caller's `act`: that one was decided against the bot whose webhook
    // route the delivery arrived on, and Chatwoot fans a message out to the conversation's assigned
    // bot AND the inbox's — so on a conversation assigned to another persona's bot the two differ,
    // and the plain "activated" would be posted about a conversation this inbox's agent cannot
    // answer in. The wording names no holder for the same reason: a human, another persona's bot and
    // an `open` status all reach here, and only "not with this agent" is true of all three.
    //
    // Diagnosed here, ACTED ON in /reset: silently pulling a conversation away from an agent who
    // legitimately took it is a bigger surprise than a clear message.
    const testeBlocker = await answerBlocker();
    await postAcknowledgement(
      testeBlocker === "none"
        ? "🧪 Modo teste ativado para esta conversa."
        : testeBlocker === "ownership"
          ? "🧪 Modo teste ativado para esta conversa. Mas ela não está com este agente, então ele ainda não vai responder. Envie /reset para devolvê-la ao agente."
          : // No command is named: /reset returns a conversation and this agent is switched off, so
            // it would be the same wrong instruction one variant up, one layer deeper.
            "🧪 Modo teste ativado para esta conversa. Mas este agente está desativado, então ele não vai responder.",
    );
    logger.info("chatwoot: /teste activated (conv=%s)", String(conversationId));
    return true;
  }

  // ── /reset (only when test mode is ACTIVE for THIS conversation): clear the contact's agent memory +
  //    audio preference + this conversation's labels and custom attributes. Deliberately does NOT touch
  //    testActivatedAt (the conversation keeps answering). Every step is best-effort; consumed regardless.
  if (isReset && shouldRunReset(ctx.mode, ctx.conv.testActivatedAt)) {
    // Each cleanup is independent and best-effort, so each gets its OWN try: sharing one meant the
    // first failure skipped every step after it (the kanban card kept the previous episode's dates
    // because the attributes call above it had thrown). `failed` collects the PT-BR name of whatever
    // did not get cleared, so the confirmation below can stop claiming a full reset after a partial
    // one. `label` is what the customer-visible ack names; `what` is the English log wording.
    // NOTE: The handoff the command was ASKED about, captured before any cleanup runs. The hand-back
    // exists to undo a handoff that was ALREADY in place when the operator typed /reset, so two
    // facts have to survive the cleanup — a dozen network calls long — for it to fire: the
    // conversation was not the bot's then, and the SAME party still holds it now. A conversation the
    // bot owned at that moment has nothing for the command to undo, and a party who claimed it
    // meanwhile claimed it after the command was typed. Either way the command would be stealing a
    // conversation from someone who took it later, which is the round-1 harm pointing the other way.
    //
    // The ASSIGNEE is what is compared, not the whole row: status moves on its own (an inbound
    // message reopens a resolved conversation) and that is not a takeover.
    // Asked BEFORE the two facts below are read, because they are read from the mirror and the mirror
    // lags Chatwoot by one webhook. The command's own delivery normally carries the assignee and
    // reconciles it, but a sparse payload carries none, and then a missed or delayed assignment
    // webhook leaves the mirror saying "the bot owns this" about a conversation a human is holding.
    // Both facts are then wrong in the direction that does nothing: `notOursAtStart` false skips the
    // hand-back entirely, and /reset acknowledges a clean slate on a conversation the agent still
    // cannot answer in — which is issue #198 itself, one layer further in.
    //
    // One GET on a command an operator types by hand. The same ask is repeated before the hand-back
    // rather than carried down, because everything between the two is I/O and the answer decays over
    // exactly that stretch.
    await refreshFromLive("the command's own decisions", null);
    const notOursAtStart = !(await stillOursOrUnknown());
    const holderAtStart = `${ctx.conv.assigneeType ?? ""}:${ctx.conv.assigneeId ?? ""}`;
    const heldBySameParty = async (): Promise<boolean> => {
      const now = await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.conversation.findUnique({
          where: { id: ctx.conv.id },
          select: { assigneeType: true, assigneeId: true },
        }),
      ).catch(() => null);
      // Unreadable answers "unchanged", the same direction every other fence here falls: the
      // irreversible act is the hand-back, and an unknown must not be the thing that triggers it —
      // but here it is the START state that already said "not ours", so standing on it is standing
      // on the answer the command was given.
      if (!now) return true;
      // NOBODY IS NOT A NEW HOLDER. This fence exists to stop the hand-back unassigning somebody who
      // arrived while the command ran; a conversation the original party RELEASED has no such person,
      // and comparing holder strings reads that release as a change and refuses.
      //
      // Refusing there produces issue #198's own symptom, one layer further in: the holder is gone but
      // the status is whatever they left it as, and `open` with no assignee is precisely the state the
      // agent cannot answer in — the hand-back's remaining half, putting the conversation back to
      // `pending`, is exactly what is needed and is the half that gets skipped. The acknowledgement
      // then blames a takeover, because "not answerable by us" is what it reads to decide that
      // sentence, and it names a person who has in fact left.
      //
      // Safe on the other side too: the hand-back is handed the START holder as its baseline, so with
      // nobody there it finds nothing to remove and sends no unassign at all.
      if (now.assigneeType === null) return true;
      return (
        `${now.assigneeType ?? ""}:${now.assigneeId ?? ""}` === holderAtStart
      );
    };
    const failed: string[] = [];
    const step = async <T>(
      what: string,
      label: string,
      run: () => Promise<T>,
    ): Promise<T | null> => {
      try {
        return await run();
      } catch (err) {
        failed.push(label);
        logger.warn(
          "chatwoot: /reset %s failed (conv=%s): %s",
          what,
          String(conversationId),
          errMsg(err),
        );
        return null;
      }
    };

    // NOTE: Scoped to the conversation the command was typed on, which is the scoping it already
    // uses for memory. The redirect funnel spans a PAIR — the entry conversation holds
    // `redirectSentAt`/`redirectCount`, the widget one holds `redirectLinkedAt`/`redirectClosedAt`,
    // and the ladder job is keyed by the widget thread — so a /reset typed on one side leaves the
    // other side's anchors and ladder standing, and the funnel can be re-run but not re-closed. The
    // operator resets the other side to finish the job.
    //
    // Reaching across needs to know WHICH widget chat opened from this entry, and that used to be
    // underivable: the merge happens inside Chatwoot's token resolve and what comes back names the
    // CONTACT, not the conversation the token was minted on, so every predicate over the mirrored
    // rows was a guess — on a command that cancels appointment reminders. Issue #222 removed that:
    // the widget row now records the entry conversation it opened from, so this direction is a
    // lookup rather than an inference.
    //
    // The scoping stands anyway, and deliberately. Widening what a /reset erases is a change to what
    // the operator asked for, on the command whose whole ordering above exists to bound what it
    // touches; it is the operator's call, not a side effect of the pairing becoming available. What
    // changed is that the reach is now implementable, not that it is wanted here.

    // FIRST among the mutations, and the ordering is the whole fence. Two races pull in opposite
    // directions and only this position settles both.
    //
    // Late is wrong because /reset is not atomic with the conversation: a message arriving during the
    // cleanup runs a turn that can book, reschedule, or re-enter the funnel, and a retirement running
    // after it kills work that belongs to the NEXT episode. Sparing that work by age does not
    // discriminate — enqueueJob re-arms by upsert, so `created_at` stays put and `updated_at` moves on
    // a claim (see cancelThreadAppointments). Retiring first needs no such test: the upsert
    // that re-arms writes `status: PENDING` with a fresh payload, so anything armed afterwards revives
    // its own row.
    //
    // Early is also what the watermarks need. Clearing the anchors first opens a gap in which a ladder
    // the worker has ALREADY claimed still passes its own fence — nothing has stamped it yet — and
    // runs to its closing, which re-sets `redirectClosedAt` on the row the command just cleared, on a
    // conversation it also resolves. With the stamp landing here, anything in flight stands down, and
    // whatever it may already have written is cleared by the steps below rather than after them.
    //
    // NOTE: All three per-conversation job kinds that can still post AT the customer. MEMORY_COMPACT is
    // cancelled further down and is the one genuine exception: it writes memory rather than messages,
    // and the advisory lock the clear takes is what serializes it.
    //
    // The inactivity follow-up was on `cancelPendingJob` and that was not enough, for the reason this
    // whole block exists: a cancel reaches PENDING rows only. A follow-up already CLAIMED has passed
    // its pre-send ownership probe and is inside the model call, and its second probe — the one that
    // catches a takeover mid-run — asks whether the bot owns the conversation. The hand-back below
    // ANSWERS YES, so a nudge from the episode the operator just erased lands right after the
    // acknowledgement, carrying its labels and resolve with it.
    //
    // The ladder is retired by the key that ARMED it, which is the WIDGET side's thread — not this
    // conversation's, unless this conversation is the widget one. Its stages message and resolve both
    // sides of the pair, so a /reset on the entry conversation (the side the funnel is re-run from)
    // was cancelling a key that had never been enqueued.
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
    // NOTE: Every side of the pair, for the same reason the ladder is retired by the widget's key: in a
    // redirect episode the AI does not serve the entry conversation at all — the gate answers there
    // with a fixed message and no model, and every turn (so every booking) happens in the widget
    // (docs/channel-redirect.md). A /reset typed on the entry side would therefore cancel reminders
    // on a thread that never booked anything, and the test appointment would go on nudging the
    // customer about an episode the operator was told had been erased. Every widget chat of this
    // entry and not just the live one, on the same reasoning as the ladder: what is being cancelled
    // is SCHEDULED work, so the question is what is still armed, not which chat the lead is in.
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
      // The LAST per-conversation kind, and the one this command reached past for longest. A
      // debounce flush is a queued TURN: it coalesces the burst that arrived before the command and
      // invokes the graph, which recreates the thread this reset is about to clear — and the reply
      // is the smaller half of that, since the invoke rewrites the checkpoint whether or not the
      // watermark lets the message out. Retired here with the rest, and the handler asks before it
      // invokes, because a flush already CLAIMED is past every cancel.
      //
      // Which completes the sweep: of the eleven scheduler kinds, five are per-conversation
      // (FOLLOWUP, REDIRECT_FOLLOWUP, APPOINTMENT_REMINDER, MEMORY_COMPACT, INGEST_MESSAGE) and this
      // is the sixth. The other five are fleet-wide sweeps and outbound retries that know nothing
      // about a conversation.
      await step("cancel pending debounce", "mensagens em espera", () =>
        retireJobsByDedupeKey(
          tenantId,
          "DEBOUNCE",
          debounceDedupeKey(chatwootThreadId(tenantId, instanceId, convId)),
          base,
        ),
      );
    }

    // IMMEDIATELY after the retirements, and that pairing is the point. The order between the two is
    // fixed the other way round — clearing first opens a gap in which a ladder the worker has ALREADY
    // claimed passes its own fence and runs to its closing, re-setting `redirectClosedAt` on the row
    // the command just cleared — so the clear cannot lead. What it can do is follow immediately.
    //
    // It used to sit after the memory clear, the labels, the attributes and the kanban card: a dozen
    // Chatwoot round trips. On a conversation the agent still OWNS the gate is open for every one of
    // them (the hand-back below is what closes it, and there is nothing to hand back here), so a
    // customer message arriving in that stretch runs a turn whose watermarks this update then wipes —
    // a re-link posting its private note twice, or a fresh failure losing its banner. Adjacent to the
    // retirement the window is two database writes wide instead.
    //
    // It does not CLOSE that race, and nothing here does: /reset is not atomic with a turn, by
    // design. The remaining window is pinned as a named limit rather than papered over with a
    // generation column through every writer (see .codex-review-waived).
    //
    // Clear the follow-up watermarks so the sweep does not immediately re-arm a follow-up: a reset is
    // a clean slate, so no proactive nudge should fire until the CUSTOMER sends a genuine message
    // again (which re-anchors lastInboundAt). Also clear the one-shot notice watermarks (test-mode +
    // out-of-hours) so a fresh notice can be posted if this conversation is ever silenced again.
    //
    // The redirect anchors go with them, and used not to: same shape, same purpose (one-shot /
    // cooldown), and skipping them meant the WhatsApp→chat redirect could not be tested twice — once
    // it has fired, `redirectCount` is at its cap and the cooldown anchor is set, so the operator who
    // resets to run the funnel again gets a conversation that will never redirect. Only the anchors
    // on THIS conversation are cleared: each lives on one side of the pair (entry WhatsApp vs
    // widget), which matches the scoping the command already uses for memory.
    //
    // And the previous run's failure. `lastError` self-heals on the next successful turn, but
    // `failureNoticeSentAt` is the coalescing anchor for the "a human has to take over" note, so
    // without clearing it a fresh failure after a reset cannot announce itself — the same reasoning
    // that already clears `testNoticeSentAt`.
    // The redirect anchors describe the EPISODE and happen to be stored one pair of columns per
    // side, so clearing this row releases only the half the operator typed into: a /reset on the
    // entry conversation leaves `redirectClosedAt` on the widget, and the funnel can be run again
    // but not closed again until the widget side is reset too. Named in the acknowledgement's own
    // scope rather than worked around — see the NOTE above the job cancellations.
    const redirectAnchors = {
      redirectSentAt: null,
      // A counter, so it goes back to zero rather than to null.
      redirectCount: 0,
      redirectLinkedAt: null,
      redirectClosedAt: null,
    };
    await step("clear the conversation's watermarks", "marcadores", () =>
      runScopedOn(base, sysCtx(tenantId), (db) =>
        db.conversation.update({
          where: { id: ctx.conv.id },
          data: {
            lastInboundAt: null,
            lastFollowUpAt: null,
            testNoticeSentAt: null,
            outOfHoursNoticeSentAt: null,
            awayMessageSentAt: null,
            ...redirectAnchors,
            lastError: null,
            lastErrorAt: null,
            failureNoticeSentAt: null,
          },
        }),
      ),
    );

    // Clear the agent's memory thread (per contact-inbox / channel), the AgentThread marker (the
    // divider's last-conversation + the ingestion watermark) AND the compacted memory of past
    // attendances, so a reset truly starts this channel's conversation over. Only THIS channel's memory is cleared (the contact's other channels keep
    // their own threads), which matches where the operator typed /reset.
    if (ctx.conv.contactInboxId !== null) {
      const contactInboxId = ctx.conv.contactInboxId;
      // ALL THREE deletions under the lock a compaction takes, and in one step, because a reset that
      // clears them in separate critical sections loses to a job already CLAIMED (past
      // cancelPendingJob, provider call in flight):
      //
      //   - the summary rows and the AgentThread marker, or the job slips its row in between the two
      //     and the next compaction renders memory this reset cleared;
      //   - the CHECKPOINT itself, or the job's rewrite recreates the thread — with the memory head
      //     in it — right after this deleted it, and nothing deletes it again. That one is the worst
      //     of the three, because the operator sees the reset confirmed and the agent keeps
      //     answering from the memory they just cleared.
      //
      // Inside the shared critical section the job either finished before this ran (and this deletes
      // everything it wrote) or it finds the AgentThread row gone and drops the summary.
      //
      // THE ONLY MEMBER OF THIS FAMILY THAT STILL HOLDS A TRANSACTION ACROSS THE CHECKPOINTER, and
      // deliberately. Everywhere else that hold was removed because it drained the pool (issue #225);
      // here the transaction IS the safety net. `clearContactMemory` deletes the rows first and the
      // checkpoint last precisely so a failed checkpoint delete rolls the rows back and leaves /reset
      // a clean retry (../memory/reset.ts spells out why the reverse order is worse). Moving the
      // checkpointer call outside would commit the rows and then possibly fail, leaving the operator
      // told the memory was cleared while the thread still answers from it. This is an operator
      // action, not a hot path, so the one held connection is not what starves anything.
      //
      // The queue is what keeps it exclusive with ingestion, the turn, the nudge and compaction now
      // that they no longer take the advisory lock.
      //
      // The order the three deletions run in is load-bearing and lives with its reasoning in
      // src/modules/memory/reset.ts.
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
              // A TURN ALREADY INVOKING IS THE ONE THING THIS LOCK DOES NOT HOLD BACK. A graph invoke
              // is a read-modify-write of the whole message channel — it saves what it LOADED plus
              // its own messages — so a clear that lands mid-invoke is undone the moment that turn
              // finishes, restoring the history it just deleted (src/graph/inflight.ts, measured in
              // tests/modules/memory-compaction.test.ts). Compaction, the other rewriter of this
              // channel, already defers on exactly this question, under exactly this lock.
              //
              // And clearing anyway is WORSE than not clearing: the turn's save restores the raw
              // channel, but nothing restores the summary rows or the AgentThread marker this would
              // have deleted, so the operator is left with a half-erased memory and an
              // acknowledgement claiming a clean one. Refusing the step is the honest outcome — the
              // ack already names what did not clear, and /reset is a command the operator can
              // simply type again once the turn lands.
              //
              // Asked INSIDE the lock, which is what makes the two exclusive rather than merely
              // staggered: the turn takes this same lock to mark itself, so this either runs entirely
              // before the mark (and the turn then loads a cleared thread) or it sees the mark.
              //
              // On `db`, and taking the row: same reason as `revokeJobsByKeyPrefixOn` below. A helper
              // that opened its own transaction would wait for a connection this one cannot release
              // (measured under `DB_POOL_MAX=1`: 2047ms, then "Unable to start a transaction in the
              // given time"), and reading without the lock would leave the answer stale the moment
              // it returns, since a turn on another replica claims by updating this same row.
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
              // QUEUED INGESTION IS REVOKED FIRST, AND FROM IN HERE (issue #194). Continuous
              // ingestion is a scheduler job now, so at any moment this thread can owe an append
              // carrying text from before the reset — pending, or CLAIMED and blocked on the very
              // lock this step is holding. Left alone, it lands the instant this releases and
              // rebuilds the AgentThread row and the checkpoint from the memory the operator was
              // just told had been cleared.
              //
              // Inside the critical section, not as a step after it, because the window between
              // leaving it and cancelling is exactly where a claimed job enters it. Retiring the
              // rows is half; a run already in memory re-reads its own row inside the section and
              // stands down (../../graph/ingest-job.ts, stillWanted).
              // On `db`, the connection this step already holds. A helper that opened its own
              // transaction would wait for a connection this one cannot release until it returns,
              // and `DB_POOL_MAX=1` is a supported setting: the reset would time out and report a
              // partial failure of the very step that had nothing wrong with it.
              await revokeJobsByKeyPrefixOn(
                db,
                "INGEST_MESSAGE",
                `ingest:${graphThreadId}:`,
              );
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
      // The compacted memory of past attendances lives in its own table, not in the thread, so
      // deleting the thread alone would resurrect every one of them on the next compaction (the head
      // is rendered from these rows). "Starts this channel's conversation over" has to include them,
      // and the PENDING job that would write more of them: a compaction armed on a resolve waits out
      // a grace window, so at any moment one can be sitting in the queue holding the conversation
      // this reset is clearing.
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
    // Custom attributes and the kanban card are BOT-token calls, so this client must carry the
    // persona's token; labels are admin-token and would work either way. Building it is itself a step:
    // it reads the DB and resolves DNS through the SSRF guard, so during an outage it throws, and
    // outside the boundary that would abandon the whole reset — including the local cleanups below
    // and the acknowledgement — after the memory was already wiped.
    const client = await step(
      "build the persona client",
      "etiquetas, atributos e card do kanban",
      personaClient,
    );
    if (client) {
      await step("clear labels", "etiquetas", () =>
        client.setConversationLabels(conversationId, []),
      );
      await step("clear custom attributes", "atributos", () =>
        client.clearConversationCustomAttributes(conversationId),
      );
      // Clear the linked kanban card's scheduled dates too (item 17): a reset is a clean slate, so a
      // stale start/due date from the prior episode must not linger. Title/description/step are kept
      // (they identify the card / hold operator notes). Best-effort — no card ⇒ skip.
      //
      // The card's ATTRIBUTES go with the dates, and used not to: `set_custom_attribute` writes to
      // three scopes and this command cleared one, so the agent kept every structured fact it had
      // extracted from the memory that was just wiped, and did not ask again. The card carries no
      // tension here — it belongs to this conversation and the reset already edits it.
      //
      // Two steps, not one, for the reason every other cleanup here gets its own: they are
      // independent endpoints, and sharing a try meant a failure on the dates skipped the attributes
      // entirely — the exact shape of #79, where the first failure silently ended the reset.
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
          client.setKanbanTaskCustomAttributes(taskId, {}),
        );
      }
    }
    // The contact's Chatwoot attributes are deliberately NOT cleared, and the acknowledgement below
    // says why without having to: it promises the attributes of THIS CONVERSATION. Contact
    // attributes outlive the conversation, are shared with every other conversation of every other
    // agent on the account, and nothing records who wrote one — the definitions are account-wide, so
    // the narrowest set this command could name still includes an operator's CRM field and an
    // integration's column. Deleting those is not undoable, and the cost of keeping them is that the
    // agent may not re-ask something it already knows.
    //
    // `voiceReply` above is the contrast that draws the line: it is OUR column, written only by our
    // own tool, so its provenance is total and clearing it is this command's business.
    //
    // NOTE: the agent still reads those attributes into its prompt after a reset, so a test run can
    // start over and skip a question it already has an answer for. Wanting them cleared is
    // legitimate; doing it safely needs provenance the schema does not carry today.
    // LAST, and that ordering is the point. The state that decides whether the agent may speak AT
    // ALL — `shouldBotHandle` needs both `status === "pending"` and an assignee that is not a human
    // — is also the state that makes the NEXT delivery actionable. Returned first, a customer
    // message arriving while the steps above are still running passes the gate and starts a turn on
    // the very episode this command is in the middle of erasing: memory not yet cleared, attributes
    // still set, the previous ladder still armed. Returned last, that window holds the human's
    // ownership, which is the state the conversation was already in.
    //
    // The reason the rest of this command was useless after a handoff, and the reason it runs at
    // all: the canonical test loop — activate with /teste, let the agent transfer to a human,
    // resolve, start over — ended with a conversation that announces itself as active and then never
    // answers, and the only thing that undid it was "Devolver para IA" in the console. That is
    // behind a login, and the common case is an operator handing a test agent to a client who has
    // Chatwoot and no console at all.
    //
    // `stillOurs()` rather than testing the assignee alone: an assignment to another persona's bot,
    // or a conversation left `open`, silences it just as effectively — and it asks about the persona
    // bound to THIS INBOX from a FRESH read, which is the same question the acknowledgement below
    // asks. Skipped when the answer is already yes, so an ordinary reset does not spend two admin
    // calls undoing nothing.
    //
    // `returnConversationToAgent` and not a local unassign+toggle: the ORDER is load-bearing and
    // documented there, the two cannot collapse into one `toggle_status`, and it mirrors the write
    // so the very next delivery passes the gate instead of waiting for a Chatwoot event.
    //
    // Only when the blocker is OWNERSHIP. A disabled agent is the one case where returning the
    // conversation makes things worse than leaving them: the runtime refuses to run a disabled agent
    // (the away-message branch says so in as many words), so an unassign would take the human off a
    // conversation nothing is left to answer. The command still clears everything else — starting the
    // episode over before switching the agent back on is a reasonable thing to want — and says what
    // it did not do.
    // Everything below decides from the MIRROR, and the mirror lags Chatwoot by one webhook. That is
    // fine for the rest of the command — it acts on our own state — but the hand-back is the one act
    // here that reaches a third party, taking a conversation away from whoever holds it. A human who
    // took over during the cleanup (a dozen network calls long) may not have arrived in the mirror
    // yet, and then `heldBySameParty` compares a stale holder against itself, answers "unchanged",
    // and the command unassigns the very takeover the fence exists to protect.
    //
    // A REFRESH of the mirror, not a second read beside it: the four fences that follow
    // (answerBlocker, heldBySameParty, and the ack's own recheck) all read that row, and answering
    // one of them from a different source is how two fences come to disagree about who holds a
    // conversation. reconcileMirrorFromLive is also the versioned path — a webhook that landed with
    // something newer wins instead of being overwritten by this GET — and it is the same probe
    // `runAgentNudge` runs before ITS irreversible act, for the same reason.
    //
    // Best-effort on purpose. Failing to refresh leaves the decision exactly where it stood before
    // this line, which is where it stood for every round of this PR; it does not warrant telling the
    // operator the assignment failed, so it is logged rather than collected into `failed`.
    if (notOursAtStart) await refreshFromLive("the hand-back", client);
    const resetBlocker = await answerBlocker();
    // `undefined` = never attempted, which is a third answer and not a quieter version of the other
    // two: the two guards below stand the hand-back down for reasons the acknowledgement has to
    // report differently from a hand-back that ran and answered.
    let handBack: ReturnToAgentOutcome | null | undefined;
    // A TURN FROM BEFORE THE RESET IS STILL RUNNING, AND THE HAND-BACK IS WHAT WOULD LET IT SPEAK.
    // The memory step above refuses on this same question for its own reason (the turn's save would
    // restore what the clear deletes). This is the SECOND thing one in-flight turn breaks, and it
    // breaks it in the opposite direction: that turn is carrying a reply composed BEFORE the operator
    // asked for a clean slate, and the takeover is the only thing currently keeping it quiet. Its
    // ownership recheck reads the mirror for exactly two fields (../../graph/runtime.ts, the
    // `shouldBotHandle` recheck) — status `pending` and no assignee — which is precisely the state a
    // successful hand-back writes. Returning the conversation therefore un-silences the stale reply
    // and posts it over the human who had claimed the conversation.
    //
    // The direct webhook turn is the one that gets here: it passes `stillWanted: null`, so nothing
    // can call it off once it is invoking. A debounced flush is retired through its own job and
    // stands down by itself.
    //
    // Checked in memory and outside the memory step's lock, which is enough for the harm named: a
    // turn that starts AFTER this line loads the memory the reset just cleared, so it is not the
    // stale turn this guards against.
    //
    // Standing down is the honest answer and not a lesser one — the conversation stays exactly where
    // the operator found it, the acknowledgement says so and why, and `/reset` typed again once the
    // turn lands finds nothing stale left to release.
    //
    // BOTH markers, because a turn sets two and they are not interchangeable. The per-conversation
    // one is claimed at the top of the turn (../../graph/runtime.ts, at `status.started()`); the
    // graph one only later, inside the ingest lock, after the checkpointer and the divider write. A
    // turn caught between them is running and posting into this very conversation while the graph
    // key still reads free. The conversation key also carries the case a contact-inbox id cannot:
    // with `contactInboxId` null the graph thread IS the conversation thread, and a guard that gave
    // up on the null asked nothing at all. And a follow-up nudge claims ONLY the graph key
    // (../../graph/nudge.ts) while posting into the conversation, so neither key alone is the
    // question. `resolveGraphThreadId` is the same resolution the turn marks with, rather than a
    // second copy of the rule.
    const graphKey = resolveGraphThreadId(
      tenantId,
      instanceId,
      conversationId,
      ctx.conv.contactInboxId,
    );
    // The graph half is asked of the ROW when there is one to ask (issue #203): a turn running on
    // another replica is invisible to this process's registry, and handing the conversation back
    // under it is the case this guard exists for. With a null contact inbox the graph thread IS the
    // conversation thread and has no row, so that key keeps the in-process answer, which is what the
    // conversation key has anyway.
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
            // The holder the two guards above just agreed on, carried in rather than re-read there:
            // a re-read inside the hand-back would answer about a moment AFTER `heldBySameParty`,
            // and somebody arriving in between would become the baseline and be unassigned.
            assigneeType: ctx.conv.assigneeType,
            assigneeId: ctx.conv.assigneeId,
          }),
      );
    }
    // Best-effort is the design; announcing a full reset after a partial one is not. The operator
    // typed /reset to get a clean slate, and acting on a conversation that is not clean is worse than
    // knowing what survived.
    const distinctFailed = [...new Set(failed)];
    // The assignment is the one thing the operator can SEE not happening, so silence about it would
    // read as the command failing. Only when it was actually withheld: a conversation the agent
    // already owned has nothing to explain.
    //
    // TWO questions, because the operator is about to watch the agent not answer and there are two
    // independent reasons for that. Ownership has four ways to arrive and each was silent in its own
    // way — the hand-back ran and found a new holder, the holder changed before it could run, or the
    // conversation was the bot's at the start and somebody claimed it during the cleanup — so that
    // sentence is chosen from the state at the END, not from which guard fired.
    //
    // Being SWITCHED OFF is the other, and it is not a variety of the first: a disabled agent that
    // still owns a pending conversation reads as a clean reset and answers nothing. Asking ownership
    // first made this arm reachable only when somebody else held it, which is the one case where the
    // agent being off is the LESS surprising half. The other two places that answer this question
    // (the /teste acknowledgement and the activation notice) already keep the two apart; this was the
    // third and it was the one that did not.
    const leftWithSomebodyElse = !(await stillOursOrUnknown());
    const heldBack =
      resetBlocker === "disabled"
        ? leftWithSomebodyElse
          ? " Este agente está desativado, então ele não vai responder e a conversa continua com quem a atendia."
          : " Este agente está desativado, então ele não vai responder."
        : !leftWithSomebodyElse
          ? ""
          : turnStillRunning
            ? // Never attempted, and for a reason the operator can act on. Distinct from the arm
              // below because nobody arrived during the reset: the conversation is with the same
              // person it started with, and the hand-back is a retry away rather than lost.
              " Uma resposta anterior ao reset ainda está sendo gerada, então a conversa continua com quem a atendia. Digite /reset de novo quando ela terminar."
            : handBack === null
              ? // Attempted and threw. `failed` already names the assignment below, and explaining
                // the same conversation twice reads as two separate problems.
                ""
              : " Alguém assumiu a conversa durante o reset, então ela continua com essa pessoa.";
    await postAcknowledgement(
      distinctFailed.length === 0
        ? `🔄 Memória, preferência de áudio e etiquetas/atributos desta conversa foram limpos.${heldBack}`
        : `⚠️ Reset parcial: não consegui limpar ${distinctFailed.join(", ")}. O restante foi limpo.${heldBack}`,
    );
    logger.info(
      "chatwoot: /reset (conv=%s failed=%s)",
      String(conversationId),
      distinctFailed.length === 0 ? "none" : distinctFailed.join("|"),
    );
    return true;
  }
  // A /reset typed while test mode is NOT yet active for this conversation (no /teste) must not wipe
  // memory — and must NOT return out of this function, or the caller would run the turn and the agent
  // would answer pre-activation. Do nothing here and fall through to the test-mode gate below (which
  // silences the conversation and posts the one-shot activation notice). BUG FIX: this case used to
  // `return false`, which let the agent respond before /teste.
  if (isReset) {
    logger.info(
      "chatwoot: /reset with test mode not active — deferring to the test-mode gate (conv=%s)",
      String(conversationId),
    );
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
            ? // This notice fires ONLY while the conversation has never been activated, and `/reset`
              // needs `testActivatedAt` to run (shouldRunReset) — so pointing at it alone would send
              // the operator down the same no-op path, and the one-shot watermark would then suppress
              // any further guidance. Both commands, in the order that works: /teste lifts the
              // test-mode silence, /reset returns the conversation to the agent.
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
    // ── The CUSTOMER-facing half (#153), on its own watermark and its own cadence. A DISABLED agent
    //    still tells the operator why it is quiet — that note is pre-existing behavior nobody but the
    //    operator sees — but it acquires no voice toward the customer: switching an agent off switches
    //    off everything it says to them, which is why the runtime refuses to run it a few lines later.
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

  // ── Spend ceiling: the tenant's own token budget for the calendar month (issue #146). BEFORE the
  //    authorization gate below, and that ordering is the point: past this line the turn is not going
  //    to run, so asking somebody else's endpoint whether the contact may be served would be spending
  //    a stranger's network call on a question whose answer changes nothing. It is also the cheapest
  //    gate here, one indexed local read (measured: 1.3ms median over a 1M-row ledger spread across
  //    200 tenants, see `tokensUsedSince`).
  //
  //    Over the ceiling ⇒ the operator's configured sentence to the customer, then a handoff so a
  //    human can pick the conversation up, then a private note saying why the agent went quiet.
  //    That sequence, its order and its cooldown live in the spend-ceiling module rather than here,
  //    because the debounce flush owes the customer exactly the same three things when the ceiling
  //    is crossed inside the debounce window. What stays local is what only this caller can supply:
  //    the fenced primitives above, which know that a conversation a human took is one the bot no
  //    longer speaks in. ──
  if (ctx.agentId !== null && ctx.agentEnabled && isNewIncomingMessage(n)) {
    const ceiling = await spendCeilingVerdict({
      tenantId,
      source: "inbox",
      base,
    });
    // ALREADY ANSWERED ⇒ NOTHING TO REFUSE, and nothing to report either. The same fan-out this
    // gate's occasion key is about sends one message down two routes, and the two read the ledger at
    // different instants: the first can be under the ceiling, run its turn, and commit the usage
    // that puts the tenant over before the second gets here. The second would then tell a customer
    // the agent cannot answer, open the conversation for humans, and write an `error` line saying a
    // turn was skipped for budget — about a message that was answered.
    //
    // The watermark is what says it was: `runAgentTurn` advances it on the message it posted for.
    // Read only on the `over` branch, so the ordinary message pays nothing for it, and read BEFORE
    // the announcement so a refusal that did not happen leaves no record of having happened.
    //
    // It does not close the whole race. A delivery landing inside the window between the other
    // route's usage write and its watermark CAS sees neither, and that narrow interleaving is left
    // to the CAS, which is what keeps the ANSWER single. What this closes is the wide half: a second
    // delivery arriving after the first has finished, which needs no coincidence at all.
    if (ceiling.state === "over") {
      const handled = await readHandledWatermark({
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
      // AND THE AGENT HAS TO BE RUNNABLE FOR THE BUDGET TO BE WHAT STOPPED IT. `ctx.agentEnabled`
      // is the operator's switch and not the whole question: `loadAgentConfig` also returns null
      // when the agent row is gone, and when the model `credentialRef` no longer resolves (deleted
      // from the vault, or a NAME stored where a `vault:<id>` belongs). In both cases `runAgentTurn`
      // returns `agent-unavailable` before a model is built, so the same message under a ceiling
      // with room is already unanswered — refusing here would tell the customer and the operator
      // that a budget silenced an agent that could not have spoken anyway, and send them to raise a
      // number that changes nothing.
      //
      // NOTHING TO ANSWER ⇒ NOTHING TO REFUSE, on the direct path as on the flush's. A message that
      // renders to nothing for the agent — blank content, an attachment type we do not recognise, a
      // reaction — makes `runAgentTurn` return `skipped` before any billed call, so under a ceiling
      // with room this customer is already unanswered and in silence. Refusing it would send them
      // the operator's sentence, put the conversation in a human's queue and write an `error` line,
      // all about a message no model was ever going to see. Asked with `incomingRenderable`, the
      // same shape the turn renders from, so the two cannot drift.
      if (!renderInboundMessage(incomingRenderable(n))) {
        logger.info(
          "chatwoot: spend ceiling reached (conv=%s) — but the message renders to nothing, so there is no turn to refuse",
          String(conversationId),
        );
        return false;
      }
      // Read only on the refusing branch, so the ordinary message pays nothing for it, and asked of
      // the SAME function the turn asks rather than a second copy of its rules.
      // `skipExperiment` because resolving an A/B variant INSERTS the thread's assignment: a probe
      // must not enrol a turn that is not going to run.
      //
      // A PROBE THAT COULD NOT ANSWER IS NOT AN AGENT THAT CANNOT RUN, and the two must not collapse
      // into one. The ceiling fails OPEN when the ceiling itself is unreadable — a customer must not
      // be silenced by our own database hiccup — but here the verdict is read and says `over`, and
      // this probe is only the escape hatch from it. An unreadable escape hatch does not open: the
      // pool that refused this read has nothing to do with the budget the operator capped, and
      // treating the error as "not runnable" would let the turn run and SPEND past the ceiling,
      // which is the one outcome this gate exists to prevent.
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
      // ONE REFUSED MESSAGE, ONE LINE, which is what this gate promises and could not keep on its
      // own. Chatwoot fans an incoming message to the conversation's assigned agent bot AND to the
      // inbox's, and the two deliveries run concurrently under two ids, so an unkeyed announcement
      // put two `over` rows and two alert bumps on the Logs page for one customer. The sequence
      // below is already single-flighted per conversation; this is the same fan-out reaching the
      // line thirty lines above it. Keyed by the message the delivery carries, so nothing about a
      // DIFFERENT message can be swallowed with it.
      // The INSTANCE is part of the message's identity: Chatwoot message ids are account-local, so
      // a tenant connected to two Chatwoot instances has two different messages numbered the same,
      // and a key without it would hand the second one the first's window — one refused customer
      // losing their row and their alert, which is the exact invariant this key exists to keep.
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
        // The message is the refusal, so two deliveries of it coalesce and two messages do not.
        // Without an id (an event shape that carries none) the delivery names itself, which
        // coalesces nothing and is the safe direction: saying it twice beats not saying it.
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
        String(ceiling.usedTokens),
        String(ceiling.ceilingTokens),
      );
      return true;
    }
  }

  // ── Contact authorization gate: an agent that may only serve contacts a system outside the
  //    console knows about (docs/contact-auth.md) asks it before spending a turn. Last of the gates
  //    on purpose: a conversation an earlier gate already silenced costs no authorization call. The
  //    identity is what Chatwoot mirrored for the contact (phone, email, the operator's own
  //    identifier), never anything the customer typed; under POST with includeMessageText the
  //    triggering text rides along too, in its own `message` field, so the endpoint can accept an
  //    unlock code. EVERY message is re-checked (no verdict outlives its request), so a revocation
  //    or an unlock on the endpoint's side takes effect on the very next message. Denied ⇒ the
  //    operator's fixed copy + a handoff to humans; cannot-tell (an endpoint failure, a contact
  //    with no identifiers) ⇒ fail-closed silence toward the customer, with a private note telling
  //    the operator why. Copy and note sit behind a cooldown (noticeCooldownSeconds), the verdict
  //    never does: a refused burst is re-checked every time but voiced once per window. ──
  if (ctx.agentId !== null && ctx.agentEnabled && isNewIncomingMessage(n)) {
    const authCfg = readContactAuthConfig(ctx.agentSettings);
    if (authCfg.enabled) {
      const agentId = ctx.agentId;
      // Opens the conversation for the human queue (the handoff_to_human mechanics: status `open`
      // ends the bot's attribution, the optional team assignment routes it). Best-effort the same
      // way the tool is: the open is what matters, an assignment failure never undoes it.
      // A Chatwoot team id belongs to ONE account, so the stored number is only meaningful in the
      // account it was picked from. The editor records that account alongside it and stops offering
      // a target once the agent serves several — but a value can still arrive through REST, MCP or
      // an import, and an agent MOVED between accounts keeps a number the editor has no reason to
      // question: there is one account again, just not the one the id came from. So the recorded
      // account is what decides, and counting accounts is only the fallback for a value stored
      // before the field existed. Asked only when a target is configured, and only on a refusal,
      // which is rare and already spending two API calls.
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
      const verdict = await authorizeContact({
        tenantId,
        agentId,
        contactDbId: ctx.conv.contactId,
        conversationId,
        inboxId: ctx.inboxChatwootId,
        channelType: ctx.channelType,
        messageText: n.message?.content ?? null,
        // The message id under an unlock flow, where the verdict is a function of the text; the
        // source otherwise. Never the text itself: it must not reach a cache key.
        requestKey: authCfg.includeMessageText
          ? `msg:${n.message?.id ?? "none"}`
          : "inbox",
        cfg: authCfg,
        base,
        fetchImpl: deps?.contactAuthFetch,
      });
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
        contactAuthFlowEvent(verdict),
      );
      if (verdict.outcome !== "allowed") {
        // Coalescing the QUESTION is not coalescing the ANSWER's consequences. The single-flight
        // asks the endpoint once about a contact, which is right; the copy, the handoff and the
        // note belong to a CONVERSATION, and one contact can have two open ones. Gating these on
        // `!verdict.shared` meant the follower's conversation got no copy, no note and above all no
        // handoff — opening the leader's does not open the follower's, so a refused contact sat
        // there unanswered. What stops two deliveries of the SAME conversation from both speaking
        // is the notice claim below, which is per conversation and synchronous.
        //
        // Actions in this order: customer copy first (after the open the conversation is no longer
        // the bot's and the fence would rightly withhold it), then the handoff, then the note, so
        // the note can say what actually happened. An ERROR hands nothing off: it is transient by
        // contract (the next message retries), and escalating every blip of the endpoint would page
        // humans for conversations the next message answers.
        {
          const cooldownMs = authCfg.noticeCooldownSeconds * 1000;
          const claim = (notice: ContactAuthNotice) =>
            claimContactAuthNotice(
              contactAuthNoticeKey(tenantId, agentId, ctx.conv.id, notice),
              cooldownMs,
            );
          // The copy's window is claimed only when a copy is actually going out. Sharing one claim
          // with the note let an ERROR, which speaks to nobody, spend the customer's window and
          // silence the denial that followed it.
          const denyMessage =
            verdict.outcome === "denied" ? authCfg.denyMessage : null;
          const copyClaim = denyMessage ? claim("copy") : false;
          if (denyMessage && copyClaim) {
            // The window is claimed before the send, because two settled deliveries racing must not
            // both speak — so a send that does not land has to give it back. Kept, it would silence
            // the next refusal for the whole window over a message the customer never received.
            if (!(await postPublicMessage(denyMessage))) {
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
          const noteClaim = claim("note");
          if (noteClaim) {
            if (
              !(await postPrivateNote(contactAuthNoteText(verdict, handedOff)))
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
      // Allowed, and up to ten seconds may have gone by inside somebody else's endpoint. The
      // attribution gate that let this delivery through ran BEFORE that wait, and `runAgentTurn`
      // re-checks ownership only AFTER the model has answered — which withholds the reply and
      // nothing else, so a human who took the conversation during the round-trip would find the
      // agent's tools writing on it: a label, a Kanban card, a custom attribute, an outbound HTTP
      // call. The turn's own build-and-invoke is slow too and this does not pretend to fence that
      // (it is the runtime's window, and every agent has it); what it does is not WIDEN it by the
      // length of an operator's network call. Asked against the mirror, the same source the first
      // gate read.
      const now = await ownershipNow();
      if (!now.ours) {
        // NOTE: the same exit as the gate on the way in, so it leaves the same line. This is the one
        // `stillOurs` caller where a customer message that WOULD have been answered stops being
        // answered; the others guard a command or a handoff action, which have their own trail.
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
    }
  }
  return false;
}

export async function processChatwootDelivery(
  params: ProcessChatwootParams,
): Promise<"processed" | "skipped"> {
  const base = params.base ?? basePrisma;

  // tx1: CAS <claimFrom>→PROCESSING. A re-entry (duplicate POST that found a stranded PENDING) sees
  // 0 rows and skips.
  //
  // The claim is STAMPED, because the winner of this CAS is not always the first attempt: a
  // redelivery is deliberately allowed through to here on a row stranded on PENDING, and that claim
  // can land long after the row was received. `claimed_at` is the clock the stranded-delivery sweep
  // measures a PROCESSING row by; without it the sweep dates this live attempt to the original
  // receipt, calls it abandoned the instant it starts, and reports a lost message while the process
  // answering it is still running (issue #228).
  //
  // WHICH state it claims FROM is the caller's, and there are exactly two answers because there are
  // exactly two ways a delivery reaches this function.
  //
  //   "PENDING"  a delivery arriving, or a redelivery of one that never started. The row was just
  //              inserted, or was left where an insert put it.
  //   "DEAD"     a recovery of a delivery a process death stranded and the sweep gave up on (issue
  //              #295). `DEAD` is the sweep's verdict, reached by INFERENCE — nothing has moved this
  //              row — and a recovery that runs the turn is direct evidence that outranks it, the
  //              same way a turn already corrects a `DEAD` row it ran over (retireCoveredDeliveries).
  //
  // ONE CAS with two predicates, rather than a reclaim step followed by the ordinary claim. The
  // difference is a window: reclaiming first would leave the row PROCESSING with nothing holding it
  // if the process died between the two statements, which is the exact state this whole subsystem
  // exists to make impossible to reach silently. Here the winner of the single statement owns the
  // row, and a second recovery for the same row matches nothing and skips.
  //
  // `attempts` is incremented, and this is its first reader: it was carried unused since the ledger
  // was introduced, and the caller bounds a retry on it. A live delivery does not touch it — its
  // claim is not an attempt at recovery, it is the first attempt at all.
  const claimFrom = params.claimFrom ?? "PENDING";
  const claimed = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.chatwootWebhookDelivery.updateMany({
      where: { id: params.deliveryRowId, status: claimFrom },
      data: {
        status: "PROCESSING",
        claimedAt: new Date(),
        ...(claimFrom === "DEAD" ? { attempts: { increment: 1 } } : {}),
      },
    }),
  );
  if (claimed.count === 0) return "skipped";

  const n = params.normalized;

  // Only message_created drives commands, debounce and the agent turn. A message_updated can still
  // carry an audio attachment that was absent at creation time; it is eligible for STT only.
  const isNewIncoming = isNewIncomingMessage(n);
  const hasLateMedia = hasPendingInboundMediaUpdate(n);

  // A human agent's reply is folded into the contact's memory too (ingestUnhandledMessage), and the
  // inbox's agent is what says whether to ingest at all.
  const isNewHumanAgent = isNewHumanAgentMessage(n);

  // Resolve the bound agent for a new message (from either side) or a late-media update. The latter
  // never drives a turn.
  //
  // WIDENING THIS IS THE RISKY HALF of issue #187: `rt` turning non-null for a class of event it was
  // always null for can wake code that was unreachable, not just the code the change is for. Every
  // other reader of `rt` was checked against an outgoing message and none of them moves — the
  // eager-media and test-mode gates require isNewIncoming or hasLateMedia, `commandActive` reads a
  // `command` that is null off anything but a new incoming message, and the channel-redirect
  // follow-up arm sits inside `if (act && isNewIncoming)`. The only branch this reaches is the
  // ingestion one at the bottom of this function.
  const rt =
    isNewIncoming || hasLateMedia || isNewHumanAgent
      ? await inboxAgentRuntime(
          params.tenantId,
          params.instanceId,
          n.inboxId,
          base,
        )
      : null;
  const command = isNewIncoming ? controlCommand(n) : null;
  // NOTE: A control command is "active" only for a test-mode agent, and issue #270 is what happens when
  // that question is answered by a different row than the one that acts on it: `rt` resolves the
  // agent from the inbox id the PAYLOAD carries, while the test-mode gate downstream resolves it
  // from the inbox id STORED on the mirrored conversation. Disagree, and the operator sends /teste
  // and gets back the private note asking them to send /teste — a dead end with no way out from
  // inside the conversation, and nothing anywhere naming the command as the thing that was dropped.
  //
  // The payload stays PRIMARY, so an ordinary delivery is answered by exactly the query it always
  // was and pays for nothing extra. The stored row is consulted only when the payload names no
  // INBOX at all AND a command was actually typed, which is the miss path that used to dead-end.
  // The fallback can only ever turn a dropped command into an honoured one; it can never make an
  // active command inactive, so no delivery that works today changes.
  let commandMode: string | null = null;
  // The agent the command was decided against, from whichever of the two readings answered. Named
  // once and used by the line that reports a dropped one: `rt` is null on the sparse-payload path
  // even though the stored conversation names an agent there, and reading only `rt` writes a row
  // attributed to no agent and no inbox, on the one path where the ids cost nothing to keep.
  let commandAgent: { agentId: bigint; inboxId: bigint } | null =
    rt !== null ? { agentId: rt.agentId, inboxId: rt.inboxId } : null;
  if (command !== null) {
    if (rt !== null) {
      commandMode = rt.mode;
    } else if (n.inboxId == null) {
      // NOTE: ONLY when the payload named no inbox at all. An inbox it DID name that resolves to no agent
      // is an answer, not a gap: falling back there would decide the command against whatever inbox
      // the conversation pointed at BEFORE this event, and the mirror is about to move it to the one
      // that just arrived. The command would then be active for an agent the delivery never reached,
      // the route check would find no persona to match, and it would be consumed without running and
      // without an acknowledgement — a worse silence than the one this fixes.
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
  // Mirror metadata (idempotent, monotonic, per-conversation locked) BEFORE the gate so the
  // runtime reads fresh state. Unconditional: applies to every event, not just actionable ones.
  const mirror = await mirrorChatwootEvent(
    params.tenantId,
    params.instanceId,
    n,
    base,
    {
      suppressInboundWatermark: commandActive,
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

  // NOTE: A command that will not run is otherwise indistinguishable from ordinary customer text, in the
  // logs and in the conversation alike — which is what left issue #270 undiagnosable from the
  // outside. This is the only place that knows all three values the diagnosis needs, and past it
  // the command is simply gone: `isTeste`/`isReset` are both false, so every later line describes a
  // plain message. `mode=unresolved` means no inbox on either reading named an agent at all.
  //
  // BELOW the mirror, and that is the whole reason it sits here rather than where the values are
  // computed: the row hangs off the conversation, and the conversation row is what the mirror just
  // created (issue #317). The process line moved with it so one place still knows the fact.
  if (command !== null && !commandActive) {
    // WHO SPEAKS FOR THE COMMAND, asked here too and by the same rule the fence downstream uses for
    // an active one. Chatwoot fans a message out to the conversation's assigned bot AND the inbox's
    // (`agent_bots_for`), and both deliveries reach this line: measured live, one `/teste` on a
    // production agent produced two identical drops, one per route. They are not the same fact —
    // the inbox's persona is the one the command was about, and the other route only deferred to
    // it — so each delivery reports what IT did and the pair reads as one command.
    //
    // With no persona to compare against (no agent bound, or one with no `ChatwootAgentBot` row)
    // nothing here separates two deliveries, and both report the mode: a row twice is the lesser
    // failure than a command nobody reports, and that state already has #318's `route` line per
    // delivery for the same reason.
    //
    // BEST-EFFORT, and the id ONLY: this reading exists to report the delivery, and the mirror has
    // already committed by the time it runs. A rejection escaping here would leave the ledger row on
    // PROCESSING with nothing running, skip the gate and the turn, and never be retried — Chatwoot
    // was handed its 200 long before. A line about a dropped command must not be able to drop the
    // message it is describing, so an unreadable persona degrades to `no_persona`, which reports the
    // mode and loses only the route distinction.
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

  // Gate, then the agent runtime — all network OUTSIDE the transaction.
  // NOTE: The payload wins when it spoke (explicit null = a real unassign); when it said nothing
  // (no meta), fall back to the mirror's EFFECTIVE state — it preserves the stored trio now, so a
  // degraded event on a human-owned conversation must not read as bot-owned.
  const assigneeKnown = n.assigneeType !== undefined;
  // NOTE: Named once, asked twice: by the gate, and — when the gate closes — by the line that says
  // which of the two events closed it. Re-deriving it at the second question is how the two answers
  // drift apart, and the second is the one an operator reads afterwards.
  //
  // NOTE: only the assignee is lifted, and the literals below stay literals on purpose: the
  // per-call-site sweep for issue #210 reads the argument as written, so a call handed a named
  // object no longer shows it the `assigneeId` that makes the gate strict.
  //
  // WHICHEVER WITNESS SAYS THE CONVERSATION IS HELD, and the rule for that is `effectiveAssignee`
  // in ../chatwoot/normalize.ts, where the reasoning and its decision table live. The gate used to
  // prefer the payload wherever it spoke, and the payload always speaks: a rebuilt one states the
  // trio it read a moment earlier (#295), and Chatwoot's own is frozen at enqueue. A message may
  // never write the assignee (../chatwoot/state-order.ts), so a human taking the conversation left
  // the mirror correctly human-owned and the gate answering anyway. MEASURED on the recovery.
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
  // THE STATUS THE MIRROR SETTLED ON, not the one the payload proposed. `mirror` is the row AFTER
  // this event was written, so it already holds whichever of the two won: a new incoming message
  // that reopened a resolved conversation reads `pending` here exactly as Chatwoot does, and a
  // status the ordering refused reads the one that outranked it.
  //
  // The payload is only a proposal, and every payload here is a snapshot of an earlier instant:
  // Chatwoot freezes its own at enqueue, and a delivery recovery rebuilds one from reads made a
  // moment before (#295). MEASURED there — an operator resolving the conversation between the
  // rebuild and this line, the mirror correctly refusing the reopen, and the gate answering anyway
  // because it read the proposal instead of the outcome.
  //
  // NOT `mirror.applied`: that says the event won the ordering OVERALL, and the status is decided on
  // an axis of its own — a payload can be applied and still have its status refused, which is the
  // case measured above.
  //
  // The same shape as the assignee beside it, which already prefers what the mirror holds whenever
  // the payload is not the better witness.
  const effectiveStatus = mirror.status ?? n.status;
  const act = shouldBotHandle(
    {
      assigneeType: effectiveAssigneeType,
      status: effectiveStatus,
      assigneeId: effectiveAssigneeId,
    },
    { ourAgentBotId: params.agentBotId },
  );
  // Who is holding it, when somebody else is. A HUMAN taking a conversation is a statement about the
  // message: they will answer it, whichever bot route carried it here. ANOTHER BOT is not — its own
  // delivery of this same message may be running right now, and Chatwoot fans a message to two
  // routes whenever a conversation's assignee bot differs from the inbox's (`agent_bots_for`). The
  // settlement at the gate tail is scoped by this, and by nothing else about the gate.
  //
  // Asked of `heldByAnotherParty`, the same predicate the gate itself uses, rather than of `act`.
  // `act` is false for a second reason — a status that is not `pending` — so `assigneeType is
  // AgentBot && !act` calls OUR OWN bot another bot on every open or resolved conversation, and then
  // scopes away the sibling settlement on the most ordinary gate exit there is.
  const heldByAnotherBot =
    effectiveAssigneeType === "AgentBot" &&
    heldByAnotherParty(
      {
        assigneeType: effectiveAssigneeType,
        assigneeId: effectiveAssigneeId,
      },
      { ourAgentBotId: params.agentBotId },
    );
  const convLabel = n.conversationId === null ? "?" : String(n.conversationId);

  // ── A conversation this agent manages just transitioned TO resolved (by anyone: the agent's own
  //    resolve tool, an operator in our console, or a human resolving directly in Chatwoot). Two
  //    independent consequences hang off the same transition: memory compaction for EVERY agent, and
  //    the WhatsApp→chat redirect handling for a widget inbox.
  //
  // ── WhatsApp→chat redirect: the WIDGET conversation this agent manages just transitioned TO resolved
  //    (by anyone — the agent's own resolve tool, an operator in our console, or a human resolving
  //    directly in Chatwoot). Two things happen: (1) cancel any pending follow-up ladder job — a
  //    resolved conversation must not be chased; (2) if closing is on, post the closing message on the
  //    WhatsApp sibling. deliverRedirectClosing CAS-guards the per-conversation watermark, so this is
  //    idempotent under a re-delivered webhook AND against the ladder's own timed "closing" stage (only
  //    one of them delivers). Detected off the mirror's fresh prevStatus→status transition. Applies to
  //    ANY event carrying a status, not just message_created. `inboxAgentRuntime` is reused (a resolve is
  //    never a message, so not gated on isNewIncoming). Best-effort: a failure must not strand the
  //    delivery. ──
  if (
    mirror.applied &&
    mirror.prevStatus !== null &&
    mirror.prevStatus !== "resolved" &&
    mirror.status === "resolved" &&
    n.conversationId !== null
  ) {
    const conversationId = n.conversationId;
    // Both ids FROM THE MIRROR when the event does not carry them. A conversation_* payload can
    // arrive without `inbox` and without `contact_inbox` — the mirror handles that shape explicitly,
    // preserving the stored ids rather than nulling them — and gating on the event alone would skip
    // compaction for a resolve that is otherwise complete. Nothing comes back for it either: if the
    // customer returns on the same conversation there is no new-attendance boundary, so that history
    // stays raw indefinitely, on exactly the resolve trigger that exists to make the return turn
    // cheap.
    //
    // In its OWN best-effort boundary, ahead of everything else. The redirect handling below is a
    // different feature that happens to key off the same transition, and it is the one with a
    // deadline: it cancels the follow-up chase and posts the closing message. A transient failure in
    // this lookup would otherwise land in the shared catch, skip both of those, and still mark the
    // delivery processed — losing the closing sequence for good, for a conversation that will never
    // resolve again.
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
      const closingRt = await inboxAgentRuntime(
        params.tenantId,
        params.instanceId,
        closingInboxId,
        base,
      );
      if (closingRt) {
        // Memory compaction: an attendance that ended is an attendance that can become a summary.
        // Armed here, with a grace period, so the thread is already compacted BEFORE the customer
        // comes back — measurement says the resumption turn is the one billed fresh (cache rate
        // ~0% past 24h), so compacting only when they return would miss the expensive turn. The
        // job re-checks the status at execution, because a resolve can be undone. Unlike the
        // redirect handling below, this applies to every agent, not only a widget inbox.
        if (closingContactInboxId !== null) {
          try {
            await armCompaction({
              tenantId: params.tenantId,
              instanceId: params.instanceId,
              contactInboxId: closingContactInboxId,
              conversationId,
              agentId: closingRt.agentId,
              reason: "resolved",
              enabled: readMemoryConfig(closingRt.settings).compaction.enabled,
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
        const redirectCfg = readChannelRedirectConfig(closingRt.settings);
        // The redirect keys off the EVENT's inbox (it is the widget conversation that resolved).
        // A sparse payload carries none, and `widgetInboxId === null` would otherwise read as a
        // match on a half-configured agent.
        if (
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
          // (2) Closing message on the WhatsApp sibling (at most once, CAS-guarded). Chatwoot is
          //     already resolving the widget conversation, so resolveWidget:false.
          //
          //     Gated on the agent being live, the same question the ladder's own closing stage asks
          //     (issue #219). This is the OTHER way that goodbye reaches the customer — a resolve on
          //     the widget conversation, from anyone — and it sends fixed text with no nudge behind
          //     it, so nothing else on this path would ask. The cancel above stays ungated: standing
          //     the chase down is not a send, and a switched-off agent wants it stopped either way.
          const closingLive =
            redirectCfg.closingEnabled &&
            redirectCfg.entryInboxId !== null &&
            isRedirectFollowUpLive({
              agentEnabled: closingRt.enabled,
              agentMode: closingRt.mode,
              // Only a test agent's liveness depends on the stamp, and this read is paid on a path
              // whose failure is permanent: the surrounding best-effort catch sits AFTER the ladder
              // was cancelled, the delivery is marked PROCESSED, and a conversation resolves once —
              // so a transient error here would lose the closing for good. A production agent has
              // nothing to look up.
              testActivatedAt:
                closingRt.mode === "test"
                  ? await episodeActivationForWidget(
                      params.tenantId,
                      params.instanceId,
                      conversationId,
                      redirectCfg,
                      closingRt.mode,
                      base,
                    )
                  : null,
            });
          if (closingLive && redirectCfg.entryInboxId !== null) {
            const outcome = await deliverRedirectClosing({
              // The gate above is older than the sibling lookup, the client build and this
              // function's own reads, and this path has no job to ask about — so the switch is
              // re-asked from inside, at the same points the ladder asks (issue #246). One read, and
              // it fails OPEN: a conversation resolves once, so a transient error must not cost the
              // closing. A production agent needs no stamp lookup at all.
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
                if (rt.mode !== "test") return "go" as const;
                // NOTE: A test agent's answer takes a second read, and the two do not share a
                // snapshot: the switch could flip inside it. Left as a residual rather than closed,
                // because closing
                // it needs the agent and the stamp in ONE statement and `Inbox` has no `agent`
                // relation to select through — so it would take raw SQL or a schema change, for a
                // window one query wide on a test agent, on the path where the operator has just
                // resolved the conversation by hand.
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

  // Production analyzes every new incoming message. Some transports attach the audio just after
  // message_created, so the first useful attachment arrives on message_updated; analyze that update
  // without arming debounce or a second turn. Test mode keeps its cost fence and only analyzes a late
  // attachment on an activated EPISODE (issue #261) — the unit the other two gates use. Asked of the
  // row alone, an episode activated on the WhatsApp side got no transcription on the widget side, and
  // the agent then answered a message it never heard.
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
  if (
    rt?.enabled &&
    ((isNewIncoming && rt.mode === "production") ||
      (hasLateMedia && (rt.mode === "production" || activatedTestLateMedia)))
  ) {
    await runEagerMedia(params.tenantId, params.instanceId, n, base, {
      conversationId: mirror.conversationRowId,
      agentId: rt.agentId,
      inboxId: rt.inboxId,
    });
  }

  // First-class on-reply reset: a new customer message makes any pending inactivity follow-up moot.
  // Cancel it regardless of the bot gate (a reply while a human handles it should still stop the
  // bot's queued follow-up). Best-effort — a failure here must never strand the delivery.
  if (isNewIncoming && n.conversationId !== null) {
    const threadId = chatwootThreadId(
      params.tenantId,
      params.instanceId,
      n.conversationId,
    );
    try {
      await cancelPendingJob(
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
  }

  // Hoisted so the ingestion pass below can tell an out-of-hours-silenced incoming (consumed) from an
  // answered one. Stays false on every path that never runs the gate.
  // Say on the LEDGER that this delivery settled the message it carries — something ran over it, or
  // a gate decided deliberately that nothing would — AT THE MOMENT it is decided, never later.
  //
  // Later is the whole point. tx2 is the natural place and it is much too late: the error clearing,
  // the follow-up arming, the redirect re-arm, the ingestion pass and the watermark tail all sit in
  // between, each taking its own time, and a process that dies anywhere in that stretch leaves the
  // row PROCESSING for a message whose fate was already sealed. The stranded-delivery sweep would
  // then report it as a customer nobody answered and page somebody about it (issue #228).
  //
  // One body, called from each branch that decides, rather than one call reading a flag set by
  // them: the decision and the record have to be adjacent, and a flag is exactly the thing that
  // lets them drift apart again.
  //
  // "Settled" is not "answered", which is why the caller says which. What the ledger has to hold is
  // whether a message was lost to a PROCESS DEATH, and one a gate consumed or a turn answered with
  // silence was not lost. A delivery that armed a flush settles NOTHING here: the flush is what
  // will, and it retires the rows itself when it runs.
  // `scope` is which rows this settlement speaks for, and it is not always the conversation's.
  //
  //   "conversation"  every row for this message, whichever bot route received it. What a TURN can
  //                   say: it ran over the message and answered or deliberately did not, and that is
  //                   true of the message rather than of one delivery of it. It is also what rescues
  //                   a row an earlier attempt stranded.
  //   "this-delivery" only the row this process is working. What a gate taken because ANOTHER PARTY
  //                   holds the conversation can say. Chatwoot fans a message to up to two bot
  //                   routes (`agent_bots_for`: the assignee bot and the inbox bot, each with its
  //                   own delivery id), so the other party may be a bot whose own delivery is in
  //                   flight right now. Retiring its row would take a live loss out of the list.
  const settleDelivery = async (
    messageId: number,
    settlement: "answered" | "consumed",
    scope: "conversation" | "this-delivery" = "conversation",
  ): Promise<void> => {
    // Narrows for the call below, which takes a number. Every caller is already inside a branch that
    // needs a conversation, so nothing reaches here without one and removing this kills no test.
    if (n.conversationId === null) return;
    try {
      await retireCoveredDeliveries({
        tenantId: params.tenantId,
        instanceId: params.instanceId,
        conversationId: n.conversationId,
        conversationRowId: mirror.conversationRowId,
        settlement,
        ...(scope === "this-delivery"
          ? { deliveryRowId: params.deliveryRowId }
          : { messageIds: [messageId] }),
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
  let consumed = false;
  // What the contact-authorization gate below learned about this contact, for the direct turn's
  // prompt. Null when the gate is off, or when the delivery never reaches a turn.
  const gate: { authContext: AuthContext | null } = { authContext: null };
  // NOTE: `act || commandActive`, and the second half is the whole point: a control command is the
  // OPERATOR driving the tooling, not the agent speaking, so bot ownership is not its business. The
  // conversation a human took over is exactly where /reset has to work, and it is the state `act`
  // refuses — measured, not assumed: with a `User` assignee neither /teste nor /reset produced a
  // single Chatwoot call, on `open` and on `resolved` alike. The operator typed a command into a
  // silent conversation and got silence back.
  //
  // Same shape as the follow-up cancel below, which already runs regardless of this gate for the
  // same reason. The fence stays `commandActive` (`command !== null && mode === "test"`): for any
  // other agent these are ordinary customer text and never reach here.
  if ((act || commandActive) && isNewIncoming) {
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
    });
    if (!consumed) {
      // Eager media (STT/vision) so the debounce re-fetch (and the direct path) get text instead of an
      // empty audio/image message. For a production agent this already ran before the gate; the call
      // is idempotent, so here it only does real work for a test-mode agent that just passed the gate
      // (activated with /teste). Best-effort — a failure leaves a "please send text" marker.
      // `rt` is null when nothing on the payload's inbox names an agent — either none is bound, or
      // the payload named no inbox at all — and then no STT/vision config resolves and no line is
      // written, so the nulls never reach a row. The second half of that reaches here only through
      // a control command that the conversation's own agent made active (issue #270); the state
      // itself is not new, since `act` never depended on `rt`.
      await runEagerMedia(params.tenantId, params.instanceId, n, base, {
        conversationId: mirror.conversationRowId,
        agentId: rt?.agentId ?? null,
        inboxId: rt?.inboxId ?? null,
      });

      // Debounce path: an incoming message on a debounce-enabled agent re-arms the durable DEBOUNCE
      // job (coalescing window) instead of replying balloon-by-balloon. The fast worker flushes it
      // (re-fetch + coalesce + one reply). Arming is best-effort: if it fails we fall back to a direct
      // turn so the customer is never left unanswered.
      let armed = false;
      if (n.conversationId !== null && n.inboxId !== null) {
        try {
          const cfg = await resolveDebounceConfig(
            params.tenantId,
            params.instanceId,
            n.inboxId,
            base,
          );
          if (cfg) {
            const threadId = chatwootThreadId(
              params.tenantId,
              params.instanceId,
              n.conversationId,
            );
            const flushAt = await armDebounce({
              tenantId: params.tenantId,
              threadId,
              agentBotId: params.agentBotId,
              cfg,
              lastMessageId: n.message?.id ?? undefined,
              base,
            });
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
        try {
          // REPORTED FROM THE TURN'S OWN SETTLEMENT, never from the enclosing catch, and the two
          // are not interchangeable. This `try` also wraps the bookkeeping that follows — settling
          // the ledger, the unrouted line, clearing a surfaced error — and a caller reading
          // `{ kind: "error" }` cannot tell "the turn failed" from "the turn ANSWERED and a write
          // after it failed". The recovery (#295) acts on that difference: an error there puts the
          // row back to DEAD and the scheduler runs the whole turn again, so the customer is
          // answered twice and every side-effecting tool the turn called runs a second time.
          //
          // Today none of those three can throw — each swallows its own failure, and the flow-log
          // write is fire-and-forget. That is the point: the contract must not rest on a property of
          // three unrelated call sites that any of them could drop. Bound to the turn here, it
          // cannot.
          const outcome = await runAgentTurn({
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
          // The turn RAN over this message, so nothing is owed on it — EVERY outcome, where the
          // flush keeps two of them open. The rule belongs to the call site, because the same two
          // words mean different things on each side:
          //
          //   superseded  On the flush it means the burst is handed to a re-armed flush that will
          //               answer it and retire these same rows, so retiring them now would close a
          //               message before the run that covers it exists. Nothing is re-armed here:
          //               the graph already ran over this message (the thread state, reply included,
          //               is written before `shouldPost` is consulted), and it is the NEWER
          //               message's own delivery that carries the reply. Left open, the row is
          //               reported as a lost customer message every time the process dies in the
          //               tail after a deliberate supersede — which is the one thing separating this
          //               outcome from every other one on this path, since all of them close here.
          //   stale       Not reachable at all: `runAgentTurn` passes `stillWanted: null`, because
          //               nothing queued this turn and there is no job for /reset to retire. It is
          //               NOT written into the condition, because a branch no input can take is a
          //               branch no test can hold: it would read as a rule and be a comment. The
          //               premise it rests on is asserted instead, in
          //               tests/modules/delivery-sweep.test.ts, so the day something hands this path
          //               a `stillWanted` the failure points here rather than passing silently.
          //
          // NOTE: no `isNewIncoming` here, because the whole block is already inside it — an
          // incoming `message_updated` (our own media write-back coming around) never reaches this
          // line, which matters: it carries the same message id as the `message_created` whose row
          // may be stranded, and nothing about it answered anybody. Asserted from the outside in
          // tests/modules/delivery-sweep.test.ts, since a guard that is absorbed cannot be mutated.
          //
          // The null check below is absorbed by that same enclosing guard: an event that is a new
          // incoming message HAS an id. It answers the compiler, not the runtime, which is why
          // removing it kills no test — a survivor that is a narrowing rather than a rule.
          if (n.message?.id != null) {
            await settleDelivery(
              n.message.id,
              outcome === "posted" ? "answered" : "consumed",
            );
          }
          // NOTE: The turn had nowhere to go: no agent is bound to this inbox (issue #318). One line
          // per customer message that nothing will answer — `runAgentTurn` only reaches this outcome
          // for a new incoming message with text — which is the same unit as the gate's line below.
          //
          // The outcome is the WHOLE condition on purpose. `no-agent` used to also cover a binding
          // that exists and could not load (a switched-off agent, which is deliberate and gets no
          // line), and this branch first excluded that by re-reading the binding here. Re-reading is
          // what the second reading cost: the turn runs gates, mirroring and media in between, so a
          // rebind landing inside it answered about a different moment. `runAgentTurn` now
          // classifies the two from the same scoped read that decides them, and `agent-unavailable`
          // is the one this line stays silent about.
          if (outcome === "no-agent" && mirror.conversationRowId !== null) {
            emitUnroutedMessage({
              tenantId: params.tenantId,
              conversationRowId: mirror.conversationRowId,
              inboxRowId: mirror.inboxRowId,
              chatwootInboxId: n.inboxId,
              base,
            });
          }
          // Recovered: a successful answer clears any previously surfaced turn error (item 6).
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
          // Surface the failure to the operator (sanitized) so they can re-engage (item 6).
          if (n.conversationId !== null) {
            await recordConversationError({
              tenantId: params.tenantId,
              instanceId: params.instanceId,
              chatwootConversationId: n.conversationId,
              error: err,
              base,
            });
            // And, when nothing else is coming, say so INSIDE Chatwoot (issue #71). There is no
            // retry on this path, so the only thing that can still answer is a newer message's own
            // turn — the same fence the success path applies at `shouldPost`. Read by the announcer,
            // not here: the answer has to describe the moment of the note, not the moment of the
            // failure.
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
              error: err,
              base,
            });
          }
        }
      }

      // ── WhatsApp→chat redirect: (re)arm the cross-channel follow-up now that the turn for this
      //    message has been dispatched (debounced or direct), but ONLY when this message landed on
      //    the WIDGET conversation a channelRedirect-enabled agent manages (its
      //    channelRedirect.widgetInboxId — NOT the WhatsApp entry inbox, which never gets this job).
      //    `rt` (inboxAgentRuntime, above) already resolved this inbox's bound agent + settings for
      //    the eager-media/test-mode gates, so this reuses it rather than adding a query. Re-arming
      //    on every message doubles as cancel-on-reply (see armRedirectChatFollowUp's doc) — no
      //    separate cancel call is needed here, unlike the generic FOLLOWUP job above. Best-effort. ──
      if (rt && n.inboxId !== null && n.conversationId !== null) {
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
              // From the EVENT, not from the mirrored row: a mirror write whose ladder retirement
              // was rejected holds the pairing back, and this same delivery still arms. Reading the
              // row there would stamp the episode being left behind, and the payload that finally
              // applies the pairing would retire the ladder it had just armed.
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
    // THE SAME TWO READINGS THE GATE DECIDED ON, and that is the whole rule of this file: a line
    // that explains a decision has to name the values the decision was made from. `describeClosedGate`
    // says as much where it lives — the status rides along instead of being re-read, because a second
    // query would answer about a different moment — and a payload's own proposal is a different
    // moment just as surely. Reported from `n.status`, a conversation the mirror had already resolved
    // was recorded as `ownership_lost` at `pending`, sending an investigation after a missing
    // assignee when the answer was the status all along.
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
    // NOTE: The operator's own trail, and it is deliberately narrower than this branch: ONE line
    // per customer message the bot did not answer, never one per webhook event. This gate is the
    // only one those messages reach — a refused event arms no flush and starts no turn — so without
    // the line the silence an operator is investigating has nothing behind it (issue #271). The
    // narrowing is what keeps it readable: `message_updated` here is usually our own media
    // write-back coming back around, and a switched-off agent was never going to answer, so a line
    // there would explain the silence with the wrong reason.
    if (isNewIncoming && rt?.enabled && mirror.conversationRowId !== null) {
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

  // A new inbound message the bot deliberately leaves unanswered — the conversation is human-owned
  // (!act) or a command/test-mode gate consumed it — still advances the handled watermark: it is
  // context, not a pending task. Left behind, these pile up below the watermark and the first flush
  // after a human returns the conversation re-answers the whole human-era backlog, handoff reason
  // included (issue #8). When a turn WILL run (act && !consumed), the turn/flush owns the advance.
  // Best-effort: a miss only widens a later re-coalesce.
  if (
    isNewIncoming &&
    (!act || consumed) &&
    n.message?.id != null &&
    mirror.conversationRowId !== null
  ) {
    // The same fact the watermark records here, on the ledger: a human owns the conversation, or a
    // command or a gate consumed the message. Nothing further is coming for it, deliberately, so it
    // is not a message a crash lost — and a gate is silence by construction, never an answer.
    //
    // SCOPED to this delivery in exactly one case: another BOT holds the conversation. Then the
    // silence is about US, and the row this message also has on that bot's route belongs to a
    // delivery that may be working right now — retiring it takes a live loss out of the list. A
    // human holding the conversation is the opposite: they answer the message, whichever route
    // carried it, and so is a command or a test-mode gate consuming it. Both keep the wider scope,
    // which is also what rescues a strand an earlier attempt left behind.
    // THE WATERMARK FIRST, and the order is chosen by which way the pair fails.
    //
    // They are two writes and not a transaction, so a process dying between them leaves one of two
    // states. Settle first and the row is terminal while the watermark still sits below this
    // message: the sweep can no longer see it, and a flush after the conversation comes back to the
    // bot re-coalesces from that watermark and ANSWERS the message a gate deliberately suppressed —
    // a reply the product decided not to send, with nothing anywhere reporting it. Watermark first
    // and the row is left in the worklist for a message something did handle: a line in the loss
    // list that is wrong and VISIBLE, and correctable by the next turn that runs over it.
    //
    // Wrong and visible over quiet and wrong is the rule this whole change is built on.
    try {
      await advanceHandledWatermark({
        tenantId: params.tenantId,
        conversationDbId: mirror.conversationRowId,
        toMessageId: n.message.id,
        base,
      });
    } catch (err) {
      logger.warn(
        "chatwoot: advance handled watermark failed (conv=%s): %s",
        convLabel,
        errMsg(err),
      );
    }
    await settleDelivery(
      n.message.id,
      "consumed",
      heldByAnotherBot ? "this-delivery" : "conversation",
    );
  }

  // Continuous ingestion (production + enabled only): fold the messages no turn handled into the
  // agent's memory thread (a customer message it stayed silent on, a human agent's reply). Disabled /
  // test agents never ingest (no cost / no silent-period capture). Best-effort.
  if (rt?.enabled && rt.mode === "production") {
    await ingestUnhandledMessage({
      tenantId: params.tenantId,
      instanceId: params.instanceId,
      n,
      act,
      consumed,
      agentId: rt.agentId,
      compactionEnabled: readMemoryConfig(rt.settings).compaction.enabled,
      base,
    });
  }

  // tx2: mark processed. NOTE: a crash between tx1 and tx2 still strands the row in PROCESSING —
  // nothing here can close that window, because the process is gone. What closes it is the
  // stranded-delivery sweep (./delivery-sweep.ts): it does not replay the event, it REPORTS the row
  // and arms a recovery, so the payload never had to be stored. The recovery rebuilds a body from
  // the mirror plus one REST read and comes back through THIS function with `claimFrom: "DEAD"`
  // (issue #295, ./recover-delivery.ts).
  //
  // NOTE: By ID and with no CAS, which matters for one race and is the right side of it. A turn that
  // outlives the sweep's staleness threshold (nothing bounds a model call or a tool here) has its
  // row judged abandoned and marked DEAD while this process is still working, and then reaches this
  // line. Winning here is what leaves the row TRUE — the delivery did complete, late — so the
  // correction outlives the sweep's verdict. What cannot be taken back is the alert the sweep
  // already dispatched, which is why the threshold is generous; the residue is one false alert on a
  // pathological turn, against a row that ends up saying the right thing.
  await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.chatwootWebhookDelivery.update({
      where: { id: params.deliveryRowId },
      data: { status: "PROCESSED", processedAt: new Date() },
    }),
  );
  return "processed";
}
