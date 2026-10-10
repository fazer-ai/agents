/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components/Toast";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import {
  ClassifierFields,
  DecisionsFields,
  type DecisionsServerRefusal,
} from "@/client/pages/agents/DecisionsFields";
import { EngineCards } from "@/client/pages/agents/EngineChoice";
import { ObservationSection } from "@/client/pages/agents/ObservationSection";
import {
  decisionsBaseline,
  editDecisions,
  type ObservationState,
  observationToForm,
  observationToStored,
  withEngine,
} from "@/client/pages/agents/observationFormState";
import {
  decisionsBlockFingerprint,
  decisionsIssues,
} from "@/modules/decisions/config";

// THE DECISIONS ENGINE IN THE AGENT EDITOR, drawn as the page draws it (agents#1224): the engine
// cards and the classifier on General, the questions and rules on their own tab, the timing alone in
// Behavior's Observation. The questions and the rules are on screen for a watcher on that engine; a rule that names a question that is gone is shown broken;
// what the engine has been doing is read from its own log lines. Every assertion reduces to a number,
// a string or a boolean BEFORE expect: a failing expectation holding a DOM node serializes a cyclic
// happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;

const BLOCK = {
  provider: "typesafe",
  credentialRef: "vault:12",
  questions: [
    { name: "pede_reembolso", type: "yes_no", instructions: "Pede reembolso?" },
    {
      name: "assunto",
      type: "choice",
      instructions: "Assunto",
      options: [
        { value: "reembolso", description: "" },
        { value: "outro", description: "" },
      ],
    },
  ],
  rules: [
    {
      when: [{ question: "pede_reembolso", minProbability: 0.7 }],
      action: { tool: "set_labels", args: { add: ["reembolso"] } },
    },
    {
      when: [{ question: "assunto", equals: "outro" }],
      action: { tool: "private_note", args: { content: "ver" } },
    },
  ],
  apply: "shadow",
};

// The mark the engine writes on each line for the block above (docs/decisions.md).
const MARK = decisionsBlockFingerprint(BLOCK) as string;

const LOG_LINES = [
  {
    id: "2",
    createdAt: "2026-10-08T12:05:00Z",
    status: "ok",
    detail: {
      engine: "decisions",
      block: MARK,
      answers: {
        pede_reembolso: { type: "yes_no", probability: 0.91 },
        assunto: { type: "choice", choice: "reembolso", confidence: 0.8 },
      },
      actions: [{ rule: 0, tool: "set_labels", outcome: "shadow" }],
      notFired: [{ rule: 1, miss: { why: "other_choice" } }],
    },
  },
  {
    id: "1",
    createdAt: "2026-10-08T12:00:00Z",
    status: "ok",
    detail: {
      engine: "decisions",
      block: MARK,
      answers: { pede_reembolso: { type: "yes_no", probability: 0.1 } },
      actions: [],
      notFired: [0, 1].map((rule) => ({ rule, miss: { why: "refused" } })),
    },
  },
];

const logQueries: URLSearchParams[] = [];

function stubApi(): void {
  logQueries.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      "http://localhost",
    );
    if (url.pathname.endsWith("/v1/logs")) logQueries.push(url.searchParams);
    const body = url.pathname.includes("/custom-attributes/")
      ? {
          attributes: [
            {
              key: "sentimento",
              displayName: "Sentimento",
              model: "conversation_attribute",
            },
          ],
          accountCount: 1,
        }
      : url.pathname.includes("/labels/")
        ? { labels: [{ title: "reembolso", color: null }], accountCount: 1 }
        : url.pathname.endsWith("/v1/logs")
          ? { items: LOG_LINES, nextCursor: null }
          : url.pathname.endsWith("/v1/vault")
            ? { entries: [] }
            : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const opened: string[] = [];
const grantedTools: string[] = [];

