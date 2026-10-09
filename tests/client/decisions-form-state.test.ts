import { describe, expect, test } from "bun:test";
import {
  conditionFor,
  decisionsFormIssues,
  decisionsRefusalFrom,
  decisionsRefusalStanding,
  decisionsToForm,
  decisionsToStored,
  decisionsUntouched,
  issuesUnder,
  ruleIsBroken,
} from "@/client/pages/agents/decisionsFormState";
import {
  decisionsBlockToStore,
  observationToForm,
  observationToStored,
} from "@/client/pages/agents/observationFormState";
import {
  CHOICE_OPTIONS_MAX,
  decisionsIssues,
  decisionsSchema,
  QUESTIONS_MAX,
  SCORE_LEVELS_MAX,
} from "@/modules/decisions/config";
import { readMonitoringConfig } from "@/modules/observe/settings";

// The decisions block in the agent editor: stored block -> form -> stored block, asked the write
// boundary's own schema. What the form calls a problem has to be what the server refuses, at the
// same field, and a block nobody touched has to come back out as it went in.

const BLOCK = {
  provider: "typesafe",
  model: "jev-latest",
  credentialRef: "vault:12",
  questions: [
    { name: "pede_reembolso", type: "yes_no", instructions: "Pede reembolso?" },
    {
      name: "assunto",
      type: "choice",
      instructions: "Assunto principal",
      options: [
        { value: "reembolso", description: "estorno" },
        { value: "outro", description: "" },
      ],
    },
    {
      name: "irritacao",
      type: "score",
      instructions: "Quão irritado?",
      levels: [
        { value: "calmo", description: "" },
        { value: "frustrado", description: "" },
        { value: "muito_irritado", description: "" },
      ],
    },
  ],
  rules: [
    {
      when: [{ question: "pede_reembolso", minProbability: 0.7 }],
      action: { tool: "set_labels", args: { add: ["reembolso"] } },
    },
    {
      when: [
        { question: "assunto", equals: "reembolso", minConfidence: 0.8 },
        { question: "irritacao", minLevel: 2, maxLevel: 2 },
      ],
      action: { tool: "handoff_to_human", args: {} },
    },
  ],
  apply: "shadow",
};

// The fixture loosened to what a stored block may hold, so a test can break it.
interface Block {
  provider: string;
  model: string;
  credentialRef: string;
  questions: {
    name: string;
    type: string;
    instructions: string;
    options?: { value: string; description: string }[];
    levels?: { value: string; description: string }[];
  }[];
  rules: {
    when: Record<string, unknown>[];
    action: { tool: string; args: Record<string, unknown> };
  }[];
  apply: string;
}
const clone = (): Block => structuredClone(BLOCK) as Block;
function got<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("fixture");
  return v;
}
function formOf(block: unknown) {
  const form = decisionsToForm(block);
  if (!form) throw new Error("not a block");
  return form;
}
// The paths the form marks, sorted, for a block.
const marked = (block: unknown) =>
  [...decisionsFormIssues(formOf(block)).keys()].sort();

