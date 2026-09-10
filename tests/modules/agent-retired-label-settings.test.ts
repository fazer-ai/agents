import { describe, expect, test } from "bun:test";
import {
  assertSettingsProtectedLabels,
  assertSettingsRetiredLabelKeys,
  RetiredLabelSettingError,
  TooManyProtectedLabelsError,
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

  test("an empty tombstone passes, because refusing it breaks ordinary saves", () => {
    // The previous Behavior editor wrote `monitoring.labelGroups` unconditionally, so an agent that
    // never had a taxonomy still carries `[]` — and both surviving writers spread what they read.
    // A refusal on mere presence would fail every later save for a key the operator cannot see.
    // The migration clears the stored ones; this keeps the rolling-deploy window from hard-failing.
    for (const value of [
      {},
      [],
      null,
      "",
      { groups: [] },
      { groups: [], noteOnChange: false },
    ]) {
      expect(() =>
        assertSettingsRetiredLabelKeys({ labels: value }),
      ).not.toThrow();
    }
    expect(() =>
      assertSettingsRetiredLabelKeys({ monitoring: { labelGroups: [] } }),
    ).not.toThrow();
  });

  test("but a tombstone that carries configuration is refused", () => {
    // `noteOnChange: true` is a setting somebody chose and that nothing honours any more, so it gets
    // the same answer a group does.
    expect(() =>
      assertSettingsRetiredLabelKeys({ labels: { noteOnChange: true } }),
    ).toThrow(RetiredLabelSettingError);
    expect(() =>
      assertSettingsRetiredLabelKeys({
        labels: { groups: [{ name: "assunto", values: ["a"] }] },
      }),
    ).toThrow(RetiredLabelSettingError);
  });

  test("monitoring.labelGroups is refused without refusing the rest of the block", () => {
    expect(() =>
      assertSettingsRetiredLabelKeys({
        monitoring: { labelGroups: [{ name: "assunto", values: ["a"] }] },
      }),
    ).toThrow(RetiredLabelSettingError);
    expect(() =>
      assertSettingsRetiredLabelKeys({
        monitoring: { window: { messages: 20 }, analysis: "incremental" },
      }),
    ).not.toThrow();
  });

  test("monitoring.noteOnChange: true is refused, false is not", () => {
    // The flag lived HERE, not under `labels`: readMonitoringConfig read it off the monitoring block
    // and the previous editor wrote it for every agent, defaulting to true. `true` asks for a
    // behaviour that is gone; `false` asks for what it already gets, and refusing it would teach
    // nothing while breaking a save.
    expect(() =>
      assertSettingsRetiredLabelKeys({ monitoring: { noteOnChange: true } }),
    ).toThrow(RetiredLabelSettingError);
    expect(() =>
      assertSettingsRetiredLabelKeys({ monitoring: { noteOnChange: false } }),
    ).not.toThrow();
    try {
      assertSettingsRetiredLabelKeys({ monitoring: { noteOnChange: true } });
    } catch (e) {
      expect(String(e)).toContain("monitoring.noteOnChange");
    }
  });

  test("every truthy spelling of the retired flag is refused, not just boolean true", () => {
    // The bag is LOOSE, so REST and MCP can both put a string or a number under this key. Refusing
    // only boolean `true` left `"true"`, `1` and `"sim"` stored, answered 200 and inert — and MCP's
    // merge normalizing them away while reporting success (review round 25). The question asked is
    // "is this the inert value", which needs no new line the next time a shape nobody listed
    // arrives.
    for (const value of ["true", "sim", 1, {}, [], "yes", 0.5]) {
      expect(() =>
        assertSettingsRetiredLabelKeys({ monitoring: { noteOnChange: value } }),
      ).toThrow(RetiredLabelSettingError);
    }
    // And the inert spellings still pass, including the string a form post turns `false` into.
    for (const value of [false, "false", "FALSE", " false ", null]) {
      expect(() =>
        assertSettingsRetiredLabelKeys({ monitoring: { noteOnChange: value } }),
      ).not.toThrow();
    }
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

describe("the protected-label ceiling is refused, not truncated", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);

  test("a list past the ceiling is refused, naming the ceiling", () => {
    // The reader keeps the first PROTECTED_LABELS_MAX, so without this the console reloads sixty
    // labels as configured while ten of them are there for set_labels to remove — a guard that
    // looks active and is not.
    expect(() =>
      assertSettingsProtectedLabels(
        { setLabels: { protected: many(PROTECTED_LABELS_MAX + 1) } },
        undefined,
      ),
    ).toThrow(TooManyProtectedLabelsError);
    try {
      assertSettingsProtectedLabels(
        { setLabels: { protected: many(PROTECTED_LABELS_MAX + 1) } },
        undefined,
      );
    } catch (e) {
      expect(String(e)).toContain(String(PROTECTED_LABELS_MAX));
    }
  });

  test("counted the way the reader counts it", () => {
    // Blanks, non-strings and duplicates never became guards, so they must not push a legal list
    // over the edge either — the refusal and the truncation have to be about the same list.
    const padded = [...many(PROTECTED_LABELS_MAX), "", "  ", 3, "l0", null];
    expect(() =>
      assertSettingsProtectedLabels(
        { setLabels: { protected: padded } },
        undefined,
      ),
    ).not.toThrow();
  });

  test("a stored over-ceiling list is not refused when the write leaves it alone", () => {
    // The rule its neighbours use: an unrelated PATCH is not the moment to make an operator fix a
    // field they did not come to edit.
    const over = { setLabels: { protected: many(PROTECTED_LABELS_MAX + 5) } };
    expect(() => assertSettingsProtectedLabels(over, over)).not.toThrow();
    expect(() =>
      assertSettingsProtectedLabels(
        { setLabels: { protected: many(PROTECTED_LABELS_MAX + 6) } },
        over,
      ),
    ).toThrow(TooManyProtectedLabelsError);
  });

  test("a bag with no list at all is not this check's business", () => {
    for (const bag of [undefined, {}, { setLabels: {} }, { setLabels: [] }])
      expect(() => assertSettingsProtectedLabels(bag, undefined)).not.toThrow();
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
