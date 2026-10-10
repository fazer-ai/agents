import { createHash } from "node:crypto";
import type { NormalizedChatwootEvent } from "./types";

// A `message_updated` that repeats, for everything the receiver normalizes, what this process already
// processed for that message on that route and holds as mirrored in the rows it would write: a
// delivery receipt. The payload names neither the status nor what changed, so this is the question
// that can be asked. Never a customer message's update, nor a send failure. In memory and bounded; a
// miss processes the update as before. docs/chatwoot.md, "Webhook receiver", step 3a.

// How many messages and mirrored rows are remembered. A record is one key and one digest (about 150
// bytes), so the bound is a few MB; oldest-first eviction.
export const UNCHANGED_UPDATE_MESSAGES_MAX = 20_000;
export const UNCHANGED_UPDATE_ROWS_MAX = 20_000;

// One row the mirror writes from a payload, and what the payload states for it. The conversation row
// and the contact are separate because the contact is shared by other conversations, whose
// deliveries write it too. The inbox name is not compared: see the known limit in docs/chatwoot.md.
interface Part {
  key: string;
  digest: string;
}

interface InFlight {
  digests: Map<string, number>;
  // Runs with different snapshots of the row overlapped: their commit order is not their completion
  // order, so none of them can say what the row holds.
  conflicted: boolean;
}

interface Store {
  messages: Map<string, string>;
  // Per row, the snapshot the last mirror run of it applied whole.
  rows: Map<string, string>;
  mirroring: Map<string, InFlight>;
  // Deliveries this process accepted and has not mirrored yet, per row: they will write when their
  // turn comes, so a row they would change is not known until then.
  pending: Map<string, Map<string, number>>;
  // In acceptance order, so the oldest expire first.
  pendingByDelivery: Map<string, { parts: Part[]; at: number }>;
  // Until when no receipt is dropped, because the pending bookkeeping hit its bound and let go of
  // deliveries it could no longer follow.
  saturatedUntil: number;
}

