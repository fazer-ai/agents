import { describe, expect, test } from "bun:test";
import {
  assertSettingsRetiredLabelKeys,
  RetiredLabelSettingError,
} from "@/modules/agents/service";
import {
  PROTECTED_LABELS_MAX,
  readProtectedLabels,
} from "@/modules/agents/tool-guidance";

// The settings blocks are loose objects, so a key removed from every reader keeps being accepted and
// stored with a 200 while governing nothing. Issue #568 retired the taxonomy; these are the four
// faces the verifier found of it still being accepted, and the guard that answers all four.
describe("retired label settings", () => {
  test("settings.labels is refused, naming where the taxonomy went", () => {
    expect(() =>
      assertSettingsRetiredLabelKeys({
        labels: { groups: [{ name: "assunto", values: ["a"] }] },
      }),
    ).toThrow(RetiredLabelSettingError);
    try {
      assertSettingsRetiredLabelKeys({ labels: {} });
    } catch (e) {
      expect(String(e)).toContain("toolGuidance.set_labels");
    }
  });

  test("an empty or falsy block is still a block, and still refused", () => {
    // `labels: {}` is what a console round-trip of an agent that once had groups sends back. Read as
    // "nothing to see", it is the exact write that keeps the dead key alive.
    for (const value of [{}, [], null, ""]) {
      expect(() => assertSettingsRetiredLabelKeys({ labels: value })).toThrow(
        RetiredLabelSettingError,
      );
    }
  });

  test("monitoring.labelGroups is refused without refusing the rest of the block", () => {
    expect(() =>
      assertSettingsRetiredLabelKeys({ monitoring: { labelGroups: [] } }),
    ).toThrow(RetiredLabelSettingError);
    expect(() =>
      assertSettingsRetiredLabelKeys({
        monitoring: { window: { messages: 20 }, analysis: "incremental" },
      }),
    ).not.toThrow();
  });

  test("a settings bag without either key passes", () => {
    expect(() =>
      assertSettingsRetiredLabelKeys({
        toolGuidance: { set_labels: "exactly one of a, b, c" },
        setLabels: { protected: ["agente-off"] },
      }),
    ).not.toThrow();
    for (const value of [undefined, null, "x", 3, []])
      expect(() => assertSettingsRetiredLabelKeys(value)).not.toThrow();
  });
});

describe("readProtectedLabels", () => {
  test("trims, drops blanks and duplicates, keeps order", () => {
    expect(
      readProtectedLabels({
        setLabels: { protected: [" agente-off ", "agente-off", "", "  ", "x"] },
      }),
    ).toEqual(["agente-off", "x"]);
  });

  test("a non-string entry is dropped rather than stringified", () => {
    // A guard entry that never equals a real label protects nothing, and `"3"` would look like a
    // guard in the console while matching no Chatwoot label.
    expect(
      readProtectedLabels({ setLabels: { protected: [3, null, {}, "vip"] } }),
    ).toEqual(["vip"]);
  });

  test("anything but an array of strings reads as no guard at all", () => {
    for (const block of [
      undefined,
      null,
      {},
      { protected: "agente-off" },
      { protected: {} },
      [],
    ])
      expect(readProtectedLabels({ setLabels: block })).toEqual([]);
    expect(readProtectedLabels(undefined)).toEqual([]);
  });

  test("the list is bounded", () => {
    const many = Array.from(
      { length: PROTECTED_LABELS_MAX + 10 },
      (_, i) => `l${i}`,
    );
    expect(
      readProtectedLabels({ setLabels: { protected: many } }),
    ).toHaveLength(PROTECTED_LABELS_MAX);
  });
});
