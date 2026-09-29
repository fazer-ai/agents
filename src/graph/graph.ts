import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  type MessageContent,
  RemoveMessage,
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
import { datedHistory } from "@/graph/history-dates";
import { selectHistoryWindow } from "@/graph/history-window";
import { contentToText } from "@/graph/message-text";
import { PRIMARY_TIMEOUT_MS } from "@/graph/model-fallback";
import {
  type ModelLabels,
  type ModelRetryInfo,
  type PermitWaitInfo,
  runModelCall,
} from "@/graph/model-limit";
import { countMessageTokens } from "@/graph/token-count";
import {
  USAGE_MODEL_METADATA_KEY,
  USAGE_PROVIDER_METADATA_KEY,
} from "@/graph/usage";
import { calledOffToolResult } from "./markers";
import { SKIP_REPLY_TOOL, skipReplyRan } from "./silence";

// The second provider as the graph needs it: the built model plus the two labels that name it on
// the usage row and the flow trail. Built and bounded by `prepare.buildModelAndGraph`; the node only
// ever calls it.
export interface FallbackModel {
  model: BaseChatModel;
  provider: string;
  modelId: string;
  // The deadline on each call to it. Absent means `PRIMARY_TIMEOUT_MS`, the ceiling its SDK is built
  // with, which the Google adapter drops and this race holds.
  deadlineMs?: number;
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
  // Fired when this node's model call has waited past the capacity threshold for a permit of the
  // process-wide semaphore, so the runtime can put a `capacity` warn on the trail.
  onModelPermitWait?: (info: PermitWaitInfo) => void;
  // The second provider, already built and already bounded (see ./model-fallback). Absent when the
  // agent configured none, and then the node never falls back.
  fallback?: FallbackModel;
  // What the agent's OWN model is, for the lines this node's callbacks carry. Not read to dial
  // anything: `model` above is what dials.
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
  // null/undefined sends the whole thread.
  maxHistoryTokens?: number | null;
  // Whether each person's message reaches the model behind the date it was sent, and in which
  // timezone (agent.settings.memory.historyDates; see ./history-dates.ts). null/undefined sends the
  // history as it is stored.
  historyDates?: { timezone: string } | null;
  // Fired when a turn actually dropped messages, so the runtime can put it in the turn trail.
  // Trimming that leaves no trace is indistinguishable, from the operator's chair, from the agent
  // forgetting things on its own.
  onHistoryTrim?: (info: {
    kept: number;
    dropped: number;
    tokens: number;
  }) => void;
  // The turn's own "is this still wanted", asked at the tool boundary. The runtime asks it at every
  // seam it owns, but a tool call happens INSIDE the invoke, so without it a `/reset` landing mid-call
  // is reported done while this graph's tools write an attribute, a label and a kanban card back onto
  // the conversation. No `strict` option: this seam cannot stop the run by throwing (see
  // `refuseCalledOffCalls`), so the caller binds the strictness it wants and an error is not an answer.
  // Absent for callers with nothing to call off (the playground); the reactive turn and the nudge both
  // pass one, since a nudge runs from a job that `/reset` retires.
  stillWanted?: () => Promise<boolean>;
  // A turn with no reply channel (an observation): its frame says any text reaches nobody and its
  // Chatwoot client is muted, so the tool budget's wrap-up telling it to answer the customer would
  // contradict the frame, and models then either go silent or argue back in prose that goes nowhere
  // and is paid for by the token. Absent means the ordinary turn, which does answer somebody.
  noReplyChannel?: boolean;
  // What the model is told about a spoken reply, asked on EVERY round: the notice's text while the
  // reply still goes as a voice note, null once it does not (the model chose text, or the customer
  // asked for text mid-turn), so no later round forbids the lists text was chosen to carry. It travels
  // where the wrap-up does (see `LATE_SYSTEM_MESSAGE`), never as a human message, so everything before
  // it is the bytes a text turn sends and the cached prefix survives. It is persisted on no round.
  spokenNotice?: () => string | null;
  // The deadline on each call to the PRIMARY, retries included: the fallback's 45 s when one was built
  // (the primary then has one attempt), the agent's `modelCallTimeoutMs` when none was (see
  // buildModelAndGraph). Absent means that same default, so no call runs unbounded.
  primaryDeadlineMs?: number;
  // The signal of the scheduler job this graph runs for. It is NOT handed to
  // `graph.invoke`: aborting an invoke between a checkpointed tool call and its result leaves the
  // thread with a call no `ToolMessage` answers, which the providers then reject on every later turn
  // (see `refuseCalledOffCalls`), and the invoke would reject while the tool is still running. It
  // reaches the model call, and the tool boundary refuses calls once it has aborted, the same way a
  // called-off turn does, so the graph ends in a consistent state and only after its work has stopped.
  signal?: AbortSignal;
  // An unexplained silence is asked once more. A turn that would end with nothing for
  // the customer, no handoff and no `skip_reply` is sent back to the model in the same round, with a
  // late instruction naming both exits: answer, or declare the silence. Asked at the moment it would
  // run, because only the caller knows whether the turn already reached the customer or handed the
  // conversation to a person, and those turns are not silences. Absent means never: the nudge and
  // the playground pass none, and a caller with no reply channel must not be told to answer.
  retrySilence?: () => boolean;
  // Fired once when that retry ran, with what the second answer did, for the turn's trail.
  onSilenceRetry?: (info: SilenceRetryInfo) => void;
}

