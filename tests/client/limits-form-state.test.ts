import { describe, expect, test } from "bun:test";
import {
  limitsToForm,
  limitsToStored,
} from "@/client/pages/agents/limitsFormState";
import { readLimitsConfig } from "@/modules/agents/limits";

// The Behavior save REPLACES the `limits` block, so a key this pair drops is DELETED from the agent's
// bag on the next save. `retrySilence` (issue #885) has no control on the tab, and an operator who
// turned it off through the API would get it back on by saving an unrelated setting.

describe("limits form ↔ stored round trip", () => {
  test("every stored key survives the trip, the retry switch included", () => {
    const stored = {
      limits: {
        maxToolCalls: 7,
        maxHistoryTokens: 12_000,
        retrySilence: false,
      },
    };
    expect(limitsToStored(limitsToForm(stored))).toEqual({
      maxToolCalls: 7,
      maxHistoryTokens: 12_000,
      retrySilence: false,
    });
  });

  test("the pair covers every key the reader answers", () => {
    const read = Object.keys(readLimitsConfig({})).sort();
    const written = Object.keys(limitsToStored(limitsToForm({}))).sort();
    expect(written).toEqual(read);
  });

  test("an empty bag round-trips to the defaults", () => {
    expect(limitsToStored(limitsToForm({}))).toEqual({
      maxToolCalls: 10,
      maxHistoryTokens: null,
      retrySilence: true,
    });
  });

  test("an emptied ceiling field is stored as off", () => {
    const form = { ...limitsToForm({}), maxHistoryTokens: "" };
    expect(limitsToStored(form).maxHistoryTokens).toBeNull();
  });
});
