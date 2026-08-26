import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { broadcastConversationEvent } from "@/api/features/realtime/realtime.service";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { modelConfigSchema } from "@/graph/model-config";
import {
  AppError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { loadAppointmentContext } from "@/modules/appointments/context";
import {
  exceptionInForceAt,
  isOutOfHoursNow,
  nextOpenAt,
  parseSchedule,
  type ScheduleException,
} from "@/modules/business-hours/hours";
import { episodeTestActivatedAt } from "@/modules/channel-redirect/episode";
import { readChannelRedirectConfig } from "@/modules/channel-redirect/service";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  type LoadChatwootClientDeps,
  loadAgentBot,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import {
  heldByAnotherParty,
  parseLiveConversation,
} from "@/modules/chatwoot/normalize";
import { reconcileMirrorFromLive } from "@/modules/chatwoot/reconcile";
import { recordResolutionOrigin } from "@/modules/conversations/record-resolution";
import { appointmentPauseApplies } from "@/modules/followups/appointment-pause";
import { isFollowUpLive } from "@/modules/followups/eligibility";
import type { FollowUpDelayUnit } from "@/modules/followups/settings";
import {
  isNewFollowUpEpisode,
  readFollowUpConfig,
  stepDelayMinutes,
} from "@/modules/followups/settings";

// Read projection of the Conversation mirror for the operational UI + (future) fleet. The mirror
// holds METADATA ONLY — no message bodies — so the heavy PII (conversation content) is never even
// stored here. The one PII field is the contact's display name, which a same-tenant operator
// legitimately needs; tenant isolation is enforced by the scoped read (a tenant never sees
// another's rows).
// NOTE: a SUPER_ADMIN cross-tenant projection must strip the contact name; that gate lands with
// the fleet/super-admin views. For now this endpoint serves the operator's OWN tenant.

const CONVERSATION_STATUSES = [
  "open",
  "pending",
  "resolved",
  "snoozed",
] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface ListConversationsFilter {
  status?: string;
  limit?: number;
  // Keyset cursor: the id of the last item from the previous page. The next page continues from just
  // past it in the (lastEventAt desc, id desc) ordering.
  cursor?: string;
  // Free-text search: matches the contact display name or the Chatwoot conversation id (see
  // buildConversationsWhere). No message-body search — the mirror holds metadata only.
  q?: string;
}

export interface ConversationListItem {
  id: string;
  threadId: string;
  chatwootConversationId: number;
  status: string;
  assigneeId: number | null;
  assigneeType: string | null;
  // Human assignee display name (null when AI-handled / unassigned) — shown instead of "Human #id".
  assigneeName: string | null;
  lastEventAt: string | null;
  // Last agent-turn failure (sanitized) + when, for the operator's error badge + re-engage action.
  lastError: string | null;
  lastErrorAt: string | null;
  inbox: { id: string; name: string } | null;
  contact: { name: string | null } | null;
  // The bound persona's name, so the list can show it for AI-handled rows. Null when no agent bound.
  agentName: string | null;
  // True when the bound agent's availability schedule is currently closed (item 23). Computed
  // server-side; false when no agent / no schedule.
  outOfHours: boolean;
}

export interface ConversationsPage {
  items: ConversationListItem[];
  // Pass back as `cursor` to fetch the next (older) page; null when this is the last page.
  nextCursor: string | null;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function normalizeStatus(status: string | undefined): string | undefined {
  return status && (CONVERSATION_STATUSES as readonly string[]).includes(status)
    ? status
    : undefined;
}

function parseCursor(cursor: string | undefined): bigint | null {
  if (!cursor) return null;
  try {
    return BigInt(cursor);
  } catch {
    return null;
  }
}

// Combine the status filter with an optional free-text search. Search matches the contact display
// name (case-insensitive substring) OR, for an all-digit query, the Chatwoot conversation id
// (operators reference conversations by their Chatwoot #id). No message-body search — the mirror
// holds metadata only.
function buildConversationsWhere(
  status: string | undefined,
  q: string | undefined,
): Prisma.ConversationWhereInput {
  const where: Prisma.ConversationWhereInput = {};
  if (status) where.status = status;
  const term = q?.trim();
  if (term) {
    const or: Prisma.ConversationWhereInput[] = [
      { contact: { name: { contains: term, mode: "insensitive" } } },
    ];
    if (/^\d+$/.test(term)) {
      const n = Number(term);
      if (Number.isSafeInteger(n)) or.push({ chatwootConversationId: n });
    }
    where.OR = or;
  }
  return where;
}

export async function listConversations(
  ctx: TenantContext,
  filter: ListConversationsFilter,
  base: PrismaClient = basePrisma,
): Promise<ConversationsPage> {
  const take = clampLimit(filter.limit);
  const status = normalizeStatus(filter.status);
  const cursorId = parseCursor(filter.cursor);
  const where = buildConversationsWhere(status, filter.q);
  const rows = await runScopedOn(base, ctx, (db) =>
    db.conversation.findMany({
      where,
      // lastEventAt is the canonical recency signal (nulls sort last); id breaks ties.
      orderBy: [
        { lastEventAt: { sort: "desc", nulls: "last" } },
        { id: "desc" },
      ],
      take,
      // Keyset: seek past the cursor row in the ordering above (id is unique → a stable anchor).
      ...(cursorId != null ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: {
        id: true,
        threadId: true,
        chatwootConversationId: true,
        status: true,
        assigneeId: true,
        assigneeType: true,
        assigneeName: true,
        lastEventAt: true,
        lastError: true,
        lastErrorAt: true,
        inbox: { select: { id: true, name: true, agentId: true } },
        contact: { select: { name: true } },
      },
    }),
  );
  // Resolve the bound persona names for this page in one batch (Inbox carries agentId, no relation).
  const agentIds = [
    ...new Set(
      rows.map((r) => r.inbox?.agentId).filter((x): x is bigint => x != null),
    ),
  ];
  const agentNameById = new Map<string, string>();
  // Each bound agent's availability schedule id, to compute the out-of-hours badge (item 23) for the
  // page in two batched queries (agents → their distinct schedules), no N+1.
  const agentHoursId = new Map<string, bigint | null>();
  if (agentIds.length > 0) {
    const agents = await runScopedOn(base, ctx, (db) =>
      db.agent.findMany({
        where: { id: { in: agentIds } },
        select: { id: true, name: true, businessHoursId: true },
      }),
    );
    for (const a of agents) {
      agentNameById.set(String(a.id), a.name);
      agentHoursId.set(String(a.id), a.businessHoursId);
    }
  }
  const outOfHoursByHoursId = new Map<string, boolean>();
  const hoursIds = [
    ...new Set(
      [...agentHoursId.values()].filter((h): h is bigint => h != null),
    ),
  ];
  if (hoursIds.length > 0) {
    const hoursRows = await runScopedOn(base, ctx, (db) =>
      db.businessHours.findMany({
        where: { id: { in: hoursIds } },
        select: { id: true, windows: true, exceptions: true, timezone: true },
      }),
    );
    const now = new Date();
    for (const h of hoursRows) {
      outOfHoursByHoursId.set(
        String(h.id),
        isOutOfHoursNow(parseSchedule(h), now),
      );
    }
  }
  const agentOutOfHours = (agentId: bigint | null | undefined): boolean => {
    if (agentId == null) return false;
    const hId = agentHoursId.get(String(agentId));
    return hId != null
      ? (outOfHoursByHoursId.get(String(hId)) ?? false)
      : false;
  };
  const items = rows.map((r) => ({
    id: String(r.id),
    threadId: r.threadId,
    chatwootConversationId: r.chatwootConversationId,
    status: r.status,
    assigneeId: r.assigneeId,
    assigneeType: r.assigneeType,
    assigneeName: r.assigneeName,
    lastEventAt: r.lastEventAt ? r.lastEventAt.toISOString() : null,
    lastError: r.lastError,
    lastErrorAt: r.lastErrorAt ? r.lastErrorAt.toISOString() : null,
    inbox: r.inbox ? { id: String(r.inbox.id), name: r.inbox.name } : null,
    contact: r.contact ? { name: r.contact.name } : null,
    agentName:
      r.inbox?.agentId != null
        ? (agentNameById.get(String(r.inbox.agentId)) ?? null)
        : null,
    outOfHours: agentOutOfHours(r.inbox?.agentId),
  }));
  // A full page may have more behind it; the last row's id is the next cursor.
  const nextCursor =
    rows.length === take && items.length > 0
      ? (items[items.length - 1]?.id ?? null)
      : null;
  return { items, nextCursor };
}

// ── operations (on-demand fetch + actions over the Chatwoot client) ──
//
// The mirror holds METADATA only; the thread is fetched on demand from Chatwoot (admin token).
// Actions (reply/handoff/return/status) go over the client (bot token) — NETWORK happens OUTSIDE
// any tx; we then optimistically update the mirror for immediate UI feedback (the webhook reconciles
// the canonical state, with its lastEventAt monotonic guard).
//
// NOTE: getConversationDetail's message normalization follows the Chatwoot message shape
// (payload[] of { id, content, message_type, private, created_at, sender }), CONFIRMED live against
// a chatwoot-pro instance (message_type is a NUMBER here, unlike the webhook where it is a string).

// A message attachment as the admin messages API serializes it (_message.json.jbuilder maps each
// via Attachment#push_event_data): file_type bucket, the (host-served) data_url, an image thumb_url,
// and, for audio, the transcription our eager STT wrote back. The thread renders audio (player +
// transcription) and images inline; data_url is proxied through our origin (getConversationMedia).
export interface ConversationAttachment {
  id: number | null;
  fileType: string | null;
  dataUrl: string | null;
  thumbUrl: string | null;
  transcribedText: string | null;
}

export interface ConversationMessage {
  id: number | null;
  content: string | null;
  messageType: number | null;
  private: boolean;
  createdAt: number | null;
  senderName: string | null;
  senderType: string | null;
  attachments: ConversationAttachment[];
  // content_attributes.in_reply_to — the quoted/replied-to message id (the console renders a quote
  // preview by resolving it against the loaded thread). null when this message is not a reply.
  inReplyTo: number | null;
  // content_attributes.is_reaction — true when this message is an emoji reaction (content = emoji).
  isReaction: boolean;
}

// Metadata shell of a conversation (a single scoped DB read, NO network) — renders the detail page
// immediately. The message thread is fetched separately (getConversationMessages) so a slow/down
// Chatwoot only affects the messages area, not the whole page.
export interface ConversationDetail {
  id: string;
  threadId: string;
  chatwootConversationId: number;
  status: string;
  assigneeId: number | null;
  assigneeType: string | null;
  // Human assignee display name (null when AI-handled / unassigned) — shown instead of "Human #id".
  assigneeName: string | null;
  // Whether somebody OTHER than this inbox's persona is holding the conversation — a human, or another
  // persona's agent bot. Derived here rather than in the console, because the comparison needs the
  // bound bot's Chatwoot id and because it is the same rule `shouldBotHandle` applies: a browser
  // asking "is the assignee a User?" reads the other-bot case backwards, and that agent cannot answer
  // there either. Status is deliberately NOT part of it — the console asks who HOLDS the conversation,
  // which is a different question from whether the agent may speak right now.
  heldByAnotherParty: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
  inbox: { id: string; name: string } | null;
  // contact.voiceReply: the per-contact audio-reply preference (true=audio, false=text, null=unknown).
  contact: { name: string | null; voiceReply: boolean | null } | null;
  // The bound persona, so the console can show its name and deep-link to its editor.
  agentId: string | null;
  agentName: string | null;
  // The bound persona's operating mode (item 1), so the console can flag a test agent. null = no agent.
  agentMode: "test" | "production" | null;
  // The model the bound persona runs (e.g. "gpt-5.4-mini"), shown in the conversation header. null = no
  // agent or an unparseable model config.
  agentModel: string | null;
  // True when the bound agent's availability schedule (businessHoursId) is currently CLOSED (item 23).
  // Computed server-side ("now" in the schedule's timezone), so it never depends on the browser clock.
  // false when there's no agent or no schedule (always-on).
  outOfHours: boolean;
  // When this conversation was activated for a test agent via /teste (ISO). null = not activated.
  testActivatedAt: string | null;
  // Proactive follow-up journey, for an operator-facing indicator (item 17). null = no agent bound.
  // Times are ESTIMATES — follow-ups fire on background jobs that can be delayed.
  followUp: {
    enabled: boolean;
    totalSteps: number;
    // The next pending follow-up: 1-based step index + estimated run time (ISO). null = none pending.
    nextStep: number | null;
    nextRunAt: string | null;
    // True when nextRunAt was pushed past the configured cadence because it fell outside the send
    // window (item 3) — so the UI can explain why the ETA exceeds the step's delay.
    nextRunAtDeferred: boolean;
    // When the last follow-up fired for this conversation (ISO). null = none has fired yet.
    lastFollowUpAt: string | null;
    // The configured sequence, for the "full sequence" tooltip: per-step delay + optional label + the
    // step that resolves the conversation. Cadence: step 1 = inactivity threshold; later = wait AFTER
    // the previous step. Empty when follow-up is disabled.
    steps: {
      delayValue: number;
      delayUnit: FollowUpDelayUnit;
      assignLabels: string[];
      resolve: boolean;
    }[];
    // The schedule that gates proactive sends (follow-up-specific hours, else the agent's main hours).
    // null = no restriction (the follow-up can fire any time). Surfaced in the sequence tooltip so the
    // operator sees the allowed send window — the same windows the estimate + worker honor.
    hours: {
      timezone: string;
      windows: { day: number; start: string; end: string }[];
      // The date exception in force TODAY, when one is (holiday, shutdown, half-day). Non-null means
      // the weekly grid above is NOT what the agent is keeping right now, so the tooltip has to say
      // so; `ranges: []` is a full closure.
      exceptionToday: ScheduleException | null;
    } | null;
    // WhatsApp→chat redirect (channelRedirect): this conversation's inbox is the redirect's entry or
    // widget inbox, so the generic follow-up above is SUPPRESSED here (the redirect owns re-engagement
    // for those two inboxes — enforced in the followups sweep + handler). The UI shows a redirect
    // indicator instead of the — never-firing — generic estimate. false for every other conversation.
    managedByRedirect: boolean;
    // The pending REDIRECT_FOLLOWUP keyed to this conversation, when managedByRedirect. Only the WIDGET
    // conversation carries one (the entry/WhatsApp side is re-engaged by the gate re-sending the link on
    // the next inbound, not a scheduled job). null = none pending (or not the widget side).
    redirectNext: { stage: "chat" | "whatsapp"; runAt: string } | null;
    // The agent pauses re-engagement while the contact has a live appointment
    // (followUp.pauseWhileAppointment, on by default), so the sweep skips this conversation and the
    // handler reschedules an already-armed job. Surfaced instead of a countdown that never fires:
    // an indicator that promises a follow-up the sweep suppresses is indistinguishable from a broken
    // scheduler, which is the worst failure mode for an indicator whose whole job is to be trusted.
    pausedByAppointment: boolean;
    // A follow-up job IS armed for this conversation and the handler will drop it when it claims it
    // (isFollowUpLive: agent enabled, follow-up on, not redirect-managed, not test-silenced, bot
    // still owns the conversation). Nothing is coming, but nothing completed either — so the console
    // must show neither a countdown nor the "sequence complete" marker.
    //
    // It is keyed on a job EXISTING, not on liveness alone, because the two look identical from the
    // outside and mean opposite things: a sequence whose last step is configured to resolve the
    // conversation ends with the bot no longer owning it, which is a completed sequence, not an
    // abandoned one. What separates them is whether a step is still queued.
    abandoned: boolean;
  } | null;
  // Pending appointment reminders for THIS conversation (deterministic Calendar-booked reminders), for
  // an operator-facing "a reminder is scheduled" indicator. One entry per pending scheduler job, soonest
  // first; empty when none. Unlike the follow-up estimate, these run times are exact (give or take the
  // worker tick).
  appointmentReminders: {
    runAt: string; // when the reminder fires (ISO)
    startISO: string | null; // the appointment start it is for (ISO), when known
    offsetHours: number | null; // how long before the start (hours)
    isLast: boolean; // the closest reminder (the one that may ask for confirmation)
  }[];
  // Origin + account of the conversation's Chatwoot instance, to build an "open in Chatwoot" link
  // (${chatwootBaseUrl}/app/accounts/${accountId}/conversations/${chatwootConversationId}).
  chatwootBaseUrl: string;
  accountId: number;
  // Recent execution-flow markers for THIS conversation (PII-free), interleaved into the timeline:
  // tool calls (name + status + duration) and proactive follow-up sends. Oldest → newest.
  trail: ConversationTrailEntry[];
}

// A compact, PII-free activity marker drawn inline in the conversation timeline. Derived from the
// ExecutionLog: a tool call (kind "tool"), a proactive follow-up send (kind "followup"), or an
// appointment reminder send (kind "reminder").
export interface ConversationTrailEntry {
  id: string;
  kind: "tool" | "followup" | "reminder";
  // tool → the tool's name; followup/reminder → the nudge source (e.g. "followup").
  name: string | null;
  status: string | null;
  durationMs: number | null;
  // followup → the 1-based sequence step that fired ("Follow-up N enviado"). null when not recorded.
  step: number | null;
  // tool → the (already-redacted, truncated) arguments the agent passed and the tool's result, so the
  // operator can expand the marker to inspect what ran (parity with the playground trace). Both null for
  // follow-up rows and for tool rows logged before this field existed. args is a JSON value; output is a
  // string (the result text the model saw).
  args: unknown;
  output: string | null;
  // tool → the sanitized error message when the tool FAILED (status "error"), so the operator sees WHY
  // it failed inline instead of just a ✗. null on success and for follow-up/reminder rows.
  errorMessage: string | null;
  at: string;
}

export interface ConversationThread {
  messages: ConversationMessage[];
  // True when the live thread fetch from Chatwoot failed (timeout/unreachable/error) — the UI shows
  // a retry in the messages area instead of breaking the page.
  messagesUnavailable: boolean;
  // True when the fetched page was FULL (the fork returns ~20 per page), so older messages likely
  // exist before it — the console shows "load older" only then (item 4). A partial page ⇒ start of
  // history ⇒ button hidden. false on a fetch failure.
  hasMoreOlder: boolean;
}

// The fork's MessageFinder page size: a full page is the signal that older history may exist.
const MESSAGES_PAGE_SIZE = 20;

// Count the raw messages in a getMessages response ({ payload: [...] } or a bare array) — the page
// size before normalizeMessages slices/drops, so it reflects whether the fork returned a full page.
function rawMessageCount(raw: unknown): number {
  const payload = (raw as { payload?: unknown } | null)?.payload;
  if (Array.isArray(payload)) return payload.length;
  return Array.isArray(raw) ? (raw as unknown[]).length : 0;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function normalizeMessages(raw: unknown): ConversationMessage[] {
  const payload = (raw as { payload?: unknown } | null)?.payload;
  const arr = Array.isArray(payload)
    ? payload
    : Array.isArray(raw)
      ? (raw as unknown[])
      : [];
  return arr.slice(-100).map((m) => {
    const msg = (m ?? {}) as Record<string, unknown>;
    const sender = (msg.sender ?? {}) as Record<string, unknown>;
    const ca =
      typeof msg.content_attributes === "object" && msg.content_attributes
        ? (msg.content_attributes as Record<string, unknown>)
        : null;
    const inReplyTo =
      ca && typeof ca.in_reply_to === "number" ? ca.in_reply_to : null;
    const attachments: ConversationAttachment[] = Array.isArray(msg.attachments)
      ? (msg.attachments as unknown[])
          .filter(
            (a): a is Record<string, unknown> =>
              typeof a === "object" && a !== null,
          )
          .map((a) => ({
            id: typeof a.id === "number" ? a.id : null,
            fileType: asStr(a.file_type),
            dataUrl: asStr(a.data_url),
            thumbUrl: asStr(a.thumb_url),
            // Empty string (the fork's default when un-transcribed) normalizes to null.
            transcribedText: asStr(a.transcribed_text) || null,
          }))
      : [];
    return {
      id: typeof msg.id === "number" ? msg.id : null,
      content: asStr(msg.content),
      messageType:
        typeof msg.message_type === "number" ? msg.message_type : null,
      private: Boolean(msg.private),
      createdAt: typeof msg.created_at === "number" ? msg.created_at : null,
      senderName: asStr(sender.name),
      senderType: asStr(sender.type),
      attachments,
      inReplyTo,
      isReaction: ca?.is_reaction === true,
    };
  });
}

function requireTenant(ctx: TenantContext): bigint {
  if (ctx.tenantId === null) {
    throw new TenantTargetRequiredError();
  }
  return ctx.tenantId;
}

async function loadConvRef(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient,
): Promise<{
  id: bigint;
  chatwootInstanceId: bigint;
  chatwootConversationId: number;
  status: string;
  chatwootStatusAt: number | null;
  assigneeId: number | null;
  assigneeType: string | null;
  assigneeName: string | null;
  threadId: string;
  lastEventAt: Date | null;
  lastInboundAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  testActivatedAt: Date | null;
  contactId: bigint | null;
  lastFollowUpAt: Date | null;
  inbox: {
    id: bigint;
    name: string;
    agentId: bigint | null;
    chatwootInboxId: number;
  } | null;
  contact: { name: string | null; voiceReply: boolean | null } | null;
  instance: { accountId: number; deployment: { baseUrl: string } };
}> {
  const conv = await runScopedOn(base, ctx, (db) =>
    db.conversation.findUnique({
      where: { id },
      select: {
        id: true,
        chatwootInstanceId: true,
        chatwootConversationId: true,
        status: true,
        chatwootStatusAt: true,
        assigneeId: true,
        assigneeType: true,
        assigneeName: true,
        threadId: true,
        lastEventAt: true,
        lastInboundAt: true,
        lastError: true,
        lastErrorAt: true,
        testActivatedAt: true,
        contactId: true,
        lastFollowUpAt: true,
        inbox: {
          select: {
            id: true,
            name: true,
            agentId: true,
            chatwootInboxId: true,
          },
        },
        contact: { select: { name: true, voiceReply: true } },
        instance: {
          select: {
            accountId: true,
            deployment: { select: { baseUrl: true } },
          },
        },
      },
    }),
  );
  if (!conv) {
    throw new NotFoundError(
      "conversation not found",
      "errors.conversationNotFound",
    );
  }
  return conv;
}

// The persona bot token the console acts AS for a conversation = the bot of the inbox's bound agent.
// undefined when the inbox has no agent bound (the bot-token actions below then have no identity to
// act as — an edge case: console actions normally target bot-handled conversations).
async function convBotToken(
  tenantId: bigint,
  conv: {
    chatwootInstanceId: bigint;
    inbox: { agentId: bigint | null } | null;
  },
  base: PrismaClient,
): Promise<string | undefined> {
  const agentId = conv.inbox?.agentId;
  if (agentId == null) return undefined;
  const bot = await loadAgentBot(
    tenantId,
    conv.chatwootInstanceId,
    agentId,
    base,
  );
  return bot?.accessToken;
}

async function updateMirror(
  ctx: TenantContext,
  base: PrismaClient,
  id: bigint,
  data: {
    status?: string;
    assigneeId?: number | null;
    assigneeType?: string | null;
    assigneeName?: string | null;
  },
): Promise<void> {
  await runScopedOn(base, ctx, (db) =>
    db.conversation.updateMany({
      where: { id },
      data,
    }),
  );
}

// The conversation state as it stands after a console write, when the live read decided it. null =
// the read did not decide (it failed, carried no version, or was rejected by activity alone), so the
// caller's own intent is what was written and what it should announce.
interface ConsoleWriteState {
  status: string;
  assigneeId: number | null;
  assigneeType: string | null;
  assigneeName: string | null;
  lastEventAt: Date | null;
}

// Writes the mirror after a console action, claiming the version Chatwoot produced for it.
//
// The two write endpoints do not serialize the conversation's `updated_at` (assignments renders the
// agent, toggle_status a status blob), so a write applied straight from what we asked for lands with
// no version at all. An event Chatwoot serialized BEFORE the click and is still retrying then arrives
// carrying a higher version and the pre-click truth, and the mirror accepts it — undoing the handoff
// or the resolve until Chatwoot's own event for the action arrives, or permanently if that delivery
// is lost. While the row is wrong the runtime's ownership recheck reads it, so the bot can answer on
// top of the human (issue #77).
//
// Reading the conversation back is what closes it: the REST show DOES render the same
// `updated_at.to_f` the webhook carries, so the local write can be ordered by the same key everything
// else uses, with no clock of ours involved. The cost is one extra GET per console action.
//
// The version is an improvement on the write, not a precondition for it: when the read fails or the
// payload does not parse, fall back to the blind write so the console still reflects what the
// operator just did — exactly the behavior that preceded this.
// What the mirror write knows afterwards, and the two halves answer different questions. `state` is
// what was STORED, and it is null whenever the live read could not be versioned — the unversioned
// fallback writes only the fields the action meant to change, on purpose, so there is no trustworthy
// full row to hand back.
//
// `observed` is what Chatwoot SAID, kept even when it could not be versioned. Discarding it is how a
// caller comes to treat "I could not decide" as "nothing is there": the hand-back's final read is the
// only look anybody takes after the unassign, and on a versionless Chatwoot a human who claimed the
// conversation in that window was seen and then thrown away. Required rather than optional so a new
// caller has to say what it does with an undecided read.
interface ConsoleWriteMirror {
  state: ConsoleWriteState | null;
  observed: {
    assigneeType: string | null;
    assigneeId: number | null;
    assigneeName: string | null;
  } | null;
}

async function mirrorConsoleWrite(
  ctx: TenantContext,
  base: PrismaClient,
  id: bigint,
  conv: {
    chatwootInstanceId: bigint;
    chatwootConversationId: number;
    assigneeType: string | null;
    assigneeId: number | null;
  },
  client: ChatwootClient,
  fallback: {
    status?: string;
    assigneeId?: number | null;
    assigneeType?: string | null;
  },
): Promise<ConsoleWriteMirror> {
  const tenantId = requireTenant(ctx);
  // NOTE: An operator commanding a non-resolved status ends the resolution, and that is decided HERE
  // rather than inside either write below. Deliberately NOT `clearsResolutionOrigin`: that function
  // answers "did the ordering leave this close standing?", and a click has no ordering to consult.
  // It is a command, so it holds whatever the mirror currently reads — including the case the shared
  // rule refuses, where the row still shows the pre-resolve status because our own resolve webhook
  // has not landed, and both the stored and the live status therefore read non-resolved. Living in
  // the unversioned fallback meant exactly that case escaped: a successful versioned reconcile
  // returns before the fallback runs, and the stamp survived the reopen into the next close.
  if (fallback.status != null && fallback.status !== "resolved") {
    await runScopedOn(base, ctx, (db) =>
      db.conversation.updateMany({
        where: { id },
        data: { resolvedBy: null, resolvedByAt: null },
      }),
    );
  }
  // Held outside the try so a throw after the read still hands back what was seen.
  let observed: ConsoleWriteMirror["observed"] = null;
  try {
    const live = parseLiveConversation(
      await client.getConversation(conv.chatwootConversationId),
    );
    if (live) {
      observed = {
        assigneeType: live.assigneeType,
        assigneeId: live.assigneeId,
        assigneeName: live.assigneeName,
      };
    }
    // A snapshot with no version buys nothing here and can cost: without one, the reconcile applies
    // the WHOLE snapshot, so a status click could carry back an assignee that a webhook has since
    // changed. The fallback writes exactly the fields this action meant to change, which is what the
    // console did before any of this.
    if (live && live.updatedAt !== null) {
      const outcome = await reconcileMirrorFromLive({
        tenantId,
        instanceId: conv.chatwootInstanceId,
        conversationId: conv.chatwootConversationId,
        live,
        base,
      });
      // Applied, or beaten by a stored version: either way the row now holds the newest thing known,
      // and the caller must announce THAT rather than what the click asked for.
      if (outcome.applied || outcome.outrankedByVersion)
        return { state: outcome.state, observed };
      // Nothing landed and no version decided it — the coarse activity comparison rejected a
      // conversation this process just wrote to Chatwoot, which is not evidence of anything newer.
      // Falling through leaves the operator's action absent from the mirror, and the runtime's
      // ownership recheck reads this row.
      logger.warn(
        "conversations: live read after a console write was rejected by activity alone (conv=%s) — writing unversioned",
        String(conv.chatwootConversationId),
      );
    } else {
      logger.warn(
        "conversations: live read after a console write carried no usable version (conv=%s) — writing unversioned",
        String(conv.chatwootConversationId),
      );
    }
  } catch (err) {
    logger.warn(
      { err, conversationId: String(conv.chatwootConversationId) },
      "conversations: live read after a console write failed — writing unversioned",
    );
  }
  // THE NAME FOLLOWS THE HOLDER, and that is decided HERE rather than at each call site because
  // every caller that writes an assignee has this problem and none of them holds the answer.
  // `assigneeName` is a column of its own, rendered next to the assignee, so a fallback that moves
  // the id and leaves the name shows the NEW holder's id under the PREVIOUS holder's name until some
  // later webhook happens to repair it. That is worse than showing no name: it names the wrong
  // person, confidently, on the screen an operator uses to decide who is handling a conversation.
  //
  // Three cases, and only the last is a guess:
  //   - the holder is not moving: leave the name alone, the row already has the right one;
  //   - the holder is the one the live read just saw: take that read's name, which is the true one;
  //   - anything else: null. The name is genuinely unknown here, and unknown is written as unknown.
  const nextType =
    fallback.assigneeType === undefined
      ? conv.assigneeType
      : fallback.assigneeType;
  const nextId =
    fallback.assigneeId === undefined ? conv.assigneeId : fallback.assigneeId;
  const named =
    nextType === conv.assigneeType && nextId === conv.assigneeId
      ? {}
      : {
          assigneeName:
            observed !== null &&
            observed.assigneeType === nextType &&
            observed.assigneeId === nextId
              ? observed.assigneeName
              : null,
        };
  await updateMirror(ctx, base, id, { ...fallback, ...named });
  return { state: null, observed };
}

// Metadata only — fast scoped DB read, NO network. The UI renders the shell from this immediately.
export async function getConversationDetail(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ConversationDetail> {
  const tenantId = requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  // Resolve the bound persona's name (separate read — Inbox carries only agentId, no relation).
  const agentId = conv.inbox?.agentId ?? null;
  const agent =
    agentId != null
      ? await runScopedOn(base, ctx, (db) =>
          db.agent.findUnique({
            where: { id: agentId },
            select: {
              name: true,
              enabled: true,
              mode: true,
              settings: true,
              modelConfig: true,
              businessHoursId: true,
              followUpHoursId: true,
              followUpArmedAt: true,
            },
          }),
        )
      : null;

  // The bound persona's Chatwoot agent-bot id, which is what makes "another bot is holding this"
  // answerable at all: without it every AgentBot assignee looks like ours. Same resolution the webhook
  // gate does (Inbox.agentId -> ChatwootAgentBot).
  const ourAgentBotId =
    agentId != null
      ? ((
          await runScopedOn(base, ctx, (db) =>
            db.chatwootAgentBot.findFirst({
              where: {
                tenantId,
                chatwootInstanceId: conv.chatwootInstanceId,
                agentId,
              },
              select: { chatwootAgentBotId: true },
            }),
          )
        )?.chatwootAgentBotId ?? null)
      : null;

  // The EPISODE's activation, not this row's (issue #261). A channel-redirect episode is two
  // conversations of one contact and `/teste` stamps only the one it was typed in, so the row alone
  // answers for half of it. Both readers below take this: the badge the console renders, and the
  // follow-up estimate — and they have to agree with the gates in `webhook.ts`, which now answer the
  // episode's question. A badge reading "awaiting /teste" over an agent that is answering is the
  // console contradicting what the operator can see in the conversation.
  const episodeActivatedAt = await episodeTestActivatedAt({
    tenantId,
    instanceId: conv.chatwootInstanceId,
    cfg: readChannelRedirectConfig(agent?.settings),
    agentMode: agent?.mode ?? "production",
    conv: {
      testActivatedAt: conv.testActivatedAt,
      contactId: conv.contactId,
      chatwootInboxId: conv.inbox?.chatwootInboxId ?? null,
    },
    base,
  });

  // Follow-up journey (item 17): the agent's configured step count + the next PENDING follow-up job
  // for this conversation's thread. The job's runAt is an ESTIMATE — it fires on a background worker.
  let followUp: ConversationDetail["followUp"] = null;
  if (agentId != null) {
    const cfg = readFollowUpConfig(agent?.settings);
    // WhatsApp→chat redirect: when this conversation's inbox is the redirect's entry or widget inbox,
    // the generic follow-up is suppressed for it (the redirect owns re-engagement — see the followups
    // sweep + handler). Detect it so the estimate below is skipped and the UI shows the redirect
    // indicator instead of an estimate that can never fire.
    const redirectCfg = readChannelRedirectConfig(agent?.settings);
    const inboxCwId = conv.inbox?.chatwootInboxId ?? null;
    const managedByRedirect =
      redirectCfg.enabled &&
      inboxCwId != null &&
      (redirectCfg.widgetInboxId === inboxCwId ||
        redirectCfg.entryInboxId === inboxCwId);
    // Whether a follow-up for this conversation is alive AT ALL, by the same predicate the handler
    // re-checks when it claims the job. Both branches below are gated on it: the estimate because the
    // sweep would never enqueue it, and the armed job because the handler would drop it (issue #72).
    const followUpLive = isFollowUpLive({
      agentEnabled: agent?.enabled ?? false,
      followUpEnabled: cfg.enabled,
      managedByRedirect,
      agentMode: agent?.mode ?? "production",
      testActivatedAt: episodeActivatedAt,
      status: conv.status,
      assigneeType: conv.assigneeType,
      // The strict ownership answer, which this reader is the one that needs: nothing runs after the
      // indicator to correct it, so a conversation another persona's bot is holding must not be
      // counted down (issue #214). The bot id is already in hand — the same one the header's
      // "held by another party" line is drawn from.
      //
      // `heldByAnotherParty` alone is not the whole answer here: it leaves an AgentBot it cannot
      // identify UNCOUNTED, which is right for the hand-back offer it was written for (there is
      // nobody named to hand back to) and wrong for a promise, because the unidentified bot may be
      // the foreign one. Unverifiable is therefore not ours — the same call the live payload's own
      // parser makes when it refuses an "AgentBot" with no numeric id.
      mirrorHolder: (() => {
        const holder = {
          assigneeType: conv.assigneeType,
          assigneeId: conv.assigneeId,
        };
        if (heldByAnotherParty(holder, { ourAgentBotId })) return "not-ours";
        const unverifiableBot =
          conv.assigneeType === "AgentBot" &&
          (conv.assigneeId == null || ourAgentBotId == null);
        return unverifiableBot ? "not-ours" : "ours";
      })(),
    });
    const isRedirectWidgetConv =
      redirectCfg.enabled &&
      inboxCwId != null &&
      redirectCfg.widgetInboxId === inboxCwId;
    // The schedule gating proactive sends (follow-up-specific hours, else the agent's main hours).
    // Fetched once: used to adjust the estimate AND surfaced in the UI tooltip — both must match what
    // the worker honors. null/empty → no restriction (the follow-up can fire any time).
    const hoursId = agent?.followUpHoursId ?? agent?.businessHoursId ?? null;
    const hoursRow =
      cfg.enabled && !managedByRedirect && hoursId != null
        ? await runScopedOn(base, ctx, (db) =>
            db.businessHours.findUnique({
              where: { id: hoursId },
              select: { windows: true, exceptions: true, timezone: true },
            }),
          )
        : null;
    const hours = hoursRow ? parseSchedule(hoursRow) : null;
    const job = managedByRedirect
      ? null
      : await runScopedOn(base, ctx, (db) =>
          db.schedulerJob.findFirst({
            where: {
              kind: "FOLLOWUP",
              dedupeKey: `followup:${conv.threadId}`,
              status: "PENDING",
            },
            select: { runAt: true, payload: true },
          }),
        );
    let nextStep: number | null = null;
    let nextRunAt: string | null = null;
    // True when the configured cadence landed outside the send window, so the estimate was pushed to
    // the next open slot (item 3): the conversation line then reads e.g. "in 3 days" even though the
    // step is "2d". The tooltip uses this to explain the deferral.
    let nextRunAtDeferred = false;
    const firstStep = cfg.steps[0];
    // The estimate exists to show what the handler will ACTUALLY do, including its terminal case: a
    // schedule that never reopens (a closure outliving the scan horizon, or a recurring one covering
    // every date) makes the handler END the sequence, so the console must show no next step rather
    // than a time inside the closure. Null here means exactly that. Before date exceptions this
    // branch was unreachable — a weekly grid always reopens within the scan — so the estimate could
    // fall back to the ungated time without ever being wrong.
    const openWindowFor = (dueAt: Date): Date | null =>
      hours && hours.windows.length > 0 ? nextOpenAt(hours, dueAt) : dueAt;
    // NOTE: A PENDING step-0 job enqueued before a re-arm will be DROPPED by the handler's
    // activation fence — the estimate must not promise it. Later steps stay exempt (an in-flight
    // sequence legitimately outlives a re-arm), mirroring followUpHandler.
    const rawStep = (job?.payload as { stepIndex?: unknown } | null)?.stepIndex;
    const jobStepIndex =
      typeof rawStep === "number" && Number.isInteger(rawStep) ? rawStep : 0;
    const fencedStep0Job =
      job != null &&
      jobStepIndex === 0 &&
      (agent?.followUpArmedAt == null ||
        conv.lastInboundAt == null ||
        conv.lastInboundAt < agent.followUpArmedAt);
    // NOTE: a job whose step no longer exists is a sequence that is OVER, and the handler says so
    // by returning `done` on its very first look (issue #103 moved that check to the top). An
    // operator who shortens a sequence with a later-step job still pending leaves exactly that
    // state, so the console has to reach the same terminal answer — otherwise it counts down to a
    // step that will never fire, prints "step 5 of 1", and (once the step decides the pause)
    // reports the conversation as appointment-paused over a job that is about to end instead.
    //
    // Its own arm, ahead of both others, because falling through is not the same answer: the
    // estimate arm below would offer step 1, which is a countdown for a sequence about to end.
    const jobStepGone = job != null && cfg.steps[jobStepIndex] === undefined;
    if (jobStepGone) {
      nextStep = null;
    } else if (job && !fencedStep0Job && followUpLive) {
      const stepIndex = jobStepIndex;
      nextStep = stepIndex + 1;
      // job.runAt is NOT the firing time yet — the sweep enqueues step 0 with runAt=now (and re-arms
      // it on EVERY pass), so a freshly-swept job's runAt sits before the real cadence AND outside the
      // business-hours window until the worker claims it and reschedules. Reconstruct what will actually
      // fire, exactly like the handler: floor step 0 at lastEventAt + first-step delay, then push an
      // out-of-window time to the next open window. Without this the indicator flickers to "imminent /
      // out-of-hours" right after each sweep and only resyncs once the worker rewrites run_at.
      let dueAt = job.runAt;
      if (stepIndex === 0 && firstStep && conv.lastEventAt) {
        const floor = new Date(
          conv.lastEventAt.getTime() + stepDelayMinutes(firstStep) * 60_000,
        );
        if (floor.getTime() > dueAt.getTime()) dueAt = floor;
      }
      const ungated = dueAt.getTime();
      const gated = openWindowFor(dueAt);
      if (gated === null) {
        nextStep = null;
      } else {
        if (gated.getTime() > ungated) nextRunAtDeferred = true;
        nextRunAt = gated.toISOString();
      }
    } else if (
      // No job armed yet: estimate the FIRST step so the operator sees a live countdown during the
      // idle window. The sweep only enqueues the job ~at fire time, so for short delays (e.g. 1 min)
      // the pending-job window is seconds — without this estimate the indicator would sit at "none
      // scheduled" the whole time, then jump straight to "complete". Same eligibility as the sweep:
      // follow-up on, a fresh episode (none fired yet, OR the customer replied since the last one — a
      // reply restarts the sequence at step 0), the bot still owns the conversation, the agent isn't
      // test-silenced, and we know when the conversation last moved. The episode predicate MUST match
      // the sweep/handler (isNewFollowUpEpisode) or the indicator disagrees with what actually fires.
      // (managedByRedirect already forces job=null; guard the estimate too so it stays suppressed.)
      followUpLive &&
      firstStep &&
      isNewFollowUpEpisode(conv.lastFollowUpAt, conv.lastInboundAt) &&
      // NOTE: Activation fence (mirrors the sweep SQL): no estimate for an episode that began before
      // follow-up was armed — the sweep will never enqueue it, so the indicator must not promise it.
      agent?.followUpArmedAt != null &&
      conv.lastInboundAt != null &&
      conv.lastInboundAt >= agent.followUpArmedAt &&
      conv.lastEventAt
    ) {
      nextStep = 1;
      const dueAt = new Date(
        conv.lastEventAt.getTime() + stepDelayMinutes(firstStep) * 60_000,
      );
      const ungated = dueAt.getTime();
      // Mirror the handler's business-hours gate: a follow-up coming due outside the configured window
      // does NOT fire then — the worker reschedules it into the next open window. Reflect that here so
      // the estimate never shows a time the follow-up can't actually fire.
      const gated = openWindowFor(dueAt);
      if (gated === null) {
        nextStep = null;
      } else {
        if (gated.getTime() > ungated) nextRunAtDeferred = true;
        nextRunAt = gated.toISOString();
      }
    }
    // A live appointment suppresses BOTH shapes: the sweep never enqueues the estimated step, and an
    // already-armed job is rescheduled by the handler for as long as the appointment stands, so its
    // countdown would just slip an hour at a time. Show the reason instead of a time that never comes.
    //
    // NOTE: read from the SAME source the handler uses (loadAppointmentContext via
    // hasLiveAppointment), instead of a third hand-kept copy of the predicate. The estimate and the
    // sweep have now drifted twice — the suppression itself in #39, and this indicator in #60 — so
    // anything else here would be the third.
    //
    // The `nextStep` guard is what makes the flag mean "the appointment is hiding something": every
    // OTHER reason the follow-up will not run (conversation resolved or taken by a human, episode
    // older than the arming, agent test-silenced, sequence already finished) leaves nextStep null on
    // its own, and announcing "paused by appointment" there would state a reason that is not the
    // reason — and, because the completion marker yields to this flag, would hide a finished sequence
    // behind it. It also skips the query on every conversation with nothing to suppress.
    //
    // NOTE: which step is about to fire decides it, not the agent (issue #103). `nextStep` is
    // 1-based for display, so the step the worker will actually run is `steps[nextStep - 1]` — the
    // same index the handler resolves from the job's payload. The three sites agreeing is not the
    // same condition written out three times: it is one function, asked here about this step.
    const upcomingStep =
      nextStep === null ? undefined : cfg.steps[nextStep - 1];
    const pausedByAppointment =
      nextStep !== null &&
      cfg.enabled &&
      appointmentPauseApplies(cfg, upcomingStep) &&
      !managedByRedirect &&
      (await runScopedOn(
        base,
        ctx,
        async (db) =>
          (await loadAppointmentContext(db, tenantId, conv.threadId)).length >
          0,
      ));
    if (pausedByAppointment) {
      nextStep = null;
      nextRunAt = null;
      nextRunAtDeferred = false;
    }

    // The pending redirect follow-up, keyed to the WIDGET conversation's thread (the entry/WhatsApp
    // side has no job of its own). Surfaced in place of the — suppressed — generic estimate.
    let redirectNext: { stage: "chat" | "whatsapp"; runAt: string } | null =
      null;
    if (isRedirectWidgetConv) {
      const rj = await runScopedOn(base, ctx, (db) =>
        db.schedulerJob.findFirst({
          where: {
            kind: "REDIRECT_FOLLOWUP",
            dedupeKey: `redirect-followup:${conv.threadId}`,
            status: "PENDING",
          },
          select: { runAt: true, payload: true },
        }),
      );
      if (rj) {
        const stage =
          (rj.payload as { stage?: unknown } | null)?.stage === "whatsapp"
            ? "whatsapp"
            : "chat";
        redirectNext = { stage, runAt: rj.runAt.toISOString() };
      }
    }
    followUp = {
      enabled: cfg.enabled,
      totalSteps: cfg.steps.length,
      nextStep,
      nextRunAt,
      nextRunAtDeferred,
      lastFollowUpAt: conv.lastFollowUpAt
        ? conv.lastFollowUpAt.toISOString()
        : null,
      steps: cfg.enabled
        ? cfg.steps.map((s) => ({
            delayValue: s.delayValue,
            delayUnit: s.delayUnit,
            assignLabels: s.assignLabels ?? [],
            resolve: s.resolve === true,
          }))
        : [],
      hours:
        hours && hours.windows.length > 0
          ? {
              timezone: hours.timezone,
              windows: hours.windows,
              // The weekly grid alone reads as authoritative, so on a date an exception governs the
              // panel would state hours the agent is not keeping — the same silent disagreement this
              // whole schedule dimension exists to end. Resolved here because the local date depends
              // on the schedule's timezone, which the browser does not share.
              exceptionToday: exceptionInForceAt(hours, new Date()),
            }
          : null,
      managedByRedirect,
      redirectNext,
      pausedByAppointment,
      abandoned: job !== null && !followUpLive,
    };
  }

  // Out-of-hours status (item 23): the AGENT's availability schedule (businessHoursId, NOT the
  // follow-up schedule), evaluated at "now" in its own timezone. Surfaced as a header badge.
  let outOfHours = false;
  if (agent?.businessHoursId != null) {
    const availId = agent.businessHoursId;
    const bh = await runScopedOn(base, ctx, (db) =>
      db.businessHours.findUnique({
        where: { id: availId },
        select: { windows: true, exceptions: true, timezone: true },
      }),
    );
    if (bh) {
      outOfHours = isOutOfHoursNow(parseSchedule(bh), new Date());
    }
  }

  // Activity trail (item 8 + 12): recent tool calls + proactive follow-up sends for this conversation,
  // from the execution-flow log (real traffic only, PII-free). One indexed read; the UI interleaves
  // these markers into the message timeline by timestamp. A generate row counts as a follow-up marker
  // only when it carries detail.trigger (the nudge source) — ordinary turns are excluded.
  const trailRows = await runScopedOn(base, ctx, (db) =>
    db.executionLog.findMany({
      where: {
        conversationId: id,
        source: "inbox",
        stage: { in: ["tool", "generate"] },
      },
      orderBy: { id: "desc" },
      take: 60,
      select: {
        id: true,
        stage: true,
        status: true,
        durationMs: true,
        detail: true,
        errorMessage: true,
        createdAt: true,
      },
    }),
  );
  const trail: ConversationTrailEntry[] = [];
  for (const r of trailRows) {
    const detail = (r.detail ?? null) as Record<string, unknown> | null;
    if (r.stage === "tool") {
      const rawOutput = detail?.output;
      trail.push({
        id: String(r.id),
        kind: "tool",
        name: typeof detail?.tool === "string" ? detail.tool : null,
        status: r.status,
        durationMs: r.durationMs,
        step: null,
        args: detail?.args ?? null,
        output:
          typeof rawOutput === "string"
            ? rawOutput
            : rawOutput != null
              ? JSON.stringify(rawOutput)
              : null,
        errorMessage: r.status === "error" ? r.errorMessage : null,
        at: r.createdAt.toISOString(),
      });
    } else if (
      r.stage === "generate" &&
      detail &&
      typeof detail.trigger === "string"
    ) {
      trail.push({
        id: String(r.id),
        kind:
          detail.trigger === "appointment_reminder" ? "reminder" : "followup",
        name: detail.trigger,
        status: r.status,
        durationMs: r.durationMs,
        step: typeof detail.step === "number" ? detail.step : null,
        args: null,
        output: null,
        errorMessage: null,
        at: r.createdAt.toISOString(),
      });
    }
  }
  // Rows came newest-first (id desc); the timeline wants oldest → newest.
  trail.reverse();

  // Pending appointment reminders for this conversation's thread (soonest first). Exact times — these
  // are armed scheduler jobs, not estimates. Read under the same tenant scope as the trail.
  const reminderRows = await runScopedOn(base, ctx, (db) =>
    db.schedulerJob.findMany({
      where: {
        kind: "APPOINTMENT_REMINDER",
        status: "PENDING",
        payload: { path: ["threadId"], equals: conv.threadId },
      },
      orderBy: { runAt: "asc" },
      take: 20,
      select: { runAt: true, payload: true },
    }),
  );
  const appointmentReminders = reminderRows.map((r) => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    return {
      runAt: r.runAt.toISOString(),
      startISO: typeof p.startISO === "string" ? p.startISO : null,
      offsetHours: typeof p.offsetHours === "number" ? p.offsetHours : null,
      isLast: p.isLast === true,
    };
  });

  return {
    id: String(conv.id),
    threadId: conv.threadId,
    chatwootConversationId: conv.chatwootConversationId,
    status: conv.status,
    assigneeId: conv.assigneeId,
    assigneeType: conv.assigneeType,
    assigneeName: conv.assigneeName,
    heldByAnotherParty: heldByAnotherParty(
      { assigneeType: conv.assigneeType, assigneeId: conv.assigneeId },
      { ourAgentBotId },
    ),
    lastError: conv.lastError,
    lastErrorAt: conv.lastErrorAt ? conv.lastErrorAt.toISOString() : null,
    inbox: conv.inbox
      ? { id: String(conv.inbox.id), name: conv.inbox.name }
      : null,
    contact: conv.contact
      ? { name: conv.contact.name, voiceReply: conv.contact.voiceReply }
      : null,
    agentId: agentId != null ? String(agentId) : null,
    agentName: agent?.name ?? null,
    agentMode: agent ? (agent.mode === "test" ? "test" : "production") : null,
    agentModel: (() => {
      const parsed = modelConfigSchema.safeParse(agent?.modelConfig);
      return parsed.success ? parsed.data.model : null;
    })(),
    outOfHours,
    testActivatedAt: episodeActivatedAt
      ? episodeActivatedAt.toISOString()
      : null,
    followUp,
    appointmentReminders,
    chatwootBaseUrl: conv.instance.deployment.baseUrl,
    accountId: conv.instance.accountId,
    trail,
  };
}

// The live message thread (network: Chatwoot admin token), fetched on its own so a slow/unreachable
// instance only spins the messages area, not the whole page. Degrades gracefully: on failure returns
// an empty thread with messagesUnavailable=true (the UI shows a retry) instead of throwing a 500.
export async function getConversationMessages(
  ctx: TenantContext,
  id: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
  // When set, page backwards: return the messages OLDER than this Chatwoot message id (the console's
  // "load older" on scroll-up). Omitted → the most recent page.
  before?: number,
): Promise<ConversationThread> {
  const tenantId = requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  const client = await loadChatwootClient(tenantId, conv.chatwootInstanceId, {
    ...deps,
    base,
  });
  try {
    const raw = await client.getMessages(
      conv.chatwootConversationId,
      before != null ? { before } : undefined,
    );
    return {
      messages: normalizeMessages(raw),
      messagesUnavailable: false,
      hasMoreOlder: rawMessageCount(raw) >= MESSAGES_PAGE_SIZE,
    };
  } catch (err) {
    logger.warn(
      { err, conversationId: String(conv.id) },
      "chatwoot getMessages failed; serving conversation without the thread",
    );
    return { messages: [], messagesUnavailable: true, hasMoreOlder: false };
  }
}

export interface ConversationMediaBlob {
  bytes: ArrayBuffer;
  contentType: string;
}

// Proxies a conversation attachment (voice note / image / file) from the tenant's Chatwoot through
// OUR origin. Same-origin delivery is required: CSP pins media-src/img-src to 'self'/blob:, and the
// SUPER_ADMIN tenant selector rides only on our API calls (a raw cross-origin Chatwoot URL would trip
// CSP). Security: the url MUST be on the conversation's own instance origin (so we are never an open
// proxy to arbitrary hosts), and downloadAttachment re-applies anti-SSRF + sends the admin token only
// when the host matches. Returns null when the instance row is gone.
export async function getConversationMedia(
  ctx: TenantContext,
  id: bigint,
  url: string,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<ConversationMediaBlob | null> {
  const tenantId = requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  const instance = await runScopedOn(base, ctx, (db) =>
    db.chatwootInstance.findUnique({
      where: { id: conv.chatwootInstanceId },
      select: { deployment: { select: { baseUrl: true } } },
    }),
  );
  if (!instance) return null;
  let sameOrigin = false;
  try {
    sameOrigin =
      new URL(url).origin === new URL(instance.deployment.baseUrl).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) {
    throw new AppError("media url is not on the conversation's instance", 400);
  }
  const client = await loadChatwootClient(tenantId, conv.chatwootInstanceId, {
    ...deps,
    base,
  });
  const { bytes, contentType } = await client.downloadAttachment(url);
  return {
    bytes,
    contentType: contentType ?? "application/octet-stream",
  };
}

export async function replyToConversation(
  ctx: TenantContext,
  id: bigint,
  content: string,
  isPrivate: boolean,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenantId = requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  const client = await loadChatwootClient(tenantId, conv.chatwootInstanceId, {
    ...deps,
    base,
    botToken: await convBotToken(tenantId, conv, base),
  });
  await client.sendMessage(conv.chatwootConversationId, content, {
    private: isPrivate,
  });
}

// Handoff: optionally assign a specific human, then set status open so the attribution gate stops
// the bot. assigneeId is the Chatwoot agent id.
export async function handoffConversation(
  ctx: TenantContext,
  id: bigint,
  assigneeId: number | null,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenantId = requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  // Operator-initiated → use the instance admin token (audit shows the operator, not the persona).
  const client = await loadChatwootClient(tenantId, conv.chatwootInstanceId, {
    ...deps,
    base,
  });
  if (assigneeId !== null) {
    await client.assignToAgent(conv.chatwootConversationId, assigneeId, {
      asAdmin: true,
    });
  }
  await client.toggleStatus(conv.chatwootConversationId, "open", {
    asAdmin: true,
  });
  const { state } = await mirrorConsoleWrite(ctx, base, id, conv, client, {
    status: "open",
    assigneeType: "User",
    ...(assigneeId !== null ? { assigneeId } : {}),
  });
  // Optimistic realtime feedback (the inbound webhook reconciles canonically). It announces the row
  // as STORED, not as asked for: the two differ when the live read came back with something else
  // (an assignment Chatwoot resolved differently, or a webhook that outranked this write), and a
  // publication of the intent would arrive last and leave the console showing a state nobody holds.
  broadcastConversationEvent(tenantId, {
    conversationId: String(id),
    status: state?.status ?? "open",
    assigneeId: state ? state.assigneeId : (assigneeId ?? conv.assigneeId),
    assigneeType: state ? state.assigneeType : "User",
    lastEventAt:
      (state ? state.lastEventAt : conv.lastEventAt)?.toISOString() ?? null,
  });
}

// Return to the bot: set status pending AND unassign the human (the gate requires BOTH
// status === "pending" and assignee_type !== "User"). A live probe against the chatwoot-pro fork
// confirmed that toggle_status → pending does NOT clear the assignee, so unassigning is mandatory —
// otherwise the next inbound message still carries assignee_type "User" and the bot stays silent.
// The optional reengage prompt is a separate proactive message the caller sends via replyToConversation.
//
// STATUS FIRST, and that ordering is chosen for the failure, not for the success: the two calls are
// separate requests and either can fail. Unassigning first and then failing leaves a conversation
// with no assignee and a status the gate refuses — the human is gone and the bot still will not
// speak, which is nobody's conversation. Failing the other way leaves the human holding it exactly
// as before, one status apart. The caller reports the partial either way; only one of the two
// partials is recoverable by doing nothing.
//
// What the ordering costs is paid back by the read between them. Whoever is holding the conversation
// is read LIVE and the unassign only fires for that same holder, because putting the status call
// first opens a window the other order did not have: a human claiming the conversation while it runs
// would be removed by an unconditional unassign that was aimed at somebody else. Chatwoot has no
// conditional unassign, so this is the compare done here — it narrows the window to one request
// instead of two, and the direction it fails in is leaving a human in place, which is the direction
// a takeover should always win.
export type ReturnToAgentOutcome = "returned" | "taken-over";

export interface ReturnToAgentHolder {
  assigneeType: string | null;
  assigneeId: number | null;
}

export async function returnConversationToAgent(
  ctx: TenantContext,
  id: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
  // The holder this hand-back is FOR, when the caller already established one. /reset does: it reads
  // the holder, decides the conversation is worth taking back from THAT person, and only then calls
  // here — and between those two moments somebody else can arrive. Reading the baseline here would
  // adopt the newcomer and hand the conversation away from them, which is the guard inverted.
  //
  // Optional because the other two callers have no such expectation: the console button and the MCP
  // tool say "return this conversation", with no claim about who is holding it, and for them the
  // only honest baseline is the live one read below. A caller that omits it can only ever refuse to
  // unassign somebody, which is the safe direction for one that forgets.
  expectedHolder?: ReturnToAgentHolder,
): Promise<ReturnToAgentOutcome> {
  const tenantId = requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  // Operator-initiated → instance admin token (audit shows the operator, not the persona).
  const client = await loadChatwootClient(tenantId, conv.chatwootInstanceId, {
    ...deps,
    base,
  });
  // The BASELINE, read live and BEFORE the status call, because "who held it when this request
  // started" is the only thing a takeover can be measured against. The mirrored row is not that: an
  // assignment webhook can be late or lost, and then a human who was already there reads as somebody
  // who arrived mid-request — the hand-back refuses, the caller is told "taken-over", and the
  // conversation is not returned. /reset never saw it because it reconciles from live first; the
  // console and MCP callers do not.
  //
  // Falls back to the mirror when the read fails, which is where this stood before: an unreadable
  // baseline is not evidence that nobody was there.
  const readHolder = async (): Promise<{
    assigneeType: string | null;
    assigneeId: number | null;
  } | null> => {
    const live = parseLiveConversation(
      await client
        .getConversation(conv.chatwootConversationId)
        .catch(() => null),
    );
    return live === null
      ? null
      : { assigneeType: live.assigneeType, assigneeId: live.assigneeId };
  };
  const baseline = expectedHolder ??
    (await readHolder()) ?? {
      assigneeType: conv.assigneeType,
      assigneeId: conv.assigneeId,
    };
  await client.toggleStatus(conv.chatwootConversationId, "pending", {
    asAdmin: true,
  });
  // Unreadable is NOT "nobody took it": a degraded payload with the holder unchanged is the common
  // case, and refusing to hand back on it would leave the conversation with a human who has already
  // walked away. The live read is the improvement over an unconditional unassign, not a new gate.
  const live = await readHolder();
  // The whole identity, not the id: "User" and "AgentBot" are separate id namespaces in Chatwoot, so
  // comparing numbers alone reads User 7 claiming a conversation held by AgentBot 7 as nobody having
  // moved — and unassigns the human. Any change of holder counts, in either field.
  //
  // An EMPTY live assignee is not a competing holder: it means whoever was there has already gone,
  // and unassigning is then the no-op that also corrects the mirror. Only somebody actually holding
  // the conversation stops the hand-back.
  //
  // "Occupied" is read off the TYPE, not off the id. `parseLiveConversation` accepts a payload that
  // names a "User" and carries no assignee object — it only rejects that shape for "AgentBot", where
  // an unverifiable id would let another bot's conversation read as ours. Here the same shape says a
  // person is holding it and we cannot tell WHICH, and comparing a null id against the baseline
  // answered "nobody moved" and unassigned them. Unknown is not absent; it fails closed.
  //
  // Asked of two different reads below, so it is written once. Copying it was how the second reader
  // came to answer "somebody is there" about the very party this call had just unassigned: a live
  // read taken after the unassign can still name them, and only the comparison against the baseline
  // tells that apart from a person who actually arrived.
  const holderOtherThan = (
    seen: { assigneeType: string | null; assigneeId: number | null } | null,
  ): { assigneeType: string | null; assigneeId: number | null } | null =>
    seen !== null &&
    seen.assigneeType !== null &&
    (seen.assigneeId === null ||
      seen.assigneeType !== baseline.assigneeType ||
      seen.assigneeId !== baseline.assigneeId)
      ? { assigneeType: seen.assigneeType, assigneeId: seen.assigneeId }
      : null;
  const newHolder = holderOtherThan(live);
  // NOBODY TO REMOVE MEANS NO REQUEST. `assignee_id: 0` on a conversation that already has no
  // assignee changes nothing at Chatwoot, so the only thing this write can still accomplish is to
  // arrive AFTER somebody claimed the conversation in the round trip and take it away from them.
  // There is no conditional assignment to lean on — Chatwoot's assignments#create writes whatever it
  // is handed, with no holder or version to compare against — so the window is closed by not
  // spending a write on work that does not exist, rather than by guarding one that does.
  //
  // Only for a read that came back EMPTY. An unreadable read stays on the write, for the reason the
  // baseline gives above: silence is not evidence that the conversation is free, and the caller
  // asked for it back.
  const nobodyToRemove = live !== null && live.assigneeType === null;
  if (newHolder === null && !nobodyToRemove) {
    await client.unassignConversation(conv.chatwootConversationId, {
      asAdmin: true,
    });
  } else if (newHolder !== null) {
    logger.info(
      "conversations: hand-back left the conversation with its new holder (conv=%d, %s=%s)",
      conv.chatwootConversationId,
      newHolder.assigneeType ?? "none",
      String(newHolder.assigneeId ?? "none"),
    );
  }
  const { state, observed } = await mirrorConsoleWrite(
    ctx,
    base,
    id,
    conv,
    client,
    {
      status: "pending",
      ...(newHolder ?? { assigneeId: null, assigneeType: null }),
    },
  );
  // Who the mirror ends up naming, resolved ONCE and read by both the event and the return below.
  // It is the LAST thing that looked at the conversation, not the first: `mirrorConsoleWrite` does
  // its own live read AFTER the unassign, so a human who claimed it in that window is here and
  // nowhere in `newHolder` — and the row and the broadcast already say so.
  //
  // Three sources, most-decided first, and the middle one is the whole point of `observed`.
  //
  // `state` is the stored row after a versioned reconcile: decided, so it wins.
  //
  // `observed` is what Chatwoot said on that same read when it could not be versioned (a deployment
  // older than 4.0.2 sends no `updated_at`). Falling straight past it to `newHolder` treats "I could
  // not decide" as "nobody is there", and the window it hides is precisely the one this function
  // cannot see any other way: a human who claimed the conversation AFTER the unassign went out.
  // `newHolder` is null there by construction — it was read before the unassign — so the answer
  // would be "returned" while a person holds it, which is the one answer the caller acts on.
  //
  // `newHolder` last: the holder read BEFORE the unassign, which is right when the live read failed
  // outright and `mirrorConsoleWrite` has already written that same holder to the row. A null here
  // would tell every open console the conversation is unassigned while Chatwoot and the mirror both
  // say a human has it.
  const finalHolder = state
    ? { assigneeType: state.assigneeType, assigneeId: state.assigneeId }
    : (holderOtherThan(observed) ??
      newHolder ?? { assigneeType: null, assigneeId: null });
  // And the ROW, which is the half a return value cannot fix. Where `observed` is what corrected the
  // answer, `mirrorConsoleWrite` has already written its fallback — status pending, no assignee —
  // because that is what this call asked for before anybody claimed the conversation. Leaving it
  // there makes the disagreement worse than the one just closed: the response and every open console
  // name the human, while the row that `shouldBotHandle` reads says the conversation is the bot's,
  // and the agent answers over them until an assignment webhook happens to arrive. It is the same
  // fallback-is-not-nobody reasoning one layer down, applied to the durable copy.
  if (state === null && finalHolder.assigneeType !== null) {
    await updateMirror(ctx, base, id, {
      assigneeType: finalHolder.assigneeType,
      assigneeId: finalHolder.assigneeId,
      // Same rule as the fallback inside `mirrorConsoleWrite`, for the same reason: this write moves
      // the holder, so the name has to move with it. Only the live read that SAW this holder can
      // name them — `newHolder`, the other source `finalHolder` can come from, was read before the
      // unassign and carries no name — and anything else is written as unknown rather than left
      // reading as the person who was here before.
      assigneeName:
        observed !== null &&
        observed.assigneeType === finalHolder.assigneeType &&
        observed.assigneeId === finalHolder.assigneeId
          ? observed.assigneeName
          : null,
    });
  }
  broadcastConversationEvent(tenantId, {
    conversationId: String(id),
    status: state?.status ?? "pending",
    assigneeId: finalHolder.assigneeId,
    assigneeType: finalHolder.assigneeType,
    lastEventAt:
      (state ? state.lastEventAt : conv.lastEventAt)?.toISOString() ?? null,
  });
  // The outcome, because "taken over" is not a failure and every caller would otherwise report the
  // hand-back it asked for as having happened. Nothing throws on this path: the status WAS set to
  // pending and the mirror WAS corrected — the one thing withheld is the unassign, which is exactly
  // what the caller told its operator it was doing.
  //
  // Read off the same value the console just received, because the two answering differently is the
  // defect rather than a detail: a caller told "returned" while the row it triggered names a person
  // has nothing to notice the disagreement with.
  //
  // And asked with the OWNERSHIP rule rather than "is there a type here", because the success state
  // of this very function can carry one: the pending transition, or a concurrent assignment, can
  // leave the conversation on the inbox's own agent bot — which the gate reads as the AI holding it,
  // exactly what the caller asked for. Answering "taken-over" there warns the operator that somebody
  // claimed a conversation the intended agent owns, and takes away the re-engage offer with it.
  //
  // A holder whose id never arrived is still a holder: `heldByAnotherParty` keeps that direction for
  // `User` (any human counts) while an unidentifiable AgentBot stays uncounted, which is the same
  // answer the unassign above already gives.
  const ourAgentBotId =
    conv.inbox?.agentId != null
      ? ((
          await runScopedOn(base, ctx, (db) =>
            db.chatwootAgentBot.findFirst({
              where: {
                tenantId,
                chatwootInstanceId: conv.chatwootInstanceId,
                agentId: conv.inbox?.agentId ?? 0n,
              },
              select: { chatwootAgentBotId: true },
            }),
          )
        )?.chatwootAgentBotId ?? null)
      : null;
  return heldByAnotherParty(finalHolder, { ourAgentBotId })
    ? "taken-over"
    : "returned";
}

export async function setConversationStatus(
  ctx: TenantContext,
  id: bigint,
  status: "open" | "pending" | "resolved",
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenantId = requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  // Operator-initiated → instance admin token (audit shows the operator, not the persona).
  const client = await loadChatwootClient(tenantId, conv.chatwootInstanceId, {
    ...deps,
    base,
  });
  await client.toggleStatus(conv.chatwootConversationId, status, {
    asAdmin: true,
  });
  // NOTE: An operator closing a conversation is not the agent resolving it, and the two are
  // indistinguishable from status + assignee alone (this path deliberately does NOT assign the
  // operator: the audit shows the instance admin, not the persona). Recording it is what keeps it
  // out of the Resolution funnel. Non-resolved statuses need nothing: the mirror clears the stamp.
  //
  // BEFORE the mirror write, not after: the recorder only stamps a row that is not already resolved
  // (a resolve on a resolved conversation is a no-op in Chatwoot and does not change who closed it),
  // and mirrorConsoleWrite is what makes this row resolved. Running it second would refuse every
  // console stamp; running it first also makes the re-resolve case fall out for free, because then
  // the row it reads is the pre-toggle one.
  if (status === "resolved") {
    await recordResolutionOrigin({
      tenantId,
      conversation: { id },
      origin: "console",
      // NOTE: conv is the row as loaded BEFORE the toggle, so an operator re-resolving an already
      // resolved conversation records nothing: their call was a no-op in Chatwoot too.
      observed: { status: conv.status, statusAt: conv.chatwootStatusAt },
      base,
    });
  }
  const { state } = await mirrorConsoleWrite(ctx, base, id, conv, client, {
    status,
  });
  broadcastConversationEvent(tenantId, {
    conversationId: String(id),
    status: state?.status ?? status,
    assigneeId: state ? state.assigneeId : conv.assigneeId,
    assigneeType: state ? state.assigneeType : conv.assigneeType,
    lastEventAt:
      (state ? state.lastEventAt : conv.lastEventAt)?.toISOString() ?? null,
  });
}