// What the retry of an unexplained silence got back: text for the customer, the declared silence,
// other tool calls (the turn goes on), or nothing again.
export type SilenceRetryOutcome = "answered" | "skip_reply" | "tools" | "empty";
export interface SilenceRetryInfo {
  outcome: SilenceRetryOutcome;
}

// The opening of the retry instruction, exported so a test can find it wherever it travels.
export const SILENCE_RETRY_MARK =
  "[Sistema] Este turno terminou sem mensagem para o cliente";

const DEFAULT_MAX_TOOL_CALLS = 10;

// LangGraph counts super-steps, not tool calls, and defaults to 25, so an operator budget (1-50) could
// be unreachable: one round of tool call plus tool node is TWO steps, and the turn would die with
// `GraphRecursionError` after its tools had side effects, instead of ending at the budget with text.
// Sized to the budget: `2 * max` for the rounds, `+1` for the final answer, `+3` for entry and exit.
// Never below LangGraph's default, so a small budget keeps that room.
export function recursionLimitFor(maxToolCalls?: number): number {
  return Math.max(25, 2 * (maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS) + 4);
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

// True when the model's most recent act was deciding NOT to answer through `skip_reply` (also how a
// follow-up says so), so the soft wrap-up ("Conclua agora: responda ao cliente") must not land on the
// round after it, which a small `maxToolCalls` crosses on that very round. The COUNT is left alone:
// the cap still has to bound a model that calls skip_reply in a loop.
function justDecidedToStaySilent(history: BaseMessage[]): boolean {
  return lastBatch(history).skipped;
}

// The turn's batches, newest first, each carrying what the decision needs, in ONE scan so the three
// questions cannot disagree about where a batch starts:
//   `skipped`: the model chose silence, which suppresses the wrap-up instruction;
//   `alone`: the decision is ALL it did, which makes the turn silent;
//   `caller`: the AI message that requested the batch, whose text is taken back out.
// `skipped` and `alone` differ on a PARALLEL batch, so they cannot be merged.
type Batch = { skipped: boolean; alone: boolean; caller: BaseMessage | null };

function turnBatches(history: BaseMessage[]): Batch[] {
  const out: Batch[] = [];
  let sawTool = false;
  let skipped = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const t = m?.getType();
    // NOTE: the turn starts at the last human message: a batch from an EARLIER turn is not this one's.
    if (t === "human") break;
    if (t === "tool") {
      // NOTE: the CONTIGUOUS batch, not the last message: a model can emit parallel calls (`skip_reply`
      // alongside `react_to_message`, the documented way to answer with a reaction alone), and which
      // result lands last is an ordering accident.
      sawTool = true;
      // NOTE: the ACK, not the name. A precondition on `skip_reply` returns a normal tool result under
      // that same name saying the call did NOT run; read by name, an operator's own guard would end the
      // turn with no text where the customer is waiting for one. `skipReplyRan` recognises our no-op
      // and nothing else, so anything unrecognised falls through to "answer them".
      if (skipReplyRan(m as Parameters<typeof skipReplyRan>[0])) skipped = true;
      continue;
    }
    // NOTE: the batch ends at the AI message that requested it; anything before is an earlier round.
    if (sawTool) {
      out.push({ skipped, alone: onlySkipped(m), caller: m ?? null });
      sawTool = false;
      skipped = false;
    }
  }
  return out;
}

function lastBatch(history: BaseMessage[]): Batch {
  return (
    turnBatches(history)[0] ?? { skipped: false, alone: false, caller: null }
  );
}

// Whether this turn decided silence on its own anywhere since the last human message (unlike
// `justDecidedToStaySilent`, which reads the last batch). A lone `skip_reply` does not END the turn:
// a prompt that forbids parallel calls with `skip_reply` named first would otherwise lose every step
// the operator asked for after the decision, and no prompt wording fixes that ordering. So the turn
// continues and the decision sticks: the wrap-up stays suppressed, the hard limit stops forcing an
// answer, and the final text is taken out in code. Read over the whole turn because the batch after
// the decision is the operator's `resolve_conversation`. ALONE is the scope: in a parallel batch a
// companion that failed gives the model something to change its mind about, so it may answer.
function decidedToStaySilentAlone(history: BaseMessage[]): boolean {
  return turnBatches(history).some((b) => b.skipped && b.alone);
}

// Every call the last assistant turn asked for already has its answer in this turn's history, so the
// tools step will produce nothing and the round after it sees exactly what this one saw. See the
// call site for why this is asked of the calls and not of the step's output.
function repeatsAnsweredCalls(history: BaseMessage[]): boolean {
  // No check on the message TYPE: only an assistant turn carries `tool_calls`, so anything else
  // falls out at the empty list below.
  const calls = (history.at(-1) as AIMessage | undefined)?.tool_calls ?? [];
  if (calls.length === 0) return false;
  // THIS TURN'S answers, and the bound is load-bearing: a call id is only unique within the
  // request that minted it, and a model that reuses one across turns (a stub reusing `call_attr`, a
  // provider numbering from zero) would otherwise look like it was repeating a call it never made here.
  const answered = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.getType() === "human") break;
    if (m?.getType() !== "tool") continue;
    const id = (m as { tool_call_id?: string }).tool_call_id;
    if (typeof id === "string") answered.add(id);
  }
  // NOTE: `every` is the claim being made (nothing new can come of this batch). `some` behaves the same
  // today, since a batch that mints a new id gets it run and the last message is then no longer this
  // assistant turn, but that rests on `ToolNode` skipping only the answered call rather than the step.
  return calls.every((c) => typeof c.id === "string" && answered.has(c.id));
}

