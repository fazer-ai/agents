import {
  ADDITIONAL_CONTACT_FIELDS,
  type AdditionalContactField,
} from "@/modules/chatwoot/contact-fields";
import { closedByTheAgentSide } from "@/modules/conversations/resolution-origin";
import {
  CHATWOOT_REPLY_BY_OPERATOR_KEY,
  CHATWOOT_REPLY_TEXT_KEY,
} from "./constants";
import { bodyImagesBesides, emailBodyImageUrlsFrom } from "./email-body-images";
import type { RenderableLocation, RenderableMessage } from "./render";
import type {
  NormalizedChatwootAttachment,
  NormalizedChatwootEvent,
} from "./types";

// Pure normalization of an (untrusted) Chatwoot Agent Bot webhook payload into the fields we
// act on, tolerant of the two payload shapes. No DB, no network: the receiver verifies HMAC,
// resolves the tenant, and applies idempotency around this.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

// What kind of message this is, in the ONE vocabulary the rest of the code compares against. It
// takes both spellings because Chatwoot's two serializers disagree: `Message#webhook_data` renders
// `message_type` as the string `"incoming"` (the webhook) and `Message#push_event_data` as the
// integer `0` (every REST read), and ./messages.ts reads REST bodies through this same function.
// Unknown input collapses to "other": the only readers ask `=== "incoming"` and `=== "outgoing"`,
// so a value neither matches already meant "neither".
export function messageTypeOf(
  v: unknown,
): "incoming" | "outgoing" | "activity" | "template" | "other" {
  // A string is coerced only when it IS the integer spelling. `Number("")` and `Number("  ")`
  // are both 0, so a bare coercion would classify a blank `message_type` as `incoming`, the one
  // class that drives an agent turn.
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^[0-9]+$/.test(v)
        ? Number(v)
        : NaN;
  if (n === 0) return "incoming";
  if (n === 1) return "outgoing";
  if (n === 2) return "activity";
  if (n === 3) return "template";
  if (v === "incoming") return "incoming";
  if (v === "outgoing") return "outgoing";
  if (v === "activity") return "activity";
  if (v === "template") return "template";
  return "other";
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// Coordinates arrive as JSON floats (possibly negative), which num() deliberately rejects (it
// parses ids). Numbers only: the fork's serializer never sends coordinates as strings.
function float(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// A Chatwoot timestamp, read in both spellings the same producer uses for one field: a message's
// `created_at` is ISO 8601 on the wire (`Message#webhook_data`) and epoch SECONDS over REST
// (`_message.json.jbuilder` renders `.to_i`); a conversation's `created_at` is seconds and its
// `first_reply_created_at` an ISO string. Anything that does not parse reads as absent, never as the
// epoch: seconds read as milliseconds would date every message in 1970. Exported because the
// message parser reads the same fields, and a second copy would be a second set of edge cases.
export function chatwootTimestamp(v: unknown): Date | null {
  // Every branch exits through here. `Number.isFinite` and `> 0` both pass for an epoch far
  // outside the range a Date can hold (1e20, or a digit string of the same size), and what comes
  // back is an Invalid Date, which Prisma refuses, failing the WHOLE delivery over an optional
  // field, and failing it again on every retry because the payload never changes. A reading this
  // cannot use has to read as absent, on the same terms as a field the payload never carried.
  const held = (d: Date): Date | null => (Number.isNaN(d.getTime()) ? null : d);
  if (typeof v === "number" && Number.isFinite(v))
    return v > 0 ? held(new Date(v * 1000)) : null;
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) {
      const sec = Number(v);
      return sec > 0 ? held(new Date(sec * 1000)) : null;
    }
    return held(new Date(v));
  }
  return null;
}

// undefined means "this payload said nothing", so the mirror keeps the stored bag instead of
// wiping it; `{}` is a real "no attributes" and DOES clear it.
function attrs(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined;
}

// Each event's body is its own SUBJECT, and every subject renders its table id under `id`:
// `Conversations::EventDataPresenter#push_data` puts the conversation's DISPLAY id there, while
// `Message`, `Contact`, `ContactInbox`, `Inbox` and the Kanban card put a primary key. Only the event
// name says which, hence two allowlists and no fallback: an unknown event identifies no conversation,
// because a foreign id on `conversationId` opens a SECOND mirror row, and a duplicate does not heal.

// Bodies that ARE a conversation (`conversation.webhook_data`). conversation_created reaches only an
// account webhook, never an agent bot, but its body is the same one and it costs nothing to name.
const CONVERSATION_BODY_EVENTS = new Set([
  "conversation_created",
  "conversation_opened",
  "conversation_resolved",
  "conversation_status_changed",
  "conversation_updated",
]);

// Bodies that are a MESSAGE (`Message#webhook_data`), carrying the conversation nested under
// `conversation`. Deliberately NOT the account webhook's message_incoming/message_outgoing: they are
// the same body redelivered under a second name, so accepting them would mirror each message twice
// and hand `isNewIncomingMessage` a class of event it has never seen.
const MESSAGE_BODY_EVENTS = new Set(["message_created", "message_updated"]);

