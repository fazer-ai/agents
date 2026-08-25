import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { nudgeMessage } from "@/graph/markers";
import { planTurnRollback, type RollbackPlan } from "@/graph/refused-turn";

// The decision, as a table. `undoRefusedTurn` does the reading and the writing; everything that is a
// JUDGEMENT is here, because the write is a checkpointer round trip and a rule proven through one
// tells you the wiring works, not what the rule is.
//
// The question in every row: this invoke produced these messages and the channel currently holds
// these ids. Which of them may be taken back out? Issue #251.

function h(id: string, text: string): BaseMessage {
  return new HumanMessage({ id, content: text });
}
function a(id: string, text: string): BaseMessage {
  return new AIMessage({ id, content: text });
}
function calling(id: string, name: string): BaseMessage {
  return new AIMessage({
    id,
    content: "",
    tool_calls: [{ id: `${id}-c`, name, args: {} }],
  });
}
function toolResult(id: string, text: string): BaseMessage {
  return new ToolMessage({ id, content: text, tool_call_id: `${id}-c` });
}
function nudge(id: string): BaseMessage {
  const m = nudgeMessage("An external system event just occurred…", 900);
  m.id = id;
  return m;
}
const allOf = (...ms: BaseMessage[]) => new Set(ms.map((m) => m.id as string));

describe("planTurnRollback", () => {
  const ROWS: Array<{
    name: string;
    produced: BaseMessage[];
    present: ReadonlySet<string>;
    expected: RollbackPlan;
  }> = [
    (() => {
      const hist = [h("h1", "oi"), a("a1", "olá")];
      return {
        name: "a thread with no nudge in it has no proactive turn to take back",
        produced: hist,
        present: allOf(...hist),
        expected: { action: "keep", reason: "no-turn-found" },
      };
    })(),
    (() => {
      const produced = [
        h("h1", "oi"),
        a("a1", "olá"),
        nudge("n1"),
        a("a2", "ainda precisa?"),
      ];
      return {
        name: "the directive and the answer it produced, and nothing that came before them",
        produced,
        present: allOf(...produced),
        expected: { action: "remove", ids: ["n1", "a2"] },
      };
    })(),
    (() => {
      // The transfer is the case that forces the rule: the tool handed the conversation to the human
      // queue from inside the graph, and no removal here can undo that.
      const produced = [
        nudge("n1"),
        calling("a1", "transfer_to_human"),
        toolResult("t1", "ok"),
        a("a2", "Vou te transferir."),
      ];
      return {
        name: "a turn that ran a tool keeps its history, because the act it records really happened",
        produced,
        present: allOf(...produced),
        expected: { action: "keep", reason: "tool-ran" },
      };
    })(),
    (() => {
      // A tool result with no matching call in the slice is the same answer: something ran.
      const produced = [nudge("n1"), toolResult("t1", "ok"), a("a1", "pronto")];
      return {
        name: "a bare tool result answers the same question the same way",
        produced,
        present: allOf(...produced),
        expected: { action: "keep", reason: "tool-ran" },
      };
    })(),
    (() => {
      // Two nudges on one thread: the earlier one ended silent and belongs to a turn nobody refused.
      const produced = [
        nudge("n1"),
        a("a1", "[[SKIP]]"),
        h("h1", "oi"),
        nudge("n2"),
        a("a2", "ainda precisa?"),
      ];
      return {
        name: "only the LAST directive's turn, never an earlier nudge that already stood",
        produced,
        present: allOf(...produced),
        expected: { action: "remove", ids: ["n2", "a2"] },
      };
    })(),
    (() => {
      const produced = [nudge("n1"), a("a1", "ainda precisa?")];
      return {
        name: "a channel another writer already rewrote is left exactly as it is",
        produced,
        present: new Set<string>(),
        expected: { action: "keep", reason: "already-gone" },
      };
    })(),
    (() => {
      // The reducer THROWS on an id it cannot find, so a partially-surviving slice names only what
      // survived. Half a rollback beats a thrown job on a refusal that already suppressed the send.
      const produced = [nudge("n1"), a("a1", "ainda precisa?")];
      return {
        name: "half the turn still there names half the turn",
        produced,
        present: new Set(["a1"]),
        expected: { action: "remove", ids: ["a1"] },
      };
    })(),
    (() => {
      // A message the reducer has not stamped yet has no id to name, and naming `undefined` is how a
      // rollback becomes a throw.
      const produced = [nudge("n1"), new AIMessage({ content: "sem id" })];
      return {
        name: "a message with no id is not nameable, so it is not named",
        produced,
        present: new Set(["n1"]),
        expected: { action: "remove", ids: ["n1"] },
      };
    })(),
  ];

  for (const row of ROWS) {
    test(row.name, () => {
      expect(planTurnRollback(row.produced, row.present)).toEqual(row.expected);
    });
  }
});