describe("the decisions block round trip", () => {
  test("a valid block survives form -> stored unchanged", () => {
    expect(decisionsToStored(formOf(BLOCK))).toEqual(BLOCK);
    expect(decisionsIssues(decisionsToStored(formOf(BLOCK)))).toEqual([]);
  });

  test("the same stored block always produces the same form", () => {
    expect(JSON.stringify(formOf(BLOCK))).toBe(JSON.stringify(formOf(BLOCK)));
  });

  test("a block nobody touched is written back as stored, optional keys absent included", () => {
    const minimal = {
      provider: "openai",
      credentialRef: "vault:1",
      questions: [{ name: "a", type: "yes_no", instructions: "?" }],
    };
    // An empty rule list is one the form would not write: untouched, it still goes back as stored.
    const emptyRules = { ...minimal, rules: [] };
    for (const decisions of [BLOCK, minimal, emptyRules]) {
      const stored = { monitoring: { engine: "decisions", decisions } };
      expect(observationToStored(observationToForm(stored))).toEqual(
        readMonitoringConfig(stored),
      );
    }
  });

  test("an argument the form has no field for survives an edit of the rule", () => {
    const block = clone();
    (
      block.rules[0] as { action: { args: Record<string, unknown> } }
    ).action.args = { add: ["reembolso"], scope: "contact" };
    const form = formOf(block);
    const rule = got(form.rules[0]);
    rule.args = { ...rule.args, add: ["vip"] };
    const out = decisionsToStored(form) as unknown as Block;
    expect(out.rules[0]?.action.args).toEqual({
      add: ["vip"],
      scope: "contact",
    });
  });

  test("only the operands the question's type reads are written", () => {
    const form = formOf(BLOCK);
    // Pointed at the yes/no question with the score's levels still typed in.
    const cond = form.rules[1]?.when[1];
    if (!cond) throw new Error("fixture");
    cond.question = "pede_reembolso";
    cond.minProbability = "0.5";
    cond.equals = "reembolso";
    cond.minConfidence = "0.9";
    const out = decisionsToStored(form) as unknown as Block;
    expect(out.rules[1]?.when[1]).toEqual({
      question: "pede_reembolso",
      minProbability: 0.5,
    });
  });

  test("picking a question for a condition leaves nothing over from the previous one", () => {
    const form = formOf(BLOCK);
    expect(conditionFor(form, "irritacao")).toEqual({
      question: "irritacao",
      minProbability: "",
      equals: "",
      minConfidence: "",
      minLevel: "0",
      maxLevel: "0",
    });
    expect(conditionFor(form, "assunto").equals).toBe("reembolso");
    expect(conditionFor(form, "pede_reembolso").minProbability).toBe("0.7");
  });

  test("text that is not a number travels as typed and is refused at its field", () => {
    const form = formOf(BLOCK);
    const cond = form.rules[0]?.when[0];
    if (!cond) throw new Error("fixture");
    cond.minProbability = "alto";
    const out = decisionsToStored(form) as unknown as Block;
    expect(out.rules[0]?.when[0]?.minProbability).toBe("alto");
    expect([...decisionsFormIssues(form).keys()]).toEqual([
      "rules.0.when.0.minProbability",
    ]);
  });
});