// The ONE event name that can owe a customer an answer, named because two very different readers
// need the same answer and must not drift: `isNewIncomingMessage` below, which decides whether a
// live event drives a turn, and ./stranded-delivery.ts, which asks of a ledger row whether anything
// was ever owed on it. A `message_updated` is our own write-back coming around and drives nothing,
// which is why the two questions have one answer.
export const TURN_BEARING_EVENT = "message_created";

// THE OTHER EVENT THAT CAN OWE ONE, in one shape only. Our own STT write-back makes the fork
// re-dispatch the message as `message_updated`, which mostly owes nothing; but on a route where
// nothing ran the turn at creation (audio not audible yet, an observer with no responder), the
// transcription on the UPDATE is the only readable form the message takes. A ledger row keeps no
// payload, so the receiver marks this case by writing `inboundMessageId`, which no build writes for
// any other `message_updated`, and ./stranded-delivery.ts reads that pair as the discriminator.
export const LATE_TRANSCRIPTION_EVENT = "message_updated";

export function normalizeChatwootEvent(
  payload: unknown,
): NormalizedChatwootEvent | null {
  if (!isRecord(payload)) return null;
  const event = str(payload.event);
  if (!event) return null;

  const isMessage = MESSAGE_BODY_EVENTS.has(event);
  // WHICH OBJECT the body is, decided by the event name and never by looking at the body. See
  // CONVERSATION_BODY_EVENTS: an event we do not know is an event whose `id` we cannot name.
  const conv = isMessage
    ? isRecord(payload.conversation)
      ? payload.conversation
      : null
    : CONVERSATION_BODY_EVENTS.has(event)
      ? payload
      : null;
  const meta = conv && isRecord(conv.meta) ? conv.meta : null;
  const assignee = meta && isRecord(meta.assignee) ? meta.assignee : null;
  const sender = meta && isRecord(meta.sender) ? meta.sender : null;
  // contact_inbox ships as the full association object (EventDataPresenter#push_data → contact_inbox);
  // tolerate a flat contact_inbox_id scalar too. Same on both shapes (conv = payload | payload.conversation).
  const contactInbox =
    conv && isRecord(conv.contact_inbox) ? conv.contact_inbox : null;

  // The message's own inbox object (Message#webhook_data → inbox: {id, name}); conversation events
  // do not carry it. Read for both halves: the name, and the id when the conversation scalar is gone.
  const inboxObj = isMessage && isRecord(payload.inbox) ? payload.inbox : null;

  const normalized: NormalizedChatwootEvent = {
    event,
    conversationId: conv ? num(conv.id) : null,
    contactInboxId: contactInbox
      ? num(contactInbox.id)
      : conv
        ? num(conv.contact_inbox_id)
        : null,
    // NOTE: `conversation.inbox_id` first, then the message's own `inbox` object. The fork sends
    // both, but only the second survives a payload that carries the message without the
    // conversation's scalar, and an inbox named at either spot is an answer, so nothing downstream
    // goes looking for an older one.
    inboxId:
      (conv ? num(conv.inbox_id) : null) ??
      (inboxObj ? num(inboxObj.id) : null),
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
      messageType: messageTypeOf(payload.message_type),
      private: payload.private === true,
      // NOTE: WHEN the customer wrote, through the same reader the conversation timestamps use:
      // both Chatwoot spellings parse, and anything else reads as absent rather than as the epoch.
      createdAt: chatwootTimestamp(payload.created_at),
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
            // NOTE: audio attachments ship `transcribed_text` (empty until our write-back lands); empty
            // string normalizes to null so callers can treat "no transcription" uniformly.
            transcribedText: str(a.transcribed_text) || null,
            // NOTE: what a PREVIOUS vision pass persisted on this attachment (fork write-back), so
            // the eager pass reuses it instead of paying the provider again. A delivery recovery
            // re-runs the pass from scratch, and without this a partial re-run would publish an
            // aggregate poorer than the metadata it overrides.
            imageDescription: metaString(a.meta, "image_description"),
            extractedText: metaString(a.meta, "extracted_text"),
            // NOTE: Location attachments ship coordinates + place name (location_metadata);
            // null-ish on every other file_type.
            latitude: float(a.coordinates_lat),
            longitude: float(a.coordinates_long),
            fallbackTitle: str(a.fallback_title) || null,
          }))
        : undefined,
      inReplyTo: ca ? num(ca.in_reply_to) : null,
      // NOTE: a reaction (WhatsApp emoji react) arrives as a message with content_attributes.is_reaction.
      // The content is the emoji; in_reply_to points at the message it reacts to.
      isReaction: ca?.is_reaction === true,
      externalSenderName: ca ? str(ca.external_sender_name) : null,
      // NOTE: The Subject header of an inbound email. Read through the shared reader so
      // the delivered event and the REST page cannot disagree about what the subject is.
      emailSubject: emailSubjectFrom(ca),
      emailBodyImages: emailBodyImageUrlsFrom(ca),
      imported: ca?.imported === true,
      externalError: ca ? str(ca.external_error) || null : null,
      replyText: ca ? str(ca[CHATWOOT_REPLY_TEXT_KEY]) || null : null,
      replyByOperator: ca?.[CHATWOOT_REPLY_BY_OPERATOR_KEY] === true,
    };
  }
  if ("changed_attributes" in payload) {
    normalized.changedAttributes = payload.changed_attributes;
  }

  // NOTE: mirror metadata, best-effort. Conversation events carry the contact at meta.sender
  // (EventDataPresenter push_meta).
  if (sender) {
    const contactAttrs = attrs(sender.custom_attributes);
    // Presence of the KEY is the signal, for every identity field: absent leaves the stored
    // value alone, present-and-empty clears it. `str()` alone would turn both into null and lose the
    // clear, so a removed phone or e-mail would stay the identity the gate asks about.
    const stated = (key: string, raw: unknown) =>
      key in sender ? { [key]: str(raw) || null } : {};
    normalized.contact = {
      id: num(sender.id),
      ...stated("name", sender.name),
      ...stated("email", sender.email),
      ...(("phone_number" in sender
        ? { phone: str(sender.phone_number) || null }
        : {}) as { phone?: string | null }),
      ...stated("identifier", sender.identifier),
      ...(contactAttrs ? { customAttributes: contactAttrs } : {}),
      ...additionalContactFields(sender),
    };
  }
  // Conversation + kanban-card custom attributes ride along on every event (push_data.custom_attributes
  // and the fork's push_data.kanban_task), so the agent's attribute context needs NO extra API call.
  const convAttrs = conv ? attrs(conv.custom_attributes) : undefined;
  if (convAttrs) normalized.customAttributes = convAttrs;
  // The whole list rides along with the bags, so it is assigned, never merged. A payload whose
  // `labels` is not a list says nothing, and the stored list stays.
  if (conv && Array.isArray(conv.labels))
    normalized.labels = conv.labels.filter(
      (l): l is string => typeof l === "string" && l.length > 0,
    );
  const kanbanTask =
    conv && isRecord(conv.kanban_task) ? conv.kanban_task : null;
  const taskAttrs = kanbanTask
    ? attrs(kanbanTask.custom_attributes)
    : undefined;
  if (taskAttrs) normalized.kanbanAttributes = taskAttrs;
  // NOTE: the fork's `group_type`, read by the contact gate's rule. A value outside the two types says
  // nothing rather than something wrong: absent leaves the stored value alone. The label list is read
  // above, once, for the dashboard and the gate alike.
  if (
    conv &&
    (conv.group_type === "group" || conv.group_type === "individual")
  ) {
    normalized.conversationType = conv.group_type;
  }
  // Never sent by Chatwoot: ./recover-payload.ts marks a body whose facts were read for a row it is
  // about to create. A forged one only narrows what the mirror writes.
  if (conv && conv.fazer_facts_on_create_only === true)
    normalized.factsOnCreateOnly = true;
  const createActivityAt = conv ? num(conv.fazer_create_activity_at) : null;
  if (createActivityAt !== null) normalized.createActivityAt = createActivityAt;
  // NOTE: the redirect episode's other half, when the fork wrote one. PRESENCE of the key is the
  // statement: the fork always ships it (nil included) and a Chatwoot without it never does, so a
  // payload that says nothing never clears an established pairing. A present-but-unusable value (0,
  // a string, a negative) reads as none: the sender did speak, it just said nothing usable.
  if (conv && "redirect_origin_display_id" in conv) {
    const redirectOrigin = num(conv.redirect_origin_display_id);
    normalized.redirectOriginDisplayId =
      redirectOrigin !== null && redirectOrigin > 0 ? redirectOrigin : null;
  }
  normalized.inboxName = inboxObj ? str(inboxObj.name) : null;
  // NOTE: `channel` (channel_type) is exposed by EventDataPresenter on conversation events.
  normalized.channel = conv ? str(conv.channel) : null;
  normalized.lastActivityAt = conv ? num(conv.last_activity_at) : null;
  // NOTE: float() and not num(): `updated_at` ships as `to_f`, so it carries a fraction, and num()
  // parses ids (its string branch is integers only).
  normalized.conversationUpdatedAt = conv ? float(conv.updated_at) : null;
  // NOTE: the service level of the human half of an attendance, as CHATWOOT computes it; see the
  // field notes in types.ts for why these two are read instead of derived from the events we receive.
  normalized.conversationCreatedAt = conv
    ? chatwootTimestamp(conv.created_at)
    : null;
  normalized.firstReplyCreatedAt = conv
    ? chatwootTimestamp(conv.first_reply_created_at)
    : null;
  return normalized;
}

