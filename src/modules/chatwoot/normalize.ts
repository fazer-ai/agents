import type { NormalizedChatwootEvent } from "./types";

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
    assigneeType: meta ? str(meta.assignee_type) : null,
    assigneeId: assignee ? num(assignee.id) : null,
    assigneeName: assignee ? str(assignee.name) : null,
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
  return normalized;
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

// True when a brand-new OUTGOING message was authored by a HUMAN agent (a Chatwoot User), as opposed
// to our bot, another bot, or the AI assistant (sender.type "agent_bot"/"Captain", or absent). Drives
// continuous ingestion: a human colleague's reply is folded into the agent's memory marked as such, so
// the bot understands what actually happened while it was silent. message_created only (an edit must
// not re-ingest); not a private note (operator-only, never part of the customer dialogue).
export function isHumanAgentMessage(e: NormalizedChatwootEvent): boolean {
  return (
    e.event === "message_created" &&
    e.message?.messageType === "outgoing" &&
    e.message?.private !== true &&
    e.message?.sender?.type === "user"
  );
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
