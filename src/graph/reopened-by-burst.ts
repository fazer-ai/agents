import type { ChatwootMessageRow } from "@/modules/chatwoot/messages";

// Whether the customer messages a turn answers are what reopened a RESOLVED conversation (issue
// #897): a thank-you after a close, which an `acknowledged` silence should put back to `resolved`.
//
// Read off Chatwoot's own activity trail on the page the turn fetches, not off anything we record.
// `ActivityMessageHandler#status_change_activity` writes a `conversation_status_changed` activity,
// with the status in `content_attributes.activity`, for every status change made by a person, by
// the API (our own resolve included) or by an automation. It writes NONE when the contact's own
// message reopens a bot inbox's conversation (`Message#reopen_resolved_conversation` moves it to
// `pending` with no user and no `executed_by`, so the activity content is blank and skipped).
// Measured on one deployment's e-mail inbox over three days: 582 activities for the agent's
// resolves, 449 + 436 for automation reopens, none for a contact's reopen. So the trail answers
// the question directly, with no clock and no webhook ordering:
//
//   * the LAST status activity on the page says `resolved`, and it comes before the burst: the
//     conversation was closed and nothing since has reopened it except a message; and
//   * no public message sits between that activity and the burst: the burst is the first thing
//     anybody said after the close, not an "ok" later in an episode the reopen already started;
//   * nothing public comes after the burst either: a turn that runs late, after a newer message was
//     already answered, would otherwise close the case that newer message opened.
//
// Conservative on every edge, which leaves today's behaviour (the conversation waits in `pending`):
// the close scrolled off the page, a close written after the message (the activity job is
// asynchronous, so a thank-you seconds after the close can precede its row), an operator's reopen,
// any status row at all after the close.
export function burstReopenedResolved(
  page: readonly ChatwootMessageRow[],
  burstIds: readonly number[],
): boolean {
  if (burstIds.length === 0) return false;
  const burst = new Set(burstIds);
  const first = Math.min(...burstIds);
  const rows = [...page].sort((a, b) => a.id - b.id);
  const statusRows = rows.filter(
    (r) =>
      r.messageType === "activity" &&
      r.activityType === "conversation_status_changed" &&
      r.activityStatus != null,
  );
  const lastStatus = statusRows.at(-1);
  if (lastStatus?.activityStatus !== "resolved") return false;
  if (lastStatus.id > first) return false;
  // Public talk after the close that is not this burst: before it (the episode already started) or
  // after it (a newer exchange the close would cut off).
  const otherTalk = rows.some(
    (r) =>
      r.id > lastStatus.id &&
      !burst.has(r.id) &&
      !r.private &&
      (r.messageType === "incoming" || r.messageType === "outgoing"),
  );
  if (otherTalk) return false;
  // Every id of the burst is a customer's public message on this page: an id the page does not
  // carry is a burst we cannot vouch for.
  return [...burst].every((id) =>
    rows.some((r) => r.id === id && r.messageType === "incoming" && !r.private),
  );
}
