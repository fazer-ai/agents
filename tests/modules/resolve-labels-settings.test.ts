import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readBehaviorSettings } from "@/modules/agents/behavior-settings";
import {
  RESOLVE_LABELS_MAX,
  readResolveLabels,
} from "@/modules/agents/resolve-labels";
import {
  assertResolveLabelsNotProtected,
  dropUnusableImportedSettingsInPlace,
} from "@/modules/agents/service";

describe("readResolveLabels", () => {
  test("absent block or field is no label", () => {
    expect(readResolveLabels(undefined)).toEqual([]);
    expect(readResolveLabels({})).toEqual([]);
    expect(readResolveLabels({ resolveConversation: {} })).toEqual([]);
    expect(
      readResolveLabels({ resolveConversation: { assignLabels: "x" } }),
    ).toEqual([]);
  });

  test("cleaned like the case labels: trimmed, lowercased, deduplicated, strings only", () => {
    expect(
      readResolveLabels({
        resolveConversation: {
          assignLabels: [
            " Resolvido-Pela-IA ",
            "resolvido-pela-ia",
            "",
            7,
            "vip",
          ],
        },
      }),
    ).toEqual(["resolvido-pela-ia", "vip"]);
  });

  test("capped", () => {
    const many = Array.from(
      { length: RESOLVE_LABELS_MAX + 5 },
      (_, i) => `l${i}`,
    );
    expect(
      readResolveLabels({ resolveConversation: { assignLabels: many } }),
    ).toHaveLength(RESOLVE_LABELS_MAX);
  });

  test("is part of the behavior surface", () => {
    expect(
      readBehaviorSettings({
        resolveConversation: { assignLabels: ["resolvido-pela-ia"] },
      }).resolveConversation,
    ).toEqual({ assignLabels: ["resolvido-pela-ia"] });
    expect(readBehaviorSettings({}).resolveConversation).toEqual({
      assignLabels: [],
    });
  });
});

// A label the operator marked as not the agent's to touch cannot also be one the agent's close
// writes: the two settings would contradict each other, and which one wins would be an accident.
// Judged on the bag the write LEAVES, never on the patch beside a guess about what survives it.
describe("a resolve label that is also protected is refused", () => {
  test("both in the resulting bag", () => {
    expect(() =>
      assertResolveLabelsNotProtected({
        setLabels: { protected: ["Agente-Off"] },
        resolveConversation: {
          assignLabels: ["resolvido-pela-ia", "agente-off"],
        },
      }),
    ).toThrow(/agente-off/);
  });

  test("a bag that dropped the protected list is free to assign the label", () => {
    expect(() =>
      assertResolveLabelsNotProtected({
        resolveConversation: { assignLabels: ["agente-off"] },
      }),
    ).not.toThrow();
  });

  test("disjoint lists and an empty resolve list are accepted", () => {
    expect(() =>
      assertResolveLabelsNotProtected({
        setLabels: { protected: ["agente-off"] },
        resolveConversation: { assignLabels: ["resolvido-pela-ia"] },
      }),
    ).not.toThrow();
    expect(() =>
      assertResolveLabelsNotProtected({
        setLabels: { protected: ["agente-off"] },
        resolveConversation: { assignLabels: [] },
      }),
    ).not.toThrow();
  });
});

// An import is not refused whole over one field: the clashing label is taken out of the close's list
// and named, and the protected list, the stronger of the two statements, stays as the bundle wrote it.
describe("an imported bundle with a protected resolve label", () => {
  test("the label is taken out of the close's list and named", () => {
    const bag = {
      setLabels: { protected: ["agente-off"] },
      resolveConversation: {
        assignLabels: ["resolvido-pela-ia", "Agente-Off"],
      },
    };
    const taken = dropUnusableImportedSettingsInPlace(bag);
    expect(bag.resolveConversation.assignLabels).toEqual(["resolvido-pela-ia"]);
    expect(bag.setLabels.protected).toEqual(["agente-off"]);
    expect(taken.paths).toContain("resolveConversation.assignLabels.1");
  });

  test("a clash past the reader's window is taken out too, so none moves into it", () => {
    const ordinary = Array.from({ length: 19 }, (_, i) => `l${i}`);
    const bag = {
      setLabels: { protected: ["guard-a", "guard-b"] },
      resolveConversation: {
        assignLabels: ["guard-a", ...ordinary, "guard-b"],
      },
    };
    dropUnusableImportedSettingsInPlace(bag);
    expect(bag.resolveConversation.assignLabels).toEqual(ordinary);
    expect(() => assertResolveLabelsNotProtected(bag)).not.toThrow();
  });
});

// The Tools save writes the grants first and the settings after, so a clash the PATCH refuses has
// to be caught before the grants PUT, or the tools change while the save reports a failure. The
// editor asks the same function the server asks, of the bag it is about to send.
describe("the editor refuses the clash before the grants are written (source)", () => {
  const src = readFileSync(
    "src/client/pages/agents/AgentEditorPage.tsx",
    "utf8",
  );
  test("the Tools save asks protectedResolveLabels before the tool-selections PUT", () => {
    const start = src.indexOf("async function saveTools(");
    const body = src.slice(start, src.indexOf("\n  }\n", start));
    const ask = body.indexOf("protectedResolveLabels(toolsSettings)");
    const put = body.indexOf('["tool-selections"].put(');
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(put);
  });
});
