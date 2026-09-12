import { describe, expect, test } from "bun:test";
import {
  SIGNATURE_SEED,
  signatureOnToggle,
  signatureToForm,
  signatureToStored,
} from "@/client/pages/agents/signatureFormState";
import { PROMPT_CONTEXT_VARS } from "@/graph/prompt";

// THE SCREEN'S HALF OF #612, which the mutation battery found uncovered: every property below
// survived a mutant while the rule lived inline in the page. Each test here is one of those
// mutants, and each of them loses the operator's own text when it is wrong.

const SIG = "Atenciosamente,\nAlex | Minha Empresa";

describe("signatureToForm: what the screen shows for a stored bag", () => {
  // THE MIGRATION CASE. Every agent configured under #599 has text and no flag. If the editor
  // reads that as off, the operator opens the tab, sees the switch down, saves anything else on
  // the page, and the signature is gone with no action that looks like turning it off.
  test("text and no flag shows as ON", () => {
    expect(signatureToForm({ signature: { text: SIG } })).toEqual({
      enabled: true,
      text: SIG,
      position: "top",
      separator: "blank",
    });
  });

  test("no text and no flag shows as off", () => {
    expect(signatureToForm({ signature: { text: "  " } }).enabled).toBe(false);
  });

  test("no block at all shows as off, with the defaults", () => {
    expect(signatureToForm({})).toEqual({
      enabled: false,
      text: "",
      position: "top",
      separator: "blank",
    });
  });

  test("an explicit flag is shown as given, in both directions", () => {
    expect(
      signatureToForm({ signature: { enabled: false, text: SIG } }).enabled,
    ).toBe(false);
    expect(
      signatureToForm({ signature: { enabled: true, text: "" } }).enabled,
    ).toBe(true);
  });
});

describe("signatureToStored: what the screen writes back", () => {
  // The switch has to be able to go DOWN. Writing `true` whenever there is text is the shape this
  // bug takes, and it makes the feature impossible to turn off by any means except deleting the
  // text, which is the state #612 exists to leave behind.
  test("off is written as off, and the text survives it", () => {
    expect(
      signatureToStored({
        enabled: false,
        text: SIG,
        position: "bottom",
        separator: "--",
      }),
    ).toEqual({
      enabled: false,
      text: SIG,
      position: "bottom",
      separator: "--",
    });
  });

  test("on is written as on", () => {
    expect(
      signatureToStored({
        enabled: true,
        text: SIG,
        position: "top",
        separator: "blank",
      }).enabled,
    ).toBe(true);
  });

  // Saving an untouched form must be a no-op, or every unrelated save rewrites this block.
  test("the pair round-trips a stored bag unchanged", () => {
    for (const bag of [
      { enabled: true, text: SIG, position: "bottom", separator: "--" },
      { enabled: false, text: SIG, position: "top", separator: "blank" },
      { enabled: true, text: "", position: "top", separator: "blank" },
    ]) {
      expect(signatureToStored(signatureToForm({ signature: bag }))).toEqual(
        bag as ReturnType<typeof signatureToStored>,
      );
    }
  });

  // A bag from before the switch round-trips to the SAME behaviour, now written down explicitly.
  test("an old bag round-trips to enabled: true rather than silently off", () => {
    expect(
      signatureToStored(signatureToForm({ signature: { text: SIG } })).enabled,
    ).toBe(true);
  });
});

describe("signatureOnToggle: the seed, and the guard that matters more", () => {
  const off = {
    enabled: false,
    text: "",
    position: "top" as const,
    separator: "blank" as const,
  };

  test("turning it on over an empty box seeds the agent's name", () => {
    expect(signatureOnToggle(off, true)).toEqual({
      ...off,
      enabled: true,
      text: SIGNATURE_SEED,
    });
  });

  // THE GUARD. Seeding over a kept text is the same data loss the switch was built to prevent,
  // committed by the convenience meant to celebrate it.
  test("turning it on over a kept text changes nothing but the switch", () => {
    const kept = { ...off, text: SIG };
    expect(signatureOnToggle(kept, true)).toEqual({ ...kept, enabled: true });
  });

  test("a box holding only whitespace counts as empty", () => {
    expect(signatureOnToggle({ ...off, text: "   \n" }, true).text).toBe(
      SIGNATURE_SEED,
    );
  });

  test("turning it OFF never touches the text", () => {
    const on = { ...off, enabled: true, text: SIG };
    expect(signatureOnToggle(on, false)).toEqual({ ...on, enabled: false });
    // and the whole point: back on gives it back byte for byte
    expect(signatureOnToggle(signatureOnToggle(on, false), true)).toEqual(on);
  });

  // The seed is only useful if it resolves; a literal `{{...}}` in the preview would teach the
  // operator the variables do not work at the moment they are learning the field.
  test("the seed names a variable the field supports", () => {
    const named = [...SIGNATURE_SEED.matchAll(/\{\{([^}]+)\}\}/g)].map(
      (m) => m[1] as string,
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => !PROMPT_CONTEXT_VARS.includes(n))).toEqual([]);
  });
});
