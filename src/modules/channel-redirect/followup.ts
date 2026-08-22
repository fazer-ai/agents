import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { type AgentNudge, parseThreadId, runAgentNudge } from "@/graph/nudge";
import type { RuntimeDeps } from "@/graph/runtime";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { loadAgentBot, loadChatwootClient } from "@/modules/chatwoot/instance";
import {
  type ObservedConversation,
  recordResolutionOrigin,
} from "@/modules/conversations/record-resolution";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import {
  buildTemplatePayload,
  type ProactiveSendMode,
  proactiveSendMode,
  readServiceWindowConfig,
} from "@/modules/service-window/service";
import { interpolateLink, resolveRedirectLink } from "./gate";
import {
  type ChannelRedirectConfig,
  REDIRECT_LINK_TTL_SECONDS,
  type RedirectDelayUnit,
  readChannelRedirectConfig,
  redirectDelayMinutes,
} from "./service";

// Cross-channel follow-up for the WhatsApp→chat redirect (see service.ts's header comment for the
// whole feature): once a lead lands on the widget conversation, a single REDIRECT_FOLLOWUP scheduler
// job chases them across three stages, advancing on the SAME row (mirrors appointments/reminders.ts):
//   1. "chat"     — idle in the widget conversation → a nudge THERE.
//   2. "whatsapp" — still idle → re-send the LINK on the WhatsApp SIBLING conversation as a FIXED
//                   message (waFollowupMessage, NOT AI — the lead may have left the chat, so this pulls
//                   them back); proactiveSendMode applies the 24h window/HSM template on official WhatsApp.
//   3. "closing"  — still idle after the WhatsApp escalation → post the closing message on BOTH channels
//                   (the website chat AND the WhatsApp sibling) and resolve both. A new widget message
//                   re-arms back to stage "chat" (enqueueJob upserts by dedupeKey), so replying in the
//                   chat supersedes a pending escalation/close.
// A closing also fires when the widget conversation is resolved by anyone (the webhook's resolve-
// transition detection) — there only the WhatsApp side is messaged, since the chat is already being
// resolved by the trigger. Both paths funnel through deliverRedirectClosing, which CAS-guards a
// per-conversation watermark (Conversation.redirectClosedAt) so the closing is delivered AT MOST ONCE.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export function followUpDedupeKey(widgetThreadId: string): string {
  return `redirect-followup:${widgetThreadId}`;
}

export type RedirectFollowUpStage = "chat" | "whatsapp" | "closing";

export interface RedirectFollowUpPayload {
  stage: RedirectFollowUpStage;
  widgetThreadId: string;
  // Agent.id, serialized as a string — scheduler job payloads are plain JSON.
  agentId: string;
  entryInboxId: number | null;
}

// Parse (and validate) a claimed job's raw payload. Pure — no I/O — so "is this payload usable" is
// unit-testable without a DB. Returns null on anything malformed.
export function parseRedirectFollowUpPayload(
  payload: Record<string, unknown>,
): RedirectFollowUpPayload | null {
  const stage =
    payload.stage === "whatsapp"
      ? "whatsapp"
      : payload.stage === "closing"
        ? "closing"
        : payload.stage === "chat"
          ? "chat"
          : null;
  const widgetThreadId =
    typeof payload.widgetThreadId === "string" ? payload.widgetThreadId : null;
  const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const entryInboxId =
    typeof payload.entryInboxId === "number" ? payload.entryInboxId : null;
  if (!stage || !widgetThreadId || !agentId) return null;
  return { stage, widgetThreadId, agentId, entryInboxId };
}

// Pure: the nudge content for each stage, kept separate from I/O so "what do we say" is trivially
// testable. A blank `instructions` yields no operator guidance — renderNudge (in graph/nudge.ts)
// already handles the directive + trigger fields on its own.
export function chatFollowupNudge(instructions: string): AgentNudge {
  return {
    source: "channel-redirect",
    kind: "chat-followup",
    instructions: instructions || undefined,
  };
}

// Pure: `now` + a delay in minutes → the run_at for the next stage. No I/O, `now` injected — mirrors
// computeReminderJobs's discipline in appointments/reminders.ts.
export function minutesFromNow(minutes: number, now: Date): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

export interface ArmRedirectChatFollowUpParams {
  tenantId: bigint;
  instanceId: bigint;
  widgetThreadId: string;
  agentId: bigint;
  entryInboxId: number | null;
  cfg: {
    chatFollowupEnabled: boolean;
    chatFollowupDelayValue: number;
    chatFollowupDelayUnit: RedirectDelayUnit;
    waFollowupEnabled: boolean;
    closingEnabled: boolean;
  };
  base?: PrismaClient;
  now?: Date;
}

