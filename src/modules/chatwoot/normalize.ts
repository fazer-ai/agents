import type { RenderableLocation, RenderableMessage } from "./render";
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

// What kind of message this is, in the ONE vocabulary the rest of the code compares against.
//
// It takes both spellings because Chatwoot has two serializers and they disagree. MEASURED on the
// fork, one message, both of them: `Message#webhook_data[:message_type]` is the string `"incoming"`
// and `Message#push_event_data[:message_type]` is the integer `0`. The webhook carries the first and
// every REST read carries the second, so a body's provenance decides its spelling.
//
// This used to be `str()` here and a private copy in ./messages.ts, which is the shape of defect
// that keeps costing this repo: one question, two places, two tolerances. The copy in messages.ts
// took both and this one took only the string, so an event rebuilt from a REST read normalized to
// `messageType: null` and `isNewIncomingMessage` answered false — a customer's message classified as
// not-incoming, with no throw and no line. Nothing rebuilt events from REST until issue #295, which
// is why the divergence had never fired.
//
// Unknown input collapses to "other" rather than passing through, and that is not a widening: the
// only two readers of this field ask `=== "incoming"` and `=== "outgoing"`, so a value neither of
// them matches already meant "neither".
export function messageTypeOf(
  v: unknown,
): "incoming" | "outgoing" | "activity" | "template" | "other" {
  // A string is coerced only when it IS the integer spelling, digits and nothing else. `Number("")`
  // and `Number("  ")` are both 0, so a bare coercion classifies an empty or blank `message_type` as
  // `incoming` — and an incoming message is the one class that drives an agent turn. The old
  // string-only reader rejected those by not matching "incoming"; widening the domain is what would
  // have woken that branch (a defect this repo has paid for before), so the widening is closed here.
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

// NOTE: Coordinates arrive as JSON floats (possibly negative) — num() deliberately rejects those
// (it parses ids). Numbers only: the fork's serializer never sends coordinates as strings.
function float(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// A Chatwoot timestamp field that is NOT one of the push_timestamps trio, read off the conversation
// payload. Two spellings reach us for the same column and both are Chatwoot's own: the jbuilder
// partials render `created_at` as epoch seconds (`.to_i`), while `first_reply_created_at` is a
// plain ActiveRecord attribute and serializes as an ISO-8601 string. Accept either, reject anything
// that does not parse — a field we cannot read must read as absent, never as the epoch.
function ts(v: unknown): Date | null {
  // NOTE: every branch exits through here. `Number.isFinite` and `> 0` both pass for an epoch far
  // outside the range a Date can hold (1e20, or a digit string of the same size), and what comes
  // back is an Invalid Date, which Prisma refuses — failing the WHOLE delivery over an optional
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

// NOTE: undefined means "this payload said nothing", so the mirror keeps the stored bag instead of
// wiping it; `{}` is a real "no attributes" and DOES clear it.
function attrs(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined;
}

// Chatwoot serializes each event's own SUBJECT, and every subject renders its own table id under the
// same `id` key: `Conversations::EventDataPresenter#push_data` puts the conversation's DISPLAY id
// there, while `Message`, `Contact`, `ContactInbox`, `Inbox` and the Kanban card all put a primary
// key. So the body only says which id it holds if you already know which object it is, and the event
// name is the only thing that says so.
//
// Treating "not a message event" as "the body IS the conversation" put a foreign row id on
// `conversationId`, and the mirror keys `chatwoot_conversation_id` off exactly that — which opened a
// SECOND row for a conversation that already had one (issue #257; measured against the fork, 7 of 19
// event shapes). Hence two allowlists and no fallback: an unknown event identifies no conversation,
// the mirror writes nothing for it, and the next real event refreshes the row. Failing the other way
// is what creates the duplicate, and a duplicate does not heal.

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

  // NOTE: The message's own inbox object (Message#webhook_data → inbox: {id, name}); conversation events
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
    // NOTE: `conversation.inbox_id` first, then the message's own top-level `inbox` object. They name the
    // same inbox and the fork sends both, but only the second survives a payload that carries the
    // message without the conversation's scalar — and an inbox the payload named at either spot is
    // an answer, so nothing downstream should go looking for an older one (issue #270).
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
    // Presence of the KEY is the signal, for every identity field: absent leaves the stored value
    // alone, present-and-empty clears it. `str()` alone turned both into null and the clear was
    // lost, so a removed phone or e-mail went on being the identity the gate asks about.
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
  // The redirect episode's other half, when the fork wrote one. Absent rather than null on everything
  // that is not the widget side of an episode, so a payload that says nothing never clears a pairing
  // an earlier one established (issue #222).
  // PRESENCE of the key is the statement, not the value: the fork always ships it (nil included) and
  // a Chatwoot without it never does, so `in` is what separates "there is no pairing" from "this
  // instance does not speak about pairings". A present-but-unusable value (0, a string, a negative)
  // reads as none rather than as silence — the sender did speak, it just said nothing usable.
  if (conv && "redirect_origin_display_id" in conv) {
    const redirectOrigin = num(conv.redirect_origin_display_id);
    normalized.redirectOriginDisplayId =
      redirectOrigin !== null && redirectOrigin > 0 ? redirectOrigin : null;
  }
  normalized.inboxName = inboxObj ? str(inboxObj.name) : null;
  // `channel` (channel_type) is exposed by EventDataPresenter on conversation events.
  normalized.channel = conv ? str(conv.channel) : null;
  normalized.lastActivityAt = conv ? num(conv.last_activity_at) : null;
  // NOTE: float() and not num() — `updated_at` ships as `to_f`, so it carries a fraction, and num()
  // parses ids (its string branch is integers only).
  normalized.conversationUpdatedAt = conv ? float(conv.updated_at) : null;
  // The service level of the human half of an attendance, as CHATWOOT computes it — see the field
  // notes in types.ts for why these two are read instead of derived from the events we receive.
  normalized.conversationCreatedAt = conv ? ts(conv.created_at) : null;
  normalized.firstReplyCreatedAt = conv
    ? ts(conv.first_reply_created_at)
    : null;
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
// The ASSIGNEE half of the question below, on its own because two different questions are built from
// it and only one of them is about status. "Somebody else is holding this" is a human, or a bot that
// is not ours — Chatwoot keeps User and AgentBot in separate id namespaces, so the comparison is the
// whole identity and never the number alone.
//
// Split out rather than restated: the console asks it to decide which ownership action to offer, and
// a conversation held by ANOTHER persona's bot is the case a "is the assignee a User?" test reads
// backwards — the inbox's own agent cannot answer there either, so it needs the same hand-back the
// human case needs. A second copy is how that case came to be missing in the first place.
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

// WHICH OF TWO ASSIGNEE READINGS THE GATE MUST BELIEVE, when a delivery arrives holding both.
//
// A delivery gates on a PAYLOAD, and every payload is a snapshot of an earlier instant: Chatwoot
// serializes the conversation when the message fires and only then enqueues (state-order.ts, point
// 1), and a delivery recovery rebuilds one from reads it made a moment before (#295). Beside it
// sits the MIRROR row as it stands after this event was written — a different instant again.
//
// Neither reading is uniformly the newer one, so this does not pick by recency. It picks by which
// way a wrong answer fails. A reading that says SOMEBODY ELSE HOLDS IT can only cost silence: the
// event that releases the conversation is a conversation-level one, it applies when it lands, and
// the next delivery passes. A reading that says NOBODY DOES costs an answer posted over a human who
// had just taken over — and posted is the smaller half of it, because the runtime's ownership
// re-check runs after the model call (../../graph/runtime.ts), so the turn has already run every
// tool it chose by the time anything withholds the text.
//
// So: whichever witness says the conversation is held is the one believed, and the payload's
// statement is preferred over the mirror only where neither says so.
//
// The asymmetry is not this function's invention — it is the mirror's rule read from the gate's
// side. A message snapshot may never write the assignee at all (state-order.ts: `assigneeOrdered`
// requires `fromConversationEvent`), so a mirror that reads human-owned under a payload that reads
// bot-owned is the mirror doing its job, not lagging. MEASURED on the recovery, where the window is
// widest: a human taking the conversation between the last mirror read and the gate got a full turn
// run against them, tools included.
//
// `stated` is the degraded-payload question of issue #27 and stays separate from `assigneeType`:
// a payload that said NOTHING is not a payload that said "unassigned", and `null` cannot tell the
// two apart.
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

export function shouldBotHandle(
  e: {
    assigneeType: string | null;
    status: string | null;
    assigneeId?: number | null;
  },
  opts: { ourAgentBotId?: number | null } = {},
): boolean {
  if (e.status !== "pending") return false;
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

// A message the BUSINESS sent to the customer, typed by a HUMAN agent rather than produced by a bot.
// `sender.type` is the fork's own discriminator and was read from its source: User#webhook_data emits
// "user", AgentBot#webhook_data emits "agent_bot", and Contact#webhook_data carries no `type` key at
// all, so an incoming message normalizes to null there.
//
// Our own bot's outgoing is excluded because the turn that produced it already wrote it to the memory
// thread — ingesting it again would duplicate every answer the agent ever gave. Another account bot's
// outgoing is excluded by the same clause, and deliberately: whatever it is doing is not this agent's
// dialogue with the contact. Private notes are the operator talking to their own team, not to the
// customer, so they never enter the contact's memory. Templates and activities are not `outgoing` and
// never reach here.
//
// A REACTION is the one exclusion that is not obvious from the shape. The fork stores an emoji react
// as a real message — `MessageBuilder` with `message_type: "outgoing"`, `content` = the emoji,
// `content_attributes.is_reaction`, sender `Current.user` — so an operator reacting 👍 matches every
// other clause here (confirmed on live rows). Ingested, the permanent memory of that attendance would
// carry a line reading `atendente: 👍`. It is an acknowledgement, not something the team said.
export function isHumanAgentMessage(e: NormalizedChatwootEvent): boolean {
  return (
    e.message?.messageType === "outgoing" &&
    e.message.private !== true &&
    e.message.isReaction !== true &&
    e.message.sender?.type === "user"
  );
}

// message_created only, for the same reason isNewIncomingMessage is: our own attachment write-backs
// make the fork re-dispatch a message_updated for a message already handled, and acting on those is
// how the voice-note loop happened. An edit to an agent's reply is not a new thing said.
export function isNewHumanAgentMessage(e: NormalizedChatwootEvent): boolean {
  return e.event === "message_created" && isHumanAgentMessage(e);
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
// THE ONE MAPPING FROM A NORMALIZED EVENT TO WHAT THE AGENT WOULD READ. Two callers ask it and one
// of them is not running a turn: the spend-ceiling gate has to know whether the message it is about
// to refuse would have reached a model at all, and `runAgentTurn` answers `skipped` — before any
// billed call — for a message that renders to nothing (blank content, an attachment type we do not
// recognise, a reaction). Asking that there with a second copy of this shape would be a second
// answer to one question, and the two would drift the first time a marker or a field is added.
export function incomingRenderable(
  n: NormalizedChatwootEvent,
): RenderableMessage {
  return {
    text: n.message?.content ?? "",
    transcribedText: n.message?.transcribedText,
    imageDescription: n.message?.imageDescription,
    extractedText: n.message?.extractedText,
    attachmentTypes: (n.message?.attachments ?? [])
      .map((a) => a.fileType)
      .filter((t): t is string => t !== null),
    location: firstLocationAttachment(n.message?.attachments),
    inReplyTo: n.message?.inReplyTo,
    isReaction: n.message?.isReaction,
  };
}

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
