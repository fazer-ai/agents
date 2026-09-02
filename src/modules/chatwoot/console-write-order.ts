/**
 * Ordering a console write that could not be versioned, by the SOURCE's message sequence
 * (issue #469).
 *
 * Pure: no DB, no clock, no network. The console stamps what `consoleWriteMark` computes, and the
 * human-reply takeover's fence asks `consoleWriteLandedAfter` what a stored mark means.
 *
 * ## The gap this fills, in one paragraph
 *
 * `mirrorConsoleWrite` writes Chatwoot FIRST and mirrors afterwards, and its live read is what earns
 * that mirror write a version. When the read fails or carries none (issue #77), the row is written
 * blind: only the fields the action meant to change, with every ordering mark left exactly where the
 * pre-click state put them. The takeover's freshness check is a comparison against one of those
 * marks, so a delivery Chatwoot serialized BEFORE the click compares equal-or-newer, passes, and
 * takes the conversation over — undoing the operator who just asked for the agent back.
 *
 * ## Why neither existing axis can answer it
 *
 * A VERSION cannot: the console has none to offer on that branch, and the delivery's own version
 * cannot say whether it predates a write made on this side, because a customer message advances
 * `conversation.updated_at` on its own account (measured on the fork: 1788291197.7034419 →
 * 1788291197.720337). A snapshot frozen a moment before our write compares greater exactly like one
 * frozen after it. That is the same finding status-claim.ts opens with, reached from the other side.
 *
 * The STATUS CLAIM cannot either, and it was tried, measured and removed in review round 1 of #468,
 * in both directions. On the mirror side it fences the wrong thing: the console has already written
 * to Chatwoot by the time it mirrors, so nothing is in flight, and the claim refused the state every
 * later payload was reporting. On the fence side it trades a mild harm for a worse one: a claim
 * outstanding makes the takeover skip ANY human reply for its lifetime, including one typed AFTER
 * the click — a real handover — which is the defect #430 exists to close, reintroduced by the guard.
 *
 * A local CLOCK cannot: our timestamp dates the moment our code reached a line, and between the
 * event and that line sit an ack, a detached dispatch and possibly another replica
 * (../../graph/reset-episode.ts, and padroes.md has the four anchors #447 walked through before
 * landing on the same answer this file lands on).
 *
 * ## The axis that does
 *
 * Chatwoot's own message sequence. Message ids are per account and monotonic, a human reply IS a
 * message, and the console's live read renders the newest one the source knows about. So the mark
 * is: THE LATEST MESSAGE CHATWOOT KNEW ABOUT WHEN THIS SIDE WROTE THE ROW WITHOUT A VERSION. A
 * human-reply delivery at or below it already existed when the operator clicked, so the click is the
 * later decision; one above it was written afterwards, and is a genuine handover the takeover must
 * still act on. That is exactly the property the status claim could not offer, and it is why the
 * mark needs no deadline: it expires by construction, because the next message carries a bigger id.
 *
 * MEASURED, and this is what makes the axis available on the population that needs it: `json.messages`
 * has been in the REST show partial since 2020-03-06, while `json.updated_at conversation.updated_at.to_f`
 * arrived 2025-02-10 (upstream #10875, released in 4.0.2). Confirmed by reading the partial at v2.16.0
 * and v3.0.0, which render `messages` and `last_non_activity_message` and no `updated_at` at all: every
 * deployment whose fallback is the ONLY path renders the sequence this orders by.
 *
 * ## What the sequence does NOT promise, measured rather than assumed
 *
 * The mark comes from `dashboard_seed_message`, which Chatwoot selects with `ORDER BY created_at DESC,
 * id DESC` — an order that is not the id order. Counted on the local fork's account 1, over 6315
 * conversations: the seed IS the conversation's highest id in 6218 of them and sits BELOW it in 97
 * (1.5%), all of them conversations that received a bulk write carrying past timestamps (1626 messages
 * with a high id and a `created_at` over a month old; 127 conversations where the id order and the
 * `created_at` order disagree internally).
 *
 * That costs coverage and nothing else, because of the asymmetry above: the seed is always a message
 * that EXISTS, so the mark can land below the newest id but never above it. On those conversations a
 * reply frozen between the mark and the true maximum still gets through, which is the defect as it
 * stands. The opposite — a reply written after the click landing at or below the mark, which would
 * skip a real handover — would need the mark to name a message that does not exist yet, and no
 * reading of that endpoint can produce one.
 *
 * ## Where it does not reach, stated rather than implied
 *
 * The other half of the fallback: a live read that FAILED outright leaves no mark, because the id
 * this needs is the id of a message Chatwoot has and we have not seen yet — no watermark of ours can
 * supply it (`lastHandledMessageId`, `lastRepliedMessageId` and the thread's sync marks all name
 * messages we DID see, and the colleague's reply is by definition not one of them). There the
 * behaviour is what it was before this file existed, and an operator who watches the conversation
 * leave the agent again clicks a second time.
 *
 * Both ends of the comparison fail toward the SAME direction, deliberately. A mark that is too LOW
 * lets a pre-click delivery through, which is the defect as it stands and costs a round trip. A mark
 * that is too HIGH skips a real handover, which is #430 and costs the agent answering over a person.
 * So every source of the mark must be a message that DEMONSTRABLY already existed, never an estimate
 * of the newest one.
 */

// THE MARK a console write leaves, from a live read it could not version.
//
// `null` means there is nothing to stamp, and the two ways to get there are different facts that the
// caller must not merge: the read failed (no `live` at all), or it succeeded on a conversation whose
// message list the payload did not render. Both leave the previous mark standing, which is right —
// an older mark orders strictly less than a newer one would, and this axis only ever fails low.
export function consoleWriteMark(
  live: { latestMessageId: number | null } | null,
): number | null {
  return live?.latestMessageId ?? null;
}

// Did the console write land AFTER the message that drove this delivery?
//
// AT OR BELOW, not below: the mark names a message the source already had when the click was made,
// so a delivery carrying that same message is one the operator was looking at. This is the same
// boundary `resetLandedAfter` draws for /reset, for the same reason and in the same order.
export function consoleWriteLandedAfter(
  triggerMessageId: number | null,
  consoleWriteAtMessageId: number | null,
): boolean {
  // No mark is not evidence of anything: either no console write has been made unversioned here, or
  // the one that was could not read a message id. Neither says the delivery is stale.
  if (consoleWriteAtMessageId === null) return false;
  // And no trigger is a caller that named no message — the recovery of issue #439 running on a
  // ledger row an older build wrote, a test. The fence has nothing to order, and refusing on an
  // unknown would skip a takeover on no evidence at all.
  if (triggerMessageId === null) return false;
  return triggerMessageId <= consoleWriteAtMessageId;
}