// (Re-)arm the ladder at stage 1 (chat idle) whenever the lead messages the widget conversation this
// agent manages. enqueueJob upserts by dedupeKey — a fresh call always resets run_at AND resets the
// sequence's payload back to stage "chat" (a re-enqueue's payload is authoritative, see enqueueJob's
// doc), so re-arming on every message is ALSO the cancel-on-reply: a pending "whatsapp"/"closing" stage
// from a prior idle period is superseded rather than needing an explicit cancel — this is what stops a
// WhatsApp follow-up / closing from firing while the lead is actively replying in the chat. A no-op when
// EVERY follow-up step is disabled, or the thread doesn't belong to this tenant/instance (defense in
// depth — mirrors threadBelongsToTenant's fence in graph/nudge.ts). `enqueue` is injectable for tests.
export async function armRedirectChatFollowUp(
  p: ArmRedirectChatFollowUpParams,
  enqueue: typeof enqueueJob = enqueueJob,
): Promise<boolean> {
  if (
    !p.cfg.chatFollowupEnabled &&
    !p.cfg.waFollowupEnabled &&
    !p.cfg.closingEnabled
  ) {
    return false;
  }
  const parsed = parseThreadId(p.widgetThreadId);
  if (
    !parsed ||
    parsed.tenantId !== p.tenantId ||
    parsed.instanceId !== p.instanceId
  ) {
    return false;
  }
  const now = p.now ?? new Date();
  await enqueue({
    tenantId: p.tenantId,
    kind: "REDIRECT_FOLLOWUP",
    dedupeKey: followUpDedupeKey(p.widgetThreadId),
    runAt: minutesFromNow(
      redirectDelayMinutes(
        p.cfg.chatFollowupDelayValue,
        p.cfg.chatFollowupDelayUnit,
      ),
      now,
    ),
    payload: {
      stage: "chat",
      widgetThreadId: p.widgetThreadId,
      agentId: p.agentId.toString(),
      entryInboxId: p.entryInboxId,
    },
    base: p.base,
  });
  return true;
}

interface WhatsAppSibling {
  chatwootConversationId: number;
  // Mirrored status AND its version, read before the closing toggle: see record-resolution.ts
  // rule 2 and the floor in ObservedConversation.
  status: string;
  chatwootStatusAt: number | null;
  chatwootContactId: number;
  lastInboundAt: Date | null;
  channelType: string | null;
  provider: string | null;
}

// Resolve the WhatsApp sibling conversation of a widget conversation's contact: the OTHER conversation
// on the SAME contact whose inbox is the agent's configured entry (official WhatsApp) inbox, most-
// recently-active. Returns everything the proactive WhatsApp touches need — the sibling's conversation id
// (to post on), the contact's Chatwoot id (the token identity), plus the 24h-window inputs (lastInboundAt
// + inbox channel/provider). Powers stage 2 (re-send the link) AND the closing. null when the contact has
// no such conversation (never messaged that inbox, or the merge never linked it).
async function resolveWhatsAppSibling(
  tenantId: bigint,
  instanceId: bigint,
  widgetConversationId: number,
  entryInboxId: number,
  base: PrismaClient,
): Promise<WhatsAppSibling | null> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const widgetConv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: widgetConversationId,
        },
      },
      select: { contactId: true },
    });
    if (!widgetConv?.contactId) return null;
    const sibling = await db.conversation.findFirst({
      where: {
        contactId: widgetConv.contactId,
        chatwootInstanceId: instanceId,
        inbox: { chatwootInboxId: entryInboxId },
      },
      select: {
        chatwootConversationId: true,
        status: true,
        chatwootStatusAt: true,
        lastInboundAt: true,
        contact: { select: { chatwootContactId: true } },
        inbox: { select: { channelType: true, provider: true } },
      },
      orderBy: { lastEventAt: "desc" },
    });
    if (!sibling?.contact?.chatwootContactId) return null;
    return {
      chatwootConversationId: sibling.chatwootConversationId,
      status: sibling.status,
      chatwootStatusAt: sibling.chatwootStatusAt,
      chatwootContactId: sibling.contact.chatwootContactId,
      lastInboundAt: sibling.lastInboundAt,
      channelType: sibling.inbox?.channelType ?? null,
      provider: sibling.inbox?.provider ?? null,
    };
  });
}

