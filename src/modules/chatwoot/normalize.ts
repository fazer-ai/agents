import type { RenderableLocation } from "./render";
import type {
  NormalizedChatwootAttachment,
  NormalizedChatwootEvent,
} from "./types";

// Pure normalization of an (untrusted) Chatwoot Agent Bot webhook payload into the fields we
// act on, tolerant of the two payload shapes. No DB, no network — the receiver verifies HMAC,
// resolves the tenant, and applies idempotency around this.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// NOTE: Coordinates arrive as JSON floats (possibly negative) — num() deliberately rejects those
// (it parses ids). Numbers only: the fork's serializer never sends coordinates as strings.
function float(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// NOTE: undefined means "this payload said nothing", so the mirror keeps the stored bag instead of
// wiping it; `{}` is a real "no attributes" and DOES clear it.
function attrs(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined;
}

export function normalizeChatwootEvent(
  payload: unknown,
): NormalizedChatwootEvent | null {
  if (!isRecord(payload)) return null;
  const event = str(payload.event);
  if (!event) return null;

  const isMessage = event === "message_created" || event === "message_updated";
  const conv = isMessage
    ? isRecord(payload.conversation)
      ? payload.conversation
      : null
    : payload;
  const meta = conv && isRecord(conv.meta) ? conv.meta : null;
  const assignee = meta && isRecord(meta.assignee) ? meta.assignee : null;
  const sender = meta && isRecord(meta.sender) ? meta.sender : null;
  // contact_inbox ships as the full association object (EventDataPresenter#push_data → contact_inbox);
  // tolerate a flat contact_inbox_id scalar too. Same on both shapes (conv = payload | payload.conversation).
  const contactInbox =
    conv && isRecord(conv.contact_inbox) ? conv.contact_inbox : null;

  const normalized: NormalizedChatwootEvent = {
    event,
    conversationId: conv ? num(conv.id) : null,
    contactInboxId: contactInbox
      ? num(contactInbox.id)
      : conv
        ? num(conv.contact_inbox_id)
        : null,
    inboxId: conv ? num(conv.inbox_id) : null,
    status: conv ? str(conv.status) : null,
    // NOTE: No meta ⇒ undefined ("said nothing", the mirror preserves); meta without an assignee ⇒
    // explicit null (a real unassign). Mirrors the attrs() sentinel above.
    assigneeType: meta ? str(meta.assignee_type) : undefined,
    assigneeId: meta ? (assignee ? num(assignee.id) : null) : undefined,
    assigneeName: meta ? (assignee ? str(assignee.name) : null) : undefined,
  };

  if (isMessage) {
    const ca = isRecord(payload.content_attributes)
      ? payload.content_attributes
      : null;
    // The MESSAGE's own author (payload.sender), distinct from the conversation contact (meta.sender).
    const msgSender = isRecord(payload.sender) ? payload.sender : null;
    normalized.message = {
      id: num(payload.id),
      content: str(payload.content),
      messageType: str(payload.message_type),
      private: payload.private === true,
      sender: msgSender
        ? {
            type: str(msgSender.type),
            id: num(msgSender.id),
            name: str(msgSender.name),
          }
        : null,
      attachments: Array.isArray(payload.attachments)
        ? payload.attachments.filter(isRecord).map((a) => ({
            id: num(a.id),
            fileType: str(a.file_type),
            dataUrl: str(a.data_url),
            // Audio attachments ship `transcribed_text` (empty until our write-back lands); empty
            // string normalizes to null so callers can treat "no transcription" uniformly.
            transcribedText: str(a.transcribed_text) || null,
            // NOTE: Location attachments ship coordinates + place name (location_metadata);
            // null-ish on every other file_type.
            latitude: float(a.coordinates_lat),
            longitude: float(a.coordinates_long),
            fallbackTitle: str(a.fallback_title) || null,
          }))
        : undefined,
      inReplyTo: ca ? num(ca.in_reply_to) : null,
      // A reaction (WhatsApp emoji react) arrives as a message with content_attributes.is_reaction.
      // The content is the emoji; in_reply_to points at the message it reacts to.
      isReaction: ca?.is_reaction === true,
    };
  }
  if ("changed_attributes" in payload) {
    normalized.changedAttributes = payload.changed_attributes;
  }

  // ── mirror metadata (best-effort) ──
  // Contact: conversation events carry it at meta.sender (EventDataPresenter push_meta).
  if (sender) {
    const contactAttrs = attrs(sender.custom_attributes);
    normalized.contact = {
      id: num(sender.id),
      name: str(sender.name),
      email: str(sender.email),
      phone: str(sender.phone_number),
      identifier: str(sender.identifier),
      ...(contactAttrs ? { customAttributes: contactAttrs } : {}),
    };
  }
  // Conversation + kanban-card custom attributes ride along on every event (push_data.custom_attributes
  // and the fork's push_data.kanban_task), so the agent's attribute context needs NO extra API call.
  const convAttrs = conv ? attrs(conv.custom_attributes) : undefined;
  if (convAttrs) normalized.customAttributes = convAttrs;
  const kanbanTask =
    conv && isRecord(conv.kanban_task) ? conv.kanban_task : null;
  const taskAttrs = kanbanTask
    ? attrs(kanbanTask.custom_attributes)
    : undefined;
  if (taskAttrs) normalized.kanbanAttributes = taskAttrs;
  // Inbox name only ships on message events (Message#webhook_data → inbox: {id, name}).
  const inboxObj = isMessage && isRecord(payload.inbox) ? payload.inbox : null;
  normalized.inboxName = inboxObj ? str(inboxObj.name) : null;
  // `channel` (channel_type) is exposed by EventDataPresenter on conversation events.
  normalized.channel = conv ? str(conv.channel) : null;
  normalized.lastActivityAt = conv ? num(conv.last_activity_at) : null;
  // NOTE: float() and not num() — `updated_at` ships as `to_f`, so it carries a fraction, and num()
  // parses ids (its string branch is integers only).
  normalized.conversationUpdatedAt = conv ? float(conv.updated_at) : null;
  return normalized;
}

// NOTE: Minimal parse of a LIVE conversation payload (GET /conversations/:id — the REST show shape;
// same field positions as the conversation-event payloads: `status` at the top, `meta.assignee_type`,
// `meta.assignee.{id,name}`, `id` = display_id). Null when the payload does not look like a
// conversation — a missing `status` is treated as unparseable (the caller must fail closed and retry,
// never conclude "not bot-owned" from a degraded payload). Feeds the proactive-send live gate: the
// mirror can be stale forever (a lost resolve webhook has no reconciliation), so anything about to
// message a customer proactively re-checks this.
export interface LiveConversationState {
  status: string;
  assigneeType: string | null;
  assigneeId: number | null;
  assigneeName: string | null;
  // NOTE: The conversation's last_activity_at (REST show renders it both as `last_activity_at` and
  // `timestamp`, epoch seconds). Lets the live-probe reconcile compare freshness against the
  // mirror's monotonic lastEventAt. null when the payload omits both.
  lastActivityAt: Date | null;
  // NOTE: The conversation's own version, the same `updated_at.to_f` the webhook carries — the REST
  // show renders it too (`api/v1/conversations/partials/_conversation.json.jbuilder`). A reconcile
  // that wrote newer state without it would leave the row ahead of its own marks, and the next
  // delayed conversation event would look newer than them. null on a Chatwoot too old to send it.
  updatedAt: number | null;
}

export function parseLiveConversation(
  raw: unknown,
): LiveConversationState | null {
  if (!isRecord(raw)) return null;
  if (num(raw.id) === null) return null;
  const status = str(raw.status);
  if (status === null) return null;
  const meta = isRecord(raw.meta) ? raw.meta : null;
  const assignee = meta && isRecord(meta.assignee) ? meta.assignee : null;
  const assigneeType = meta ? str(meta.assignee_type) : null;
  const assigneeId = assignee ? num(assignee.id) : null;
  // NOTE: An "AgentBot" claim without a readable numeric id is unverifiable ownership — with a null
  // assigneeId, shouldBotHandle would treat a conversation owned by ANOTHER bot as ours. The fork's
  // jbuilder always renders meta.assignee (agent_bot_slim, with id) alongside assignee_type
  // "AgentBot", so this only rejects genuinely malformed payloads. Fail closed: the live gate turns
  // null into "live-unavailable" and retries.
  if (assigneeType === "AgentBot" && assigneeId === null) return null;
  const activitySec = num(raw.last_activity_at) ?? num(raw.timestamp);
  return {
    status,
    assigneeType,
    assigneeId,
    assigneeName: assignee ? str(assignee.name) : null,
    lastActivityAt: activitySec !== null ? new Date(activitySec * 1000) : null,
    updatedAt: num(raw.updated_at),
  };
}

// Attribution = source of truth. The bot owns a conversation only while NO human is assigned
// (assignee_type !== "User") and it is still pending. A human assignee (handoff) or a
// resolved/snoozed/open status means fazer.ai agents stays silent. The gate is OUR responsibility:
// Chatwoot delivers the event to the bot even when a human is assigned.
//
// One Agent Bot can front many inboxes, and Chatwoot also delivers an event to a conversation's
// `assignee_agent_bot` (agent_bot_listener.rb) — so with multiple bots our endpoint may receive
// events for a conversation OWNED by a DIFFERENT bot. When `ourAgentBotId` is provided we act
// only if the conversation is unassigned (assignee_type null) or assigned to OUR bot, never to
// another AgentBot. Omitting the option preserves the loose attribution-only gate.
export function shouldBotHandle(
  e: {
    assigneeType: string | null;
    status: string | null;
    assigneeId?: number | null;
  },
  opts: { ourAgentBotId?: number | null } = {},
): boolean {
  if (e.status !== "pending") return false;
  if (e.assigneeType === "User") return false;
  if (
    e.assigneeType === "AgentBot" &&
    opts.ourAgentBotId != null &&
    e.assigneeId != null &&
    e.assigneeId !== opts.ourAgentBotId
  ) {
    return false;
  }
  return true;
}

export function isIncomingMessage(e: NormalizedChatwootEvent): boolean {
  return e.message?.messageType === "incoming" && e.message.private !== true;
}

// A BRAND-NEW incoming customer message (message_created), as opposed to a message_updated of an
// existing one. Only these may drive the agent (STT, debounce, turn). Our own STT/vision write-back
// PATCHes the attachment meta, which touches the message and makes the fork re-dispatch a
// message_updated to the bot (Message#dispatch_update_event fires on any non-blank change). If a
// message_updated re-triggered STT/debounce/turn, that write-back → update → reprocess cycle would
// loop forever (the voice-note infinite loop). The media is present at creation (baileys attaches
// it before the single `save!`), so gating on message_created loses nothing.
export function isNewIncomingMessage(e: NormalizedChatwootEvent): boolean {
  return e.event === "message_created" && isIncomingMessage(e);
}

// The control commands an operator types into the conversation to drive the agent (matched on the
// trimmed, case-insensitive text content — text-only by design). `/teste` activates a test agent for
// THIS conversation; `/reset` clears its memory/state. Both are handled by the webhook gate.
export type ControlCommand = "teste" | "reset";

export function controlCommand(
  e: NormalizedChatwootEvent,
): ControlCommand | null {
  const lc = (e.message?.content ?? "").trim().toLowerCase();
  if (lc === "/teste") return "teste";
  if (lc === "/reset") return "reset";
  return null;
}

// True when the message is a control command. Such a message is NOT genuine customer engagement, so
// it must not advance the follow-up / 24h-window inbound watermark (`lastInboundAt`) — otherwise a
// bare `/teste` or `/reset` would look like a fresh customer reply and arm a proactive follow-up.
export function isCommandMessage(e: NormalizedChatwootEvent): boolean {
  return controlCommand(e) !== null;
}

// The first audio attachment on the event's message (with a usable id + url), or null. Drives the
// eager STT pass: an audio voice note has no text content, so it must be transcribed before the turn.
export function firstAudioAttachment(e: NormalizedChatwootEvent): {
  id: number;
  dataUrl: string;
  // The transcription already stored on the attachment (from a prior write-back), or null. Lets the
  // eager STT pass be idempotent: a re-delivered audio message is reused, never re-transcribed.
  transcribedText: string | null;
} | null {
  for (const a of e.message?.attachments ?? []) {
    if (a.fileType === "audio" && a.id !== null && a.dataUrl) {
      return {
        id: a.id,
        dataUrl: a.dataUrl,
        transcribedText: a.transcribedText ?? null,
      };
    }
  }
  return null;
}

// NOTE: The first USABLE location attachment (a WhatsApp pin): real coordinates and/or a human
// title, or null. Chatwoot's coordinate columns default to 0.0, so an exact (0,0) — the null
// island — means the provider sent no coordinates, not a pin in the Gulf of Guinea; such a pin can
// still carry a usable fallback_title (place name + address). Neither ⇒ null, and the render falls
// back to the generic attachment marker. Shared by the direct webhook path and the debounce
// re-fetch (issue #45).
export function firstLocationAttachment(
  attachments:
    | Array<
        Pick<
          NormalizedChatwootAttachment,
          "fileType" | "latitude" | "longitude" | "fallbackTitle"
        >
      >
    | undefined,
): RenderableLocation | null {
  for (const a of attachments ?? []) {
    if (a.fileType !== "location") continue;
    const lat = a.latitude ?? null;
    const long = a.longitude ?? null;
    // NOTE: Out-of-range values (|lat| > 90, |long| > 180) are provider garbage, not coordinates —
    // they would flow into tool args. Same fail-safe as (0,0): drop the coords, keep the title.
    const hasCoords =
      lat !== null &&
      long !== null &&
      lat >= -90 &&
      lat <= 90 &&
      long >= -180 &&
      long <= 180 &&
      !(lat === 0 && long === 0);
    const title = a.fallbackTitle?.replace(/\s+/g, " ").trim() || null;
    if (hasCoords || title) {
      return {
        latitude: hasCoords ? lat : null,
        longitude: hasCoords ? long : null,
        title,
      };
    }
  }
  return null;
}

// The first image/file attachment (with a usable id + url), or null. Drives the eager vision pass:
// the downloaded mime decides image vs document vs unsupported (audio/video are handled elsewhere /
// skipped). file_type "image" and "file" cover photos and documents (e.g. PDFs).
export function firstVisualAttachment(e: NormalizedChatwootEvent): {
  id: number;
  dataUrl: string;
} | null {
  for (const a of e.message?.attachments ?? []) {
    if (
      (a.fileType === "image" || a.fileType === "file") &&
      a.id !== null &&
      a.dataUrl
    ) {
      return { id: a.id, dataUrl: a.dataUrl };
    }
  }
  return null;
}