const KEY = Symbol.for("fazerai.chatwoot.unchangedUpdates.v5");

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  const held = g[KEY];
  if (
    !held ||
    !(held.messages instanceof Map) ||
    !(held.rows instanceof Map) ||
    !(held.mirroring instanceof Map) ||
    !(held.pending instanceof Map) ||
    !(held.pendingByDelivery instanceof Map)
  ) {
    g[KEY] = {
      messages: new Map(),
      rows: new Map(),
      mirroring: new Map(),
      pending: new Map(),
      pendingByDelivery: new Map(),
      saturatedUntil: 0,
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

function messageDigest(n: NormalizedChatwootEvent): string {
  return digest(n.message);
}

// What a payload states for each row the mirror writes from it. The conversation row leaves out the
// event's own name and `changed_attributes`, the message, the contact (its own row) and the inbox
// name, which a message event carries and a conversation event does not, and which is not compared.
// The inbox's channel type is fixed in Chatwoot and is compared with the conversation.
function partsOf(
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
): Part[] {
  // No conversation, no mirror write at all (`mirrorChatwootEvent` returns before any row).
  if (n.conversationId === null) return [];
  const {
    event: _event,
    message: _message,
    changedAttributes: _changed,
    inboxName: _inboxName,
    contact,
    ...snapshot
  } = n;
  // The contact's identity stays with the conversation: the row links to it, and a payload naming a
  // contact the row does not have yet fills the link.
  const parts: Part[] = [
    {
      key: `c:${tenantId}:${instanceId}:${n.conversationId}`,
      digest: digest({ ...snapshot, contactId: contact?.id ?? null }),
    },
  ];
  if (contact != null && contact.id != null) {
    parts.push({
      key: `k:${tenantId}:${instanceId}:${contact.id}`,
      digest: digest(contact),
    });
  }
  return parts;
}

function messageKey(
  tenantId: bigint,
  instanceId: bigint,
  agentBotId: number,
  messageId: number,
): string {
  return `${tenantId}:${instanceId}:${agentBotId}:${messageId}`;
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

// Whether something other than this digest is about to be written to the row: a run in flight, or a
// delivery accepted and not mirrored yet.
function rowUnsettled(s: Store, part: Part): boolean {
  const differs = (m: Map<string, number> | undefined) =>
    m !== undefined && [...m.keys()].some((d) => d !== part.digest);
  return (
    differs(s.mirroring.get(part.key)?.digests) ||
    differs(s.pending.get(part.key))
  );
}

// Whether this delivery repeats, for everything the receiver reads, what this process already handled.
export function isUnchangedMessageUpdate(
  tenantId: bigint,
  instanceId: bigint,
  agentBotId: number | null,
  n: NormalizedChatwootEvent,
  now: number = Date.now(),
): boolean {
  if (agentBotId === null || !droppableShape(n)) return false;
  const s = store();
  if (now < s.saturatedUntil) return false;
  expirePending(s, now);
  const seen = s.messages.get(
    messageKey(tenantId, instanceId, agentBotId, n.message?.id as number),
  );
  if (seen === undefined || seen !== messageDigest(n)) return false;
  return partsOf(tenantId, instanceId, n).every(
    (part) => s.rows.get(part.key) === part.digest && !rowUnsettled(s, part),
  );
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

const bump = (m: Map<string, number>, k: string, by: number) => {
  const next = (m.get(k) ?? 0) + by;
  if (next > 0) m.set(k, next);
  else m.delete(k);
};

// A delivery this process accepted and will process: until its mirror runs (or it leaves for the
// delivery recovery, which rebuilds from Chatwoot as it stands), the rows it would write are unsettled.
// A marker the processing never releases (a throw, then the sweep settling the row, or a recovery
// that is not this path) expires after the longest a stored body waits for the drain
// (`STORED_DELIVERY_MAX_AGE_MS`, ./delivery-queue.ts); a body drained after that is a mirror run like
// any other, and the record follows it. Past the bound, the oldest marker goes and no receipt is
// dropped until it would have expired.
export const UNCHANGED_UPDATE_PENDING_MAX = 20_000;
export const UNCHANGED_UPDATE_PENDING_TTL_MS = 6 * 60 * 60 * 1000;

function releasePending(s: Store, id: string): void {
  const held = s.pendingByDelivery.get(id);
  if (held === undefined) return;
  s.pendingByDelivery.delete(id);
  for (const part of held.parts) {
    const m = s.pending.get(part.key);
    if (m === undefined) continue;
    bump(m, part.digest, -1);
    if (m.size === 0) s.pending.delete(part.key);
  }
}

function expirePending(s: Store, now: number): void {
  for (const [id, held] of s.pendingByDelivery) {
    if (held.at > now - UNCHANGED_UPDATE_PENDING_TTL_MS) break;
    releasePending(s, id);
  }
}

export function markDeliveryPending(
  deliveryRowId: bigint,
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
  now: number = Date.now(),
): void {
  const s = store();
  const id = String(deliveryRowId);
  if (s.pendingByDelivery.has(id)) return;
  expirePending(s, now);
  while (s.pendingByDelivery.size >= UNCHANGED_UPDATE_PENDING_MAX) {
    const oldest = s.pendingByDelivery.keys().next().value;
    if (oldest === undefined) break;
    releasePending(s, oldest);
    s.saturatedUntil = now + UNCHANGED_UPDATE_PENDING_TTL_MS;
  }
  const parts = partsOf(tenantId, instanceId, n);
  s.pendingByDelivery.set(id, { parts, at: now });
  for (const part of parts) {
    const m = s.pending.get(part.key) ?? new Map<string, number>();
    bump(m, part.digest, 1);
    s.pending.set(part.key, m);
  }
}

export function settleDeliveryPending(deliveryRowId: bigint): void {
  releasePending(store(), String(deliveryRowId));
}

// Around every mirror run (`mirrorOncePerEvent`, the one path every delivery, drain and recovery
// mirrors through), per row it writes. The record is a snapshot whose re-application writes nothing:
// the last one a run applied whole, since this process has written nothing else to the row after
// it. Last, not newest: the rows order their fields by several clocks (version, activity, the
// pairing's own mark), and an older event still writes what its own clock lets it. Any other ending
// (a write held back, a throw, runs with different snapshots overlapping, whose commit order nobody
// knows) forgets the record, so the next receipt reaches the mirror.
export function trackConversationMirror(
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
): { done: (whole: boolean) => void } {
  const s = store();
  const parts = partsOf(tenantId, instanceId, n);
  const flights = parts.map((part) => {
    const flight = s.mirroring.get(part.key) ?? {
      digests: new Map<string, number>(),
      conflicted: false,
    };
    if ([...flight.digests.keys()].some((d) => d !== part.digest)) {
      flight.conflicted = true;
    }
    bump(flight.digests, part.digest, 1);
    s.mirroring.set(part.key, flight);
    return flight;
  });
  let settled = false;
  return {
    done: (whole) => {
      if (settled) return;
      settled = true;
      parts.forEach((part, i) => {
        const flight = flights[i] as InFlight;
        if (whole && !flight.conflicted) {
          setBounded(s.rows, part.key, part.digest, UNCHANGED_UPDATE_ROWS_MAX);
        } else {
          s.rows.delete(part.key);
        }
        bump(flight.digests, part.digest, -1);
        if (flight.digests.size === 0 && s.mirroring.get(part.key) === flight) {
          s.mirroring.delete(part.key);
        }
      });
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
  rows: number;
  pending: number;
} {
  const s = store();
  return {
    messages: s.messages.size,
    rows: s.rows.size,
    pending: s.pendingByDelivery.size,
  };
}

export function resetUnchangedUpdateRecords(): void {
  const s = store();
  s.messages.clear();
  s.rows.clear();
  s.mirroring.clear();
  s.pending.clear();
  s.pendingByDelivery.clear();
  s.saturatedUntil = 0;
}
