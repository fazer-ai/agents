import type { AIMessage, BaseMessage } from "@langchain/core/messages";

// The id a turn's input is written under. Every attempt of one run (a reactive turn answering one
// Chatwoot message, one step of a scheduled nudge) names the same key, so the reducer replaces the
// copy a failed attempt left in place instead of appending another. The key is reused only while
// everything after that copy is the failed attempt's own tool progress: a later human input (the
// customer, another directive) or a finished answer means another turn ran since, and replacing the
// input would move it behind that turn. Without a key the id is fresh, as before. See docs/graph.md,
// "What a failed attempt leaves in the thread".
export function turnInputId(
  key: string | null,
  thread: readonly BaseMessage[],
  // Whether the message holding the key is still the kind of input this run writes. Compaction hands
  // a consumed input's id to the memory head, and replacing that would erase the summary.
  isSameInput: (m: BaseMessage) => boolean,
): string {
  if (key === null) return crypto.randomUUID();
  const at = thread.findIndex((m) => m.id === key);
  if (at === -1) return key;
  if (!isSameInput(thread[at] as BaseMessage)) return crypto.randomUUID();
  const onlyProgress = thread.every(
    (m, i) =>
      i <= at ||
      m.getType() === "tool" ||
      (m.getType() === "ai" && ((m as AIMessage).tool_calls?.length ?? 0) > 0),
  );
  return onlyProgress ? key : crypto.randomUUID();
}
