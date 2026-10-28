import type { AIMessage, BaseMessage } from "@langchain/core/messages";

// The id a turn's input is written under. Every attempt of one run (a reactive turn answering one
// Chatwoot message, a nudge of one scheduled job) names the same key, so the reducer replaces the
// copy a failed attempt left in place instead of appending another. Once the model finished an
// answer after that copy, a further run is a new turn and gets a fresh id: replacing the input would
// leave the invoke ending on the model's own message. Without a key the id is fresh, as before. See
// docs/graph.md, "What a failed attempt leaves in the thread".
export function turnInputId(
  key: string | null,
  thread: readonly BaseMessage[],
): string {
  if (key === null) return crypto.randomUUID();
  const at = thread.findIndex((m) => m.id === key);
  if (at === -1) return key;
  const answered = thread.some(
    (m, i) =>
      i > at &&
      m.getType() === "ai" &&
      ((m as AIMessage).tool_calls?.length ?? 0) === 0,
  );
  return answered ? crypto.randomUUID() : key;
}