// The repeated batch is taken OUT of the channel. `ToolNode` answered none of its calls (every id
// already had an answer, which is what the stall is), so it would stay as an assistant turn with
// unanswered `tool_call_id`s that `isEmptyAssistantTurn` keeps, and the next customer turn would hand
// OpenAI and Anthropic a history both refuse. Nothing is lost: it repeats a batch still in the history
// with its results, and text written beside it was never delivered.
function dropRepeatedBatch(history: BaseMessage[]): BaseMessage[] {
  const id = history.at(-1)?.id;
  return typeof id === "string" ? [new RemoveMessage({ id })] : [];
}

// The turn still has to end: what stops a model that answers every round with the same lone
// `skip_reply` is the SECOND one, since asked again after deciding alone it did nothing new. The
// budget bounds it too, but later and through a path built for another purpose. A parallel batch
// followed by a lone `skip_reply` costs one round more, and that round is where the operator's
// remaining step runs.
function reaffirmedSilenceAlone(history: BaseMessage[]): boolean {
  const [last, previous] = turnBatches(history);
  return (
    last?.skipped === true &&
    last.alone &&
    previous?.skipped === true &&
    previous.alone
  );
}

// Whether the decision was the whole of what the model did, read off the CALLS, not their results.
// A tool can decline through an ordinary success result (business refusals must not use `toolFailure`,
// per `failure.ts`: `react_to_message` on a reaction, `send_image` on a disallowed host), and telling
// those apart would need a per-tool "did nothing" contract every future tool would silently fail to
// join. So, like `actedOnTheWorld`, a batch that called ANYTHING else gave the model unseen
// information and it decides again. The cost: `react_to_message` + `skip_reply` takes one more round,
// where a reaction that did not happen lets the model answer the customer.
function onlySkipped(caller: BaseMessage | undefined): boolean {
  const ai = caller as AIMessage | undefined;
  const calls = ai?.tool_calls ?? [];
  // NOTE: invalid calls count as companions. A provider can emit a good `skip_reply` beside a call
  // whose arguments do not parse, which LangChain files under `invalid_tool_calls`; reading
  // `tool_calls` alone would end the turn and deny the model the round where it sees the failure.
  if ((ai?.invalid_tool_calls?.length ?? 0) > 0) return false;
  return calls.length > 0 && calls.every((c) => c.name === SKIP_REPLY_TOOL);
}

// The message's blocks with the TEXT taken out and everything else left alone. A string collapses to
// an empty list (there was nothing but text in it); an array keeps every block that is not text,
// which is what carries Anthropic's signed `thinking` / `redacted_thinking` through unchanged.
function textlessContent(content: MessageContent): MessageContent {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b) => typeof b !== "string" && (b as { type?: unknown }).type !== "text",
  ) as MessageContent;
}

// ...and the raw provider output, because `@langchain/openai` replays the Responses API's `output`
// array from `response_metadata`, so blanking `content` alone would still hand the narration back.
// Only the PART type decides: `function_call` carries arguments as a string and `reasoning` carries
// `reasoning_text` parts, so a check on the ITEM type would be a condition no fixture can tell from
// its absence. An adapter that keeps no `output` array pays nothing.
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
    // NOTE: an item that was nothing but text goes with it: left with an empty content array, the
    // replay is rejected like Anthropic's empty text block, and the round a companion bought fails.
    // Dropped only when the filter emptied it; an item that arrived empty is the provider's own.
    if (before.length > 0 && after.length === 0) return [];
    return [{ ...(item as object), content: after }];
  });
  return { ...meta, output: rewritten };
}

// The last word of a silent turn, taken out here instead of being the model's to withhold: the turn
// does not end ON the decision, so the posted message is whatever the model wrote in the round after.
// Removes the TEXT and nothing else, as `silenceNarration` does: `thinking` blocks are signed protocol
// data, and usage is what the turn is billed by.
function withoutText(message: BaseMessage): BaseMessage {
  const ai = message as AIMessage;
  // NOTE: no tool calls carried, unlike `silenceNarration`: this is only handed the message that ENDS
  // the turn, which requests none, so the difference is unreachable and not written.
  return new AIMessage({
    ...(typeof ai.id === "string" ? { id: ai.id } : {}),
    content: textlessContent(ai.content),
    additional_kwargs: ai.additional_kwargs,
    response_metadata: textlessResponseMetadata(ai.response_metadata),
    ...(ai.usage_metadata ? { usage_metadata: ai.usage_metadata } : {}),
    ...(ai.name ? { name: ai.name } : {}),
  });
}

