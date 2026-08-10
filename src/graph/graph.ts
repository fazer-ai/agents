import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  type BaseMessage,
  SystemMessage,
  trimMessages,
} from "@langchain/core/messages";
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
  // Ceiling on the history tokens sent to the model (agent.settings.limits.maxHistoryTokens).
  // undefined/null = send the whole thread, the historical behavior.
  maxHistoryTokens?: number | null;
  // Fired when a turn actually dropped messages, so the runtime can surface it in the turn trail —
  // silent trimming is how you end up debugging "the agent forgot" without knowing it was trimmed.
  onHistoryTrim?: (info: { kept: number; dropped: number }) => void;
}

const DEFAULT_MAX_TOOL_CALLS = 10;

// Keep only the most recent `maxHistoryTokens` worth of history. Off (null/undefined) → untouched,
// which is the pre-existing behavior and stays the default.
//
// Three options here are load-bearing, and getting any of them wrong breaks the turn instead of
// shortening it:
//   startOn: "human"  — a window must not open on a ToolMessage whose originating tool_call was
//     just dropped. Providers reject an orphan tool result outright (OpenAI 400), so a naive
//     "keep the last N tokens" turns into a hard failure exactly on the longest conversations.
//   allowPartial: false — half a message is worse than no message; it reads as the agent
//     misquoting the customer.
//   includeSystem: false — the prompt is prepended per turn by the caller and is never part of
//     `history`; counting it here would silently shrink the real budget.
//
// The counter is the model itself (BaseLanguageModel.getNumTokens), so the budget is measured in
// the same tokens the provider bills, not an approximation that drifts per language.
async function trimHistory(
  history: BaseMessage[],
  maxHistoryTokens: number | null | undefined,
  model: BaseChatModel,
): Promise<BaseMessage[]> {
  if (!maxHistoryTokens) return history;
  try {
    return await trimMessages(history, {
      maxTokens: maxHistoryTokens,
      tokenCounter: model,
      strategy: "last",
      startOn: "human",
      allowPartial: false,
      includeSystem: false,
    });
  } catch (err) {
    // Trimming is an optimization; never let it cost a customer their answer. Falling back to the
    // full history restores exactly the previous behavior (slow and expensive, but correct).
    logger.warn({ err }, "graph: history trim failed; sending full history");
    return history;
  }
}

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

    // Bound the history BEFORE the tool-call budget is computed, so both look at the same window.
    // The checkpointer thread spans every conversation this contact had on the channel and is never
    // pruned by itself, so without a ceiling this array only grows.
    const history = await trimHistory(full, maxHistoryTokens, model);
    if (history.length < full.length) {
      onHistoryTrim?.({
        kept: history.length,
        dropped: full.length - history.length,
      });
    }

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

    const response = await runModelCall(() =>
      (hardLimit ? model : llm).invoke([new SystemMessage(prompt), ...history]),
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
