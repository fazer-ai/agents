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

// One row the mirror writes from a payload, and what the payload states for it. The conversation row,
// the contact and the inbox are separate because the contact and the inbox are shared by other
// conversations, whose deliveries write them too.
interface Part {
  key: string;
  digest: string;
  // The row's own ordering clocks, as the mirror compares them: a strictly older position writes
  // nothing, a tie goes to the last writer (or empties a contact field), a newer one wins.
  pos: number[];
}

interface RowRecord {
  digest: string;
  pos: number[];
}

interface InFlight {
  digests: Map<string, number>;
  // Runs with different snapshots of the row overlapped: their commit order is not their completion
  // order, so none of them can say what the row holds.
  conflicted: boolean;
}

interface Store {
  messages: Map<string, string>;
  rows: Map<string, RowRecord>;
  mirroring: Map<string, InFlight>;
  // Deliveries this process accepted and has not mirrored yet, per row: they will write when their
  // turn comes, so a row they would change is not known until then.
  pending: Map<string, Map<string, number>>;
  pendingByDelivery: Map<string, Part[]>;
}

const KEY = Symbol.for("fazerai.chatwoot.unchangedUpdates.v2");

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

const clock = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;

// What a payload states for each row the mirror writes from it. The conversation row leaves out the
// event's own name and `changed_attributes`, the message, and what belongs to the shared rows. The
// inbox part exists only where the payload names the inbox (a message event); a conversation event
// writes no name. The inbox's channel type is fixed in Chatwoot and is compared with the conversation.
function partsOf(
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
): Part[] {
  const parts: Part[] = [];
  const version = clock(n.conversationUpdatedAt);
  const activity = clock(n.lastActivityAt);
  if (n.conversationId !== null) {
    const {
      event: _event,
      message: _message,
      changedAttributes: _changed,
      inboxName: _inboxName,
      contact: _contact,
      ...snapshot
    } = n;
    parts.push({
      key: `c:${tenantId}:${instanceId}:${n.conversationId}`,
      digest: digest(snapshot),
      pos: [version, activity],
    });
  }
  if (n.contact != null && n.contact.id != null) {
    parts.push({
      key: `k:${tenantId}:${instanceId}:${n.contact.id}`,
      digest: digest(n.contact),
      pos: [activity],
    });
  }
  if (n.inboxId != null && n.inboxName != null) {
    parts.push({
      key: `b:${tenantId}:${instanceId}:${n.inboxId}`,
      digest: digest(n.inboxName),
      pos: [Math.max(version, activity)],
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
): boolean {
  if (agentBotId === null || !droppableShape(n)) return false;
  const s = store();
  const seen = s.messages.get(
    messageKey(tenantId, instanceId, agentBotId, n.message?.id as number),
  );
  if (seen === undefined || seen !== messageDigest(n)) return false;
  return partsOf(tenantId, instanceId, n).every(
    (part) =>
      s.rows.get(part.key)?.digest === part.digest && !rowUnsettled(s, part),
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
export function markDeliveryPending(
  deliveryRowId: bigint,
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
): void {
  const s = store();
  const id = String(deliveryRowId);
  if (s.pendingByDelivery.has(id)) return;
  const parts = partsOf(tenantId, instanceId, n);
  s.pendingByDelivery.set(id, parts);
  for (const part of parts) {
    const m = s.pending.get(part.key) ?? new Map<string, number>();
    bump(m, part.digest, 1);
    s.pending.set(part.key, m);
  }
}

export function settleDeliveryPending(deliveryRowId: bigint): void {
  const s = store();
  const id = String(deliveryRowId);
  const parts = s.pendingByDelivery.get(id);
  if (parts === undefined) return;
  s.pendingByDelivery.delete(id);
  for (const part of parts) {
    const m = s.pending.get(part.key);
    if (m === undefined) continue;
    bump(m, part.digest, -1);
    if (m.size === 0) s.pending.delete(part.key);
  }
}

type Order = "ahead" | "behind" | "mixed";

function orderOf(run: number[], held: number[]): Order {
  let ahead = true;
  let behind = true;
  for (let i = 0; i < run.length; i++) {
    const a = run[i] as number;
    const b = held[i] as number;
    if (Number.isNaN(a) || Number.isNaN(b)) return "mixed";
    if (!(a >= b)) ahead = false;
    if (!(a < b)) behind = false;
  }
  return ahead ? "ahead" : behind ? "behind" : "mixed";
}

// Around every mirror run (`mirrorOncePerEvent`, the one path every delivery, drain and recovery
// mirrors through), per row it writes. The record is a snapshot whose re-application writes nothing:
// the last one a run applied whole, since the row has seen no other write from this process after it.
// A run strictly behind the record on every clock of the row writes nothing there (each of them
// refuses an older position), so the record stands. Any other ending (a write held back, a throw, runs
// with different snapshots overlapping, whose commit order nobody knows) forgets the record, so the
// next receipt reaches the mirror.
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
        const held = s.rows.get(part.key);
        if (!whole || flight.conflicted) {
          s.rows.delete(part.key);
        } else if (held !== undefined && held.digest === part.digest) {
          // The same snapshot again writes nothing new; the record stands.
        } else if (held === undefined) {
          setBounded(
            s.rows,
            part.key,
            { digest: part.digest, pos: part.pos },
            UNCHANGED_UPDATE_ROWS_MAX,
          );
        } else if (orderOf(part.pos, held.pos) !== "behind") {
          setBounded(
            s.rows,
            part.key,
            { digest: part.digest, pos: part.pos },
            UNCHANGED_UPDATE_ROWS_MAX,
          );
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
} {
  const s = store();
  return { messages: s.messages.size, rows: s.rows.size };
}

export function resetUnchangedUpdateRecords(): void {
  const s = store();
  s.messages.clear();
  s.rows.clear();
  s.mirroring.clear();
  s.pending.clear();
  s.pendingByDelivery.clear();
}