// Minimal parse of a LIVE conversation payload (GET /conversations/:id, the REST show shape; same
// field positions as the conversation-event payloads: `status` at the top, `meta.assignee_type`,
// `meta.assignee.{id,name}`, `id` = display_id). Null when the payload does not look like a
// conversation: a missing `status` is unparseable (the caller must fail closed and retry, never
// conclude "not bot-owned" from a degraded payload). Feeds the proactive-send live gate: the mirror
// can be stale forever (a lost resolve webhook has no reconciliation), so anything about to message
// a customer proactively re-checks this.
export interface LiveConversationState {
  status: string;
  assigneeType: string | null;
  assigneeId: number | null;
  assigneeName: string | null;
  // The conversation's last_activity_at (REST show renders it both as `last_activity_at` and
  // `timestamp`, epoch seconds). Lets the live-probe reconcile compare freshness against the
  // mirror's monotonic lastEventAt. null when the payload omits both.
  lastActivityAt: Date | null;
  // The conversation's own version, the same `updated_at.to_f` the webhook carries; the REST show
  // renders it too (`api/v1/conversations/partials/_conversation.json.jbuilder`). A reconcile
  // that wrote newer state without it would leave the row ahead of its own marks, and the next
  // delayed conversation event would look newer than them. null on a Chatwoot too old to send it.
  updatedAt: number | null;
  // WHICH INBOX THE SOURCE SAYS THIS CONVERSATION IS ON. A transfer reaches the mirror by webhook,
  // so until then the local row names the inbox the conversation LEFT, and a rule read off that
  // inbox's responder would authorise a hand-back into an inbox that may have none. The REST show and
  // every conversation webhook render `inbox_id` at the top level. null when the payload omits it,
  // the only shape on which a reader may fall back to the mirror.
  inboxId: number | null;
  // The newest message id this payload names, the axis a console write that cannot be versioned is
  // ordered by (./console-write-order.ts). The REST show renders `messages` (the
  // `dashboard_seed_message`) and `last_non_activity_message`; the highest id across both is taken,
  // because each is a message that DEMONSTRABLY exists and this mark may only ever be too low. null
  // when the payload names none.
  latestMessageId: number | null;
  // Whether the payload STATED the assignee, which is whether it carried `meta` at all: the REST show
  // always renders `meta` and leaves `assignee_type` out when nobody holds the conversation, so inside
  // `meta` silence means nobody. A payload with no `meta` reads `assigneeType: null` too without
  // saying so. Optional only for hand-built states; the parser always sets it.
  assigneeStated?: boolean;
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
  // NOTE: An "AgentBot" claim without a readable numeric id is unverifiable ownership: with a null
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
    inboxId: num(raw.inbox_id),
    updatedAt: num(raw.updated_at),
    latestMessageId: latestMessageId(raw),
    assigneeStated: meta !== null,
  };
}

