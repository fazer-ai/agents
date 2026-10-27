import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ingestedMessages } from "@/graph/ingest";
import {
  burstStartStamp,
  conversationStamp,
  humanAgentMessage,
  nudgeMessage,
  sentAtStamp,
} from "@/graph/markers";
import { unansweredInputs } from "@/graph/unanswered-inputs";

const AT = new Date("2026-10-20T12:00:00Z");

function customer(
  id: string,
  text: string,
  at: Date = AT,
  conv = 7,
  burst: Date | null = AT,
) {
  return new HumanMessage({
    id,
    content: text,
    additional_kwargs: {
      ...conversationStamp(conv),
      ...sentAtStamp(at),
      ...burstStartStamp(burst),
    },
  });
}

function undated(id: string, text: string) {
  return new HumanMessage({
    id,
    content: text,
    additional_kwargs: conversationStamp(7),
  });
}

function ingested(messageId: number, text: string) {
  return ingestedMessages(
    "customer",
    text,
    7,
    false,
    messageId,
    AT,
  )[0] as BaseMessage;
}

function directive(id: string, text = "Faça o follow-up.") {
  const m = nudgeMessage(text, 7);
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
    name: "repeated directives with no output between them keep the last copy",
    thread: [directive("d1"), directive("d2"), directive("d3")],
    removed: ["d1", "d2"],
    directives: 2,
    duplicates: 0,
  },
  {
    name: "a failed directive followed by the customer stays: it may carry an event's facts",
    thread: [ai("a0"), directive("d1"), customer("h1", "voltei")],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "copies of a failed directive before the customer's message keep one",
    thread: [
      ai("a0"),
      directive("d1"),
      directive("d2"),
      customer("h1", "voltei"),
    ],
    removed: ["d1"],
    directives: 1,
    duplicates: 0,
  },
  {
    name: "two different events are not copies of each other",
    thread: [
      directive("d1"),
      directive("d2", "Pagamento confirmado."),
      ai("a1"),
    ],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "the same directive answered each time is not residue",
    thread: [directive("d1"), ai("a1"), directive("d2"), ai("a2")],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "the same customer input sent twice by a retry keeps the last copy",
    thread: [
      customer("h1", "qual o horário?"),
      customer("h2", "qual o horário?"),
    ],
    removed: ["h1"],
    duplicates: 1,
    directives: 0,
  },
  {
    name: "three copies keep one",
    thread: [customer("h1", "oi"), customer("h2", "oi"), customer("h3", "oi")],
    removed: ["h1", "h2"],
    duplicates: 2,
    directives: 0,
  },
  {
    name: "a failed event nudge between two copies leaves the customer's input last",
    thread: [customer("h1", "oi"), directive("d1"), customer("h2", "oi")],
    removed: ["h1"],
    directives: 0,
    duplicates: 1,
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
    name: "a single-message burst's retry copies carry no burst stamp and are still copies",
    thread: [
      customer("h1", "oi", AT, 7, null),
      customer("h2", "oi", AT, 7, null),
    ],
    removed: ["h1"],
    directives: 0,
    duplicates: 1,
  },
  {
    name: "the same words with another burst start are not a copy",
    thread: [
      customer("h1", "oi", AT, 7, null),
      customer("h2", "oi", AT, 7, AT),
    ],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "undated inputs are never taken for copies",
    thread: [undated("h1", "oi"), undated("h2", "oi")],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "ingested messages in the same second are two messages",
    thread: [ingested(1, "sim"), ingested(2, "sim")],
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
    name: "the same input after a tool step is left alone: a terminal tool ends a turn too",
    thread: [
      customer("h1", "que horas são?"),
      calling("a1"),
      new ToolMessage({ id: "t1", content: "12:00", tool_call_id: "c-a1" }),
      customer("h2", "que horas são?"),
    ],
    removed: [],
    directives: 0,
    duplicates: 0,
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
