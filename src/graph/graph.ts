import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  SystemMessage,
  type ToolMessage,
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
import { selectHistoryWindow } from "@/graph/history-window";
import { contentToText } from "@/graph/message-text";
import {
  type ModelLabels,
  type ModelRetryInfo,
  runModelCall,
} from "@/graph/model-limit";
import { countMessageTokens } from "@/graph/token-count";
import { USAGE_MODEL_METADATA_KEY } from "@/graph/usage";
import { skipReplyRan } from "./silence";
import { wasPreconditionRefused } from "./tools/precondition";

// The second provider as the graph needs it: the built model plus the two labels that name it on
// the usage row and the flow trail. Built and bounded by `prepare.buildModelAndGraph`; the node only
// ever calls it.
export interface FallbackModel {
  model: BaseChatModel;
  provider: string;
  modelId: string;
}

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
  onModelRetry?: (info: ModelRetryInfo) => void;
  // The second provider, already built and already bounded (see ./model-fallback). Absent for every
  // agent that configured none, which is every agent today, and absent means the node behaves
  // exactly as it did.
  fallback?: FallbackModel;
  // What the agent's OWN model is, for the lines this node's callbacks carry. Not read to dial
  // anything — `model` above is what dials.
  primary: ModelLabels;
  onModelFallback?: (info: {
    provider: string;
    model: string;
    reason: string;
  }) => void;
  onModelFallbackFailed?: (info: {
    provider: string;
    model: string;
    reason: string;
  }) => void;
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

// True when the model's most recent act was to decide NOT to answer. `skip_reply` performs nothing
// and IS that decision (since #454 it is also how a follow-up says so), so the soft wrap-up
// instruction must not land on the round after it: "Conclua agora: responda ao cliente" is the exact
// opposite of what the model just chose, and an agent with a small `maxToolCalls` crosses the soft
// limit on that very round. The COUNT is left alone deliberately — the cap still has to bound a model
// that calls skip_reply in a loop.
function justDecidedToStaySilent(history: BaseMessage[]): boolean {
  return lastBatch(history).skipped;
}

// The AI message that REQUESTED the tool batch the history ends on, alongside whether that batch
// says the model chose silence. One scan, because the two answers are about the same batch and a
// second walk would be a second chance to disagree about where it starts.
function lastBatch(history: BaseMessage[]): {
  skipped: boolean;
  caller: BaseMessage | null;
} {
  let sawTool = false;
  let skipped = false;
  let companionFailed = false;
  // The CONTIGUOUS batch, not the last message: a model can emit parallel calls (`skip_reply`
  // alongside `react_to_message`, which is the documented way to answer with a reaction alone), and
  // whichever result lands last is an ordering accident. Returning on the first `ToolMessage` read
  // the accident instead of the decision.
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const t = m?.getType();
    if (t === "tool") {
      sawTool = true;
      // The ACK, not the name. A precondition on `skip_reply` returns a normal tool result under
      // that same name saying the call did NOT run — read by name, an operator's own guard would
      // end the turn with no text where the customer is waiting for one. `skipReplyRan` recognises
      // our no-op and nothing else, so anything unrecognised falls through to "answer them".
      if (skipReplyRan(m as Parameters<typeof skipReplyRan>[0])) skipped = true;
      // ...AND THE COMPANION HAS TO HAVE HAPPENED. `skip_reply` beside `react_to_message` is the
      // documented way to answer with a reaction alone, so the reaction IS the reply — and when it
      // failed or was refused, ending the turn on the skip leaves the customer with nothing at all.
      // The model has to see that result and decide again, which is what every other failed tool
      // call already gets.
      else if (
        (m as ToolMessage).status === "error" ||
        wasPreconditionRefused(m as ToolMessage)
      ) {
        companionFailed = true;
      }
      continue;
    }
    // The batch ends at the AI message that requested it — anything before is an earlier round.
    if (sawTool) {
      return { skipped: skipped && !companionFailed, caller: m ?? null };
    }
    if (t === "human") return { skipped: false, caller: null };
  }
  return { skipped: false, caller: null };
}

