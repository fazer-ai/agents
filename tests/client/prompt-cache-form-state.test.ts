import { describe, expect, test } from "bun:test";
import { promptCacheToStored } from "@/client/pages/agents/promptCacheFormState";
import { parseModelConfig } from "@/graph/model-config";

const form = (over: Partial<Record<string, string>> = {}) => ({
  provider: "anthropic",
  promptCache: "",
  promptCacheTtl: "",
  promptCacheConversationTtl: "",
  ...over,
});

// What the General tab stores must always be a config the backend accepts: the save would otherwise
// fail on a field the operator never touched.
describe("prompt cache form → stored", () => {
  test("an untouched form stores nothing, so the defaults stay the backend's", () => {
    expect(promptCacheToStored(form())).toEqual({});
  });

  test("the chosen values are stored", () => {
    expect(
      promptCacheToStored(
        form({ promptCacheTtl: "1h", promptCacheConversationTtl: "5m" }),
      ),
    ).toEqual({ promptCacheTtl: "1h", promptCacheConversationTtl: "5m" });
  });

  test("off drops the TTLs", () => {
    expect(
      promptCacheToStored(form({ promptCache: "off", promptCacheTtl: "1h" })),
    ).toEqual({ promptCache: "off" });
  });

  test("a provider that caches on its own stores none of them", () => {
    expect(
      promptCacheToStored(form({ provider: "openai", promptCacheTtl: "1h" })),
    ).toEqual({});
  });

  test("openrouter keeps auto/off but stores no TTL", () => {
    expect(
      promptCacheToStored(
        form({
          provider: "openrouter",
          promptCache: "auto",
          promptCacheTtl: "1h",
          promptCacheConversationTtl: "1h",
        }),
      ),
    ).toEqual({ promptCache: "auto" });
  });

  test("a 1h conversation behind a 5m prefix is never sent", () => {
    expect(
      promptCacheToStored(form({ promptCacheConversationTtl: "1h" })),
    ).toEqual({});
  });

  test("every combination the form can hold parses on the backend", () => {
    for (const provider of ["anthropic", "openrouter", "openai"])
      for (const promptCache of ["", "auto", "off"])
        for (const promptCacheTtl of ["", "5m", "1h"])
          for (const promptCacheConversationTtl of ["", "5m", "1h"]) {
            const stored = promptCacheToStored({
              provider,
              promptCache,
              promptCacheTtl,
              promptCacheConversationTtl,
            });
            expect(() =>
              parseModelConfig({
                provider,
                model:
                  provider === "openrouter"
                    ? "anthropic/claude-haiku-5.5"
                    : "m",
                ...stored,
              }),
            ).not.toThrow();
          }
  });
});
