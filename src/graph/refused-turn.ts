import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { RemoveMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { withKeyedQueue } from "@/lib/locks";
import {
  clearTurnInFlight,
  isTurnInFlight,
  markTurnInFlight,
} from "./inflight";
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
  | {
      action: "keep";
      reason:
        | "no-turn-found"
        | "tool-ran"
        | "already-gone"
        | "another-invoke-is-reading";
    };

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

// AN ID IS NOT AN IDENTITY ON THIS CHANNEL, and memory compaction is why. Its rewrite REUSES the id
// of the first message it replaces for the rendered memory head, deliberately, because the reducer
// replaces a same-id message in place and appends an unknown-id one at the end, and a memory head
// sitting after the conversation is a footnote rather than a header (docs/graph.md). A compaction
// that lands between the invoke and this plan can therefore hand the refused directive's id to the
// head of an entire attendance, and a removal that only asked "is the id still there?" would delete
// that head. Losing a summary is worse than the residue this exists to clear, so the current message
// has to still BE the one this invoke produced, not merely occupy its id.
function isStillTheSameMessage(
  current: BaseMessage,
  produced: BaseMessage,
): boolean {
  if (current.getType() !== produced.getType()) return false;
  const text = (m: BaseMessage) =>
    typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  return text(current) === text(produced);
}

// `produced` is THIS invoke's own view of the channel (what `graph.invoke` returned), and `current`
// is what the channel holds when the removal is about to be written. They are read at different
// moments on purpose: between them sit the ownership probe and the guardrail judge, which are model
// calls and Chatwoot round trips, and anything can have rewritten the thread in that time. The
// reducer THROWS on a `RemoveMessage` whose id it cannot find ("Attempting to delete a message with
// an ID that doesn't exist"), so a message that left has to be dropped from the plan rather than
// named in it.
export function planTurnRollback(
  produced: readonly BaseMessage[],
  current: readonly BaseMessage[],
): RollbackPlan {
  // NOTE: the LAST one, not the first: the thread can already carry the directive of an earlier nudge that
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
  return nameWhatSurvived(slice, current);
}

// The last step of both plans, and the only one that reads the CURRENT channel: a slice is a
// proposal, and this is what turns it into ids the reducer will accept.
function nameWhatSurvived(
  slice: readonly BaseMessage[],
  current: readonly BaseMessage[],
): RollbackPlan {
  const byId = new Map<string, BaseMessage>();
  for (const m of current) if (typeof m.id === "string") byId.set(m.id, m);
  const ids = slice
    .filter((m) => {
      if (typeof m.id !== "string") return false;
      const now = byId.get(m.id);
      return now !== undefined && isStillTheSameMessage(now, m);
    })
    .map((m) => m.id as string);
  if (ids.length === 0) return { action: "keep", reason: "already-gone" };
  return { action: "remove", ids };
}

// WHAT A REACTIVE TURN LEAVES BEHIND, which is the same residue and NOT the same slice (issue #315).
//
// `runLoadedTurn` appends the customer's own message and then invokes, so the pair in the channel is
// [their message][our answer] — and every refusal below the invoke suppresses only the second half.
// The proactive plan above removes the directive together with the answer because this process wrote
// the directive; doing that here would delete the customer's message, and on `superseded` it is
// precisely the message the re-armed flush exists to answer.
//
// So the removable part is named directly rather than by a boundary: the trailing run of assistant
// messages that neither called a tool nor are a tool result. It stops at the first message that is
// anything else, which means it can never reach a HumanMessage of any kind — the customer's, a
// divider, a memory head, a nudge, or an attendant's — and it needs no rule about where a turn
// "starts".
//
// That also answers the tool case better than the proactive plan could. There, the directive and the
// act are one slice, so any tool call keeps everything. Here the act sits OUTSIDE the trailing run by
// construction: the tool call and its result stay, and only the sentence nobody read comes out. A
// transfer that really happened keeps its record, and the closing line the customer never saw does
// not go on to be read as something they were told.
function saidSomethingAndNothingElse(m: BaseMessage): boolean {
  return (
    m.getType() === "ai" && ((m as AIMessage).tool_calls?.length ?? 0) === 0
  );
}

export function planReactiveTurnRollback(
  produced: readonly BaseMessage[],
  current: readonly BaseMessage[],
): RollbackPlan {
  let start = produced.length;
  while (start > 0) {
    const m = produced[start - 1];
    if (m === undefined || !saidSomethingAndNothingElse(m)) break;
    start--;
  }
  // Nothing trailing (the turn ended on a tool, so it said nothing), or nothing but assistant
  // messages, which is not a channel this invoke produced — the wall this rule leans on is missing,
  // and guessing where the turn began is how a rollback eats history.
  if (start === produced.length || start === 0) {
    return { action: "keep", reason: "no-turn-found" };
  }
  return nameWhatSurvived(produced.slice(start), current);
}

// Reads the channel and writes the removal under the SAME key the append and the compaction rewrite
// take (`ingest:<graphThreadId>`), so the read and the write are one step as far as those two are
// concerned.
//
// THE QUEUE IS NOT ENOUGH, AND THE COUNT IS WHY. A turn takes that key to mark itself and RELEASES
// it before the model runs, so an invoke in flight is not holding anything this could queue behind.
// What it is holding is a claim in `src/graph/inflight.ts`, and the hazard that registry exists for
// is exactly this one: an invoke is a read-modify-write of the WHOLE channel, so one that loaded the
// refused turn will save it back the moment it finishes, undoing a removal written underneath it.
//
// Memory compaction answers this by reading the count before adding its own claim and standing down
// (`isTurnInFlight` -> "busy"), and so does this. The difference is what standing down costs: a
// deferred compaction runs again at the next attendance boundary, and a deferred rollback has no
// later, so the refused turn stays in the history. That is the honest outcome rather than a better
// one: writing a removal that another invoke is about to undo leaves the same history and a
// checkpoint that says otherwise. It is named and logged so the case is visible instead of silent.
//
// The nudge's own claim is already released by the time any refusal reaches here (the `finally` that
// clears it sits above them all), so this never stands down on account of itself.
//
// WHERE THIS STOPS, because the check reads a count rather than holding a gate. It excludes an invoke
// that is ALREADY in flight; it cannot exclude one that starts a moment later, loads the refused turn
// and saves it back when it finishes. The window is widest on the fallback thread, where a
// conversation with no `contactInboxId` makes the graph thread and the conversation thread the same
// key, and `runLoadedTurn` marks that key before it takes any lock. Closing it would mean holding a
// critical section across another invoke, which is the pool inversion #227 removed for issue #225, so
// it is deliberately not attempted. Losing that race costs exactly what happens today with no
// rollback at all: the refused turn stays in the history. The rollback is best-effort against a
// concurrent invoke, and never worse than not having run.
export async function undoRefusedTurn(params: {
  checkpointer: BaseCheckpointSaver;
  graphThreadId: string;
  produced: readonly BaseMessage[];
  // WHICH turn was refused, because the two have different removable slices and neither plan is
  // right for the other: a proactive one wrote its own `[human]` directive and takes it back with the
  // answer, a reactive one is answering the CUSTOMER'S message and must leave it standing. Required
  // rather than defaulted — a caller that has to name it cannot inherit the wrong one by omission.
  kind: "proactive" | "reactive";
}): Promise<RollbackPlan> {
  const { checkpointer, graphThreadId, produced, kind } = params;
  const plan =
    kind === "reactive" ? planReactiveTurnRollback : planTurnRollback;
  const graph = buildThreadStateGraph(checkpointer);
  const threadCfg = { configurable: { thread_id: graphThreadId } };
  return withKeyedQueue(`ingest:${graphThreadId}`, async () => {
    if (isTurnInFlight(graphThreadId)) {
      return { action: "keep", reason: "another-invoke-is-reading" };
    }
    // NOTE: taken only once the answer above is no, and for the length of the read and the write: it
    // is what keeps a compaction from rewriting the channel between them.
    markTurnInFlight(graphThreadId);
    try {
      const current = ((
        (await graph.getState(threadCfg)).values as
          | { messages?: BaseMessage[] }
          | undefined
      )?.messages ?? []) as BaseMessage[];
      const decided = plan(produced, current);
      if (decided.action === "remove") {
        await graph.updateState(
          threadCfg,
          { messages: decided.ids.map((id) => new RemoveMessage({ id })) },
          THREAD_STATE_NODE,
        );
      }
      return decided;
    } finally {
      clearTurnInFlight(graphThreadId);
    }
  });
}
