import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  calledOffToolResult,
  memoryHeadMessage,
  nudgeMessage,
} from "@/graph/markers";
import {
  planReactiveTurnRollback,
  planTurnRollback,
  type RollbackPlan,
} from "@/graph/refused-turn";
import { SKIP_REPLY_TOOL } from "@/graph/silence";

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
function toolResult(
  id: string,
  text: string,
  // The tool NAME, which the rollback planner reads to tell an inert `skip_reply` from a real act.
  name?: string,
): BaseMessage {
  return new ToolMessage({
    id,
    content: text,
    tool_call_id: `${id}-c`,
    ...(name ? { name } : {}),
  });
}
// The graph's own refusal, carrying the marker that says the call never ran (issue #449). Built
// through the production helper on purpose: a hand-rolled copy would keep passing if the marker
// moved.
function refused(id: string, name: string, callId: string): BaseMessage {
  const m = calledOffToolResult({ id: callId, name });
  m.id = id;
  return m;
}
function nudge(id: string): BaseMessage {
  const m = nudgeMessage("An external system event just occurred…", 900);
  m.id = id;
  return m;
}
const head = (id: string): BaseMessage =>
  memoryHeadMessage("<atendimentos-anteriores>…</atendimentos-anteriores>", id);

describe("planTurnRollback", () => {
  const ROWS: Array<{
    name: string;
    produced: BaseMessage[];
    current: BaseMessage[];
    inert?: ReadonlySet<string>;
    expected: RollbackPlan;
  }> = [
    (() => {
      const hist = [h("h1", "oi"), a("a1", "olá")];
      return {
        name: "a thread with no nudge in it has no proactive turn to take back",
        produced: hist,
        current: hist,
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
        current: produced,
        expected: { action: "remove", ids: ["n1", "a2"] },
      };
    })(),
    (() => {
      // Issue #454, review round 7. `skip_reply` is the one tool that acts on NOTHING — it IS the
      // decision to stay quiet, and since this change it is how a follow-up says so. Counting it as
      // an act pinned the directive and its tool result in shared memory after a `/reset`, a
      // takeover, or any post-generation refusal: the residue this planner exists to clear, reached
      // through the silence protocol itself.
      const produced = [
        nudge("n1"),
        calling("a1", "skip_reply"),
        toolResult("t1", "Produce no message now.", "skip_reply"),
        a("a2", ""),
      ];
      return {
        name: "a turn whose only tool was skip_reply acted on nothing, so it can still be taken back",
        produced,
        current: produced,
        inert: new Set([SKIP_REPLY_TOOL]),
        expected: { action: "remove", ids: ["n1", "a1", "t1", "a2"] },
      };
    })(),
    (() => {
      // ...and the exemption is for that tool ALONE: paired with a real one, the act happened.
      const produced = [
        nudge("n1"),
        calling("a1", "skip_reply"),
        toolResult("t1", "ok", "skip_reply"),
        calling("a2", "assign_label"),
        toolResult("t2", "ok", "assign_label"),
        a("a3", ""),
      ];
      return {
        name: "skip_reply next to a real tool still keeps the history",
        produced,
        current: produced,
        inert: new Set([SKIP_REPLY_TOOL]),
        expected: { action: "keep", reason: "tool-ran" },
      };
    })(),
    (() => {
      // The TOOL RESULT on its own, because the AI message that requested it can be trimmed out of a
      // slice and would otherwise carry the verdict alone — a mutation restoring the by-name check on
      // that branch survived a table where every row had both.
      const produced = [nudge("n1"), toolResult("t1", "ok", "skip_reply")];
      return {
        name: "a lone inert tool result does not pin the turn",
        produced,
        current: produced,
        inert: new Set([SKIP_REPLY_TOOL]),
        expected: { action: "remove", ids: ["n1", "t1"] },
      };
    })(),
    (() => {
      const produced = [nudge("n1"), toolResult("t1", "ok", "skip_reply")];
      return {
        name: "...and the same lone result pins it when nothing was inert",
        produced,
        current: produced,
        inert: new Set<string>(),
        expected: { action: "keep", reason: "tool-ran" },
      };
    })(),
    (() => {
      // Review round 8. A NAME is not an identity: `toolDefinitionCreateSchema` reserves none of the
      // native names, so an agent with native tools disabled can grant a custom HTTP tool called
      // `skip_reply` that really calls something. The caller names what was inert; here nothing was,
      // and the turn is kept even though the messages look identical to the case above.
      const produced = [
        nudge("n1"),
        calling("a1", "skip_reply"),
        toolResult("t1", "ok", "skip_reply"),
        a("a2", ""),
      ];
      return {
        name: "a CUSTOM tool that borrowed the name is not inert, and keeps the history",
        produced,
        current: produced,
        inert: new Set<string>(),
        expected: { action: "keep", reason: "tool-ran" },
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
        current: produced,
        expected: { action: "keep", reason: "tool-ran" },
      };
    })(),
    (() => {
      // A tool result with no matching call in the slice is the same answer: something ran.
      const produced = [nudge("n1"), toolResult("t1", "ok"), a("a1", "pronto")];
      return {
        name: "a bare tool result answers the same question the same way",
        produced,
        current: produced,
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
        current: produced,
        expected: { action: "remove", ids: ["n2", "a2"] },
      };
    })(),
    (() => {
      const produced = [nudge("n1"), a("a1", "ainda precisa?")];
      return {
        name: "a channel another writer already rewrote is left exactly as it is",
        produced,
        current: [],
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
        current: [produced[1] as BaseMessage],
        expected: { action: "remove", ids: ["a1"] },
      };
    })(),
    (() => {
      // The sharp one. Memory compaction REUSES the id of the first message it replaces for the
      // rendered head, so a compaction landing between the invoke and this plan hands the refused
      // directive's id to the head of an entire attendance. Removing by id alone would delete it.
      const produced = [nudge("n1"), a("a1", "ainda precisa?")];
      return {
        name: "an id that memory compaction reused for its head is not the message we produced",
        produced,
        current: [head("n1")],
        expected: { action: "keep", reason: "already-gone" } as RollbackPlan,
      };
    })(),
    (() => {
      // …and the half that IS still ours survives that same rewrite.
      const produced = [nudge("n1"), a("a1", "ainda precisa?")];
      return {
        name: "the reply survives a rewrite that only took the directive's id",
        produced,
        current: [head("n1"), produced[1] as BaseMessage],
        expected: { action: "remove", ids: ["a1"] } as RollbackPlan,
      };
    })(),
    (() => {
      // A message the reducer has not stamped yet has no id to name, and naming `undefined` is how a
      // rollback becomes a throw.
      const produced = [nudge("n1"), new AIMessage({ content: "sem id" })];
      return {
        name: "a message with no id is not nameable, so it is not named",
        produced,
        current: [produced[0] as BaseMessage],
        expected: { action: "remove", ids: ["n1"] },
      };
    })(),
    (() => {
      // ISSUE #449. The graph's tool boundary refused the call, so nothing reached the world and the
      // turn is as removable as a silent one. The tool's NAME says nothing here — it is whatever the
      // operator granted — and neither does the content, which any tool may return. What answers is
      // the marker the graph writes on its own refusal.
      const produced = [
        nudge("n1"),
        calling("a1", "assign_label"),
        refused("t1", "assign_label", "a1-c"),
        a("a2", ""),
      ];
      return {
        name: "a call the tool boundary refused never acted, so the turn comes back out",
        produced,
        current: produced,
        expected: { action: "remove", ids: ["n1", "a1", "t1", "a2"] },
      };
    })(),
    (() => {
      // REVIEW ROUND 3. A provider may emit a call with no id — LangChain types it optional — and the
      // refusal then carries `""`, which matches no call. Pairing by id read the wrong axis: the
      // boundary refuses a BATCH, so what answers is the position, and this row is what says so.
      const produced = [
        nudge("n1"),
        new AIMessage({
          id: "a1",
          content: "",
          tool_calls: [{ name: "assign_label", args: {} }],
        }),
        refused("t1", "assign_label", ""),
        a("a2", ""),
      ];
      return {
        name: "a refused call with no id is still a call that never ran",
        produced,
        current: produced,
        expected: { action: "remove", ids: ["n1", "a1", "t1", "a2"] },
      };
    })(),
    (() => {
      // ONLY OUR OWN REFUSAL makes a calling turn inert, and the mutation battery is what asked for
      // this row: reading the position without reading the MARKER survived every other case, because
      // a real tool result is caught on its own line. It is not caught here — a calling turn whose
      // result is simply absent is a call that may well have gone out, and the conservative answer
      // for a write nothing can undo is to keep the slice.
      const produced = [
        nudge("n1"),
        calling("a1", "assign_label"),
        a("a2", ""),
      ];
      return {
        name: "a calling turn followed by anything else is still a turn that may have acted",
        produced,
        current: produced,
        expected: { action: "keep", reason: "tool-ran" } as RollbackPlan,
      };
    })(),
    (() => {
      // The pairing, and the reason the answer is not "the slice contains a refusal". One hop RAN
      // before the turn was called off, and that write is in the world: the slice stays whole.
      const produced = [
        nudge("n1"),
        calling("a1", "assign_label"),
        toolResult("t1", "Label applied.", "assign_label"),
        calling("a2", "set_custom_attribute"),
        refused("t2", "set_custom_attribute", "a2-c"),
        a("a3", ""),
      ];
      return {
        name: "a turn refused on its SECOND hop keeps the tool that already ran",
        produced,
        current: produced,
        expected: { action: "keep", reason: "tool-ran" } as RollbackPlan,
      };
    })(),
  ];

  for (const row of ROWS) {
    test(row.name, () => {
      expect(
        planTurnRollback(row.produced, row.current, row.inert ?? new Set()),
      ).toEqual(row.expected);
    });
  }
});

