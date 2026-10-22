import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { MessagesAnnotation } from "@langchain/langgraph";
import { HANDOFF_TOOL_NAME } from "./tools/catalog";

// A batch that both closes the conversation and hands it to a person asks for two outcomes that
// cannot both happen, and the close is the one the model meant: a handoff beside
// `resolve_conversation` is a call the model weighed and emitted anyway, often with an empty
// message and a reason like "Not applicable". Run, it opens the conversation, drops the close and
// the reply, and leaves a customer who said "no, thanks" in a human's queue. So the handoff is
// answered without running, and the rest of the batch runs as written. A handoff in a batch of its
// own is untouched, and so is one in a later round of the same turn.

const RESOLVE_TOOL_NAME = "resolve_conversation";

export const CONTRADICTED_HANDOFF_RESULT =
  "Not transferred: this same step also closes the conversation (resolve_conversation), and a conversation cannot be closed and handed to a person at once. The close stands and nothing was sent to the team. Write your reply to the customer now.";

export function contradictedHandoffs(calls: readonly ToolCall[]): ToolCall[] {
  if (!calls.some((c) => c.name === RESOLVE_TOOL_NAME)) return [];
  return calls.filter((c) => c.name === HANDOFF_TOOL_NAME);
}

// What the tool node runs instead of the state it was given: the last assistant turn without the
// handoffs, and their answers, to put next to the results of the calls that ran. Null when the batch
// carries no contradiction, or when every handoff in it already has an answer: `ToolNode` skips a
// call whose id has one anywhere in the state, and answering it again would hide a repeated batch
// from the stall check (`repeatsAnsweredCalls`).
export function setAsideContradictedHandoffs(
  state: typeof MessagesAnnotation.State,
): {
  view: typeof MessagesAnnotation.State;
  answers: ToolMessage[];
} | null {
  const last = state.messages.at(-1);
  if (last?.getType() !== "ai") return null;
  const ai = last as AIMessage;
  const calls = ai.tool_calls ?? [];
  const setAside = contradictedHandoffs(calls);
  const answered = new Set(
    state.messages
      .filter((m) => m.getType() === "tool")
      .map((m) => (m as ToolMessage).tool_call_id),
  );
  const unanswered = setAside.filter((c) => !c.id || !answered.has(c.id));
  if (unanswered.length === 0) return null;
  const view = new AIMessage({
    content: ai.content,
    id: ai.id,
    tool_calls: calls.filter((c) => !setAside.includes(c)),
  });
  return {
    view: {
      ...state,
      messages: [...state.messages.filter((m) => m !== last), view],
    },
    answers: unanswered.map(
      (c) =>
        new ToolMessage({
          content: CONTRADICTED_HANDOFF_RESULT,
          tool_call_id: c.id ?? "",
          name: c.name,
          status: "error",
        }),
    ),
  };
}
