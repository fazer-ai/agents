import { describe, expect, test } from "bun:test";
import {
  acceptsConstrainedOutput,
  MODEL_PROVIDERS,
} from "@/graph/model-config";
import {
  type GuardrailVerdict,
  readVerdict,
  VERDICT_SCHEMA,
  verdictFromObject,
} from "@/modules/guardrails/verdict";

// Two tables, and they answer the two halves of issue #131: WHERE the constrained verdict may be
// asked for, and HOW a verdict is read once it comes back either way.
//
// The axis both tables turn on is the one this module keeps getting wrong: a verdict that could not
// be read must stay distinguishable from a verdict that says "clean". This is a moderation feature
// and it fails OPEN, so every ambiguity that collapses into CLEAN is a message delivered unscreened
// under a guardrail the operator believes is running.

describe("which providers may be asked for a constrained verdict", () => {
  // Measured, not assumed. What each row costs when it is wrong is not symmetric: a provider
  // wrongly on the list stops screening (the call fails and the guardrail fails open), while a
  // provider wrongly off it keeps exactly today's behaviour.
  const table: Record<(typeof MODEL_PROVIDERS)[number], boolean> = {
    // json_schema with strict is OpenAI's own; the adapter falls back to function calling on the
    // ids that predate it (gpt-4 and older), so no id is left without a constrained path.
    openai: true,
    // The adapter asks with a FORCED tool call, which every current Anthropic model implements.
    anthropic: true,
    // Out over a DIALECT: Gemini's responseSchema is the OpenAPI subset, where nullability is
    // `nullable: true` and not a type union, and the adapter forwards ours unconverted (the wire is
    // asserted in tests/modules/guardrail-constrained.test.ts). Asking with the other dialect is
    // not a shared answer either: OpenAI ignores `nullable` and the field becomes a required
    // string, which pushes the model into inventing a replacement.
    google: false,
    // The API implements json_object only and answers "unavailable now" to json_schema.
    deepseek: false,
    // Support is per ENDPOINT behind the router, not per model, and it changes without notice; the
    // router simply fails the request when it lands on a provider that lacks it.
    openrouter: false,
    // An arbitrary server by definition. Measured against a local one that ignores the parameter:
    // the client retried the same call six times over a minute and never settled, while the
    // unconstrained call it makes today answered on the first try.
    "openai-compatible": false,
  };

  for (const provider of MODEL_PROVIDERS) {
    test(`${provider}: ${table[provider] ? "constrained" : "prose"}`, () => {
      expect(acceptsConstrainedOutput(provider)).toBe(table[provider]);
    });
  }

  // The list is a claim about endpoints we do not own, so it has to be readable as one. A provider
  // added to MODEL_PROVIDERS without a decision here would default to whatever the code happens to
  // do, which is how a new provider silently loses its screening.
  test("every provider is decided, not defaulted", () => {
    expect(Object.keys(table).sort()).toEqual([...MODEL_PROVIDERS].sort());
  });
});

describe("verdictFromObject", () => {
  const cases: Array<{
    name: string;
    input: Record<string, unknown>;
    expected: GuardrailVerdict | null;
  }> = [
    {
      name: "a clean verdict carries nothing else, whatever the model also wrote",
      input: {
        violated: false,
        categories: ["toxicity"],
        rationale: "quase",
        suggestedReply: "oi",
      },
      expected: {
        violated: false,
        categories: [],
        rationale: "",
        suggestedReply: null,
      },
    },
    {
      name: "a violation keeps its categories, rationale and replacement",
      input: {
        violated: true,
        categories: ["toxicity"],
        rationale: "xingamento",
        suggestedReply: "Posso ajudar de outra forma?",
      },
      expected: {
        violated: true,
        categories: ["toxicity"],
        rationale: "xingamento",
        suggestedReply: "Posso ajudar de outra forma?",
      },
    },
    {
      name: "non-string categories drop out instead of reaching the log",
      input: { violated: true, categories: ["toxicity", 7, null] },
      expected: {
        violated: true,
        categories: ["toxicity"],
        rationale: "",
        suggestedReply: null,
      },
    },
    {
      name: "a blank replacement is no replacement, so the template goes out instead",
      input: { violated: true, categories: [], suggestedReply: "   " },
      expected: {
        violated: true,
        categories: [],
        rationale: "",
        suggestedReply: null,
      },
    },
    {
      // The one rule the whole module rests on: `violated` is the answer, and a value that is not a
      // boolean is not an answer. A string "false" reads as truthy in JS and as clean to a human,
      // which is the exact pair that makes this worth a row.
      name: "a non-boolean verdict is not a verdict",
      input: { violated: "true", categories: [] },
      expected: null,
    },
    {
      name: "an empty object is parseable and still says nothing",
      input: {},
      expected: null,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(verdictFromObject(c.input)).toEqual(c.expected);
    });
  }
});

// The reader both call paths end at. `parsed` is what the schema produced (null when the model was
// never constrained, or when the constrained answer could not be validated), `raw` is the text the
// model actually wrote.
describe("readVerdict", () => {
  const clean = '{"violated": false, "categories": [], "rationale": ""}';

  test("a schema answer is used as-is, and the raw text is not consulted", () => {
    const v = readVerdict(
      { violated: true, categories: ["toxicity"], rationale: "x" },
      // Contradicts the schema answer on purpose: if this text were read, the assertion below fails.
      clean,
    );
    expect(v.violated).toBe(true);
    expect(v.error).toBeUndefined();
  });

  // Defence in depth for a provider that IS on the list: an answer the schema could not validate
  // must not throw away the text the model wrote. Reading it is exactly what the prose path does
  // today, so recovering here is not a new behaviour, it is the old one still reachable.
  test("no schema answer falls back to the prose the model wrote", () => {
    const v = readVerdict(null, `Aqui está: ${clean}`);
    expect(v.violated).toBe(false);
    expect(v.error).toBeUndefined();
  });

  test("no schema answer and no readable prose is NOT a clean verdict", () => {
    const v = readVerdict(null, "não consegui analisar");
    expect(v.violated).toBe(false);
    expect(v.error).toBe("no usable verdict in response");
  });

  // Same rule as the prose path: two verdicts is a model correcting itself, and picking either one
  // is a guess. The schema answer wins only because it is not a guess.
  test("two prose verdicts stay unreadable rather than being guessed at", () => {
    const v = readVerdict(
      null,
      `{"violated": true, "categories": ["toxicity"]} Correção: ${clean}`,
    );
    expect(v.error).toBe("2 conflicting verdicts in response");
  });
});

describe("VERDICT_SCHEMA", () => {
  // strict mode (OpenAI) rejects a schema whose object does not close itself off, and it requires
  // every property to be listed as required. `suggestedReply` is therefore required AND nullable,
  // which is how "the model must answer this field" and "null is a legitimate answer" coexist.
  test("is strict-mode shaped: closed, and every field required", () => {
    expect(VERDICT_SCHEMA.additionalProperties).toBe(false);
    expect(([...VERDICT_SCHEMA.required] as string[]).sort()).toEqual(
      Object.keys(VERDICT_SCHEMA.properties).sort(),
    );
  });

  test("null is a legal value for the replacement, and only for it", () => {
    const nullable = Object.entries(VERDICT_SCHEMA.properties)
      .filter(([, v]) => Array.isArray(v.type) && v.type.includes("null"))
      .map(([k]) => k);
    expect(nullable).toEqual(["suggestedReply"]);
  });
});