export type WhatsAppFollowUpOutcome = "sent" | "no-sibling" | "misconfigured";

export interface SendWhatsAppFollowUpParams {
  tenantId: bigint;
  instanceId: bigint;
  agentId: bigint;
  // The widget conversation whose contact's WhatsApp sibling we re-engage.
  widgetConversationId: number;
  entryInboxId: number;
  cfg: ChannelRedirectConfig;
  // agent.settings — for the service-window config (the 24h-window gate).
  settings: unknown;
  base: PrismaClient;
  now: Date;
}

// Stage 2: re-send the redirect LINK on the WhatsApp sibling as a FIXED message (cfg.waFollowupMessage),
// NOT an AI nudge — the lead may have left the chat, so this fixed link is what pulls them back. Re-mints
// the token (a fresh, valid link) and posts via the persona bot, honoring the 24h window on official
// WhatsApp: free-form inside (and on no-window channels like baileys), a template outside if configured,
// else a private note (the lead's next WhatsApp message re-triggers the gate, which re-sends the link).
export async function sendWhatsAppFollowUp(
  p: SendWhatsAppFollowUpParams,
): Promise<WhatsAppFollowUpOutcome> {
  if (p.cfg.widgetInboxId === null) return "misconfigured";
  const sibling = await resolveWhatsAppSibling(
    p.tenantId,
    p.instanceId,
    p.widgetConversationId,
    p.entryInboxId,
    p.base,
  );
  if (!sibling) return "no-sibling";

  const url = await resolveRedirectLink({
    tenantId: p.tenantId,
    instanceId: p.instanceId,
    chatwootContactId: sibling.chatwootContactId,
    widgetInboxId: p.cfg.widgetInboxId,
    openWidget: p.cfg.openWidget,
    ttlSeconds: REDIRECT_LINK_TTL_SECONDS,
    base: p.base,
  });
  if (url === null) return "misconfigured";
  const text = interpolateLink(p.cfg.waFollowupMessage, url);

  const bot = await loadAgentBot(p.tenantId, p.instanceId, p.agentId, p.base);
  const client = await loadChatwootClient(p.tenantId, p.instanceId, {
    base: p.base,
    botToken: bot?.accessToken,
  });
  const sw = readServiceWindowConfig(p.settings);
  const mode = proactiveSendMode(sw, sibling.lastInboundAt, p.now, {
    channelType: sibling.channelType,
    provider: sibling.provider,
  });
  if (mode === "template") {
    const payload = buildTemplatePayload(sw, null);
    if (payload) {
      await client.sendTemplate(sibling.chatwootConversationId, payload);
      return "sent";
    }
    // No template configured → fall through to a private note (never a rejected free-form send).
  }
  await client.sendMessage(sibling.chatwootConversationId, text, {
    private: mode === "note",
  });
  return "sent";
}

