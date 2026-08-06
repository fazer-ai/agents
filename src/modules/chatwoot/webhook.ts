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
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { shouldRunReset } from "@/modules/agents/test-mode";
import {
  isOpenAt,
  parseWindows,
  type WindowSpec,
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
import { armDebounce, resolveDebounceConfig } from "@/modules/debounce/service";
import { advanceHandledWatermark } from "@/modules/debounce/watermark";
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
import { loadAgentBot, loadChatwootClient } from "./instance";
import { mirrorChatwootEvent } from "./mirror";
import {
  type ControlCommand,
  controlCommand,
  firstAudioAttachment,
  firstVisualAttachment,
  isHumanAgentMessage,
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

  // A human agent's outgoing reply (a colleague messaged the customer while the bot was silent).
  if (isHumanAgentMessage(n)) {
    const text = (n.message.content ?? "").trim();
    if (!text) return;
    try {
      await ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId,
        contactInboxId,
        graphThreadId,
        messageId,
        role: "human_agent",
        text,
        agentName: n.message.sender?.name ?? null,
        base,
      });
    } catch (err) {
      logger.warn(
        "ingest (human agent) failed (conv=%s): %s",
        String(conversationId),
        errMsg(err),
      );
    }
    return;
  }

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
      role: "customer",
      text,
      base,
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
export function outOfHoursGate(
  hours: { windows: WindowSpec[]; timezone: string } | null,
  now: Date,
  noticeAlreadySent: boolean,
): { silence: boolean; postNote: boolean } {
  if (!hours || hours.windows.length === 0) {
    return { silence: false, postNote: false };
  }
  if (isOpenAt(hours.windows, hours.timezone, now)) {
    return { silence: false, postNote: false };
  }
  return { silence: true, postNote: !noticeAlreadySent };
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
    let hours: { windows: WindowSpec[]; timezone: string } | null = null;
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
          select: { mode: true, businessHoursId: true, settings: true },
        });
        if (agent) {
          mode = agent.mode;
          agentSettings = agent.settings;
          // The agent's "Availability" schedule (businessHoursId) gates REACTIVE replies: outside it
          // the agent stays silent (a one-shot private note tells the operator). Empty = always on.
          if (agent.businessHoursId !== null) {
            const bh = await db.businessHours.findUnique({
              where: { id: agent.businessHoursId },
              select: { windows: true, timezone: true },
            });
            if (bh) {
              hours = {
                windows: parseWindows(bh.windows),
                timezone: bh.timezone,
              };
            }
          }
        }
      }
    }
    return { conv, agentId, mode, hours, inboxChatwootId, agentSettings };
  });
  if (!ctx) return false;

  // A persona-bot client to ACK as the agent (bot token). Labels use the admin token regardless.
  const postAck = async (text: string): Promise<void> => {
    try {
      const bot =
        ctx.agentId !== null
          ? await loadAgentBot(tenantId, instanceId, ctx.agentId, base)
          : null;
      const client = await loadChatwootClient(tenantId, instanceId, {
        base,
        botToken: bot?.accessToken,
      });
      await client.sendMessage(conversationId, text);
    } catch (err) {
      logger.warn(
        "chatwoot: command ack failed (conv=%s): %s",
        String(conversationId),
        errMsg(err),
      );
    }
  };

  // Private note (operator-only, invisible to the customer) posted as the persona bot. Used for the
  // one-shot "agent is in test mode" notice on a silenced conversation.
  const postPrivateNote = async (text: string): Promise<void> => {
    try {
      const bot =
        ctx.agentId !== null
          ? await loadAgentBot(tenantId, instanceId, ctx.agentId, base)
          : null;
      const client = await loadChatwootClient(tenantId, instanceId, {
        base,
        botToken: bot?.accessToken,
      });
      await client.sendPrivateNote(conversationId, text);
    } catch (err) {
      logger.warn(
        "chatwoot: private note failed (conv=%s): %s",
        String(conversationId),
        errMsg(err),
      );
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
    await postAck("🧪 Modo teste ativado para esta conversa.");
    logger.info("chatwoot: /teste activated (conv=%s)", String(conversationId));
    return true;
  }

  // ── /reset (only when test mode is ACTIVE for THIS conversation): clear the contact's agent memory +
  //    audio preference + this conversation's labels and custom attributes. Deliberately does NOT touch
  //    testActivatedAt (the conversation keeps answering). Every step is best-effort; consumed regardless.
  if (isReset && shouldRunReset(ctx.mode, ctx.conv.testActivatedAt)) {
    // Clear the agent's memory thread (per contact-inbox / channel) AND the AgentThread marker (the
    // divider's last-conversation + the ingestion watermark), so a reset truly starts this channel's
    // conversation over. Only THIS channel's memory is cleared (the contact's other channels keep
    // their own threads), which matches where the operator typed /reset.
    if (ctx.conv.contactInboxId !== null) {
      const contactInboxId = ctx.conv.contactInboxId;
      try {
        const cp = await getCheckpointer();
        await cp.deleteThread(
          contactInboxThreadId(tenantId, instanceId, contactInboxId),
        );
      } catch (err) {
        logger.warn(
          "chatwoot: /reset deleteThread failed (conv=%s): %s",
          String(conversationId),
          errMsg(err),
        );
      }
      try {
        await runScopedOn(base, sysCtx(tenantId), (db) =>
          db.agentThread.deleteMany({
            where: { tenantId, chatwootInstanceId: instanceId, contactInboxId },
          }),
        );
      } catch (err) {
        logger.warn(
          "chatwoot: /reset clear agent-thread marker failed (conv=%s): %s",
          String(conversationId),
          errMsg(err),
        );
      }
    }
    if (ctx.conv.contactId !== null) {
      const contactDbId = ctx.conv.contactId;
      try {
        await runScopedOn(base, sysCtx(tenantId), (db) =>
          db.contact.update({
            where: { id: contactDbId },
            data: { voiceReply: null },
          }),
        );
      } catch (err) {
        logger.warn(
          "chatwoot: /reset clear voiceReply failed (conv=%s): %s",
          String(conversationId),
          errMsg(err),
        );
      }
    }
    try {
      const client = await loadChatwootClient(tenantId, instanceId, { base });
      await client.setConversationLabels(conversationId, []);
      await client.setConversationCustomAttributes(conversationId, {});
      // Clear the linked kanban card's scheduled dates too (item 17): a reset is a clean slate, so a
      // stale start/due date from the prior episode must not linger. Title/description/step are kept
      // (they identify the card / hold operator notes). Best-effort — no card ⇒ skip.
      const taskId = await client.kanbanTaskIdForConversation(conversationId);
      if (taskId != null) {
        await client.updateKanbanTask(taskId, {
          startDate: null,
          dueDate: null,
        });
      }
    } catch (err) {
      logger.warn(
        "chatwoot: /reset clear labels/attributes/card failed (conv=%s): %s",
        String(conversationId),
        errMsg(err),
      );
    }
    // Cancel any pending inactivity follow-up: a reset is an explicit "start over", so a queued
    // proactive nudge from the prior episode is moot. Best-effort.
    try {
      const threadId = chatwootThreadId(tenantId, instanceId, conversationId);
      await cancelPendingJob(
        tenantId,
        "FOLLOWUP",
        `followup:${threadId}`,
        base,
      );
    } catch (err) {
      logger.warn(
        "chatwoot: /reset cancel follow-up failed (conv=%s): %s",
        String(conversationId),
        errMsg(err),
      );
    }
    // Clear the follow-up watermarks so the sweep does not immediately re-arm a follow-up: a reset is
    // a clean slate, so no proactive nudge should fire until the CUSTOMER sends a genuine message
    // again (which re-anchors lastInboundAt). Also clear the one-shot notice watermarks (test-mode +
    // out-of-hours) so a fresh notice can be posted if this conversation is ever silenced again.
    try {
      await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.conversation.update({
          where: { id: ctx.conv.id },
          data: {
            lastInboundAt: null,
            lastFollowUpAt: null,
            testNoticeSentAt: null,
            outOfHoursNoticeSentAt: null,
          },
        }),
      );
    } catch (err) {
      logger.warn(
        "chatwoot: /reset clear test-notice flag failed (conv=%s): %s",
        String(conversationId),
        errMsg(err),
      );
    }
    await postAck(
      "🔄 Memória, preferência de áudio e etiquetas/atributos desta conversa foram limpos.",
    );
    logger.info("chatwoot: /reset (conv=%s)", String(conversationId));
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
    if (ctx.conv.testNoticeSentAt === null) {
      await postPrivateNote(
        "🧪 Este agente está em modo teste. Ele não responde automaticamente nesta conversa. Envie /teste para ativar as respostas aqui.",
      );
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
        send: postAck,
      });
      if (outcome !== "misconfigured") return true;
    }
  }

  // ── Availability gate: the agent's business hours (the "Disponibilidade" schedule) gate REACTIVE
  //    replies. Outside the configured window the agent stays silent and the operator gets a one-shot
  //    private note (same anti-spam watermark as the test-mode notice). Empty/no schedule = always on. ──
  const availability = outOfHoursGate(
    ctx.hours,
    new Date(),
    ctx.conv.outOfHoursNoticeSentAt !== null,
  );
  if (availability.silence) {
    if (availability.postNote) {
      await postPrivateNote(
        "🌙 Mensagem recebida fora do horário de atendimento. O agente não respondeu automaticamente; ele volta a responder no próximo horário disponível.",
      );
      try {
        await runScopedOn(base, sysCtx(tenantId), (db) =>
          db.conversation.update({
            where: { id: ctx.conv.id },
            data: { outOfHoursNoticeSentAt: new Date() },
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
  const act = shouldBotHandle(
    {
      assigneeType: n.assigneeType,
      status: n.status,
      assigneeId: n.assigneeId,
    },
    { ourAgentBotId: params.agentBotId },
  );
  const convLabel = n.conversationId === null ? "?" : String(n.conversationId);

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
    n.inboxId !== null &&
    n.conversationId !== null
  ) {
    const conversationId = n.conversationId;
    try {
      const closingRt = await inboxAgentRuntime(
        params.tenantId,
        params.instanceId,
        n.inboxId,
        base,
      );
      if (closingRt) {
        const redirectCfg = readChannelRedirectConfig(closingRt.settings);
        if (redirectCfg.enabled && redirectCfg.widgetInboxId === n.inboxId) {
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
