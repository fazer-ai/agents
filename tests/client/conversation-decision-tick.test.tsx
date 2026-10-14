/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import i18next from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import clientEn from "@/client/locales/en.json";
import clientPt from "@/client/locales/pt-BR.json";
import {
  buildTimeline,
  type Message,
  type TrailEntry,
} from "@/client/pages/conversationTimeline";
import { DecisionTickMarker } from "@/client/pages/DecisionTickMarker";
import { isNearMiss, previousDecisionTicks } from "@/client/pages/decisionTick";

// A decision tick of a "Questions and rules" observer on the conversation page (agents#1401):
// collapsed it says what the tick did; expanded it shows each question's answer with its
// probabilities and each rule's outcome; a tick that did not decide says why in the error style. On
// the timeline it sits right before the action markers its rules wrote, though its line is newer.

afterEach(() => {
  cleanup();
});

async function inLanguage(lng: "en" | "pt-BR", ui: ReactNode) {
  const i = i18next.createInstance();
  await i.init({
    lng,
    resources: {
      en: { translation: clientEn },
      "pt-BR": { translation: clientPt },
    },
    interpolation: { escapeValue: false },
  });
  return render(<I18nextProvider i18n={i}>{ui}</I18nextProvider>);
}

const T0 = Date.parse("2026-10-12T10:00:00Z");

type Tick = NonNullable<TrailEntry["decision"]>;

const BLOCK: NonNullable<Tick["block"]> = {
  questions: [
    { name: "asks_refund", type: "yes_no" },
    {
      name: "topic",
      type: "choice",
      options: [
        { value: "exchange", description: "exchange or return" },
        { value: "damaged", description: "arrived damaged" },
        { value: "other", description: "something else" },
      ],
    },
    {
      name: "anger",
      type: "score",
      levels: [
        { value: "calm", description: "calm" },
        { value: "upset", description: "complaining" },
        { value: "furious", description: "threatens to leave" },
      ],
    },
  ],
  rules: [
    {
      when: [{ question: "asks_refund", minProbability: 0.7 }],
      tool: "set_labels",
      trigger: "each_time",
    },
    {
      when: [{ question: "asks_refund", minProbability: 0.9 }],
      tool: "handoff_to_human",
      trigger: "on_start",
    },
    {
      when: [{ question: "topic", equals: "exchange", minConfidence: 0.6 }],
      tool: "set_custom_attribute",
      trigger: "each_time",
    },
    {
      when: [{ question: "anger", minLevel: 2, maxLevel: 2 }],
      tool: "set_labels",
      trigger: "on_start",
    },
    {
      when: [{ question: "topic", equals: "damaged" }],
      tool: "private_note",
      trigger: "on_start",
    },
  ],
};

const ANSWERS = {
  asks_refund: { type: "yes_no", probability: 0.82 },
  topic: {
    type: "choice",
    choice: "exchange",
    confidence: 0.51,
    probabilities: { exchange: 0.59, damaged: 0.41, other: 0 },
  },
  anger: {
    type: "score",
    score: 1.2,
    confidence: 0.7,
    probabilities: { calm: 0.1, upset: 0.6, furious: 0.3 },
  },
};

function tick(over: Partial<Tick> = {}): Tick {
  return {
    outcome: "decided",
    agentId: "7",
    provider: "typesafe",
    model: "jev-latest",
    modelVersion: "jev-1.13.0",
    reason: "burst",
    messagesRead: 4,
    skipped: null,
    failed: null,
    failure: null,
    problem: null,
    answers: ANSWERS,
    actions: [{ rule: 0, tool: "set_labels", outcome: "ran", merged: [] }],
    notFired: [
      {
        rule: 1,
        miss: {
          question: "asks_refund",
          why: "below_threshold",
          got: 0.82,
          threshold: 0.9,
          measure: "probability",
        },
      },
      {
        rule: 2,
        miss: {
          question: "topic",
          why: "below_threshold",
          got: 0.51,
          threshold: 0.6,
          measure: "confidence",
        },
      },
      {
        rule: 3,
        miss: {
          question: "anger",
          why: "outside_levels",
          got: 1,
          minLevel: 2,
          maxLevel: 2,
        },
      },
      {
        rule: 4,
        miss: {
          question: "topic",
          why: "other_choice",
          got: "exchange",
          expected: "damaged",
        },
      },
    ],
    held: [],
    labels: [],
    block: BLOCK,
    ...over,
  };
}

