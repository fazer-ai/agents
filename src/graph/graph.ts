import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  type MessageContent,
  SystemMessage,
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
import { SKIP_REPLY_TOOL, skipReplyRan } from "./silence";

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

// The AI message that REQUESTED the tool batch the history ends on, alongside the two answers about
// that batch. One scan, because both are about the same batch and a second walk would be a second
// chance to disagree about where it starts.
//
//   `skipped` — the model chose silence, which is what suppresses the wrap-up instruction;
//   `alone`   — the decision is ALL it did, which is what may end the turn.
//
// They are separate because the two questions have different answers on a PARALLEL batch, and
// merging them is what rounds 17 and 18 of review kept finding.
function lastBatch(history: BaseMessage[]): {
  skipped: boolean;
  alone: boolean;
  caller: BaseMessage | null;
} {
  let sawTool = false;
  let skipped = false;
  // NOTE: The CONTIGUOUS batch, not the last message: a model can emit parallel calls (`skip_reply`
  // alongside `react_to_message`, which is the documented way to answer with a reaction alone), and
  // whichever result lands last is an ordering accident. Returning on the first `ToolMessage` read
  // the accident instead of the decision.
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const t = m?.getType();
    if (t === "tool") {
      sawTool = true;
      // NOTE: The ACK, not the name. A precondition on `skip_reply` returns a normal tool result under
      // that same name saying the call did NOT run — read by name, an operator's own guard would
      // end the turn with no text where the customer is waiting for one. `skipReplyRan` recognises
      // our no-op and nothing else, so anything unrecognised falls through to "answer them".
      if (skipReplyRan(m as Parameters<typeof skipReplyRan>[0])) skipped = true;
      continue;
    }
    // NOTE: The batch ends at the AI message that requested it — anything before is an earlier round.
    if (sawTool) return { skipped, alone: onlySkipped(m), caller: m ?? null };
    if (t === "human") return { skipped: false, alone: false, caller: null };
  }
  return { skipped: false, alone: false, caller: null };
}

// WHETHER THE DECISION WAS THE WHOLE OF WHAT THE MODEL DID, read off the CALLS rather than off their
// results — and that is the shape rounds 17 and 18 arrived at from opposite ends.
//
// Round 17 asked whether the companion SUCCEEDED, and answered it from the result: an error status,
// or a precondition refusal. Round 18 showed why that cannot be answered there. A tool can decline
// through a perfectly ordinary success result, because business-level refusals are normal operation
// and `failure.ts` forbids them from using `toolFailure`: `react_to_message` says so when the last
// message is itself a reaction, `send_image` when the host is not allowed. Telling those apart from
// a tool that really acted needs a per-tool contract about what "did nothing" looks like — a
// taxonomy every future tool would have to join, and would silently fail to.
//
// So the question is asked of the batch instead, and answered conservatively, the way
// `actedOnTheWorld` answers its own: a batch that called ANYTHING else produced information the
// model has not seen, so it decides again. Only a batch that is nothing but this decision may end
// the turn on it.
//
// THE COST, said out loud: the documented `react_to_message` + `skip_reply` batch now takes one more
// model round, on which the model sees the reaction's result and either calls `skip_reply` alone
// (terminal) or answers. That is the point — when the reaction did not happen, answering is exactly
// what the customer needs.
function onlySkipped(caller: BaseMessage | undefined): boolean {
  const ai = caller as AIMessage | undefined;
  const calls = ai?.tool_calls ?? [];
  // NOTE: INVALID CALLS COUNT AS COMPANIONS. A provider can emit a good `skip_reply` beside a call whose
  // arguments do not parse, and LangChain files that one under `invalid_tool_calls` — so a check
  // that read `tool_calls` alone saw a batch that was nothing but the decision, ended the turn, and
  // denied the model the round where it would have seen the failure and answered (round 26).
  if ((ai?.invalid_tool_calls?.length ?? 0) > 0) return false;
  return calls.length > 0 && calls.every((c) => c.name === SKIP_REPLY_TOOL);
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
// The message's blocks with the TEXT taken out and everything else left alone. A string collapses to
// an empty list (there was nothing but text in it); an array keeps every block that is not text,
// which is what carries Anthropic's signed `thinking` / `redacted_thinking` through unchanged.
function textlessContent(content: MessageContent): MessageContent {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b) => typeof b !== "string" && (b as { type?: unknown }).type !== "text",
  ) as MessageContent;
}

