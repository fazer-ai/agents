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
// THIS IS NOW THE FAST HALF, NOT THE WHOLE ANSWER. It holds under the single-replica / one-leader
// invariant, where the webhook turn and the scheduler worker share this process and therefore this
// Map. On the scaled web tier docs/deploy.md §4 sanctions they do not, and the consumer whose
// cross-process failure is irreversible, continuous ingestion, whose append is undone AND recorded
// as handled, reads a busy thread as free. That half moved to ./thread-claim.ts, which keeps the
// claim in the thread's own row; this Map stays in front of it as the answer that costs no query,
// and it can only ever say MORE than the row, never less.
//
// What is left here alone is the key that has no row: the per-CONVERSATION thread the follow-up
// nudge claims, and the graph thread of a conversation whose contact inbox is unknown. Their cost is
// the one issue #203 measured: a nudge races one reply, a compaction is undone and re-armed at the
// next attendance boundary where the summary row already exists. Neither loses a message.
//
// Not durable by design, a process restart clears it, after which the next sweep re-evaluates
// purely from the persisted watermarks (lastEventAt / lastFollowUpAt).
// COUNTED, not a set of present keys. Two turns really do overlap on one thread — two deliveries for
// the same conversation race whenever debounce is off, and a follow-up nudge invokes on the same
// memory thread as a reactive turn — and with plain membership the first one to finish releases a
// claim the other is still holding. A compaction would then read the thread as idle, rewrite it, and
// have the surviving invoke undo the rewrite: exactly the failure the claim exists to prevent, made
// harder to see because it only happens under load.
const inFlight = new Map<string, number>();

// RESERVATIONS, counted the same way and kept in their own map. A reservation says "a turn is about
// to run on this thread and has not claimed it yet" — the stretch a delivery recovery holds between
// its own fence and `runAgentTurn` taking the claim (../modules/chatwoot/recover-delivery.ts). Every
// reader that asks "may I write this thread" has to see it, which is why `isTurnInFlight` counts
// both: a /reset, an append or a compaction landing in that stretch is undone by the turn that
// follows it.
//
// Separate from `inFlight` because ONE reader must not see it. `markTurnOwning` asks whether ANOTHER
// invoke was already reading the thread, and answers the boundary question with it — a `true` there
// defers the attendance divider and the marker, on the grounds that somebody else is mid-read. The
// reserving caller IS the invoke that is about to call it, so counting its own reservation made a
// recovered first turn on a reused contact thread run against the previous attendance with no
// divider (MEASURED). `isTurnRunning` is what that one asks.
const reserved = new Map<string, number>();

export function markTurnInFlight(threadId: string): void {
  inFlight.set(threadId, (inFlight.get(threadId) ?? 0) + 1);
}

// Hold the thread for a turn that has not started yet. Balanced by `clearTurnReserved`, and for the
// reason `clearTurnInFlight` gives: an unbalanced release hands the thread to a writer the reserving
// caller is about to undo.
export function markTurnReserved(threadId: string): void {
  reserved.set(threadId, (reserved.get(threadId) ?? 0) + 1);
}

export function clearTurnReserved(threadId: string): void {
  const left = (reserved.get(threadId) ?? 0) - 1;
  if (left > 0) reserved.set(threadId, left);
  else reserved.delete(threadId);
}

// Releases ONE claim. Callers must release exactly what they took: an unbalanced release is not a
// harmless no-op, it hands the thread to a compaction while another invoke is still reading it.
export function clearTurnInFlight(threadId: string): void {
  const left = (inFlight.get(threadId) ?? 0) - 1;
  if (left > 0) inFlight.set(threadId, left);
  else inFlight.delete(threadId);
}

// Either kind of hold: an invoke that is reading the thread, or a reservation for one that is about
// to. This is the answer every writer wants.
export function isTurnInFlight(threadId: string): boolean {
  return (inFlight.get(threadId) ?? 0) > 0 || (reserved.get(threadId) ?? 0) > 0;
}

// INVOKES ONLY. One caller wants this and it is not a writer: see the note on `reserved` above.
export function isTurnRunning(threadId: string): boolean {
  return (inFlight.get(threadId) ?? 0) > 0;
}
