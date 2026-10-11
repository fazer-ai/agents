import { createHash } from "node:crypto";
import type { NormalizedChatwootEvent } from "./types";

// A `message_updated` of the business's own message whose payload repeats, field for field, the last
// payload of that same message this process processed on the same bot route: a delivery receipt
// (`source_id`, delivered, read). The wire names neither the status nor what changed, so the question
// asked is whether the update carries anything an already processed payload of the message did not.
// Nothing here reads the mirror: a payload that differs in anything meaningful is processed, and one
// that does not has nothing to write that was not written. docs/chatwoot.md, "Webhook receiver", 3a.

// How many messages are remembered: one key and one digest each (about 150 bytes), oldest out first.
export const REPEATED_UPDATE_MESSAGES_MAX = 20_000;

const KEY = Symbol.for("fazerai.chatwoot.repeatedUpdates.v1");

function store(): Map<string, string> {
  const g = globalThis as unknown as Record<
    symbol,
    Map<string, string> | undefined
  >;
  const held = g[KEY];
  if (!(held instanceof Map)) g[KEY] = new Map();
  return g[KEY] as Map<string, string>;
}

// Left out: only what carries nothing the mirror or the agent reads. The conversation's version and
// activity stay in: they are the positions the mirror orders by, so a dropped update is an exact repeat
// of a payload already applied, at the same positions. Delivery status and `source_id` are not normalized.
function payloadDigest(n: NormalizedChatwootEvent): string {
  const {
    event: _event, // names the dispatch (created or updated), not the state
    changedAttributes: _changed, // never sent with `message_updated`
    factsOnCreateOnly: _createOnly, // set only on a recovery's rebuilt body, never on the wire
    createActivityAt: _createAt, // same
    ...meaningful
  } = n;
  return createHash("sha256")
    .update(
      JSON.stringify(meaningful, (_k, v) =>
        typeof v === "bigint" ? `${v}n` : v,
      ),
    )
    .digest("base64");
}

function recordKey(
  tenantId: bigint,
  instanceId: bigint,
  agentBotId: number,
  messageId: number,
): string {
  return `${tenantId}:${instanceId}:${agentBotId}:${messageId}`;
}

// The business's own message, the only kind a repeat is dropped for and so the only kind recorded.
function businessMessageId(n: NormalizedChatwootEvent): number | null {
  const m = n.message;
  if (m === undefined || m.id === null) return null;
  return m.messageType === "outgoing" || m.messageType === "template"
    ? m.id
    : null;
}

// Whether this delivery may be acked and dropped before the ledger row.
export function isRepeatedMessageUpdate(
  tenantId: bigint,
  instanceId: bigint,
  agentBotId: number,
  n: NormalizedChatwootEvent,
): boolean {
  if (n.event !== "message_updated") return false;
  const id = businessMessageId(n);
  if (id === null || n.message?.externalError) return false;
  // A Chatwoot before 4.0.2 sends no version: equal payloads can be two transitions (open, resolved,
  // open again), and each is mirrored, as `mirrorOncePerEvent` does.
  if (n.conversationUpdatedAt == null) return false;
  const seen = store().get(recordKey(tenantId, instanceId, agentBotId, id));
  return seen !== undefined && seen === payloadDigest(n);
}

// Taken when the delivery starts processing; the returned function records it, and is called only
// once the delivery was processed on this route with its mirror fully applied.
export function recordOnSuccess(
  tenantId: bigint,
  instanceId: bigint,
  agentBotId: number | null,
  n: NormalizedChatwootEvent,
): () => void {
  const id = businessMessageId(n);
  if (agentBotId === null || id === null) return () => {};
  const key = recordKey(tenantId, instanceId, agentBotId, id);
  const digest = payloadDigest(n);
  return () => {
    const s = store();
    // Re-inserted so the most recently processed message is the last evicted.
    s.delete(key);
    s.set(key, digest);
    while (s.size > REPEATED_UPDATE_MESSAGES_MAX) {
      const oldest = s.keys().next().value;
      if (oldest === undefined) break;
      s.delete(oldest);
    }
  };
}

export function repeatedUpdateRecordCount(): number {
  return store().size;
}

export function resetRepeatedUpdateRecords(): void {
  store().clear();
}