// ...AND THE RAW PROVIDER OUTPUT, because for some models the history is serialized from THAT and
// not from `content`. `@langchain/openai` keeps the Responses API's `output` array in
// `response_metadata` and replays it, so a message whose `content` is blanked would still hand the
// narration back to the model, which is the false memory this whole rule exists to remove.
//
// The PART type is what decides, and it is the only condition here. A second check on the ITEM type
// ("only a message loses its text") was written first and removed: `function_call` carries its
// arguments as a string and `reasoning` carries `reasoning_text` parts, so neither is reachable by
// the filter below, and a condition no fixture can tell from its absence reads as protection it is
// not. An adapter that keeps no `output` array pays nothing.
function textlessResponseMetadata(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const output = meta?.output;
  if (!meta || !Array.isArray(output)) return meta;
  const rewritten = output.flatMap((item) => {
    const it = item as { content?: unknown };
    if (!Array.isArray(it?.content)) return [item];
    const before = it.content as unknown[];
    const after = before.filter(
      (part) =>
        (part as { type?: unknown })?.type !== "output_text" &&
        (part as { type?: unknown })?.type !== "text",
    );
    // NOTE: AN ITEM THAT WAS NOTHING BUT TEXT GOES WITH IT. Left behind with an empty content array it is
    // the Responses API's own version of Anthropic's empty text block: the replay is rejected and
    // the round a companion bought fails instead of running. Dropped only when the filter emptied
    // it — an item that ARRIVED empty is the provider's own and not this rule's to remove
    // (round 28).
    if (before.length > 0 && after.length === 0) return [];
    return [{ ...(item as object), content: after }];
  });
  return { ...meta, output: rewritten };
}