function renderSection(
  settings: unknown,
  opts: {
    refusal?: DecisionsServerRefusal | null;
    granted?: string[] | null;
    grantsPending?: boolean;
    showErrors?: boolean;
  } = {},
): { state: () => ObservationState } {
  let latest = observationToForm(settings);
  opened.length = 0;
  grantedTools.length = 0;
  function Harness() {
    const [observation, setObservation] = useState<ObservationState>(() =>
      observationToForm(settings),
    );
    latest = observation;
    const setDecisions = (next: Parameters<typeof editDecisions>[1]) =>
      setObservation((prev) => editDecisions(prev, next));
    return (
      <>
        <EngineCards
          engine={observation.engine}
          onChange={(engine) =>
            setObservation((prev) => withEngine(prev, engine))
          }
        />
        <ObservationSection
          observation={observation}
          setObservation={setObservation}
        />
        {observation.engine === "decisions" && observation.decisions && (
          <>
            <ClassifierFields
              decisions={observation.decisions}
              storedDecisions={decisionsBaseline(observation)}
              setDecisions={setDecisions}
              credentialError={null}
              serverRefusal={opts.refusal ?? null}
            />
            <DecisionsFields
              agentId="7"
              savedAt="2026-10-08T11:00:00.000Z"
              storedBlock={decisionsBlockFingerprint(
                observation.storedDecisions,
              )}
              storedDecisions={decisionsBaseline(observation)}
              storedRuleCount={
                Array.isArray(observation.storedDecisions?.rules)
                  ? observation.storedDecisions.rules.length
                  : 0
              }
              decisions={observation.decisions}
              setDecisions={setDecisions}
              serverRefusal={opts.refusal ?? null}
              granted={
                opts.granted === undefined
                  ? null
                  : opts.granted === null
                    ? null
                    : new Set(opts.granted)
              }
              grantsPending={opts.grantsPending ?? false}
              onGrantTool={(tool) => grantedTools.push(tool)}
              onOpenTools={() => opened.push("tools")}
              onOpenGeneral={() => opened.push("general")}
              showErrors={opts.showErrors ?? false}
            />
          </>
        )}
      </>
    );
  }
  render(
    <MemoryRouter>
      <ThemeProvider>
        <ToastProvider>
          <TooltipProvider>
            <Harness />
          </TooltipProvider>
        </ToastProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
  return { state: () => latest };
}

const count = (testId: string) => screen.queryAllByTestId(testId).length;
const brokenRules = () =>
  screen
    .queryAllByTestId("decisions-rule")
    .map((el) => el.getAttribute("data-broken"));
// The engine card that is on, by its stored value.
const engineOn = () =>
  screen.getByTestId("engine-llm").getAttribute("aria-checked") === "true"
    ? "llm"
    : screen.getByTestId("engine-decisions").getAttribute("aria-checked") ===
        "true"
      ? "decisions"
      : "none";
const pickEngine = (engine: "llm" | "decisions") =>
  fireEvent.click(screen.getByTestId(`engine-${engine}`));

describe("the decisions engine in the agent editor", () => {
  test("an agent on the model engine shows the choice and none of the engine's fields", () => {
    stubApi();
    renderSection({});
    expect(engineOn()).toBe("llm");
    expect(count("decisions-fields")).toBe(0);
  });

  test("choosing the decisions engine opens an empty block in shadow, and says what is missing", () => {
    stubApi();
    const { state } = renderSection({}, { showErrors: true });
    pickEngine("decisions");
    expect(count("decisions-fields")).toBe(1);
    expect(state().engine).toBe("decisions");
    expect(state().decisions?.apply).toBe("shadow");
    expect(count("decisions-problems")).toBe(1);
    expect(
      screen.queryAllByText(/Add at least one question/).length,
    ).toBeGreaterThan(0);
  });

  test("an agent stored on the decisions engine with no block shows the fields and what is missing", () => {
    stubApi();
    renderSection(
      { monitoring: { engine: "decisions" } },
      { showErrors: true },
    );
    expect(engineOn()).toBe("decisions");
    expect(count("decisions-fields")).toBe(1);
    expect(count("decisions-problems")).toBe(1);
    expect(
      screen.queryAllByText(/Add at least one question/).length,
    ).toBeGreaterThan(0);
  });

  test("an agent on the decisions engine shows its provider, questions and rules", () => {
    stubApi();
    renderSection({ monitoring: { engine: "decisions", decisions: BLOCK } });
    expect(engineOn()).toBe("decisions");
    expect(count("decisions-question")).toBe(2);
    expect(count("decisions-rule")).toBe(2);
    expect(count("decisions-problems")).toBe(0);
    expect(brokenRules()).toEqual(["false", "false"]);
    const provider = screen.getByRole("combobox", {
      name: /Classification API/,
    }) as HTMLSelectElement;
    expect(provider.value).toBe("typesafe");
    // The model field is empty and names the provider's default.
    expect(screen.queryAllByText(/jev-latest/).length).toBeGreaterThan(0);
  });

  test("removing a question shows the rule that names it as broken", () => {
    stubApi();
    renderSection({ monitoring: { engine: "decisions", decisions: BLOCK } });
    const remove = screen.getAllByRole("button", { name: "Remove question" });
    fireEvent.click(remove[0] as HTMLElement);
    expect(count("decisions-question")).toBe(1);
    expect(brokenRules()).toEqual(["true", "false"]);
    expect(screen.queryAllByText("Broken").length).toBe(1);
    expect(
      screen.queryAllByText(/No question is named "pede_reembolso"/).length,
    ).toBe(1);
    expect(count("decisions-problems")).toBe(1);
  });

  test("switching back to the model engine hides the fields and keeps the block", () => {
    stubApi();
    const { state } = renderSection({
      monitoring: { engine: "decisions", decisions: BLOCK },
    });
    pickEngine("llm");
    expect(count("decisions-fields")).toBe(0);
    const stored = observationToStored(state());
    expect(stored.engine).toBe("llm");
    expect(stored.decisions).toEqual(BLOCK);
  });

  test("says what each rule and question has been doing, from the engine's own lines", async () => {
    stubApi();
    renderSection({ monitoring: { engine: "decisions", decisions: BLOCK } });
    await waitFor(() => expect(count("decisions-activity-total")).toBe(1));
    const text = (testId: string) =>
      screen.queryAllByTestId(testId).map((el) => el.textContent ?? "");
    expect(text("decisions-activity-total")[0]).toContain("2 of");
    expect(text("decisions-rule-activity")).toEqual([
      "Fired in 1 of 2 decisions, would have run 1 (rehearsal).",
      "Fired in 0 of 2 decisions.",
    ]);
    expect(text("decisions-question-answers")).toEqual([
      "Latest answers: yes 91% · yes 10%",
      "Latest answers: reembolso (80%)",
    ]);
    // The read is this agent's observe lines.
    const q = logQueries[0];
    expect(q?.get("agentId")).toBe("7");
    expect(q?.get("stage")).toBe("observe");
  });

  test("lines a different set of rules wrote are not counted against these", async () => {
    stubApi();
    const reordered = { ...BLOCK, rules: [...BLOCK.rules].reverse() };
    renderSection({
      monitoring: { engine: "decisions", decisions: reordered },
    });
    await waitFor(() => expect(count("decisions-activity-total")).toBe(1));
    expect(
      screen.queryAllByTestId("decisions-activity-total")[0]?.textContent,
    ).toContain("0 of");
    expect(count("decisions-rule-activity")).toBe(0);
  });

  test("a rule added on screen has decided nothing, and the counts stay with the rule when it moves", async () => {
    stubApi();
    renderSection({ monitoring: { engine: "decisions", decisions: BLOCK } });
    await waitFor(() => expect(count("decisions-activity-total")).toBe(1));
    const down = screen.getAllByRole("button", { name: "Move down" });
    // The rules' own arrows come after the questions' (two questions, two arrows).
    fireEvent.click(down[2] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(
      screen
        .queryAllByTestId("decisions-rule-activity")
        .map((el) => el.textContent ?? ""),
    ).toEqual([
      "Fired in 0 of 2 decisions.",
      "Fired in 1 of 2 decisions, would have run 1 (rehearsal).",
      "Not saved yet, so it has not decided anything.",
    ]);
  });

  test("an attribute rule stored for the contact says so, and offers the contact's attributes", () => {
    stubApi();
    renderSection({
      monitoring: {
        engine: "decisions",
        decisions: {
          ...BLOCK,
          rules: [
            {
              when: [{ question: "pede_reembolso", minProbability: 0.7 }],
              // No key yet, so the card opens on its warning and the fields are drawn.
              action: {
                tool: "set_custom_attribute",
                args: { value: "x", scope: "contact" },
              },
            },
          ],
        },
      },
    });
    const scope = screen.getByRole("combobox", {
      name: /Written to/,
    }) as HTMLSelectElement;
    expect(scope.value).toBe("contact");
    fireEvent.change(scope, { target: { value: "conversation" } });
    expect(
      (
        screen.getByRole("combobox", {
          name: /Written to/,
        }) as HTMLSelectElement
      ).value,
    ).toBe("conversation");
  });

  // The keystroke that fixes a field must not fold the card it is typed in.
  test("a card a problem opened stays open while its field is being filled", () => {
    stubApi();
    renderSection({ monitoring: { engine: "decisions", decisions: BLOCK } });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    const action = screen.getAllByRole("combobox", { name: "Action" });
    fireEvent.change(action[action.length - 1] as HTMLElement, {
      target: { value: "private_note" },
    });
    const note = () => screen.queryAllByRole("textbox", { name: "Note" });
    expect(note().length).toBe(1);
    fireEvent.change(note()[0] as HTMLElement, { target: { value: "v" } });
    // The warning is gone and the textarea is still there to take the next character.
    expect(screen.queryAllByText(/Without a note/).length).toBe(0);
    expect(note().length).toBe(1);
    expect((note()[0] as HTMLTextAreaElement).value).toBe("v");
  });

  test("a question card stays open while its name is being typed", () => {
    stubApi();
    renderSection({ monitoring: { engine: "decisions", decisions: BLOCK } });
    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    const names = () => screen.queryAllByRole("textbox", { name: "Name" });
    const before = names().length;
    expect(before).toBeGreaterThan(0);
    fireEvent.change(names()[before - 1] as HTMLElement, {
      target: { value: "nova" },
    });
    expect(names().length).toBe(before);
  });

  test("a refusal the server names a field for is shown at that field", () => {
    stubApi();
    renderSection(
      { monitoring: { engine: "decisions", decisions: BLOCK } },
      {
        refusal: {
          path: "questions.0.name",
          message: "the server said no to this name",
        },
      },
    );
    expect(
      screen.queryAllByText("the server said no to this name").length,
    ).toBe(1);
  });

  test("a refusal about a path the screen has no input for is still said", () => {
    stubApi();
    renderSection(
      { monitoring: { engine: "decisions", decisions: BLOCK } },
      { refusal: { path: "rules.1", message: "the server refused the rule" } },
    );
    expect(count("decisions-problems")).toBe(1);
    expect(screen.queryAllByText("the server refused the rule").length).toBe(1);
  });
});

// Reorder and remove are icon-only: their hint has to reach a keyboard user, which a native `title`
// does not, so they go through the shared tooltip and keep their accessible name.
describe("the icon buttons of a card", () => {
  test("carry an accessible name and no native title", () => {
    stubApi();
    renderSection({ monitoring: { engine: "decisions", decisions: BLOCK } });
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button[aria-label]"),
    ).filter((b) => b.querySelector("svg") && (b.textContent ?? "") === "");
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.filter((b) => b.hasAttribute("title")).length).toBe(0);
  });
});

