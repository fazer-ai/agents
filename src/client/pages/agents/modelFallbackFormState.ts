import { readModelFallbackConfig } from "@/graph/fallback-settings";
import { modelOptionalFor } from "@/graph/model-defaults";
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

// THE TWO VERDICTS THE EDITOR DRAWS FROM THIS BLOCK, out here rather than inline in the page because
// both of them decide something and neither can be tested through a page that only one test in the
// suite renders. They answer the SAME question the backend answers (`hasModelFallback`,
// `modelOptionalFor`, `assertSettingsModelFallback`) and have to keep answering it the same way:
// written as "both halves are named", `fallbackIsConfigured` returned false for a model-less
// `openai-compatible` fallback that the backend calls configured, which switched OFF the endpoint
// checks that gate the save — so Save went through on a missing or malformed base URL, the server
// stored the block, and the runtime could not build it.

// Whether there is a fallback here at all. Gates the endpoint checks, so a false answer is not a
// quieter editor, it is an editor that stops checking.
export function fallbackIsConfigured(form: ModelFallbackState): boolean {
  const provider = form.provider.trim();
  if (!provider) return false;
  return !!form.model.trim() || modelOptionalFor(provider);
}

// Whether the operator picked a provider and owes a model. Renders the field's error AND blocks the
// save, because the round trip does not survive this state: it stores, comes back as "No fallback",
// and the choice is gone with nothing on screen to say why.
export function fallbackModelIsMissing(form: ModelFallbackState): boolean {
  const provider = form.provider.trim();
  return !!provider && !form.model.trim() && !modelOptionalFor(provider);
}
