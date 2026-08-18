import type { BehaviorSettingsPatch } from "./behavior-settings";

// Every field of the agent settings bag that holds a vault credential ref, with WHERE the editor shows
// it. ONE list, because it has to reach every place that treats a ref as a ref and each of them used
// to keep its own: export/import (id ↔ portable name, and the deep link an import warning offers),
// the MCP contract (name ↔ `vault:<id>` in both directions) and the vault's reverse index (what an
// entry is used by). Three private copies of this list agreed with each other and were all wrong the
// same way: none of them knew `guardrails.credentialRef`, so exporting an agent whose guardrails run
// on their own key failed with 500 (a `vault:<id>` left in the payload trips the export's leak
// defense), the vault UI listed that key as unused, and the MCP read handed back an id where it
// promises a name. The test over this constant walks the behavior readers for their credential
// fields, so the next block that grows one cannot be missed here.
//
// The editor location travels with the path for the same reason: deriving it as "the behavior tab,
// section = block" was right for four entries and wrong for the fifth (guardrails has a tab of its
// own), and an import warning that deep-links to a section that does not exist dismisses itself
// without showing the field it is about.
export const SETTINGS_CREDENTIAL_PATHS = [
  { block: "stt", field: "credentialRef", tab: "behavior", sectionId: "stt" },
  { block: "tts", field: "credentialRef", tab: "behavior", sectionId: "tts" },
  {
    block: "tts",
    field: "normalizeCredentialRef",
    tab: "behavior",
    sectionId: "tts",
  },
  {
    block: "vision",
    field: "credentialRef",
    tab: "behavior",
    sectionId: "vision",
  },
  {
    block: "guardrails",
    field: "credentialRef",
    tab: "guardrails",
    sectionId: "gr-model",
  },
] as const satisfies ReadonlyArray<{
  block: keyof BehaviorSettingsPatch;
  field: string;
  tab: "behavior" | "guardrails";
  sectionId: string;
}>;

// The editor tabs an agent-level credential field can live on, for the import warning's deep link.
export type CredentialFieldTab =
  | "general"
  | (typeof SETTINGS_CREDENTIAL_PATHS)[number]["tab"];
