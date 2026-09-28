// The Tools tab's dirty snapshot holds the non-RAG grants AND the tool config (handoff, labels,
// crossInboxCase, sendImage, ...). The Knowledge save persists the whole grant set and none of that
// config, so after it only the grants half of the Tools baseline may move: recapturing all of it
// would mark an unsaved config edit as saved and let the page be left without a warning.
export function rebaseToolGrants(baseline: string, snapshot: string): string {
  const old = JSON.parse(baseline) as Record<string, unknown>;
  const now = JSON.parse(snapshot) as Record<string, unknown>;
  return JSON.stringify({ ...old, grants: now.grants });
}
