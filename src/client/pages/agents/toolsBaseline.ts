// The Tools tab's dirty snapshot holds the non-RAG grants AND the tool config (handoff, labels,
// crossInboxCase, sendImage, ...). The Knowledge save persists the whole grant set and none of that
// config, so after it only the grants half of the Tools baseline may move: recapturing all of it
// would mark an unsaved config edit as saved and let the page be left without a warning.
export function rebaseToolGrants(baseline: string, snapshot: string): string {
  const old = JSON.parse(baseline) as Record<string, unknown>;
  const now = JSON.parse(snapshot) as Record<string, unknown>;
  return JSON.stringify({ ...old, grants: now.grants });
}

// The same move after a write whose grants are known from its response (a rule's "Allow"): the
// grants half becomes what the server stored, not the form, which the operator may have edited on
// Tools while the request ran. Taking the form would mark those edits as saved.
export function rebaseToolGrantsOnto(
  baseline: string,
  writtenGrants: string,
): string {
  return rebaseToolGrants(baseline, JSON.stringify({ grants: writtenGrants }));
}
