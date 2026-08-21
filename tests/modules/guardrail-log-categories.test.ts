import { describe, expect, test } from "bun:test";
import { loggableCategories } from "@/modules/guardrails/log-categories";
import { GUARDRAIL_CATEGORY_KEYS } from "@/modules/guardrails/prompts";

// Decision table for what a verdict's `categories` may leave in `execution_logs.detail` (issue
// #141). The field reads like an enum and is model-written, so the rule has to answer two questions
// at once: keep nothing the model invented, and still say that it invented something, because a
// violation of the operator's `customPolicy` legitimately has no key to be named by.

describe("loggableCategories", () => {
  test("the vocabulary is the keys the prompt actually asks for", () => {
    // Spelled out rather than derived, so a rename in the prompt has to be made here on purpose.
    expect([...GUARDRAIL_CATEGORY_KEYS].sort()).toEqual([
      "answer_relevance",
      "competitor_mention",
      "prompt_adherence",
      "toxicity",
      "unsafe_content",
    ]);
  });

  const cases: Array<{
    name: string;
    input: string[];
    expected: { categories: string[]; categoriesUnnamed?: number };
  }> = [
    {
      name: "no categories at all",
      input: [],
      expected: { categories: [] },
    },
    {
      name: "every key from the vocabulary survives, in order",
      input: ["toxicity", "unsafe_content"],
      expected: { categories: ["toxicity", "unsafe_content"] },
    },
    {
      name: "a sentence where a key belongs is dropped and counted",
      input: ["toxicity", "o cliente citou o CPF 12345678900"],
      expected: { categories: ["toxicity"], categoriesUnnamed: 1 },
    },
    {
      name: "a near-miss spelling is not a key either",
      input: ["unsafeContent"],
      expected: { categories: [], categoriesUnnamed: 1 },
    },
    {
      name: "the custom policy has no key, so it can only be counted",
      input: ["custom_policy"],
      expected: { categories: [], categoriesUnnamed: 1 },
    },
    {
      name: "several strangers count as several",
      input: ["custom_policy", "porque o cliente insistiu", "toxicity"],
      expected: { categories: ["toxicity"], categoriesUnnamed: 2 },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(loggableCategories(c.input)).toEqual(c.expected);
    });
  }

  // The count is absent, not zero, when nothing was dropped: a key that is always there stops being
  // read, and the question it answers ("did something fire that we cannot name?") only exists when
  // the answer is yes.
  test("a clean list carries no count at all", () => {
    expect("categoriesUnnamed" in loggableCategories(["toxicity"])).toBe(false);
  });
});
