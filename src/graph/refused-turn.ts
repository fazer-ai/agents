import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { RemoveMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { withKeyedQueue } from "@/lib/locks";
import {
  clearTurnInFlight,
  isTurnInFlight,
  markTurnInFlight,
} from "./inflight";
import { isCalledOffToolResult, isNudgeTurn } from "./markers";
import {
  claimIngestWrite,
  type IngestWriteClaim,
  releaseIngestWrite,
  type ThreadOwner,
} from "./thread-claim";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "./thread-state";

// What a proactive turn leaves behind when it is refused after it was generated. The graph
// checkpoints as it runs, so a suppressed send (takeover, `/reset`, agent switched off) leaves the
// directive and the answer in history, and the next turn would say "as I mentioned" about a sentence
// nobody was shown. Removing them is the only shape that matches what the customer received:
// delivering is wrong (the conversation stopped being ours to write in), and marking the turn keeps
// the text in every later prompt. Removal names ids, never REMOVE_ALL_MESSAGES, like compaction.

export type RollbackPlan =
  // `noted`: the first id now holds the undelivered-reply note instead of being removed.
  | { action: "remove"; ids: string[]; noted?: true }
  | {
      action: "keep";
      reason:
        | "no-turn-found"
        | "tool-ran"
        | "already-gone"
        | "another-invoke-is-reading";
    };

// A tool call separates a turn that only SAID something from one that DID something (a transfer
// cannot be undone), so any tool call keeps the whole slice. Two calls perform nothing: `skip_reply`,
// judged from the bound set the caller passes (a custom HTTP tool may carry that name and really
// act), and a call the graph's boundary refused, recognized by the graph-only marker. A refusal pairs
// by POSITION with the assistant turn right before it (the boundary answers a whole batch there);
// `tool_call_id` is wrong, since a call may have no id. Positional rather than "the slice contains a
// refusal", because a turn can run a tool on one hop and be refused on the next.
function isInertToolCall(
  m: BaseMessage,
  inert: ReadonlySet<string>,
  // The message directly after `m` in the slice, or undefined at the end of it.
  next: BaseMessage | undefined,
): boolean {
  // NOTE: no early return on an empty set: `inert.has` already answers false, and the shortcut would
  // make a by-name mutation of the branch below unobservable to the tests.
  if (m.getType() === "tool") {
    if (isCalledOffToolResult(m)) return true;
    const name = (m as { name?: string }).name;
    return name !== undefined && inert.has(name);
  }
  const calls = (m as AIMessage).tool_calls ?? [];
  if (calls.length === 0) return false;
  if (next !== undefined && isCalledOffToolResult(next)) return true;
  return calls.every((c) => inert.has(c.name));
}

function actedOnTheWorld(
  slice: readonly BaseMessage[],
  inert: ReadonlySet<string>,
): boolean {
  return slice.some(
    (m, i) =>
      !isInertToolCall(m, inert, slice[i + 1]) &&
      (m.getType() === "tool" ||
        ((m as AIMessage).tool_calls?.length ?? 0) > 0),
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
  // Tools whose call performed NOTHING, so a turn holding only those can still be taken back. Named
  // by the caller because only the toolset knows which tool a name resolved to.
  inertTools: ReadonlySet<string> = new Set(),
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
  if (actedOnTheWorld(slice, inertTools))
    return { action: "keep", reason: "tool-ran" };
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

// What a reactive turn leaves behind: the same residue, not the same slice. The channel holds
// [customer message][our answer], and removing the first would delete the message a re-armed flush
// exists to answer. So the removable part is the trailing run of assistant messages with no tool
// call; it can never reach a HumanMessage of any kind, and needs no rule about where a turn starts.
// A tool call and its result sit outside that run, so a real transfer keeps its record and only the
// unread closing line goes.
function saidSomethingAndNothingElse(m: BaseMessage): boolean {
  return (
    m.getType() === "ai" && ((m as AIMessage).tool_calls?.length ?? 0) === 0
  );
}

// Where the trailing run starts, or null when there is none to take: nothing trailing (the turn ended
// on a tool, so it said nothing), or nothing but assistant messages, which is not a channel this
// invoke produced — the wall this rule leans on is missing, and guessing where the turn began is how
// a rollback eats history.
function trailingRunStart(produced: readonly BaseMessage[]): number | null {
  let start = produced.length;
  while (start > 0) {
    const m = produced[start - 1];
    if (m === undefined || !saidSomethingAndNothingElse(m)) break;
    start--;
  }
  return start === produced.length || start === 0 ? null : start;
}

export function planReactiveTurnRollback(
  produced: readonly BaseMessage[],
  current: readonly BaseMessage[],
  // Unused here: a reactive turn's removable slice never includes a tool result (see below), so the
  // question the proactive planner asks does not arise. Accepted so the two share one call shape.
  _inertTools: ReadonlySet<string> = new Set(),
): RollbackPlan {
  const start = trailingRunStart(produced);
  if (start === null) return { action: "keep", reason: "no-turn-found" };
  return nameWhatSurvived(produced.slice(start), current);
}

// Whether the reply the reactive plan takes back followed an act of THIS turn: the
// stretch between the message the turn answered and that reply. Stopping at the first human message
// is what keeps a booking from a turn that was delivered out of it. Inert calls are read as the
// proactive plan reads them, so a `skip_reply` or a call the boundary refused is not an act.
export function turnActedBeforeItsReply(
  produced: readonly BaseMessage[],
  inertTools: ReadonlySet<string> = new Set(),
): boolean {
  const start = trailingRunStart(produced);
  if (start === null) return false;
  return actedOnTheWorld(actingStretch(produced, start), inertTools);
}

function actingStretch(
  produced: readonly BaseMessage[],
  start: number,
): readonly BaseMessage[] {
  let from = start;
  while (from > 0 && produced[from - 1]?.getType() !== "human") from--;
  return produced.slice(from, start);
}

// The names of what that stretch called, for the operator's line. Once each, in call order.
export function actedToolNames(
  produced: readonly BaseMessage[],
  inertTools: ReadonlySet<string> = new Set(),
): string[] {
  const start = trailingRunStart(produced);
  if (start === null) return [];
  const stretch = actingStretch(produced, start);
  // A batch is inert as a whole only when every call is, so a mixed one still drops its inert
  // calls by name.
  const names = stretch.flatMap((m, i) =>
    isInertToolCall(m, inertTools, stretch[i + 1])
      ? []
      : ((m as AIMessage).tool_calls ?? [])
          .map((c) => c.name)
          .filter((name) => !inertTools.has(name)),
  );
  return [...new Set(names)];
}

// Reads the channel and writes the removal under the same `ingest:<graphThreadId>` key the append
// and compaction take. The queue alone is not enough: an invoke in flight holds no key but loads and
// saves back the whole channel, so like compaction this stands down when `isTurnInFlight`, and the
// refused turn then stays (a removal about to be undone is worse). Across replicas it also takes
// `claimIngestWrite`, the append claim (the counted turn claim excludes no other turn). An invoke
// already reading, or a thread with no contact inbox, still cannot be excluded: best-effort, never
// worse than not running. Details in docs/graph.md, "The tool boundary, when the turn was called off".
export async function undoRefusedTurn(params: {
  checkpointer: BaseCheckpointSaver;
  graphThreadId: string;
  produced: readonly BaseMessage[];
  // WHICH turn was refused, because the two have different removable slices and neither plan is
  // right for the other: a proactive one wrote its own `[human]` directive and takes it back with the
  // answer, a reactive one is answering the CUSTOMER'S message and must leave it standing. Required
  // rather than defaulted — a caller that has to name it cannot inherit the wrong one by omission.
  kind: "proactive" | "reactive";
  // See planTurnRollback. The caller resolves it from the toolset it actually built, so a CUSTOM tool
  // that happens to be named like a native one is never mistaken for the inert one.
  inertTools?: ReadonlySet<string>;
  // The note that takes the removed reply's place when the turn acted before it
  // (`turnActedBeforeItsReply`). It reuses the first removed id, so the reducer puts it exactly where
  // the reply stood, ahead of anything appended since. Absent, the reply just goes. Meaningful on the
  // reactive plan only: the proactive one removes nothing from a turn that acted.
  undeliveredNote?: BaseMessage;
  // The DURABLE half of the exclusion, for the one thread key that has a row to hang it on. Both or
  // neither: without them only the process-local check applies, which is all a thread with no
  // contact inbox can have.
  owner?: ThreadOwner | null;
  base?: PrismaClient;
}): Promise<RollbackPlan> {
  const { checkpointer, graphThreadId, produced, kind, owner, base } = params;
  const plan =
    kind === "reactive" ? planReactiveTurnRollback : planTurnRollback;
  const graph = buildThreadStateGraph(checkpointer);
  const threadCfg = { configurable: { thread_id: graphThreadId } };
  return withKeyedQueue(`ingest:${graphThreadId}`, async () => {
    if (isTurnInFlight(graphThreadId)) {
      return { action: "keep", reason: "another-invoke-is-reading" };
    }
    // Before the Map mark, forced: `claimIngestWrite` asks `isTurnInFlight` itself, so marking
    // first would refuse on account of the caller. Same order as ingest.ts (queue, then claim), which
    // is why the two cannot deadlock.
    let write: IngestWriteClaim | null = null;
    if (owner && base) {
      const held = await claimIngestWrite(owner, base);
      // NOTE: A turn holds the thread on some replica. The same answer the Map gives, decided from the row
      // — which is the half that can see another process.
      if (held.state === "busy") {
        return { action: "keep", reason: "another-invoke-is-reading" };
      }
      write = held;
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
      const decided = plan(produced, current, params.inertTools ?? new Set());
      if (decided.action === "remove") {
        const note =
          params.undeliveredNote !== undefined &&
          turnActedBeforeItsReply(produced, params.inertTools)
            ? params.undeliveredNote
            : null;
        const [first, ...rest] = decided.ids;
        if (note && first !== undefined) note.id = first;
        await graph.updateState(
          threadCfg,
          {
            messages: note
              ? [note, ...rest.map((id) => new RemoveMessage({ id }))]
              : decided.ids.map((id) => new RemoveMessage({ id })),
          },
          THREAD_STATE_NODE,
        );
        if (note) return { ...decided, noted: true };
      }
      return decided;
    } finally {
      clearTurnInFlight(graphThreadId);
      // NOTE: released on every exit (a stranded claim defers every append until its lease ends), and
      // best-effort: a throw here would turn a successful removal into an error, and the claim is
      // stranded either way since release stops the renewal first. The lease is the recovery path.
      if (write && owner && base) {
        try {
          await releaseIngestWrite(owner, base, write);
        } catch (err) {
          logger.warn(
            { err, thread: graphThreadId },
            "failed to release the durable ingest write claim after a rollback; its lease will expire",
          );
        }
      }
    }
  });
}

// How a post-generation stretch ended: `undo` says the generated text never reached the customer
// and has to leave the checkpoint. Built only through `settlement`, never as a literal.
export interface Settled<O extends string> {
  readonly outcome: O;
  readonly undo: boolean;
}

// The two ways to end a post-generation stretch, typed per path. `RefusalOnly` names the words that
// can only mean "generated and not delivered" on that path, and `settled` refuses them at compile
// time, so a refusal that skips the rollback is a type error rather than a quiet residue in history.
// Words that are a refusal only sometimes (`silent`, `noted`, `empty`) stay legal on both sides,
// and behavior tests hold those exits.
export function settlement<O extends string, RefusalOnly extends O>() {
  return {
    refused: (outcome: O): Settled<O> => ({ outcome, undo: true }),
    settled: (outcome: Exclude<O, RefusalOnly>): Settled<O> => ({
      outcome,
      undo: false,
    }),
  };
}

// The rollback a refused stretch's single caller runs, shared by the reactive and the proactive
// path. Best-effort and loud: throwing would turn a correct refusal into a retried turn. The one
// keep that is a miss (`another-invoke-is-reading`) is a warn, since the history still holds a
// message the customer never received.
export async function rollBackRefusedTurn<O extends string>(
  outcome: O,
  params: Parameters<typeof undoRefusedTurn>[0] & {
    logPrefix: "turn" | "agentNudge";
    conversationId: number;
  },
): Promise<O> {
  const { logPrefix, conversationId, ...undo } = params;
  const plan = await undoRefusedTurn(undo).catch((err) => {
    logger.warn(
      { err, conversationId: String(conversationId) },
      `${logPrefix}: could not roll back the refused turn`,
    );
    return null;
  });
  if (plan?.action === "remove") {
    logger.info(
      `${logPrefix} rolled back a refused turn: conv=%s outcome=%s messages=%d`,
      String(conversationId),
      outcome,
      plan.ids.length,
    );
  } else if (plan?.reason === "another-invoke-is-reading") {
    logger.warn(
      `${logPrefix} could not roll back a refused turn, another invoke holds the thread: conv=%s outcome=%s`,
      String(conversationId),
      outcome,
    );
  }
  return outcome;
}
