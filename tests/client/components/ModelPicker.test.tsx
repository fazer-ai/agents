/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { ModelPicker } from "@/client/components/ModelPicker";

// An empty model field still displays text, and the operator reads that text as "the model this
// will use". It used to be the literal "gpt-5.4-mini" for every provider, so an Anthropic guardrail
// with nothing selected showed an OpenAI model, which is how a whole config could look configured
// and screen nothing. The placeholder now has to name the model the runtime would actually fall
// back to. No credentialRef here, so the picker's loader returns [] without touching the network.
//
// NOTE: The assertion reduces to a string BEFORE expect. A failing expectation that holds a DOM node
// serializes a cyclic happy-dom tree and stalls the runner.
function shownFor(
  provider: string,
  capability?: "chat" | "transcription" | "vision",
): string {
  render(
    <ModelPicker
      value=""
      onChange={() => {}}
      provider={provider}
      capability={capability}
      aria-label="model"
    />,
  );
  return screen.getByLabelText("model").textContent ?? "";
}

describe("ModelPicker placeholder", () => {
  afterEach(() => cleanup());

  test("names the provider's own default, not OpenAI's", () => {
    expect(shownFor("anthropic")).toContain("claude-sonnet-4-6");
  });

  test("names the OpenAI default on OpenAI", () => {
    expect(shownFor("openai")).toContain("gpt-5.4-mini");
  });

  // Empty is a real choice here (single-model servers ignore the requested name), so naming a model
  // would be the lie in the other direction.
  test("promises no model where the server picks one", () => {
    const shown = shownFor("openai-compatible");
    expect([shown.includes("gpt"), shown.length > 0]).toEqual([false, true]);
  });

  // PROVIDER_DEFAULT_MODEL is a chat table; showing a chat model where a transcription model goes
  // would name something that will never be sent.
  test("promises no chat model for a non-chat capability", () => {
    expect(shownFor("openai", "transcription").includes("gpt-5.4-mini")).toBe(
      false,
    );
  });
});
