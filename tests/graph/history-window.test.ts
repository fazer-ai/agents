import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { selectHistoryWindow } from "@/graph/history-window";

// Decision table for the history ceiling. The counter is synthetic on purpose: what is under test
// is the RULE (where the window opens and what it is never allowed to drop), not the tokenizer,
// which has its own test. Every message costs 10, so a budget reads as "how many messages fit".
const EACH = 10;
const count = () => EACH;

// h=human, a=assistant, A=assistant WITH tool calls, t=tool result. Index in the string is the
// index in the history, which is what the expectations below refer to.
function build(shape: string): BaseMessage[] {
  return [...shape].map((c, i) => {
    if (c === "h") return new HumanMessage(`h${i}`);
    if (c === "t")
      return new ToolMessage({ content: `t${i}`, tool_call_id: `c${i}` });
    if (c === "A") {
      return new AIMessage({
        content: "",
        tool_calls: [{ name: "x", args: {}, id: `c${i + 1}` }],
      });
    }
    return new AIMessage(`a${i}`);
  });
}

describe("selectHistoryWindow", () => {
  // "hahAtahAta": h0 a1 h2 A3 t4 a5 h6 A7 t8 a9 — two attendances, each with a tool loop.
  const SHAPE = "hahAtahAta";
  const LAST_HUMAN = 6;

  const cases: {
    name: string;
    shape?: string;
    max: number | null;
    dropped: number;
  }[] = [
    {
      name: "no ceiling configured: the whole thread travels",
      max: null,
      dropped: 0,
    },
    {
      name: "everything fits: nothing is dropped",
      max: 10 * SHAPE.length,
      dropped: 0,
    },
    {
      name: "budget forces a cut and the window opens on a human message",
      max: 45,
      dropped: LAST_HUMAN,
    },
    {
      name: "candidate start lands on a tool result, so it advances to the next human",
      max: 65,
      dropped: LAST_HUMAN,
    },
    {
      name: "candidate start lands mid tool loop, so it advances to the next human",
      max: 75,
      dropped: LAST_HUMAN,
    },
    {
      name: "the turn being answered does not fit, and travels anyway",
      max: 35,
      dropped: LAST_HUMAN,
    },
    {
      name: "no human message anywhere: no safe boundary, so nothing is dropped",
      shape: "ata",
      max: 10,
      dropped: 0,
    },
    {
      name: "history begins on a non-human message but fits: still untouched",
      shape: "aha",
      max: 100,
      dropped: 0,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const history = build(c.shape ?? SHAPE);
      const window = selectHistoryWindow(history, c.max, count);
      expect(window.dropped).toBe(c.dropped);
      expect(window.kept.length).toBe(history.length - c.dropped);
      // Whatever the budget said, a trimmed window always opens on a human message.
      if (c.dropped > 0) expect(window.kept[0]?.getType()).toBe("human");
    });
  }

  test("a window that had to overshoot reports the size it actually sent", () => {
    const history = build(SHAPE);
    // 35 fits three messages; the floor keeps four (h6 a7 t8 a9), so the report must say 40.
    const window = selectHistoryWindow(history, 35, count);
    expect(window.tokens).toBe(40);
    expect(window.tokens).toBeGreaterThan(35);
  });

  test("the last human message and everything after it are never dropped", () => {
    const history = build(SHAPE);
    for (const max of [20, 35, 45, 65, 75, 95]) {
      const kept = selectHistoryWindow(history, max, count).kept;
      expect(kept.length).toBeGreaterThanOrEqual(history.length - LAST_HUMAN);
      expect(kept).toContain(history[LAST_HUMAN] as BaseMessage);
      expect(kept.at(-1)).toBe(history.at(-1) as BaseMessage);
    }
  });

  test("counts each message once instead of re-counting the whole prefix", () => {
    const history = build(SHAPE);
    const seen = new Map<BaseMessage, number>();
    selectHistoryWindow(history, 45, (m) => {
      seen.set(m, (seen.get(m) ?? 0) + 1);
      return EACH;
    });
    // The O(n^2) shape this replaced re-counted the surviving prefix on every step.
    for (const [, times] of seen) expect(times).toBe(1);
  });
});
