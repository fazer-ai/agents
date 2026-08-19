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
import logger from "@/api/lib/logger";
import { selectHistoryWindow } from "@/graph/history-window";
import { contentToText } from "@/graph/message-text";
import { runModelCall } from "@/graph/model-limit";
import { countMessageTokens } from "@/graph/token-count";

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
  // Ceiling on the history tokens handed to the model (agent.settings.limits.maxHistoryTokens).
  // null/undefined = send the whole thread, which is the historical behavior.
  maxHistoryTokens?: number | null;
  // Fired when a turn actually dropped messages, so the runtime can put it in the turn trail.
  // Trimming that leaves no trace is indistinguishable, from the operator's chair, from the agent
  // forgetting things on its own.
  onHistoryTrim?: (info: {
    kept: number;
    dropped: number;
    tokens: number;
  }) => void;
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

// Applies the per-agent history ceiling, if there is one. Best-effort: trimming is an optimization
// and must never cost a customer their answer, so a throw falls back to the full history — slow and
// expensive, but exactly the behavior that shipped before the ceiling existed.
function applyHistoryCeiling(
  full: BaseMessage[],
  maxHistoryTokens: number | null | undefined,
  onHistoryTrim: BuildAgentGraphParams["onHistoryTrim"],
): BaseMessage[] {
  if (!maxHistoryTokens) return full;
  try {
    const window = selectHistoryWindow(
      full,
      maxHistoryTokens,
      countMessageTokens,
    );
    if (window.dropped > 0) {
      onHistoryTrim?.({
        kept: window.kept.length,
        dropped: window.dropped,
        tokens: window.tokens,
      });
    }
    return window.kept;
  } catch (err) {
    logger.warn({ err }, "history ceiling: trim failed, sending full history");
    return full;
  }
}

export function buildAgentGraph({
  model,
  systemPrompt,
  checkpointer,
  tools,
  maxToolCalls,
  onToolLimit,
  onModelRetry,
  maxHistoryTokens,
  onHistoryTrim,
}: BuildAgentGraphParams) {
  const hasTools = !!tools && tools.length > 0;
  const llm = hasTools ? (model.bindTools?.(tools) ?? model) : model;
  const max = maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;

  const agentNode = async (state: typeof MessagesAnnotation.State) => {
    // Exactly one system message, and it must be first: prepend the configured prompt and drop any
    // system message that leaked into the history (e.g. a proactive nudge persisted as a
    // SystemMessage by an older build). Providers like Google reject a second one outright with
    // "System messages are only permitted as the first passed message".
    const full = state.messages.filter((m) => m.getType() !== "system");

    // NOTE: Bound the history BEFORE the tool-call budget below, so both read the same window. The
    // window always keeps the last human message and everything after it, so the tool count is not
    // affected by the trim; this ordering is about the two never disagreeing.
    const history = applyHistoryCeiling(full, maxHistoryTokens, onHistoryTrim);

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
  return contentToText(content).trim();
}
