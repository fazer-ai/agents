/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
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
import type { DecisionsServerRefusal } from "@/client/pages/agents/DecisionsFields";
import { ObservationSection } from "@/client/pages/agents/ObservationSection";
import {
  type ObservationState,
  observationToForm,
  observationToStored,
} from "@/client/pages/agents/observationFormState";
import { decisionsBlockFingerprint } from "@/modules/decisions/config";

// THE DECISIONS ENGINE IN THE AGENT EDITOR, drawn. The engine choice, the questions and the rules
// are on screen for a monitoring agent; a rule that names a question that is gone is shown broken;
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

function renderSection(
  settings: unknown,
  opts: { refusal?: DecisionsServerRefusal | null } = {},
): { state: () => ObservationState } {
  let latest = observationToForm(settings);
  function Harness() {
    const [observation, setObservation] = useState<ObservationState>(() =>
      observationToForm(settings),
    );
    latest = observation;
    return (
      <ObservationSection
        agentId="7"
        savedAt="2026-10-08T11:00:00.000Z"
        observation={observation}
        setObservation={setObservation}
        decisionsCredentialError={null}
        decisionsRefusal={opts.refusal ?? null}
      />
    );
  }
  render(
    <MemoryRouter>
      <ThemeProvider>
        <ToastProvider>
          <Harness />
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
const engineSelect = () =>
  screen.getByRole("combobox", { name: /What decides/ }) as HTMLSelectElement;

describe("the decisions engine in the agent editor", () => {
  test("an agent on the model engine shows the choice and none of the engine's fields", () => {
    stubApi();
    renderSection({});
    expect(engineSelect().value).toBe("llm");
    expect(count("decisions-fields")).toBe(0);
  });

  test("choosing the decisions engine opens an empty block in shadow, and says what is missing", () => {
    stubApi();
    const { state } = renderSection({});
    fireEvent.change(engineSelect(), { target: { value: "decisions" } });
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
    renderSection({ monitoring: { engine: "decisions" } });
    expect(engineSelect().value).toBe("decisions");
    expect(count("decisions-fields")).toBe(1);
    expect(count("decisions-problems")).toBe(1);
    expect(
      screen.queryAllByText(/Add at least one question/).length,
    ).toBeGreaterThan(0);
  });

  test("an agent on the decisions engine shows its provider, questions and rules", () => {
    stubApi();
    renderSection({ monitoring: { engine: "decisions", decisions: BLOCK } });
    expect(engineSelect().value).toBe("decisions");
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
    fireEvent.change(engineSelect(), { target: { value: "llm" } });
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
      "Fired in 1 of 2 decisions, would have run 1 (shadow).",
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
      "Fired in 1 of 2 decisions, would have run 1 (shadow).",
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
