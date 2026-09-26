import { readLimitsConfig } from "@/modules/agents/limits";
import type { LimitsState } from "./BehaviorTab";

// The agent editor's Limits block, as a pair of pure functions: stored settings → form state →
// stored settings. The Behavior save REPLACES the whole `limits` block with what the form holds, so a
// key the form does not carry is DELETED on the next save. `retrySilence` (issue #885) has no control
// on the tab and rides through the form untouched; the round-trip test checks the pair against the
// reader's own keys, so the next key cannot be added and forgotten here.

export function limitsToForm(settings: unknown): LimitsState {
  const read = readLimitsConfig(settings);
  return {
    maxToolCalls: String(read.maxToolCalls),
    // NOTE: Empty means no ceiling, so an absent/zero value must stay empty rather than pick up a
    // default the way maxToolCalls does.
    maxHistoryTokens:
      read.maxHistoryTokens == null ? "" : String(read.maxHistoryTokens),
    retrySilence: read.retrySilence,
  };
}

export function limitsToStored(form: LimitsState): {
  maxToolCalls: number;
  maxHistoryTokens: number | null;
  retrySilence: boolean;
} {
  return {
    maxToolCalls: Number(form.maxToolCalls) || 10,
    // NOTE: An emptied field is how the operator turns the ceiling OFF, so it has to reach the API as
    // null. `Number("") || 0` would send 0, which the reader also reads as off, but null is what "not
    // configured" means everywhere else in this payload.
    maxHistoryTokens: Number(form.maxHistoryTokens) || null,
    retrySilence: form.retrySilence,
  };
}