function entry(
  id: string,
  over: Partial<TrailEntry> & { atMs?: number } = {},
): TrailEntry {
  const { atMs, ...rest } = over;
  return {
    id,
    turnId: `turn-${id}`,
    kind: "decision",
    name: null,
    status: "ok",
    durationMs: 700,
    step: null,
    args: null,
    output: null,
    errorMessage: null,
    turnDelivered: null,
    originRecorded: null,
    messageId: null,
    integrationName: null,
    decision: tick(),
    at: new Date(atMs ?? T0).toISOString(),
    ...rest,
  } as TrailEntry;
}

function msg(id: number, atMs: number): Message {
  return {
    id,
    content: `m${id}`,
    messageType: 0,
    createdAt: Math.floor(atMs / 1000),
    attachments: [],
  } as unknown as Message;
}

// Opens the marker, then every question's bars and the folded rules, so a test reads the whole tick.
async function expand(e: TrailEntry, lng: "en" | "pt-BR" = "en") {
  await inLanguage(lng, <DecisionTickMarker entry={e} />);
  fireEvent.click(screen.getAllByRole("button")[0] as HTMLElement);
  const d = screen.getByTestId("decision-details");
  for (const q of within(d).queryAllByTestId(/^decision-question-/)) {
    const b = within(q).queryByRole("button");
    if (b) fireEvent.click(b);
  }
  const rest = within(d).queryByTestId("decision-rules-rest");
  if (rest) fireEvent.click(within(rest).getByRole("button"));
  return d;
}

// Every rule's line, in rule order whatever group it sits in.
const ruleLines = () =>
  screen
    .getAllByTestId("decision-rule")
    .map((r) => r.textContent ?? "")
    .sort(
      (a, b) =>
        Number(/^Rule (\d+)/.exec(a)?.[1]) - Number(/^Rule (\d+)/.exec(b)?.[1]),
    );

describe("the collapsed marker", () => {
  test("names the classifier version, the duration and what ran, counted by kind", async () => {
    await inLanguage(
      "en",
      <DecisionTickMarker
        entry={entry("1", {
          decision: tick({
            actions: [
              { rule: 0, tool: "set_labels", outcome: "ran", merged: [] },
              { rule: 3, tool: "set_labels", outcome: "ran", merged: [] },
              {
                rule: 2,
                tool: "set_custom_attribute",
                outcome: "ran",
                merged: [],
              },
              { rule: 1, tool: "handoff_to_human", outcome: "ran", merged: [] },
            ],
          }),
        })}
      />,
    );
    const m = screen.getByTestId("decision-marker").textContent ?? "";
    expect(m).toContain("Classified");
    expect(m).toContain("jev-1.13.0");
    expect(m).toContain("700ms");
    expect(m).toContain("2 label writes, 1 attribute, handed off");
    expect(m).toContain("✓");
  });

  test("label writes are counted by what they changed when the line says, not by calls", async () => {
    const ran = (rule: number) => ({
      rule,
      tool: "set_labels",
      outcome: "ran",
      merged: [],
    });
    await inLanguage(
      "en",
      <DecisionTickMarker
        entry={entry("1", {
          decision: tick({
            actions: [ran(0), ran(3)],
            labels: [
              { scope: "conversation", added: 3, removed: 1, after: 4 },
              { scope: "conversation", added: 0, removed: 1, after: 3 },
            ],
          }),
        })}
      />,
    );
    expect(screen.getByTestId("decision-marker").textContent).toContain(
      "3 labels added, 2 labels removed",
    );
    cleanup();
    await inLanguage(
      "en",
      <DecisionTickMarker
        entry={entry("1", {
          decision: tick({
            actions: [ran(0)],
            labels: [{ scope: "conversation", added: 0, removed: 0, after: 2 }],
          }),
        })}
      />,
    );
    const m = screen.getByTestId("decision-marker").textContent ?? "";
    expect(m).toContain("labels unchanged");
    expect(m).not.toContain("1 label");
  });

  test("says no rule fired when none did, without the error style", async () => {
    await inLanguage(
      "en",
      <DecisionTickMarker
        entry={entry("1", { decision: tick({ actions: [] }) })}
      />,
    );
    const m = screen.getByTestId("decision-marker");
    expect(m.textContent).toContain("no rule fired");
    expect(m.querySelector(".text-error")).toBeNull();
  });

  test("speaks the screen's language", async () => {
    await inLanguage("pt-BR", <DecisionTickMarker entry={entry("1")} />);
    expect(screen.getByTestId("decision-marker").textContent).toContain(
      "1 escrita de etiqueta",
    );
  });

  test.each([
    [
      {
        outcome: "failed",
        skipped: "decisions_config_invalid",
        problem: "monitoring.decisions.questions",
      },
      "The questions and rules are not valid: monitoring.decisions.questions",
    ],
    [
      { outcome: "failed", skipped: "decisions_credential_unresolved" },
      "The classifier's credential could not be read from the vault",
    ],
    [
      { outcome: "failed", failed: "decision_call", failure: "HTTP 503" },
      "The call to the classifier failed: HTTP 503",
    ],
  ] as const)(
    "a tick that did not decide says why, as an error: %o",
    async (over, why) => {
      await inLanguage(
        "en",
        <DecisionTickMarker
          entry={entry("1", {
            status: "error",
            decision: tick({
              ...over,
              answers: null,
              actions: [],
              notFired: [],
            } as Partial<Tick>),
          })}
        />,
      );
      const m = screen.getByTestId("decision-marker");
      expect(m.textContent).toContain("Classification failed");
      expect(m.querySelector(".text-error")?.textContent).toBe("✗");
      expect(screen.getByText(why)).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
    },
  );
});