// WHAT THE MODEL WROTE BESIDE THE DECISION, taken back out. A model can put text in the very message
// that calls `skip_reply` ("Vou deixar quieto por ora"), and that text is never delivered: the
// runtime posts the LAST assistant message, which is the empty one this turn ends on. Left in the
// channel it is a sentence the customer never saw, read by the next turn as something they were
// told — the false memory `refused-turn.ts` exists to prevent, arriving through the silence protocol
// instead of through a refusal.
//
// SCOPED TO THE DECISION, and deliberately not to every tool call. A preamble beside an ORDINARY
// call ("Vou verificar seu pedido") is followed by a reply that may lean on it, and rewriting the
// history of every tool-calling turn is a different change on a path this issue is not about. Here
// we know what the model chose: nothing at all reached the customer.
//
// Replaced by ID so the reducer swaps it in place, and everything BUT the content rides along: the
// tool calls, because the results already in the channel name them and an orphaned `tool_call_id` is
// a provider error on the next turn; the metadata, because a message rebuilt from its id and content
// alone silently drops the model's own usage and response fields, which is a second edit nobody
// asked for. Content is the only thing this is allowed to change.
//
// No "already empty, skip it" shortcut: with everything else carried over, replacing an empty
// message with an empty message is the same message, so the branch would be a condition no test
// could tell from its absence — and one of those is how a rule gets read as protection it is not.
function silenceNarration(history: BaseMessage[]): BaseMessage[] {
  const { caller } = lastBatch(history);
  if (!caller || typeof caller.id !== "string") return [];
  const ai = caller as AIMessage;
  return [
    new AIMessage({
      id: ai.id,
      content: "",
      tool_calls: ai.tool_calls ?? [],
      additional_kwargs: ai.additional_kwargs,
      response_metadata: ai.response_metadata,
      ...(ai.usage_metadata ? { usage_metadata: ai.usage_metadata } : {}),
      ...(ai.name ? { name: ai.name } : {}),
    }),
  ];
}