export async function redirectFollowUpHandler(
  job: ClaimedJob,
  base: PrismaClient,
  deps?: RuntimeDeps,
): Promise<JobResult> {
  const payload = parseRedirectFollowUpPayload(job.payload);
  if (!payload) return { outcome: "done" };
  const parsed = parseThreadId(payload.widgetThreadId);
  if (!parsed || parsed.tenantId !== job.tenantId) return { outcome: "done" };
  const tenantId = job.tenantId;
  let agentId: bigint;
  try {
    agentId = BigInt(payload.agentId);
  } catch {
    return { outcome: "done" };
  }

  // Reload the redirect config FRESH — an operator may have changed or disabled it since this job
  // was armed, and a scheduled delay can span that change. Never trust the arm-time snapshot.
  const agent = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.agent.findUnique({
      where: { id: agentId },
      select: { settings: true },
    }),
  );
  if (!agent) return { outcome: "done" };
  const cfg = readChannelRedirectConfig(agent.settings);
  if (!cfg.enabled) return { outcome: "done" };
  const entryInboxId = cfg.entryInboxId ?? payload.entryInboxId;

  // Reschedule this same job to the next stage after its configured delay. The payload is authoritative
  // on re-enqueue, so this advances the ladder on the SAME row (mirrors the two-stage original).
  const rescheduleTo = (
    stage: RedirectFollowUpStage,
    value: number,
    unit: RedirectDelayUnit,
  ): JobResult => ({
    outcome: "reschedule",
    runAt: minutesFromNow(redirectDelayMinutes(value, unit), new Date()),
    payload: {
      stage,
      widgetThreadId: payload.widgetThreadId,
      agentId: payload.agentId,
      entryInboxId,
    },
  });

  if (payload.stage === "chat") {
    if (cfg.chatFollowupEnabled) {
      await runAgentNudge({
        tenantId,
        threadId: payload.widgetThreadId,
        nudge: chatFollowupNudge(cfg.chatFollowupInstructions),
        base,
        deps,
      });
    }
    if (cfg.waFollowupEnabled) {
      return rescheduleTo(
        "whatsapp",
        cfg.waFollowupDelayValue,
        cfg.waFollowupDelayUnit,
      );
    }
    if (cfg.closingEnabled) {
      return rescheduleTo(
        "closing",
        cfg.closingDelayValue,
        cfg.closingDelayUnit,
      );
    }
    return { outcome: "done" };
  }

  if (payload.stage === "whatsapp") {
    if (cfg.waFollowupEnabled && entryInboxId !== null) {
      const outcome = await sendWhatsAppFollowUp({
        tenantId,
        instanceId: parsed.instanceId,
        agentId,
        widgetConversationId: parsed.conversationId,
        entryInboxId,
        cfg,
        settings: agent.settings,
        base,
        now: new Date(),
      });
      if (outcome !== "sent") {
        logger.info(
          "channel-redirect: WhatsApp follow-up %s (widget thread=%s)",
          outcome,
          payload.widgetThreadId,
        );
      }
    }
    if (cfg.closingEnabled) {
      return rescheduleTo(
        "closing",
        cfg.closingDelayValue,
        cfg.closingDelayUnit,
      );
    }
    return { outcome: "done" };
  }

  // stage === "closing" — the ladder's terminal give-up: post the closing on BOTH channels + resolve, once.
  if (cfg.closingEnabled && entryInboxId !== null) {
    await deliverRedirectClosing({
      tenantId,
      instanceId: parsed.instanceId,
      widgetConversationId: parsed.conversationId,
      entryInboxId,
      closingMessage: cfg.closingMessage,
      closeChat: true,
      base,
      deps,
    });
  }
  return { outcome: "done" };
}

let registered = false;
export function registerRedirectFollowUpHandlers(): void {
  if (registered) return;
  registerJobHandler("REDIRECT_FOLLOWUP", (job, base) =>
    redirectFollowUpHandler(job, base),
  );
  registered = true;
  logger.debug("channel-redirect follow-up handler registered");
}

// Post the fixed closing message on ONE conversation + resolve it. deliverRedirectClosing calls it once
// per channel (chat + WhatsApp) with a single shared bot client. sendMode gates visibility: freeform
// (in-window, or the web widget, which has no window) → a customer-visible goodbye; template/note
// (official WhatsApp outside the 24h window, where free-form is blocked) → a private note (a goodbye is
// best-effort, never worth burning an HSM template on).
async function deliverClosing(
  client: Awaited<ReturnType<typeof loadChatwootClient>>,
  conversationId: number,
  closingMessage: string,
  sendMode: ProactiveSendMode,
  origin: {
    tenantId: bigint;
    instanceId: bigint;
    base: PrismaClient;
    // The conversation as the caller loaded it, before this function's own toggle.
    observed: ObservedConversation;
  },
): Promise<void> {
  await client.sendMessage(conversationId, closingMessage, {
    private: sendMode !== "freeform",
  });
  await client.toggleStatus(conversationId, "resolved");
  // NOTE: Tidying up the channel the episode moved AWAY from. Whatever the outcome was, it was not decided
  // here, so this closing is not a resolution the agent can be credited with.
  await recordResolutionOrigin({
    tenantId: origin.tenantId,
    conversation: {
      chatwootInstanceId: origin.instanceId,
      chatwootConversationId: conversationId,
    },
    origin: "redirect_closing",
    observed: origin.observed,
    base: origin.base,
  });
}

export interface DeliverRedirectClosingParams {
  tenantId: bigint;
  instanceId: bigint;
  // The WIDGET conversation's chatwootConversationId. The closing watermark lives on this row; the agent
  // (bot token), the service-window config + the chat channel are all derived from it.
  widgetConversationId: number;
  // The agent's configured entry (official WhatsApp) inbox — used to find the sibling to close.
  entryInboxId: number;
  // The fixed goodbye, posted verbatim on BOTH channels (not AI: the WhatsApp closing nudge silences).
  closingMessage: string;
  // Post + resolve the CHAT (widget) conversation too. true from the timed ladder's closing stage (the
  // goodbye goes out on both channels). false from the webhook's resolve-transition, where the chat is
  // already being resolved by the trigger — only the WhatsApp sibling still needs the closing.
  closeChat: boolean;
  base?: PrismaClient;
  deps?: RuntimeDeps;
}

