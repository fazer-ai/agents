import { readModelFallbackConfig } from "@/graph/fallback-settings";
import type { ModelFallbackState } from "./BehaviorTab";

// The agent editor's fallback-provider block, as a pair of pure functions: stored settings → form
// state → stored settings. Outside the page for the reason the memory and TTS pairs are: the
// Behavior save REPLACES the whole block with what the form holds, so a field the form does not
// carry is not merely un-editable, it is DELETED on the next save. The round-trip test over this
// pair is what makes the next such field impossible to add silently.

export function modelFallbackToForm(settings: unknown): ModelFallbackState {
  const c = readModelFallbackConfig(settings);
  return {
    provider: c.provider ?? "",
    model: c.model ?? "",
    credentialRef: c.credentialRef ?? "",
    baseURL: c.baseURL ?? "",
  };
}

export function modelFallbackToStored(form: ModelFallbackState): {
  provider: string | null;
  model: string | null;
  credentialRef: string | null;
  baseURL: string | null;
} {
  return {
    // NOTE: blank is stored as null, not "". The reader treats both as absent, but null is what a
    // bag written before this feature holds, so a saved agent stays byte-comparable with an
    // untouched one.
    provider: form.provider || null,
    model: form.model || null,
    credentialRef: form.credentialRef || null,
    baseURL: form.baseURL || null,
  };
}

// The keys the reader produces, for the test that asserts the form carries all of them. Exported
// rather than inlined in the test so the list cannot be written to match the form.
export function modelFallbackReaderKeys(): string[] {
  return Object.keys(readModelFallbackConfig({})).sort();
}
