import { describe, expect, test } from "bun:test";
import { promptCacheToStored } from "@/client/pages/agents/promptCacheFormState";
import { parseModelConfig } from "@/graph/model-config";

// What the General tab stores must always be a config the backend accepts: the save would otherwise
// fail on a field the operator never touched.
describe("prompt cache form → stored", () => {
  test("an untouched form stores nothing, so the default stays the backend's", () => {
    expect(
      promptCacheToStored({ provider: "anthropic", promptCache: "" }),
    ).toEqual({});
  });

  test("the chosen value is stored", () => {
    expect(
      promptCacheToStored({ provider: "anthropic", promptCache: "off" }),
    ).toEqual({ promptCache: "off" });
  });

  test("a provider that caches on its own stores nothing", () => {
    expect(
      promptCacheToStored({ provider: "openai", promptCache: "off" }),
    ).toEqual({});
  });

  test("every value the form can hold parses on the backend", () => {
    for (const provider of ["anthropic", "openrouter", "openai"])
      for (const promptCache of ["", "auto", "off"]) {
        const stored = promptCacheToStored({ provider, promptCache });
        expect(() =>
          parseModelConfig({
            provider,
            model:
              provider === "openrouter" ? "anthropic/claude-haiku-5.5" : "m",
            ...stored,
          }),
        ).not.toThrow();
      }
  });
});
