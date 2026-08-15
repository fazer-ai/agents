// What a review actually changed, and therefore what the console sends to
// `PATCH /v1/knowledge/approvals/:id`.
//
// The rule that needed a name: `editApprovalItem` unconditionally stamps the item `EDITED`, and that
// status is a claim about a human ("someone revised this before approving it"). Opening the editor
// and closing it must not make that claim, so a review with nothing changed sends nothing at all. A
// status that lies is worse than no status: the reviewer of the next queue reads `EDITED` as "the
// wording was already looked at".
//
// Comparison is on trimmed text because the textarea round-trips a trailing newline that no reviewer
// typed and that no reader would call a revision.

export interface ApprovalOriginal {
  proposedTitle: string | null;
  proposedContent: string;
}

export interface ApprovalDraft {
  title: string;
  content: string;
}

export interface ApprovalEditPatch {
  title?: string;
  content?: string;
}

// Returns null when there is nothing to send: unchanged text, or a draft whose content was emptied
// (an entry with no content is not a revision, and the endpoint would happily store it).
//
// NOTE: A title cleared to blank is deliberately NOT sent. The endpoint has no way to express "no
// title" — it writes the string it is given, and an empty one would become the approved document's
// title, since the fallback there only catches null. Clearing a label is not what this affordance is
// for; rewriting the content is.
export function approvalEditPatch(
  original: ApprovalOriginal,
  draft: ApprovalDraft,
): ApprovalEditPatch | null {
  const content = draft.content.trim();
  if (!content) return null;
  const patch: ApprovalEditPatch = {};
  if (content !== original.proposedContent.trim()) patch.content = content;
  const title = draft.title.trim();
  if (title && title !== (original.proposedTitle ?? "").trim()) {
    patch.title = title;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