// What the write boundary refuses comes with the server's own sentence, written for a log. The
// screen has its own words for every such problem, at the field: none of those sentences may be
// what the operator reads.
describe("a problem the server would name", () => {
  type Draft = {
    credentialRef: string;
    questions: Record<string, unknown>[];
    rules: {
      when: Record<string, unknown>[];
      action: { tool: string; args: Record<string, unknown> };
    }[];
  };
  const at = <T,>(list: T[], i: number): T => {
    const v = list[i];
    if (v === undefined) throw new Error("fixture");
    return v;
  };
  const q = (b: Draft, i: number) => at(b.questions, i);
  const rule = (b: Draft, i: number) => at(b.rules, i);
  const cond = (b: Draft, i: number) => at(rule(b, i).when, 0);
  const SCORE = {
    name: "urgencia",
    type: "score",
    instructions: "Urgência",
    levels: [
      { value: "baixa", description: "" },
      { value: "alta", description: "" },
    ],
  };
  const broken: [string, (b: Draft) => void][] = [
    [
      "no credential",
      (b) => {
        b.credentialRef = "";
      },
    ],
    [
      "a name with a space",
      (b) => {
        q(b, 0).name = "Pede Reembolso";
      },
    ],
    [
      "a choice with one option",
      (b) => {
        q(b, 1).options = [{ value: "so", description: "" }];
      },
    ],
    [
      "an option repeated",
      (b) => {
        q(b, 1).options = [
          { value: "outro", description: "" },
          { value: "outro", description: "" },
        ];
      },
    ],
    [
      "a name repeated",
      (b) => {
        q(b, 1).name = "pede_reembolso";
      },
    ],
    [
      "a rule on a question that is gone",
      (b) => {
        cond(b, 0).question = "sumiu";
      },
    ],
    [
      "a rule on an option that is gone",
      (b) => {
        cond(b, 1).equals = "sumiu";
      },
    ],
    [
      "a yes or no condition with no probability",
      (b) => {
        rule(b, 0).when = [{ question: "pede_reembolso" }];
      },
    ],
    [
      "a probability above one",
      (b) => {
        cond(b, 0).minProbability = 2;
      },
    ],
    [
      "a choice condition with no option",
      (b) => {
        rule(b, 1).when = [{ question: "assunto" }];
      },
    ],
    [
      "a level past the last",
      (b) => {
        b.questions.push(SCORE);
        rule(b, 0).when = [{ question: "urgencia", minLevel: 1, maxLevel: 5 }];
      },
    ],
    [
      "a score condition with no levels",
      (b) => {
        b.questions.push(SCORE);
        rule(b, 0).when = [{ question: "urgencia" }];
      },
    ],
    [
      "an action that does not exist",
      (b) => {
        rule(b, 0).action.tool = "apagar";
      },
    ],
    [
      "a question with no wording",
      (b) => {
        q(b, 0).instructions = "";
      },
    ],
  ];

  // A piece of what the screen says about each case, in its own words.
  const SAYS: Record<string, string> = {
    "no credential": "The classifier on the General tab is not complete.",
    "a name with a space": "Lowercase letters",
    "a choice with one option": "At least 2",
    "an option repeated": "is already used in this list",
    "a name repeated": "is already named",
    "a rule on a question that is gone": "No question is named",
    "a rule on an option that is gone": "is no longer one of",
    "a yes or no condition with no probability": "Set the minimum probability",
    "a probability above one": "At most 100%",
    "a choice condition with no option": "Pick the option.",
    "a level past the last": "one past the last",
    "a score condition with no levels": "Pick the lowest and the highest",
    "an action that does not exist": "Not an accepted value.",
    "a question with no wording": "Required.",
  };

  test("is worded by the screen, never shown as the server wrote it", () => {
    const codes = new Set<string>();
    for (const [what, breakIt] of broken) {
      const block = JSON.parse(JSON.stringify(BLOCK)) as Draft;
      breakIt(block);
      const issues = decisionsIssues(block);
      expect(issues.length, what).toBeGreaterThan(0);
      stubApi();
      renderSection({ monitoring: { engine: "decisions", decisions: block } });
      expect(count("decisions-problems"), what).toBe(1);
      const shown = document.body.textContent ?? "";
      for (const issue of issues) {
        codes.add(issue.code);
        expect(shown.includes(issue.message), `${what}: ${issue.code}`).toBe(
          false,
        );
      }
      // ...and it IS said, so the absence above is not an empty screen.
      expect(shown.includes(SAYS[what] ?? "\u0000"), what).toBe(true);
      cleanup();
    }
    expect(codes.size).toBeGreaterThanOrEqual(10);
  });
});