// The highest message id a conversation payload names. The REST show renders `messages` as a
// one-element array holding `dashboard_seed_message` (the newest renderable message) and
// `last_non_activity_message`; they differ when the newest message is an activity line, so the
// maximum is the newest message the source has. Read defensively: an absent, empty or malformed list
// names no message, because too low is the safe direction for every caller
// (./console-write-order.ts) and a number invented from a malformed payload is not.
function latestMessageId(raw: Record<string, unknown>): number | null {
  let best: number | null = null;
  const consider = (v: unknown): void => {
    if (!isRecord(v)) return;
    const id = num(v.id);
    if (id !== null && (best === null || id > best)) best = id;
  };
  if (Array.isArray(raw.messages)) for (const m of raw.messages) consider(m);
  consider(raw.last_non_activity_message);
  return best;
}

// The ASSIGNEE half of the ownership gate: somebody else holds the conversation when it is a human,
// or a bot that is not ours (Chatwoot keeps User and AgentBot ids in separate namespaces, so the
// type is part of the identity). Chatwoot also delivers to a conversation's `assignee_agent_bot`, so
// one endpoint can receive events for a conversation ANOTHER bot owns; without `ourAgentBotId` only a
// human counts. Shared with the console, where a conversation held by another persona's bot needs
// the same hand-back a human-held one does.
export function heldByAnotherParty(
  e: { assigneeType: string | null; assigneeId?: number | null },
  opts: { ourAgentBotId?: number | null } = {},
): boolean {
  if (e.assigneeType === "User") return true;
  return (
    e.assigneeType === "AgentBot" &&
    opts.ourAgentBotId != null &&
    e.assigneeId != null &&
    e.assigneeId !== opts.ourAgentBotId
  );
}

