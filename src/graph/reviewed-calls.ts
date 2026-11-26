import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { MessagesAnnotation } from "@langchain/langgraph";

// The turn review's veto at the tool boundary: each write call of the step is judged before it runs,
// in the order the model wrote them, and a call the reviewer flags is answered with the reviewer's
// note instead of running, so the model reads why and the turn goes on. Reads always run. A call
// that already has an answer anywhere in the state is left alone: `ToolNode` skips it, and answering
// it again would hide a repeated batch from the stall check (`repeatsAnsweredCalls`).
export async function setAsideReviewedCalls(
  state: typeof MessagesAnnotation.State,
  isWrite: (name: string) => boolean,
  review: (
    turn: typeof MessagesAnnotation.State.messages,
    call: { name: string; args: unknown },
  ) => Promise<string | null>,
): Promise<{
  view: typeof MessagesAnnotation.State;
  answers: ToolMessage[];
} | null> {
  const last = state.messages.at(-1);
  if (last?.getType() !== "ai") return null;
  const ai = last as AIMessage;
  const calls = ai.tool_calls ?? [];
  const answered = new Set(
    state.messages
      .filter((m) => m.getType() === "tool")
      .map((m) => (m as ToolMessage).tool_call_id),
  );
  const setAside: { call: ToolCall; note: string }[] = [];
  for (const c of calls) {
    if (!isWrite(c.name) || (c.id && answered.has(c.id))) continue;
    const note = await review(state.messages, { name: c.name, args: c.args });
    if (note) setAside.push({ call: c, note });
  }
  if (setAside.length === 0) return null;
  const aside = new Set(setAside.map((s) => s.call));
  const view = new AIMessage({
    content: ai.content,
    id: ai.id,
    tool_calls: calls.filter((c) => !aside.has(c)),
  });
  return {
    view: {
      ...state,
      messages: [...state.messages.filter((m) => m !== last), view],
    },
    answers: setAside.map(
      ({ call, note }) =>
        new ToolMessage({
          content: note,
          tool_call_id: call.id ?? "",
          name: call.name,
          status: "error",
        }),
    ),
  };
}