// The two free-text fields are bounded when typed and cut nowhere, so a longer text stored through
// the API is drawn whole: not marked invalid, and not under the counter that says the agent
// receives only the first part of it.
describe("a question or a note longer than the typing bound", () => {
  test("is shown whole and unmarked, and cannot grow from there", () => {
    const long = "x".repeat(2500);
    const block = JSON.parse(JSON.stringify(BLOCK)) as typeof BLOCK;
    (block.questions[0] as { instructions: string }).instructions = long;
    (
      block.rules[1] as { action: { args: { content: string } } }
    ).action.args.content = long;
    stubApi();
    renderSection({ monitoring: { engine: "decisions", decisions: block } });
    expect(count("decisions-problems")).toBe(0);
    for (const fold of Array.from(
      document.querySelectorAll<HTMLElement>('[aria-expanded="false"]'),
    )) {
      fireEvent.click(fold);
    }
    const areas = Array.from(document.querySelectorAll("textarea"));
    const longOnes = areas.filter((a) => a.value.length === 2500);
    expect(longOnes.length).toBe(2);
    expect(longOnes.map((a) => a.maxLength)).toEqual([2500, 2500]);
    expect(longOnes.filter((a) => a.getAttribute("aria-invalid")).length).toBe(
      0,
    );
    expect((document.body.textContent ?? "").includes("over the limit")).toBe(
      false,
    );
    // A text within the bound still declares the bound itself.
    const short = areas.filter((a) => a.value === "Assunto");
    expect(short.map((a) => a.maxLength)).toEqual([2000]);
  });
});

