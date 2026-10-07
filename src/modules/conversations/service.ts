import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { broadcastConversationEvent } from "@/api/features/realtime/realtime.service";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { modelConfigSchema } from "@/graph/model-config";
import { createChatModel } from "@/graph/models";
import { isNudgeOrigin } from "@/graph/nudge-origin";
import { loadAgentConfig } from "@/graph/prepare";
import { parseDbId } from "@/lib/db-id";
import {
  AppError,
  ConflictError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { withEntityLock } from "@/lib/locks";
import { assertUsableCount, badQueryParam } from "@/lib/query-param";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type AgentMode, normalizeAgentMode } from "@/modules/agents/mode";
import { isTestSilenced } from "@/modules/agents/test-mode";
import {
  type DrillOutcome,
  drillDownPageIds,
} from "@/modules/analytics/drilldown";
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
import { consoleWriteMark } from "@/modules/chatwoot/console-write-order";
import {
  type LoadChatwootClientDeps,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import {
  heldByAnotherParty,
  type LiveConversationState,
  parseLiveConversation,
} from "@/modules/chatwoot/normalize";
import { reconcileMirrorFromLive } from "@/modules/chatwoot/reconcile";
import { announceStatusChange } from "@/modules/chatwoot/status-announce";
import { recordConversationAction } from "@/modules/conversations/audit";
import { recordResolutionOrigin } from "@/modules/conversations/record-resolution";
import {
  type ConversationUsage,
  getConversationUsage,
} from "@/modules/conversations/usage";
import { appointmentPauseApplies } from "@/modules/followups/appointment-pause";
import {
  isFollowUpLive,
  ourSideHasSpoken,
} from "@/modules/followups/eligibility";
import type { FollowUpDelayUnit } from "@/modules/followups/settings";
import {
  followUpEpisodeKey,
  isNewFollowUpEpisode,
  lastActivityAt,
  readFollowUpConfig,
  silenceStartedAt,
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
  cursor?: bigint;
  // Free-text search: matches the contact display name or the Chatwoot conversation id (see
  // buildConversationsWhere). No message-body search — the mirror holds metadata only.
  q?: string;
  // Conversations on every inbox this agent is attached to: bound as its responder, or observing it
  // (a pending observer row included, as every reader of "does it observe" counts one). A monitoring
  // agent is never bound, so this is what its filter can show. An id of another tenant, or of no
  // agent, is an empty page under the caller's own scope.
  // Under a `drillDown` it reads as the dashboard's agent filter instead (bound, or the agent ran on
  // it), the one the clicked figure was counted with.
  agentId?: bigint;
  // A dashboard figure's conversations: its view (window of creation, inbox) and the outcome it
  // counts. See src/modules/analytics/drilldown.ts.
  drillDown?: {
    createdSince?: Date;
    createdUntil?: Date;
    inboxId?: bigint;
    outcome: DrillOutcome;
  };
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
  // The monitoring agents watching this conversation's inbox as observers, by name, so a row says
  // who is reading it even when nobody of ours answers it.
  observerNames: string[];
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
  assertUsableCount(limit, "limit");
  return limit === undefined ? DEFAULT_LIMIT : Math.min(limit, MAX_LIMIT);
}

// A status outside the closed set is REFUSED, never dropped: dropping it answers a request for one
// status with every status, which is the widening this whole surface exists to stop. `""` counts as
// a value the caller sent, exactly as it does for the ids. The check lives here rather than in the
// controller because MCP and internal callers reach this function without a query string, the same
// split `assertUsableCount` follows.
function normalizeStatus(status: string | undefined): string | undefined {
  if (status === undefined) return undefined;
  if (!(CONVERSATION_STATUSES as readonly string[]).includes(status))
    badQueryParam("status");
  return status;
}

// Combine the status filter with an optional free-text search. Search matches the contact display
// name (case-insensitive substring) OR, for an all-digit query, the Chatwoot conversation id
// (operators reference conversations by their Chatwoot #id). No message-body search — the mirror
// holds metadata only.
function buildConversationsWhere(
  status: string | undefined,
  q: string | undefined,
  agentId: bigint | undefined,
): Prisma.ConversationWhereInput {
  const where: Prisma.ConversationWhereInput = {};
  if (status) where.status = status;
  if (agentId !== undefined) {
    where.inbox = {
      OR: [{ agentId }, { observers: { some: { agentId } } }],
    };
  }
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

// The agents the Conversations screen can be narrowed to: id and name only. Its own read because
// `/v1/agents` is TENANT_ADMIN, and an AGENT-role user must be able to see and clear a filter a
// shared link put on them. Every agent, since a filter offering only the first page would leave the
// rest unpickable.
export async function listConversationAgentOptions(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<{ id: string; name: string }[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.agent.findMany({
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  );
  return rows.map((r) => ({ id: String(r.id), name: r.name }));
}

export async function listConversations(
  ctx: TenantContext,
  filter: ListConversationsFilter,
  base: PrismaClient = basePrisma,
): Promise<ConversationsPage> {
  const take = clampLimit(filter.limit);
  const status = normalizeStatus(filter.status);
  const cursorId = filter.cursor ?? null;
  const drill = filter.drillDown;
  const where: Prisma.ConversationWhereInput = drill
    ? {}
    : buildConversationsWhere(status, filter.q, filter.agentId);
  const rows = await runScopedOn(base, ctx, async (db) => {
    // The drill-down's page is chosen in SQL (same predicate as the figure); the rows are then read
    // by id in that order, with the same selection as the plain list.
    const pageIds = drill
      ? await drillDownPageIds(
          db,
          {
            view: {
              since: drill.createdSince,
              until: drill.createdUntil,
              inboxId: drill.inboxId,
              agentId: filter.agentId,
            },
            outcome: drill.outcome,
          },
          { status, q: filter.q, cursor: cursorId ?? undefined, take },
        )
      : null;
    if (pageIds && pageIds.length === 0) return [];
    const found = await db.conversation.findMany({
      where: pageIds ? { id: { in: pageIds } } : where,
      // lastEventAt is the canonical recency signal (nulls sort last); id breaks ties.
      orderBy: [
        { lastEventAt: { sort: "desc", nulls: "last" } },
        { id: "desc" },
      ],
      take,
      // Keyset: seek past the cursor row in the ordering above (id is unique → a stable anchor).
      ...(cursorId != null && !pageIds
        ? { cursor: { id: cursorId }, skip: 1 }
        : {}),
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
        inbox: {
          select: {
            id: true,
            name: true,
            agentId: true,
            observers: { select: { agentId: true } },
          },
        },
        contact: { select: { name: true } },
      },
    });
    if (!pageIds) return found;
    const byId = new Map(found.map((r) => [String(r.id), r]));
    return pageIds
      .map((id) => byId.get(String(id)))
      .filter((r): r is (typeof found)[number] => r !== undefined);
  });
  // Resolve the bound persona names for this page in one batch (Inbox carries agentId, no relation).
  const agentIds = [
    ...new Set(
      rows
        .flatMap((r) => [
          r.inbox?.agentId,
          ...(r.inbox?.observers.map((o) => o.agentId) ?? []),
        ])
        .filter((x): x is bigint => x != null),
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
    observerNames: (r.inbox?.observers ?? [])
      .map((o) => agentNameById.get(String(o.agentId)))
      .filter((n): n is string => n != null),
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
// Actions go over the client (bot token) OUTSIDE any tx, then optimistically update the mirror (the
// webhook reconciles the canonical state, with its lastEventAt monotonic guard). In the admin
// messages API `message_type` is a NUMBER, unlike the webhook where it is a string.

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
  // Whether that persona is switched on. With `agentMode`, what the console needs to know whether
  // anything answers this inbox before it offers to hand a conversation back.
  agentEnabled: boolean;
  // ...and whether it has a BOT on this deployment. A binding is not an identity: without the bot
  // row the server refuses the hand-back with 409 and the re-engage cannot load the agent, so the
  // console must offer neither. Derived from the held-by-another-party lookup, so it costs no query.
  agentHasBot: boolean;
  // The monitoring agents observing this inbox, by name.
  observerNames: string[];
  // The same observers with their ids, so the console can link to each one.
  observers: { id: string; name: string }[];
  // The bound persona's operating mode (item 1), so the console can flag a test agent. null = no agent.
  agentMode: AgentMode | null;
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
    // A follow-up job IS armed and the handler will drop it when it claims it (isFollowUpLive fails),
    // so the console shows neither a countdown nor "sequence complete". Keyed on a job EXISTING, not
    // on liveness alone: a sequence whose last step resolves the conversation also ends with the bot
    // not owning it, and that one is complete, not abandoned.
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
  // What the conversation has spent, as the provider reported it: the total for the header and the
  // newest turns' lines for the timeline.
  usage: ConversationUsage;
}

// A compact, PII-free activity marker drawn inline in the conversation timeline. Derived from the
// ExecutionLog: a tool call (kind "tool") or a proactive turn, by where it came from: an inactivity
// follow-up ("followup"), an appointment reminder ("reminder"), a channel-redirect follow-up
// ("redirect"), or an inbound integration's event ("event").
export interface ConversationTrailEntry {
  id: string;
  kind: "tool" | "followup" | "reminder" | "redirect" | "event";
  // Proactive rows only: whether the origin above was RECORDED by the turn (true) or inferred from
  // the nudge source on a line that records none (false). The screen matches only a recorded row by
  // `messageId`; an inferred one keeps the time-window match. null on tools.
  originRecorded: boolean | null;
  // Proactive rows only: the Chatwoot id of the message the turn sent the customer, or null when it
  // sent none (a note, a silence) or the line does not record it.
  messageId: number | null;
  // "event" rows only: the name of the integration that spoke, null when the line names no instance
  // or the instance no longer exists (the screen then says "External event").
  integrationName: string | null;
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
  // `skip_reply` only: whether that TURN had put something in front of the customer (a handoff's
  // closing line, an attachment) when the agent decided to stay quiet, which the tool name alone
  // cannot tell. null on every other row, and on a `skip_reply` line that does not record it
  // (unknown, so the screen keeps the plain label).
  turnDelivered: boolean | null;
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
  lastRepliedMessageId: number | null;
  // When OUR side last spoke here: the estimate's fence and episode predicate read it, and they have
  // to read what the sweep reads.
  lastRepliedAt: Date | null;
  chatwootFirstReplyAt: Date | null;
  lastProactiveAt: Date | null;
  inbox: {
    id: bigint;
    name: string;
    agentId: bigint | null;
    chatwootInboxId: number;
    observers: { agentId: bigint }[];
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
        lastRepliedMessageId: true,
        // NOTE: the estimate's fence and episode predicate must read what the sweep reads, or the
        // indicator promises a follow-up that never fires.
        lastRepliedAt: true,
        chatwootFirstReplyAt: true,
        lastProactiveAt: true,
        inbox: {
          select: {
            id: true,
            name: true,
            agentId: true,
            chatwootInboxId: true,
            observers: { select: { agentId: true } },
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
  await runScopedOn(base, ctx, async (db) => {
    const key = await db.conversation.findUnique({
      where: { id },
      select: {
        tenantId: true,
        chatwootInstanceId: true,
        chatwootConversationId: true,
      },
    });
    if (!key) return;
    // NOTE: under the conversation's own lock, the one the mirror, the reconcile and the takeover claim
    // take: the status this write moves is announced here, and read outside the lock a webhook for the
    // same click could read the old status too and announce the transition a second time.
    await withEntityLock(
      db,
      `${key.tenantId}:${key.chatwootInstanceId}:${key.chatwootConversationId}`,
      async () => {
        const before =
          data.status === undefined
            ? null
            : await db.conversation.findUnique({
                where: { id },
                select: { status: true, inboxId: true, assigneeType: true },
              });
        await db.conversation.updateMany({ where: { id }, data });
        if (before && data.status !== undefined) {
          await announceStatusChange(db, key.tenantId, {
            conversationId: id,
            inboxId: before.inboxId,
            status: data.status,
            previousStatus: before.status,
            assigneeType:
              data.assigneeType === undefined
                ? before.assigneeType
                : data.assigneeType,
          });
        }
      },
    );
  });
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

// What the mirror write knows afterwards. `state` is what was STORED, null whenever the live read
// could not be versioned (the fallback writes only the fields the action meant to change, so there
// is no trustworthy full row to hand back). `observed` is what Chatwoot SAID, kept even unversioned:
// the hand-back's final read is the only look taken after the unassign, and a human who claimed the
// conversation in that window must not be discarded. Required, so a new caller says what it does
// with an undecided read.
interface ConsoleWriteMirror {
  state: ConsoleWriteState | null;
  observed: {
    assigneeType: string | null;
    assigneeId: number | null;
    assigneeName: string | null;
  } | null;
}

// The reading that orders a console write that could not be versioned, taken by the caller BEFORE
// its own writes to Chatwoot and handed to `mirrorConsoleWrite` as `markAt`. A reading taken after
// the action could contain a colleague who replied during the round trip, and the takeover's fence
// would then skip that colleague's handover. One function, so every call site shares the decision.
// A failed read is `null`: it stamps nothing and leaves the previous mark standing.
function readLiveBeforeConsoleWrite(
  client: ChatwootClient,
  chatwootConversationId: number,
): Promise<LiveConversationState | null> {
  // NOTE: try/catch rather than `.catch` alone: a client that cannot answer this call throws
  // SYNCHRONOUSLY, which a rejection handler never sees, and every caller treats this read as
  // failing open.
  try {
    return client
      .getConversation(chatwootConversationId)
      .catch(() => null)
      .then(parseLiveConversation);
  } catch {
    return Promise.resolve(null);
  }
}

// Writes the mirror after a console action, claiming the version Chatwoot produced for it. The two
// write endpoints do not serialize `updated_at`, so a blind write carries no version and an event
// Chatwoot serialized BEFORE the click, still retrying, would outrank it and undo the action (the
// runtime's ownership recheck reads this row). Reading the conversation back gets the same
// `updated_at.to_f` the webhook carries; when that read fails or has no version, the blind write
// still runs so the console reflects the operator's action.
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
  // Where the source's message sequence stood BEFORE this action was applied, or null when the caller
  // took no reading. Required and not derivable here: this runs after the caller's Chatwoot calls, so
  // a read here could cover a colleague's reply typed after the click and the fence would skip it.
  markAt: number | null,
): Promise<ConsoleWriteMirror> {
  const tenantId = requireTenant(ctx);
  // NOTE: the mark is stamped before anything here can return, on every path. It says which message
  // Chatwoot already had when the action was applied, so the human-reply takeover can tell a reply
  // that predates the click from one typed after it. The takeover recovery carries no version, so a
  // mark written only on the unversioned tail would leave versioned deployments unfenced. Its own
  // statement with `GREATEST`, so it never moves backwards when two console writes commit out of
  // order (a NULL column takes the first value). A payload whose version compares EQUAL passes the
  // strict version check and is refused by the mark: that is the fence working, not a side effect.
  if (markAt !== null) {
    await runScopedOn(
      base,
      ctx,
      (db) => db.$executeRaw`
      UPDATE conversations
         SET console_write_at_message_id = GREATEST(console_write_at_message_id, ${markAt})
       WHERE id = ${id}`,
    );
  }
  // NOTE: an operator commanding a non-resolved status ends the resolution, decided here and not in
  // either write below, and not via `clearsResolutionOrigin`: a click is a command with no ordering
  // to consult. The versioned reconcile returns before the fallback, so clearing only there would
  // let the stamp survive the reopen while our own resolve webhook has not landed.
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
    // NOTE: a snapshot with no version is not reconciled: the reconcile would apply the WHOLE
    // snapshot, so a status click could carry back an assignee a webhook has since changed. The
    // fallback writes exactly the fields this action meant to change.
    if (live && live.updatedAt !== null) {
      const outcome = await reconcileMirrorFromLive({
        tenantId,
        instanceId: conv.chatwootInstanceId,
        conversationId: conv.chatwootConversationId,
        live,
        // NOTE: an operator's click is a decision even when it restates the stored state.
        ownershipIsDecision: fallback.status != null,
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
  // The name follows the holder. `assigneeName` is its own column, so a fallback that moves
  // the id and keeps the name would show the new holder under the previous holder's name. Holder
  // not moving: keep the name. Holder is the one the live read saw: take that name. Otherwise:
  // null, since the name is unknown here.
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
  // NOTE: this write claims no version (the toggle and assignment endpoints render no `updated_at`,
  // and the read that would supply one just failed), so a payload serialized before the click could
  // pass the takeover's freshness check. The mark stamped at the top of this function answers that;
  // the status claim does not, since it fences a transition still on the wire.
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
  const observerIds = conv.inbox?.observers.map((o) => o.agentId) ?? [];
  const observerRows =
    observerIds.length > 0
      ? await runScopedOn(base, ctx, (db) =>
          db.agent.findMany({
            where: { id: { in: observerIds } },
            select: { id: true, name: true },
            orderBy: { id: "asc" },
          }),
        )
      : [];
  const observerNames = observerRows.map((a) => a.name);
  const observers = observerRows.map((a) => ({
    id: String(a.id),
    name: a.name,
  }));
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

  // The EPISODE's activation, not this row's. A channel-redirect episode is two conversations
  // of one contact and `/teste` stamps only the one it was typed in. The badge and the follow-up
  // estimate both read this, and must agree with the gates in `webhook.ts`.
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
    // Whether a follow-up here is alive at all, by the predicate the handler re-checks when it
    // claims the job. Both branches below are gated on it: the sweep would never enqueue the
    // estimate, and the handler would drop the armed job.
    const followUpLive = isFollowUpLive({
      agentEnabled: agent?.enabled ?? false,
      followUpEnabled: cfg.enabled,
      managedByRedirect,
      agentMode: agent?.mode ?? "production",
      testActivatedAt: episodeActivatedAt,
      status: conv.status,
      assigneeType: conv.assigneeType,
      // NOTE: the strict ownership answer: nothing runs after the indicator to correct it, so a
      // conversation another persona's bot holds must not be counted down. `heldByAnotherParty`
      // alone leaves an unidentifiable AgentBot uncounted; for a promise, unverifiable is not ours
      // (as the live payload's parser refuses an "AgentBot" with no numeric id).
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
      // NOTE: the sweep never selects a conversation nobody ever answered, so a countdown there would
      // promise a re-engagement that cannot happen.
      ourSideHasSpoken: ourSideHasSpoken(conv),
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
    // The conversation's one FOLLOWUP row, whatever its state: PENDING is the job the estimate
    // reads, and DEAD is a follow-up the sweep will not offer again in this episode.
    const jobRow = managedByRedirect
      ? null
      : await runScopedOn(base, ctx, (db) =>
          db.schedulerJob.findFirst({
            where: {
              kind: "FOLLOWUP",
              dedupeKey: `followup:${conv.threadId}`,
            },
            select: {
              runAt: true,
              payload: true,
              status: true,
              updatedAt: true,
            },
          }),
        );
    const job = jobRow?.status === "PENDING" ? jobRow : null;
    let nextStep: number | null = null;
    let nextRunAt: string | null = null;
    // True when the configured cadence landed outside the send window, so the estimate was pushed to
    // the next open slot (item 3): the conversation line then reads e.g. "in 3 days" even though the
    // step is "2d". The tooltip uses this to explain the deferral.
    let nextRunAtDeferred = false;
    const firstStep = cfg.steps[0];
    // The estimate shows what the handler will ACTUALLY do, including its terminal case: a
    // schedule that never reopens (a closure outliving the scan horizon, or a recurring one covering
    // every date) makes the handler END the sequence, so null here means no next step.
    const openWindowFor = (dueAt: Date): Date | null =>
      hours && hours.windows.length > 0 ? nextOpenAt(hours, dueAt) : dueAt;
    // A PENDING step-0 job enqueued before a re-arm will be DROPPED by the handler's
    // activation fence — the estimate must not promise it. Later steps stay exempt (an in-flight
    // sequence legitimately outlives a re-arm), mirroring followUpHandler.
    const rawStep = (job?.payload as { stepIndex?: unknown } | null)?.stepIndex;
    const jobStepIndex =
      typeof rawStep === "number" && Number.isInteger(rawStep) ? rawStep : 0;
    // Same expression the sweep and the handler use: the LATER of the two words spoken here.
    const fencedSilenceStart = silenceStartedAt(
      conv.lastInboundAt,
      conv.lastRepliedAt,
    );
    // A follow-up that died in THIS episode (its row went DEAD after the silence began): the
    // sweep leaves the conversation out until either side speaks again, so no step 1 is promised.
    // Same comparison as the sweep's SQL, dated by the row's episode when it carries one.
    const deadEpisode = (jobRow?.payload as { episode?: unknown } | null)
      ?.episode;
    const diedThisEpisode =
      jobRow?.status === "DEAD" &&
      fencedSilenceStart != null &&
      (typeof deadEpisode === "string"
        ? deadEpisode === followUpEpisodeKey(fencedSilenceStart)
        : jobRow.updatedAt >= fencedSilenceStart);
    // Our own reply opens an episode and cancels nothing, so a pending later-step job can meet
    // a fresh episode, and the handler drops it (`else if (newEpisode) return done`). The console
    // must not count it down.
    const newEpisode = isNewFollowUpEpisode(
      conv.lastFollowUpAt,
      conv.lastInboundAt,
      conv.lastRepliedAt,
    );
    // Whoever opened the episode. The handler drops a pending later step in both shapes of a
    // fresh episode, and the inbound webhook's cancel of that job can be lost or delayed, so this
    // predicate must not be narrower than the handler. A live appointment does not save the job
    // either: the sweep's `upsertJobRow` overwrites a PENDING row with the new episode's step 0, and
    // the pause shows through `pausedByAppointment` below, for the step that will actually run.
    const supersededLaterStepJob =
      job != null && jobStepIndex > 0 && newEpisode;
    // The inactivity floor, the same one the handler and the SQL use: our reply counts as movement.
    const movedAt = lastActivityAt(
      conv.lastEventAt,
      conv.lastRepliedAt,
      conv.lastProactiveAt,
    );
    const fencedStep0Job =
      job != null &&
      jobStepIndex === 0 &&
      (agent?.followUpArmedAt == null ||
        fencedSilenceStart == null ||
        fencedSilenceStart < agent.followUpArmedAt);
    // A job whose step no longer exists is a sequence that is OVER (the handler returns `done`
    // on its first look), as when an operator shortens a sequence with a later step pending. Its own
    // arm ahead of the others: falling through would count down to step 1 of a sequence about to end.
    const jobStepGone = job != null && cfg.steps[jobStepIndex] === undefined;
    // NOTE: ...unless that job was already superseded by an episode our own reply opened: the sweep
    // is about to start a fresh step 0, and suppressing here would hide the NEW episode's countdown.
    if (jobStepGone && !supersededLaterStepJob) {
      nextStep = null;
    } else if (
      job &&
      !fencedStep0Job &&
      !supersededLaterStepJob &&
      followUpLive
    ) {
      const stepIndex = jobStepIndex;
      nextStep = stepIndex + 1;
      // job.runAt is NOT the firing time yet — the sweep enqueues step 0 with runAt=now (and re-arms
      // it on EVERY pass), so a freshly-swept job's runAt sits before the real cadence AND outside the
      // business-hours window until the worker claims it and reschedules. Reconstruct what will actually
      // fire, exactly like the handler: floor step 0 at lastEventAt + first-step delay, then push an
      // out-of-window time to the next open window. Without this the indicator flickers to "imminent /
      // out-of-hours" right after each sweep and only resyncs once the worker rewrites run_at.
      let dueAt = job.runAt;
      if (stepIndex === 0 && firstStep && movedAt) {
        const floor = new Date(
          movedAt.getTime() + stepDelayMinutes(firstStep) * 60_000,
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
      // NOTE: no job armed yet: estimate the FIRST step, since the sweep enqueues the job only about
      // at fire time and the indicator would otherwise sit at "none scheduled", then jump to
      // "complete". Same eligibility as the sweep and handler (isNewFollowUpEpisode, ownership,
      // test-silence, activity), or the indicator disagrees with what actually fires.
      followUpLive &&
      firstStep &&
      newEpisode &&
      // NOTE: Activation fence (mirrors the sweep SQL): no estimate for an episode that began before
      // follow-up was armed — the sweep will never enqueue it, so the indicator must not promise it.
      agent?.followUpArmedAt != null &&
      fencedSilenceStart != null &&
      fencedSilenceStart >= agent.followUpArmedAt &&
      !diedThisEpisode &&
      movedAt
    ) {
      nextStep = 1;
      const dueAt = new Date(
        movedAt.getTime() + stepDelayMinutes(firstStep) * 60_000,
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
    // A live appointment suppresses both shapes (the sweep never enqueues the estimated step,
    // and the handler keeps rescheduling an armed job), so show the reason instead of a time. Read
    // through the handler's own source (loadAppointmentContext), asked about the step about to fire
    // (`steps[nextStep - 1]`), not the agent. Gated on `nextStep` so the flag appears only when the
    // appointment is what hides something: every other reason already leaves nextStep null.
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
      // NOTE: keyed on "nothing is coming", not on why: a PENDING job with no scheduled step (the
      // handler would drop it, a fresh episode dooms a later step, or `fencedStep0Job`) must not read
      // as "sequence complete". The appointment pause is the other state, with its own field.
      abandoned: job !== null && nextStep === null && !pausedByAppointment,
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
        turnId: true,
        stage: true,
        status: true,
        durationMs: true,
        detail: true,
        errorMessage: true,
        createdAt: true,
      },
    }),
  );
  // The delivery fact is the turn's, folded over the turn before any row is shaped. A turn can
  // write several `skip_reply` lines, each stamped with what it had delivered at that instant, and a
  // batch after the decision can still deliver (a transfer's closing line). The `generate` line the
  // runtime writes when the turn ENDS carries what actually reached the customer, so it wins; else
  // the LAST stamp (rows arrive newest-first). That end line is newer than the decision it governs,
  // so the 60-row newest-first cap cannot drop it while keeping the marker (tests/graph/runtime.test.ts
  // covers it on a real turn, since `emitFlowEvent` does not await its write).
  const deliveredByTurn = new Map<string, boolean>();
  const finalByTurn = new Map<string, boolean>();
  for (const r of trailRows) {
    const d = (r.detail ?? null) as Record<string, unknown> | null;
    if (typeof d?.turnDelivered !== "boolean") continue;
    const into = r.stage === "generate" ? finalByTurn : deliveredByTurn;
    if (into.has(r.turnId)) continue;
    into.set(r.turnId, d.turnDelivered);
  }
  // The integrations "event" rows name, resolved in one read under the tenant's scope. An instance
  // deleted since, or one of another tenant, is simply absent and the row falls back to no name.
  const instanceIds = [
    ...new Set(
      trailRows.flatMap((r) => {
        const d = (r.detail ?? null) as Record<string, unknown> | null;
        const raw =
          r.stage === "generate" && typeof d?.integrationInstanceId === "string"
            ? parseDbId(d.integrationInstanceId)
            : null;
        return raw === null ? [] : [raw];
      }),
    ),
  ];
  const instanceNames = new Map<string, string>();
  if (instanceIds.length > 0) {
    const found = await runScopedOn(base, ctx, (db) =>
      db.integrationInstance.findMany({
        where: { id: { in: instanceIds } },
        select: { id: true, name: true },
      }),
    );
    for (const f of found) instanceNames.set(String(f.id), f.name);
  }
  const trail: ConversationTrailEntry[] = [];
  for (const r of trailRows) {
    const detail = (r.detail ?? null) as Record<string, unknown> | null;
    // The turn's summary of a tool that failed on every call (`failedCalls`) is not a call: its calls
    // are already on the trail, each with its own row.
    if (r.stage === "tool" && detail?.failedCalls !== undefined) continue;
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
        // The turn's answer, but only on a row that ASKED the question. The stamp is written by the
        // silence tool's line and by no other, so a row without one keeps null: the fact is about
        // the turn, and the claim is the silence marker's alone to make.
        errorMessage: r.status === "error" ? r.errorMessage : null,
        originRecorded: null,
        messageId: null,
        integrationName: null,
        turnDelivered:
          typeof detail?.turnDelivered === "boolean"
            ? (finalByTurn.get(r.turnId) ??
              deliveredByTurn.get(r.turnId) ??
              null)
            : null,
        at: r.createdAt.toISOString(),
      });
    } else if (
      r.stage === "generate" &&
      detail &&
      typeof detail.trigger === "string"
    ) {
      const recorded = isNudgeOrigin(detail.origin) ? detail.origin : null;
      const kind: ConversationTrailEntry["kind"] =
        recorded ??
        // NOTE: a line that records no origin keeps the inference from its trigger.
        (detail.trigger === "appointment_reminder" ? "reminder" : "followup");
      trail.push({
        id: String(r.id),
        kind,
        originRecorded: recorded !== null,
        messageId:
          recorded !== null &&
          typeof detail.messageId === "number" &&
          Number.isSafeInteger(detail.messageId)
            ? detail.messageId
            : null,
        integrationName:
          kind === "event" && typeof detail.integrationInstanceId === "string"
            ? (instanceNames.get(detail.integrationInstanceId) ?? null)
            : null,
        name: detail.trigger,
        status: r.status,
        durationMs: r.durationMs,
        step: typeof detail.step === "number" ? detail.step : null,
        args: null,
        output: null,
        errorMessage: null,
        turnDelivered: null,
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
    agentEnabled: agent?.enabled ?? false,
    agentHasBot: ourAgentBotId !== null,
    observerNames,
    observers,
    agentMode: agent ? normalizeAgentMode(agent.mode) : null,
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
    usage: await getConversationUsage(ctx, id, base),
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
  // TWO REQUESTS, and either can fail on its own. The assignment landing and the toggle failing is a
  // conversation a person now holds, in Chatwoot, irreversibly — and an "on success" row would leave
  // that with nothing on the trail saying who put them there. The row follows the EFFECT, so a
  // partial effect gets a partial row and the error still propagates.
  let assigned = false;
  try {
    if (assigneeId !== null) {
      await client.assignToAgent(conv.chatwootConversationId, assigneeId, {
        asAdmin: true,
      });
      assigned = true;
    }
    await client.toggleStatus(conv.chatwootConversationId, "open", {
      asAdmin: true,
    });
  } catch (err) {
    if (assigned) {
      await recordConversationAction(ctx, base, id, {
        action: "conversation.handoff",
        before: {
          status: conv.status,
          assigneeType: conv.assigneeType,
          assigneeId: conv.assigneeId,
        },
        // NOTE: The status is the one this call READ, because the toggle is what failed; `partial` is what
        // says the pair did not complete, rather than leaving a reader to infer it from a status
        // that did not move.
        after: {
          status: conv.status,
          assigneeType: "User",
          assigneeId,
          partial: true,
        },
      });
    }
    throw err;
  }
  // FROM HERE THE EFFECT HAS HAPPENED, and everything below is our own bookkeeping. It can throw —
  // the mirror's fallback write is a transaction like any other — and a row written only on the
  // happy path would then be missing for a conversation Chatwoot has already handed to a person.
  // So the row is written in a `finally`, from the best `after` known at that moment: the reconciled
  // state when the mirror got there, and the state Chatwoot accepted when it did not.
  let landed: {
    status: string;
    assigneeType: string | null;
    assigneeId: number | null;
  } = {
    status: "open",
    assigneeType: assigneeId !== null ? "User" : conv.assigneeType,
    assigneeId: assigneeId ?? conv.assigneeId,
  };
  try {
    const { state } = await mirrorConsoleWrite(
      ctx,
      base,
      id,
      conv,
      client,
      // NOTE: the holder is part of what this write ASKED FOR only when it named one: an untargeted
      // handoff sends no assignment and the open toggle assigns nobody, so claiming `User` in the
      // fallback would stamp a person onto a conversation that has none.
      {
        status: "open",
        ...(assigneeId !== null ? { assigneeType: "User", assigneeId } : {}),
      },
      // NO MARK, and it costs nothing here: this action hands the conversation to a PERSON, so the
      // fence the mark feeds is never reached — `conversationOwnershipNow` answers "not ours" first.
      // Taking a reading before the write would buy a round trip for a comparison nobody makes.
      null,
    );
    // NOTE: where this write landed, resolved once and read by both the broadcast and the row, so
    // they cannot disagree. It is the row as STORED, not as asked for: the live read may have come
    // back with something else, and an untargeted handoff never calls `assignToAgent`, so the holder
    // is Chatwoot's answer and not this call's argument.
    landed = {
      status: state?.status ?? "open",
      assigneeId: state ? state.assigneeId : (assigneeId ?? conv.assigneeId),
      // NOTE: `User` only where THIS call put one there. An untargeted handoff makes no assignment
      // request and the open toggle auto-assigns nobody (`docs/chatwoot.md`), so with no usable
      // post-write state the holder is the one the conversation already had.
      assigneeType: state
        ? state.assigneeType
        : assigneeId !== null
          ? "User"
          : conv.assigneeType,
    };
    broadcastConversationEvent(tenantId, {
      conversationId: String(id),
      ...landed,
      lastEventAt:
        (state ? state.lastEventAt : conv.lastEventAt)?.toISOString() ?? null,
    });
  } finally {
    // NOTE: `before` comes off the mirror, not a live read: the row answers "what did this action
    // move", which is the state the operator saw when they clicked. The TYPE travels with the id on
    // both sides, since `User` and `AgentBot` are separate id namespaces in Chatwoot.
    await recordConversationAction(ctx, base, id, {
      action: "conversation.handoff",
      before: {
        status: conv.status,
        assigneeType: conv.assigneeType,
        assigneeId: conv.assigneeId,
      },
      after: landed,
    });
  }
}

// Return to the bot: set status pending AND unassign the human (the gate requires both, and
// toggle_status to pending does NOT clear the assignee in the chatwoot-pro fork). STATUS FIRST,
// chosen for the failure: unassigning first and then failing leaves nobody's conversation (no
// human, a status the gate refuses), while the other partial leaves the human holding it. The
// window this opens is narrowed by reading the holder LIVE and unassigning only that same holder
// (Chatwoot has no conditional unassign), so a human who claims it meanwhile stays.
export type ReturnToAgentOutcome = "returned" | "taken-over";

// A hand-back needs somebody to hand back TO. On an inbox whose responder is missing, switched off,
// only observes, or has no bot, nothing ever picks the conversation up again, so the refusal comes
// BEFORE any write and names the reason (the console shows it as is). Asked of every caller (the
// console button, the MCP tool, `/reset`), since each would strand the conversation the same way.
export async function requireAnsweringResponder(
  ctx: TenantContext,
  inbox: { agentId: bigint | null } | null,
  chatwootInstanceId: bigint,
  base: PrismaClient,
  // The conversation this is being asked about, when the caller has one. The RUNNABLE probe needs it
  // (`loadAgentConfig` is keyed by thread) and so does the TEST ACTIVATION one, which is a fact about
  // this conversation rather than about the agent. A caller without one (there is none today) gets
  // every other rule unchanged rather than a refusal it cannot act on.
  runnableFor?: {
    conversationId: number;
    threadId: string;
    testActivatedAt: Date | null;
    contactId: bigint | null;
    chatwootInboxId: number | null;
  },
): Promise<void> {
  const agentId = inbox?.agentId ?? null;
  if (agentId === null) {
    throw new ConflictError(
      "No responder is bound to the inbox of this conversation.",
      "errors.returnNoResponder",
    );
  }
  const [agent, bot] = await runScopedOn(base, ctx, (db) =>
    Promise.all([
      db.agent.findUnique({
        where: { id: agentId },
        // `settings` for the redirect pairing the test-activation question needs below; it is one
        // column on a row this already reads.
        select: { enabled: true, mode: true, settings: true },
      }),
      // NOTE: ...and the persona's bot on THIS deployment. A binding is not an identity: the row can
      // be missing (an instance reconnected, a bot deleted upstream and the reconcile not run), and
      // then the runtime has no token and no route to answer with.
      db.chatwootAgentBot.findUnique({
        where: {
          tenantId_chatwootInstanceId_agentId: {
            tenantId: requireTenant(ctx),
            chatwootInstanceId,
            agentId,
          },
        },
        select: { chatwootAgentBotId: true },
      }),
    ]),
  );
  if (!agent?.enabled) {
    throw new ConflictError(
      "The responder of this inbox is switched off.",
      "errors.returnAgentOff",
    );
  }
  if (normalizeAgentMode(agent.mode) === "monitoring") {
    throw new ConflictError(
      "The responder of this inbox observes; it does not answer.",
      "errors.returnAgentObserves",
    );
  }
  if (bot === null) {
    throw new ConflictError(
      "The responder of this inbox has no bot on this Chatwoot; reconnect the instance.",
      "errors.returnAgentNoBot",
    );
  }
  // NOTE: and a config that actually builds, asked with the runtime's own loader (`skipExperiment`, so
  // the probe enrols the thread in no experiment). A 4xx `AppError` or the loader's `null` refuses;
  // anything else (a credential that fails to decrypt) is rethrown, not read as a blip. The whole
  // guard is in docs/chatwoot.md ("Nothing to hand back to").
  if (runnableFor) {
    const cfg = await runScopedOn(base, ctx, (db) =>
      loadAgentConfig(
        db,
        {
          tenantId: requireTenant(ctx),
          instanceId: chatwootInstanceId,
          conversationId: runnableFor.conversationId,
          agentId,
          threadId: runnableFor.threadId,
        },
        { skipExperiment: true },
      ),
    ).catch((err) => {
      if (err instanceof AppError && err.statusCode < 500) return null;
      throw err;
    });
    // The model has to build too: any throw from this side-effect-free constructor is
    // deterministic, so it refuses. The verdict is held, not thrown here, because the loader's `null`
    // also covers an agent just switched off or flipped to monitoring; the reason is chosen after the
    // last reading, in the order the operator can act on: off, then observes, then not runnable.
    let notRunnable: string | null =
      cfg === null ? "config did not load" : null;
    if (cfg) {
      try {
        createChatModel({
          provider: cfg.mc.provider,
          model: cfg.mc.model,
          apiKey: cfg.apiKey,
          baseURL: cfg.credentialBaseUrl ?? cfg.mc.baseURL ?? undefined,
          temperature: cfg.mc.temperature,
        });
      } catch (err) {
        logger.warn(
          { err },
          "conversations: the responder's model could not be built before the hand-back",
        );
        notRunnable = "the model could not be built";
      }
    }
    // NOTE: a key where the provider needs one, which the constructor does not check for every
    // provider (the `ChatOpenAI`-based ones accept `apiKey: ""` and fail on the first request). The
    // rule is `config-health.ts`'s (all but `openai-compatible`), asked of the RESOLVED key.
    if (
      cfg !== null &&
      cfg.mc.provider !== "openai-compatible" &&
      cfg.apiKey.trim() === ""
    ) {
      notRunnable = "the provider needs a key and the agent has none";
    }
    // A `test` agent not activated here answers nothing either (`isTestSilenced`, through
    // `episodeTestActivatedAt` since a redirect pair's activation can live on the sibling). Asked
    // last, on a fresh read of the agent that also re-asks the switch and the mode, because the
    // snapshot at the top is several awaits old by here.
    const last = await runScopedOn(base, ctx, (db) =>
      db.agent.findUnique({
        where: { id: agentId },
        select: { enabled: true, mode: true, settings: true },
      }),
    );
    if (!last?.enabled) {
      throw new ConflictError(
        "The responder of this inbox is switched off.",
        "errors.returnAgentOff",
      );
    }
    if (normalizeAgentMode(last.mode) === "monitoring") {
      throw new ConflictError(
        "The responder of this inbox observes; it does not answer.",
        "errors.returnAgentObserves",
      );
    }
    // The loader's verdict, judged after the reasons that outrank it and logged with its own cause,
    // which the single translation key does not carry.
    if (notRunnable !== null) {
      logger.warn(
        "conversations: the responder of agent %s cannot run before a hand-back — %s",
        String(agentId),
        notRunnable,
      );
      throw new ConflictError(
        "The responder of this inbox cannot run; check its model credential.",
        "errors.returnAgentNotRunnable",
      );
    }
    const activatedAt = await episodeTestActivatedAt({
      tenantId: requireTenant(ctx),
      instanceId: chatwootInstanceId,
      cfg: readChannelRedirectConfig(last.settings),
      agentMode: last.mode ?? "production",
      conv: {
        testActivatedAt: runnableFor.testActivatedAt,
        contactId: runnableFor.contactId,
        chatwootInboxId: runnableFor.chatwootInboxId,
      },
      base,
    });
    if (isTestSilenced(last.mode ?? "production", activatedAt)) {
      throw new ConflictError(
        "The responder of this inbox is in test mode and has not been activated on this conversation.",
        "errors.returnAgentTestSilent",
      );
    }
  }
}

// The attachment Chatwoot actually has, and that it is OURS: our `ChatwootAgentBot` row does not say
// the bot is still attached to this inbox, nor that the attached bot is this responder's (an
// out-of-band rebind). Fails OPEN on an unreadable answer, like the baseline read; only a definite
// answer refuses. A missing local row refuses on its own.
async function requireLiveAttachment(
  ctx: TenantContext,
  where: {
    chatwootInstanceId: bigint;
    chatwootInboxId: number | null;
    agentId: bigint | null;
  },
  client: {
    inboxAgentBotId: (inboxId: number) => Promise<number | null | undefined>;
  },
  base: PrismaClient,
  conversationId: bigint,
): Promise<void> {
  if (where.chatwootInboxId === null || where.agentId === null) return;
  const ours = (
    await runScopedOn(base, ctx, (db) =>
      db.chatwootAgentBot.findUnique({
        where: {
          tenantId_chatwootInstanceId_agentId: {
            tenantId: requireTenant(ctx),
            chatwootInstanceId: where.chatwootInstanceId,
            agentId: where.agentId ?? 0n,
          },
        },
        select: { chatwootAgentBotId: true },
      }),
    )
  )?.chatwootAgentBotId;
  // try/catch and not `.catch`, because the call itself can throw: a client that cannot answer this
  // question at all is the same "unreadable" case as one whose request fails.
  let attached: number | null | undefined;
  try {
    attached = await client.inboxAgentBotId(where.chatwootInboxId);
  } catch (err) {
    logger.warn(
      { err },
      `conversations: could not read the inbox's attached bot before the hand-back (conv=${String(conversationId)})`,
    );
    return;
  }
  // NOTE: a missing local row refuses before the remote answer is consulted: `deleteAgent` leaves
  // the remote bot attached, so Chatwoot would report an id for a persona whose route token is gone.
  // Unlike the remote answers, a row that is not there is definite.
  if (ours === undefined) {
    throw new ConflictError(
      "The responder of this inbox has no bot on this Chatwoot; reconnect the instance.",
      "errors.returnAgentNoBot",
    );
  }
  if (attached === undefined) return;
  if (attached === null || attached !== ours) {
    throw new ConflictError(
      "The responder of this inbox is not attached in Chatwoot; reconnect the inbox.",
      "errors.returnAgentNotAttached",
    );
  }
}

// The same refusal, asked of a conversation id alone, for a caller that has not loaded one: the MCP
// DRY RUN, whose preview must answer what the apply will do (docs/mcp.md).
export async function assertConversationReturnable(
  ctx: TenantContext,
  id: bigint,
  // The client the REMOTE half needs: without it the preview would approve a hand-back the apply
  // refuses with a 409 on the very next call. One GET.
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<void> {
  const conv = await loadConvRef(ctx, id, base);
  const client = await loadChatwootClient(
    requireTenant(ctx),
    conv.chatwootInstanceId,
    { ...deps, base },
  );
  // The inbox Chatwoot names, as the apply reads it: a preview judging a transferred
  // conversation by the inbox it LEFT would approve what the apply refuses. Nothing is written, so
  // the apply's lock has no place here.
  const live = await readLiveBeforeConsoleWrite(
    client,
    conv.chatwootConversationId,
  );
  const inbox = await resolveHandBackInbox(
    ctx,
    base,
    conv.chatwootInstanceId,
    live?.inboxId ?? null,
    conv.inbox,
  );
  // NOTE: in the apply's own order, attachment first and the local state last: coherence covers the
  // REASON as well as the verdict, so a responder both off and detached gets the same refusal key.
  await requireLiveAttachment(
    ctx,
    {
      chatwootInstanceId: conv.chatwootInstanceId,
      chatwootInboxId: inbox?.chatwootInboxId ?? null,
      agentId: inbox?.agentId ?? null,
    },
    client,
    base,
    id,
  );
  await requireAnsweringResponder(ctx, inbox, conv.chatwootInstanceId, base, {
    conversationId: conv.chatwootConversationId,
    threadId: conv.threadId,
    testActivatedAt: conv.testActivatedAt,
    contactId: conv.contactId,
    chatwootInboxId: inbox?.chatwootInboxId ?? null,
  });
}

// Which inbox a hand-back is judged against, off what CHATWOOT says rather than the mirror. Shared
// by the preview and the apply so the two cannot drift. `mirrored` stands only when the source named
// no inbox; an inbox the source names that has no row here is null (this runtime does not serve it,
// so it has no responder), never the mirror's stale row.
async function resolveHandBackInbox(
  ctx: TenantContext,
  base: PrismaClient,
  chatwootInstanceId: bigint,
  liveInboxId: number | null,
  mirrored: { agentId: bigint | null; chatwootInboxId: number } | null,
): Promise<{ agentId: bigint | null; chatwootInboxId: number } | null> {
  if (liveInboxId === null) return mirrored;
  if (mirrored !== null && mirrored.chatwootInboxId === liveInboxId) {
    return mirrored;
  }
  return await runScopedOn(base, ctx, (db) =>
    db.inbox.findFirst({
      where: { chatwootInstanceId, chatwootInboxId: liveInboxId },
      select: { agentId: true, chatwootInboxId: true },
    }),
  );
}

export interface ReturnToAgentHolder {
  assigneeType: string | null;
  assigneeId: number | null;
}

export async function returnConversationToAgent(
  ctx: TenantContext,
  id: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
  // The holder this hand-back is FOR, when the caller already established one (/reset reads it and
  // decides first, and somebody else can arrive in between). Reading the baseline here would adopt
  // the newcomer. The console and MCP omit it; omitting it can only ever refuse to unassign somebody.
  expectedHolder?: ReturnToAgentHolder,
): Promise<ReturnToAgentOutcome> {
  const tenantId = requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  // The responder is asked once, late, against the inbox Chatwoot names (a transfer webhook
  // may not have landed). Operator-initiated, so the instance admin token (audit shows the operator).
  const client = await loadChatwootClient(tenantId, conv.chatwootInstanceId, {
    ...deps,
    base,
  });
  // The BASELINE, read live and BEFORE the status call: "who held it when this request started"
  // is what a takeover is measured against, and the mirror may lag a late or lost assignment webhook.
  // An unreadable baseline falls back to the mirror; it is not evidence that nobody was there.
  const readHolder = (): Promise<LiveConversationState | null> =>
    readLiveBeforeConsoleWrite(client, conv.chatwootConversationId);
  // Taken before the toggle and unconditionally (even when `expectedHolder` spares the
  // baseline), since it is also the mark: it must name a message that existed when the operator
  // clicked, or the takeover's fence would skip a colleague's reply typed during the round trip.
  const before = await readHolder();
  const baseline = expectedHolder ??
    (before === null
      ? null
      : {
          assigneeType: before.assigneeType,
          assigneeId: before.assigneeId,
        }) ?? {
      assigneeType: conv.assigneeType,
      assigneeId: conv.assigneeId,
    };
  // The binding is re-read here, past the awaits above, off the inbox Chatwoot names (the
  // mirror may still name the one it LEFT; null for an inbox this runtime does not serve), UNDER the
  // inbox row's `FOR NO KEY UPDATE` lock that `persistBinding` takes, so an unbind in flight commits
  // before this read or after the hand-back. The lock is released before the Chatwoot write. The full
  // sequence is in docs/chatwoot.md ("Nothing to hand back to").
  const relocated = before?.inboxId ?? null;
  const nowInbox = await runScopedOn(base, ctx, async (db) => {
    // The inbox NUMBER as well as the agent: the live attachment below has to be read on the
    // inbox the conversation is on now.
    const targetId =
      relocated === null
        ? ((
            await db.conversation.findUnique({
              where: { id },
              select: { inboxId: true },
            })
          )?.inboxId ?? null)
        : ((
            await db.inbox.findFirst({
              where: {
                chatwootInstanceId: conv.chatwootInstanceId,
                chatwootInboxId: relocated,
              },
              select: { id: true },
            })
          )?.id ?? null);
    if (targetId === null) return null;
    // Locked and then RE-READ under the lock, in that order: the row resolved above was read outside
    // it, so an unbind committing in between would be invisible to a caller that trusted the first
    // reading. The lock is on the inbox the hand-back is judged against, which is the row
    // `persistBinding` takes for that same inbox.
    await db.$queryRaw`SELECT id FROM inboxes WHERE id = ${targetId} FOR NO KEY UPDATE`;
    return db.inbox.findUnique({
      where: { id: targetId },
      // NOTE: `id` as well, because the mirror's own `inboxId` is corrected from it after the write.
      select: { id: true, agentId: true, chatwootInboxId: true },
    });
  });
  const liveInbox = relocated === null ? (nowInbox ?? conv.inbox) : nowInbox;
  await requireLiveAttachment(
    ctx,
    {
      chatwootInstanceId: conv.chatwootInstanceId,
      chatwootInboxId: liveInbox?.chatwootInboxId ?? null,
      agentId: liveInbox?.agentId ?? null,
    },
    client,
    base,
    id,
  );
  // One last look at which inbox it is on, after every probe and immediately before the write:
  // a transfer landing meanwhile REFUSES (the next click is judged on the right inbox) rather than
  // looping. Fails open. Compared against the number the hand-back was JUDGED ON, not the row it
  // resolved to. A transfer between this read and the toggle still wins: Chatwoot has no conditional
  // status write, and a lock here would be held across somebody else's network.
  const judgedInboxId =
    relocated ??
    liveInbox?.chatwootInboxId ??
    conv.inbox?.chatwootInboxId ??
    null;
  const atWrite = await readHolder();
  if (
    atWrite !== null &&
    atWrite.inboxId !== null &&
    judgedInboxId !== null &&
    atWrite.inboxId !== judgedInboxId
  ) {
    throw new ConflictError(
      "This conversation moved to another inbox while it was being returned; try again.",
      "errors.returnConversationMoved",
    );
  }
  // NOTE: the responder's local state, asked last, after both GETs: an agent switched off, flipped
  // to monitoring, swapped or with a broken credential while those were on the wire would otherwise
  // be invisible, and the hand-back would remove the human for an agent that will not answer.
  await requireAnsweringResponder(
    ctx,
    liveInbox,
    conv.chatwootInstanceId,
    base,
    {
      conversationId: conv.chatwootConversationId,
      threadId: conv.threadId,
      testActivatedAt: conv.testActivatedAt,
      contactId: conv.contactId,
      chatwootInboxId: liveInbox?.chatwootInboxId ?? null,
    },
  );
  // The binding itself is re-read LAST of all, after the runnable probe (the longest await
  // left), under the same row lock: a rebind in that window would leave the validation judging the
  // agent that was there before. It refuses rather than re-validating, like the move confirmation.
  const boundNow = await runScopedOn(base, ctx, async (db) => {
    if (nowInbox === null) return null;
    await db.$queryRaw`SELECT id FROM inboxes WHERE chatwoot_instance_id = ${conv.chatwootInstanceId} AND chatwoot_inbox_id = ${nowInbox.chatwootInboxId} FOR NO KEY UPDATE`;
    return db.inbox.findFirst({
      where: {
        chatwootInstanceId: conv.chatwootInstanceId,
        chatwootInboxId: nowInbox.chatwootInboxId,
      },
      select: { agentId: true },
    });
  });
  if (
    nowInbox !== null &&
    (boundNow?.agentId ?? null) !== (liveInbox?.agentId ?? null)
  ) {
    throw new ConflictError(
      "The responder of this inbox changed while the conversation was being returned; try again.",
      "errors.returnResponderChanged",
    );
  }
  // The bot of the inbox the hand-back was judged on. Chatwoot clears the bot assignee whenever a
  // person takes the conversation, so removing the person alone leaves it in "Unassigned" while the
  // agent answers it; the hand-back assigns this bot instead (docs/chatwoot.md, next to the unassign note).
  // Read before the first remote write, so a failed read changes nothing in Chatwoot.
  const ourAgentBotId =
    liveInbox?.agentId != null
      ? ((
          await runScopedOn(base, ctx, (db) =>
            db.chatwootAgentBot.findFirst({
              where: {
                tenantId,
                chatwootInstanceId: conv.chatwootInstanceId,
                agentId: liveInbox?.agentId ?? 0n,
              },
              select: { chatwootAgentBotId: true },
            }),
          )
        )?.chatwootAgentBotId ?? null)
      : null;
  await client.toggleStatus(conv.chatwootConversationId, "pending", {
    asAdmin: true,
  });
  // NOTE: the mirror learns where the conversation is: the reconcile below never touches `inboxId`,
  // and a stale row sends "Respond now" through the ORIGIN inbox's persona. Compare-and-set on the
  // inbox we believed we were leaving, so a webhook that landed the move wins; best-effort, since
  // the hand-back has already happened.
  if (
    nowInbox !== null &&
    relocated !== null &&
    conv.inbox !== null &&
    nowInbox.chatwootInboxId !== conv.inbox.chatwootInboxId
  ) {
    try {
      await runScopedOn(base, ctx, (db) =>
        db.conversation.updateMany({
          where: { id, inboxId: conv.inbox?.id },
          data: { inboxId: nowInbox.id },
        }),
      );
    } catch (err) {
      logger.warn(
        { err },
        `conversations: the hand-back could not record the conversation's new inbox (conv=${String(id)})`,
      );
    }
  }
  // Unreadable is NOT "nobody took it": a degraded payload with the holder unchanged is the common
  // case, and refusing to hand back on it would leave the conversation with a human who has already
  // walked away. The live read is the improvement over an unconditional unassign, not a new gate.
  const live = await readHolder();
  // A holder other than the baseline, by the whole identity ("User" and "AgentBot" are
  // separate id namespaces). An EMPTY assignee is not a competing holder; a typed holder with no id
  // is (unknown is not absent, so it fails closed). Written once because a live read after the
  // unassign can still name the party just removed, and only the baseline tells them apart.
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
  const alreadyOurs =
    live !== null &&
    ourAgentBotId !== null &&
    live.assigneeType === "AgentBot" &&
    live.assigneeId === ourAgentBotId;
  // An EMPTY read still assigns the bot, since an empty assignee is exactly the state being fixed.
  // Without a bot assignment, nobody to remove means no request: unassigning an already unassigned
  // conversation changes nothing and could only land after somebody claimed it in the round trip
  // (Chatwoot has no conditional assignment). An unreadable read still writes.
  const nobodyToRemove = live !== null && live.assigneeType === null;
  let handedToBot = alreadyOurs;
  if (newHolder === null && !alreadyOurs) {
    try {
      if (ourAgentBotId !== null) {
        handedToBot = await client.assignAgentBot(
          conv.chatwootConversationId,
          ourAgentBotId,
          { asAdmin: true },
        );
      }
      // NOTE: an assignment that came back without the bot may have named a USER with that id (a
      // Chatwoot that ignores `assignee_type`), so the unassign follows it even onto an empty read.
      if (!handedToBot && (ourAgentBotId !== null || !nobodyToRemove)) {
        await client.unassignConversation(conv.chatwootConversationId, {
          asAdmin: true,
        });
      }
    } catch (err) {
      // NOTE: THE PARTIAL THIS FUNCTION'S OWN ORDERING CHOOSES. The status went to pending and the human
      // is still holding the conversation, which is the recoverable half of the pair (the comment on
      // the ordering above says why it is the one to fail into). Recoverable is not invisible: the
      // status of a live conversation moved, and the row is what says so.
      await recordConversationAction(ctx, base, id, {
        action: "conversation.return",
        before: {
          status: conv.status,
          assigneeType: baseline.assigneeType,
          assigneeId: baseline.assigneeId,
        },
        after: {
          status: "pending",
          assigneeType: baseline.assigneeType,
          assigneeId: baseline.assigneeId,
          partial: true,
        },
      });
      throw err;
    }
  } else if (newHolder !== null) {
    logger.info(
      "conversations: hand-back left the conversation with its new holder (conv=%d, %s=%s)",
      conv.chatwootConversationId,
      newHolder.assigneeType ?? "none",
      String(newHolder.assigneeId ?? "none"),
    );
  }
  // From here the effect has happened, and the bookkeeping below can throw, so the row is
  // written in a `finally`. It carries what THIS CALL knows, not the baseline: the unassign ran, was
  // skipped because the conversation was free, or was withheld because somebody else holds it.
  const requestedHolder: {
    assigneeType: string | null;
    assigneeId: number | null;
  } =
    newHolder ??
    (handedToBot
      ? { assigneeType: "AgentBot", assigneeId: ourAgentBotId }
      : { assigneeType: null, assigneeId: null });
  let landedReturn: {
    status: string;
    assigneeType: string | null;
    assigneeId: number | null;
  } = { status: "pending", ...requestedHolder };
  let outcomeForRow: ReturnToAgentOutcome | null = null;
  try {
    const { state, observed } = await mirrorConsoleWrite(
      ctx,
      base,
      id,
      conv,
      client,
      { status: "pending", ...requestedHolder },
      consoleWriteMark(before),
    );
    // Who the mirror ends up naming, resolved once for the event and the return. `state` (a
    // versioned reconcile) wins; then `observed`, the unversioned read taken AFTER the unassign (a
    // Chatwoot older than 4.0.2 sends no `updated_at`), the only look that sees a human who claimed
    // it meanwhile (`newHolder` was read before); then `newHolder`, right when that read failed and
    // the mirror already wrote the same holder.
    const finalHolder = state
      ? { assigneeType: state.assigneeType, assigneeId: state.assigneeId }
      : (holderOtherThan(observed) ?? requestedHolder);
    // NOTE: The row's `after` takes it HERE, the moment it is known, and not at the end: everything
    // below (the mirror's fallback write, the broadcast, the ownership read that names the outcome)
    // can throw, and the `finally` would then fall back to the pre-unassign reading and lose the
    // holder this call actually found.
    landedReturn = {
      status: state?.status ?? "pending",
      assigneeType: finalHolder.assigneeType,
      assigneeId: finalHolder.assigneeId,
    };
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
    // "taken over" is an outcome, not a failure: the status was set and only the unassign was
    // withheld. Read off the value the console just received, with the OWNERSHIP rule against the
    // RESOLVED inbox's bot: the destination's own bot holding it is the success state. A holder whose
    // id never arrived still counts for `User`, while an unidentifiable AgentBot stays uncounted.
    const outcome: ReturnToAgentOutcome = heldByAnotherParty(finalHolder, {
      ourAgentBotId,
    })
      ? "taken-over"
      : "returned";
    // NOTE: The OUTCOME is on the row, because it is the one action of this family whose success is not the
    // thing the caller asked for: `taken-over` means the status went to pending and the human stayed,
    // and a row that only said "returned to the agent" would be the trail disagreeing with the console
    // that was told otherwise in the same instant.
    // NOTE: Same rule as the other two: the status is where the write LANDED, and the outcome is what the
    // caller was told. `taken-over` with a status that is not `pending` is the honest pair, and a row
    // that hard-coded `pending` would be the trail contradicting the console it answered.
    outcomeForRow = outcome;
    return outcome;
  } finally {
    // NOTE: THE HOLDER, on both sides, because on this action it is the whole mutation: a hand-back on a
    // conversation that is already pending moves nothing else, and a row carrying only the status
    // would say nothing happened. `baseline` is who held it when the call started, read live rather
    // than off the mirror, and `landedReturn` is where the write ended up.
    await recordConversationAction(ctx, base, id, {
      action: "conversation.return",
      before: {
        status: conv.status,
        assigneeType: baseline.assigneeType,
        assigneeId: baseline.assigneeId,
      },
      after: {
        ...landedReturn,
        ...(outcomeForRow !== null ? { outcome: outcomeForRow } : {}),
      },
    });
  }
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
  // The reading that orders an unversioned write, taken BEFORE the toggle as the hand-back
  // does: a press of `pending` on a bot-owned `open` conversation gives it back to the agent, and a
  // delivery serialized before the press could reopen it. The mirror's own read is post-write, so it
  // cannot serve. A failed read stamps nothing.
  const before = await readLiveBeforeConsoleWrite(
    client,
    conv.chatwootConversationId,
  );
  await client.toggleStatus(conv.chatwootConversationId, status, {
    asAdmin: true,
  });
  // NOTE: an operator closing a conversation is not the agent resolving it, and status + assignee
  // cannot tell them apart, so it is recorded (keeping it out of the Resolution funnel). BEFORE the
  // mirror write: the recorder stamps only a row not already resolved, and the mirror write is what
  // resolves it; reading the pre-toggle row also makes a re-resolve record nothing.
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
  // The toggle has landed in Chatwoot; the rest is our own bookkeeping and can throw. Same seam as
  // the handoff: the row goes in a `finally`, carrying the reconciled status when the mirror got
  // there and the accepted one when it did not.
  let landedStatus = status as string;
  try {
    const { state } = await mirrorConsoleWrite(
      ctx,
      base,
      id,
      conv,
      client,
      { status },
      consoleWriteMark(before),
    );
    // NOTE: WHERE IT LANDED. A row carrying the status this call ASKED for would claim the operator left
    // the conversation resolved while the mirror and every open console say otherwise, which happens
    // whenever a webhook or another operator outranks the toggle inside `mirrorConsoleWrite`.
    landedStatus = state?.status ?? status;
    broadcastConversationEvent(tenantId, {
      conversationId: String(id),
      status: landedStatus,
      assigneeId: state ? state.assigneeId : conv.assigneeId,
      assigneeType: state ? state.assigneeType : conv.assigneeType,
      lastEventAt:
        (state ? state.lastEventAt : conv.lastEventAt)?.toISOString() ?? null,
    });
  } finally {
    await recordConversationAction(ctx, base, id, {
      action: "conversation.status",
      before: { status: conv.status },
      after: { status: landedStatus },
    });
  }
}
