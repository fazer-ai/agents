import type {
  ChatwootClient,
  CustomAttributeDef,
} from "@/modules/chatwoot/client";

// The account's "vocabulary" the agent should write FROM, not guess: existing label titles + custom
// attribute definitions (per model). Surfaced in the set_labels / set_custom_attribute tool
// descriptions so the model picks known values instead of inventing them.
export interface ChatwootVocab {
  labels: string[];
  attributes: CustomAttributeDef[];
}

// Per-instance TTL cache (mirrors handoff/targets.ts): a bursty inbox does not re-list labels +
// attribute definitions on every turn, but an operator who adds one sees it within the window.
const TTL_MS = 60_000;
const cache = new Map<string, { value: ChatwootVocab; expires: number }>();

// Fetches (and caches) the account's labels + custom attribute definitions. `cacheKey` identifies the
// Chatwoot instance (e.g. `${tenantId}:${instanceId}`); `now` is injectable for tests. Does NOT
// swallow errors — the caller treats a throw as "no vocab" (the tools still work, just ungrounded).
export async function loadChatwootVocab(
  client: ChatwootClient,
  cacheKey: string,
  now: number = Date.now(),
): Promise<ChatwootVocab> {
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > now) return hit.value;
  const [labels, attributes] = await Promise.all([
    client.listLabels(),
    client.listCustomAttributeDefinitions(),
  ]);
  const value: ChatwootVocab = { labels, attributes };
  cache.set(cacheKey, { value, expires: now + TTL_MS });
  return value;
}

// Attribute definitions for one model (conversation_attribute | contact_attribute | task_attribute).
export function attributesForModel(
  vocab: ChatwootVocab | undefined,
  model: string,
): CustomAttributeDef[] {
  return (vocab?.attributes ?? []).filter((a) => a.model === model);
}

// DROP ONE INSTANCE'S ENTRY, because the catalog we are holding is provably wrong: `set_labels`
// sends the model's own strings and Chatwoot CREATES a tag its label list does not have, so the
// moment a write names a title this cache never listed, every reader of it is describing an account
// that no longer exists. Waiting out the TTL is up to a minute of a label that cannot be recognised
// anywhere — in the tool's own suggestion list, and in the observer's label history, where a change
// invisible for a minute is exactly the churn the history exists to show (issue #642, round 3).
export function invalidateChatwootVocab(cacheKey: string): void {
  cache.delete(cacheKey);
}

// Test-only: drop all cached entries so cases don't leak TTL state into one another.
export function __resetChatwootVocabCache(): void {
  cache.clear();
}
