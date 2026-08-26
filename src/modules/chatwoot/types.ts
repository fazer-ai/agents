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
  // NOTE: Location attachments (a WhatsApp pin) also ship their coordinates + human-readable place
  // name in the payload (Attachment#push_event_data → location_metadata: coordinates_lat /
  // coordinates_long / fallback_title). The columns default to 0.0, so an exact (0,0) means "the
  // provider sent no coordinates", not a real pin (see firstLocationAttachment). Absent on every
  // other file_type.
  latitude?: number | null;
  longitude?: number | null;
  fallbackTitle?: string | null;
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
// The identity fields all follow the same three-state rule: the KEY's presence says whether this
// payload speaks about the field at all. `undefined` = it did not ⇒ keep what is stored, because a
// degraded payload must not wipe identity; `null` = Chatwoot CLEARED it ⇒ clear ours, because the
// authorization gate asks the endpoint about whoever these values name, and a phone kept after it
// was removed asks about the person who used to have it.
export interface NormalizedChatwootContact {
  id: number | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  // The operator's own customer id, stamped on the Chatwoot contact.
  identifier?: string | null;
  // NOTE: meta.sender.custom_attributes — Contact#push_event_data ships the whole jsonb on every
  // event, which is what lets the agent READ it with no extra API call. `undefined` = the payload
  // did not carry it ⇒ the mirror keeps whatever it had (never wiped by a degraded payload).
  customAttributes?: Record<string, unknown>;
}

export interface NormalizedChatwootEvent {
  event: string;
  // conversation display_id (per-account) — the id the bot-token API uses, NOT the global PK.
  // null whenever the event's body is not a conversation and embeds none: the two allowlists in
  // normalize.ts are where that promise is kept, and issue #257 is what happens without them.
  conversationId: number | null;
  // The native Chatwoot ContactInbox id (conversation.contact_inbox.id). Present on every event the
  // fork emits (EventDataPresenter#push_data embeds the raw contact_inbox association). Keys the
  // agent's per-contact-inbox graph memory thread; mirrored onto Conversation.contactInboxId.
  contactInboxId: number | null;
  inboxId: number | null;
  status: string | null;
  // NOTE: The assignee trio uses `undefined` as "this payload said nothing" (no `meta`), so the
  // mirror keeps the stored values instead of wiping them — same convention as the attribute bags.
  // An explicit `null` means meta WAS present with no assignee: a real unassign, and it clears.
  assigneeType?: string | null;
  assigneeId?: number | null;
  // NOTE: Display name of the assignee (meta.assignee.name) — the human's name for a User
  // assignee, the bot's name for an AgentBot one.
  assigneeName?: string | null;
  message?: NormalizedChatwootMessage;
  changedAttributes?: unknown;
  // ── mirror metadata (best-effort; absent on payloads that do not carry it) ──
  contact?: NormalizedChatwootContact | null;
  inboxName?: string | null;
  channel?: string | null;
  // last_activity_at as unix SECONDS (EventDataPresenter push_timestamps); drives the
  // monotonic lastEventAt guard so out-of-order deliveries cannot regress mirror state.
  lastActivityAt?: number | null;
  // NOTE: The CONVERSATION row's `updated_at` as unix seconds WITH FRACTION (push_timestamps sends
  // `updated_at.to_f`, upstream since Chatwoot 4.0.2). It is the version stamp of the state this
  // payload describes — unlike last_activity_at it advances on a status or assignee change, and it
  // has sub-second resolution — so it, not last_activity_at, orders conversation-level state.
  // `null` on a Chatwoot too old to send it.
  conversationUpdatedAt?: number | null;
  // ── the human half of an attendance, as CHATWOOT already measured it ──
  //
  // Chatwoot keeps a first-response SLA of its own and ships it on every conversation payload
  // (`Conversations::EventDataPresenter`): `created_at`, and `first_reply_created_at` — the moment
  // of the first message satisfying `Message#valid_first_reply?` (outgoing, not private, not a
  // reaction, sender outside `['AgentBot', 'Captain::Assistant']`, which is the same predicate this
  // codebase spells `isNewHumanAgentMessage`).
  //
  // Both are computed by Chatwoot FROM THE MESSAGES TABLE, which is what makes them worth mirroring
  // rather than deriving here: they do not depend on the order its webhooks reach us, they are
  // already correct for a conversation that predates our mirror, and neither is revised once set.
  // A retry that arrives late carries the same two values as the delivery it duplicates.
  //
  // NOTE on semantics: `first_reply_created_at` is Chatwoot's SLA field, so on a conversation the
  // BUSINESS opened it marks that opening message — the KPI built on it reports the operator's own
  // dashboard number, including that bias. Timing the customer's wait instead would mean anchoring
  // on `waiting_since`, which Chatwoot clears when the reply goes out; that is a different metric,
  // and a product decision rather than a translation.
  //
  // `undefined`/`null` ⇒ the payload did not carry it (a message event whose `conversation` is
  // absent, or a conversation with no qualifying reply yet) ⇒ the mirror keeps what it stored.
  conversationCreatedAt?: Date | null;
  firstReplyCreatedAt?: Date | null;
  // The CONVERSATION's custom attributes (conversation.custom_attributes on EventDataPresenter
  // push_data). Mirrored for the agent's attribute context. `undefined` ⇒ absent from this payload.
  customAttributes?: Record<string, unknown>;
  // The linked kanban CARD's custom attributes (conversation.kanban_task.custom_attributes — the Pro
  // fork's FazerAi::Conversations::EventDataPresenter adds `kanban_task` to push_data, and
  // Kanban::Task#common_event_data carries `custom_attributes`). `undefined` ⇒ absent (upstream
  // Chatwoot, or a conversation with no card).
  kanbanAttributes?: Record<string, unknown>;
  // The WhatsApp entry conversation this widget thread was redirected FROM, as its display_id
  // (conversation.redirect_origin_display_id, which the fork's token resolve writes at the one moment
  // the pairing is a fact).
  //
  // THREE states, and the difference between the last two is load-bearing:
  //   number    — this is the pairing.
  //   null      — the payload STATES there is none. The fork clears the pairing when a re-entry's
  //               token names no origin, and that clear has to reach the row: the consumer holding
  //               the previous pairing is the one that must stop acting on it.
  //   undefined — the payload said nothing, which is every event from a Chatwoot without
  //               fazer-ai/chatwoot#418. Reading it as a clear would wipe every episode's pairing on
  //               the first ordinary message (issue #222).
  redirectOriginDisplayId?: number | null;
}
