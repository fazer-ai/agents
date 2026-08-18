import { describe, expect, test } from "bun:test";
import { readGuardrailsFormState } from "@/client/pages/agents/guardrailsFormState";
import {
  CUSTOM_POLICY_MAX,
  GENERATION_PROMPT_MAX,
  TEMPLATE_MESSAGE_MAX,
} from "@/modules/agents/text-caps";
import { readGuardrailsConfig } from "@/modules/guardrails/settings";

// The runtime reader clips prose to its cap, which is what keeps a malformed row from reaching the
// model, and is exactly wrong for the editor: a row stored over the cap would hydrate AT the limit,
// so the counter reads clean while every save is refused for text the operator cannot see. Every
// other block hydrates raw (readBehaviorState reads the bag with str()); guardrails was the one that
// went through its reader.

const over = (max: number) => "a".repeat(max + 500);

describe("guardrails form state", () => {
  test("an over-cap customPolicy hydrates whole, while the runtime reader still clips it", () => {
    const settings = { guardrails: { customPolicy: over(CUSTOM_POLICY_MAX) } };
    expect(readGuardrailsFormState(settings).customPolicy.length).toBe(
      CUSTOM_POLICY_MAX + 500,
    );
    expect(readGuardrailsConfig(settings).customPolicy.length).toBe(
      CUSTOM_POLICY_MAX,
    );
  });

  test("both directions hydrate their over-cap template and generation text whole", () => {
    const settings = {
      guardrails: {
        input: {
          templateMessage: over(TEMPLATE_MESSAGE_MAX),
          generationPrompt: over(GENERATION_PROMPT_MAX),
        },
        output: {
          templateMessage: over(TEMPLATE_MESSAGE_MAX),
          generationPrompt: over(GENERATION_PROMPT_MAX),
        },
      },
    };
    const form = readGuardrailsFormState(settings);
    for (const dir of ["input", "output"] as const) {
      expect(form[dir].templateMessage.length).toBe(TEMPLATE_MESSAGE_MAX + 500);
      expect(form[dir].generationPrompt.length).toBe(
        GENERATION_PROMPT_MAX + 500,
      );
    }
  });

  // The cap counts the RAW length (what the browser enforces maxLength against, and what the server
  // refuses on), so trailing whitespace can push a value over while the trimmed text fits. Hydrating
  // the trimmed value there would show a field at exactly the limit that the server keeps refusing.
  test("a value that is over the cap only because of whitespace hydrates whole", () => {
    const raw = `${"a".repeat(CUSTOM_POLICY_MAX)}     `;
    expect(
      readGuardrailsFormState({ guardrails: { customPolicy: raw } })
        .customPolicy,
    ).toBe(raw);
  });

  test("a value within the cap keeps the reader's trimmed text", () => {
    const form = readGuardrailsFormState({
      guardrails: {
        customPolicy: "  no competitors  ",
        input: { templateMessage: "  hold on  " },
      },
    });
    expect(form.customPolicy).toBe("no competitors");
    expect(form.input.templateMessage).toBe("hold on");
  });

  test("the other fields still come from the reader", () => {
    const form = readGuardrailsFormState({
      guardrails: {
        enabled: true,
        provider: "anthropic",
        competitors: ["acme"],
        output: { action: "silent" },
      },
    });
    expect(form.enabled).toBe(true);
    expect(form.provider).toBe("anthropic");
    expect(form.competitors).toEqual(["acme"]);
    expect(form.output.action).toBe("silent");
  });

  test("a malformed bag falls through to the reader instead of throwing", () => {
    expect(readGuardrailsFormState(undefined).customPolicy).toBe("");
    expect(readGuardrailsFormState({ guardrails: "nope" }).customPolicy).toBe(
      "",
    );
    expect(
      readGuardrailsFormState({ guardrails: { customPolicy: 42, input: [] } })
        .customPolicy,
    ).toBe("");
    expect(
      readGuardrailsFormState({
        guardrails: { input: { templateMessage: null } },
      }).input.templateMessage.length,
    ).toBeGreaterThan(0);
  });
});
