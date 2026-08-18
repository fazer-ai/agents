import { describe, expect, test } from "bun:test";
import { readBehaviorSettings } from "@/modules/agents/behavior-settings";
import { SETTINGS_CREDENTIAL_PATHS } from "@/modules/agents/credential-paths";
import { credentialFieldTargets } from "@/modules/agents/transfer";

// The list of settings paths that hold a credential ref has to equal what the behavior readers
// actually produce, in BOTH directions. This is the test that would have caught the fifth entry
// (guardrails) being missing from three private copies of it: a block that grows a credential field
// fails here until the field reaches every consumer of the list, and a stale entry fails here too.
describe("SETTINGS_CREDENTIAL_PATHS", () => {
  test("names every credential field the behavior readers produce, and nothing else", () => {
    const produced: string[] = [];
    const settings = readBehaviorSettings({}) as unknown as Record<
      string,
      unknown
    >;
    for (const [block, value] of Object.entries(settings)) {
      if (!value || typeof value !== "object") continue;
      for (const field of Object.keys(value)) {
        if (/credentialref$/i.test(field)) produced.push(`${block}.${field}`);
      }
    }
    const declared = SETTINGS_CREDENTIAL_PATHS.map(
      ({ block, field }) => `${block}.${field}`,
    );
    expect(produced.sort()).toEqual([...declared].sort());
  });
});

// The deep link an import warning offers for each field is read off the same list, and it has to
// land on a section that exists on the tab it names. Deriving it ("the behavior tab, section =
// block") was right for four paths and wrong for guardrails, which has a tab of its own: the link
// went to /behavior#guardrails, nothing there carries that id, and the warning dismissed itself
// without showing the field.
describe("credentialFieldTargets", () => {
  test("every path deep-links to the tab and section where the field is edited", () => {
    const settings: Record<string, Record<string, unknown>> = {};
    for (const { block, field } of SETTINGS_CREDENTIAL_PATHS) {
      settings[block] = {
        ...(settings[block] ?? {}),
        [field]: `${block}-${field}`,
      };
    }
    const targets = credentialFieldTargets(
      { credentialRef: "model-key" },
      settings,
    );
    expect(targets.get("model-key")).toEqual({
      tab: "general",
      sectionId: "general-model",
    });
    for (const { block, field, tab, sectionId } of SETTINGS_CREDENTIAL_PATHS) {
      expect(targets.get(`${block}-${field}`)).toEqual({ tab, sectionId });
    }
    // The one that broke, spelled out so the invariant above cannot be satisfied by a wrong entry.
    expect(targets.get("guardrails-credentialRef")).toEqual({
      tab: "guardrails",
      sectionId: "gr-model",
    });
  });
});
