// Chatwoot Agent Bot webhook payload shapes (the subset we consume) and our normalized event.
// Per the fork's EventDataPresenter#webhook_data and Message#webhook_data: conversation_* events
// carry the conversation fields at the TOP level; message_created/message_updated carry the message
// at top level with the conversation NESTED under `.conversation`. The conversation carries `id`
// (display_id, the per-account id the bot-token API uses), `status`, `inbox_id`, and
// `meta.{assignee, assignee_type}` ("User" for a human, "AgentBot" or null otherwise).

import type { AdditionalContactField } from "@/modules/chatwoot/contact-fields";
import type { UnreadFile } from "@/modules/vision/unread";

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
  // What a previous vision pass persisted on this attachment's meta (`image_description` /
  // `extracted_text`, fork write-back). Makes the eager vision pass idempotent per attachment: a
  // delivery recovery re-runs it, and reusing what is there is cheaper and keeps its aggregate complete.
  imageDescription?: string | null;
  extractedText?: string | null;
  // Location attachments (a WhatsApp pin) also ship their coordinates + human-readable place
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
  // When Chatwoot recorded this message: the only instant on the payload that answers "when did the
  // customer write" for the prompt's age variables (the conversation's `created_at` is when it opened,
  // and `last_inbound_at` is null on a conversation mirrored from a non-message event). `null` ⇒ the
  // payload carried no readable one, and the age renders empty.
  createdAt?: Date | null;
  attachments?: NormalizedChatwootAttachment[];
  // The id of the message this one quotes/replies-to (content_attributes.in_reply_to), so the agent
  // gets the referenced context. Resolved against the conversation history when available.
  inReplyTo?: number | null;
  // True when this message is an emoji reaction (content_attributes.is_reaction). `content` is the
  // emoji and `inReplyTo` points at the reacted-to message. Rendered as a context marker for the agent.
  isReaction?: boolean;
  // content_attributes.external_sender_name. The fork writes the literal "WhatsApp" on every OUTGOING
  // message that came back FROM the WhatsApp session rather than out of Chatwoot — all four session
  // paths do it (baileys, zapi, the session inbound writer, the reaction store). It is the only field
  // in the payload that separates an attendant replying on the paired phone from the other three
  // shapes of sender-less outgoing message Chatwoot itself produces (see isDeviceAttendantMessage).
  externalSenderName?: string | null;
  // The email's Subject header, from `content_attributes.email.subject`. Only a mailbox writes that
  // bag, so its presence is the channel gate. Null on every other channel.
  emailSubject?: string | null;
  // Chatwoot blob URLs of the images a mailbox kept inside the email body instead of attaching them.
  // Empty on every other channel.
  emailBodyImages?: string[];
  // content_attributes.imported. Set by the history importer on a backfilled row.
  imported?: boolean;
  // content_attributes.external_error: what the CHANNEL said when it failed to deliver this message,
  // e.g. `"131053: Media upload error"` on WhatsApp Cloud. Chatwoot writes it only when
  // the status becomes `failed` and clears it on every other transition, so its presence IS the
  // failure signal (`status` itself is not in the webhook payload). Null when absent or empty.
  externalError?: string | null;
  // content_attributes.fazer_ai_reply_text: the whole reply an audio reply of ours was cut from, when
  // the speech left something out. Null everywhere else.
  replyText?: string | null;
  // content_attributes.fazer_ai_reply_by_operator: that voice note's words are the operator's.
  replyByOperator?: boolean;
  // Filled by the eager STT pass (NOT from the payload): the audio transcription, used by the direct
  // (no-debounce) path. The debounce flush instead reads it back from the attachment meta on re-fetch.
  transcribedText?: string | null;
  // Filled by the eager vision pass (NOT from the payload): image/document extraction for the direct
  // path. The debounce flush reads these back from the attachment meta on re-fetch.
  imageDescription?: string | null;
  extractedText?: string | null;
  // How many attachments the eager vision pass did not open (over the per-message cap). The
  // renderer turns it into the marker that tells the model files are missing, so it must reach the
  // flush as well as the direct path — it rides the annotation store, not the payload.
  attachmentsUnread?: number | null;
  // Which of those files the pass tried, with the name and why each was not read.
  unreadFiles?: UnreadFile[] | null;
  // Filled by the eager vision pass: it went through the email body's images, so the second call
  // site of this delivery does not download them again.
  bodyRead?: boolean;
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
// was removed asks about its previous holder.
export interface NormalizedChatwootContact {
  id: number | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  // The operator's own customer id, stamped on the Chatwoot contact.
  identifier?: string | null;
  // meta.sender.custom_attributes: Contact#push_event_data ships the whole jsonb on every event, so
  // the agent reads it with no extra API call. `undefined` = the payload
  // did not carry it ⇒ the mirror keeps whatever it had (never wiped by a degraded payload).
  customAttributes?: Record<string, unknown>;
  // The four `additional_attributes` keys the agent may see (contact-fields.ts), each a string or
  // null when the bag lacks it. `undefined` = the payload carried no `additional_attributes` at all,
  // and the mirror keeps what it had.
  additionalAttributes?: Partial<Record<AdditionalContactField, string | null>>;
}

