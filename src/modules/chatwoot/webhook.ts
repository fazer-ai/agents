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
import { ingestMessageIntoThread } from "@/graph/ingest";
import { runAgentTurn } from "@/graph/runtime";
import { AppError, UnauthorizedError } from "@/lib/errors";
import { withEntityLock } from "@/lib/locks";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { shouldRunReset } from "@/modules/agents/test-mode";
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
} from "@/modules/business-hours/hours";
import { linkRedirectConversations } from "@/modules/channel-redirect/cross-link";
import {
  armRedirectChatFollowUp,
  deliverRedirectClosing,
  followUpDedupeKey,
} from "@/modules/channel-redirect/followup";
import { runRedirectGate } from "@/modules/channel-redirect/gate";
import {
  isRedirectEntryInbox,
  readChannelRedirectConfig,
} from "@/modules/channel-redirect/service";
import {
  clearConversationError,
  recordConversationError,
} from "@/modules/conversations/error";
import {
  announceFailedTurn,
  readDirectFence,
} from "@/modules/conversations/failure-note";
import { armDebounce, resolveDebounceConfig } from "@/modules/debounce/service";
import { advanceHandledWatermark } from "@/modules/debounce/watermark";
import { armCompaction } from "@/modules/memory/compact";
import { clearContactMemory } from "@/modules/memory/reset";
import { readMemoryConfig } from "@/modules/memory/settings";
import { cancelPendingJob } from "@/modules/scheduler/service";
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
import {
  type AgentBotIdentity,
  loadAgentBot,
  loadChatwootClient,
} from "./instance";
import { mirrorChatwootEvent } from "./mirror";
import {
  type ControlCommand,
  controlCommand,
  firstAudioAttachment,
  firstLocationAttachment,
  firstVisualAttachment,
  isIncomingMessage,
  isNewIncomingMessage,
  normalizeChatwootEvent,
  shouldBotHandle,
} from "./normalize";
import { renderInboundMessage } from "./render";
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
      select: { agentId: true },
    });
    if (!inbox?.agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: { enabled: true, mode: true, settings: true },
    });
    if (!agent) return null;
    return {
      agentId: inbox.agentId,
      enabled: agent.enabled,
      mode: agent.mode,
      settings: agent.settings,
    };
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
  const webhookRouteTokenHash = hashRouteToken(token);
  const row = await asSuperAdminOn(base, (db) =>
    db.chatwootAgentBot.findUnique({
      where: { webhookRouteTokenHash },
      select: {
        chatwootInstanceId: true,
        tenantId: true,
        chatwootAgentBotId: true,
        webhookSecret: true,
      },
    }),
  );
  if (!row) return null;
  // Ignore a soft-disconnected account: the bot's webhook route may still exist in Chatwoot until the
  // unbind propagates, but we must stop handling its traffic (the rows are kept only for history).
  const inst = await asSuperAdminOn(base, (db) =>
    db.chatwootInstance.findUnique({
      where: { id: row.chatwootInstanceId },
      select: { disconnectedAt: true },
    }),
  );
  if (!inst || inst.disconnectedAt !== null) return null;
  return {
    instanceId: row.chatwootInstanceId,
    tenantId: row.tenantId,
    agentBotId: row.chatwootAgentBotId,
    webhookSecret: row.webhookSecret,
  };
}

export interface ReceiveChatwootResult {
  ack: true;
  outcome: "queued" | "duplicate" | "ignored";
  tenantId?: bigint;
  instanceId?: bigint;
  deliveryRowId?: bigint;
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

  const { rowId, duplicate } = await recordDelivery(
    base,
    bot,
    deliveryId,
    normalized.event,
  );

  return {
    ack: true,
    outcome: duplicate ? "duplicate" : "queued",
    tenantId: bot.tenantId,
    instanceId: bot.instanceId,
    deliveryRowId: rowId,
    agentBotId: bot.agentBotId,
    normalized,
  };
}

