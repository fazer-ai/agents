import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type BaseMessage, SystemMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { runModelCall } from "@/graph/model-limit";

// Minimal functional supervisor: an agent node over the persisted message history, with an
// optional tool-calling loop (agent ⇄ tools until the model stops calling tools). The
// checkpointer (thread_id = conversation) stores the running messages between webhook events, so
// each incoming message resumes the conversation. The system prompt is config (prepended per
// turn), not part of the persisted history. Subgraphs (qualifier, proposal_writer, kanban_mover,
// human_handoff) graft onto this skeleton in later increments.

export interface BuildAgentGraphParams {
  model: BaseChatModel;
  systemPrompt: string;
  checkpointer?: BaseCheckpointSaver;
  tools?: StructuredToolInterface[];
  // Soft+hard cap on tool executions within ONE turn (default 10). At maxToolCalls-2 the agent gets
  // a "wrap up now" instruction; at maxToolCalls it is invoked WITHOUT tools, forcing a text answer
  // instead of LangGraph's GraphRecursionError. See src/modules/agents/limits.ts.
  maxToolCalls?: number;
  // Fired once when the hard limit forces a no-tools answer (runtime emits a flow warn so it shows
  // up in the turn trail / Logs). Best-effort; never throws.
  onToolLimit?: (info: { maxToolCalls: number; toolCalls: number }) => void;
  // Fired when a model call is retried after the provider answered with no completion (see
  // model-limit). Same purpose as onToolLimit: without it a recovered turn looks like a clean one
  // and the fault rate stays invisible.
  onModelRetry?: (info: { attempt: number; error: unknown }) => void;
}

const DEFAULT_MAX_TOOL_CALLS = 10;

// Count tool executions since the last customer (Human) message: ToolMessages after the last
// HumanMessage in the history. One per tool call the model issued and we ran this turn.
function toolCallsSinceLastHuman(history: BaseMessage[]): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]?.getType();
    if (t === "human") break;
    if (t === "tool") count++;
  }
  return count;
}

export function buildAgentGraph({
  model,
  systemPrompt,
  checkpointer,
  tools,
  maxToolCalls,
  onToolLimit,
  onModelRetry,
}: BuildAgentGraphParams) {
  const hasTools = !!tools && tools.length > 0;
  const llm = hasTools ? (model.bindTools?.(tools) ?? model) : model;
  const max = maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;

  const agentNode = async (state: typeof MessagesAnnotation.State) => {
    // Exactly one system message, and it must be first: prepend the configured prompt and drop any
    // system message that leaked into the history (e.g. a proactive nudge persisted as a
    // SystemMessage by an older build). Providers like Google reject a second one outright with
    // "System messages are only permitted as the first passed message".
    const history = state.messages.filter((m) => m.getType() !== "system");

    // Tool-call budget for this turn. Hard limit reached → invoke the RAW model (no tools bound), so
    // the response carries no tool_calls and toolsCondition routes to END. Approaching it (N-2) →
    // append a "wrap up" instruction but keep tools available for the imprescindible case.
    const toolCalls = hasTools ? toolCallsSinceLastHuman(history) : 0;
    const hardLimit = hasTools && toolCalls >= max;
    const softLimit =
      hasTools && !hardLimit && toolCalls >= Math.max(1, max - 2);

    let prompt = systemPrompt;
    if (softLimit) {
      prompt = `${systemPrompt}\n\n[Sistema] Você já usou ${toolCalls} de ${max} ferramentas permitidas neste turno. Conclua agora: responda ao cliente com as informações que já tem. Só use outra ferramenta se for absolutamente imprescindível.`;
    }
    if (hardLimit) {
      onToolLimit?.({ maxToolCalls: max, toolCalls });
    }

    const response = await runModelCall(
      () =>
        (hardLimit ? model : llm).invoke([
          new SystemMessage(prompt),
          ...history,
        ]),
      onModelRetry,
    );
    return { messages: [response] };
  };

  const builder = new StateGraph(MessagesAnnotation)
    .addNode("agent", agentNode)
    .addEdge(START, "agent");

  if (hasTools) {
    builder
      .addNode("tools", new ToolNode(tools))
      // toolsCondition routes to "tools" when the last AIMessage has tool calls, else to END.
      .addConditionalEdges("agent", toolsCondition)
      .addEdge("tools", "agent");
  } else {
    builder.addEdge("agent", END);
  }

  return builder.compile(checkpointer ? { checkpointer } : {});
}

// Extracts the assistant's reply text from the final state, normalizing the content (which may
// be a string or an array of content blocks for some providers) to a plain string.
export function lastAssistantText(messages: BaseMessage[]): string {
  const last = messages.at(-1);
  if (!last) return "";
  const content = last.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "string"
          ? c
          : c && typeof c === "object" && "text" in c
            ? String((c as { text: unknown }).text)
            : "",
      )
      .join("")
      .trim();
  }
  return "";
}
