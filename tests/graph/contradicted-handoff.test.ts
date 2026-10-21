import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  CONTRADICTED_HANDOFF_RESULT,
  contradictedHandoffs,
  setAsideContradictedHandoffs,
} from "@/graph/contradicted-handoff";

const call = (name: string, id: string) => ({ name, id, args: {} });

describe("contradictedHandoffs", () => {
  const table: Array<[string, string[], string[]]> = [
    [
      "handoff beside resolve",
      ["handoff_to_human", "resolve_conversation"],
      ["h0"],
    ],
    [
      "resolve first, handoff last",
      ["resolve_conversation", "kanban_move_card", "handoff_to_human"],
      ["h2"],
    ],
    [
      "two handoffs beside resolve",
      ["handoff_to_human", "handoff_to_human", "resolve_conversation"],
      ["h0", "h1"],
    ],
    ["handoff alone", ["handoff_to_human"], []],
    [
      "handoff beside kanban, no resolve",
      ["handoff_to_human", "kanban_move_card"],
      [],
    ],
    ["resolve alone", ["resolve_conversation"], []],
    ["no tool at all", [], []],
  ];
  for (const [label, names, expected] of table)
    test(label, () => {
      const calls = names.map((n, i) => call(n, `h${i}`));
      expect(contradictedHandoffs(calls).map((c) => c.id)).toEqual(expected);
    });
});

describe("setAsideContradictedHandoffs", () => {
  test("answers the handoff and leaves the rest of the batch to run", () => {
    const human = new HumanMessage("não obrigado.");
    const ai = new AIMessage({
      content: "",
      id: "m1",
      tool_calls: [
        call("handoff_to_human", "h"),
        call("kanban_move_card", "k"),
        call("resolve_conversation", "r"),
      ],
    });
    const out = setAsideContradictedHandoffs({ messages: [human, ai] });
    expect(out).not.toBeNull();
    const view = out?.view.messages.at(-1) as AIMessage;
    expect(out?.view.messages[0]).toBe(human);
    expect(view.id).toBe("m1");
    expect(view.tool_calls?.map((c) => c.id)).toEqual(["k", "r"]);
    expect(
      out?.answers.map((m) => [m.tool_call_id, m.content, m.status]),
    ).toEqual([["h", CONTRADICTED_HANDOFF_RESULT, "error"]]);
  });

  test("does not answer again a handoff a repeated batch already had answered", () => {
    const batch = [
      call("handoff_to_human", "h"),
      call("resolve_conversation", "r"),
    ];
    const first = new AIMessage({ content: "", tool_calls: batch });
    const repeat = new AIMessage({ content: "", tool_calls: batch });
    const answers = [
      new ToolMessage({
        content: "x",
        tool_call_id: "h",
        name: "handoff_to_human",
      }),
      new ToolMessage({
        content: "y",
        tool_call_id: "r",
        name: "resolve_conversation",
      }),
    ];
    expect(
      setAsideContradictedHandoffs({ messages: [first, ...answers, repeat] }),
    ).toBeNull();
  });

  test("leaves a batch without the contradiction alone", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [call("handoff_to_human", "h")],
    });
    expect(setAsideContradictedHandoffs({ messages: [ai] })).toBeNull();
  });
});
