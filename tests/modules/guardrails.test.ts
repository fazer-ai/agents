import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { analyzeGuardrail } from "@/modules/guardrails/analyze";
import { buildGuardrailSystemPrompt } from "@/modules/guardrails/prompts";
import {
  GUARDRAILS_DEFAULTS,
  readGuardrailsConfig,
} from "@/modules/guardrails/settings";

// A minimal fake chat model: invoke returns a message with the given content (or throws).
function fakeModel(content: string): BaseChatModel {
  return { invoke: async () => ({ content }) } as unknown as BaseChatModel;
}
const throwingModel = {
  invoke: async () => {
    throw new Error("boom");
  },
} as unknown as BaseChatModel;

const INPUT_CHECKS = {
  toxicity: true,
  unsafeContent: true,
  competitorMentions: false,
  promptAdherence: false,
};

describe("readGuardrailsConfig", () => {
  test("empty / missing → defaults (off)", () => {
    expect(readGuardrailsConfig({})).toEqual(GUARDRAILS_DEFAULTS);
    expect(readGuardrailsConfig(undefined)).toEqual(GUARDRAILS_DEFAULTS);
    expect(readGuardrailsConfig({}).enabled).toBe(false);
  });

  test("reads nested config + fills per-direction defaults", () => {
    const c = readGuardrailsConfig({
      guardrails: {
        enabled: true,
        provider: "anthropic",
        input: { action: "silent" },
      },
    });
    expect(c.enabled).toBe(true);
    expect(c.provider).toBe("anthropic");
    expect(c.input.action).toBe("silent");
    // untouched sub-fields fall back to defaults
    expect(c.input.checks).toEqual(GUARDRAILS_DEFAULTS.input.checks);
    expect(c.output).toEqual(GUARDRAILS_DEFAULTS.output);
  });

  test("clamps invalid provider / action + filters competitors", () => {
    const c = readGuardrailsConfig({
      guardrails: {
        provider: "bogus",
        output: { action: "nope" },
        competitors: ["Acme", "", "  ", "Globex", 42],
      },
    });
    expect(c.provider).toBe("openai");
    expect(c.output.action).toBe("template");
    expect(c.competitors).toEqual(["Acme", "Globex"]);
  });

  test("caps the competitor list", () => {
    const many = Array.from({ length: 80 }, (_, i) => `C${i}`);
    expect(
      readGuardrailsConfig({ guardrails: { competitors: many } }).competitors
        .length,
    ).toBe(50);
  });

  test("generationPrompt defaults to '' and is read per direction", () => {
    expect(readGuardrailsConfig({}).input.generationPrompt).toBe("");
    const c = readGuardrailsConfig({
      guardrails: { input: { generationPrompt: "  be warm  " } },
    });
    expect(c.input.generationPrompt).toBe("be warm");
  });
});

describe("buildGuardrailSystemPrompt", () => {
  const base = {
    direction: "output" as const,
    checks: {
      toxicity: false,
      unsafeContent: false,
      competitorMentions: false,
      promptAdherence: true,
    },
    competitors: [],
    customPolicy: "",
  };

  test("prompt_adherence refers to the agent's instructions, not 'system prompt'", () => {
    const p = buildGuardrailSystemPrompt({
      ...base,
      systemPrompt: "You are Maria.",
    });
    expect(p).toContain("The agent's instructions");
    expect(p).not.toContain("system prompt");
  });

  test("includes the generation guidance when present", () => {
    const p = buildGuardrailSystemPrompt({
      ...base,
      generationPrompt: "Offer a human handoff.",
    });
    expect(p).toContain("Offer a human handoff.");
    expect(p).toContain("suggestedReply");
  });

  test("grounds output adherence in the customer message and strict instructions", () => {
    const p = buildGuardrailSystemPrompt({
      ...base,
      systemPrompt: "Always address the customer by name. Never mention internals.",
      customerMessage: "Quanto tempo dura a consulta?",
    });
    expect(p).toContain("The customer message this reply must answer");
    expect(p).toContain("Quanto tempo dura a consulta?");
    expect(p).toContain("MUST, ALWAYS, NEVER, REQUIRED, EXACTLY");
    expect(p).toContain("answers a different question");
    expect(p).toContain("omits a required element");
  });

  test("does not include customer context for input moderation", () => {
    const p = buildGuardrailSystemPrompt({
      ...base,
      direction: "input",
      customerMessage: "context must stay output-only",
    });
    expect(p).not.toContain("context must stay output-only");
    expect(p).not.toContain("Prompt-adherence review procedure");
  });
});

describe("analyzeGuardrail", () => {
  const base = {
    direction: "input" as const,
    text: "hello",
    checks: INPUT_CHECKS,
    competitors: [],
    customPolicy: "",
  };

  test("parses a violation verdict", async () => {
    const v = await analyzeGuardrail(
      fakeModel(
        '{"violated": true, "categories": ["toxicity"], "rationale": "abuse", "suggestedReply": "Posso ajudar de outra forma?"}',
      ),
      base,
    );
    expect(v.violated).toBe(true);
    expect(v.categories).toEqual(["toxicity"]);
    expect(v.suggestedReply).toBe("Posso ajudar de outra forma?");
  });

  test("tolerates prose / code fences around the JSON", async () => {
    const v = await analyzeGuardrail(
      fakeModel(
        'Result:\n```json\n{"violated": true, "categories": ["unsafe_content"], "rationale": "x", "suggestedReply": null}\n```',
      ),
      base,
    );
    expect(v.violated).toBe(true);
    expect(v.categories).toEqual(["unsafe_content"]);
    expect(v.suggestedReply).toBeNull();
  });

  test("clean verdict when nothing is violated", async () => {
    const v = await analyzeGuardrail(
      fakeModel('{"violated": false, "categories": [], "rationale": ""}'),
      base,
    );
    expect(v.violated).toBe(false);
  });

  test("fail-open on a model error (never blocks)", async () => {
    const v = await analyzeGuardrail(throwingModel, base);
    expect(v.violated).toBe(false);
  });

  test("fail-open on unparseable output", async () => {
    const v = await analyzeGuardrail(fakeModel("not json at all"), base);
    expect(v.violated).toBe(false);
  });
});