describe("the form marks what the server refuses, at the field", () => {
  test("a valid block marks nothing", () => {
    expect(marked(BLOCK)).toEqual([]);
  });

  // Each case is a block the write boundary refuses. The form must mark it too, at the input.
  const cases: [string, (b: Block) => void, string][] = [
    [
      "no credential",
      (b) => {
        b.credentialRef = "";
      },
      "credentialRef",
    ],
    [
      "no questions",
      (b) => {
        b.questions = [];
        b.rules = [];
      },
      "questions",
    ],
    [
      "a question without a name",
      (b) => {
        got(b.questions[0]).name = "";
      },
      "questions.0.name",
    ],
    [
      "a name the engine cannot use",
      (b) => {
        got(b.questions[0]).name = "Pede Reembolso";
      },
      "questions.0.name",
    ],
    [
      "a question without instructions",
      (b) => {
        got(b.questions[0]).instructions = "";
      },
      "questions.0.instructions",
    ],
    [
      "a repeated question name",
      (b) => {
        got(b.questions[1]).name = "pede_reembolso";
      },
      "questions.1.name",
    ],
    [
      "one option only",
      (b) => {
        got(b.questions[1]).options = [{ value: "reembolso", description: "" }];
      },
      "questions.1.options",
    ],
    [
      "a repeated option",
      (b) => {
        got(got(b.questions[1]).options?.[1]).value = "reembolso";
      },
      "questions.1.options.1.value",
    ],
    [
      "an option without a value",
      (b) => {
        got(got(b.questions[1]).options?.[1]).value = "";
      },
      "questions.1.options.1.value",
    ],
    [
      "one level only",
      (b) => {
        got(b.questions[2]).levels = [{ value: "calmo", description: "" }];
      },
      "questions.2.levels",
    ],
    [
      "a repeated level",
      (b) => {
        got(got(b.questions[2]).levels?.[1]).value = "calmo";
      },
      "questions.2.levels.1.value",
    ],
    [
      "a rule without a condition",
      (b) => {
        got(b.rules[0]).when = [];
      },
      "rules.0.when",
    ],
    [
      "a rule without an action",
      (b) => {
        got(b.rules[0]).action.tool = "";
      },
      "rules.0.action.tool",
    ],
    [
      "a yes/no condition without a threshold",
      (b) => {
        got(b.rules[0]).when = [{ question: "pede_reembolso" }];
      },
      "rules.0.when.0.minProbability",
    ],
    [
      "a probability above 1",
      (b) => {
        got(b.rules[0]).when = [
          { question: "pede_reembolso", minProbability: 1.5 },
        ];
      },
      "rules.0.when.0.minProbability",
    ],
    [
      "levels given highest first",
      (b) => {
        got(b.rules[1]).when = [
          { question: "irritacao", minLevel: 2, maxLevel: 0 },
        ];
      },
      "rules.1.when.0.minLevel",
    ],
  ];
  for (const [what, breakIt, path] of cases) {
    test(`${what} is marked at ${path}`, () => {
      const block = clone();
      breakIt(block);
      // The boundary refuses the block as the form writes it...
      expect(
        decisionsSchema.safeParse(decisionsToStored(formOf(block))).success,
      ).toBe(false);
      // ...and the form marks the input.
      expect(marked(block)).toContain(path);
    });
  }

  test("the limits the server enforces are enforced, with the list named", () => {
    const tooManyQuestions = clone();
    tooManyQuestions.questions = Array.from(
      { length: QUESTIONS_MAX + 1 },
      (_, i) => ({
        name: `q${i}`,
        type: "yes_no",
        instructions: "?",
      }),
    );
    tooManyQuestions.rules = [];
    expect(marked(tooManyQuestions)).toEqual(["questions"]);

    const tooManyLevels = clone();
    got(tooManyLevels.questions[2]).levels = Array.from(
      { length: SCORE_LEVELS_MAX + 1 },
      (_, i) => ({ value: `l${i}`, description: "" }),
    );
    expect(marked(tooManyLevels)).toEqual(["questions.2.levels"]);

    const tooManyOptions = clone();
    got(tooManyOptions.questions[1]).options = [
      { value: "reembolso", description: "" },
      ...Array.from({ length: CHOICE_OPTIONS_MAX }, (_, i) => ({
        value: `o${i}`,
        description: "",
      })),
    ];
    expect(marked(tooManyOptions)).toEqual(["questions.1.options"]);
  });

  test("every problem carries a code the screen can word", async () => {
    const codes = new Set<string>();
    for (const [, breakIt] of cases) {
      const block = clone();
      breakIt(block);
      for (const i of decisionsIssues(decisionsToStored(formOf(block)))) {
        codes.add(i.code);
      }
    }
    // Every one of them is a code `issueText` (DecisionsFields.tsx) has a sentence for.
    const source = await Bun.file(
      "src/client/pages/agents/DecisionsFields.tsx",
    ).text();
    expect(codes.size).toBeGreaterThanOrEqual(8);
    for (const code of codes) {
      expect(source.includes(`case "${code}":`), code).toBe(true);
    }
  });
});

describe("a rule that names something that no longer exists is broken", () => {
  test("a valid block has no broken rule", () => {
    const issues = decisionsFormIssues(formOf(BLOCK));
    expect([0, 1].map((r) => ruleIsBroken(issues, r))).toEqual([false, false]);
  });

  test("a deleted question breaks the rule that names it, and only that one", () => {
    const form = formOf(BLOCK);
    form.questions = form.questions.filter((q) => q.name !== "pede_reembolso");
    const issues = decisionsFormIssues(form);
    expect([0, 1].map((r) => ruleIsBroken(issues, r))).toEqual([true, false]);
    expect(issuesUnder(issues, "rules.0").map((i) => i.code)).toEqual([
      "unknown_question",
    ]);
    // The condition keeps what it held, so nothing is lost while it is pointed elsewhere.
    const out = decisionsToStored(form) as unknown as Block;
    expect(out.rules[0]?.when[0]).toEqual({
      question: "pede_reembolso",
      minProbability: 0.7,
    });
  });

  test("a renamed option breaks the rule that names the old value", () => {
    const form = formOf(BLOCK);
    const option = form.questions[1]?.options[0];
    if (!option) throw new Error("fixture");
    option.value = "estorno";
    const issues = decisionsFormIssues(form);
    expect(ruleIsBroken(issues, 1)).toBe(true);
    expect([...issues.keys()]).toEqual(["rules.1.when.0.equals"]);
  });

  test("a shortened scale breaks the rule that names a level past its end", () => {
    const form = formOf(BLOCK);
    const q = form.questions[2];
    if (!q) throw new Error("fixture");
    q.levels = q.levels.slice(0, 2);
    const issues = decisionsFormIssues(form);
    expect(ruleIsBroken(issues, 1)).toBe(true);
    expect([...issues.keys()]).toEqual(["rules.1.when.1.maxLevel"]);
  });

  test("an incomplete rule is a problem and not a broken one", () => {
    const form = formOf(BLOCK);
    const rule = form.rules[0];
    if (!rule) throw new Error("fixture");
    rule.when = [];
    const issues = decisionsFormIssues(form);
    expect(issues.size).toBe(1);
    expect(ruleIsBroken(issues, 0)).toBe(false);
  });
});

