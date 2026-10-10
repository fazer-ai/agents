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

interface MirrorsInFlight {
  count: number;
  // Another mirror run of the conversation started while one was in flight: their commit order is
  // not their completion order, so neither can say what the row holds.
  overlapped: boolean;
}

interface Store {
  messages: Map<string, string>;
  // The snapshot the LAST mirror run of the conversation in this process applied whole.
  conversations: Map<string, string>;
  mirroring: Map<string, MirrorsInFlight>;
}

const KEY = Symbol.for("fazerai.chatwoot.unchangedUpdates");

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  const held = g[KEY];
  if (
    !held ||
    !(held.messages instanceof Map) ||
    !(held.conversations instanceof Map) ||
    !(held.mirroring instanceof Map)
  ) {
    g[KEY] = {
      messages: new Map(),
      conversations: new Map(),
      mirroring: new Map(),
    };
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

// The business's own message: the only kind a repeat is dropped for, and so the only kind recorded.
function businessMessage(
  m: NormalizedChatwootEvent["message"],
): m is NonNullable<NormalizedChatwootEvent["message"]> {
  return (
    m !== undefined &&
    (m.messageType === "outgoing" || m.messageType === "template")
  );
}

// The class the drop may apply to at all, before any record is consulted.
function droppableShape(n: NormalizedChatwootEvent): boolean {
  const m = n.message;
  return (
    n.event === "message_updated" &&
    businessMessage(m) &&
    !m.externalError &&
    m.id !== null &&
    n.conversationId !== null &&
    // A Chatwoot before 4.0.2 sends no version, so two equal snapshots can be two transitions (open,
    // resolved, open again): each one is mirrored, as `mirrorOncePerEvent` does.
    n.conversationUpdatedAt != null
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
  const key = conversationKey(tenantId, instanceId, n.conversationId as number);
  // A mirror of this conversation in flight has not said yet what the row will hold.
  if (s.mirroring.has(key)) return false;
  return s.conversations.get(key) === conversationDigest(n);
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

// Around every mirror run (`mirrorOncePerEvent`, the one path every delivery, drain and recovery
// mirrors through). The record is what the row holds only when the run applied the snapshot whole
// and no other run of the conversation overlapped it; any other ending forgets the record, so the
// next receipt reaches the mirror. "Newest by version" is not the rule: the unversioned fields
// (contact, bags, labels) are ordered by the coarse activity clock, so an older event can still
// write them, and what the row holds is what the last run wrote.
export function trackConversationMirror(
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
): { done: (whole: boolean) => void } {
  if (n.conversationId === null) return { done: () => {} };
  const key = conversationKey(tenantId, instanceId, n.conversationId);
  const snapshot = conversationDigest(n);
  const s = store();
  const flight = s.mirroring.get(key) ?? { count: 0, overlapped: false };
  if (flight.count > 0) flight.overlapped = true;
  flight.count++;
  s.mirroring.set(key, flight);
  let settled = false;
  return {
    done: (whole) => {
      if (settled) return;
      settled = true;
      if (whole && !flight.overlapped) {
        setBounded(
          s.conversations,
          key,
          snapshot,
          UNCHANGED_UPDATE_CONVERSATIONS_MAX,
        );
      } else {
        s.conversations.delete(key);
      }
      flight.count--;
      if (flight.count === 0 && s.mirroring.get(key) === flight) {
        s.mirroring.delete(key);
      }
    },
  };
}

// The message half, taken on arrival and kept only once the delivery was processed on this route:
// call the returned function then.
export function rememberOnSuccess(
  tenantId: bigint,
  instanceId: bigint,
  agentBotId: number | null,
  n: NormalizedChatwootEvent,
): () => void {
  const m = n.message;
  const message =
    agentBotId !== null && businessMessage(m) && m.id !== null
      ? {
          key: messageKey(tenantId, instanceId, agentBotId, m.id),
          digest: messageDigest(n),
        }
      : null;
  return () => {
    if (message === null) return;
    setBounded(
      store().messages,
      message.key,
      message.digest,
      UNCHANGED_UPDATE_MESSAGES_MAX,
    );
  };
}

// Both halves at once, as a whole mirror run and a processed delivery would leave them.
export function rememberProcessedDelivery(
  tenantId: bigint,
  instanceId: bigint,
  agentBotId: number | null,
  n: NormalizedChatwootEvent,
): void {
  trackConversationMirror(tenantId, instanceId, n).done(true);
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
  s.mirroring.clear();
}
