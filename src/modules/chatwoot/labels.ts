import {
  closeKeyedQueueTail,
  keyedQueueTail,
  withKeyedQueue,
} from "@/lib/locks";

// The one critical section for a conversation's labels. `POST /conversations/:id/labels` replaces
// the whole set and Chatwoot has no compare-and-set, so every read-modify-write (`set_labels`, the
// nudge's `assignLabels`, the observer's verdict, the reset's clear) runs in this queue, or a later
// POST silently erases what an earlier one added.
//
// A free function, not a client method: the client is stubbed by object literals across the suite,
// and a double that forgot the queue would run unserialized. The key is the tenant, not the
// account: the tool context carries no instance, and a key two writers spell differently is no queue.
export function withConversationLabels<T>(
  tenantId: bigint | null | undefined,
  conversationId: number,
  fn: () => Promise<T>,
  // Offered to later callers as the entry they may join (`conversationLabelsTail`).
  tail?: object,
): Promise<T> {
  return withKeyedQueue(labelsKey(tenantId, conversationId), fn, tail);
}

function labelsKey(
  tenantId: bigint | null | undefined,
  conversationId: number,
): string {
  const scope = tenantId == null ? "?" : String(tenantId);
  return `labels:${scope}:${conversationId}`;
}

// The joinable entry at the tail of the conversation's label queue, if the last writer queued there
// offered one. Whatever was queued after it (another writer, the reset's clear) took it away.
export function conversationLabelsTail(
  tenantId: bigint | null | undefined,
  conversationId: number,
): object | undefined {
  return keyedQueueTail(labelsKey(tenantId, conversationId));
}

export function closeConversationLabelsTail(
  tenantId: bigint | null | undefined,
  conversationId: number,
  tail: object,
): void {
  closeKeyedQueueTail(labelsKey(tenantId, conversationId), tail);
}
