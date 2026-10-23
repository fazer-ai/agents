import type { MediaAnnotation } from "@/modules/chatwoot/annotations";
import {
  mediaAnnotationFor,
  overlayMediaAnnotations,
} from "@/modules/chatwoot/annotations";
import type { ChatwootMessageRow } from "@/modules/chatwoot/messages";

// What the reading does with a customer message's media (docs/occurrences.md, "Readings"). It never
// waits on a producer: a message's content is complete or it is not, and an incomplete one younger
// than the grace period defers the conversation; older, it is read with the renderer's marker.
// `none`: no media, or not the customer's. `complete`: every voice note has words (or none to
// have), every file its content. `incomplete`: something is not here yet, or never will be.
export type MediaState = "none" | "complete" | "incomplete";

// Long enough for the arrival pass to finish a message's files and voice note, and inside the
// in-process memory that holds them on upstream Chatwoot (15 minutes).
export const READING_MEDIA_GRACE_MS = 10 * 60_000;

export function mediaStateOf(
  row: ChatwootMessageRow,
  // The arrival pass's result in this process, when it still holds one.
  stashed: MediaAnnotation | null,
): MediaState {
  if (row.messageType !== "incoming") return "none";
  const audio = row.attachmentTypes.includes("audio");
  const visual = row.visuals.length > 0;
  if (!audio && !visual) return "none";
  const heard =
    !audio ||
    Boolean(row.transcribedText) ||
    Boolean(stashed?.transcriptionEmpty);
  // The pass stashes its files' result once, when every file is through; a file's own meta is
  // written one at a time, so it counts only when every file carries one.
  const seen =
    !visual ||
    Boolean(
      stashed?.imageDescription ||
        stashed?.extractedText ||
        stashed?.attachmentsUnread ||
        stashed?.bodyRead,
    ) ||
    row.visuals.every((v) => Boolean(v.imageDescription || v.extractedText));
  return heard && seen ? "complete" : "incomplete";
}

// Overlays what this process holds and decides at once: defer while an incomplete message is
// younger than the grace period, else read. A message with no time reads as old. The rows are
// filled in place, as `overlayMediaAnnotations` does.
export function settleMedia(
  tenantId: bigint,
  instanceId: bigint,
  rows: ChatwootMessageRow[],
  now: Date,
  graceMs: number = READING_MEDIA_GRACE_MS,
): { verdict: "read" | "defer"; states: MediaState[] } {
  // The memory's own clock for what it holds; the round's for how old a message is.
  overlayMediaAnnotations(tenantId, instanceId, rows);
  const states = rows.map((r) =>
    mediaStateOf(r, mediaAnnotationFor(tenantId, instanceId, r.id)),
  );
  const young = (r: ChatwootMessageRow) =>
    r.createdAt != null && now.getTime() - r.createdAt.getTime() < graceMs;
  const defer = rows.some((r, k) => states[k] === "incomplete" && young(r));
  return { verdict: defer ? "defer" : "read", states };
}