describe("what the collapsed marker counts and how a skip looks", () => {
  test("an action that did not run is not counted as done", async () => {
    await inLanguage(
      "en",
      <DecisionTickMarker
        entry={entry("1", {
          decision: tick({
            actions: [
              {
                rule: 0,
                tool: "set_labels",
                outcome: "refused",
                fence: "protected_label",
                merged: [],
              },
              {
                rule: 1,
                tool: "handoff_to_human",
                outcome: "not_granted",
                merged: [],
              },
            ],
          }),
        })}
      />,
    );
    const m = screen.getByTestId("decision-marker").textContent ?? "";
    expect(m).toContain("no action ran");
    expect(m).not.toContain("label");
    expect(m).not.toContain("handed off");
  });

  test("a tick with nothing to do is skipped, not failed, and says why", async () => {
    await inLanguage(
      "en",
      <DecisionTickMarker
        entry={entry("1", {
          status: "skipped",
          decision: tick({
            outcome: "skipped",
            skipped: "no_customer_message",
            answers: null,
            actions: [],
            notFired: [],
          }),
        })}
      />,
    );
    const m = screen.getByTestId("decision-marker");
    expect(m.textContent).toContain("Classification skipped");
    expect(m.querySelector(".text-error")).toBeNull();
    expect(screen.getByText("No customer message to read yet")).toBeTruthy();
  });
});

