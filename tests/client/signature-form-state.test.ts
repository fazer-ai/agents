import { describe, expect, test } from "bun:test";
import {
  signaturePreviewParts,
  signaturePreviewVars,
} from "@/client/pages/agents/BehaviorTab";
import {
  SIGNATURE_SEED,
  signatureOnToggle,
  signatureToForm,
  signatureToStored,
} from "@/client/pages/agents/signatureFormState";
import { SIGNATURE_MAX } from "@/modules/agents/text-caps";

// The signature switch as the screen reads and writes it. Each test here is a property that, when
// wrong, loses the operator's own text.

const SIG = "Atenciosamente,\nAlex | Minha Empresa";

describe("signatureToForm: what the screen shows for a stored bag", () => {
  // NOTE: the migration case. A bag written before the switch existed has text and no flag. Read as
  // off, the operator sees the switch down, saves anything else on the page, and the signature is gone
  // with no action that looks like turning it off.
  test("text and no flag shows as ON", () => {
    expect(signatureToForm({ signature: { text: SIG } })).toEqual({
      enabled: true,
      text: SIG,
      position: "top",
      frequency: "all",
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
      frequency: "all",
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
  // NOTE: the switch has to be able to go DOWN. Writing `true` whenever there is text makes the
  // feature impossible to turn off except by deleting the text.
  test("off is written as off, and the text survives it", () => {
    expect(
      signatureToStored({
        enabled: false,
        text: SIG,
        position: "bottom",
        frequency: "once",
        separator: "--",
      }),
    ).toEqual({
      enabled: false,
      text: SIG,
      position: "bottom",
      frequency: "once",
      separator: "--",
    });
  });

  // Saving an untouched form must be a no-op, or every unrelated save rewrites this block.
  test("the pair round-trips a stored bag unchanged", () => {
    for (const bag of [
      {
        enabled: true,
        text: SIG,
        position: "bottom",
        frequency: "once",
        separator: "--",
      },
      {
        enabled: false,
        text: SIG,
        position: "top",
        frequency: "all",
        separator: "blank",
      },
      {
        enabled: true,
        text: "",
        position: "top",
        frequency: "all",
        separator: "blank",
      },
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
    frequency: "all" as const,
    separator: "blank" as const,
  };

  test("turning it on over an empty box seeds the agent's name", () => {
    const up = signatureOnToggle(off, true, null);
    expect(up.form).toEqual({ ...off, enabled: true, text: SIGNATURE_SEED });
    expect(up.seed).toEqual({ form: up.form, from: "" });
  });

  test("a box holding only whitespace counts as empty", () => {
    expect(
      signatureOnToggle({ ...off, text: "   \n" }, true, null).form.text,
    ).toBe(SIGNATURE_SEED);
  });

  test("turning it OFF never touches the operator's text", () => {
    const on = { ...off, enabled: true, text: SIG };
    const down = signatureOnToggle(on, false, null);
    expect(down.form).toEqual({ ...on, enabled: false });
    // and the whole point: back on gives it back byte for byte
    expect(signatureOnToggle(down.form, true, down.seed).form).toEqual(on);
  });

  // The seed is the switch's own suggestion, not something the operator wrote: turned straight back
  // off over it, the box holds what it held before, so on and off again is no change at all.
  test("turning it off over the untouched seed gives back the box as it was", () => {
    for (const before of ["", "  \n"]) {
      const box = { ...off, text: before };
      const up = signatureOnToggle(box, true, null);
      expect(signatureOnToggle(up.form, false, up.seed).form).toEqual(box);
    }
  });

  // Any edit since the seed hands the switch a new form, even one that types the seed back: the text
  // is then the operator's, and off keeps it.
  test("a seed edited, even back to itself, stays when the switch goes off", () => {
    const up = signatureOnToggle(off, true, null);
    const retyped = { ...up.form, text: SIGNATURE_SEED };
    expect(signatureOnToggle(retyped, false, up.seed).form.text).toBe(
      SIGNATURE_SEED,
    );
  });

  // Text that reads like the seed is the operator's when the switch did not put it there: typed by
  // hand into an enabled empty box, or a saved signature. Off keeps it.
  test("a seed the switch did not put there stays when the switch goes off", () => {
    const typed = { ...off, enabled: true, text: SIGNATURE_SEED };
    expect(signatureOnToggle(typed, false, null).form.text).toBe(
      SIGNATURE_SEED,
    );
  });

  // Turning it on over a kept text seeds nothing, and says so, so a later off has nothing to undo.
  test("on over a kept text records no seed", () => {
    const up = signatureOnToggle(off, true, null);
    expect(
      signatureOnToggle({ ...off, text: SIG }, true, up.seed).seed,
    ).toBeNull();
  });

  // The seed is only useful if it resolves; a literal `{{...}}` in the preview would teach the
  // operator the variables do not work at the moment they are learning the field.
  test("the seed names a variable the field supports", () => {
    const seeded = signatureOnToggle(off, true, null).form;
    const [first] = signaturePreviewParts(
      seeded,
      (_k: string, d: string) => d,
      signaturePreviewVars("Ana", "ACME"),
    );
    expect(first?.[0]).toBe("**Ana**");
  });
});

// AN OVERSIZED SIGNATURE ALREADY IN THE BAG SURVIVES AN UNRELATED SAVE.
//
// `readSignatureConfig` clamps the text to `SIGNATURE_MAX` because that is what the customer
// receives; the EDITOR must not, or the next save of any other field writes a truncated copy over
// the original. `collectOversizedTextChanges` lets an oversized value through when it is UNCHANGED,
// which only works if the form gives back what was stored.
describe("a stored signature longer than the cap", () => {
  const LONG = "x".repeat(SIGNATURE_MAX + 100);

  test("round-trips byte for byte, so an untouched save is a no-op", () => {
    const bag = {
      enabled: true,
      text: LONG,
      position: "bottom" as const,
      frequency: "once" as const,
      separator: "--" as const,
    };
    expect(signatureToStored(signatureToForm({ signature: bag }))).toEqual(bag);
  });

  // And it survives the switch, which is the state an operator is most likely to be in when they
  // meet this: turning a long signature off for a while.
  test("turning it off and on again does not shorten it", () => {
    const form = signatureToForm({ signature: { text: LONG } });
    expect(
      signatureOnToggle(signatureOnToggle(form, false, null).form, true, null)
        .form.text,
    ).toBe(LONG);
  });
});

// The frequency's default is a MIGRATION rule, not a UI preference: a bag written before the field
// existed says nothing, and what its silence means is read off the position.
describe("the frequency the form reads and the one it writes", () => {
  test("a bag with no frequency: top reads all, bottom reads once", () => {
    expect(
      signatureToForm({ signature: { text: "Alex", position: "top" } })
        .frequency,
    ).toBe("all");
    expect(
      signatureToForm({ signature: { text: "Alex", position: "bottom" } })
        .frequency,
    ).toBe("once");
  });

  test("a written frequency is what the screen shows, position notwithstanding", () => {
    expect(
      signatureToForm({
        signature: { text: "Alex", position: "top", frequency: "once" },
      }).frequency,
    ).toBe("once");
  });

  // WRITTEN OUT even when it equals the derivation. Once the operator has seen the control, the bag
  // says; leaving it implicit would let a later change of position silently move a choice they made.
  test("the save writes the frequency, and writing it is not optional", () => {
    const stored = signatureToStored({
      enabled: true,
      text: "Alex",
      position: "top",
      frequency: "all",
      separator: "blank",
    });
    expect(stored.frequency).toBe("all");
    expect(Object.keys(stored).sort()).toEqual([
      "enabled",
      "frequency",
      "position",
      "separator",
      "text",
    ]);
  });

  test("a cross combination survives the round trip", () => {
    const form = {
      enabled: true,
      text: "Alex",
      position: "top" as const,
      frequency: "once" as const,
      separator: "--" as const,
    };
    expect(signatureToForm({ signature: signatureToStored(form) })).toEqual(
      form,
    );
  });

  // The seed guard is about the TEXT and must stay that way: turning the switch on may not move a
  // frequency the operator chose while it was off.
  test("the toggle leaves the frequency alone", () => {
    const off = {
      enabled: false,
      text: "",
      position: "top" as const,
      frequency: "once" as const,
      separator: "blank" as const,
    };
    expect(signatureOnToggle(off, true, null).form.frequency).toBe("once");
    expect(
      signatureOnToggle({ ...off, enabled: true }, false, null).form.frequency,
    ).toBe("once");
  });
});