// Idempotency ledger insert: create-then-catch across two transactions (a unique violation
// aborts its own transaction). Unique on (chatwoot_instance_id, delivery_id).
async function recordDelivery(
  base: PrismaClient,
  bot: ResolvedChatwootBot,
  deliveryId: string,
  event: string,
): Promise<{ rowId: bigint; duplicate: boolean }> {
  try {
    const row = await runScopedOn(base, sysCtx(bot.tenantId), (db) =>
      db.chatwootWebhookDelivery.create({
        data: {
          tenantId: bot.tenantId,
          chatwootInstanceId: bot.instanceId,
          deliveryId,
          event,
          status: "PENDING",
        },
        select: { id: true },
      }),
    );
    return { rowId: row.id, duplicate: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await runScopedOn(base, sysCtx(bot.tenantId), (db) =>
      db.chatwootWebhookDelivery.findFirst({
        where: { chatwootInstanceId: bot.instanceId, deliveryId },
        select: { id: true },
      }),
    );
    if (!existing) throw err;
    return { rowId: existing.id, duplicate: true };
  }
}

export interface ProcessChatwootParams {
  tenantId: bigint;
  instanceId: bigint;
  deliveryRowId: bigint;
  agentBotId: number | null;
  normalized: NormalizedChatwootEvent;
  base?: PrismaClient;
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

async function isTestConversationActivated(params: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number | null;
  base: PrismaClient;
}): Promise<boolean> {
  if (params.conversationId === null) return false;
  const row = await runScopedOn(params.base, sysCtx(params.tenantId), (db) =>
    db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId: params.tenantId,
          chatwootInstanceId: params.instanceId,
          chatwootConversationId: params.conversationId as number,
        },
      },
      select: { testActivatedAt: true },
    }),
  );
  return row?.testActivatedAt != null;
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
// silent on (out of hours, or a human took over), and a HUMAN agent's reply sent while it was silent.
// Our own bot's outgoing reply is already in the thread (from the turn) and is skipped; so are
// notes/activities/templates. The CALLER gates this on an ENABLED + PRODUCTION agent (test/disabled
// never ingest — no cost), so a `consumed` incoming here is always an out-of-hours silence. Eager
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
  const armOnBoundary = (previousConversationId: number): Promise<void> =>
    armCompaction({
      tenantId,
      instanceId,
      contactInboxId,
      conversationId: previousConversationId,
      agentId: args.agentId,
      reason: "new_attendance",
      enabled: args.compactionEnabled,
      base,
    }).then(() => undefined);

  // A customer incoming message the bot will NOT answer: silenced out of hours (act && consumed) or
  // not bot-handled (!act — a human owns it, or it is not pending). An answered/debounced message is
  // covered by its turn and is NOT re-ingested here.
  const incomingUnhandled =
    isNewIncomingMessage(n) && ((act && consumed) || !act);
  if (!incomingUnhandled) return;
  const text = renderInboundMessage({
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
  try {
    await ingestMessageIntoThread({
      tenantId,
      instanceId,
      conversationId,
      contactInboxId,
      graphThreadId,
      messageId,
      text,
      base,
      onAttendanceClosed: armOnBoundary,
    });
  } catch (err) {
    logger.warn(
      "ingest (customer, unhandled) failed (conv=%s): %s",
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
  if (!hours || hours.windows.length === 0) {
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
  base: PrismaClient;
}): Promise<boolean> {
  const { tenantId, instanceId, n, command, commandActive, base } = params;
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
        outOfHoursNoticeSentAt: true,
        awayMessageSentAt: true,
        redirectSentAt: true,
        redirectCount: true,
        redirectLinkedAt: true,
        inboxId: true,
      },
    });
    if (!conv) return null;
    let agentId: bigint | null = null;
    let inboxChatwootId: number | null = null;
    let agentSettings: unknown = null;
    let mode = "production";
    let agentEnabled = true;
    let hours: Schedule | null = null;
    if (conv.inboxId !== null) {
      const inbox = await db.inbox.findUnique({
        where: { id: conv.inboxId },
        select: { agentId: true, chatwootInboxId: true },
      });
      inboxChatwootId = inbox?.chatwootInboxId ?? null;
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
      botToken: (await persona())?.accessToken,
    });

  // Is the conversation still the bot's, RIGHT NOW? `act` upstream was decided from the payload
  // Chatwoot sent, so a human who took the conversation between that event and this post is invisible
  // to it — and on a re-delivered webhook that gap is not milliseconds. The mirror applies assignment
  // events as they arrive, so a fresh read can see the handoff the payload could not. Same fence the
  // runtime puts before its own reply; it needs one because a model call is slow, this path needs one
  // because being fast is not being atomic.
  const stillOurs = async (): Promise<boolean> => {
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
    if (ourBotId === null && conv?.assigneeType === "AgentBot") return false;
    return shouldBotHandle(
      {
        assigneeType: conv?.assigneeType ?? null,
        assigneeId: conv?.assigneeId ?? null,
        status: conv?.status ?? null,
      },
      { ourAgentBotId: ourBotId },
    );
  };

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
        },
        base,
      });
      ctx.conv.testActivatedAt = linked.testActivatedAt;
    }
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
    await postPublicMessage("🧪 Modo teste ativado para esta conversa.");
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
      // Under the shared lock the job either finished before this ran (and this deletes everything it
      // wrote) or it finds the AgentThread row gone and drops the summary. The checkpointer call is a
      // separate connection, which is exactly why the advisory lock — and not the transaction — is
      // what serializes here.
      //
      // The order the three deletions run in is load-bearing and lives with its reasoning in
      // src/modules/memory/reset.ts.
      await step("clear agent memory", "memória", () =>
        runScopedOn(base, sysCtx(tenantId), (db) =>
          withEntityLock(
            db,
            `ingest:${contactInboxThreadId(tenantId, instanceId, contactInboxId)}`,
            async () => {
              await clearContactMemory({
                db,
                checkpointer: await getCheckpointer(),
                tenantId,
                instanceId,
                contactInboxId,
                threadId: contactInboxThreadId(
                  tenantId,
                  instanceId,
                  contactInboxId,
                ),
              });
            },
          ),
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
      await step("clear kanban card dates", "card do kanban", async () => {
        const taskId = await client.kanbanTaskIdForConversation(conversationId);
        if (taskId != null) {
          await client.updateKanbanTask(taskId, {
            startDate: null,
            dueDate: null,
          });
        }
      });
    }
    // Cancel any pending inactivity follow-up: a reset is an explicit "start over", so a queued
    // proactive nudge from the prior episode is moot.
    await step("cancel follow-up", "follow-up pendente", () =>
      cancelPendingJob(
        tenantId,
        "FOLLOWUP",
        `followup:${chatwootThreadId(tenantId, instanceId, conversationId)}`,
        base,
      ),
    );
    // Clear the follow-up watermarks so the sweep does not immediately re-arm a follow-up: a reset is
    // a clean slate, so no proactive nudge should fire until the CUSTOMER sends a genuine message
    // again (which re-anchors lastInboundAt). Also clear the one-shot notice watermarks (test-mode +
    // out-of-hours) so a fresh notice can be posted if this conversation is ever silenced again.
    await step("clear follow-up/notice watermarks", "marcadores", () =>
      runScopedOn(base, sysCtx(tenantId), (db) =>
        db.conversation.update({
          where: { id: ctx.conv.id },
          data: {
            lastInboundAt: null,
            lastFollowUpAt: null,
            testNoticeSentAt: null,
            outOfHoursNoticeSentAt: null,
            awayMessageSentAt: null,
          },
        }),
      ),
    );
    // Best-effort is the design; announcing a full reset after a partial one is not. The operator
    // typed /reset to get a clean slate, and acting on a conversation that is not clean is worse than
    // knowing what survived.
    const distinctFailed = [...new Set(failed)];
    await postPublicMessage(
      distinctFailed.length === 0
        ? "🔄 Memória, preferência de áudio e etiquetas/atributos desta conversa foram limpos."
        : `⚠️ Reset parcial: não consegui limpar ${distinctFailed.join(", ")}. O restante foi limpo.`,
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
    if (
      ctx.conv.testNoticeSentAt === null &&
      (await postPrivateNote(
        "🧪 Este agente está em modo teste. Ele não responde automaticamente nesta conversa. Envie /teste para ativar as respostas aqui.",
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
  return false;
}

export async function processChatwootDelivery(
  params: ProcessChatwootParams,
): Promise<"processed" | "skipped"> {
  const base = params.base ?? basePrisma;

  // tx1: CAS PENDING→PROCESSING. A re-entry (duplicate POST that found a stranded PENDING) sees
  // 0 rows and skips.
  const claimed = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.chatwootWebhookDelivery.updateMany({
      where: { id: params.deliveryRowId, status: "PENDING" },
      data: { status: "PROCESSING" },
    }),
  );
  if (claimed.count === 0) return "skipped";

  const n = params.normalized;

  // Only message_created drives commands, debounce and the agent turn. A message_updated can still
  // carry an audio attachment that was absent at creation time; it is eligible for STT only.
  const isNewIncoming = isNewIncomingMessage(n);
  const hasLateMedia = hasPendingInboundMediaUpdate(n);

  // Resolve the bound agent for a new message or a late-media update. The latter never drives a turn.
  const rt =
    isNewIncoming || hasLateMedia
      ? await inboxAgentRuntime(
          params.tenantId,
          params.instanceId,
          n.inboxId,
          base,
        )
      : null;
  const command = isNewIncoming ? controlCommand(n) : null;
  const commandActive = command !== null && rt?.mode === "test";

  // Mirror metadata (idempotent, monotonic, per-conversation locked) BEFORE the gate so the
  // runtime reads fresh state. Unconditional: applies to every event, not just actionable ones.
  const mirror = await mirrorChatwootEvent(
    params.tenantId,
    params.instanceId,
    n,
    base,
    { suppressInboundWatermark: commandActive },
  );

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
  const act = shouldBotHandle(
    {
      assigneeType: assigneeKnown
        ? (n.assigneeType ?? null)
        : mirror.assigneeType,
      status: n.status,
      assigneeId: assigneeKnown ? (n.assigneeId ?? null) : mirror.assigneeId,
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
          if (redirectCfg.closingEnabled && redirectCfg.entryInboxId !== null) {
            const outcome = await deliverRedirectClosing({
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
  // attachment when this conversation was explicitly activated.
  const activatedTestLateMedia =
    hasLateMedia &&
    rt?.enabled === true &&
    rt.mode === "test" &&
    act &&
    (await isTestConversationActivated({
      tenantId: params.tenantId,
      instanceId: params.instanceId,
      conversationId: n.conversationId,
      base,
    }));
  if (
    rt?.enabled &&
    ((isNewIncoming && rt.mode === "production") ||
      (hasLateMedia && (rt.mode === "production" || activatedTestLateMedia)))
  ) {
    await runEagerMedia(params.tenantId, params.instanceId, n, base);
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
  let consumed = false;
  if (act && isNewIncoming) {
    // Test-mode gate + /teste and /reset commands — may consume the delivery (skip all agent work).
    consumed = await maybeConsumeCommandOrGate({
      tenantId: params.tenantId,
      instanceId: params.instanceId,
      n,
      command,
      commandActive,
      base,
    });
    if (!consumed) {
      // Eager media (STT/vision) so the debounce re-fetch (and the direct path) get text instead of an
      // empty audio/image message. For a production agent this already ran before the gate; the call
      // is idempotent, so here it only does real work for a test-mode agent that just passed the gate
      // (activated with /teste). Best-effort — a failure leaves a "please send text" marker.
      await runEagerMedia(params.tenantId, params.instanceId, n, base);

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
          const outcome = await runAgentTurn({
            tenantId: params.tenantId,
            instanceId: params.instanceId,
            agentBotId: params.agentBotId,
            event: n,
          });
          logger.info(
            "chatwoot agent turn: conv=%s event=%s outcome=%s mirror=%s",
            convLabel,
            n.event,
            outcome,
            mirror.applied ? "applied" : "skipped",
          );
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
    logger.info(
      "chatwoot: bot silent by gate (conv=%s event=%s newIncoming=%s)",
      convLabel,
      n.event,
      isNewIncoming,
    );
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

  // tx2: mark processed. NOTE: a crash between tx1 and tx2 strands the row in PROCESSING; a
  // reaper (stale PROCESSING→PENDING) lands with the durable payload store.
  await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.chatwootWebhookDelivery.update({
      where: { id: params.deliveryRowId },
      data: { status: "PROCESSED", processedAt: new Date() },
    }),
  );
  return "processed";
}