describe("the expanded tick", () => {
  test("a choice shows every option with its probability, the chosen one and the confidence", async () => {
    const d = await expand(entry("1"));
    const q = within(d).getByTestId("decision-question-topic");
    const rows = within(q).getAllByTestId("decision-option");
    expect(rows.map((r) => [r.textContent, r.dataset.chosen])).toEqual([
      ["exchangechosenexchange or return59%", "true"],
      ["damagedarrived damaged41%", "false"],
      ["othersomething else0%", "false"],
    ]);
    expect(q.textContent).toContain("confidence 51%");
  });

  test("questions follow the block's order", async () => {
    const d = await expand(entry("1"));
    expect(
      within(d)
        .getAllByTestId(/^decision-question-/)
        .map((q) => q.dataset.testid),
    ).toEqual([
      "decision-question-asks_refund",
      "decision-question-topic",
      "decision-question-anger",
    ]);
  });

  test("a score shows the level reached, the probability per level and the confidence", async () => {
    const d = await expand(entry("1"));
    const q = within(d).getByTestId("decision-question-anger");
    expect(q.textContent).toContain("level 1 · upset (score 1.20)");
    expect(q.textContent).toContain("confidence 70%");
    expect(
      within(q)
        .getAllByTestId("decision-option")
        .map((r) => [r.textContent, r.dataset.chosen]),
    ).toEqual([
      ["calmcalm10%", "false"],
      ["upsetchosencomplaining60%", "true"],
      ["furiousthreatens to leave30%", "false"],
    ]);
  });

  test("a yes/no shows its probability and the threshold of each rule that reads it", async () => {
    // A second yes/no question with a rule of its own, whose threshold is not the first one's.
    const block = {
      ...BLOCK,
      questions: [
        ...BLOCK.questions,
        { name: "wants_human", type: "yes_no" as const },
      ],
      rules: [
        ...BLOCK.rules,
        {
          when: [{ question: "wants_human", minProbability: 0.5 }],
          tool: "handoff_to_human",
          trigger: "on_start" as const,
        },
      ],
    };
    const d = await expand(
      entry("1", {
        decision: tick({
          block,
          answers: {
            ...ANSWERS,
            wants_human: { type: "yes_no", probability: 0.3 },
          },
        }),
      }),
    );
    expect(
      within(d).getByTestId("decision-question-wants_human").textContent,
    ).toBe("wants_humanyes: 30%Rule 6 asks at least 50%");
    const q = within(d).getByTestId("decision-question-asks_refund");
    expect(q.textContent).toContain("yes: 82%");
    expect(q.textContent).toContain(
      "Rule 1 asks at least 70% · Rule 2 asks at least 90%",
    );
  });

  test("every rule has its outcome: fired, and each reason a rule did not fire", async () => {
    await expand(entry("1"));
    expect(ruleLines()).toEqual([
      "Rule 1set_labelsfired: ranbecause asks_refund yes 82% (at least 70%)",
      "Rule 2handoff_to_humanasks_refund probability 82% is below 90%",
      "Rule 3set_custom_attributetopic confidence 51% is below 60%",
      "Rule 4set_labelsanger at level 1 (upset); asks for level 2 (furious)",
      "Rule 5private_notenot fired: topic answered exchange, the rule expects damaged",
    ]);
  });

  test("the wording the operator asked for on #1417: one level reads as that level, a range as from-to, one parenthetical, a near miss on one line", async () => {
    await inLanguage(
      "pt-BR",
      <DecisionTickMarker
        entry={entry("1", {
          decision: tick({
            block: {
              ...BLOCK,
              rules: [
                ...BLOCK.rules.slice(0, 3),
                {
                  when: [{ question: "anger", minLevel: 2, maxLevel: 2 }],
                  tool: "set_labels",
                  trigger: "on_start",
                },
                {
                  when: [{ question: "anger", minLevel: 0, maxLevel: 0 }],
                  tool: "private_note",
                  trigger: "each_time",
                },
              ],
            },
            notFired: [
              {
                rule: 3,
                miss: {
                  question: "anger",
                  why: "outside_levels",
                  got: 1.2,
                  minLevel: 2,
                  maxLevel: 2,
                },
              },
              {
                rule: 4,
                miss: {
                  question: "anger",
                  why: "outside_levels",
                  got: 1.2,
                  minLevel: 0,
                  maxLevel: 0,
                },
              },
              {
                rule: 2,
                miss: {
                  question: "anger",
                  why: "outside_levels",
                  got: 1,
                  minLevel: 2,
                  maxLevel: 3,
                },
              },
            ],
          }),
        })}
      />,
    );
    fireEvent.click(screen.getAllByRole("button")[0] as HTMLElement);
    const near = within(screen.getByTestId("decision-rules-near"))
      .getAllByTestId("decision-rule")
      .map((r) => r.textContent);
    expect(near).toEqual([
      "Regra 3set_custom_attributeanger no nível 1 (upset); pede de 2 (furious) a 3",
      "Regra 4set_labelsanger no nível 1 (upset), nota 1.20; pede o nível 2 (furious)",
      "Regra 5private_noteanger no nível 1 (upset), nota 1.20; pede o nível 0 (calm)",
    ]);
    for (const line of near) expect(line).not.toMatch(/\)\s*\(/);
    // One line on a wide screen: the row does not wrap from lg up, and the reason keeps its whole
    // text in the title when a long name would still overflow.
    const row = within(
      screen.getByTestId("decision-rules-near"),
    ).getAllByTestId("decision-rule")[1] as HTMLElement;
    expect(row.className).toContain("lg:flex-nowrap");
    const reason = row.lastElementChild as HTMLElement;
    expect(reason.className).toContain("lg:truncate");
    expect(reason.getAttribute("title")).toBe(
      "anger no nível 1 (upset), nota 1.20; pede o nível 2 (furious)",
    );
  });

  test("a score between two levels names the nearest one, as the rule read it, and the score", async () => {
    await expand(
      entry("1", {
        decision: tick({
          notFired: [
            {
              rule: 3,
              miss: {
                question: "anger",
                why: "outside_levels",
                got: 1.46,
                minLevel: 2,
                maxLevel: 2,
              },
            },
          ],
        }),
      }),
    );
    expect(ruleLines()[3]).toBe(
      "Rule 4set_labelsanger at level 1 (upset), score 1.46; asks for level 2 (furious)",
    );
  });

  test("a held rule reads apart from one that did not fire, with its trigger", async () => {
    await expand(
      entry("1", {
        decision: tick({
          answers: {
            ...ANSWERS,
            anger: {
              type: "score",
              score: 2,
              confidence: 0.9,
              probabilities: { calm: 0, upset: 0.1, furious: 0.9 },
            },
          },
          held: [{ rule: 3, trigger: "on_start" }],
          notFired: tick().notFired.filter(
            (n) => (n as { rule: number }).rule !== 3,
          ),
          actions: [
            { rule: 0, tool: "set_labels", outcome: "ran", merged: [] },
          ],
        }),
      }),
    );
    expect(ruleLines()[3]).toBe(
      "Rule 4set_labelsconditions held, but it already acted (When the conditions start holding)because anger level 2 (furious), needs level 2",
    );
    // Its conditions held, but it did not act this tick: its own group, neither fired nor a miss.
    const rulesIn = (id: string) =>
      within(screen.getByTestId(id))
        .getAllByTestId("decision-rule")
        .map((r) => /^Rule (\d+)/.exec(r.textContent ?? "")?.[1]);
    expect(rulesIn("decision-rules-fired")).toEqual(["1"]);
    expect(rulesIn("decision-rules-held")).toEqual(["4"]);
    expect(
      within(screen.getByTestId("decision-rules-held")).getByText(
        "Already acted",
      ),
    ).toBeTruthy();
  });

  test("each outcome of a fired rule, and a merged rule takes the outcome of the action it shares", async () => {
    await expand(
      entry("1", {
        decision: tick({
          notFired: [],
          actions: [
            {
              rule: 0,
              tool: "set_labels",
              outcome: "refused",
              fence: "protected_label",
              merged: [3],
            },
            {
              rule: 1,
              tool: "handoff_to_human",
              outcome: "not_granted",
              merged: [],
            },
            {
              rule: 2,
              tool: "set_custom_attribute",
              outcome: "failed",
              failure: "tool_error",
              merged: [],
            },
            { rule: 4, tool: "private_note", outcome: "ran", merged: [] },
          ],
        }),
      }),
    );
    expect(ruleLines()).toEqual([
      "Rule 1set_labelsfired: refused by a protected labelbecause asks_refund yes 82% (at least 70%)",
      "Rule 2handoff_to_humanfired: not allowed for this agentbecause asks_refund yes 82% (at least 90%)",
      "Rule 3set_custom_attributefired: failed (tool_error)because topic is exchange, 51% sure (needs 60%)",
      "Rule 4set_labelsfired, same action as rule 1: refused by a protected labelbecause anger level 1 (upset), needs level 2",
      "Rule 5private_notefired: ranbecause topic is exchange",
    ]);
  });

  test("a question left unanswered gets no invented numbers, and the rule says why it did not fire", async () => {
    const { anger: _, ...answers } = ANSWERS;
    const d = await expand(
      entry("1", {
        decision: tick({
          answers,
          notFired: [
            { rule: 3, miss: { question: "anger", why: "unanswered" } },
          ],
        }),
      }),
    );
    const q = within(d).getByTestId("decision-question-anger");
    expect(q.textContent).toBe("angernot answered");
    expect(within(q).queryAllByTestId("decision-option")).toEqual([]);
    expect(ruleLines()[3]).toBe(
      "Rule 4set_labelsnot fired: anger was not answered",
    );
  });

  test("a line that ran another block shows what it stored and none of the current descriptions", async () => {
    const d = await expand(
      entry("1", {
        decision: tick({
          block: null,
          answers: {
            ...ANSWERS,
            topic: {
              type: "choice",
              choice: "exchange",
              confidence: 0.51,
              probabilities: { exchange: 0.59, damaged: 0.31, cancel: 0.1 },
            },
          },
        }),
      }),
    );
    expect(
      within(within(d).getByTestId("decision-question-topic"))
        .getAllByTestId("decision-option")
        .map((r) => r.textContent),
    ).toEqual(["exchangechosen59%", "damaged31%", "cancel10%"]);
    for (const text of ["exchange or return", "complaining", "Rule 1 asks"]) {
      expect(d.textContent).not.toContain(text);
    }
  });
});