export type DeliverRedirectClosingOutcome = "delivered" | "already-closed";

// The single closing entry point, shared by the ladder's terminal "closing" stage and the webhook's
// widget-resolve detection. The closing is a FIXED message posted on BOTH channels — the website chat and
// the WhatsApp sibling — each followed by a resolve, via the agent's persona bot. A CAS on
// Conversation.redirectClosedAt makes it AT MOST ONCE per episode: whichever trigger fires first wins the
// watermark and delivers; a later/concurrent trigger (including the resolve webhook re-entered by our own
// chat resolve) sees it set and no-ops.
export async function deliverRedirectClosing(
  p: DeliverRedirectClosingParams,
): Promise<DeliverRedirectClosingOutcome> {
  const base = p.base ?? basePrisma;
  const now = new Date();
  // Claim the closing: set the watermark only if still unset. rowcount 1 ⇒ we own this delivery.
  const won = await runScopedOn(base, sysCtx(p.tenantId), async (db) => {
    const res = await db.conversation.updateMany({
      where: {
        tenantId: p.tenantId,
        chatwootInstanceId: p.instanceId,
        chatwootConversationId: p.widgetConversationId,
        redirectClosedAt: null,
      },
      data: { redirectClosedAt: now },
    });
    return res.count === 1;
  });
  if (!won) return "already-closed";

  // Everything the sends need — the agent (bot token), the widget conv's channel + lastInboundAt, and the
  // service-window config — derived from the widget conversation. Both channels post via THIS agent's bot.
  const cx = await runScopedOn(base, sysCtx(p.tenantId), async (db) => {
    const widget = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId: p.tenantId,
          chatwootInstanceId: p.instanceId,
          chatwootConversationId: p.widgetConversationId,
        },
      },
      select: {
        status: true,
        chatwootStatusAt: true,
        lastInboundAt: true,
        inbox: { select: { agentId: true, channelType: true, provider: true } },
      },
    });
    if (!widget?.inbox?.agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: widget.inbox.agentId },
      select: { settings: true },
    });
    return { widget, agentId: widget.inbox.agentId, settings: agent?.settings };
  });
  // No agent bound to the widget inbox (shouldn't happen once redirect is live): the watermark is set,
  // nothing to post.
  if (!cx) return "delivered";

  const bot = await loadAgentBot(p.tenantId, p.instanceId, cx.agentId, base);
  const client = await loadChatwootClient(p.tenantId, p.instanceId, {
    base,
    botToken: bot?.accessToken,
    makeClient: p.deps?.makeClient,
  });
  const sw = readServiceWindowConfig(cx.settings);

  // Chat (website widget): post the goodbye + resolve. Skipped on the resolve-path, where the chat is
  // already being resolved by the trigger. A web widget has no 24h window → proactiveSendMode → freeform.
  if (p.closeChat) {
    const chatMode = proactiveSendMode(sw, cx.widget.lastInboundAt, now, {
      channelType: cx.widget.inbox?.channelType ?? null,
      provider: cx.widget.inbox?.provider ?? null,
    });
    await deliverClosing(
      client,
      p.widgetConversationId,
      p.closingMessage,
      chatMode,

      {
        tenantId: p.tenantId,
        instanceId: p.instanceId,
        base,
        observed: {
          status: cx.widget.status,
          statusAt: cx.widget.chatwootStatusAt,
        },
      },
    );
  }

  // WhatsApp channel: the sibling conversation (same contact, the entry inbox). Post the goodbye + resolve.
  const sibling = await resolveWhatsAppSibling(
    p.tenantId,
    p.instanceId,
    p.widgetConversationId,
    p.entryInboxId,
    base,
  );
  if (sibling) {
    const waMode = proactiveSendMode(sw, sibling.lastInboundAt, now, {
      channelType: sibling.channelType,
      provider: sibling.provider,
    });
    await deliverClosing(
      client,
      sibling.chatwootConversationId,
      p.closingMessage,
      waMode,

      {
        tenantId: p.tenantId,
        instanceId: p.instanceId,
        base,
        observed: {
          status: sibling.status,
          statusAt: sibling.chatwootStatusAt,
        },
      },
    );
  }
  return "delivered";
}
