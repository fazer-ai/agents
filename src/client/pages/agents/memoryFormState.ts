import { type MemoryConfig, readMemoryConfig } from "@/modules/memory/settings";
import type { MemoryState } from "./BehaviorTab";

// The agent editor's Memory block, as a pair of pure functions: stored settings → form state →
// stored settings. It lives outside the page for the same reason the TTS pair does: the Behavior
// save REPLACES the whole `memory` block with what the form holds, so a field the form does not
// carry is not merely un-editable, it is DELETED on the next save. The round-trip test over this
// pair is what makes the next such field impossible to add silently.

export function memoryToForm(settings: unknown): MemoryState {
  const c = readMemoryConfig(settings).compaction;
  return {
    compactionEnabled: c.enabled,
    provider: c.provider ?? "",
    model: c.model ?? "",
    credentialRef: c.credentialRef ?? "",
    baseURL: c.baseURL ?? "",
  };
}

export function memoryToStored(form: MemoryState): {
  compaction: {
    enabled: boolean;
    provider: string | null;
    model: string | null;
    credentialRef: string | null;
    baseURL: string | null;
  };
} {
  return {
    compaction: {
      enabled: form.compactionEnabled,
      // NOTE: blank is stored as null, not "". The reader treats both as "inherit the agent's
      // model", but null is what every bag written before this feature holds, so writing the same
      // thing keeps a saved agent byte-comparable with an untouched one.
      provider: form.provider || null,
      model: form.model || null,
      credentialRef: form.credentialRef || null,
      baseURL: form.baseURL || null,
    },
  };
}

// The keys the reader produces for `compaction`, for the test that asserts the form carries all of
// them. Exported rather than inlined in the test so the list cannot be written to match the form.
export function compactionReaderKeys(): string[] {
  const c: MemoryConfig["compaction"] = readMemoryConfig({}).compaction;
  return Object.keys(c).sort();
}
