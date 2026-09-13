import { describe, expect, test } from "bun:test";
import {
  assertSettingsBlocksKept,
  SettingsBlocksDroppedError,
} from "@/modules/agents/service";

// A `settings` bag REPLACES the column (docs/graph.md), so every block the bag does not name is
// deleted, and the call answers 200 saying nothing (#614). The contract stays; what changes is that
// a write which would destroy configuration has to say it means it.
//
// The question is asked of the STORED row, inside the same lock the write takes, like every other
// rule in this family: what this bag would COST, not what it looks like on its own.
describe("assertSettingsBlocksKept", () => {
  const stored = {
    signature: { enabled: true, text: "Alex" },
    split: { enabled: true, maxChars: 300 },
    followUp: { enabled: true, steps: [{ afterMinutes: 60 }] },
  };

  test("a bag carrying every stored block passes (the console's save)", () => {
    expect(() =>
      assertSettingsBlocksKept({ ...stored, debounce: { seconds: 5 } }, stored),
    ).not.toThrow();
  });

  test("a bag that omits a configured block is refused, naming it", () => {
    let caught: unknown;
    try {
      assertSettingsBlocksKept({ split: { enabled: false } }, stored);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SettingsBlocksDroppedError);
    const err = caught as SettingsBlocksDroppedError;
    expect(err.statusCode).toBe(400);
    expect(err.translationKey).toBe("errors.settingsBlocksDropped");
    // Every block it would cost, not just the first: a caller who fixes them one refusal at a time
    // learns the size of the mistake one block at a time.
    expect(err.translationParams?.blocks).toBe("followUp, signature");
    expect(err.translationParams?.count).toBe(2);
  });

  test("an empty bag on a configured agent is the whole wipe, and is refused", () => {
    expect(() => assertSettingsBlocksKept({}, stored)).toThrow(
      SettingsBlocksDroppedError,
    );
  });

  // The write that does not touch settings at all (a rename, a mode change) is not this rule's
  // business. `undefined` is "the column is not in this write", not "an empty bag".
  test("a write without a settings bag passes", () => {
    expect(() => assertSettingsBlocksKept(undefined, stored)).not.toThrow();
  });

  test("a fresh agent has nothing to lose, so any bag passes", () => {
    expect(() =>
      assertSettingsBlocksKept({ split: {} }, undefined),
    ).not.toThrow();
    expect(() => assertSettingsBlocksKept({ split: {} }, {})).not.toThrow();
    expect(() => assertSettingsBlocksKept({ split: {} }, null)).not.toThrow();
  });

  // WHAT WOULD BE LOST, not which keys existed. `agent_settings_get` answers `{}` for a block the
  // operator never configured (toolGuidance, toolPreconditions), and the console's own reader
  // materialises empty blocks; refusing a save over those would be a refusal about nothing.
  test("a stored block that holds nothing is not a loss", () => {
    const empties = {
      toolGuidance: {},
      toolPreconditions: {},
      grounding: null,
      sendImage: [],
    };
    expect(() =>
      assertSettingsBlocksKept({ debounce: { seconds: 5 } }, empties),
    ).not.toThrow();
  });

  test("an empty block alongside a configured one refuses only for the configured one", () => {
    let caught: unknown;
    try {
      assertSettingsBlocksKept(
        {},
        { toolGuidance: {}, signature: { enabled: true } },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SettingsBlocksDroppedError);
    expect(
      (caught as SettingsBlocksDroppedError).translationParams?.blocks,
    ).toBe("signature");
  });

  // A block that is OFF is still a decision somebody made, and the bag that drops it reverts that
  // decision to whatever the default is. `enabled: false` is the case where the two differ most.
  test("a block switched off is still configuration", () => {
    expect(() =>
      assertSettingsBlocksKept({}, { split: { enabled: false } }),
    ).toThrow(SettingsBlocksDroppedError);
  });

  test("a key the bag adds is nobody's loss", () => {
    expect(() =>
      assertSettingsBlocksKept({ ...stored, somethingNew: { a: 1 } }, stored),
    ).not.toThrow();
  });

  // The bag names the block and empties it: that is an edit of the block, not its removal, and the
  // block's own reader answers what an empty block means.
  test("naming a block with an empty value is not dropping it", () => {
    expect(() =>
      assertSettingsBlocksKept(
        { signature: {}, split: {}, followUp: {} },
        stored,
      ),
    ).not.toThrow();
  });

  // `null` reads as "this block is gone" in JSON-merge-patch and as a value everywhere else. It is
  // NAMED by the bag either way, so it goes through: the caller said the word.
  test("naming a block with null is not dropping it either", () => {
    expect(() =>
      assertSettingsBlocksKept(
        { signature: null, split: null, followUp: null },
        stored,
      ),
    ).not.toThrow();
  });
  // `undefined` is the one value a bag can name and still not keep: JSON has no spelling for it, so
  // the key is gone from the row the moment the write serializes. Only an in-process caller can hand
  // one over (the wire cannot carry it), and that caller would lose the block exactly as silently.
  test("a block named with undefined is a block dropped", () => {
    let caught: unknown;
    try {
      assertSettingsBlocksKept(
        { signature: undefined, split: {}, followUp: {} },
        stored,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SettingsBlocksDroppedError);
    expect(
      (caught as SettingsBlocksDroppedError).translationParams?.blocks,
    ).toBe("signature");
  });

  // A bag that is not an object keeps nothing, so it costs everything the row holds. The route's
  // schema and the service's zod record refuse these before they get here; this is what the rule
  // answers for the caller that reaches it anyway.
  test("a bag that is not an object is the whole wipe", () => {
    for (const bag of [null, [], "x"]) {
      expect(() => assertSettingsBlocksKept(bag, stored)).toThrow(
        SettingsBlocksDroppedError,
      );
    }
  });
});
