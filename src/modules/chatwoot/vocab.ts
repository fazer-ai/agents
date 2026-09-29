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
const labelCache = new Map<string, { value: string[]; expires: number }>();

// Fetches (and caches) the account's labels + custom attribute definitions. `cacheKey` identifies the
// Chatwoot instance (e.g. `${tenantId}:${instanceId}`); `now` is injectable for tests. Does NOT
// swallow errors: the caller treats a throw as "no vocab" (the tools still work, just ungrounded).
export async function loadChatwootVocab(
  client: ChatwootClient,
  cacheKey: string,
  now: number = Date.now(),
): Promise<ChatwootVocab> {
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > now) return hit.value;
  // A labels-only entry still in date answers the labels half. The observation tick reads the
  // labels alone and `buildToolset` asks for the pair moments later, so without this the same catalog
  // is fetched twice per TTL, sequentially, inside the same observation deadline.
  const warm = labelCache.get(cacheKey);
  const borrowed = warm !== undefined && warm.expires > now;
  const [labels, attributes] = await Promise.all([
    borrowed ? Promise.resolve(warm.value) : client.listLabels(),
    client.listCustomAttributeDefinitions(),
  ]);
  const value: ChatwootVocab = { labels, attributes };
  // NOTE: borrowed labels keep the expiry they came with. A fresh TTL on a catalog read most of a
  // window ago leaves a label created in between invisible for nearly two windows instead of one, and
  // the attribute endpoint recovering after a spell of failures is exactly when that entry is oldest.
  cache.set(cacheKey, {
    value,
    expires: borrowed ? Math.min(now + TTL_MS, warm.expires) : now + TTL_MS,
  });
  return value;
}

// Attribute definitions for one model (conversation_attribute | contact_attribute | task_attribute).
export function attributesForModel(
  vocab: ChatwootVocab | undefined,
  model: string,
): CustomAttributeDef[] {
  return (vocab?.attributes ?? []).filter((a) => a.model === model);
}

// The labels alone, for a caller that needs no attribute definitions (the observer's label history).
// The combined read is two requests under one `Promise.all`, so an attribute endpoint that is down
// takes a good label catalog with it, and re-asking would pay a fresh `/labels` every tick since a
// failed combined read caches nothing. Reads the combined entry when warm, keeps its own otherwise,
// never fetches the definitions; the combined read answers its labels half from this entry too.
export async function loadChatwootLabels(
  client: ChatwootClient,
  cacheKey: string,
  now: number = Date.now(),
): Promise<string[]> {
  const vocabHit = cache.get(cacheKey);
  if (vocabHit && vocabHit.expires > now) return vocabHit.value.labels;
  const hit = labelCache.get(cacheKey);
  if (hit && hit.expires > now) return hit.value;
  const labels = await client.listLabels();
  labelCache.set(cacheKey, { value: labels, expires: now + TTL_MS });
  return labels;
}

// Test-only: drop all cached entries so cases don't leak TTL state into one another.
export function __resetChatwootVocabCache(): void {
  cache.clear();
  labelCache.clear();
}
