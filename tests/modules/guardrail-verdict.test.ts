import { describe, expect, test } from "bun:test";
import {
  MODEL_PROVIDERS,
  type VerdictAskMode,
  verdictAskMode,
} from "@/graph/model-config";
import {
  type GuardrailVerdict,
  readVerdict,
  VERDICT_SCHEMA,
  VERDICT_SCHEMA_OPENAPI,
  verdictFromObject,
} from "@/modules/guardrails/verdict";

// Two tables, and they answer the two halves of issue #131: HOW each endpoint is asked for the
// verdict, and how a verdict is read once it comes back, in whichever shape it came.
//
// The axis both tables turn on is the one this module keeps getting wrong: a verdict that could not
// be read must stay distinguishable from a verdict that says "clean". This is a moderation feature
// and it fails OPEN, so every ambiguity that collapses into CLEAN is a message delivered unscreened
// under a guardrail the operator believes is running.

describe("how each provider is asked for the verdict", () => {
  // Measured, not assumed. What a wrong row costs is not symmetric: a provider wrongly on "prose"
  // keeps today's behaviour, while one asked in the wrong dialect is refused on every screen and
  // only survives it because a refused request is remade in prose.
  const table: Record<(typeof MODEL_PROVIDERS)[number], VerdictAskMode> = {
    // json_schema with strict is OpenAI's own; the adapter falls back to function calling on the
    // ids that predate it (gpt-4 and older), so no id is left without a constrained path.
    openai: "json-schema",
    // The adapter asks with a FORCED tool call, which every current Anthropic model implements.
    anthropic: "json-schema",
    // The OpenAPI 3.0 subset, where nullability is a flag and not a type union. Measured live on
    // gemini-3.5-flash and -flash-lite: the other dialect is refused with a 400, this one answers
    // in a single call.
    google: "openapi",
    // The API implements json_object only and answers "unavailable now" to json_schema.
    deepseek: "prose",
    // Support is per ENDPOINT behind the router, not per model, and it changes without notice; the
    // router simply fails the request when it lands on a provider that lacks it.
    openrouter: "prose",
    // An arbitrary server by definition. Measured against a local one that ignores the parameter:
    // the client retried the same call six times over a minute and never settled, while the
    // unconstrained call it makes today answered on the first try.
    "openai-compatible": "prose",
  };

  for (const provider of MODEL_PROVIDERS) {
    test(`${provider}: ${table[provider]}`, () => {
      expect(verdictAskMode(provider)).toBe(table[provider]);
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

// The two dialects are the same verdict, so they may differ ONLY in how a nullable field is
// spelled. `VERDICT_SCHEMA_OPENAPI` is derived from the other one, which keeps the shared fields in
// step by construction; what derivation cannot catch is a NEW nullable field, which would silently
// keep its type union and be refused by Gemini on every screen. That is what this asserts.
describe("VERDICT_SCHEMA_OPENAPI", () => {
  const props = (s: { properties: Record<string, { type: unknown }> }) =>
    Object.keys(s.properties).sort();

  test("carries the same fields and the same required list", () => {
    expect(props(VERDICT_SCHEMA_OPENAPI)).toEqual(props(VERDICT_SCHEMA));
    expect([...VERDICT_SCHEMA_OPENAPI.required]).toEqual([
      ...VERDICT_SCHEMA.required,
    ]);
  });

  test("spells every nullable field as a flag, never as a type union", () => {
    const unions = Object.entries(VERDICT_SCHEMA_OPENAPI.properties)
      .filter(([, v]) => Array.isArray((v as { type: unknown }).type))
      .map(([k]) => k);
    expect(unions).toEqual([]);
  });

  test("keeps null reachable for the fields that had it", () => {
    const nullableHere = Object.entries(VERDICT_SCHEMA_OPENAPI.properties)
      .filter(([, v]) => (v as { nullable?: unknown }).nullable === true)
      .map(([k]) => k);
    const nullableThere = Object.entries(VERDICT_SCHEMA.properties)
      .filter(([, v]) => {
        const t = (v as { type: unknown }).type;
        return Array.isArray(t) && (t as string[]).includes("null");
      })
      .map(([k]) => k);
    expect(nullableHere.sort()).toEqual(nullableThere.sort());
  });
});
