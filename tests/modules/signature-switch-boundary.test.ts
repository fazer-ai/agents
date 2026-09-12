import { describe, expect, test } from "bun:test";
import {
  assertSettingsSignature,
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
