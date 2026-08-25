import { describe, expect, test } from "bun:test";
import { readBehaviorSettings } from "@/modules/agents/behavior-settings";
import {
  collectCredentialRefWrites,
  SETTINGS_CREDENTIAL_PATHS,
} from "@/modules/agents/credential-paths";
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

// What a write is allowed to put in the two bags. The rule is not "is this ref valid" but "does this
// write introduce or change one", and the difference is the whole design: eight credential fields
// live across three editor tabs, several only rendered with their section switched on, so refusing a
// ref the write merely carried along would answer 400 naming a field the operator cannot open — and
// one deleted vault entry would freeze every agent that named it, down to the switch that turns the
// agent off.
describe("collectCredentialRefWrites", () => {
  const MODEL = { provider: "openai", model: "gpt-4o-mini" };
  const paths = (
    next: { modelConfig?: unknown; settings?: unknown },
    stored: { modelConfig?: unknown; settings?: unknown } = {},
  ) => collectCredentialRefWrites(next, stored).map((w) => w.path);

  test("a bag the write does not send is a bag it does not touch", () => {
    const stored = {
      modelConfig: { ...MODEL, credentialRef: "vault:1" },
      settings: { stt: { credentialRef: "vault:2" } },
    };
    expect(paths({}, stored)).toEqual([]);
    expect(
      paths({ modelConfig: { ...MODEL, credentialRef: "vault:1" } }, stored),
    ).toEqual([]);
  });

  test("names every field an unconfigured agent's first save fills in", () => {
    const settings: Record<string, unknown> = {};
    for (const { path } of SETTINGS_CREDENTIAL_PATHS) {
      let node = settings;
      for (const step of path.slice(0, -1)) {
        node[step] ??= {};
        node = node[step] as Record<string, unknown>;
      }
      node[path[path.length - 1] as string] = "vault:9";
    }
    expect(
      paths({
        modelConfig: { ...MODEL, credentialRef: "vault:9" },
        settings,
      }).sort(),
    ).toEqual(
      [
        "modelConfig.credentialRef",
        ...SETTINGS_CREDENTIAL_PATHS.map(
          ({ path }) => `settings.${path.join(".")}`,
        ),
      ].sort(),
    );
  });

  test("a ref equal to the stored one is not a write at all", () => {
    const bag = { guardrails: { credentialRef: "vault:7" } };
    expect(paths({ settings: bag }, { settings: bag })).toEqual([]);
    expect(
      paths(
        { settings: { guardrails: { credentialRef: "vault:8" } } },
        { settings: bag },
      ),
    ).toEqual(["settings.guardrails.credentialRef"]);
  });

  test("a write that drops the block is not a write of a ref", () => {
    // The stored bag holds one, the submitted bag does not: the save is REMOVING the credential, and
    // there is nothing to check against the vault.
    expect(
      paths(
        { settings: {} },
        { settings: { stt: { credentialRef: "vault:7" } } },
      ),
    ).toEqual([]);
  });

  test("only a non-empty string counts as a ref", () => {
    expect(
      paths({
        settings: {
          stt: { credentialRef: "" },
          vision: { credentialRef: 7 },
          tts: { credentialRef: null },
        },
      }),
    ).toEqual([]);
  });

  test("the stored comparison is per FIELD, not per block", () => {
    // `tts` carries two credentials. Changing one while re-sending the other unchanged has to report
    // exactly the one that moved, or a save of the normalizer's key drags the voice key along.
    expect(
      paths(
        {
          settings: {
            tts: {
              credentialRef: "vault:1",
              normalizeCredentialRef: "vault:3",
            },
          },
        },
        {
          settings: {
            tts: {
              credentialRef: "vault:1",
              normalizeCredentialRef: "vault:2",
            },
          },
        },
      ),
    ).toEqual(["settings.tts.normalizeCredentialRef"]);
  });

  test("replace rewrites the leaf where it was found, at any depth", () => {
    const settings = {
      memory: { compaction: { credentialRef: "vault:007", model: "gpt-4o" } },
    };
    const next = {
      modelConfig: { ...MODEL, credentialRef: "vault:009" },
      settings,
    };
    for (const w of collectCredentialRefWrites(next, {})) w.replace("vault:9");
    expect(settings.memory.compaction).toEqual({
      credentialRef: "vault:9",
      // The sibling the walker knows nothing about is still there: rebuilding the bag from the
      // declared paths would have dropped it.
      model: "gpt-4o",
    });
    expect(next.modelConfig.credentialRef).toBe("vault:9");
  });
});
