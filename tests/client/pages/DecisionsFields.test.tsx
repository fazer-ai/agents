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
import type { CustomTools } from "@/client/pages/agents/decisionsFormState";
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
import { revealFirstProblem } from "@/client/pages/agents/saveAttempt";
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
    customTools?: CustomTools | null;
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
              customTools={opts.customTools ?? null}
              grantsPending={opts.grantsPending ?? false}
              onGrantTool={(tool) => grantedTools.push(tool)}
              onOpenTools={(tool) => opened.push(`tools:${tool}`)}
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
// The engine card that is on, by its stored value. The cards are radio inputs (agents#1254).
const radioOn = (id: string) =>
  (screen.getByTestId(id) as HTMLInputElement).checked;
const engineOn = () =>
  radioOn("engine-llm")
    ? "llm"
    : radioOn("engine-decisions")
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

  test("choosing the decisions engine opens an empty block, and says what is missing", () => {
    stubApi();
    const { state } = renderSection({}, { showErrors: true });
    pickEngine("decisions");
    expect(count("decisions-fields")).toBe(1);
    expect(state().engine).toBe("decisions");
    expect(Object.keys(state().decisions ?? {}).includes("apply")).toBe(false);
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
      "Fired in 1 of 2 decisions.",
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
      "Fired in 1 of 2 decisions.",
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
        // A built-in no rule runs: any other name may be one of the tenant's own tools, which the
        // server asks of its tools (agents#1223).
        rule(b, 0).action.tool = "send_image";
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

// Every rule says when it acts, in words, preselected by its action until the operator
// picks. A fence's refusal and a rule its trigger held back are counted apart from runs.
describe("when a rule acts, and what became of it", () => {
  const unfold = () => {
    for (const fold of Array.from(
      document.querySelectorAll<HTMLElement>('[aria-expanded="false"]'),
    )) {
      fireEvent.click(fold);
    }
  };
  const triggers = () =>
    screen
      .queryAllByTestId("decisions-rule-trigger")
      .map((el) => (el as HTMLSelectElement).value);

  test("each rule shows the choice preselected by its action, in words", () => {
    stubApi();
    renderSection({ monitoring: { engine: "decisions", decisions: BLOCK } });
    unfold();
    expect(triggers()).toEqual(["each_time", "on_start"]);
    const words = Array.from(
      (screen.getAllByTestId("decisions-rule-trigger")[0] as HTMLSelectElement)
        .options,
    ).map((o) => o.textContent ?? "");
    expect(words).toEqual([
      "Every time the conditions hold",
      "When the conditions start holding",
      "Once per conversation",
    ]);
  });

  test("a picked trigger is what the block stores, and an untouched rule stores none", () => {
    stubApi();
    const { state } = renderSection({
      monitoring: { engine: "decisions", decisions: BLOCK },
    });
    unfold();
    fireEvent.change(
      screen.getAllByTestId("decisions-rule-trigger")[0] as HTMLElement,
      { target: { value: "once" } },
    );
    const rules = observationToStored(state()).decisions?.rules as {
      trigger?: string;
    }[];
    expect(rules.map((r) => r.trigger ?? "")).toEqual(["once", ""]);
    expect(triggers()).toEqual(["once", "on_start"]);
  });

  test("a refusal by a protected label and a rule held back are said apart from a run", async () => {
    const lines = [
      {
        id: "3",
        createdAt: "2026-10-08T12:10:00Z",
        status: "ok",
        detail: {
          engine: "decisions",
          block: MARK,
          answers: { pede_reembolso: { type: "yes_no", probability: 0.9 } },
          actions: [
            {
              rule: 0,
              tool: "set_labels",
              outcome: "refused",
              fence: "protected_label",
            },
          ],
          held: [{ rule: 1, trigger: "on_start" }],
        },
      },
    ];
    stubApi();
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).includes("/v1/logs")
        ? new Response(JSON.stringify({ items: lines, nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : inner(input, init)) as typeof fetch;
    renderSection({ monitoring: { engine: "decisions", decisions: BLOCK } });
    await waitFor(() => expect(count("decisions-activity-total")).toBe(1));
    expect(
      screen
        .queryAllByTestId("decisions-rule-activity")
        .map((el) => el.textContent ?? ""),
    ).toEqual([
      "Fired in 1 of 1 decisions, refused by a protected label 1.",
      "Fired in 1 of 1 decisions, already acted, held back 1.",
    ]);
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

  // Every rule that fires runs, so there is no rehearsal or live choice to draw and no word for it,
  // and the activity total stays.
  test("draws no rehearsal or live choice, and no rehearsal wording", () => {
    stubApi();
    renderSection({
      monitoring: { engine: "decisions", decisions: BLOCK },
    });
    expect(
      screen.queryAllByRole("radio", { name: /Live|Rehearsal/ }).length,
    ).toBe(0);
    expect(count("decisions-apply")).toBe(0);
    const text = visible();
    for (const word of [
      "Rehearsal",
      "rehearsal",
      "Live",
      "shadow",
      "enforce",
    ]) {
      expect(text.includes(word), word).toBe(false);
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
    // Named, so the Tools tab can take the operator to that tool's card.
    expect(opened).toEqual(["tools:private_note"]);
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

// A Save pressed on this tab with something missing goes to the problem (agents#1224): the reveal
// starts at the tab's fields, so it lands on the broken rule, and with the problem on General it
// lands on the way there.
describe("a Save pressed with the setup incomplete", () => {
  const focusedText = () => document.activeElement?.textContent ?? "";
  const inRule = () =>
    Boolean(document.activeElement?.closest('[data-testid="decisions-rule"]'));

  test("with only the classifier's key missing, goes to the way to General", () => {
    stubApi();
    renderSection(
      {
        monitoring: {
          engine: "decisions",
          decisions: { ...BLOCK, credentialRef: "" },
        },
      },
      { showErrors: true },
    );
    const tab = screen.getByTestId("decisions-fields");
    expect(revealFirstProblem(tab)).toBe(true);
    expect(focusedText()).toBe("Open General");
  });

  test("on General, the missing key is the field it goes to", () => {
    stubApi();
    renderSection({
      monitoring: {
        engine: "decisions",
        decisions: { ...BLOCK, credentialRef: "" },
      },
    });
    const general = screen.getByTestId("classifier-fields");
    expect(revealFirstProblem(general)).toBe(true);
    expect(Boolean(document.activeElement?.closest("[data-problem]"))).toBe(
      true,
    );
  });

  test("with a broken rule, goes to that rule", () => {
    stubApi();
    renderSection(
      { monitoring: { engine: "decisions", decisions: BLOCK } },
      { showErrors: true },
    );
    const remove = screen.getAllByRole("button", { name: "Remove question" });
    fireEvent.click(remove[0] as HTMLElement);
    expect(revealFirstProblem(screen.getByTestId("decisions-fields"))).toBe(
      true,
    );
    expect(inRule()).toBe(true);
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

// A RULE ON ONE OF THE TENANT'S OWN TOOLS (agents#1223): the action list carries the custom tools the
// agent has beside the four natives, each argument is fixed or filled from a field of the type it
// takes, and a required one left without either keeps the save from going, naming it.
describe("a rule on a custom tool", () => {
  const TOOLS: CustomTools = new Map([
    [
      "abrir_ticket",
      {
        name: "abrir_ticket",
        label: "Abrir ticket",
        kind: "http" as const,
        args: [
          { name: "motivo", type: "string" as const, required: true },
          { name: "telefone", type: "string" as const, required: true },
          { name: "prioridade", type: "number" as const, required: false },
        ],
      },
    ],
    [
      "registrar_caso",
      {
        name: "registrar_caso",
        label: "Registrar caso",
        kind: "code" as const,
        args: [{ name: "pedido", type: "string" as const, required: true }],
      },
    ],
  ]);
  const GRANTED = [
    "set_labels",
    "handoff_to_human",
    "private_note",
    "set_custom_attribute",
    "abrir_ticket",
    "registrar_caso",
  ];
  const openAll = () => {
    for (const fold of Array.from(
      document.querySelectorAll<HTMLElement>('[aria-expanded="false"]'),
    )) {
      fireEvent.click(fold);
    }
  };
  const optionValues = (el: Element | null) =>
    Array.from(el?.querySelectorAll("option") ?? []).map((o) => o.value);

  test("lists the custom tools beside the natives, and offers per argument the fields of its type", async () => {
    stubApi();
    renderSection(
      { monitoring: { engine: "decisions", decisions: BLOCK } },
      { granted: GRANTED, customTools: TOOLS },
    );
    // The attribute definitions arrive with the labels.
    await waitFor(() => expect(logQueries.length).toBeGreaterThan(0));
    openAll();
    const action = screen.getAllByTestId("decisions-rule-action")[0] ?? null;
    const actions = optionValues(action);
    for (const tool of [...GRANTED]) {
      expect(actions.includes(tool), tool).toBe(true);
    }
    if (!action) throw new Error("no action select");
    fireEvent.change(action, { target: { value: "abrir_ticket" } });
    for (const arg of ["motivo", "telefone", "prioridade"]) {
      expect(count(`decisions-arg-${arg}`), arg).toBe(1);
    }
    const modeOf = (arg: string) =>
      screen
        .getByTestId(`decisions-arg-${arg}`)
        .querySelector("select") as HTMLSelectElement;
    fireEvent.change(modeOf("telefone"), { target: { value: "fill" } });
    fireEvent.change(modeOf("prioridade"), { target: { value: "fill" } });
    const text = optionValues(
      screen.getByTestId("decisions-arg-source-telefone"),
    );
    for (const source of [
      "contact.phone",
      "contact.name",
      "conversation.display_id",
      "conversation.link",
      "conversation.attribute.sentimento",
      "answer.assunto.choice",
      "answer.pede_reembolso.probability",
    ]) {
      expect(text.includes(source), source).toBe(true);
    }
    // A number argument is offered numbers only.
    const number = optionValues(
      screen.getByTestId("decisions-arg-source-prioridade"),
    );
    expect(number.includes("conversation.display_id")).toBe(true);
    expect(number.includes("answer.pede_reembolso.probability")).toBe(true);
    expect(number.includes("contact.name")).toBe(false);
    expect(number.includes("contact.phone")).toBe(false);
    expect(number.includes("answer.assunto.choice")).toBe(false);
  });

  test("a required argument left without a value is a problem that names it, and the block saves what was chosen", async () => {
    stubApi();
    const { state } = renderSection(
      { monitoring: { engine: "decisions", decisions: BLOCK } },
      { granted: GRANTED, customTools: TOOLS, showErrors: true },
    );
    openAll();
    const action = screen.getAllByTestId("decisions-rule-action")[0];
    if (!action) throw new Error("no action select");
    fireEvent.change(action, { target: { value: "abrir_ticket" } });
    const row = (arg: string) => screen.getByTestId(`decisions-arg-${arg}`);
    fireEvent.change(row("motivo").querySelector("input") as HTMLElement, {
      target: { value: "cancelamento" },
    });
    expect(count("decisions-problems")).toBe(1);
    const shown = document.body.textContent ?? "";
    expect(shown.includes('"telefone" is required by the tool')).toBe(true);
    // Said once, at its row: the banner only counts it.
    expect(shown.split('"telefone" is required by the tool').length - 1).toBe(
      1,
    );
    expect(shown.includes('"motivo" is required by the tool')).toBe(false);
    fireEvent.change(row("telefone").querySelector("select") as HTMLElement, {
      target: { value: "fill" },
    });
    fireEvent.change(screen.getByTestId("decisions-arg-source-telefone"), {
      target: { value: "contact.phone" },
    });
    fireEvent.change(row("prioridade").querySelector("input") as HTMLElement, {
      target: { value: "2" },
    });
    expect(count("decisions-problems")).toBe(0);
    const rules = observationToStored(state()).decisions?.rules as {
      action: unknown;
    }[];
    expect(rules[0]?.action).toEqual({
      tool: "abrir_ticket",
      args: { motivo: "cancelamento", prioridade: 2 },
      fill: { telefone: "contact.phone" },
    });
  });

  test("a decimal is typed through its unfinished steps, and stored as the number", async () => {
    stubApi();
    const { state } = renderSection(
      { monitoring: { engine: "decisions", decisions: BLOCK } },
      { granted: GRANTED, customTools: TOOLS },
    );
    openAll();
    const action = screen.getAllByTestId("decisions-rule-action")[0];
    if (!action) throw new Error("no action select");
    fireEvent.change(action, { target: { value: "abrir_ticket" } });
    const input = screen
      .getByTestId("decisions-arg-prioridade")
      .querySelector("input") as HTMLInputElement;
    for (const typed of ["1", "1.", "1.2"]) {
      fireEvent.change(input, { target: { value: typed } });
      expect(input.value).toBe(typed);
    }
    const rules = observationToStored(state()).decisions?.rules as {
      action: { args: Record<string, unknown> };
    }[];
    expect(rules[0]?.action.args.prioridade).toBe(1.2);
  });

  test("a fixed text emptied is stored as the empty text, not left out", async () => {
    stubApi();
    const { state } = renderSection(
      { monitoring: { engine: "decisions", decisions: BLOCK } },
      { granted: GRANTED, customTools: TOOLS },
    );
    openAll();
    const action = screen.getAllByTestId("decisions-rule-action")[0];
    if (!action) throw new Error("no action select");
    fireEvent.change(action, { target: { value: "abrir_ticket" } });
    const input = screen
      .getByTestId("decisions-arg-motivo")
      .querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.change(input, { target: { value: "" } });
    const rules = observationToStored(state()).decisions?.rules as {
      action: { args: Record<string, unknown> };
    }[];
    expect(rules[0]?.action.args).toEqual({ motivo: "" });
  });

  test("a hand-named MCP argument is stored as the type picked for it", async () => {
    stubApi();
    const mcp: CustomTools = new Map([
      [
        "mcp__crm__abrir",
        {
          name: "mcp__crm__abrir",
          label: "CRM: abrir",
          kind: "mcp" as const,
          args: null,
        },
      ],
    ]);
    const { state } = renderSection(
      {
        monitoring: {
          engine: "decisions",
          decisions: {
            ...BLOCK,
            rules: [
              {
                when: [{ question: "pede_reembolso", minProbability: 0.7 }],
                action: { tool: "mcp__crm__abrir", args: { prioridade: "" } },
              },
            ],
          },
        },
      },
      { granted: ["mcp__crm__abrir"], customTools: mcp },
    );
    openAll();
    const row = screen.getByTestId("decisions-arg-prioridade");
    const [, type] = Array.from(row.querySelectorAll("select"));
    if (!type) throw new Error("no type select");
    fireEvent.change(type, { target: { value: "number" } });
    fireEvent.change(row.querySelector("input") as HTMLElement, {
      target: { value: "3" },
    });
    const rules = observationToStored(state()).decisions?.rules as {
      action: { args: Record<string, unknown> };
    }[];
    expect(rules[0]?.action.args.prioridade).toBe(3);
  });

  test("a custom tool the agent does not have points to Tools instead of granting it here", async () => {
    stubApi();
    renderSection(
      {
        monitoring: {
          engine: "decisions",
          decisions: {
            ...BLOCK,
            rules: [
              {
                when: [{ question: "pede_reembolso", minProbability: 0.7 }],
                action: {
                  tool: "abrir_ticket",
                  args: { motivo: "x" },
                  fill: { telefone: "contact.phone" },
                },
              },
            ],
          },
        },
      },
      {
        granted: GRANTED.filter((n) => n !== "abrir_ticket"),
        customTools: TOOLS,
      },
    );
    expect(count("decisions-rule-not-granted")).toBeGreaterThan(0);
    expect(count("decisions-rule-grant")).toBe(0);
  });

  test("an argument named like an object's own member reads as the rule stores it", async () => {
    stubApi();
    const tools: CustomTools = new Map([
      [
        "proto",
        {
          name: "proto",
          label: "Proto",
          kind: "code" as const,
          args: [
            { name: "constructor", type: "string" as const, required: true },
          ],
        },
      ],
    ]);
    renderSection(
      { monitoring: { engine: "decisions", decisions: BLOCK } },
      { granted: [...GRANTED, "proto"], customTools: tools },
    );
    await waitFor(() => expect(logQueries.length).toBeGreaterThan(0));
    openAll();
    const action = screen.getAllByTestId("decisions-rule-action")[0];
    if (!action) throw new Error("no action select");
    fireEvent.change(action, { target: { value: "proto" } });
    const row = screen.getByTestId("decisions-arg-constructor");
    expect((row.querySelector("select") as HTMLSelectElement).value).toBe(
      "fixed",
    );
    expect((row.querySelector("input") as HTMLInputElement).value).toBe("");
  });

  test("a tool picked in place of another shows its own arguments as the action stores them", async () => {
    stubApi();
    renderSection(
      { monitoring: { engine: "decisions", decisions: BLOCK } },
      { granted: GRANTED, customTools: TOOLS },
    );
    await waitFor(() => expect(logQueries.length).toBeGreaterThan(0));
    openAll();
    const action = screen.getAllByTestId("decisions-rule-action")[0];
    if (!action) throw new Error("no action select");
    const modeOf = (arg: string) =>
      screen
        .getByTestId(`decisions-arg-${arg}`)
        .querySelector("select") as HTMLSelectElement;
    fireEvent.change(action, { target: { value: "abrir_ticket" } });
    fireEvent.change(modeOf("telefone"), { target: { value: "fill" } });
    expect(modeOf("telefone").value).toBe("fill");
    // Away and back: the action cleared its arguments, so nothing of the first pick is shown.
    fireEvent.change(action, { target: { value: "registrar_caso" } });
    fireEvent.change(action, { target: { value: "abrir_ticket" } });
    expect(modeOf("telefone").value).toBe("fixed");
  });
});