function silenceNarration(history: BaseMessage[]): BaseMessage[] {
  const { caller } = lastBatch(history);
  if (!caller || typeof caller.id !== "string") return [];
  const ai = caller as AIMessage;
  return [
    new AIMessage({
      id: ai.id,
      // A BLOCK LIST WITHOUT THE TEXT, never `""` and never a blanket `[]`.
      //
      // Not `""`: this message KEEPS its tool calls, so `isEmptyAssistantTurn` rightly leaves it in
      // the history the model is sent — and `@langchain/anthropic` renders string content as a text
      // block, which Anthropic refuses when it is empty ("text content blocks must be non-empty").
      // An empty block LIST renders no text block at all (round 21).
      //
      // Not `[]` either: a provider can return blocks BESIDE the text, and Anthropic's `thinking`
      // and `redacted_thinking` are signed and must be replayed unchanged before the tool result
      // they precede. Emptying the list deletes protocol data, and the very next round — the one a
      // parallel companion buys — fails at the provider. TEXT is the only thing this may remove
      // (round 27).
      content: textlessContent(ai.content),
      tool_calls: ai.tool_calls ?? [],
      // NOTE: Carried like the valid ones: they are part of what the model asked for, and a rebuild that
      // dropped them would erase the record of a call that failed to parse.
      ...(ai.invalid_tool_calls?.length
        ? { invalid_tool_calls: ai.invalid_tool_calls }
        : {}),
      additional_kwargs: ai.additional_kwargs,
      response_metadata: textlessResponseMetadata(ai.response_metadata),
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
// orphans every `tool_call_id` after it. Nor is one with `invalid_tool_calls`, for the same reason
// `silenceNarration` carries them: they are the record of a call that failed to parse.
//
// And "no TEXT" is not the question (round 31). A provider can answer with reasoning or an image and
// nothing else, and Anthropic's `thinking` is signed; a turn carrying any non-text block is output,
// not absence. Reading it as empty deletes from every later prompt exactly what `textlessContent`
// above takes such care to keep, which is why the two ask the block list the same question.
function isEmptyAssistantTurn(m: BaseMessage): boolean {
  if (m.getType() !== "ai") return false;
  const ai = m as AIMessage;
  if ((ai.tool_calls?.length ?? 0) > 0) return false;
  if ((ai.invalid_tool_calls?.length ?? 0) > 0) return false;
  if (Array.isArray(ai.content) && textlessContent(ai.content).length > 0) {
    return false;
  }
  return contentToText(ai.content).trim() === "";
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

  // ONCE PER TURN, and the same closure argument the flag above makes: `buildModelAndGraph` builds
  // this graph inside the turn and invokes it once, so this variable IS "this invocation".
  //
  // The cap is one EVENT — the turn ran out of tool budget — and its handlers write an operator line
  // and can page. It used to be one call by construction, because the hard limit ended the turn. It
  // stopped being one when a parallel batch containing `skip_reply` became non-terminal (round 18)
  // and then kept `skip_reply` bound at the cap (round 22): the batch reports the limit, the
  // reaffirmation round re-enters the terminal branch and reports it again, with a bigger count. Two
  // warnings for one event, the second one describing a round that spent nothing.
  let toolLimitReported = false;
  const reportToolLimit = (info: {
    maxToolCalls: number;
    toolCalls: number;
  }) => {
    if (toolLimitReported) return;
    toolLimitReported = true;
    onToolLimit?.(info);
  };

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
    // BLANKED THE MOMENT THE DECISION IS SEEN, not only when the turn ends on it. A model can put
    // text in the message that calls `skip_reply`, and on a PARALLEL batch that message is not the
    // end of the turn — so a branch that only blanked on the way out left the narration standing
    // whenever a companion tool bought another round, and the turn could still finish silent (round
    // 20). Undelivered either way: the runtime posts the LAST assistant message.
    const narration = staySilent ? silenceNarration(history) : [];
    // NOTE: Terminal only when the decision was ALL the model did (see `onlySkipped`). `staySilent` alone
    // still suppresses the wrap-up instruction below: the model just chose silence either way.
    if (staySilent && lastBatch(history).alone) {
      if (hardLimit) reportToolLimit({ maxToolCalls: max, toolCalls });
      return { messages: [...narration, new AIMessage("")] };
    }
    // `staySilent` is back in this condition, and round 18 is why it had to be. It left when the
    // branch above returned on `staySilent` alone — no round after the decision, so nothing to
    // instruct — and now that branch also asks whether the decision stood alone. On a PARALLEL batch
    // there IS a round after it, and "Conclua agora: responda ao cliente" is the exact opposite of
    // what the model just chose. Measured by the round-7 test, not by reading.
    const softLimit =
      hasTools &&
      !hardLimit &&
      !staySilent &&
      toolCalls >= Math.max(1, max - 2);

    let prompt = systemPrompt;
    if (softLimit) {
      prompt = `${systemPrompt}\n\n[Sistema] Você já usou ${toolCalls} de ${max} ferramentas permitidas neste turno. Conclua agora: responda ao cliente com as informações que já tem. Só use outra ferramenta se for absolutamente imprescindível.`;
    }
    if (hardLimit) {
      reportToolLimit({ maxToolCalls: max, toolCalls });
    }
    // THE HARD LIMIT MUST NOT TALK A DECISION OUT OF ITSELF, and a PARALLEL batch is where it could.
    // The hard-limit path invokes the RAW model with no tools bound, which exists to force a text
    // answer — and round 18 made that batch non-terminal, so a model that chose silence and had a
    // companion to inspect landed there and could be made to write. Round 9 already named that
    // defect; this is the same one, arriving through the parallel door.
    //
    // So the budget stops the tools that ACT and leaves the one that does not: with `skip_reply`
    // alone bound, the model sees the companion's result and either reaffirms silence (a batch that
    // is nothing but the decision, which ends the turn) or answers, which is exactly what the
    // customer needs when the companion failed. It cannot loop: the reaffirmation is terminal.
    const silenceOnly =
      hardLimit && staySilent
        ? (tools ?? []).filter((t) => t.name === SKIP_REPLY_TOOL)
        : [];
    // What the HARD LIMIT invokes: the raw model, or the raw model with only that one tool bound.
    const capped =
      silenceOnly.length > 0
        ? (model.bindTools?.(silenceOnly) ?? model)
        : model;
    const cappedFallback =
      fallback && silenceOnly.length > 0
        ? (fallback.model.bindTools?.(silenceOnly) ?? fallback.model)
        : fallback?.model;

    // SENT WITHOUT THE NARRATION, not merely persisted without it. The blanking above is a reducer
    // update that lands AFTER this call, so a parallel batch's extra round would otherwise reach the
    // model still carrying the sentence the customer never received — and the model can lean on it,
    // or repeat it, in the answer that does go out (round 22).
    const sent = narration.length
      ? history.map((m) => narration.find((n) => n.id === m.id) ?? m)
      : history;
    const messages = [new SystemMessage(prompt), ...sent];
    // The SAME question, to the other provider, when there is one. Same messages and same prompt:
    // this is not a second, cheaper attempt, it is the attempt the customer is waiting for.
    const second =
      fallback && fallbackLlm
        ? {
            labels: { provider: fallback.provider, model: fallback.modelId },
            run: () =>
              (hardLimit
                ? (cappedFallback ?? fallback.model)
                : fallbackLlm
              ).invoke(messages, {
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
            ...narration,
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
      () => (hardLimit ? capped : llm).invoke(messages),
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
    return { messages: [...narration, response] };
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
