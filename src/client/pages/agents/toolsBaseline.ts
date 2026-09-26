// The Tools tab's dirty snapshot holds the non-RAG grants AND the tool config (handoff, labels,
// crossInboxCase, sendImage, ...). The Knowledge save persists the whole grant set and none of that
// config, so after it only the grants half of the Tools baseline may move: recapturing all of it
// marks an unsaved config edit as saved, drops its Discard and lets the page be left without a
// warning, losing the edit (review round 1 of #887).
export function rebaseToolGrants(baseline: string, snapshot: string): string {
  const old = JSON.parse(baseline) as Record<string, unknown>;
  const now = JSON.parse(snapshot) as Record<string, unknown>;
  return JSON.stringify({ ...old, grants: now.grants });
}
