// In-memory registry of agent turns currently executing. The keys are thread ids, and a turn marks
// TWO of them because two different jobs need to know two different things:
//
//   - the per-conversation chatwoot thread (`tenant:instance:conversationId`), for the follow-up
//     handler: do not fire a proactive nudge in the MIDDLE of a long turn (a short follow-up delay
//     can elapse while the model is still thinking, and the nudge would race the agent's own reply);
//   - the per-contact-inbox GRAPH thread, for memory compaction: do not rewrite the message channel
//     while an invoke is reading it. A LangGraph invoke is a read-modify-write of the WHOLE channel
//     — it saves what it loaded at the start plus its own messages — so a rewrite that lands in the
//     middle is silently undone when the turn finishes, restoring the raw history it had just
//     replaced. Measured, not assumed: tests/modules/memory-compaction.test.ts pins the undo.
//
// The compaction key is marked INSIDE the `ingest:<graphThreadId>` lock, which is what makes the two
// sides exclusive rather than merely staggered: the rewrite holds that same lock while it checks
// here, so it either runs entirely before a turn's mark (and the turn then loads the rewritten
// state) or it sees the mark and defers. Marking outside the lock would leave the window where the
// rewrite checks an unmarked thread that is about to be read.
//
// Safe under the single-replica / one-leader invariant: the webhook turn and the scheduler worker
// share this process, so they share this Set. Not durable by design — a process restart clears it,
// after which the next sweep re-evaluates purely from the persisted watermarks (lastEventAt /
// lastFollowUpAt). At worst a restart mid-turn drops the guard for that one turn: the follow-up may
// race one reply, and one compaction may be undone — recovered at the next attendance boundary,
// where the summary row already exists and costs no second generation.
// COUNTED, not a set of present keys. Two turns really do overlap on one thread — two deliveries for
// the same conversation race whenever debounce is off, and a follow-up nudge invokes on the same
// memory thread as a reactive turn — and with plain membership the first one to finish releases a
// claim the other is still holding. A compaction would then read the thread as idle, rewrite it, and
// have the surviving invoke undo the rewrite: exactly the failure the claim exists to prevent, made
// harder to see because it only happens under load.
const inFlight = new Map<string, number>();

export function markTurnInFlight(threadId: string): void {
  inFlight.set(threadId, (inFlight.get(threadId) ?? 0) + 1);
}

// Releases ONE claim. Callers must release exactly what they took: an unbalanced release is not a
// harmless no-op, it hands the thread to a compaction while another invoke is still reading it.
export function clearTurnInFlight(threadId: string): void {
  const left = (inFlight.get(threadId) ?? 0) - 1;
  if (left > 0) inFlight.set(threadId, left);
  else inFlight.delete(threadId);
}

export function isTurnInFlight(threadId: string): boolean {
  return (inFlight.get(threadId) ?? 0) > 0;
}
