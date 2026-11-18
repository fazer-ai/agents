import { describe, expect, mock, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import * as estimate from "@/lib/token-estimate";

// What the history ceiling's counter asks the estimator, counted at the estimator the graph's counter
// calls, which still answers with the real estimate.
let estimated = 0;
const realEstimate = estimate.estimateTokens;
mock.module("@/lib/token-estimate", () => ({
  ...estimate,
  estimateTokens: (text: string) => {
    estimated++;
    return realEstimate(text);
  },
}));

const { countMessageTokens } = await import("@/graph/token-count");
const { selectHistoryWindow } = await import("@/graph/history-window");

// A thread as a turn loads it: new objects every time, the same texts.
function loadThread(size: number, tag: string): BaseMessage[] {
  return Array.from({ length: size }, (_, i) =>
    i % 2 === 0
      ? new HumanMessage({
          id: `${tag}h${i}`,
          content: `${tag} pergunta ${i} `.repeat(10),
        })
      : new AIMessage({
          id: `${tag}a${i}`,
          content: `${tag} resposta ${i} `.repeat(10),
        }),
  );
}

describe("the history ceiling's estimates per call", () => {
  test("a thread loaded again costs no estimate, at 20 messages or at 500", () => {
    for (const size of [20, 500]) {
      const tag = `t${size}`;
      selectHistoryWindow(loadThread(size, tag), 1_000_000, countMessageTokens);
      estimated = 0;
      selectHistoryWindow(loadThread(size, tag), 1_000_000, countMessageTokens);
      expect(estimated).toBe(0);
    }
  });

  test("a turn that adds two messages estimates those two", () => {
    const thread = loadThread(300, "grow");
    selectHistoryWindow(thread, 1_000_000, countMessageTokens);
    estimated = 0;
    const next = [
      ...loadThread(300, "grow"),
      new HumanMessage({ id: "grow-new-h", content: "e amanhã?" }),
      new AIMessage({ id: "grow-new-a", content: "Amanhã abrimos às 8h." }),
    ];
    const window = selectHistoryWindow(next, 1_000_000, countMessageTokens);
    expect(estimated).toBe(2);
    expect(window.kept).toHaveLength(302);
  });
});