describe("a line that ran another block", () => {
  test("a score names no level, since the stored probabilities do not say which index is which", async () => {
    const d = await expand(
      entry("1", {
        decision: tick({
          block: null,
          answers: {
            anger: {
              type: "score",
              score: 1,
              confidence: 0.7,
              probabilities: { furious: 0.2, calm: 0.3, upset: 0.5 },
            },
          },
        }),
      }),
    );
    const q = within(d).getByTestId("decision-question-anger");
    expect(q.textContent).toContain("level 1 (score 1.00)");
    expect(
      within(q)
        .getAllByTestId("decision-option")
        .map((r) => [r.textContent, r.dataset.chosen]),
    ).toEqual([
      ["furious20%", "false"],
      ["calm30%", "false"],
      ["upset50%", "false"],
    ]);
  });

  test("a choice whose probability was not given still shows what was chosen", async () => {
    const d = await expand(
      entry("1", {
        decision: tick({
          block: null,
          answers: {
            topic: {
              type: "choice",
              choice: "exchange",
              confidence: 0.9,
              probabilities: { damaged: 0.1 },
            },
          },
        }),
      }),
    );
    expect(
      within(within(d).getByTestId("decision-question-topic"))
        .getAllByTestId("decision-option")
        .map((r) => [r.textContent, r.dataset.chosen]),
    ).toEqual([
      ["damaged10%", "false"],
      ["exchangechosen—", "true"],
    ]);
  });
});