// The same question asked of a REACTIVE turn, and the answer is a different shape (issue #315).
//
// Two things separate it from the proactive table above, and both come from one fact: the `[human]`
// message here is the CUSTOMER'S OWN. The proactive planner removes the directive together with the
// answer because this process wrote the directive; removing the customer's message would lose it,
// and on `superseded` it is exactly the message the re-armed flush exists to answer.
//
// So the removable part is named directly instead of by a boundary: the trailing run of assistant
// messages that neither called a tool nor are a tool result. That is the text the customer never saw,
// it stops at the first message that is anything else, and it can never reach a HumanMessage of any
// kind — the customer's, a divider, a memory head, a nudge, or an attendant's.
//
// It also gives the tool case a better answer than the proactive one could have. There, a turn that
// ran a tool keeps EVERYTHING, because the directive and the act are one slice. Here the act stays
// (the tool call and its result are outside the trailing run) and only the unsent sentence goes.
describe("planReactiveTurnRollback", () => {
  const ROWS: Array<{
    name: string;
    produced: BaseMessage[];
    current: BaseMessage[];
    inert?: ReadonlySet<string>;
    expected: RollbackPlan;
  }> = [
    (() => {
      const produced = [h("h1", "oi"), a("a1", "Olá! Como posso ajudar?")];
      return {
        name: "the reply the customer never received, and not the message that asked for it",
        produced,
        current: produced,
        expected: { action: "remove", ids: ["a1"] },
      };
    })(),
    (() => {
      const produced = [
        h("h0", "bom dia"),
        a("a0", "bom dia!"),
        h("h1", "oi"),
        a("a1", "Olá! Como posso ajudar?"),
      ];
      return {
        name: "nothing from a turn that already stood",
        produced,
        current: produced,
        expected: { action: "remove", ids: ["a1"] },
      };
    })(),
    (() => {
      // The row the proactive table answers the other way. The transfer really happened and no
      // removal undoes it, so its record stays — but the closing line was never sent, and keeping it
      // is the whole defect.
      const produced = [
        h("h1", "quero falar com alguém"),
        calling("a1", "transfer_to_human"),
        toolResult("t1", "ok"),
        a("a2", "Vou te transferir."),
      ];
      return {
        name: "a turn that ran a tool keeps the act and loses only the sentence nobody read",
        produced,
        current: produced,
        expected: { action: "remove", ids: ["a2"] },
      };
    })(),
    (() => {
      const produced = [
        h("h1", "quero falar com alguém"),
        calling("a1", "transfer_to_human"),
        toolResult("t1", "ok"),
      ];
      return {
        name: "a turn that ended on the tool said nothing, so there is nothing to take back",
        produced,
        current: produced,
        expected: { action: "keep", reason: "no-turn-found" },
      };
    })(),
    (() => {
      // The other half of "and nothing else", and the row without which that clause is untested: a
      // turn whose LAST message is a request to act. Nothing was said to the customer, and a tool
      // call is the module's own evidence of acting (`actedOnTheWorld` reads the same two things),
      // so it is not part of the run either.
      const produced = [
        h("h1", "quero agendar"),
        calling("a1", "create_appointment"),
      ];
      return {
        name: "a turn that ended asking to act said nothing, so nothing comes out",
        produced,
        current: produced,
        expected: { action: "keep", reason: "no-turn-found" },
      };
    })(),
    (() => {
      // A split reply is several assistant messages in a row, and none of them was sent.
      const produced = [
        h("h1", "oi"),
        a("a1", "Olá!"),
        a("a2", "Como posso ajudar?"),
      ];
      return {
        name: "every message of a split reply, because the send was suppressed once for all of them",
        produced,
        current: produced,
        expected: { action: "remove", ids: ["a1", "a2"] },
      };
    })(),
    (() => {
      // The wall this rule depends on is a message that is not an assistant's. A channel that is
      // nothing but assistant messages is not one this invoke produced, and guessing where the turn
      // starts there is how a rollback eats history.
      const produced = [a("a1", "Olá!")];
      return {
        name: "a channel with no turn boundary in it is left alone",
        produced,
        current: produced,
        expected: { action: "keep", reason: "no-turn-found" },
      };
    })(),
    (() => {
      const produced = [h("h1", "oi"), a("a1", "Olá!")];
      return {
        name: "a channel another writer already rewrote is left exactly as it is",
        produced,
        current: [],
        expected: { action: "keep", reason: "already-gone" },
      };
    })(),
    (() => {
      // Same compaction hazard as the proactive table: an id can survive while the message it named
      // does not.
      const produced = [h("h1", "oi"), a("a1", "Olá!")];
      return {
        name: "an id that memory compaction reused for its head is not the message we produced",
        produced,
        current: [head("a1")],
        expected: { action: "keep", reason: "already-gone" },
      };
    })(),
    (() => {
      const produced = [h("h1", "oi"), new AIMessage({ content: "sem id" })];
      return {
        name: "a message with no id is not nameable, so it is not named",
        produced,
        current: [produced[0] as BaseMessage],
        expected: { action: "keep", reason: "already-gone" },
      };
    })(),
    (() => {
      // A nudge directive is a HumanMessage, so it walls this rule the same way the customer's does.
      // The two planners are different questions and this is where that shows: the proactive one
      // takes the directive with the answer, this one never could.
      const produced = [nudge("n1"), a("a1", "ainda precisa?")];
      return {
        name: "a nudge directive walls the run like any other human message",
        produced,
        current: produced,
        expected: { action: "remove", ids: ["a1"] },
      };
    })(),
  ];

  for (const row of ROWS) {
    test(row.name, () => {
      expect(planReactiveTurnRollback(row.produced, row.current)).toEqual(
        row.expected,
      );
    });
  }
});
