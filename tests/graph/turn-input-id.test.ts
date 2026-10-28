import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { turnInputId } from "@/graph/turn-input-id";

const KEY = "turn:42";

function input(id = KEY) {
  return new HumanMessage({ id, content: "oi" });
}

function calling(id: string) {
  return new AIMessage({
    id,
    content: "",
    tool_calls: [
      { id: `c-${id}`, name: "buscar", args: {}, type: "tool_call" },
    ],
  });
}

const CASES: Array<{ name: string; thread: BaseMessage[]; reused: boolean }> = [
  { name: "a first attempt writes under the key", thread: [], reused: true },
  {
    name: "a retry after a failed attempt reuses the key",
    thread: [new AIMessage({ id: "a0", content: "antes" }), input()],
    reused: true,
  },
  {
    name: "a retry after the failed attempt's tool step reuses the key",
    thread: [
      input(),
      calling("a1"),
      new ToolMessage({ id: "t1", content: "ok", tool_call_id: "c-a1" }),
    ],
    reused: true,
  },
  {
    name: "a run after the model answered that input is a new turn",
    thread: [input(), new AIMessage({ id: "a1", content: "resposta" })],
    reused: false,
  },
  {
    name: "a customer message after the input is another turn",
    thread: [input(), new HumanMessage({ id: "h9", content: "e aí?" })],
    reused: false,
  },
  {
    name: "a customer message after the failed attempt's tool step is another turn",
    thread: [
      input(),
      calling("a1"),
      new ToolMessage({ id: "t1", content: "ok", tool_call_id: "c-a1" }),
      new HumanMessage({ id: "h9", content: "e aí?" }),
    ],
    reused: false,
  },
  {
    name: "an answer before the input does not count",
    thread: [new AIMessage({ id: "a0", content: "antes" }), input()],
    reused: true,
  },
  {
    name: "another input's answer does not count",
    thread: [
      input("turn:41"),
      new AIMessage({ id: "a0", content: "resposta" }),
      input(),
    ],
    reused: true,
  },
];

describe("turnInputId", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const id = turnInputId(KEY, c.thread);
      if (c.reused) expect(id).toBe(KEY);
      else expect(id).not.toBe(KEY);
    });
  }

  test("without a key every attempt gets a fresh id", () => {
    const a = turnInputId(null, []);
    const b = turnInputId(null, []);
    expect(a).not.toBe(b);
  });
});
