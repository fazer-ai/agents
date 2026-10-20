// What keeps a client round-trip that lost its claim on the thread from touching the thread again,
// and what lets the next round-trip continue from wherever a stopped one left it.
import {
  type AIMessage,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

// The checkpointer as a round-trip may use it: reads always, writes only while the round-trip still
// holds its claim. A tool already running when the claim is lost is allowed to finish (the graph does
// not cut it off mid-effect), but its result is not written, so it cannot land after another request
// took the thread.
export function fencedCheckpointer(
  saver: BaseCheckpointSaver,
  signal: AbortSignal,
): BaseCheckpointSaver {
  return new Proxy(saver, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "put" && prop !== "putWrites") return value;
      return (...args: unknown[]) => {
        if (signal.aborted) return Promise.reject(signal.reason);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

// The calls of the last assistant turn that no tool message answers. A round-trip that was stopped
// mid-tool, or a process that died there, leaves them; the providers refuse a history that carries
// one, so the next round-trip answers them before it runs.
export function unansweredCalls(
  messages: BaseMessage[],
): { id: string; name: string }[] {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.getType() === "ai") {
      last = i;
      break;
    }
  }
  if (last < 0) return [];
  const answered = new Set(
    messages
      .slice(last + 1)
      .filter((m) => m.getType() === "tool")
      .map((m) => (m as ToolMessage).tool_call_id),
  );
  return ((messages[last] as AIMessage).tool_calls ?? [])
    .filter((c) => typeof c.id === "string" && !answered.has(c.id))
    .map((c) => ({ id: c.id as string, name: c.name }));
}

export function interruptedToolMessages(
  calls: { id: string; name: string }[],
): ToolMessage[] {
  return calls.map(
    (c) =>
      new ToolMessage({
        tool_call_id: c.id,
        name: c.name,
        content:
          "This call was interrupted before it finished; its result is unknown.",
        status: "error",
      }),
  );
}

// How long from now the round-trip may keep admitting work on a claim whose expiry was set when it
// was asked for at `askedAt`. Anchored to the ask, not to the answer, because the expiry is computed
// before the update is sent: a renewal answered late has less of its claim left. It stops half a
// claim early, so a write admitted just before has that long to land before anyone else can claim.
export function admitWorkFor(
  askedAt: number,
  leaseMs: number,
  now: number,
): number {
  return Math.max(0, askedAt + leaseMs / 2 - now);
}

// The node a recovery writes its tool messages as. `client_tools` exists only on a graph that has
// tools; a graph with none has only the agent, and a write as a node the graph lacks is refused.
export function recoveryNode(
  nodes: Record<string, unknown>,
): "client_tools" | "agent" {
  return "client_tools" in nodes ? "client_tools" : "agent";
}

// The pending calls the history does not already answer. A resume that wrote its tool results and
// stopped before the next checkpoint leaves the interrupt standing with those results in the state;
// answering them again would give one call two results, which the providers refuse.
export function withoutAnswers<C extends { toolCallId: string }>(
  calls: C[],
  messages: BaseMessage[],
): C[] {
  // Only the results after the last assistant turn count; a provider may reuse a call id
  // across turns, and an earlier turn's result does not answer this one.
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.getType() === "ai") {
      last = i;
      break;
    }
  }
  const answered = new Set(
    messages
      .slice(last + 1)
      .filter((m) => m.getType() === "tool")
      .map((m) => (m as ToolMessage).tool_call_id),
  );
  return calls.filter((c) => !answered.has(c.toolCallId));
}
