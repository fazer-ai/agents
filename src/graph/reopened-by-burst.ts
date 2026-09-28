import type { ChatwootMessageRow } from "@/modules/chatwoot/messages";

// Whether the customer messages a turn answers are what reopened a RESOLVED conversation (a
// thank-you after a close), so an `acknowledged` silence can put it back to `resolved`. Read off
// Chatwoot's activity trail: every status change by a person, the API or an automation writes a
// `conversation_status_changed` activity, but a contact's message reopening a bot inbox writes none.
// True only when the last status row is `resolved`, precedes the burst, and no other public message
// sits after it. Every uncertain edge (close scrolled off the page, the async activity row landing
// after the message, an operator reopen) answers false, leaving the conversation in `pending`.
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