// An assistant turn that said nothing and did nothing, which is what a silent turn leaves behind —
// the terminal marker below, and, before this file ever wrote one, the empty message a model returns
// when it is told to produce none. It carries no information for the next turn, and it is not free
// to keep: `@langchain/anthropic` renders string content as a text block, and Anthropic refuses a
// text block that is empty ("text content blocks must be non-empty"), so a thread that accumulated
// one would stop answering entirely on the providers that check. Dropped from what the model is
// SENT, never from the channel — the marker is what keeps `lastAssistantText` reading "" instead of
// the skip tool's acknowledgement, which would otherwise be delivered to the customer as the reply.
//
// A message with tool_calls is not this, whatever its content: it is the call, and removing it
// orphans every `tool_call_id` after it.
function isEmptyAssistantTurn(m: BaseMessage): boolean {
  return (
    m.getType() === "ai" &&
    ((m as AIMessage).tool_calls?.length ?? 0) === 0 &&
    contentToText(m.content).trim() === ""
  );
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
  primary,
  fallback,
  onModelFallback,
  onModelFallbackFailed,
  maxHistoryTokens,
  onHistoryTrim,
}: BuildAgentGraphParams) {
  const hasTools = !!tools && tools.length > 0;
  const llm = hasTools ? (model.bindTools?.(tools) ?? model) : model;
  // Bound to the SAME toolset, or the fallback would answer a question the primary was asked with
  // tools it cannot call — and the tool-call budget below counts calls, not models.
  const fallbackLlm =
    fallback && hasTools
      ? (fallback.model.bindTools?.(tools) ?? fallback.model)
      : fallback?.model;
  const max = maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;

  // ONCE THE FALLBACK HAS THE TURN, IT KEEPS IT.
  //
  // A tool call routes back through this node, and without this the node asks the primary again on
  // every round. Measured on a three-round turn (two tool calls, then the answer) with the primary
  // failing: the primary was asked 3 times, the trail got 3 "fallback took the turn" warns for one
  // failover, and at 200ms per failure the turn cost 609.3ms of which ~600 was the primary. At the
  // ceiling instead of 200ms that is 45s PER ROUND — worse than the 77-99s this whole change exists
  // to remove, which is what makes it a defeat of the goal rather than an inefficiency.
  //
  // A closure and not a state channel, and the lifetime is the argument: `buildModelAndGraph` builds
  // this graph inside the turn and invokes it once (webhook, nudge and playground alike), so this
  // variable IS "this invocation". Putting it in graph state would persist it through the
  // checkpointer and demote the primary for every later turn on the same conversation, which is the
  // opposite of what a transient outage should cost.
  let fallbackHasTheTurn = false;

  const agentNode = async (state: typeof MessagesAnnotation.State) => {
    // Exactly one system message, and it must be first: prepend the configured prompt and drop any
    // system message that leaked into the history (e.g. a proactive nudge persisted as a
    // SystemMessage by an older build). Providers like Google reject a second one outright with
    // "System messages are only permitted as the first passed message".
    const full = state.messages.filter(
      (m) => m.getType() !== "system" && !isEmptyAssistantTurn(m),
    );

    // NOTE: Bound the history BEFORE the tool-call budget below, so both read the same window. The
    // window always keeps the last human message and everything after it, so the tool count is not
    // affected by the trim; this ordering is about the two never disagreeing.
    const history = applyHistoryCeiling(full, maxHistoryTokens, onHistoryTrim);

    // Tool-call budget for this turn. Hard limit reached → invoke the RAW model (no tools bound), so
    // the response carries no tool_calls and toolsCondition routes to END. Approaching it (N-2) →
    // append a "wrap up" instruction but keep tools available for the imprescindible case.
    const toolCalls = hasTools ? toolCallsSinceLastHuman(history) : 0;
    const hardLimit = hasTools && toolCalls >= max;
    const staySilent = hasTools && justDecidedToStaySilent(history);
    // THE DECISION IS TERMINAL, and terminal means the model is not asked again — not "asked again
    // and hopefully quiet". `skip_reply` is a tool, so the graph loops back here with its result, and
    // the contract that the next completion carries no text was the MODEL's to keep. It usually does,
    // being told to; when it does not, a turn that explicitly chose silence writes to the customer
    // anyway, and on the proactive path that is an unsolicited message — the outcome the sentinel
    // used to make impossible, because the token WAS the final text and the turn ended on it.
    //
    // So the turn ends here, on the decision, whatever the budget says. The outcome is the one the
    // model was heading for: no tool calls, `toolsCondition` routes to END, an empty message posts
    // nothing. The hard limit keeps its callback because the calls still COUNTED, which is what
    // bounds a model that loops on skip_reply; what it no longer does is force a TEXT answer out of
    // a turn that chose not to give one (round 9 found that half, round 11 the other).
    if (staySilent) {
      if (hardLimit) onToolLimit?.({ maxToolCalls: max, toolCalls });
      return { messages: [...silenceNarration(history), new AIMessage("")] };
    }
    // No `staySilent` term here: the branch above already returned on it. The wrap-up instruction
    // ("Conclua agora: responda ao cliente") is the exact opposite of what the model just chose, and
    // the reason it cannot land any more is that there is no round after the decision at all.
    const softLimit =
      hasTools && !hardLimit && toolCalls >= Math.max(1, max - 2);

    let prompt = systemPrompt;
    if (softLimit) {
      prompt = `${systemPrompt}\n\n[Sistema] Você já usou ${toolCalls} de ${max} ferramentas permitidas neste turno. Conclua agora: responda ao cliente com as informações que já tem. Só use outra ferramenta se for absolutamente imprescindível.`;
    }
    if (hardLimit) {
      onToolLimit?.({ maxToolCalls: max, toolCalls });
    }

    const messages = [new SystemMessage(prompt), ...history];
    // The SAME question, to the other provider, when there is one. Same messages and same prompt:
    // this is not a second, cheaper attempt, it is the attempt the customer is waiting for.
    const second =
      fallback && fallbackLlm
        ? {
            labels: { provider: fallback.provider, model: fallback.modelId },
            run: () =>
              (hardLimit ? fallback.model : fallbackLlm).invoke(messages, {
                // Metadata rather than callbacks, and measured: metadata MERGES with the turn's and
                // reaches the handlers it already had, while `callbacks` replaces them — which
                // would have billed this call to the primary's name or dropped the Langfuse trace.
                metadata: { [USAGE_MODEL_METADATA_KEY]: fallback.modelId },
              }),
          }
        : null;

    // Already demoted this invocation: the fallback IS the model now, so it gets the
    // empty-completion retry under its own name, and a failure of its own is reported as that
    // rather than as a second failover the operator never caused.
    if (second && fallbackHasTheTurn) {
      try {
        return {
          messages: [
            await runModelCall(second.run, {
              primary: second.labels,
              onRetry: onModelRetry,
            }),
          ],
        };
      } catch (err) {
        onModelFallbackFailed?.({
          ...second.labels,
          reason: err instanceof Error ? err.message : "provider error",
        });
        throw err;
      }
    }

    const response = await runModelCall(
      () => (hardLimit ? model : llm).invoke(messages),
      {
        primary,
        onRetry: onModelRetry,
        fallback: second
          ? {
              labels: second.labels,
              run: second.run,
              onFallback: ({ reason }) => {
                fallbackHasTheTurn = true;
                onModelFallback?.({ ...second.labels, reason });
              },
              onFallbackFailed: ({ reason }) =>
                onModelFallbackFailed?.({ ...second.labels, reason }),
            }
          : undefined,
      },
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
