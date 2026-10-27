import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  conversationDividerMessage,
  conversationStamp,
  humanAgentMessage,
  nudgeMessage,
  sentAtStamp,
} from "@/graph/markers";
import { unansweredInputs } from "@/graph/unanswered-inputs";

const AT = new Date("2026-10-20T12:00:00Z");

function customer(id: string, text: string, at: Date | null = AT, conv = 7) {
  return new HumanMessage({
    id,
    content: text,
    additional_kwargs: { ...conversationStamp(conv), ...sentAtStamp(at) },
  });
}

function directive(id: string) {
  const m = nudgeMessage("Faça o follow-up.", 7);
  m.id = id;
  return m;
}

function ai(id: string, text = "ok") {
  return new AIMessage({ id, content: text });
}

function calling(id: string) {
  return new AIMessage({
    id,
    content: "",
    tool_calls: [
      { id: `c-${id}`, name: "skip_reply", args: {}, type: "tool_call" },
    ],
  });
}

const CASES: Array<{
  name: string;
  thread: BaseMessage[];
  removed: string[];
  directives: number;
  duplicates: number;
}> = [
  {
    name: "a directive the model answered stays",
    thread: [directive("d1"), ai("a1"), customer("h1", "oi")],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "a directive answered by a tool call (a chosen silence) stays",
    thread: [
      directive("d1"),
      calling("a1"),
      new ToolMessage({ id: "t1", content: "ok", tool_call_id: "c-a1" }),
      customer("h1", "oi"),
    ],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "directives no model output followed are removed, the last input never",
    thread: [directive("d1"), directive("d2"), directive("d3")],
    removed: ["d1", "d2"],
    directives: 2,
    duplicates: 0,
  },
  {
    name: "a failed directive before the customer's next message is removed",
    thread: [ai("a0"), directive("d1"), customer("h1", "voltei")],
    removed: ["d1"],
    directives: 1,
    duplicates: 0,
  },
  {
    name: "a failed directive before a divider is removed",
    thread: [
      directive("d1"),
      conversationDividerMessage(8),
      customer("h1", "oi", AT, 8),
    ],
    removed: ["d1"],
    directives: 1,
    duplicates: 0,
  },
  {
    name: "the same customer input sent twice by a retry keeps the last copy",
    thread: [
      customer("h1", "qual o horário?"),
      customer("h2", "qual o horário?"),
    ],
    removed: ["h2"],
    duplicates: 1,
    directives: 0,
  },
  {
    name: "three copies keep one",
    thread: [customer("h1", "oi"), customer("h2", "oi"), customer("h3", "oi")],
    removed: ["h2", "h3"],
    duplicates: 2,
    directives: 0,
  },
  {
    name: "the customer repeating the same words later is two messages",
    thread: [
      customer("h1", "oi", new Date("2026-10-20T12:00:00Z")),
      customer("h2", "oi", new Date("2026-10-20T12:05:00Z")),
    ],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "unstamped inputs are never taken for copies",
    thread: [customer("h1", "oi", null), customer("h2", "oi", null)],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "the same words in another conversation are not a copy",
    thread: [customer("h1", "oi", AT, 7), customer("h2", "oi", AT, 8)],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "a message a human agent sent is never a customer copy",
    thread: [
      humanAgentMessage(7, "oi", "g1", AT),
      humanAgentMessage(7, "oi", "g2", AT),
    ],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "the same input after a finished answer is a new message, not a copy",
    thread: [customer("h1", "ok"), ai("a1"), customer("h2", "ok")],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "a copy appended after the failed attempt's tool progress is removed, the progress stays",
    thread: [
      customer("h1", "que horas são?"),
      calling("a1"),
      new ToolMessage({ id: "t1", content: "12:00", tool_call_id: "c-a1" }),
      customer("h2", "que horas são?"),
    ],
    removed: ["h2"],
    directives: 0,
    duplicates: 1,
  },
];

describe("unansweredInputs", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const out = unansweredInputs(c.thread);
      expect(out.ids).toEqual(c.removed);
      expect(out.directives).toBe(c.directives);
      expect(out.duplicates).toBe(c.duplicates);
    });
  }

  test("a message without an id cannot be removed and is left alone", () => {
    const d = nudgeMessage("Faça o follow-up.", 7);
    expect(unansweredInputs([d, directive("d2")]).ids).toEqual([]);
  });
});