// WHICH OF TWO ASSIGNEE READINGS THE GATE BELIEVES: the payload's snapshot (./state-order.ts,
// point 1) or the mirror row after this event. Neither is uniformly newer, so the one that says the
// conversation is HELD wins: a wrong "held" costs silence, a wrong "free" costs a turn run over a
// human, tools included.
// `stated` stays separate from `assigneeType` because a payload that said NOTHING is not one that
// said "unassigned". docs/chatwoot.md, "Mirror sync" (the gate believes whichever witness says the
// conversation is HELD).
export function effectiveAssignee(
  payload: {
    stated: boolean;
    assigneeType: string | null;
    assigneeId: number | null;
  },
  mirror: { assigneeType: string | null; assigneeId: number | null },
  opts: { ourAgentBotId?: number | null } = {},
): { assigneeType: string | null; assigneeId: number | null } {
  const held = {
    assigneeType: mirror.assigneeType,
    assigneeId: mirror.assigneeId,
  };
  if (heldByAnotherParty(held, opts)) return held;
  return payload.stated
    ? { assigneeType: payload.assigneeType, assigneeId: payload.assigneeId }
    : held;
}

// The bot owns a conversation only while it is `pending` and nobody else holds it. The gate is ours:
// Chatwoot delivers to the bot even when a human is assigned. `alsoResolved` lets one caller speak
// into a conversation the agent side itself closed (an event the operator's system sends back for a
// job the customer asked for); `open` and a conversation anybody else holds stay refused. WHO closed
// it is the recorded origin, never the assignee: an operator resolving in Chatwoot does not assign
// themself (docs/chatwoot.md, "Resolution origin"), so a caller with no stamp to pass is refused.
export function shouldBotHandle(
  e: {
    assigneeType: string | null;
    status: string | null;
    assigneeId?: number | null;
    resolvedBy?: string | null;
  },
  opts: { ourAgentBotId?: number | null; alsoResolved?: boolean } = {},
): boolean {
  const statusIsOurs =
    e.status === "pending" ||
    (opts.alsoResolved === true &&
      e.status === "resolved" &&
      closedByTheAgentSide(e.resolvedBy));
  if (!statusIsOurs) return false;
  return !heldByAnotherParty(e, opts);
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
  return e.event === TURN_BEARING_EVENT && isIncomingMessage(e);
}

// THE WRITE-BACK UPDATE, and what it is worth. When our transcription lands, the fork re-fires
// `message_updated`, which `hasPendingInboundMediaUpdate` (./webhook.ts) rightly treats as nothing
// left to ANALYSE. For MEMORY it is the one event carrying the words of a message no turn will
// answer, already paid for. The words are on the message (the eager pass stashes them within the
// transcribing delivery) or on the attachment (every later delivery); either is the whole text.
export function inboundTranscriptionOnUpdate(
  n: NormalizedChatwootEvent,
): string | null {
  if (n.event !== LATE_TRANSCRIPTION_EVENT || !isIncomingMessage(n))
    return null;
  return (
    n.message?.transcribedText ??
    firstAudioAttachment(n)?.transcribedText ??
    null
  );
}

// A message the BUSINESS sent, typed by a HUMAN agent: the fork's `sender.type` is "user" for
// User#webhook_data, "agent_bot" for AgentBot#webhook_data and absent for a contact. Bot outgoing is
// excluded (our own is already in the memory thread; another bot's is not this agent's dialogue), and
// so are private notes (the team talking to itself). A REACTION is excluded too: the fork stores an
// emoji react as a real outgoing message from `Current.user`, and ingesting it would put
// `atendente: 👍` in the attendance's memory. It is a nod, not something the team said.
export function isHumanAgentMessage(e: NormalizedChatwootEvent): boolean {
  return (
    e.message?.messageType === "outgoing" &&
    e.message.private !== true &&
    e.message.isReaction !== true &&
    e.message.sender?.type === "user"
  );
}

// message_created only, for the same reason isNewIncomingMessage is: our own attachment write-backs
// make the fork re-dispatch a message_updated for a message already handled, and acting on those
// would loop. An edit to an agent's reply is not a new thing said.
export function isNewHumanAgentMessage(e: NormalizedChatwootEvent): boolean {
  return e.event === "message_created" && isHumanAgentMessage(e);
}

// The literal the fork writes for an outgoing message that came back FROM the WhatsApp session.
// Named once because two predicates and a doc page compare against it, and a second spelling of a
// magic string is how a comparison goes quietly false.
export const SESSION_SENDER_NAME = "WhatsApp";

// THE PROVIDERS WHOSE SEND PATH RESERVES ITS WhatsApp ID BEFORE THE REQUEST, the only ones on which
// the marker above means "a person, not us": elsewhere (`zapi`) a lost send response turns the echo
// of our own reply into a new sender-less message wearing the marker. Refused rather than guessed:
// matching an echo by content inside a time window fails both ways. docs/chatwoot.md, "A person
// answering the customer ends the attendance".
export const ECHO_RESERVING_WHATSAPP_PROVIDERS = new Set([
  "baileys",
  "native",
  "uazapi",
]);

