import { withKeyedQueue } from "@/lib/locks";

// THE ONE CRITICAL SECTION FOR A CONVERSATION'S LABELS (issue #477 review, round 3).
//
// `POST /conversations/:id/labels` REPLACES the whole set and Chatwoot offers no compare-and-set, so
// every internal read-modify-write of it has to run inside the same queue or the later POST erases
// what the earlier one added — silently, and with nothing able to detect it afterwards. Four writers
// share it: `assign_label`, the nudge's `assignLabels` merge, the observer's verdict, and the
// reset's clear.
//
// A FREE FUNCTION AND NOT A CLIENT METHOD, deliberately: the client is stubbed by object literals
// all over the suite, and a method on it would make every one of those doubles a prerequisite for
// the invariant holding — a double that forgot it would silently run unserialized, which is exactly
// the bug. Here the call site takes the queue and the double is not involved.
//
// THE SCOPE IS THE TENANT, and deliberately not the account (issue #477 review, round 4). A key that
// two writers spell differently is not a queue — the first cut of this used `<tenant>:<instance>`
// where the caller knew the instance and `<tenant>:?` where it did not, which is `assign_label`
// running beside the observer's verdict with nothing between them. The tool's context carries no
// instance, so the only key every writer can spell is the tenant's. What it costs is two installs
// of ONE tenant queueing behind each other on the same numeric conversation id, which serializes
// two calls that were never going to conflict; what the alternative costs is the erased label this
// exists to prevent.
export function withConversationLabels<T>(
  tenantId: bigint | null | undefined,
  conversationId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const scope = tenantId == null ? "?" : String(tenantId);
  return withKeyedQueue(`labels:${scope}:${conversationId}`, fn);
}