describe("reading a large block (the operator's review of #1417)", () => {
  test("a question is one line, its answer and confidence; its bars open on a click", async () => {
    await inLanguage("en", <DecisionTickMarker entry={entry("1")} />);
    fireEvent.click(screen.getAllByRole("button")[0] as HTMLElement);
    const q = screen.getByTestId("decision-question-topic");
    expect(q.textContent).toBe("topicexchangeconfidence 51%");
    expect(within(q).queryAllByTestId("decision-option")).toEqual([]);
    expect(q.textContent).not.toContain("exchange or return");
    fireEvent.click(within(q).getByRole("button"));
    expect(within(q).getAllByTestId("decision-option")).toHaveLength(3);
  });

  test("a runner-up within 15 points of the chosen option is flagged as a close call", async () => {
    const closeOn = (p: Record<string, number>, choice: string) =>
      tick({
        answers: {
          topic: { type: "choice", choice, confidence: 0.5, probabilities: p },
        },
      });
    await inLanguage(
      "en",
      <DecisionTickMarker
        entry={entry("1", {
          decision: closeOn(
            { exchange: 0.55, damaged: 0.44, other: 0.01 },
            "exchange",
          ),
        })}
      />,
    );
    fireEvent.click(screen.getAllByRole("button")[0] as HTMLElement);
    expect(screen.getByTestId("decision-close-call").textContent).toBe(
      "close call: damaged 44%",
    );
    cleanup();
    await inLanguage(
      "en",
      <DecisionTickMarker
        entry={entry("1", {
          decision: closeOn(
            { exchange: 0.6, damaged: 0.44, other: 0 },
            "exchange",
          ),
        })}
      />,
    );
    fireEvent.click(screen.getAllByRole("button")[0] as HTMLElement);
    expect(screen.queryByTestId("decision-close-call")).toBeNull();
  });

  test("a fired rule's cause names every bar it cleared: the level range and the confidence it asks for", async () => {
    await inLanguage(
      "en",
      <DecisionTickMarker
        entry={entry("1", {
          decision: tick({
            block: {
              ...BLOCK,
              rules: [
                {
                  when: [
                    {
                      question: "anger",
                      minLevel: 1,
                      maxLevel: 2,
                      minConfidence: 0.6,
                    },
                    {
                      question: "topic",
                      equals: "exchange",
                      minConfidence: 0.5,
                    },
                  ],
                  tool: "set_labels",
                  trigger: "each_time",
                },
              ],
            },
            notFired: [],
          }),
        })}
      />,
    );
    fireEvent.click(screen.getAllByRole("button")[0] as HTMLElement);
    expect(
      within(screen.getByTestId("decision-rules-fired")).getByTestId(
        "decision-rule-cause",
      ).textContent,
    ).toBe(
      "because anger level 1 (upset), needs 1 to 2, 70% sure (needs 60%); topic is exchange, 51% sure (needs 50%)",
    );
  });

  test("rules sit in three groups: fired with their cause, almost fired, and the rest folded", async () => {
    await inLanguage("en", <DecisionTickMarker entry={entry("1")} />);
    fireEvent.click(screen.getAllByRole("button")[0] as HTMLElement);
    const lines = (id: string) =>
      within(screen.getByTestId(id))
        .queryAllByTestId("decision-rule")
        .map((r) => /^Rule (\d+)/.exec(r.textContent ?? "")?.[1]);
    expect(lines("decision-rules-fired")).toEqual(["1"]);
    expect(
      within(screen.getByTestId("decision-rules-fired")).getByTestId(
        "decision-rule-cause",
      ).textContent,
    ).toBe("because asks_refund yes 82% (at least 70%)");
    // 82% under 90%, a confidence of 51% under 60%, and a score one level short.
    expect(lines("decision-rules-near")).toEqual(["2", "3", "4"]);
    const rest = screen.getByTestId("decision-rules-rest");
    expect(rest.textContent).toBe("1 rule did not fire");
    expect(lines("decision-rules-rest")).toEqual([]);
    fireEvent.click(within(rest).getByRole("button"));
    expect(lines("decision-rules-rest")).toEqual(["5"]);
  });

  test("a near miss is within 15 points of its threshold, or one level outside the range", () => {
    const below = (got: number, threshold: number) =>
      isNearMiss({ why: "below_threshold", got, threshold, question: "q" });
    expect(below(0.55, 0.7)).toBe(true);
    expect(below(0.54, 0.7)).toBe(false);
    expect(
      isNearMiss({ why: "below_threshold", got: null, threshold: 0.7 }),
    ).toBe(false);
    const levels = (got: number, minLevel: number, maxLevel: number) =>
      isNearMiss({ why: "outside_levels", got, minLevel, maxLevel });
    expect(levels(1.2, 2, 2)).toBe(true);
    expect(levels(0.4, 2, 2)).toBe(false);
    expect(levels(4, 1, 3)).toBe(true);
    expect(levels(4.6, 1, 3)).toBe(false);
    expect(isNearMiss({ why: "other_choice", got: "a", expected: "b" })).toBe(
      false,
    );
  });

  test("the expanded tick takes the trail's width and puts questions and rules side by side on a wide screen", async () => {
    const d = await expand(entry("1"));
    expect(d.className).toContain("lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]");
    expect(d.parentElement?.className).toBe("w-full");
  });

  test("the collapsed marker says which answers moved since the agent's previous tick", async () => {
    const previous = tick({
      answers: {
        ...ANSWERS,
        asks_refund: { type: "yes_no", probability: 0.3 },
        topic: { ...ANSWERS.topic, choice: "damaged" },
        anger: { ...ANSWERS.anger, score: 2.1 },
      },
    });
    await inLanguage(
      "en",
      <DecisionTickMarker entry={entry("2")} previous={previous} />,
    );
    expect(screen.getByTestId("decision-changes").textContent).toBe(
      "asks_refund: no → yes; topic: damaged → exchange; anger: furious → upset",
    );
    cleanup();
    await inLanguage(
      "en",
      <DecisionTickMarker entry={entry("2")} previous={tick()} />,
    );
    expect(screen.queryByTestId("decision-changes")).toBeNull();
    cleanup();
    await inLanguage("en", <DecisionTickMarker entry={entry("2")} />);
    expect(screen.queryByTestId("decision-changes")).toBeNull();
  });

  test("a score's level need not be the likeliest: a runner-up far above it is not a close call", async () => {
    await inLanguage(
      "en",
      <DecisionTickMarker
        entry={entry("1", {
          decision: tick({
            answers: {
              anger: {
                type: "score",
                score: 0.8,
                confidence: 0.5,
                probabilities: { calm: 0.6, upset: 0, furious: 0.4 },
              },
            },
          }),
        })}
      />,
    );
    fireEvent.click(screen.getAllByRole("button")[0] as HTMLElement);
    expect(screen.queryByTestId("decision-close-call")).toBeNull();
  });

  test("a question whose type changed between ticks reports no move", async () => {
    const previous = tick({
      answers: {
        ...ANSWERS,
        asks_refund: {
          type: "choice",
          choice: "refund",
          confidence: 1,
          probabilities: { refund: 1 },
        },
      },
    });
    await inLanguage(
      "en",
      <DecisionTickMarker entry={entry("2")} previous={previous} />,
    );
    expect(screen.queryByTestId("decision-changes")).toBeNull();
  });

  test("a score is compared only between ticks of the block shown, since an edit can reorder its levels", async () => {
    const previous = tick({
      block: null,
      answers: {
        ...ANSWERS,
        topic: { ...ANSWERS.topic, choice: "damaged" },
        anger: { ...ANSWERS.anger, score: 2.1 },
      },
    });
    await inLanguage(
      "en",
      <DecisionTickMarker entry={entry("2")} previous={previous} />,
    );
    expect(screen.getByTestId("decision-changes").textContent).toBe(
      "topic: damaged → exchange",
    );
  });

  test("a rule a legacy line names nowhere fired with an earlier rule's action, not among the misses", async () => {
    await inLanguage(
      "en",
      <DecisionTickMarker
        entry={entry("1", {
          decision: tick({
            actions: [{ rule: 0, tool: "set_labels", outcome: "ran" }],
            notFired: [],
          }),
        })}
      />,
    );
    fireEvent.click(screen.getAllByRole("button")[0] as HTMLElement);
    const fired = within(screen.getByTestId("decision-rules-fired"))
      .getAllByTestId("decision-rule")
      .map((r) => r.textContent ?? "");
    expect(fired).toHaveLength(5);
    expect(fired[1]).toContain(
      "fired with an earlier rule's identical action, no outcome of its own",
    );
    expect(screen.queryByTestId("decision-rules-rest")).toBeNull();
  });

  test("the previous tick is the same agent's last decided one; the first has none", () => {
    const of = (
      id: string,
      agentId: string,
      outcome: Tick["outcome"] = "decided",
    ) =>
      entry(id, {
        decision: tick({
          agentId,
          outcome,
          ...(outcome === "decided" ? {} : { answers: null }),
        }),
      });
    const trail = [
      of("1", "A"),
      of("2", "B"),
      of("3", "A", "failed"),
      of("4", "A"),
      entry("5", { kind: "tool", decision: null }),
      of("6", "B"),
    ];
    const prev = previousDecisionTicks(trail);
    const agentOf = (id: string) => prev.get(id)?.agentId ?? null;
    expect([...prev.keys()]).toEqual(["4", "6"]);
    expect([agentOf("4"), agentOf("6")]).toEqual(["A", "B"]);
    expect(prev.get("4")).toBe(trail[0]?.decision ?? undefined);
  });
});

describe("where a tick sits on the timeline", () => {
  test("right before the action markers of its own turn, though its line is newer", () => {
    const tool = (id: string, atMs: number, turnId: string): TrailEntry =>
      entry(id, {
        kind: "tool",
        name: "set_labels",
        decision: null,
        atMs,
        turnId,
      });
    const tl = buildTimeline(
      [msg(1, T0)],
      [
        tool("10", T0 + 9_000, "other"),
        tool("11", T0 + 9_400, "U"),
        tool("12", T0 + 9_600, "U"),
        entry("13", { atMs: T0 + 10_000, turnId: "U" }),
      ],
      0,
    );
    expect(
      tl.items.map((i) => (i.kind === "trail" ? i.entry.id : `m${i.kind}`)),
    ).toEqual(["mmessage", "10", "13", "11", "12"]);
  });

  test("a tick with no action marker keeps its own time among the messages", () => {
    const tl = buildTimeline(
      [msg(1, T0), msg(2, T0 + 20_000)],
      [entry("13", { atMs: T0 + 5_000 })],
      0,
    );
    expect(
      tl.items.map((i) => (i.kind === "trail" ? i.entry.id : `m${i.kind}`)),
    ).toEqual(["mmessage", "13", "mmessage"]);
  });
});
