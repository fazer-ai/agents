import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { RemoveMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { withKeyedQueue } from "@/lib/locks";
import { clearTurnInFlight, markTurnInFlight } from "./inflight";
import { isNudgeTurn } from "./markers";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "./thread-state";

// WHAT A PROACTIVE TURN LEAVES BEHIND WHEN IT IS REFUSED AFTER IT WAS GENERATED.
//
// `runAgentNudge` invokes the graph, and the graph checkpoints as it runs: the nudge directive and
// the assistant's answer are in the thread's history the moment `invoke` returns. Every refusal that
// comes AFTER that point suppresses the send and leaves the pair there: an operator took the
// conversation, a `/reset` retired the job, the agent was switched off mid-turn. The customer never
// received the message, and the NEXT turn reads it as something they did, and answers "as I
// mentioned" about a sentence nobody was shown (issue #251).
//
// Measured before this module existed, against the test database, with the job retired during
// generation:
//
//   OUTCOME: stale   SENT TO CUSTOMER: []
//   channel: [human] An external system event just occurred…   [ai] Oi, ainda precisa de ajuda?
//
// Removing it is the only shape that leaves the history equal to what the customer received. The two
// alternatives were weighed and rejected in the issue: DELIVERING what was generated is wrong in the
// direction that matters (the refusals exist precisely because the conversation stopped being ours to
// write in), and MARKING the turn as undelivered keeps the text in every prompt from here on and
// makes every reader of the history responsible for understanding the mark.
//
// The mechanism is the one memory compaction already uses (src/modules/memory/compact.ts): name the
// ids, never REMOVE_ALL_MESSAGES, so a message that arrived from anywhere else is left alone.

export type RollbackPlan =
  | { action: "remove"; ids: string[] }
  | { action: "keep"; reason: "no-turn-found" | "tool-ran" | "already-gone" };

// A tool call is the line between a turn that only SAID something and one that DID something. The
// transfer is the case that forces it: `handoffAnsweredTheTurn` hands the conversation to the human
// queue from inside the graph, and `runAgentNudge` says so in its own words: "the transfer itself
// still stands: the tool ran inside the graph and this fence was never able to reverse it". Erasing
// the turn would erase the only record of an act that really happened, to the outside world, and no
// removal here can undo. So the question is asked of the whole slice and answered conservatively:
// any tool call at all, and the turn stays.
function actedOnTheWorld(slice: readonly BaseMessage[]): boolean {
  return slice.some(
    (m) =>
      m.getType() === "tool" || ((m as AIMessage).tool_calls?.length ?? 0) > 0,
  );
}

// `produced` is THIS invoke's own view of the channel (what `graph.invoke` returned), and `present`
// is what the channel holds when the removal is about to be written. They are read at different
// moments on purpose: between them sit the ownership probe and the guardrail judge, which are model
// calls and Chatwoot round trips, and anything can have rewritten the thread in that time. The
// reducer THROWS on a `RemoveMessage` whose id it cannot find ("Attempting to delete a message with
// an ID that doesn't exist"), so intersecting is what keeps a rollback from turning a suppressed
// follow-up into a failed job.
export function planTurnRollback(
  produced: readonly BaseMessage[],
  present: ReadonlySet<string>,
): RollbackPlan {
  // The LAST one, not the first: the thread can already carry the directive of an earlier nudge that
  // ended silent, and that one belongs to a turn nobody refused. Everything from here on is what
  // this invoke appended, because the invoke loads the channel and then adds its own to the end.
  let start = -1;
  for (let i = produced.length - 1; i >= 0; i--) {
    const m = produced[i];
    if (m !== undefined && isNudgeTurn(m)) {
      start = i;
      break;
    }
  }
  if (start === -1) return { action: "keep", reason: "no-turn-found" };
  const slice = produced.slice(start);
  if (actedOnTheWorld(slice)) return { action: "keep", reason: "tool-ran" };
  const ids = slice
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && present.has(id));
  if (ids.length === 0) return { action: "keep", reason: "already-gone" };
  return { action: "remove", ids };
}

// Reads the channel and writes the removal under the SAME key the append and the compaction rewrite
// take (`ingest:<graphThreadId>`), so the read and the write are one step as far as those two are
// concerned. The in-flight claim is taken for the length of it as well: compaction stands down on a
// claimed thread, and a rewrite landing between this read and this write would be deciding about a
// channel that is one message away from changing.
export async function undoRefusedTurn(params: {
  checkpointer: BaseCheckpointSaver;
  graphThreadId: string;
  produced: readonly BaseMessage[];
}): Promise<RollbackPlan> {
  const { checkpointer, graphThreadId, produced } = params;
  const graph = buildThreadStateGraph(checkpointer);
  const threadCfg = { configurable: { thread_id: graphThreadId } };
  return withKeyedQueue(`ingest:${graphThreadId}`, async () => {
    markTurnInFlight(graphThreadId);
    try {
      const current = ((
        (await graph.getState(threadCfg)).values as
          | { messages?: BaseMessage[] }
          | undefined
      )?.messages ?? []) as BaseMessage[];
      const plan = planTurnRollback(
        produced,
        new Set(
          current
            .map((m) => m.id)
            .filter((id): id is string => typeof id === "string"),
        ),
      );
      if (plan.action === "remove") {
        await graph.updateState(
          threadCfg,
          { messages: plan.ids.map((id) => new RemoveMessage({ id })) },
          THREAD_STATE_NODE,
        );
      }
      return plan;
    } finally {
      clearTurnInFlight(graphThreadId);
    }
  });
}
