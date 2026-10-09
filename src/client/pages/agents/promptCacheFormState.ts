import {
  PROVIDERS_WITH_PROMPT_CACHE,
  PROVIDERS_WITH_PROMPT_CACHE_1H,
} from "@/graph/prompt-cache";

// The General tab's prompt-cache fields, as stored in `modelConfig`. Empty means "not set" (`auto`, a
// 5m prefix, a conversation that follows the prefix), so an untouched form stores nothing. The backend
// refuses the fields off the providers that need marks, so a leftover from a provider swap is dropped;
// a TTL means nothing with the cache off; and a 1h conversation behind a 5m prefix is refused by the
// API, so the form never sends it.
export function promptCacheToStored(model: {
  provider: string;
  promptCache: string;
  promptCacheTtl: string;
  promptCacheConversationTtl: string;
}): Record<string, string> {
  if (
    !(PROVIDERS_WITH_PROMPT_CACHE as readonly string[]).includes(model.provider)
  )
    return {};
  const out: Record<string, string> = {};
  if (model.promptCache) out.promptCache = model.promptCache;
  if (model.promptCache === "off") return out;
  // Only the providers that report a 1h write apart from a 5m one take a TTL at all.
  if (
    !(PROVIDERS_WITH_PROMPT_CACHE_1H as readonly string[]).includes(
      model.provider,
    )
  )
    return out;
  if (model.promptCacheTtl) out.promptCacheTtl = model.promptCacheTtl;
  const conv = model.promptCacheConversationTtl;
  if (conv && !(conv === "1h" && model.promptCacheTtl !== "1h"))
    out.promptCacheConversationTtl = conv;
  return out;
}