export function providerReservesEchoIds(provider: string | null): boolean {
  return provider !== null && ECHO_RESERVING_WHATSAPP_PROVIDERS.has(provider);
}

// The person-answering shape by the other route: typed on the phone paired to the inbox's number.
// The fork stores that echo sender-less, so only `external_sender_name` sees it; a bare "outgoing
// with no sender" also matches an automation rule, a scheduled message and a CSAT survey.
// `sender == null` stays too, so a fork that stamps the marker on a Chatwoot row cannot reach this,
// and `imported` is fenced though unreachable through this event today (a cross-repo fence). This is
// the PAYLOAD half: the provider half needs the inbox row, read only when this superset passes.
// docs/chatwoot.md, "A person answering the customer ends the attendance".
export function hasDeviceAttendantShape(e: NormalizedChatwootEvent): boolean {
  return (
    e.message?.messageType === "outgoing" &&
    e.message.private !== true &&
    e.message.isReaction !== true &&
    e.message.imported !== true &&
    (e.message.sender ?? null) === null &&
    e.message.externalSenderName === SESSION_SENDER_NAME
  );
}

export function isDeviceAttendantMessage(
  e: NormalizedChatwootEvent,
  // The mirrored inbox's WhatsApp provider. REQUIRED rather than optional, so a new caller has to
  // answer it: the payload alone cannot say whether an unmatched echo of our own reply is possible
  // here, and a caller that forgot would either lose the fix silently or turn it on where it is
  // unsafe. `null` (unknown, or not a WhatsApp inbox) refuses.
  opts: { whatsappProvider: string | null },
): boolean {
  // NOTE: through `resolveHumanReplyRoute`, so this predicate and the recovery that asks it of a
  // stored shape cannot disagree about which providers the marker is trusted on.
  return (
    resolveHumanReplyRoute(
      hasDeviceAttendantShape(e) ? "device" : null,
      opts,
    ) !== null
  );
}

// COULD this event be a person answering the customer, before the inbox row has been read? Decides
// whether resolving the inbox's agent is worth a query, and whether the ledger row records a
// takeover as owed.
export function mayBeNewHumanReply(e: NormalizedChatwootEvent): boolean {
  return newHumanReplyShape(e) !== null;
}

// A PERSON answered the customer here, and by WHICH route. Downstream both routes are the same event
// (the conversation is no longer the agent's, and what was said is the business half), so they are
// joined once here. The route rather than a boolean, so the caller that acts and the flow-log line
// that says why (the CRM or somebody's phone) cannot disagree. The two predicates are DISJOINT (a
// `user` sender vs no sender), so the order they are asked in decides nothing.
export type HumanReplyRoute = "composer" | "device";

// THE HALF THE PAYLOAD ANSWERS. `device` here is a shape, not yet a verdict: an unreserved
// provider's echo wears it too, and only the inbox row tells them apart (providerReservesEchoIds).
// The ledger records this shape at INSERT, before the inbox is read, so a delivery stranded by a
// process death still says what it was about, and the recovery asks the second half later.
export function humanReplyShape(
  e: NormalizedChatwootEvent,
): HumanReplyRoute | null {
  if (isHumanAgentMessage(e)) return "composer";
  if (hasDeviceAttendantShape(e)) return "device";
  return null;
}

// message_created only, for the reason isNewHumanAgentMessage gives.
export function newHumanReplyShape(
  e: NormalizedChatwootEvent,
): HumanReplyRoute | null {
  return e.event === "message_created" ? humanReplyShape(e) : null;
}

// THE HALF THE INBOX ANSWERS. `composer` is sender-typed and stands on the payload alone; `device`
// is only a person on a provider whose send path reserves its ids, so an unknown or unreserved
// provider refuses it, the same refusal `isDeviceAttendantMessage` makes, asked of the shape
// instead of the event, so a caller that no longer HAS the event can still ask it.
export function resolveHumanReplyRoute(
  shape: HumanReplyRoute | null,
  opts: { whatsappProvider: string | null },
): HumanReplyRoute | null {
  if (shape === "composer") return "composer";
  if (shape === "device" && providerReservesEchoIds(opts.whatsappProvider)) {
    return "device";
  }
  return null;
}

export function humanReplyRoute(
  e: NormalizedChatwootEvent,
  opts: { whatsappProvider: string | null },
): HumanReplyRoute | null {
  return resolveHumanReplyRoute(humanReplyShape(e), opts);
}

// message_created only, for the reason isNewHumanAgentMessage gives: an update is our own write-back
// coming back around, and an edit to a reply is not a new thing said.
//
// `isNewHumanReplyToCustomer` is this same question asked by a caller that does not need the route.
export function newHumanReplyRoute(
  e: NormalizedChatwootEvent,
  opts: { whatsappProvider: string | null },
): HumanReplyRoute | null {
  return resolveHumanReplyRoute(newHumanReplyShape(e), opts);
}

