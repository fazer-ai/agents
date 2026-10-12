import { describe, expect, test } from "bun:test";
import {
  actionScope,
  conditionFor,
  conditionSummary,
  customToolsOf,
  DECISION_TEXT_FIELD_MAX,
  decisionsFormIssues,
  decisionsRefusalFrom,
  decisionsRefusalStanding,
  decisionsToForm,
  decisionsToStored,
  decisionsUntouched,
  decisionTextCap,
  issuesUnder,
  ruleIsBroken,
  ruleTriggerShown,
  withActionScope,
} from "@/client/pages/agents/decisionsFormState";
import {
  decisionsBaseline,
  decisionsBlockToStore,
  editDecisions,
  observationToForm,
  observationToStored,
} from "@/client/pages/agents/observationFormState";
import { namespacedToolName } from "@/graph/tools/mcp";
import { mcpRuntimeBase } from "@/graph/tools/mcp-names";
import {
  CHOICE_OPTIONS_MAX,
  decisionsBlockFingerprint,
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
    trigger?: string;
  }[];
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
      expect<unknown>(observationToStored(observationToForm(stored))).toEqual(
        readMonitoringConfig(stored),
      );
    }
  });

  // The engine compares a condition's `equals` with the option's value literally, so a pair the
  // stored block spells with a space works, and the form must not tidy one side of it.
  test("a value stored with surrounding space is written as stored, and its rule stays whole", () => {
    const block = clone();
    got(got(block.questions[1]).options?.[0]).value = " reembolso ";
    got(block.rules[1]).when = [{ question: "assunto", equals: " reembolso " }];
    expect(decisionsSchema.safeParse(block).success).toBe(true);
    const form = formOf(block);
    // Edited elsewhere, so the block is written through the form.
    form.model = "gpt-6-sol";
    expect(decisionsToStored(form)).toEqual({ ...block, model: "gpt-6-sol" });
    const issues = decisionsFormIssues(form);
    expect(issues.size).toBe(0);
    expect(ruleIsBroken(issues, 1)).toBe(false);
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
    cond.minProbability = "50";
    cond.equals = "reembolso";
    cond.minConfidence = "90";
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
    expect(conditionFor(form, "pede_reembolso").minProbability).toBe("70");
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

// When a rule acts: shown with the action's default until the operator picks one, and
// written only when picked, so a rule left alone keeps following its action's default.
describe("when a rule acts", () => {
  test("a rule with no trigger shows its action's default and is written without one", () => {
    const form = formOf(BLOCK);
    expect(form.rules.map(ruleTriggerShown)).toEqual(["each_time", "on_start"]);
    expect(form.rules.map((r) => r.trigger)).toEqual(["", ""]);
    expect(decisionsToStored(form)).toEqual(BLOCK);
  });

  test("a note rule shows when the conditions start holding; a label rule, every time", () => {
    const form = formOf(BLOCK);
    const note = { ...got(form.rules[0]), tool: "private_note", args: {} };
    expect(ruleTriggerShown(note)).toBe("on_start");
    expect(ruleTriggerShown({ ...note, tool: "set_labels" })).toBe("each_time");
  });

  test("a picked trigger is written, round-trips, and survives an action change", () => {
    const block = clone();
    got(block.rules[0]).trigger = "once";
    const form = formOf(block);
    expect(got(form.rules[0]).trigger).toBe("once");
    expect<unknown>(decisionsToStored(form)).toEqual(block);
    const changed = {
      ...form,
      rules: form.rules.map((r, i) =>
        i === 0 ? { ...r, tool: "private_note", args: { content: "x" } } : r,
      ),
    };
    expect(ruleTriggerShown(got(changed.rules[0]))).toBe("once");
    expect(
      (decisionsToStored(changed).rules as { trigger?: string }[])[0]?.trigger,
    ).toBe("once");
  });

  test("a trigger the server does not know is marked at its field", () => {
    const block = clone();
    got(block.rules[0]).trigger = "sempre_que_der";
    expect(marked(block)).toContain("rules.0.trigger");
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
});

// The form fills in what a stored block lacks so it can be drawn. Judging that reading instead of
// the block would call sound a block the engine refuses, on a screen whose save writes it back.
describe("a stored block the engine refuses is not shown as sound", () => {
  // The fixture as plain JSON, so a key can be taken out of it.
  const raw = () =>
    JSON.parse(JSON.stringify(BLOCK)) as {
      questions: Record<string, unknown>[];
    } & Record<string, unknown>;

  test("a question stored without a type shows the type as still to pick, and says so", () => {
    const block = raw();
    delete got(block.questions[0]).type;
    expect(decisionsSchema.safeParse(block).success).toBe(false);
    const form = formOf(block);
    expect(form.questions[0]?.type).toBe("");
    expect([...decisionsFormIssues(form, block).keys()]).toContain(
      "questions.0.type",
    );
    // Picking the type is an edit, and it is written.
    got(form.questions[0]).type = "yes_no";
    expect(decisionsUntouched(form, block)).toBe(false);
    expect(decisionsFormIssues(form, block).size).toBe(0);
    expect(decisionsToStored(form)).toEqual(BLOCK);
  });

  test("an untouched form is judged by the block a save writes back, not by its own reading", () => {
    // An option with no `description`: the form reads it as empty, the boundary asks for the key.
    const block = raw();
    const options = got(block.questions[1]).options as Record<
      string,
      unknown
    >[];
    delete got(options[1]).description;
    expect(decisionsSchema.safeParse(block).success).toBe(false);
    const form = formOf(block);
    expect(decisionsFormIssues(form).size).toBe(0);
    expect([...decisionsFormIssues(form, block).keys()]).toEqual([
      "questions.1.options.1.description",
    ]);
    // Any edit writes the form's block, which carries the key, and the problem is gone.
    form.model = "gpt-6-sol";
    expect(decisionsFormIssues(form, block).size).toBe(0);
  });
});

// A stored value the form reads as the same thing it shows (an empty model, a threshold stored as
// text) compares equal to its own reading. Retyping it is still an edit, and is written.
describe("a stored value the form normalizes can be repaired by editing it", () => {
  const storedWith = (block: unknown) =>
    observationToForm({
      monitoring: { engine: "decisions", decisions: block },
    });

  test("an empty stored model, typed and cleared, is written as no model", () => {
    const block: Record<string, unknown> = { ...clone(), model: "" };
    expect(decisionsSchema.safeParse(block).success).toBe(false);
    let form = storedWith(block);
    expect(form.decisions?.model).toBe("");
    form = editDecisions(form, (d) => ({ ...d, model: "jev-1.13.0" }));
    form = editDecisions(form, (d) => ({ ...d, model: "" }));
    const written = decisionsBlockToStore(form);
    expect(written).not.toHaveProperty("model");
    expect(decisionsIssues(written)).toEqual([]);
    const edited = form.decisions;
    if (!edited) throw new Error("fixture");
    expect(decisionsFormIssues(edited, decisionsBaseline(form)).size).toBe(0);
  });

  test("a threshold stored as text, retyped as the number it shows, is written as a number", () => {
    const block = clone();
    got(block.rules[0]).when = [
      { question: "pede_reembolso", minProbability: "0.7" },
    ];
    let form = storedWith(block);
    form = editDecisions(form, (d) => structuredClone(d));
    const written = decisionsBlockToStore(form) as unknown as Block;
    expect(got(written.rules[0]).when[0]?.minProbability).toBe(0.7);
  });

  test("a form nobody edited still writes the stored block back as it is", () => {
    const block: Record<string, unknown> = { ...clone(), model: "" };
    const form = storedWith(block);
    expect(decisionsBlockToStore(form)).toEqual(block);
    expect(decisionsBaseline(form)).toEqual(block);
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
    form.decisions.model = "gpt-6-sol";
    expect(decisionsUntouched(form.decisions, form.storedDecisions)).toBe(
      false,
    );
    expect(observationToStored(form).decisions).toEqual({
      ...BLOCK,
      model: "gpt-6-sol",
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

  test("an agent flipped to production does not send a broken draft nobody can see", () => {
    // The bag keeps `engine: "decisions"` while the whole Observation section is hidden.
    const form = observationToForm(stored);
    if (!form.decisions) throw new Error("fixture");
    form.decisions.questions = [];
    form.decisions.rules = [];
    expect(decisionsBlockToStore(form, false)).toEqual(BLOCK);
    expect(observationToStored(form, false).decisions).toEqual(BLOCK);
    // ...and so is the engine choice: an agent with no block that was switched to decisions on
    // screen and then flipped to production must not write `engine: "decisions"` with no block.
    const fresh = observationToForm({});
    const drafted = {
      ...fresh,
      engine: "decisions" as const,
      decisions: formOf({ provider: "openai" }),
    };
    const out = observationToStored(drafted, false);
    expect(out.engine).toBe("llm");
    expect(out).not.toHaveProperty("decisions");
    // The stored pair goes back whole even when the draft could run: half of an unseen change.
    const fine = observationToForm(stored);
    if (!fine.decisions) throw new Error("fixture");
    fine.decisions.model = "gpt-6-sol";
    expect<unknown>(
      observationToStored({ ...fine, engine: "llm" }, false),
    ).toEqual(readMonitoringConfig(stored));
  });

  // Every tick of such an agent is skipped (`decisions_config_invalid`), so the editor must show
  // what is missing instead of an engine choice with no fields under it.
  test("an agent stored on the decisions engine with no block opens on an editable draft", () => {
    for (const monitoring of [
      { engine: "decisions" },
      { engine: "decisions", decisions: null },
    ]) {
      const form = observationToForm({ monitoring });
      expect(form.storedDecisions).toBeNull();
      expect(form.decisions?.provider).toBe("openai");
      expect(
        [
          ...decisionsFormIssues(got(form.decisions ?? undefined)).keys(),
        ].sort(),
      ).toEqual(["credentialRef", "questions"]);
    }
    // An agent on the model engine with no block still has none.
    expect(observationToForm({}).decisions).toBeNull();
  });

  test("an agent that never had a block writes none", () => {
    expect(observationToStored(observationToForm({}))).not.toHaveProperty(
      "decisions",
    );
  });
});

describe("where a labels or attribute action writes", () => {
  const rule = (args: Record<string, unknown>, tool = "set_custom_attribute") =>
    got(
      formOf({ ...BLOCK, rules: [{ when: [], action: { tool, args } }] })
        .rules[0],
    );

  test("is the conversation unless the stored argument says otherwise", () => {
    expect(actionScope(rule({ key: "a", value: "b" }))).toBe("conversation");
    expect(actionScope(rule({ key: "a", value: "b", scope: "contact" }))).toBe(
      "contact",
    );
  });

  test("changing it drops the attribute key, which belonged to the other scope", () => {
    const contact = rule({ key: "tier", value: "gold", scope: "contact" });
    expect(withActionScope(contact, "conversation").args).toEqual({
      value: "gold",
    });
    expect(
      withActionScope(rule({ key: "a", value: "b" }), "contact").args,
    ).toEqual({ value: "b", scope: "contact" });
    // Choosing the scope it already has changes nothing.
    expect(withActionScope(contact, "contact").args).toEqual(contact.args);
  });

  test("a labels action keeps its labels across a scope change", () => {
    const labels = rule({ add: ["vip"] }, "set_labels");
    expect(withActionScope(labels, "contact").args).toEqual({
      add: ["vip"],
      scope: "contact",
    });
  });
});

describe("the mark of the questions and rules a tick ran", () => {
  test("is the same whatever order the keys come back in", () => {
    // `args` is the one object the tick's reader carries as stored, key order included.
    const twoArgs = clone();
    got(twoArgs.rules[0]).action.args = { add: ["a"], remove: ["b"] };
    const shuffled = clone();
    got(shuffled.rules[0]).action.args = { remove: ["b"], add: ["a"] };
    expect(decisionsBlockFingerprint(shuffled)).toBe(
      decisionsBlockFingerprint(twoArgs) as string,
    );
    expect(decisionsBlockFingerprint(twoArgs)).not.toBe(
      decisionsBlockFingerprint(BLOCK),
    );
  });

  test("changes when the rules are reordered or a question changes", () => {
    const mark = decisionsBlockFingerprint(BLOCK);
    const reordered = clone();
    reordered.rules.reverse();
    expect(decisionsBlockFingerprint(reordered)).not.toBe(mark);
    const reworded = clone();
    got(reworded.questions[0]).instructions = "Outra pergunta?";
    expect(decisionsBlockFingerprint(reworded)).not.toBe(mark);
  });

  test("survives what does not change what a rule index means", () => {
    const mark = decisionsBlockFingerprint(BLOCK);
    expect(
      decisionsBlockFingerprint({
        ...BLOCK,
        credentialRef: "vault:99",
      }),
    ).toBe(mark as string);
  });

  test("a block that could not run has none", () => {
    expect(decisionsBlockFingerprint({ ...BLOCK, questions: [] })).toBeNull();
    expect(decisionsBlockFingerprint(null)).toBeNull();
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
      decisionsRefusalStanding(held, { ...BLOCK, model: "gpt-6-sol" }),
    ).toBeNull();
    expect(decisionsRefusalStanding(null, BLOCK)).toBeNull();
  });
});

// The two free-text fields are bounded when typed and cut nowhere, so a longer text stored through
// the API must not be drawn as past a limit: the shared counter would say the agent receives only
// the first part of it, which is false for these fields.
describe("the cap a free-text field declares", () => {
  test("is the typing bound, raised to a stored text that is already longer", () => {
    expect(decisionTextCap("")).toBe(DECISION_TEXT_FIELD_MAX);
    expect(decisionTextCap("x".repeat(DECISION_TEXT_FIELD_MAX))).toBe(
      DECISION_TEXT_FIELD_MAX,
    );
    const long = "x".repeat(DECISION_TEXT_FIELD_MAX + 500);
    expect(decisionTextCap(long)).toBe(long.length);
  });
});

// A folded rule is read in one line, and the confidence floor decides when it fires: a rule asking
// for 10% and one asking for 95% must not look the same.
describe("a folded rule's condition", () => {
  const cond = (over: Record<string, string>) => ({
    question: "assunto",
    minProbability: "",
    equals: "",
    minConfidence: "",
    minLevel: "",
    maxLevel: "",
    ...over,
  });
  const question = (type: string) =>
    got(
      formOf({
        ...BLOCK,
        questions: [
          {
            name: "assunto",
            type,
            instructions: "x",
            options: [{ value: "reembolso" }, { value: "outro" }],
            levels: [{ value: "baixo" }, { value: "alto" }],
          },
        ],
        rules: [],
      }),
    ).questions[0];

  test("names the confidence floor of a choice", () => {
    const q = question("choice");
    expect(conditionSummary(cond({ equals: "reembolso" }), q)).toBe(
      "assunto = reembolso",
    );
    const low = conditionSummary(
      cond({ equals: "reembolso", minConfidence: "10" }),
      q,
    );
    const high = conditionSummary(
      cond({ equals: "reembolso", minConfidence: "95" }),
      q,
    );
    expect(low).toBe("assunto = reembolso (≥ 10%)");
    expect(high).toBe("assunto = reembolso (≥ 95%)");
  });

  test("names it on a score, for one level and for a range", () => {
    const q = question("score");
    expect(
      conditionSummary(
        cond({ minLevel: "1", maxLevel: "1", minConfidence: "80" }),
        q,
      ),
    ).toBe("assunto = alto (≥ 80%)");
    expect(
      conditionSummary(
        cond({ minLevel: "0", maxLevel: "1", minConfidence: "80" }),
        q,
      ),
    ).toBe("assunto = baixo…alto (≥ 80%)");
    expect(conditionSummary(cond({ minLevel: "0", maxLevel: "1" }), q)).toBe(
      "assunto = baixo…alto",
    );
  });

  test("a yes or no condition reads by its probability", () => {
    expect(
      conditionSummary(cond({ minProbability: "70" }), question("yes_no")),
    ).toBe("assunto ≥ 70%");
    expect(conditionSummary(cond({}), undefined)).toBe("assunto");
  });
});

// Thresholds are read and typed as percentages and stored as the fraction the engine compares
// with: an operator thinks "70%", not "0.7".
describe("a threshold on screen", () => {
  const stored = {
    provider: "openai",
    credentialRef: "vault:1",
    questions: [
      { name: "pede", type: "yes_no", instructions: "?" },
      {
        name: "assunto",
        type: "choice",
        instructions: "?",
        options: [
          { value: "a", description: "" },
          { value: "b", description: "" },
        ],
      },
    ],
    rules: [
      {
        when: [{ question: "pede", minProbability: 0.7 }],
        action: { tool: "set_labels", args: { add: ["x"] } },
      },
      {
        when: [{ question: "assunto", equals: "a", minConfidence: 0.65 }],
        action: { tool: "set_labels", args: { add: ["y"] } },
      },
    ],
  };
  test("reads as a percentage and is written back as the fraction", () => {
    const form = decisionsToForm(stored);
    if (!form) throw new Error("fixture");
    expect(form.rules[0]?.when[0]?.minProbability).toBe("70");
    expect(form.rules[1]?.when[0]?.minConfidence).toBe("65");
    const out = decisionsToStored(form) as unknown as typeof stored;
    expect(out.rules[0]?.when[0]).toEqual({
      question: "pede",
      minProbability: 0.7,
    });
    expect(out.rules[1]?.when[0]).toEqual({
      question: "assunto",
      equals: "a",
      minConfidence: 0.65,
    });
  });
  test("a stored threshold keeps every digit through the form", () => {
    const precise = structuredClone(stored);
    precise.rules[0] = {
      when: [{ question: "pede", minProbability: 0.123456789 }],
      action: { tool: "set_labels", args: { add: ["x"] } },
    };
    const form = decisionsToForm(precise);
    if (!form) throw new Error("fixture");
    expect(form.rules[0]?.when[0]?.minProbability).toBe("12.3456789");
    const out = decisionsToStored(form) as unknown as {
      rules: { when: { minProbability?: number }[] }[];
    };
    expect(out.rules[0]?.when[0]?.minProbability).toBe(0.123456789);
  });
  test("a threshold reads and writes as typed, without float noise", () => {
    const noisy = structuredClone(stored);
    noisy.rules[0] = {
      when: [{ question: "pede", minProbability: 0.57 }],
      action: { tool: "set_labels", args: { add: ["x"] } },
    };
    const form = decisionsToForm(noisy);
    if (!form?.rules[0]?.when[0]) throw new Error("fixture");
    expect(form.rules[0].when[0].minProbability).toBe("57");
    form.rules[0].when[0].minProbability = "1.1";
    const out = decisionsToStored(form) as unknown as {
      rules: { when: { minProbability?: number }[] }[];
    };
    expect(out.rules[0]?.when[0]?.minProbability).toBe(0.011);
  });
  test("a negative percentage too small to round is still refused", () => {
    const form = decisionsToForm(stored);
    if (!form?.rules[0]?.when[0]) throw new Error("fixture");
    form.rules[0].when[0].minProbability = "-0.00001";
    expect([...decisionsFormIssues(form).keys()]).toContain(
      "rules.0.when.0.minProbability",
    );
  });
  test("a percentage past 100 is refused at its field", () => {
    const form = decisionsToForm(stored);
    if (!form?.rules[0]?.when[0]) throw new Error("fixture");
    form.rules[0].when[0].minProbability = "150";
    expect([...decisionsFormIssues(form).keys()]).toContain(
      "rules.0.when.0.minProbability",
    );
  });
});

// Two MCP servers whose names reduce to one slug give their tools one name, which the assembly
// tells apart by order with a suffix: a rule must not be offered either, or it may call the other
// server's tool (agents#1223).
describe("the custom tools a rule is offered", () => {
  test("no tool of two servers sharing a slug is offered, suffixed ones included; another server's is", () => {
    const { all, granted } = customToolsOf(
      {
        toolDefinitions: [],
        codeTools: [],
        mcpConnections: [
          { id: "1", name: "CRM", slug: "crm" },
          { id: "2", name: "crm", slug: "crm" },
          { id: "3", name: "Sheets", slug: "sheets" },
        ],
      },
      [
        { source: "MCP", mcpServerConnectionId: "1", enabledTools: ["abrir"] },
        // `abrir_2` is the name the assembly may give the other server's `abrir`.
        {
          source: "MCP",
          mcpServerConnectionId: "2",
          enabledTools: ["abrir", "abrir_2"],
        },
        { source: "MCP", mcpServerConnectionId: "3", enabledTools: ["append"] },
      ],
    );
    expect([...all.keys()]).toEqual(["mcp__sheets__append"]);
    expect([...granted]).toEqual(["mcp__sheets__append"]);
  });

  // A long tool name trims the slug to make room, so `crm_extended` and `crm` meet on one name.
  test("no tool whose name a trimmed slug reaches is offered, nor the suffix it may take", () => {
    const long = "t".repeat(54);
    const { all } = customToolsOf(
      {
        toolDefinitions: [],
        codeTools: [],
        mcpConnections: [
          { id: "1", name: "CRM extended", slug: "crm_extended" },
          { id: "2", name: "crm", slug: "crm" },
          { id: "3", name: "Sheets", slug: "sheets" },
        ],
      },
      [
        { source: "MCP", mcpServerConnectionId: "1", enabledTools: [long] },
        {
          source: "MCP",
          mcpServerConnectionId: "2",
          enabledTools: [long, `${"t".repeat(52)}_2`, "abrir"],
        },
        { source: "MCP", mcpServerConnectionId: "3", enabledTools: ["append"] },
      ],
    );
    expect([...all.keys()]).toEqual(["mcp__crm__abrir", "mcp__sheets__append"]);
  });

  test("the console's name before a suffix is the assembly's", () => {
    for (const [slug, tool] of [
      ["crm", "abrir"],
      ["crm_extended", "t".repeat(54)],
      ["a".repeat(28), "b".repeat(70)],
    ] as const) {
      expect(mcpRuntimeBase(slug, tool)).toBe(
        namespacedToolName(slug, tool, new Set()),
      );
    }
  });

  // A disabled definition or connection is not in the toolset: not runnable, and no name taken.
  test("a disabled tool is not granted, and a disabled server's tools collide with none", () => {
    const { all, granted } = customToolsOf(
      {
        toolDefinitions: [
          {
            id: "1",
            label: "",
            toolName: "abrir_ticket",
            args: [],
            enabled: false,
          },
        ],
        codeTools: [
          {
            id: "2",
            label: "",
            toolName: "registrar_caso",
            args: [],
            enabled: false,
          },
        ],
        mcpConnections: [
          { id: "3", name: "CRM", slug: "crm", enabled: false },
          { id: "4", name: "crm", slug: "crm" },
        ],
      },
      [
        { source: "HTTP", toolDefinitionId: "1" },
        { source: "CODE", codeToolDefinitionId: "2" },
        { source: "MCP", mcpServerConnectionId: "3", enabledTools: ["abrir"] },
        { source: "MCP", mcpServerConnectionId: "4", enabledTools: ["abrir"] },
      ],
    );
    expect(all.has("abrir_ticket")).toBe(true);
    expect([...granted]).toEqual(["mcp__crm__abrir"]);
    expect(all.get("mcp__crm__abrir")?.label).toBe("crm: abrir");
  });

  test("a tool listed twice in one grant is still one server's", () => {
    const { all } = customToolsOf(
      {
        toolDefinitions: [],
        codeTools: [],
        mcpConnections: [{ id: "1", name: "crm", slug: "crm" }],
      },
      [
        {
          source: "MCP",
          mcpServerConnectionId: "1",
          enabledTools: ["search", "search"],
        },
      ],
    );
    expect([...all.keys()]).toEqual(["mcp__crm__search"]);
  });

  test("a server sharing a slug but enabling no tool hides none of the other's", () => {
    const { all } = customToolsOf(
      {
        toolDefinitions: [],
        codeTools: [],
        mcpConnections: [
          { id: "1", name: "CRM A", slug: "crm_a" },
          { id: "2", name: "CRM_A", slug: "crm_a" },
        ],
      },
      [
        { source: "MCP", mcpServerConnectionId: "1", enabledTools: ["search"] },
        { source: "MCP", mcpServerConnectionId: "2", enabledTools: [] },
      ],
    );
    expect([...all.keys()]).toEqual(["mcp__crm_a__search"]);
  });
});

// A tool whose schema gained a required argument after its rule was saved: the server accepts the
// rule as stored, so the console asks only what the save changes (agents#1223).
describe("a rule on a custom tool as stored", () => {
  const tools = new Map([
    [
      "abrir_ticket",
      {
        name: "abrir_ticket",
        label: "Abrir ticket",
        kind: "http" as const,
        args: [{ name: "motivo", type: "string" as const, required: true }],
      },
    ],
  ]);
  const block = {
    ...BLOCK,
    rules: [
      {
        when: [{ question: "pede_reembolso", minProbability: 0.7 }],
        action: { tool: "abrir_ticket", args: {} },
      },
    ],
  };
  const stored = { monitoring: { engine: "decisions", decisions: block } };

  test("is not asked again when something else in the form is edited", () => {
    const form = observationToForm(stored);
    if (!form.decisions) throw new Error("fixture");
    form.decisions.model = "gpt-6-sol";
    const edited = { ...form, decisionsEdited: true };
    expect(
      [
        ...decisionsFormIssues(
          form.decisions,
          decisionsBaseline(edited),
          tools,
          edited.storedDecisions,
        ).keys(),
      ].filter((k) => k.includes(".action.")),
    ).toEqual([]);
  });

  test("a draft left missing an argument behind the language model is not stored over the block", () => {
    const form = observationToForm({
      monitoring: { engine: "decisions", decisions: BLOCK },
    });
    if (!form.decisions) throw new Error("fixture");
    const rule = form.decisions.rules[0];
    if (!rule) throw new Error("fixture");
    form.decisions.rules[0] = {
      ...rule,
      tool: "abrir_ticket",
      args: {},
      fill: {},
    };
    const hidden = { ...form, engine: "llm" as const, decisionsEdited: true };
    expect(decisionsBlockToStore(hidden, true, tools)).toEqual(BLOCK);
  });

  test("an action stored without args is the same action written back with empty ones", () => {
    const apiBlock = {
      ...block,
      rules: [
        {
          when: [{ question: "pede_reembolso", minProbability: 0.7 }],
          action: { tool: "abrir_ticket", fill: { motivo: "contact.name" } },
        },
      ],
    };
    const form = observationToForm({
      monitoring: { engine: "decisions", decisions: apiBlock },
    });
    if (!form.decisions) throw new Error("fixture");
    form.decisions.model = "gpt-6-sol";
    const gained = new Map([
      [
        "abrir_ticket",
        {
          name: "abrir_ticket",
          label: "Abrir ticket",
          kind: "http" as const,
          args: [
            { name: "motivo", type: "string" as const, required: true },
            { name: "canal", type: "string" as const, required: true },
          ],
        },
      ],
    ]);
    expect(
      [
        ...decisionsFormIssues(form.decisions, null, gained, apiBlock).keys(),
      ].filter((k) => k.includes(".action.")),
    ).toEqual([]);
  });
});