export interface NormalizedChatwootEvent {
  event: string;
  // conversation display_id (per-account) — the id the bot-token API uses, NOT the global PK.
  // null whenever the event's body is not a conversation and embeds none: the two allowlists in
  // normalize.ts keep that promise.
  conversationId: number | null;
  // The native Chatwoot ContactInbox id (conversation.contact_inbox.id). Present on every event the
  // fork emits (EventDataPresenter#push_data embeds the raw contact_inbox association). Keys the
  // agent's per-contact-inbox graph memory thread; mirrored onto Conversation.contactInboxId.
  contactInboxId: number | null;
  inboxId: number | null;
  status: string | null;
  // The assignee trio uses `undefined` as "this payload said nothing" (no `meta`), so the
  // mirror keeps the stored values instead of wiping them — same convention as the attribute bags.
  // An explicit `null` means meta WAS present with no assignee: a real unassign, and it clears.
  assigneeType?: string | null;
  assigneeId?: number | null;
  // Display name of the assignee (meta.assignee.name): the human's name for a User assignee, the
  // bot's name for an AgentBot one.
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
  // The CONVERSATION row's `updated_at` as unix seconds with fraction (push_timestamps sends
  // `updated_at.to_f`, upstream since Chatwoot 4.0.2). It is the version stamp of the state this
  // payload describes: unlike last_activity_at it advances on a status or assignee change and has
  // sub-second resolution, so it, not last_activity_at, orders conversation-level state.
  // `null` on a Chatwoot too old to send it.
  conversationUpdatedAt?: number | null;
  // Chatwoot's own first-response SLA (`Conversations::EventDataPresenter`): `created_at`, and
  // `first_reply_created_at`, the first message passing `Message#valid_first_reply?` (the predicate
  // this codebase spells `isNewHumanAgentMessage`). Mirrored rather than derived: Chatwoot computes both
  // from its messages table, independent of webhook order and of the mirror's age, never revised once
  // set. On a business-opened conversation it marks that opening message; timing the customer's wait
  // would anchor on `waiting_since`, which Chatwoot clears when the reply goes out: a different metric,
  // and a product decision rather than a translation. `undefined`/`null`: not carried, the mirror keeps.
  conversationCreatedAt?: Date | null;
  firstReplyCreatedAt?: Date | null;
  // The CONVERSATION's custom attributes (conversation.custom_attributes on EventDataPresenter
  // push_data). Mirrored for the agent's attribute context. `undefined` ⇒ absent from this payload.
  customAttributes?: Record<string, unknown>;
  // The conversation's label titles (push_data.labels, the conversation's `label_list`), as Chatwoot
  // stated them. Mirrored for the dashboard's outcome-by-label view and the contact gate's `label`
  // condition (which compares ignoring case). `undefined` ⇒ absent from this payload; `[]` ⇒ no labels.
  labels?: string[];
  // The linked kanban CARD's custom attributes (conversation.kanban_task.custom_attributes — the Pro
  // fork's FazerAi::Conversations::EventDataPresenter adds `kanban_task` to push_data, and
  // Kanban::Task#common_event_data carries `custom_attributes`). `undefined` ⇒ absent (upstream
  // Chatwoot, or a conversation with no card).
  kanbanAttributes?: Record<string, unknown>;
  // The fork's `conversation.group_type`. `undefined` ⇒ the payload said nothing (the mirror keeps
  // what it has).
  conversationType?: "group" | "individual";
  // Set only by a recovery's rebuilt body: the four facts above are for the row it creates, and
  // never update an existing one (a webhook may have created it since the recovery's read).
  factsOnCreateOnly?: true;
  // Set only by the same body: its live reading's activity. A row it CREATES is stamped with at least
  // this, so the facts above are not older than the row's own order, and the contact identity it
  // states is positioned at it. Never moves an existing conversation row.
  createActivityAt?: number;
  // The WhatsApp entry conversation this widget thread was redirected FROM, as its display_id
  // (conversation.redirect_origin_display_id, written by the fork's token resolve). A number is the
  // pairing. `null` states there is none (the fork clears it when a re-entry's token names no origin),
  // and must reach the row so the consumer stops acting on the old pairing. `undefined` means the
  // payload said nothing (a Chatwoot whose fork does not send the field), and reading it as a clear
  // would wipe every episode's pairing on the first ordinary message.
  redirectOriginDisplayId?: number | null;
}
