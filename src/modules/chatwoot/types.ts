// Chatwoot Agent Bot webhook payload shapes (the subset we consume) and our normalized event.
//
// Payload shape confirmed against the chatwoot-pro fork (EventDataPresenter#webhook_data,
// Message#webhook_data, AgentBotListener):
//   * conversation_* events: conversation fields are at the TOP level (conversation.webhook_data
//     merged with { event, changed_attributes }).
//   * message_created / message_updated: message fields at top level, the conversation NESTED
//     under `.conversation`.
// The conversation carries `id` (display_id — the per-account id used by the bot-token API),
// `status` (open|pending|resolved|snoozed), `inbox_id`, and `meta.{assignee, assignee_type}`
// where assignee_type is "User" for a human and "AgentBot" (or null) otherwise.

export type ChatwootStatus = "open" | "pending" | "resolved" | "snoozed";
export type ChatwootAssigneeType = "User" | "AgentBot" | "Team";
export type ChatwootMessageType =
  | "incoming"
  | "outgoing"
  | "activity"
  | "template";

// The Agent Bot events we act on. Others are accepted and ignored.
export const CHATWOOT_HANDLED_EVENTS = [
  "message_created",
  "message_updated",
  "conversation_created",
  "conversation_opened",
  "conversation_updated",
  "conversation_status_changed",
  "conversation_resolved",
] as const;

// A message attachment (from the webhook payload `message.attachments[]`). file_type is the
// Chatwoot bucket ("audio" | "image" | "file" | "video" | ...); data_url is the (host-served)
// file URL. Drives STT: an audio attachment is downloaded, transcribed (Whisper), and the
// transcription written back to Chatwoot so the debounce re-fetch reads it.
export interface NormalizedChatwootAttachment {
  id: number | null;
  fileType: string | null;
  dataUrl: string | null;
  // Audio attachments carry the fork's stored transcription IN the webhook payload
  // (Attachment#push_event_data → audio_metadata: `transcribed_text`). Empty on the original
  // message_created; populated once our STT write-back lands (which the fork re-dispatches as a
  // message_updated). Read to make eager STT idempotent and to render the transcription in the UI.
  transcribedText?: string | null;
}

export interface NormalizedChatwootMessage {
  id: number | null;
  content: string | null;
  messageType: string | null;
  private: boolean;
  attachments?: NormalizedChatwootAttachment[];
  // The id of the message this one quotes/replies-to (content_attributes.in_reply_to), so the agent
  // gets the referenced context. Resolved against the conversation history when available.
  inReplyTo?: number | null;
  // True when this message is an emoji reaction (content_attributes.is_reaction). `content` is the
  // emoji and `inReplyTo` points at the reacted-to message. Rendered as a context marker for the agent.
  isReaction?: boolean;
  // Filled by the eager STT pass (NOT from the payload): the audio transcription, used by the direct
  // (no-debounce) path. The debounce flush instead reads it back from the attachment meta on re-fetch.
  transcribedText?: string | null;
  // Filled by the eager vision pass (NOT from the payload): image/document extraction for the direct
  // path. The debounce flush reads these back from the attachment meta on re-fetch.
  imageDescription?: string | null;
  extractedText?: string | null;
  // The message author (message events only), from the payload `sender.webhook_data`. `type` is
  // "user" (a HUMAN agent), "agent_bot" (a bot — ours or another), or null/absent (the customer, on
  // incoming). Drives continuous ingestion: a human agent's outgoing reply is folded into the agent's
  // memory marked as such, our own bot's outgoing is skipped (already in the thread from the turn).
  sender?: {
    type: string | null;
    id: number | null;
    name: string | null;
  } | null;
}

// Mirror-relevant contact metadata (from conversation `meta.sender` / a message `sender`).
// This is the tenant's own data (RLS-fenced); fleet/read-API projections strip PII separately.
export interface NormalizedChatwootContact {
  id: number | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  identifier: string | null;
  // NOTE: meta.sender.custom_attributes — Contact#push_event_data ships the whole jsonb on every
  // event, which is what lets the agent READ it with no extra API call. `undefined` = the payload
  // did not carry it ⇒ the mirror keeps whatever it had (never wiped by a degraded payload).
  customAttributes?: Record<string, unknown>;
}

export interface NormalizedChatwootEvent {
  event: string;
  // conversation display_id (per-account) — the id the bot-token API uses, NOT the global PK.
  conversationId: number | null;
  // The native Chatwoot ContactInbox id (conversation.contact_inbox.id). Present on every event the
  // fork emits (EventDataPresenter#push_data embeds the raw contact_inbox association). Keys the
  // agent's per-contact-inbox graph memory thread; mirrored onto Conversation.contactInboxId.
  contactInboxId: number | null;
  inboxId: number | null;
  status: string | null;
  assigneeType: string | null;
  assigneeId: number | null;
  // Display name of the assignee (meta.assignee.name) — only meaningful for a human (User) assignee.
  assigneeName: string | null;
  message?: NormalizedChatwootMessage;
  changedAttributes?: unknown;
  // ── mirror metadata (best-effort; absent on payloads that do not carry it) ──
  contact?: NormalizedChatwootContact | null;
  inboxName?: string | null;
  channel?: string | null;
  // last_activity_at as unix SECONDS (EventDataPresenter push_timestamps); drives the
  // monotonic lastEventAt guard so out-of-order deliveries cannot regress mirror state.
  lastActivityAt?: number | null;
  // The CONVERSATION's custom attributes (conversation.custom_attributes on EventDataPresenter
  // push_data). Mirrored for the agent's attribute context. `undefined` ⇒ absent from this payload.
  customAttributes?: Record<string, unknown>;
  // The linked kanban CARD's custom attributes (conversation.kanban_task.custom_attributes — the Pro
  // fork's FazerAi::Conversations::EventDataPresenter adds `kanban_task` to push_data, and
  // Kanban::Task#common_event_data carries `custom_attributes`). `undefined` ⇒ absent (upstream
  // Chatwoot, or a conversation with no card).
  kanbanAttributes?: Record<string, unknown>;
}
