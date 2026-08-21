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
    // RECURSIVE, not one level. The walk used to stop at `block.field`, which made it blind to a
    // credential a block holds inside a sub-object — `memory.compaction.credentialRef` is one, and
    // it went in with this guard, the vault's reverse index and the MCP name↔ref translation all
    // green. A guard that only sees the shapes that existed when it was written is not a guard.
    const walk = (value: unknown, path: string[]): void => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      for (const [key, child] of Object.entries(value)) {
        if (/credentialref$/i.test(key))
          produced.push([...path, key].join("."));
        else walk(child, [...path, key]);
      }
    };
    walk(settings, []);
    const declared = SETTINGS_CREDENTIAL_PATHS.map(({ path }) =>
      path.join("."),
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
    // Built by WALKING each path, so a nested one lands where the reader would put it. Assigning
    // `settings[block]` wholesale was fine while every path was two segments and is silently wrong
    // for a deeper one: it would write the leaf key at the top level and prove nothing.
    const settings: Record<string, unknown> = {};
    for (const { path } of SETTINGS_CREDENTIAL_PATHS) {
      let node = settings;
      for (const step of path.slice(0, -1)) {
        const next = (node[step] ?? {}) as Record<string, unknown>;
        node[step] = next;
        node = next;
      }
      const leaf = path[path.length - 1] as string;
      node[leaf] = path.join("-");
    }
    const targets = credentialFieldTargets(
      { credentialRef: "model-key" },
      settings,
    );
    expect(targets.get("model-key")).toEqual({
      tab: "general",
      sectionId: "general-model",
    });
    for (const { path, tab, sectionId } of SETTINGS_CREDENTIAL_PATHS) {
      expect(targets.get(path.join("-"))).toEqual({ tab, sectionId });
    }
    // The one that broke, spelled out so the invariant above cannot be satisfied by a wrong entry.
    expect(targets.get("guardrails-credentialRef")).toEqual({
      tab: "guardrails",
      sectionId: "gr-model",
    });
    // And the nested one, for the same reason: a walk that stops one level short reads nothing here
    // and the loop above would pass on an empty expectation.
    expect(targets.get("memory-compaction-credentialRef")).toEqual({
      tab: "behavior",
      sectionId: "memory",
    });
  });
});