describe("what a save of the Observation block writes", () => {
  const stored = { monitoring: { engine: "decisions", decisions: BLOCK } };

  test("switching to the model engine keeps the questions and rules", () => {
    const form = observationToForm(stored);
    const out = observationToStored({ ...form, engine: "llm" });
    expect(out.engine).toBe("llm");
    expect(out.decisions).toEqual(BLOCK);
    // ...and switching again finds them.
    const back = observationToForm({
      monitoring: { ...out, engine: "decisions" },
    });
    expect(decisionsToStored(got(back.decisions ?? undefined))).toEqual(BLOCK);
  });

  test("an edit is written when the engine is decisions", () => {
    const form = observationToForm(stored);
    if (!form.decisions) throw new Error("fixture");
    form.decisions.apply = "enforce";
    expect(decisionsUntouched(form.decisions, form.storedDecisions)).toBe(
      false,
    );
    expect(observationToStored(form).decisions).toEqual({
      ...BLOCK,
      apply: "enforce",
    });
  });

  test("a draft that cannot run is not stored over a block that can while the model decides", () => {
    const form = observationToForm(stored);
    if (!form.decisions) throw new Error("fixture");
    form.decisions.questions = [];
    form.decisions.rules = [];
    expect(decisionsBlockToStore({ ...form, engine: "llm" })).toEqual(BLOCK);
    // With the engine on, the draft is what goes out: the save gate is what stops it.
    expect(decisionsBlockToStore(form)).not.toEqual(BLOCK);
  });

  test("an agent that never had a block writes none", () => {
    expect(observationToStored(observationToForm({})).decisions).toBeNull();
  });
});

describe("a refusal the server answers about the block", () => {
  test("is placed by the path it names, under either spelling of the root", () => {
    for (const field of [
      "monitoring.decisions.rules.0.when.0.question",
      "settings.monitoring.decisions.rules.0.when.0.question",
    ]) {
      expect(decisionsRefusalFrom({ message: "no", field }, BLOCK)?.path).toBe(
        "rules.0.when.0.question",
      );
    }
    expect(
      decisionsRefusalFrom(
        { message: "no", field: "monitoring.decisions" },
        BLOCK,
      )?.path,
    ).toBe("");
  });

  test("leaves alone what is not about the block, and the API key the editor owns", () => {
    for (const field of [
      undefined,
      "name",
      "monitoring.engine",
      "settings.monitoring.decisions.credentialRef",
    ]) {
      expect(decisionsRefusalFrom({ message: "no", field }, BLOCK)).toBeNull();
    }
    expect(decisionsRefusalFrom(null, BLOCK)).toBeNull();
  });

  test("stands while the block is what was sent, and expires when it is edited", () => {
    const held = decisionsRefusalFrom(
      { message: "no", field: "monitoring.decisions.questions.0.name" },
      BLOCK,
    );
    expect(decisionsRefusalStanding(held, clone())).toEqual({
      path: "questions.0.name",
      message: "no",
    });
    expect(
      decisionsRefusalStanding(held, { ...BLOCK, apply: "enforce" }),
    ).toBeNull();
    expect(decisionsRefusalStanding(null, BLOCK)).toBeNull();
  });
});
