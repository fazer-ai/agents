import { describe, expect, test } from "bun:test";
import {
  visionToForm,
  visionToStored,
} from "@/client/pages/agents/visionFormState";
import { DEFAULT_EXTRACTION_PROMPT } from "@/modules/vision/prompt-default";
import { readVisionConfig } from "@/modules/vision/settings";

// The Behavior save REPLACES the `vision` block, so a key this pair drops is DELETED from the agent's
// bag on the next save. `maxOutputTokens` and `reasoningEffort` have no control on the tab:
// an operator who set them through the API or MCP would lose them by saving an unrelated setting.

describe("vision form ↔ stored round trip", () => {
  test("every stored key survives the trip, the output limits included", () => {
    const stored = {
      vision: {
        enabled: true,
        provider: "anthropic",
        model: "claude-haiku-5-5",
        credentialRef: "vault:7",
        baseURL: null,
        extractionPrompt: "leia tudo",
        maxOutputTokens: 8192,
        reasoningEffort: "low" as const,
      },
    };
    expect(visionToStored(visionToForm(stored))).toEqual(stored.vision);
  });

  test("the pair covers every key the reader answers", () => {
    const read = Object.keys(readVisionConfig({})).sort();
    const written = Object.keys(visionToStored(visionToForm({}))).sort();
    expect(written).toEqual(read);
  });

  test("an empty bag round-trips to the defaults, with the prompt stored as null", () => {
    expect(visionToStored(visionToForm({}))).toEqual({
      enabled: false,
      provider: "openai",
      model: "",
      credentialRef: null,
      baseURL: null,
      extractionPrompt: null,
      maxOutputTokens: null,
      reasoningEffort: null,
    });
    expect(visionToForm({}).extractionPrompt).toBe(DEFAULT_EXTRACTION_PROMPT);
  });
});
