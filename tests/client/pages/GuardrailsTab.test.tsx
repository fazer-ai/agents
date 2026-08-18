/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { GuardrailsTab } from "@/client/pages/agents/GuardrailsTab";
import {
  CUSTOM_POLICY_MAX,
  GENERATION_PROMPT_MAX,
  TEMPLATE_MESSAGE_MAX,
} from "@/modules/agents/text-caps";
import {
  GUARDRAILS_DEFAULTS,
  type GuardrailAction,
  type GuardrailsConfig,
} from "@/modules/guardrails/settings";

// The template message is what the customer reads, and the `generated` action falls back to it
// whenever no replacement gets written: when the model returns none, and always when the relevance
// check is the one that tripped, since a reply that did not answer has nothing to rewrite. The
// field used to be hidden outside the `template` action, so an operator on `generated` could not
// see or edit the message their customers actually receive.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect. A failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.
function renderWith(action: GuardrailAction): void {
  const config: GuardrailsConfig = {
    ...structuredClone(GUARDRAILS_DEFAULTS),
    enabled: true,
  };
  // Both directions, because the tab renders a block for each and the count below cannot tell them
  // apart: with only one switched, the other's template field would answer for it.
  config.input = { ...config.input, enabled: true, action };
  config.output = { ...config.output, enabled: true, action };
  render(
    <GuardrailsTab
      guardrails={config}
      setGuardrails={() => {}}
      dirty={false}
      saving={false}
      onSave={() => {}}
      onDiscard={() => {}}
    />,
  );
}

const templateFields = () =>
  screen.queryAllByText("Mensagem template").length +
  screen.queryAllByText("Template message").length;

describe("GuardrailsTab template message", () => {
  // The tab mounts a CredentialPicker, which loads over the network. Stubbing `globalThis.fetch`
  // rather than mocking the api module on purpose: `mock.module` is global to the process and leaks
  // into whatever else shares the worker.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [] }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;

  afterEach(() => cleanup());
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("is editable on the template action", () => {
    renderWith("template");
    expect(templateFields() > 0).toBe(true);
  });

  // The one this round is about: on `generated` it is the fallback the customer receives.
  test("stays editable on the generated action, where it is the fallback", () => {
    renderWith("generated");
    expect(templateFields() > 0).toBe(true);
  });

  test("is gone on silent, which sends nothing at all", () => {
    renderWith("silent");
    expect(templateFields()).toBe(0);
  });

  // The custom policy is clamped at CUSTOM_POLICY_MAX on read, and until now the field said nothing:
  // an operator pasting a longer policy saw it saved, saw it back on reload, and never learned that
  // the analysis prompt only carried the first part of it.
  // Substring match: FormField puts the description inside the same <label>, so the accessible name
  // is "Custom policy Extra rules appended to every analysis." rather than the label alone.
  test("every clamped field on this tab declares its cap", () => {
    renderWith("generated");
    const caps = (labels: string[]) =>
      labels
        .flatMap((l) => screen.queryAllByLabelText(new RegExp(`^${l}`)))
        .map((f) => f.getAttribute("maxlength"));
    const policy = caps(["Custom policy", "Política personalizada"]);
    expect(policy.length > 0).toBe(true);
    expect(policy.every((v) => v === String(CUSTOM_POLICY_MAX))).toBe(true);
    // Both directions render one each, and the template message is what the CUSTOMER reads.
    const template = caps(["Template message", "Mensagem template"]);
    expect(template.length).toBe(2);
    expect(template.every((v) => v === String(TEMPLATE_MESSAGE_MAX))).toBe(
      true,
    );
    const generation = caps(["Generation guidance", "Orientação de geração"]);
    expect(generation.length).toBe(2);
    expect(generation.every((v) => v === String(GENERATION_PROMPT_MAX))).toBe(
      true,
    );
  });
});
