import { AIMessage, type ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { MessagesAnnotation } from "@langchain/langgraph";
import { turnReviewVetoToolResult } from "./markers";

// The turn review's veto at the tool boundary: each write call of the step is judged before it runs,
// in the order the model wrote them, and a call the reviewer flags is answered with the reviewer's
// note instead of running, so the model reads why and the turn goes on. Reads always run. A call
// that already has an answer anywhere in the state is left alone: `ToolNode` skips it, and answering
// it again would hide a repeated batch from the stall check (`repeatsAnsweredCalls`). Each review is
// shown the writes of the same step already admitted (`alongside`): they have no result yet but run
// together with the call, so a policy of one booking sees the first booking of the batch.
export async function setAsideReviewedCalls(
  state: typeof MessagesAnnotation.State,
  isWrite: (name: string) => boolean,
  review: (
    turn: typeof MessagesAnnotation.State.messages,
    call: { name: string; args: unknown; id?: string },
    opts: {
      alongside: { name: string; args: unknown }[];
      index: number;
      // Every call of the step the tools node will consider (`reviewableCalls`), this one included.
      step: readonly ToolCall[];
    },
  ) => Promise<string | null>,
  // Asked between two reviews: a turn superseded or taken over during one stops the batch at once,
  // and "lost" tells the caller to refuse all of it. No later read may run a write left unreviewed.
  turnLost?: () => Promise<boolean>,
  // Asked after each review: a review that held, or a call flagged past the attempts, stops the
  // batch on the spot ("halted"), with no further review, for the caller to refuse it all.
  halted?: () => boolean,
): Promise<
  | {
      view: typeof MessagesAnnotation.State;
      answers: ToolMessage[];
    }
  | "lost"
  | "halted"
  | null
> {
  const last = state.messages.at(-1);
  if (last?.getType() !== "ai") return null;
  const ai = last as AIMessage;
  const calls = ai.tool_calls ?? [];
  const step = reviewableCalls(state, isWrite);
  const eligible = new Set(step);
  const setAside: { call: ToolCall; note: string }[] = [];
  const admitted: { name: string; args: unknown }[] = [];
  let reviewed = 0;
  for (const [index, c] of calls.entries()) {
    if (!eligible.has(c)) continue;
    if (reviewed++ > 0 && (await turnLost?.())) return "lost";
    const note = await review(
      state.messages,
      { name: c.name, args: c.args, ...(c.id ? { id: c.id } : {}) },
      { alongside: [...admitted], index, step },
    );
    if (halted?.()) return "halted";
    if (note) setAside.push({ call: c, note });
    else admitted.push({ name: c.name, args: c.args });
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
    answers: setAside.map(({ call, note }) =>
      turnReviewVetoToolResult(call, note),
    ),
  };
}

// The calls of the last step that go through the review: writes the caller reviews, minus a call
// that already has an answer in the state, which `ToolNode` skips. The one reading of "what this
// step may run" the review and a reviewer's plan of the whole step share.
export function reviewableCalls(
  state: typeof MessagesAnnotation.State,
  isWrite: (name: string) => boolean,
): ToolCall[] {
  const last = state.messages.at(-1);
  if (last?.getType() !== "ai") return [];
  const answered = new Set(
    state.messages
      .filter((m) => m.getType() === "tool")
      .map((m) => (m as ToolMessage).tool_call_id),
  );
  return ((last as AIMessage).tool_calls ?? []).filter(
    (c) => isWrite(c.name) && !(c.id && answered.has(c.id)),
  );
}
