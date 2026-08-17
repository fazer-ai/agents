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

  // An empty model is what the editor persists when the operator enables guardrails and never
  // touches the provider select (the per-provider default is only applied on that select's change),
  // and the model field then SHOWS a model name it never saved. Reaching the provider with `model: ""`
  // fails the call, and `analyzeGuardrail` fails open, so the guardrail reads as enabled and silently
  // screens nothing. Resolved here because this reader is the single source of defaults + clamping.
  // The literals are deliberately spelled out instead of imported: a test that reads the same table
  // as the code proves nothing about which model is actually sent.
  test("an empty model resolves to the provider's default", () => {
    const cases: [string, string][] = [
      ["openai", "gpt-5.4-mini"],
      ["anthropic", "claude-sonnet-4-6"],
      ["google", "gemini-3.5-flash"],
      ["deepseek", "deepseek-chat"],
      ["openrouter", "openai/gpt-5.4-mini"],
    ];
    for (const [provider, expected] of cases) {
      const c = readGuardrailsConfig({
        guardrails: { enabled: true, provider, model: "" },
      });
      expect([provider, c.model]).toEqual([provider, expected]);
    }
  });

  test("whitespace counts as empty", () => {
    const c = readGuardrailsConfig({
      guardrails: { enabled: true, provider: "openai", model: "   " },
    });
    expect(c.model).toBe("gpt-5.4-mini");
  });

  test("openai-compatible keeps the empty model, where it means the server's own", () => {
    const c = readGuardrailsConfig({
      guardrails: { enabled: true, provider: "openai-compatible", model: "" },
    });
    expect(c.model).toBe("");
  });

  test("an explicit model is never replaced", () => {
    const c = readGuardrailsConfig({
      guardrails: { enabled: true, provider: "openai", model: "gpt-4o-mini" },
    });
    expect(c.model).toBe("gpt-4o-mini");
  });

  // The default provider is already "openai", so the default config is the broken case: nothing in
  // the editor has to be misused for it to happen.
  test("the shipped default provider resolves to a usable model", () => {
    const c = readGuardrailsConfig({ guardrails: { enabled: true } });
    expect([c.provider, c.model]).toEqual(["openai", "gpt-5.4-mini"]);
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

  // Fail-open is the right policy and it is also indistinguishable, from the outside, from a
  // guardrail that ran and approved. The verdict has to say which one happened, or an operator whose
  // credential expired keeps reading "no violations" forever. Same argument as `onModelRetry` (#63).
  test("a model error is reported as a failure to analyze, not as approval", async () => {
    const v = await analyzeGuardrail(throwingModel, base);
    expect(v.error).toContain("boom");
  });

  // Two different ways the output can be unusable, and they leave by different branches: no JSON
  // object at all never reaches the parser, while a malformed one throws inside it. A single case
  // covers only the first, which is how the second branch stayed untested (caught by mutation).
  test("output with no JSON object at all is reported", async () => {
    const v = await analyzeGuardrail(fakeModel("not json at all"), base);
    expect(typeof v.error).toBe("string");
  });

  // A verdict followed by prose that happens to carry a brace used to be sliced together with that
  // prose and fail to parse, so a real violation came back as an approval. For a moderation feature
  // that is the expensive direction of the mistake.
  test("reads a verdict that is followed by prose containing braces", async () => {
    const v = await analyzeGuardrail(
      fakeModel(
        '{"violated": true, "categories": ["toxicity"], "rationale": "x", "suggestedReply": null}\n' +
          "I flagged it because the policy {toxicity} applies here.",
      ),
      base,
    );
    expect([v.violated, v.categories, v.error]).toEqual([
      true,
      ["toxicity"],
      undefined,
    ]);
  });

  test("a brace inside a string never ends the object early", async () => {
    const v = await analyzeGuardrail(
      fakeModel(
        '{"violated": true, "categories": ["toxicity"], "rationale": "said \\"} bye\\" rudely", "suggestedReply": null}',
      ),
      base,
    );
    expect([v.violated, v.rationale]).toEqual([true, 'said "} bye" rudely']);
  });

  // Parseable is not the same as usable. A verdict with no boolean `violated` says nothing, and
  // reading it as "false" is the same silent approval the error field exists to end.
  test("an object with no boolean verdict is reported, not read as approval", async () => {
    for (const body of [
      "{}",
      '{"violated": "false"}',
      '{"violated": "true"}',
      '{"violated": null}',
      '{"categories": ["toxicity"]}',
    ]) {
      const v = await analyzeGuardrail(fakeModel(body), base);
      expect([body, v.violated, typeof v.error]).toEqual([
        body,
        false,
        "string",
      ]);
    }
  });

  test("an explicit false is a real approval, with no error", async () => {
    const v = await analyzeGuardrail(fakeModel('{"violated": false}'), base);
    expect([v.violated, v.error]).toEqual([false, undefined]);
  });

  // A model that answers twice has not answered: picking the first ignores a self-correction, and
  // picking the last would approve a real violation whenever the trailing object is the stale one.
  test("two conflicting verdicts are unanalyzed, not resolved by guessing", async () => {
    const v = await analyzeGuardrail(
      fakeModel(
        '{"violated": true, "categories": ["toxicity"], "rationale": "x", "suggestedReply": null}\n' +
          'Correction: {"violated": false, "categories": [], "rationale": "", "suggestedReply": null}',
      ),
      base,
    );
    expect([v.violated, typeof v.error]).toEqual([false, "string"]);
  });

  // A nested object belongs to its parent and must not read as a second answer.
  test("a nested object is not a second verdict", async () => {
    const v = await analyzeGuardrail(
      fakeModel(
        '{"violated": true, "categories": ["toxicity"], "rationale": "x", "suggestedReply": null, "meta": {"score": 1}}',
      ),
      base,
    );
    expect([v.violated, v.error]).toEqual([true, undefined]);
  });

  test("output with a malformed JSON object is reported", async () => {
    const v = await analyzeGuardrail(
      fakeModel('Sure: {"violated": true, categories: [oops}'),
      base,
    );
    expect([v.violated, typeof v.error]).toEqual([false, "string"]);
  });

  test("a genuine clean verdict is not reported as a failure", async () => {
    const v = await analyzeGuardrail(
      fakeModel('{"violated": false, "categories": [], "rationale": ""}'),
      base,
    );
    expect(v.error).toBeUndefined();
  });

  test("a violation is not reported as a failure", async () => {
    const v = await analyzeGuardrail(
      fakeModel(
        '{"violated": true, "categories": ["toxicity"], "rationale": "x", "suggestedReply": null}',
      ),
      base,
    );
    expect(v.error).toBeUndefined();
  });
});
