import { describe, expect, test } from "bun:test";
import { readBehaviorSettings } from "@/modules/agents/behavior-settings";
import { SETTINGS_CREDENTIAL_PATHS } from "@/modules/agents/credential-paths";

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
    const declared = SETTINGS_CREDENTIAL_PATHS.map(([b, f]) => `${b}.${f}`);
    expect(produced.sort()).toEqual([...declared].sort());
  });
});
