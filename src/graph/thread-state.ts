import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

// A minimal graph whose ONLY purpose is reading and writing a thread's message channel without a
// model: `getState` to see what the thread holds, `updateState` to append to it (ingestion) or to
// replace it (memory compaction).
//
// The channel schema is identical to the real agent graph (both MessagesAnnotation), so the same
// checkpointer thread interoperates: what is written here is visible to the next real turn, and what
// a turn wrote is visible here. `asNode` makes the update self-contained, so it does not depend on
// the node that wrote the prior checkpoint (which belongs to the real graph's topology).
export const THREAD_STATE_NODE = "noop";

export function buildThreadStateGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(MessagesAnnotation)
    .addNode(THREAD_STATE_NODE, () => ({}))
    .addEdge(START, THREAD_STATE_NODE)
    .addEdge(THREAD_STATE_NODE, END)
    .compile({ checkpointer });
}
