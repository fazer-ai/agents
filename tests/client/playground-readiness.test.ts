import { describe, expect, test } from "bun:test";
import { playgroundModelMissing } from "@/client/pages/agents/playgroundReadiness";

describe("what the playground needs from the model form", () => {
  test("an openai-compatible endpoint runs with no credential and no model name", () => {
    expect(
      playgroundModelMissing({
        provider: "openai-compatible",
        model: "",
        credentialRef: null,
      }),
    ).toEqual([]);
  });

  test("a keyed provider still needs its credential and a model", () => {
    expect(
      playgroundModelMissing({
        provider: "openai",
        model: "",
        credentialRef: null,
      }),
    ).toEqual(["model", "credential"]);
  });

  test("no provider is missing a provider first", () => {
    expect(
      playgroundModelMissing({
        provider: "",
        model: "m",
        credentialRef: "vault:1",
      }),
    ).toEqual(["provider"]);
  });
});