// agents#1224: the editor follows the engine. What the engine does not use is replaced, never
// shown disabled; a new agent starts from ready questions; a rule says when its tool is not
// allowed; and no stored value (`shadow`, `enforce`, `decisions`) is on screen.
describe("the editor follows the engine", () => {
  const visible = () => document.body.textContent ?? "";

  test("the timing stays in Observation and the engine is chosen by its cards", () => {
    stubApi();
    renderSection({});
    expect(engineOn()).toBe("llm");
    expect(
      screen.queryAllByRole("combobox", { name: /What decides/ }).length,
    ).toBe(0);
    expect(count("classifier-fields")).toBe(0);
    pickEngine("decisions");
    expect(count("classifier-fields")).toBe(1);
    expect(count("decisions-fields")).toBe(1);
    pickEngine("llm");
    expect(count("classifier-fields")).toBe(0);
    expect(count("decisions-fields")).toBe(0);
  });

  test("a new agent opens on starting points, and one adds its question and rules to the draft", () => {
    stubApi();
    const { state } = renderSection({});
    pickEngine("decisions");
    expect(count("decisions-starters")).toBe(1);
    expect(count("decisions-question")).toBe(0);
    fireEvent.click(screen.getByTestId("decisions-starter-sentiment"));
    expect(count("decisions-starters")).toBe(0);
    expect(count("decisions-question")).toBe(1);
    expect(count("decisions-rule")).toBe(5);
    expect(state().decisions?.questions[0]?.type).toBe("score");
    // The other two are still offered, and one already added is not.
    expect(
      screen.queryAllByRole("button", { name: "Customer sentiment" }).length,
    ).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Asks for a person" }));
    expect(count("decisions-question")).toBe(2);
    expect(count("decisions-rule")).toBe(6);
  });

  test("removing the last question brings the starting points back", () => {
    stubApi();
    renderSection({});
    pickEngine("decisions");
    fireEvent.click(screen.getByTestId("decisions-starter-human"));
    fireEvent.click(screen.getByRole("button", { name: "Remove question" }));
    expect(count("decisions-starters")).toBe(1);
  });

  test("a blank question is still one click away", () => {
    stubApi();
    renderSection({});
    pickEngine("decisions");
    fireEvent.click(
      screen.getByRole("button", { name: "Start with a blank question" }),
    );
    expect(count("decisions-question")).toBe(1);
    expect(count("decisions-rule")).toBe(0);
  });

  test("rehearsal and live are chosen side by side, by their names", () => {
    stubApi();
    const { state } = renderSection({
      monitoring: { engine: "decisions", decisions: BLOCK },
    });
    const live = screen.getByRole("radio", { name: /Live/ });
    expect(
      screen
        .getByRole("radio", { name: /Rehearsal/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(live);
    expect(state().decisions?.apply).toBe("enforce");
    const text = visible();
    for (const jargon of ["shadow", "enforce", "Shadow", "Enforce"]) {
      expect(text.includes(jargon), jargon).toBe(false);
    }
  });

  test("a rule whose tool is not allowed says so, and Allow grants it", () => {
    stubApi();
    renderSection(
      { monitoring: { engine: "decisions", decisions: BLOCK } },
      { granted: ["set_labels"] },
    );
    expect(count("decisions-rule-not-granted")).toBe(1);
    fireEvent.click(screen.getByTestId("decisions-rule-grant"));
    expect(grantedTools).toEqual(["private_note"]);
  });

  test("with grant changes pending on Tools, the rule sends the operator there instead", () => {
    stubApi();
    renderSection(
      { monitoring: { engine: "decisions", decisions: BLOCK } },
      { granted: ["set_labels"], grantsPending: true },
    );
    expect(count("decisions-rule-grant")).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Open Tools" }));
    expect(opened).toEqual(["tools"]);
  });

  test("every rule allowed, or grants not read yet, shows no warning", () => {
    stubApi();
    renderSection(
      { monitoring: { engine: "decisions", decisions: BLOCK } },
      { granted: ["set_labels", "private_note"] },
    );
    expect(count("decisions-rule-not-granted")).toBe(0);
    cleanup();
    stubApi();
    renderSection({ monitoring: { engine: "decisions", decisions: BLOCK } });
    expect(count("decisions-rule-not-granted")).toBe(0);
  });

  test("the questions carry the anchor a refusal about them scrolls to", () => {
    stubApi();
    renderSection({ monitoring: { engine: "decisions", decisions: BLOCK } });
    expect(document.getElementById("decisions-questions") === null).toBe(false);
  });

  test("a classifier problem is a line with the way to General, not a path", () => {
    stubApi();
    renderSection({
      monitoring: {
        engine: "decisions",
        decisions: { ...BLOCK, credentialRef: "" },
      },
    });
    expect(count("decisions-problems")).toBe(1);
    expect(visible().includes("credentialRef")).toBe(false);
    // Nothing on this tab is wrong, so no count of problems "marked below".
    expect(visible().includes("marked on its field below")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Open General" }));
    expect(opened).toEqual(["general"]);
  });
});

// The first visit to the tab is an invitation, not a list of errors: what is missing is said in a
// neutral line, and it turns into an error only once the operator tries to save.
describe("a new agent's first look at its questions", () => {
  test("shows the starting points and a neutral line, no error", () => {
    stubApi();
    renderSection({});
    pickEngine("decisions");
    expect(count("decisions-starters")).toBe(1);
    expect(screen.queryAllByRole("alert").length).toBe(0);
    expect(
      (document.body.textContent ?? "").includes("Add at least one question"),
    ).toBe(false);
    expect(
      screen.getByTestId("decisions-problems").getAttribute("data-tone"),
    ).toBe("neutral");
  });

  test("turns into an error once a save was tried", () => {
    stubApi();
    renderSection({}, { showErrors: true });
    pickEngine("decisions");
    expect(
      screen.getByTestId("decisions-problems").getAttribute("data-tone"),
    ).toBe("error");
    expect(screen.queryAllByRole("alert").length).toBeGreaterThan(0);
  });
});

describe("a threshold on a rule", () => {
  test("is shown and typed as a percentage", () => {
    stubApi();
    const { state } = renderSection({
      monitoring: { engine: "decisions", decisions: BLOCK },
    });
    const card = screen.getAllByTestId("decisions-rule")[0];
    if (!card) throw new Error("fixture");
    expect((card.textContent ?? "").includes("≥ 70%")).toBe(true);
    fireEvent.click(
      screen.getAllByRole("button", { name: /Rule 1/ })[0] as HTMLElement,
    );
    const input = screen.getByRole("spinbutton", {
      name: "Minimum probability",
    }) as HTMLInputElement;
    expect(input.value).toBe("70");
    fireEvent.change(input, { target: { value: "85" } });
    const written = observationToStored(state()).decisions as {
      rules: { when: { minProbability?: number }[] }[];
    };
    expect(written.rules[0]?.when[0]?.minProbability).toBe(0.85);
  });
});