export function isNewHumanReplyToCustomer(
  e: NormalizedChatwootEvent,
  opts: { whatsappProvider: string | null },
): boolean {
  return newHumanReplyRoute(e, opts) !== null;
}

// The control commands an operator types into the conversation to drive the agent (matched on the
// trimmed, case-insensitive text content; text-only by design). `/teste` activates a test agent for
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
// it must not advance the follow-up / 24h-window inbound watermark (`lastInboundAt`), otherwise a
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

// UMA MENSAGEM QUE AINDA VAI RECEBER MAIS CONTEÚDO: hoje só o áudio sem transcrição, cujas palavras
// chegam depois num `message_updated` sobre o MESMO id. Quem pergunta é o portão de posse do caminho
// direto: parar o turno manda a mensagem para a ingestão, que grava o id no dedup do thread, e a
// transcrição posterior seria descartada como duplicata. A pergunta é se ainda vem mais, não se já há
// palavras (uma legenda ou um assunto também são). Pelo TIPO DO ARQUIVO, e não por
// `firstAudioAttachment`, que exige id e `data_url` utilizáveis: um anexo sem url ainda chega ao
// grafo como placeholder. `hasPendingInboundMediaUpdate` (./webhook.ts) faz outra pergunta.
export function awaitsTranscription(n: NormalizedChatwootEvent): boolean {
  if (!isIncomingMessage(n)) return false;
  // O PRIMEIRO áudio, que é o que a transcrição cobre (`firstAudioAttachment` e
  // `runEagerMedia` selecionam esse): com o segundo transcrito e o primeiro não, "algum está
  // transcrito" deixaria o portão atuar sobre a mensagem cuja transcrição ainda vem.
  const audios = (n.message?.attachments ?? []).filter(
    (a) => a.fileType === "audio",
  );
  if (audios.length === 0) return false;
  return !(audios[0]?.transcribedText || n.message?.transcribedText);
}

// THE ONE MAPPING FROM A NORMALIZED EVENT TO WHAT THE AGENT WOULD READ, asked by the turn, by the
// spend-ceiling gate (would this message reach a model at all? `runAgentTurn` skips one that renders
// to nothing before any billed call) and by `ingestUnhandledMessage` (what to fold into memory for a
// message no turn covers). One mapping, so a marker or field added later reaches all three.
export function incomingRenderable(
  n: NormalizedChatwootEvent,
): RenderableMessage {
  return {
    text: n.message?.content ?? "",
    transcribedText: n.message?.transcribedText,
    imageDescription: n.message?.imageDescription,
    extractedText: n.message?.extractedText,
    attachmentsUnread: n.message?.attachmentsUnread,
    unreadFiles: n.message?.unreadFiles,
    attachmentTypes: (n.message?.attachments ?? [])
      .map((a) => a.fileType)
      .filter((t): t is string => t !== null),
    bodyImages: visualAttachments(n).filter((v) => v.id === null).length,
    location: firstLocationAttachment(n.message?.attachments),
    inReplyTo: n.message?.inReplyTo,
    isReaction: n.message?.isReaction,
    emailSubject: n.message?.emailSubject,
  };
}

// The Subject header the mailbox wrote into `content_attributes.email` (MailboxSanitizer sets
// `email: processed_mail.serialized_data`, and MailPresenter#serialized_data carries `subject`).
// Read as a STRING and nothing else: the bag is shared with whatever else writes there, and a value
// of another shape is somebody's colliding key, not a subject. Shared by both readers of the bag so
// the REST page and the delivered event cannot disagree about it.
export function emailSubjectFrom(
  contentAttributes: Record<string, unknown> | null | undefined,
): string | null {
  const email = isRecord(contentAttributes?.email)
    ? contentAttributes.email
    : null;
  const subject = email?.subject;
  if (typeof subject !== "string") return null;
  return subject.trim() ? subject : null;
}

// WHAT KIND OF ACTIVITY THIS ROW DECLARES ITSELF TO BE, from `content_attributes.activity.type`
// (Chatwoot's `status_change_activity` writes `conversation_status_changed`, and Linear's service
// writes its own). It is the only structural thing an activity row carries: the label, assignee,
// team, priority and SLA handlers all pass `activity_message_params(content)` with no bag at all.
// So a row that declares a type is narration about something ELSE, which the observer's label
// history needs to rule out. Read as a string and nothing else, like every other key in a bag shared
// with whatever an operator's automation writes there.
export function activityTypeFrom(
  contentAttributes: Record<string, unknown> | null | undefined,
): string | null {
  const activity = isRecord(contentAttributes?.activity)
    ? contentAttributes.activity
    : null;
  const type = activity?.type;
  if (typeof type !== "string") return null;
  return type.trim() ? type : null;
}

