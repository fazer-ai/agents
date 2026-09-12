import { describe, expect, test } from "bun:test";
import {
  assertSettingsSignature,
  InvalidSignatureFrequencyError,
  InvalidSignatureSwitchError,
} from "@/modules/agents/service";

// THE SWITCH IS REFUSED AT THE WRITE, not normalised in the reader (#612).
//
// The acceptance run measured what accepting-and-normalising costs: REST answered 200 to
// `enabled: "sim"` and GET echoed the string back, so a client reading the API saw one answer while
// the runtime signed on another. The switch's value is the only thing that says whether an agent is
// signing, so two answers to that question is one answer too many.
describe("assertSettingsSignature", () => {
  const ON = { signature: { enabled: true, text: "Alex" } };

  test("a boolean passes, both ways", () => {
    expect(() => assertSettingsSignature(ON, undefined)).not.toThrow();
    expect(() =>
      assertSettingsSignature({ signature: { enabled: false } }, undefined),
    ).not.toThrow();
  });

  // The pre-#612 bag: no flag at all, which the reader answers from the text. Not a bad value.
  test("an absent switch passes, because that is every bag written before it existed", () => {
    expect(() =>
      assertSettingsSignature({ signature: { text: "Alex" } }, undefined),
    ).not.toThrow();
    expect(() => assertSettingsSignature({}, undefined)).not.toThrow();
    expect(() => assertSettingsSignature(null, undefined)).not.toThrow();
  });

  test("a string is refused, naming the field", () => {
    let caught: unknown;
    try {
      assertSettingsSignature({ signature: { enabled: "sim" } }, undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidSignatureSwitchError);
    const err = caught as InvalidSignatureSwitchError & {
      status?: number;
      field?: string;
    };
    expect(err.message).toContain("signature.enabled");
    expect(err.message).toContain("string");
  });

  test("a number and a null are refused too", () => {
    expect(() =>
      assertSettingsSignature({ signature: { enabled: 1 } }, undefined),
    ).toThrow(InvalidSignatureSwitchError);
    expect(() =>
      assertSettingsSignature({ signature: { enabled: null } }, undefined),
    ).toThrow(InvalidSignatureSwitchError);
  });

  // SCOPED TO WHAT THIS WRITE CHANGES, like every other rule in this family: a bad value already in
  // the row must not freeze a save that edits some other section, or one bad PATCH locks the agent
  // out of its own editor.
  test("a stored bad value does not block a save that leaves it alone", () => {
    const stored = { signature: { enabled: "sim" } };
    expect(() =>
      assertSettingsSignature({ signature: { enabled: "sim" } }, stored),
    ).not.toThrow();
  });

  test("but changing it to another bad value is still refused", () => {
    const stored = { signature: { enabled: "sim" } };
    expect(() =>
      assertSettingsSignature({ signature: { enabled: "nao" } }, stored),
    ).toThrow(InvalidSignatureSwitchError);
  });
});

// THE FREQUENCY IS REFUSED THE SAME WAY (#616), and the tie-breaker is what GET does rather than
// what the reader can cope with. `position` and `separator` normalise, so a wrong value there is
// harmless to the runtime — but the API echoes the settings bag AS STORED, so normalising leaves
// the operator's client reading "sempre" on a field the runtime answered as "all". #612 already
// settled that two answers to one question is one too many.
describe("assertSettingsSignature: the frequency", () => {
  test("both values pass", () => {
    for (const frequency of ["all", "once"]) {
      expect(() =>
        assertSettingsSignature({ signature: { frequency } }, undefined),
      ).not.toThrow();
    }
  });

  test("an absent frequency passes, because that is every bag written before it existed", () => {
    expect(() =>
      assertSettingsSignature({ signature: { text: "Alex" } }, undefined),
    ).not.toThrow();
  });

  test("a value outside the domain is refused, naming the field", () => {
    let caught: unknown;
    try {
      assertSettingsSignature(
        { signature: { frequency: "sempre" } },
        undefined,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidSignatureFrequencyError);
    const err = caught as InvalidSignatureFrequencyError & {
      field?: string;
      statusCode?: number;
    };
    expect(err.field).toBe("signature.frequency");
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('"sempre"');
  });

  test("a number, a null and an object are refused too", () => {
    for (const bad of [1, null, {}, true]) {
      expect(() =>
        assertSettingsSignature({ signature: { frequency: bad } }, undefined),
      ).toThrow(InvalidSignatureFrequencyError);
    }
  });

  // ONLY WHAT THIS WRITE INTRODUCES OR CHANGES, the scoping every rule in this family has: a bag
  // that already holds a bad value is re-sent untouched by every save that edits some other
  // section, and refusing those would freeze the agent on a field nobody is editing.
  test("a stored bad value re-sent unchanged does not block an unrelated save", () => {
    expect(() =>
      assertSettingsSignature(
        { signature: { frequency: "sempre", text: "Outro" } },
        { signature: { frequency: "sempre", text: "Alex" } },
      ),
    ).not.toThrow();
  });

  test("changing one bad value for another is still a change, and still refused", () => {
    expect(() =>
      assertSettingsSignature(
        { signature: { frequency: "toda" } },
        { signature: { frequency: "sempre" } },
      ),
    ).toThrow(InvalidSignatureFrequencyError);
  });

  // The two guards are independent: a bad switch alongside a good frequency still throws the
  // switch's error, and a good switch does not excuse a bad frequency.
  test("the switch and the frequency are checked independently", () => {
    expect(() =>
      assertSettingsSignature(
        { signature: { enabled: "sim", frequency: "all" } },
        undefined,
      ),
    ).toThrow(InvalidSignatureSwitchError);
    expect(() =>
      assertSettingsSignature(
        { signature: { enabled: true, frequency: "sempre" } },
        undefined,
      ),
    ).toThrow(InvalidSignatureFrequencyError);
  });
});