// What the model wrote beside the decision, taken back out. Text in the message that calls
// `skip_reply` is never delivered (the runtime posts the LAST assistant message), so left in the
// channel it is a sentence the customer never saw that the next turn reads as told: the false memory
// `refused-turn.ts` prevents. Scoped to the decision: a preamble beside an ordinary call may be leaned
// on by the reply. Replaced by ID with everything but the content carried: the tool calls, since an
// orphaned `tool_call_id` is a provider error, and the metadata, since a rebuild drops usage and
// response fields. No "already empty" shortcut: that branch would be a condition no test could see.
function silenceNarration(history: BaseMessage[]): BaseMessage[] {
  const { caller } = lastBatch(history);
  if (!caller || typeof caller.id !== "string") return [];
  const ai = caller as AIMessage;
  return [
    new AIMessage({
      id: ai.id,
      // NOTE: a block list without the text, never `""` and never a blanket `[]`. Not `""`: this
      // message keeps its tool calls, so `isEmptyAssistantTurn` leaves it in the prompt, and
      // `@langchain/anthropic` renders a string as a text block Anthropic refuses when empty. Not `[]`:
      // Anthropic's signed `thinking`/`redacted_thinking` must be replayed unchanged before the tool
      // result they precede, or the next round fails at the provider.
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

// Providers whose adapter re-serializes their own non-text blocks. `@langchain/openai` filters an
// assistant message to text blocks, so an Anthropic `thinking` block sent to OpenAI after a provider
// switch or fallback arrives as `content: []` and is refused, stopping the thread. So a turn is kept
// only when its block came from a member AND every model that can receive it is that provider;
// otherwise it is dropped, which costs context and never breaks a thread. A provider added to
// `models.ts` does not join by default: membership is earned by reading how its adapter builds an
// assistant message from a `content` array.
const REPLAYS_OWN_BLOCKS: ReadonlySet<string> = new Set(["anthropic"]);

// Providers that take a system message AFTER the history and keep it there, read by the tool budget's
// wrap-up, the one system message the node sends anywhere but first. Membership is earned by what the
// vendor accepts: `openai` keeps it in place on both adapter paths (sent as `developer` on GPT-5), the
// cache still reads, and it ignores `baseURL` so it points nowhere else. The Google and Anthropic
// adapters throw on it; `openai-compatible` and `openrouter` reach servers whose rules are unknown, so
// for them the instruction stays in the prompt.
const LATE_SYSTEM_MESSAGE: ReadonlySet<string> = new Set(["openai"]);

// An assistant turn that said nothing and did nothing (the terminal marker, or the empty message a
// model returns when told to produce none), dropped from what the model is SENT, never from the
// channel, where the marker keeps `lastAssistantText` reading "" rather than the skip tool's ack.
// Kept, it breaks Anthropic, which refuses an empty text block. A message with tool_calls is never
// this (removing it orphans every `tool_call_id` after it). One with only `invalid_tool_calls` is: no
// `ToolMessage` ever answers it and `@langchain/openai` replays the raw calls, so keeping it gets every
// later turn rejected. Non-text blocks (signed `thinking`) are output, not absence, and are kept only
// where they survive the trip (see `REPLAYS_OWN_BLOCKS`).
function isEmptyAssistantTurn(
  m: BaseMessage,
  destinations: ReadonlySet<string>,
): boolean {
  if (m.getType() !== "ai") return false;
  const ai = m as AIMessage;
  if ((ai.tool_calls?.length ?? 0) > 0) return false;
  if (Array.isArray(ai.content) && textlessContent(ai.content).length > 0) {
    const origin = ai.response_metadata?.model_provider;
    const survives =
      typeof origin === "string" &&
      REPLAYS_OWN_BLOCKS.has(origin) &&
      destinations.size > 0 &&
      [...destinations].every((d) => d === origin);
    if (survives) return false;
  }
  return contentToText(ai.content).trim() === "";
}

// Applies the per-agent history ceiling, if there is one. Best-effort: trimming must never cost a
// customer their answer, so a throw falls back to the full history. Counted AS SENT: with dates on,
// each person's message carries a date prefix that dominates a history of short messages, so counting
// stored text would let a ceiling set against the provider's limit pass about twice that. The window
// still keeps the STORED messages; the date is rendered on the way out.
function applyHistoryCeiling(
  full: BaseMessage[],
  maxHistoryTokens: number | null | undefined,
  onHistoryTrim: BuildAgentGraphParams["onHistoryTrim"],
  historyDates?: { timezone: string } | null,
): BaseMessage[] {
  if (!maxHistoryTokens) return full;
  try {
    const count = historyDates
      ? (m: BaseMessage) =>
          countMessageTokens(
            datedHistory([m], historyDates.timezone)[0] as BaseMessage,
          )
      : countMessageTokens;
    const window = selectHistoryWindow(full, maxHistoryTokens, count);
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
  onModelPermitWait,
  primary,
  fallback,
  onModelFallback,
  onModelFallbackFailed,
  maxHistoryTokens,
  historyDates,
  onHistoryTrim,
  stillWanted,
  noReplyChannel,
  spokenNotice,
  primaryDeadlineMs,
  signal: jobSignal,
  retrySilence,
  onSilenceRetry,
}: BuildAgentGraphParams) {
  const hasTools = !!tools && tools.length > 0;
  const llm = hasTools ? (model.bindTools?.(tools) ?? model) : model;
  // Bound to the SAME toolset, or the fallback would answer a question the primary was asked
  // with tools it cannot call; the tool-call budget below counts calls, not models.
  const fallbackLlm =
    fallback && hasTools
      ? (fallback.model.bindTools?.(tools) ?? fallback.model)
      : fallback?.model;
  const max = maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;

  // Every model that can receive this turn's history, not just the one that starts it: the
  // fallback takes over mid-invocation and is handed the same array, so a turn kept for the primary
  // alone would reach the second vendor unrenderable. See `isEmptyAssistantTurn`.
  const destinations: ReadonlySet<string> = new Set(
    [primary.provider, fallback?.provider].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    ),
  );
  // EVERY destination, for the same reason as above: the fallback is handed the same messages.
  const lateSystemAccepted =
    destinations.size > 0 &&
    [...destinations].every((d) => LATE_SYSTEM_MESSAGE.has(d));

  // Once the fallback has the turn, it keeps it. A tool call routes back through this node, and
  // asking the failing primary again every round would add a warn and up to its full deadline PER
  // ROUND, defeating the fallback's point. A closure, not a state channel: this graph is built inside
  // the turn and invoked once, so the variable IS "this invocation", while graph state would persist
  // through the checkpointer and demote the primary for every later turn on the conversation.
  let fallbackHasTheTurn = false;

  // Once per turn, by the same closure argument. The cap is one EVENT whose handlers write an
  // operator line and can page, but it can be reached twice: a parallel batch with `skip_reply` is not
  // terminal and `skip_reply` stays bound at the cap, so the reaffirmation round re-enters the terminal
  // branch and would report it again with a bigger count.
  let toolLimitReported = false;
  // Once per turn, by the same closure argument: the silence retry runs at most once in this
  // invocation, however many rounds follow it.
  let silenceRetried = false;
  const reportToolLimit = (info: {
    maxToolCalls: number;
    toolCalls: number;
  }) => {
    if (toolLimitReported) return;
    toolLimitReported = true;
    onToolLimit?.(info);
  };

  const agentNodeBody = async (state: typeof MessagesAnnotation.State) => {
    // Exactly one system message, and it must be first: prepend the configured prompt and drop
    // any that leaked into the history (a nudge persisted as a SystemMessage). Google rejects a second
    // one ("System messages are only permitted as the first passed message"). The one exception is
    // sent, never persisted, and only where it is accepted: see `LATE_SYSTEM_MESSAGE`.
    const full = state.messages.filter(
      (m) => m.getType() !== "system" && !isEmptyAssistantTurn(m, destinations),
    );

    // Bound the history BEFORE the tool-call budget below, so both read the same window. The
    // window always keeps the last human message and everything after it, so the tool count is not
    // affected by the trim; this ordering is about the two never disagreeing.
    const history = applyHistoryCeiling(
      full,
      maxHistoryTokens,
      onHistoryTrim,
      historyDates,
    );

    // Tool-call budget for this turn. Hard limit reached: invoke the RAW model (no tools bound),
    // so the response carries no tool_calls and toolsCondition routes to END. Approaching it (N-2):
    // append a "wrap up" instruction but keep tools available for the imprescindible case.
    const toolCalls = hasTools ? toolCallsSinceLastHuman(history) : 0;
    const hardLimit = hasTools && toolCalls >= max;
    const staySilent = hasTools && justDecidedToStaySilent(history);
    // The decision, taken alone, for the REST of the turn (see the function).
    const silentTurn = hasTools && decidedToStaySilentAlone(history);
    // Only the message that ends the turn, the one carrying no calls: a message still requesting
    // tools is not what the runtime posts, and a preamble beside an ordinary call is left alone (the
    // same line `silenceNarration` draws). `narration` covers the text beside the decision itself.
    const silenced = (m: BaseMessage): BaseMessage =>
      silentTurn && ((m as AIMessage).tool_calls?.length ?? 0) === 0
        ? withoutText(m)
        : m;
    // The decision sticks without ending the turn: `silentTurn` keeps the wrap-up suppressed,
    // stops the hard limit forcing an answer, and takes the final text out in code. The count is
    // untouched, which bounds a model looping on `skip_reply`: at the budget the raw model runs with
    // no tools, so `toolsCondition` routes to END. The narration is blanked the moment the decision is
    // seen: on a PARALLEL batch the calling message is not the end of the turn, and a companion's
    // extra round would leave it standing. Undelivered either way: the runtime posts the LAST message.
    const narration = staySilent ? silenceNarration(history) : [];
    // The turn ends where the information ends, in three cases. A lone `skip_reply` asked for
    // again right after one adds nothing a further round could act on (see `reaffirmedSilenceAlone`).
    // A turn that decided silence alone and spent its budget can neither act nor speak, so a model call
    // would only buy text this path blanks. And the stall: `ToolNode` skips a call whose id already has
    // an answer, so a verbatim repeat gets no result and is asked again forever (the budget counts
    // RESULTS). Asked of the CALLS, not the step's output: an empty step still leaves the model free to
    // reply, which a `/reset` landing mid-turn relies on.
    const stalled = repeatsAnsweredCalls(history);
    if (
      stalled ||
      reaffirmedSilenceAlone(history) ||
      (silentTurn && hardLimit)
    ) {
      if (hardLimit) reportToolLimit({ maxToolCalls: max, toolCalls });
      return {
        messages: [
          ...narration,
          ...(stalled ? dropRepeatedBatch(history) : []),
          new AIMessage(""),
        ],
      };
    }
    // `staySilent` is needed here: on a PARALLEL batch there IS a round after the decision, and
    // "Conclua agora: responda ao cliente" is the exact opposite of what the model just chose.
    const softLimit =
      hasTools &&
      !hardLimit &&
      !staySilent &&
      // NOTE: and for the rest of a turn that decided silence alone: the decision still stands two
      // rounds later, and the wrap-up would be arguing with it.
      !silentTurn &&
      toolCalls >= Math.max(1, max - 2);

    // On an observation the budget is the same, but the sentence after it says what the turn can
    // still do: the wrap-up exists to land the turn, and an instruction the frame forbids is one the
    // model has to argue with first.
    const wrapUpText = noReplyChannel
      ? `[Sistema] Você já usou ${toolCalls} de ${max} ferramentas permitidas neste turno. Conclua agora: se ainda falta registrar algo, use a última ferramenta; se não, encerre sem escrever nada.`
      : `[Sistema] Você já usou ${toolCalls} de ${max} ferramentas permitidas neste turno. Conclua agora: responda ao cliente com as informações que já tem. Só use outra ferramenta se for absolutamente imprescindível.`;
    // The spoken-reply notice rides with the wrap-up, first. Only the callers that deliver a reply
    // which can be spoken pass one, so an observation never carries it.
    const noticeText = spokenNotice?.()?.trim();
    const notice = noticeText ? [noticeText] : [];
    const lateTexts = [...notice, ...(softLimit ? [wrapUpText] : [])];
    // The wrap-up travels after the history where every destination takes a system message
    // there, inside the system prompt elsewhere, and in a human message never. After the history keeps
    // the cached prefix: a line appended to the system prompt changes the prefix at the first message,
    // and the round pays a cache WRITE on the whole prompt where a read was available. A SYSTEM message
    // keeps it an instruction: a customer can type "[Sistema] ..." but cannot forge the role, and a
    // real instruction in a human message would teach the model to obey the customer's copy.
    const prompt = lateSystemAccepted
      ? systemPrompt
      : [systemPrompt, ...lateTexts].join("\n\n");
    const wrapUp = lateSystemAccepted
      ? lateTexts.map((t) => new SystemMessage(t))
      : [];
    if (hardLimit) {
      reportToolLimit({ maxToolCalls: max, toolCalls });
    }
    // The hard limit must not talk a decision out of itself. Its path invokes the model with no
    // tools to force a text answer, and a parallel batch with `skip_reply` is not terminal, so a model
    // that chose silence could be made to write. So the budget keeps `skip_reply` alone bound: the
    // model sees the companion's result and either reaffirms silence (terminal, so no loop) or answers,
    // which the customer needs when the companion failed. A turn that decided silence ALONE takes no
    // tools and already returned above, which is why no `!silentTurn` term is needed here.
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

    // SENT without the narration, not merely persisted without it: the blanking above is a
    // reducer update that lands AFTER this call, so a parallel batch's extra round would reach the model
    // still carrying the sentence the customer never received, for it to lean on or repeat.
    const sent = narration.length
      ? history.map((m) => narration.find((n) => n.id === m.id) ?? m)
      : history;
    // Dated on the way out; the window above already counted each message with its date.
    const shown = historyDates
      ? datedHistory(sent, historyDates.timezone)
      : sent;
    const messages = [new SystemMessage(prompt), ...shown, ...wrapUp];
    // The SAME question, to the other provider, when there is one. Same messages and same prompt:
    // this is not a second, cheaper attempt, it is the attempt the customer is waiting for.
    const secondFor = (msgs: BaseMessage[]) =>
      fallback && fallbackLlm
        ? {
            labels: { provider: fallback.provider, model: fallback.modelId },
            // The same 45 s the fallback's SDK is given, held by the race on an adapter that drops it.
            deadlineMs: fallback.deadlineMs ?? PRIMARY_TIMEOUT_MS,
            run: (deadline: AbortSignal) => {
              // NOTE: a primary ended by the job's deadline reads as a timeout, which is what hands
              // the turn to the fallback; after the deadline there is no turn to hand.
              if (jobSignal?.aborted) return Promise.reject(jobSignal.reason);
              const signal = jobSignal
                ? AbortSignal.any([deadline, jobSignal])
                : deadline;
              return (
                hardLimit ? (cappedFallback ?? fallback.model) : fallbackLlm
              ).invoke(msgs, {
                signal,
                // NOTE: metadata rather than callbacks: metadata MERGES with the turn's handlers,
                // while `callbacks` replaces them, which would bill this call to the primary's name or
                // drop the Langfuse trace.
                metadata: {
                  [USAGE_MODEL_METADATA_KEY]: fallback.modelId,
                  [USAGE_PROVIDER_METADATA_KEY]: fallback.provider,
                },
              });
            },
          }
        : null;

    // One question to the model, the fallback's rules included. A function because the silence
    // retry below asks it a second time, with different messages, under the same rules.
    const ask = async (msgs: BaseMessage[]): Promise<BaseMessage> => {
      const second = secondFor(msgs);
      // Already demoted this invocation: the fallback IS the model now, so it gets the
      // empty-completion retry under its own name, and a failure of its own is reported as that
      // rather than as a second failover the operator never caused.
      if (second && fallbackHasTheTurn) {
        try {
          return await runModelCall(second.run, {
            deadlineMs: second.deadlineMs,
            signal: jobSignal,
            primary: second.labels,
            onRetry: onModelRetry,
            onPermitWait: onModelPermitWait,
          });
        } catch (err) {
          // NOTE: a call the job's deadline ended failed on the job, not on the provider.
          if (!jobSignal?.aborted) {
            onModelFallbackFailed?.({
              ...second.labels,
              reason: err instanceof Error ? err.message : "provider error",
            });
          }
          throw err;
        }
      }

      const primaryLlm = hardLimit ? capped : llm;
      // NOTE: an explicit `signal` REPLACES the one LangGraph propagates to this call instead of
      // joining it. The job's deadline is joined here with the call's own, which `runModelCall` hands
      // in, so a deadline that ends the job ends this call too.
      return runModelCall(
        (deadline) => {
          // NOTE: a job past its deadline starts no primary call, which a permit wait or a slow tool
          // can otherwise reach with the signal already aborted: an adapter that ignores the signal
          // would still bill a reply nobody can deliver.
          if (jobSignal?.aborted) return Promise.reject(jobSignal.reason);
          const signal = jobSignal
            ? AbortSignal.any([deadline, jobSignal])
            : deadline;
          return primaryLlm.invoke(msgs, { signal });
        },
        {
          deadlineMs: primaryDeadlineMs,
          signal: jobSignal,
          primary,
          onRetry: onModelRetry,
          onPermitWait: onModelPermitWait,
          fallback: second
            ? {
                labels: second.labels,
                run: second.run,
                deadlineMs: second.deadlineMs,
                // NOTE: after the job's deadline no fallback starts (see `second.run`), so there is no
                // failover to report and no failed provider: the primary failed on the job's deadline.
                onFallback: ({ reason }) => {
                  if (jobSignal?.aborted) return;
                  fallbackHasTheTurn = true;
                  onModelFallback?.({ ...second.labels, reason });
                },
                onFallbackFailed: ({ reason }) => {
                  if (jobSignal?.aborted) return;
                  onModelFallbackFailed?.({ ...second.labels, reason });
                },
              }
            : undefined,
        },
      );
    };

    let response = await ask(messages);
    // NOTE: the unexplained silence, asked once more. Only a final answer that says nothing: no text,
    // no calls, in a turn that declared no silence (`calledSkipThisTurn` covers the round right after
    // the decision too), whose reply the model did not already write beside a tool call (that one is
    // delivered as is), and not at the hard limit, where the model runs without the tools the
    // instruction names. The caller's predicate is asked last, at the moment it would run: it knows
    // what this node cannot (a transfer that completed, something already delivered).
    if (
      retrySilence &&
      !silenceRetried &&
      !noReplyChannel &&
      !hardLimit &&
      saidNothing(response) &&
      !calledSkipThisTurn(history) &&
      replyWrittenThisTurn([...history, response]) === "" &&
      retrySilence()
    ) {
      silenceRetried = true;
      const canSkip = (tools ?? []).some((t) => t.name === SKIP_REPLY_TOOL);
      const text = silenceRetryText(canSkip);
      // It travels where the tool budget's wrap-up does, for the same reasons: after the history
      // as a system message where every destination keeps one there, inside the one system prompt
      // everywhere else, and in a human message never. The empty answer is NOT sent back: it said
      // nothing, and an empty assistant turn is the shape some providers refuse. Neither is persisted:
      // only the second answer returns to the thread.
      const retried = lateSystemAccepted
        ? [...messages, new SystemMessage(text)]
        : [new SystemMessage(`${prompt}\n\n${text}`), ...shown, ...wrapUp];
      response = await ask(retried);
      onSilenceRetry?.({ outcome: silenceRetryOutcome(response) });
    }
    return { messages: [...narration, silenced(response)] };
  };

  // The node as the graph runs it. A model call ended by the job's deadline fails with whatever
  // the provider layer made of the abort ("timeout", or "provider error"); the run is reported with
  // the job's own error instead, which is ours to publish and names the deadline.
  const agentNode = async (state: typeof MessagesAnnotation.State) => {
    try {
      return await agentNodeBody(state);
    } catch (err) {
      if (jobSignal?.aborted && jobSignal.reason instanceof Error) {
        throw jobSignal.reason;
      }
      throw err;
    }
  };

  // Once per turn, the same closure argument the flags above make. It says the tool boundary
  // refused this turn's calls, which is what routes the graph to END instead of back to the model.
  let calledOffAtTools = false;
  const toolNode = hasTools ? new ToolNode(tools) : null;

  // The refusal is a tool result, and the turn ends on it. Routing away from the tool node would
  // leave `tool_calls` no `ToolMessage` answers, which `@langchain/openai` replays so the vendor
  // rejects every later turn; answering "refused" into the model invites it to call again up to the
  // recursion limit. It refuses by RETURNING: the assistant turn with the calls is already
  // checkpointed, so a throw leaves exactly that unanswered call, and several fences throw on a
  // database transient whatever the strictness (./reset-episode.ts reserves throwing for seams asked
  // before anything is written). An unreadable mark lets the tools run, the same trade the sends make.
  const refuseCalledOffCalls = async (
    state: typeof MessagesAnnotation.State,
  ): Promise<{ messages: BaseMessage[] } | null> => {
    if (!stillWanted && !jobSignal) return null;
    // No guard on an empty list: `toolsCondition` routes here only when the last message is an
    // assistant turn carrying tool calls.
    const last = state.messages.at(-1);
    const calls =
      last?.getType() === "ai" ? ((last as AIMessage).tool_calls ?? []) : [];
    const fenceSays = !stillWanted
      ? true
      : await stillWanted().catch((err) => {
          logger.warn(
            { err },
            "graph: could not read whether the turn is still wanted; letting its tool calls run",
          );
          return true;
        });
    // A run its job's deadline ended is called off like any other, and it is read AFTER the
    // fence, whose reads are the stretch a deadline can fire in.
    const wanted = fenceSays && !jobSignal?.aborted;
    if (wanted) return null;
    calledOffAtTools = true;
    logger.info(
      "graph: the turn was called off mid-invoke, so %d tool call(s) were refused instead of run",
      calls.length,
    );
    // NOTE: and an empty assistant turn after them. The runtime reads the reply off the LAST message
    // whatever its type (`lastAssistantText`), so ending on a `ToolMessage` offers the refusal's text
    // to post. The send gate refuses it, but not every fence is monotonic (the channel-redirect one
    // answers TRUE again once an agent is re-enabled), so the empty terminator, the one the silence
    // protocol ends on, makes the refusal unpostable by construction.
    return {
      messages: [...calls.map(calledOffToolResult), new AIMessage("")],
    };
  };

  const builder = new StateGraph(MessagesAnnotation)
    .addNode("agent", agentNode)
    .addEdge(START, "agent");

  if (hasTools) {
    builder
      // NOTE: every tool goes through here, which is why the guard lives at the node: native, HTTP,
      // MCP, integrations and documents are all assembled into this one list, and a per-tool guard is
      // one the next tool added would simply not have.
      .addNode("tools", async (state: typeof MessagesAnnotation.State) => {
        const refused = await refuseCalledOffCalls(state);
        // biome-ignore lint/style/noNonNullAssertion: hasTools is what built it.
        return refused ?? (await toolNode!.invoke(state));
      })
      // toolsCondition routes to "tools" when the last AIMessage has tool calls, else to END.
      .addConditionalEdges("agent", toolsCondition)
      .addConditionalEdges("tools", () => (calledOffAtTools ? END : "agent"), [
        END,
        "agent",
      ]);
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

// The reply the model already wrote, when the turn ends on an empty message. A model can put its
// whole answer in the message that calls a tool (`resolve_conversation`, `set_labels`,
// `private_note`) and close the turn with an empty one, and `lastAssistantText` reads only the LAST.
// The final message is not read here: the caller asks its own guarded draft. Returns "" when no
// earlier assistant message IN THIS TURN (bounded at the last human message, since an earlier turn's
// answer was delivered then) has text, or when the turn called `skip_reply`: a declared silence is
// never overridden, and it is read from the CALL, since a refused `skip_reply` still meant silence.
// The LAST earlier text wins: it is the latest thing the model meant to say.
export function replyWrittenThisTurn(messages: BaseMessage[]): string {
  let found = "";
  for (let i = messages.length - 2; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.getType() === "human") break;
    if (m.getType() !== "ai") continue;
    const ai = m as AIMessage;
    if ((ai.tool_calls ?? []).some((c) => c.name === SKIP_REPLY_TOOL))
      return "";
    if (!found) found = contentToText(ai.content).trim();
  }
  return found;
}

// The retry of an unexplained silence, the helpers the agent node asks.
//
// A final answer that says nothing: no text and no tool call. A call the provider could not parse
// (`invalid_tool_calls`) counts as nothing too: no tool runs for it and the turn ends there, so the
// customer is exactly as unanswered, and the retry is the model's one chance to act properly.
function saidNothing(m: BaseMessage): boolean {
  const ai = m as AIMessage;
  if ((ai.tool_calls?.length ?? 0) > 0) return false;
  return contentToText(ai.content).trim() === "";
}

// Whether this turn already DECLARED silence, bounded at the last human message like
// `replyWrittenThisTurn`: an earlier "ok" answered with `skip_reply` is in this thread, and a
// decision taken then says nothing about now. Read from the CALL, the conservative side: a refused
// `skip_reply` is still the model choosing to say nothing, and a retry would argue with it.
function calledSkipThisTurn(history: BaseMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) continue;
    if (m.getType() === "human") return false;
    if (m.getType() !== "ai") continue;
    if (
      ((m as AIMessage).tool_calls ?? []).some(
        (c) => c.name === SKIP_REPLY_TOOL,
      )
    )
      return true;
  }
  return false;
}

// Both exits, named, and the second one is the point: most of these silences follow a thank-you and
// are RIGHT, only undeclared, while a few are customers owed an answer. An instruction that only said
// "answer" would turn the first group into replies nobody asked for, so it names the silence as an
// equal exit and says what separates the two. Where `skip_reply` is not granted there is only one exit
// to name, and a turn that stays empty after it ends empty.
function silenceRetryText(canSkip: boolean): string {
  return canSkip
    ? `${SILENCE_RETRY_MARK} e sem \`skip_reply\`, e um turno assim deixa o cliente sem saber se foi atendido. Decida agora, uma coisa só: se a última mensagem do cliente pede ou espera algo de você, responda; se não há nada a dizer (um agradecimento, um ok, uma despedida), chame \`skip_reply\` com o motivo. Não escreva só para não ficar em silêncio.`
    : `${SILENCE_RETRY_MARK}. Decida agora: se a última mensagem do cliente pede ou espera algo de você, responda; se não há nada a dizer, encerre sem escrever nada.`;
}

// A batch that CONTAINS `skip_reply` is a declared silence, alone or beside other calls (a model
// declares it next to `resolve_conversation`). Read here from the call, because the tool has not run
// yet; the runtime confirms it from the tool's MARK once it has (see its `onSilenceRetry`), so a
// `skip_reply` a precondition refused is not reported as a silence the model chose.
function silenceRetryOutcome(m: BaseMessage): SilenceRetryOutcome {
  const calls = (m as AIMessage).tool_calls ?? [];
  if (calls.length > 0)
    return calls.some((c) => c.name === SKIP_REPLY_TOOL)
      ? "skip_reply"
      : "tools";
  return contentToText(m.content).trim() ? "answered" : "empty";
}