// THE STATUS A STATUS-CHANGE ACTIVITY NARRATES, from `content_attributes.activity.status`, which
// Chatwoot's `status_change_activity` writes beside the type. Read as a string and
// nothing else, like the type above.
export function activityStatusFrom(
  contentAttributes: Record<string, unknown> | null | undefined,
): string | null {
  const activity = isRecord(contentAttributes?.activity)
    ? contentAttributes.activity
    : null;
  const status = activity?.status;
  if (typeof status !== "string") return null;
  return status.trim() ? status : null;
}

// The first USABLE location attachment (a WhatsApp pin): real coordinates and/or a title, or null.
// Chatwoot's coordinate columns default to 0.0, so an exact (0,0) means no coordinates were sent;
// such a pin can still carry a usable fallback_title. Neither means null, and the render falls back
// to the generic attachment marker. Shared by the direct webhook path and the debounce re-fetch.
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
    // Out-of-range values (|lat| > 90, |long| > 180) are provider garbage, not coordinates:
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

// A string value on an attachment's `meta` bag, or null. The bag is shared with Chatwoot's own
// keys and with whatever an operator's automation writes there, so a value of another shape is
// somebody else's key that happens to collide, not ours.
export function metaString(meta: unknown, key: string): string | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta))
    return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v : null;
}

// O QUE CONTA COMO ANEXO VISUAL, numa pergunta só. "image" e "file" cobrem foto e documento (um
// PDF, por exemplo); áudio e vídeo têm caminhos próprios. Exportada porque o outro leitor dos
// anexos, o parser da lista REST (./messages.ts), precisa da MESMA resposta: dois predicados
// divergiriam na primeira vez que um tipo novo entrasse, e o sintoma seria um anexo lido por um
// caminho e ignorado pelo outro.
export function isVisualFileType(fileType: string | null): boolean {
  return fileType === "image" || fileType === "file";
}

// EVERY image/file attachment with a usable id + url, then the email body's images. Drives the eager
// vision pass, where the downloaded mime decides image vs document vs unsupported. A message often
// carries several attachments, and analysing only one leaves the reply asking for the others; the
// caller decides how many it can afford, and the list is what it decides from.
export function visualAttachments(e: NormalizedChatwootEvent): {
  id: number | null;
  dataUrl: string;
  name: string | null;
  // What a previous pass already extracted from THIS attachment, when the write-back landed.
  imageDescription: string | null;
  extractedText: string | null;
}[] {
  const out: ReturnType<typeof visualAttachments> = [];
  for (const a of e.message?.attachments ?? []) {
    if (isVisualFileType(a.fileType ?? null) && a.id !== null && a.dataUrl) {
      out.push({
        id: a.id,
        dataUrl: a.dataUrl,
        name: fileNameOf(a.dataUrl),
        imageDescription: a.imageDescription ?? null,
        extractedText: a.extractedText ?? null,
      });
    }
  }
  return [
    ...out,
    ...bodyImageVisuals(
      bodyImagesBesides(
        e.message?.emailBodyImages ?? [],
        out.map((v) => v.dataUrl),
      ),
    ),
  ];
}

// The images a mailbox kept in the email body, after the real attachments so they
// never take a slot of the per-message cap from one. Shared with the REST reader (./messages.ts).
export function bodyImageVisuals(urls: string[] | undefined): {
  id: null;
  dataUrl: string;
  name: string | null;
  imageDescription: null;
  extractedText: null;
}[] {
  return (urls ?? []).map((dataUrl) => ({
    id: null,
    dataUrl,
    name: fileNameOf(dataUrl),
    imageDescription: null,
    extractedText: null,
  }));
}

// The basename of the data url, query stripped, labelling each extraction so the model can tell
// which datum came from which file. BEST-EFFORT: `decodeURIComponent` THROWS on an invalid escape
// (`100%.png` is a real file name), and this runs outside `runEagerMedia`'s recovery block, so a
// throw would abort the whole message; the undecoded basename is a worse label, never a worse
// outcome.
function fileNameOf(dataUrl: string): string | null {
  const path = dataUrl.split("?")[0] ?? dataUrl;
  const base = path.slice(path.lastIndexOf("/") + 1);
  let name: string;
  try {
    name = decodeURIComponent(base).trim();
  } catch {
    name = base.trim();
  }
  return name.length > 0 && name.length <= 120 ? name : null;
}

// The `additional_attributes` keys the agent may see, when the payload carried the bag at all. Every
// key is stated once the bag is there: a key missing from it is a value Chatwoot does not hold, so
// it reads as null and clears the mirrored one, the same rule the identity fields follow.
function additionalContactFields(sender: Record<string, unknown>): {
  additionalAttributes?: Partial<Record<AdditionalContactField, string | null>>;
} {
  if (!("additional_attributes" in sender)) return {};
  const bag = isRecord(sender.additional_attributes)
    ? sender.additional_attributes
    : {};
  const out: Partial<Record<AdditionalContactField, string | null>> = {};
  for (const key of ADDITIONAL_CONTACT_FIELDS) out[key] = str(bag[key]) || null;
  return { additionalAttributes: out };
}
