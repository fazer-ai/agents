/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { GuardrailsTab } from "@/client/pages/agents/GuardrailsTab";
import type { GuardrailsRefusals } from "@/client/pages/agents/types";
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
      refusals={NO_REFUSALS}
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

// Nothing refused: every test here is about the form, not about a refusal landing on it.
const NO_REFUSALS: GuardrailsRefusals = {
  credential: null,
  customPolicy: null,
  inputTemplateMessage: null,
  outputTemplateMessage: null,
  outputGenerationPrompt: null,
};

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
    // ONE, not two: the guidance steers a replacement reply, and the input direction never writes
    // one (see src/modules/guardrails/analyze.ts), so offering the field there would be a control
    // that visibly does nothing.
    const generation = caps(["Generation guidance", "Orientação de geração"]);
    expect(generation.length).toBe(1);
    expect(generation.every((v) => v === String(GENERATION_PROMPT_MAX))).toBe(
      true,
    );
  });

  // The field is not merely absent on the input direction: the operator has to learn WHERE it went,
  // otherwise picking "generated" there looks like a feature that silently does nothing. The
  // template hint is the place, because the template is what that direction actually sends.
  test("the input direction says the template is always what gets sent", () => {
    renderWith("generated");
    const hints = screen.queryAllByText(
      /SEMPRE isto que sai|ALWAYS what gets sent/,
    );
    expect(hints.length).toBe(1);
  });
});

// THE MARK ACTUALLY REACHING THE BOX.
//
// Everything else about #349 is provable without a DOM — where a path is edited, which channel the
// placement chooses — and none of it proves the last step: that the answer handed to a tab is
// rendered beside the control it is about. This tab is the one that can be mounted (the editor pulls
// auth, theme, toast and a live catalog), and its five fields are one of each shape the editor draws:
// a credential picker, a per-direction textarea, and a policy textarea.
describe("a refusal handed to the guardrails tab lands at its input", () => {
  // The other describe in this file scopes its own cleanup, so this block needs one too: without it
  // the last render of the loop below survives into the next test, and the control that asserts
  // "none of it is on screen" reads the leftover instead. Measured -- it passes alone and fails in a
  // full run, which is the signature of state carried between tests rather than of a real defect.
  afterEach(() => cleanup());

  function renderRefused(refusals: GuardrailsRefusals): void {
    const config: GuardrailsConfig = {
      ...structuredClone(GUARDRAILS_DEFAULTS),
      enabled: true,
    };
    config.input = { ...config.input, enabled: true, action: "template" };
    config.output = { ...config.output, enabled: true, action: "generated" };
    render(
      <GuardrailsTab
        guardrails={config}
        setGuardrails={() => {}}
        refusals={refusals}
        dirty={false}
        saving={false}
        onSave={() => {}}
        onDiscard={() => {}}
      />,
    );
  }

  test("the sentence is on screen once, for each field the tab draws", () => {
    for (const key of [
      "credential",
      "customPolicy",
      "inputTemplateMessage",
      "outputTemplateMessage",
      "outputGenerationPrompt",
    ] as const) {
      cleanup();
      const reason = `refused: ${key}`;
      renderRefused({ ...NO_REFUSALS, [key]: reason });
      expect([key, screen.queryAllByText(reason).length]).toEqual([key, 1]);
    }
  });

  test("with nothing refused the tab says none of it", () => {
    // The control for the count above: a rendering that always showed the string would pass every
    // line of it.
    renderRefused(NO_REFUSALS);
    expect(screen.queryAllByText(/^refused: /).length).toBe(0);
  });

  test("the two directions do not answer for each other", () => {
    // One `renderDirection` draws both blocks, so a mark passed for the input template would sit on
    // the output one too if the field were wired to a single prop.
    renderRefused({ ...NO_REFUSALS, inputTemplateMessage: "only the input" });
    expect(screen.queryAllByText("only the input").length).toBe(1);
  });
});
