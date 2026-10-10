import { createHash } from "node:crypto";
import type { NormalizedChatwootEvent } from "./types";

// A `message_updated` that repeats, for everything the receiver normalizes, what this process already
// processed for that message on that route and mirrored for that conversation: a delivery receipt.
// The payload names neither the status nor what changed, so this is the question that can be asked.
// Never a customer message's update, nor a send failure. In memory and bounded; a miss processes the
// update as before. docs/chatwoot.md, "Webhook receiver", step 3a.

// How many messages and conversations are remembered. A record is one key and one digest (about 150
// bytes), so the bound is a few MB; oldest-first eviction.
export const UNCHANGED_UPDATE_MESSAGES_MAX = 20_000;
export const UNCHANGED_UPDATE_CONVERSATIONS_MAX = 20_000;

interface ConversationRecord {
  digest: string;
  // `conversation.updated_at`, the source's own version: the record keeps the NEWEST snapshot mirrored,
  // so a slower processing of an older event cannot make an older snapshot the one compared against.
  version: number | null;
}

interface Store {
  messages: Map<string, string>;
  conversations: Map<string, ConversationRecord>;
}

const KEY = Symbol.for("fazerai.chatwoot.unchangedUpdates");

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  const held = g[KEY];
  if (
    !held ||
    !(held.messages instanceof Map) ||
    !(held.conversations instanceof Map)
  ) {
    g[KEY] = { messages: new Map(), conversations: new Map() };
  }
  return g[KEY] as Store;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)),
    )
    .digest("base64");
}

// The message half: everything normalized about the message, plus the inbox name, which only a
// message event carries (a conversation event has no `inbox` object), so a rename is still compared
// against what this message last carried rather than against a conversation event that cannot say it.
function messageDigest(n: NormalizedChatwootEvent): string {
  return digest({ message: n.message, inboxName: n.inboxName ?? null });
}

// The conversation half: every other normalized field, the event name and the event's own
// `changed_attributes` aside (they describe the event, not the conversation it snapshots).
function conversationDigest(n: NormalizedChatwootEvent): string {
  const {
    event: _event,
    message: _message,
    changedAttributes: _changed,
    inboxName: _inboxName,
    ...snapshot
  } = n;
  return digest(snapshot);
}

function messageKey(
  tenantId: bigint,
  instanceId: bigint,
  agentBotId: number,
  messageId: number,
): string {
  return `${tenantId}:${instanceId}:${agentBotId}:${messageId}`;
}

function conversationKey(
  tenantId: bigint,
  instanceId: bigint,
  conversationId: number,
): string {
  return `${tenantId}:${instanceId}:${conversationId}`;
}

// The class the drop may apply to at all, before any record is consulted.
function droppableShape(n: NormalizedChatwootEvent): boolean {
  const m = n.message;
  return (
    n.event === "message_updated" &&
    m !== undefined &&
    (m.messageType === "outgoing" || m.messageType === "template") &&
    !m.externalError &&
    m.id !== null &&
    n.conversationId !== null
  );
}

// Whether this delivery repeats, for everything the receiver reads, what this process already handled.
export function isUnchangedMessageUpdate(
  tenantId: bigint,
  instanceId: bigint,
  agentBotId: number | null,
  n: NormalizedChatwootEvent,
): boolean {
  if (agentBotId === null || !droppableShape(n)) return false;
  const s = store();
  const seen = s.messages.get(
    messageKey(tenantId, instanceId, agentBotId, n.message?.id as number),
  );
  if (seen === undefined || seen !== messageDigest(n)) return false;
  const conv = s.conversations.get(
    conversationKey(tenantId, instanceId, n.conversationId as number),
  );
  return conv !== undefined && conv.digest === conversationDigest(n);
}

function setBounded<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  max: number,
) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

// What a delivery's message and conversation looked like ON ARRIVAL, taken before it is processed (the
// processing may enrich the normalized event, and a repeat is compared against the wire), and kept
// only once that processing succeeded on this route: call the returned function then.
export function rememberOnSuccess(
  tenantId: bigint,
  instanceId: bigint,
  agentBotId: number | null,
  n: NormalizedChatwootEvent,
): () => void {
  const conversation =
    n.conversationId === null
      ? null
      : {
          key: conversationKey(tenantId, instanceId, n.conversationId),
          record: {
            digest: conversationDigest(n),
            version: n.conversationUpdatedAt ?? null,
          },
        };
  const m = n.message;
  // Only the messages a repeat could be dropped for: the business's own.
  const message =
    agentBotId !== null &&
    m !== undefined &&
    m.id !== null &&
    (m.messageType === "outgoing" || m.messageType === "template")
      ? {
          key: messageKey(tenantId, instanceId, agentBotId, m.id),
          digest: messageDigest(n),
        }
      : null;
  return () => {
    const s = store();
    if (conversation !== null) {
      const held = s.conversations.get(conversation.key);
      const version = conversation.record.version;
      // Older than the snapshot already held: that one stays the newest mirrored.
      const older =
        held !== undefined &&
        held.version !== null &&
        (version === null || version < held.version);
      if (!older) {
        setBounded(
          s.conversations,
          conversation.key,
          conversation.record,
          UNCHANGED_UPDATE_CONVERSATIONS_MAX,
        );
      }
    }
    if (message !== null) {
      setBounded(
        s.messages,
        message.key,
        message.digest,
        UNCHANGED_UPDATE_MESSAGES_MAX,
      );
    }
  };
}

// Records a delivery as processed, for a caller that already knows it was.
export function rememberProcessedDelivery(
  tenantId: bigint,
  instanceId: bigint,
  agentBotId: number | null,
  n: NormalizedChatwootEvent,
): void {
  rememberOnSuccess(tenantId, instanceId, agentBotId, n)();
}

// The sizes, for tests and for the bound's own check.
export function unchangedUpdateRecordSizes(): {
  messages: number;
  conversations: number;
} {
  const s = store();
  return { messages: s.messages.size, conversations: s.conversations.size };
}

export function resetUnchangedUpdateRecords(): void {
  const s = store();
  s.messages.clear();
  s.conversations.clear();
}
