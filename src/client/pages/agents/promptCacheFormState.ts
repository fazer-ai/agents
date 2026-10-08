import { PROVIDERS_WITH_PROMPT_CACHE } from "@/graph/prompt-cache";

// The General tab's prompt-cache field, as stored in `modelConfig`. Empty means "not set" (`auto`), so
// an untouched form stores nothing. The backend refuses the field off the providers that need marks,
// so a leftover from a provider swap is dropped.
export function promptCacheToStored(model: {
  provider: string;
  promptCache: string;
}): Record<string, string> {
  if (
    !(PROVIDERS_WITH_PROMPT_CACHE as readonly string[]).includes(model.provider)
  )
    return {};
  return model.promptCache ? { promptCache: model.promptCache } : {};
}
