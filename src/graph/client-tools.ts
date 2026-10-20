// Client tools: declared by the HOST APPLICATION per turn and run in its browser, with the
// signed-in user's session. A call to one suspends the turn on ONE interrupt carrying every client
// call of the batch, and the turn resumes with the answers (`Command({ resume })`).
//
// A node of its own, not `interrupt()` inside each tool: `ToolNode` runs a batch with `Promise.all`,
// so only the first interrupt surfaces and every resume re-runs the whole node, server tools
// included. Server calls run and are checkpointed in `tools`; this node only suspends.
import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { interrupt, type MessagesAnnotation } from "@langchain/langgraph";
import { clipText } from "@/lib/text";

export interface ClientToolSpec {
  name: string;
  description: string;
  // JSON Schema of the arguments, as the host declared it.
  parameters: Record<string, unknown>;
}

export interface ClientToolCall {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

export type ClientToolAnswer =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export interface ClientToolsInterrupt {
  kind: "client_tools";
  calls: ClientToolCall[];
}

// A page can hand back a whole table. The model gets a bounded slice and is told it was cut.
const MAX_RESULT_CHARS = 20_000;

// The tools the model is bound to. Never run: a call is routed away from `ToolNode` before it could
// reach one, so a run means the routing broke, and it says so instead of inventing a result.
export function buildClientToolStubs(
  specs: ClientToolSpec[],
): StructuredToolInterface[] {
  return specs.map((spec) =>
    tool(
      async () => {
        throw new Error(
          `client tool "${spec.name}" reached the server tool node`,
        );
      },
      {
        name: spec.name,
        description: spec.description,
        schema: spec.parameters as never,
      },
    ),
  );
}

// The assistant message whose calls the current tool round answers: the last AI message, with the
// tool results of this round after it.
function lastCaller(messages: BaseMessage[]): AIMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.getType() === "ai") return m as AIMessage;
  }
  return undefined;
}

export function pendingClientCalls(
  messages: BaseMessage[],
  names: ReadonlySet<string>,
): ClientToolCall[] {
  const caller = lastCaller(messages);
  if (!caller) return [];
  const answered = new Set(
    messages
      .slice(messages.lastIndexOf(caller) + 1)
      .filter((m) => m.getType() === "tool")
      .map((m) => (m as ToolMessage).tool_call_id),
  );
  return (caller.tool_calls ?? [])
    .filter((c) => names.has(c.name) && c.id && !answered.has(c.id))
    .map((c) => ({
      toolCallId: c.id as string,
      name: c.name,
      args: c.args,
    }));
}

// The state `ToolNode` should see: the same history with the last assistant turn reduced to its
// server calls. Null when the batch is client calls only.
export function withServerCallsOnly(
  state: typeof MessagesAnnotation.State,
  names: ReadonlySet<string>,
): typeof MessagesAnnotation.State | null {
  const last = state.messages.at(-1);
  if (last?.getType() !== "ai") return state;
  const ai = last as AIMessage;
  const server = (ai.tool_calls ?? []).filter((c) => !names.has(c.name));
  if (server.length === (ai.tool_calls ?? []).length) return state;
  if (server.length === 0) return null;
  const view = new AIMessage({
    content: ai.content,
    id: ai.id,
    tool_calls: server,
  });
  return {
    ...state,
    messages: [...state.messages.filter((m) => m !== last), view],
  };
}

function renderAnswer(answer: ClientToolAnswer | undefined): {
  content: string;
  status: "success" | "error";
} {
  if (!answer)
    return {
      content: "The application returned no result for this call.",
      status: "error",
    };
  // A failed answer is the browser's text too, and just as unbounded: the same clip.
  if (!answer.ok) return { content: clipAnswer(answer.error), status: "error" };
  return {
    content: clipAnswer(
      typeof answer.result === "string"
        ? answer.result
        : JSON.stringify(answer.result ?? null),
    ),
    status: "success",
  };
}

// The mark fits inside the cap, so an answer clipped once is left as it is when read again.
const CUT_MARK = `\n[cut at ${MAX_RESULT_CHARS} characters]`;

function clipAnswer(raw: string): string {
  return raw.length > MAX_RESULT_CHARS
    ? `${clipText(raw, MAX_RESULT_CHARS - CUT_MARK.length)}${CUT_MARK}`
    : raw;
}

// The answers as a turn resumes with them: each already the text the model will read. The resume
// value is checkpointed before the node renders it, so an answer of a few megabytes would otherwise
// be stored whole, more than once, for a tool message the model only ever sees clipped.
export function boundClientAnswers(
  answers: Record<string, ClientToolAnswer>,
): Record<string, ClientToolAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([id, answer]) => {
      const { content, status } = renderAnswer(answer);
      return [
        id,
        status === "success"
          ? { ok: true, result: content }
          : { ok: false, error: content },
      ];
    }),
  );
}

// What a suspended turn's calls read as when the browser never answered and the turn is closed
// without it: the same message an absent answer gets on resume, so the model cannot tell the two apart.
export function unansweredToolMessages(calls: ClientToolCall[]): ToolMessage[] {
  return calls.map((c) => {
    const { content, status } = renderAnswer(undefined);
    return new ToolMessage({
      tool_call_id: c.toolCallId,
      name: c.name,
      content,
      status,
    });
  });
}

export function clientToolsNode(names: ReadonlySet<string>) {
  return async (state: typeof MessagesAnnotation.State) => {
    const calls = pendingClientCalls(state.messages, names);
    if (calls.length === 0) return { messages: [] };
    const answers = interrupt<
      ClientToolsInterrupt,
      Record<string, ClientToolAnswer> | undefined
    >({ kind: "client_tools", calls });
    return {
      messages: calls.map((c) => {
        const { content, status } = renderAnswer(answers?.[c.toolCallId]);
        return new ToolMessage({
          tool_call_id: c.toolCallId,
          name: c.name,
          content,
          status,
        });
      }),
    };
  };
}
