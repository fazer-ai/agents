import type { BehaviorSettingsPatch } from "./behavior-settings";

// Every field of the agent settings bag that holds a vault credential ref, as (block, field). ONE list,
// because it has to reach every place that treats a ref as a ref and each of them used to keep its
// own: export/import (id ↔ portable name), the MCP contract (name ↔ `vault:<id>` in both directions)
// and the vault's reverse index (what an entry is used by). Three private copies of this list agreed
// with each other and were all wrong the same way: none of them knew `guardrails.credentialRef`, so
// exporting an agent whose guardrails run on their own key failed with 500 (a `vault:<id>` left in
// the payload trips the export's leak defense), the vault UI listed that key as unused, and the MCP
// read handed back an id where it promises a name. The test over this constant walks the behavior
// readers for their credential fields, so the next block that grows one cannot be missed here.
export const SETTINGS_CREDENTIAL_PATHS = [
  ["stt", "credentialRef"],
  ["tts", "credentialRef"],
  ["tts", "normalizeCredentialRef"],
  ["vision", "credentialRef"],
  ["guardrails", "credentialRef"],
] as const satisfies ReadonlyArray<
  readonly [keyof BehaviorSettingsPatch, string]
>;
