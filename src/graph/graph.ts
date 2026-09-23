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
import { selectHistoryWindow } from "@/graph/history-window";
import { contentToText } from "@/graph/message-text";
import {
  callWithDeadline,
  type ModelLabels,
  type ModelRetryInfo,
  runModelCall,
} from "@/graph/model-limit";
import { countMessageTokens } from "@/graph/token-count";
import { USAGE_MODEL_METADATA_KEY } from "@/graph/usage";
import { calledOffToolResult } from "./markers";
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
  // THE TURN'S OWN "IS THIS STILL WANTED", ASKED AT THE TOOL BOUNDARY (issue #449).
  //
  // The runtime asks it at every seam it owns — before the divider, after the claim, before the
  // invoke, and at each outward write — and the one stretch none of those covers is INSIDE the
  // invoke, because a tool call happens within a step rather than between two. So a `/reset` landing
  // once the model call is in flight is refused on its memory step, says so, clears everything else
  // it can reach, and then this graph's tools write an attribute, a label and a kanban card back
  // onto the conversation the operator was just told about.
  //
  // NO `strict` HERE, and its absence is the contract rather than a simplification. Everywhere else
  // that option chooses whether an unreadable answer STOPS the run by throwing, and this seam cannot
  // be stopped that way: see `refuseCalledOffCalls`. So it asks one question with two answers, the
  // caller binds the strictness it wants, and an error is not one of the answers.
  //
  // Absent for every caller with nothing to call the run off — the playground, and any caller that
  // scheduled no work — and absent means the tool node behaves exactly as it did. Both the reactive
  // turn and the NUDGE pass one: a nudge runs from a job that `/reset` retires, which is the same
  // withdrawal by another route (review round 1 found the nudge missing here).
  stillWanted?: () => Promise<boolean>;
  // A TURN WITH NO REPLY CHANNEL, which is an observation (issue #629). Its frame says that any text
  // the model writes reaches nobody and its Chatwoot client is muted, so the tool budget's wrap-up
  // telling it to answer the customer contradicts the frame on the very round it lands on — for a
  // watcher at `maxToolCalls: 3`, the round after its first tool call. Measured there: `gpt-5.6-luna`
  // wrote nothing in 15 of 15, while `claude-haiku-4.5` and `gemini-3.5-flash` each argued back in
  // prose that goes nowhere and is paid for by the token. Absent means the ordinary turn, which does
  // answer somebody.
  noReplyChannel?: boolean;
  // The deadline on each call to the PRIMARY, retries included (issue #809). Set exactly when nothing
  // else bounds that call, which is when no fallback was built (see buildModelAndGraph); absent means
  // the call runs as it did.
  primaryDeadlineMs?: number;
}

const DEFAULT_MAX_TOOL_CALLS = 10;

// LANGGRAPH COUNTS SUPER-STEPS, NOT TOOL CALLS, and its default is 25 — so a budget the operator is
// allowed to set (1-50) can be unreachable by the graph that is supposed to honour it. One round of
// "the model calls a tool, the tool node runs it" is TWO steps, so the default runs out after about
// twelve rounds and the turn dies with `GraphRecursionError` instead of ending at the budget with a
// text answer, after the tools it already ran have had their side effects.
//
// Sized to the budget rather than raised to a round number: `2 * max` for the rounds, `+1` for the
// final model call that produces the answer, `+3` of margin for the graph's own entry and exit. It
// never goes BELOW LangGraph's default, so an agent with a small budget keeps the room it has today.
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

// True when the model's most recent act was to decide NOT to answer. `skip_reply` performs nothing
// and IS that decision (since #454 it is also how a follow-up says so), so the soft wrap-up
// instruction must not land on the round after it: "Conclua agora: responda ao cliente" is the exact
// opposite of what the model just chose, and an agent with a small `maxToolCalls` crosses the soft
// limit on that very round. The COUNT is left alone deliberately — the cap still has to bound a model
// that calls skip_reply in a loop.
function justDecidedToStaySilent(history: BaseMessage[]): boolean {
  return lastBatch(history).skipped;
}

// THE TURN'S BATCHES, newest first, each carrying the answers the decision needs. ONE scan, because
// three questions are asked of it and a second walk would be a second chance to disagree about where
// a batch starts:
//
//   `skipped` — the model chose silence, which is what suppresses the wrap-up instruction;
//   `alone`   — the decision is ALL it did, which is what makes the turn silent;
//   `caller`  — the AI message that requested the batch, whose text is taken back out.
//
// The first two are separate because they differ on a PARALLEL batch, and merging them is what
// rounds 17 and 18 of #454 kept finding.
type Batch = { skipped: boolean; alone: boolean; caller: BaseMessage | null };

function turnBatches(history: BaseMessage[]): Batch[] {
  const out: Batch[] = [];
  let sawTool = false;
  let skipped = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const t = m?.getType();
    // The turn starts at the last human message: a batch from an EARLIER turn is not this one's.
    if (t === "human") break;
    if (t === "tool") {
      // NOTE: The CONTIGUOUS batch, not the last message: a model can emit parallel calls (`skip_reply`
      // alongside `react_to_message`, which is the documented way to answer with a reaction alone), and
      // whichever result lands last is an ordering accident. Returning on the first `ToolMessage` read
      // the accident instead of the decision.
      sawTool = true;
      // NOTE: The ACK, not the name. A precondition on `skip_reply` returns a normal tool result under
      // that same name saying the call did NOT run — read by name, an operator's own guard would
      // end the turn with no text where the customer is waiting for one. `skipReplyRan` recognises
      // our no-op and nothing else, so anything unrecognised falls through to "answer them".
      if (skipReplyRan(m as Parameters<typeof skipReplyRan>[0])) skipped = true;
      continue;
    }
    // NOTE: The batch ends at the AI message that requested it — anything before is an earlier round.
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

// DID THIS TURN DECIDE SILENCE ON ITS OWN, anywhere since the last human message — a different
// question from `justDecidedToStaySilent`, and issue #639 is the gap between them.
//
// A LONE `skip_reply` used to END the turn. Ending it and keeping it SILENT are two different
// guarantees, and `docs/graph.md` only ever argued for the second; the first costs the operator
// everything they asked for after the decision, and the shape that reaches it is ordinary — a prompt
// that forbids parallel calls (the agent in the report carries one for `set_labels`, #604) with
// `skip_reply` named before the rest. Measured live on the issue, the two failing cells are exactly
// the two that name it first, and no wording fixes it: the note that takes gpt-5.2 from 0/12 to
// 12/12 does nothing on gpt-5.6-luna, because it asks the model to disobey the operator's ordering.
//
// So the turn continues and the decision STICKS: the wrap-up stays suppressed, the hard limit stops
// trying to force an answer, and the final text is taken out in code rather than being the model's
// to withhold. Read over the whole turn and not off the last batch, because the batch after the
// decision is the operator's `resolve_conversation`, and last-batch semantics would let the turn end
// by writing to the customer — the very hazard the terminal branch existed for.
//
// ALONE, and that word is the scope. A PARALLEL batch does not make the turn silent, because there
// the model has something to change its mind ABOUT: round 18 installed exactly that, so a companion
// that FAILED lets it answer the customer instead. A decision taken by itself rests on nothing that
// could have failed.
function decidedToStaySilentAlone(history: BaseMessage[]): boolean {
  return turnBatches(history).some((b) => b.skipped && b.alone);
}

// …AND THE TURN STILL HAS TO END. With the decision no longer terminal, what stops a model that
// answers every round with the same lone `skip_reply` is the SECOND one: asked again after deciding
// alone, it did nothing new, and no third round can add anything. The budget bounds it too, but far
// later and through a path built for another purpose — this ends it where the information ends.
//
// It is also what keeps round 18's shape: a parallel batch followed by a lone `skip_reply` costs one
// round more than it used to, and that round is the whole fix — it is where the operator's remaining
// step gets to run. A model with nothing left to do spends it and stops.
// Every call the last assistant turn asked for already has its answer in this turn's history, so the
// tools step will produce nothing and the round after it sees exactly what this one saw. See the
// call site for why this is asked of the calls and not of the step's output.
function repeatsAnsweredCalls(history: BaseMessage[]): boolean {
  // No check on the message TYPE, and the mutation battery is why: only an assistant turn carries
  // `tool_calls`, so anything else falls out at the empty list below. A guard for it survived every
  // mutation, which is what a dead condition looks like.
  const calls = (history.at(-1) as AIMessage | undefined)?.tool_calls ?? [];
  if (calls.length === 0) return false;
  // THIS TURN'S answers, and the bound is load-bearing: a call id is only unique within the request
  // that minted it, and a model that reuses one across turns (a stub reusing `call_attr`, a provider
  // numbering from zero) would otherwise look like it was repeating a call it never made here.
  const answered = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.getType() === "human") break;
    if (m?.getType() !== "tool") continue;
    const id = (m as { tool_call_id?: string }).tool_call_id;
    if (typeof id === "string") answered.add(id);
  }
  // `every`, and the mutation battery says `some` behaves identically today: a batch that repeats one
  // id and mints another gets the new one RUN, so the tools step appends a result and the last message
  // is no longer this assistant turn — the function is never consulted with a mixed batch. It is
  // spelled `every` because that is the claim being made (nothing new can come of this batch), and
  // because the equivalence rests on `ToolNode` skipping only the answered call rather than the step.
  return calls.every((c) => typeof c.id === "string" && answered.has(c.id));
}

// The repeated batch is taken OUT of the channel, and this is not tidiness. `ToolNode` answered none
// of its calls — every id already had an answer, which is what the stall IS — so the message stays in
// the history as an assistant turn whose `tool_call_id`s are never answered: `isEmptyAssistantTurn`
// keeps it, because it carries calls, and the NEXT customer turn hands a provider a history OpenAI
// and Anthropic both refuse, which stops the thread answering at all. Found by review round 1 of
// #639, and newly reachable here because a lone `skip_reply` no longer ends the turn before it.
//
// Nothing is lost by removing it: the batch is a verbatim repeat of one still in the history WITH
// its results, and text the model wrote beside it was never delivered (the turn ends on the empty
// message), so leaving it is the sentence-the-customer-never-read hazard this file already avoids.
function dropRepeatedBatch(history: BaseMessage[]): BaseMessage[] {
  const id = history.at(-1)?.id;
  return typeof id === "string" ? [new RemoveMessage({ id })] : [];
}

function reaffirmedSilenceAlone(history: BaseMessage[]): boolean {
  const [last, previous] = turnBatches(history);
  return (
    last?.skipped === true &&
    last.alone &&
    previous?.skipped === true &&
    previous.alone
  );
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

// THE LAST WORD OF A SILENT TURN, taken out here instead of being the model's to withhold (issue
// #639). The turn no longer ends ON the decision, so the message the runtime posts is whatever the
// model wrote in the round after it — and a turn that chose silence writing to the customer is the
// exact hazard the terminal branch existed for. Removing the TEXT and nothing else is the same rule
// `silenceNarration` follows, and for the same reason: `thinking` blocks are signed protocol data,
// and usage is what the turn is billed by.
function withoutText(message: BaseMessage): BaseMessage {
  const ai = message as AIMessage;
  // NO tool calls carried, unlike `silenceNarration`: this one is only ever handed the message that
  // ENDS the turn, which by definition requests nothing. Copying an empty list either way is how a
  // mutation that dropped them stayed green — the difference is unreachable, so it is not written.
  return new AIMessage({
    ...(typeof ai.id === "string" ? { id: ai.id } : {}),
    content: textlessContent(ai.content),
    additional_kwargs: ai.additional_kwargs,
    response_metadata: textlessResponseMetadata(ai.response_metadata),
    ...(ai.usage_metadata ? { usage_metadata: ai.usage_metadata } : {}),
    ...(ai.name ? { name: ai.name } : {}),
  });
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
// orphans every `tool_call_id` after it.
//
// `invalid_tool_calls` is the opposite case, and the asymmetry is the point. A call that failed to
// parse is never executed, so `toolsCondition` ends the graph and no `ToolMessage` ever answers it —
// and `@langchain/openai` stores the RAW calls in `additional_kwargs.tool_calls` and replays those
// whenever `tool_calls` is empty, so keeping such a turn hands the provider an assistant tool call
// with no response and every later turn on that thread is rejected. Dropping it is what keeps the
// thread usable; a repair round, not a filter exception, is what would preserve the record.
//
// And "no TEXT" is not the question (round 31). A provider can answer with reasoning and nothing
// else, and Anthropic's `thinking` is signed; such a turn is output, not absence, and reading it as
// empty deletes from every later prompt exactly what `textlessContent` above takes such care to keep.
//
// BUT ONLY WHERE IT SURVIVES THE TRIP (round 2 of the follow-up). A non-text block is re-serialized
// by the vendor that emitted it and by nobody else: `@langchain/openai` builds an assistant message
// as `contentBlocks.filter(b => b.type === "text")`, so an Anthropic `thinking` block sent to OpenAI
// after a provider switch or a cross-vendor fallback arrives as `content: []` and the request is
// refused — the thread then stops answering entirely, which is worse than the context this keeps.
// So the exemption asks two things, and drops the turn (the pre-#455 behavior, always safe) whenever
// either is unanswerable: the block came from a provider that replays its own blocks, and EVERY
// model that can receive this turn is that same provider.
//
// ADDING A PROVIDER TO `models.ts` DOES NOT ADD IT HERE, and should not. Absence is the safe answer:
// the turn is dropped, which costs context and never breaks a thread. Membership is earned by
// reading how that vendor's adapter builds an assistant message from a `content` array — if it
// filters to text blocks, as `@langchain/openai` does, the vendor does NOT belong here however well
// it round-trips its own reasoning inside a single call.
const REPLAYS_OWN_BLOCKS: ReadonlySet<string> = new Set(["anthropic"]);

// The providers that take a system message AFTER the history, and keep it where it was put. Read by
// the tool budget's wrap-up instruction (issue #628), which is the one system message the node sends
// anywhere but first.
//
// Membership is earned the same way as above, by what the vendor accepts and not by what it is
// likely to accept. `openai` is in because both of its adapter paths (Completions and Responses) keep
// the message in place and send it as `developer` on a GPT-5 model, the API accepts that role at the
// end, and the round still read the cache (gpt-5.6-luna through OpenRouter pinned to OpenAI, 8 of
// 8). And because the provider has no endpoint of its own to point elsewhere: `openai` ignores
// `baseURL`. The Google and Anthropic adapters throw on it before a request is made; `openai-compatible` and `openrouter` reach servers whose
// rules this cannot know, and absence is the safe answer — the instruction stays in the prompt.
const LATE_SYSTEM_MESSAGE: ReadonlySet<string> = new Set(["openai"]);

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
  stillWanted,
  noReplyChannel,
  primaryDeadlineMs,
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

  // NOTE: Every model that can receive this turn's history, not just the one that starts it: the
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
    // "System messages are only permitted as the first passed message". The one exception is sent,
    // never persisted, and only where it is accepted: see `LATE_SYSTEM_MESSAGE`.
    const full = state.messages.filter(
      (m) => m.getType() !== "system" && !isEmptyAssistantTurn(m, destinations),
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
    // The decision, taken alone, for the REST of the turn (issue #639, and see the function).
    const silentTurn = hasTools && decidedToStaySilentAlone(history);
    // ONLY THE MESSAGE THAT ENDS THE TURN, which is the one carrying no calls: a message that still
    // requests tools is not what the runtime posts, and blanking a preamble beside an ordinary call
    // is a different change on a path this issue is not about (the same line `silenceNarration`
    // draws). `narration` already covers the text written beside the decision itself.
    const silenced = (m: BaseMessage): BaseMessage =>
      silentTurn && ((m as AIMessage).tool_calls?.length ?? 0) === 0
        ? withoutText(m)
        : m;
    // THE DECISION STICKS, and it no longer ENDS the turn (issue #639). The old branch returned
    // here on a lone `skip_reply` with no further model round, which is what cost the operator every
    // step they wrote after it. What that branch was protecting is kept by `silentTurn` instead: the
    // wrap-up below stays suppressed, the hard limit stops trying to force an answer, and the final
    // text is taken out on the way back — in code, rather than being the model's to keep.
    //
    // The count is still untouched, which is what bounds a model that loops on `skip_reply`: at the
    // budget the raw model is invoked with no tools at all, so the next message carries no calls and
    // `toolsCondition` routes to END.
    // BLANKED THE MOMENT THE DECISION IS SEEN, not only when the turn ends on it. A model can put
    // text in the message that calls `skip_reply`, and on a PARALLEL batch that message is not the
    // end of the turn — so a branch that only blanked on the way out left the narration standing
    // whenever a companion tool bought another round, and the turn could still finish silent (round
    // 20). Undelivered either way: the runtime posts the LAST assistant message.
    const narration = staySilent ? silenceNarration(history) : [];
    // THE TURN ENDS WHERE THE INFORMATION ENDS: a lone `skip_reply` asked for again, right after one,
    // adds nothing a further round could act on (see `reaffirmedSilenceAlone`). Everything the old
    // terminal branch did on the way out is done here, minus the part that cost the operator their
    // remaining steps.
    // …and the OTHER way a silent turn runs out of things to do: the budget. A turn that decided
    // silence alone and has spent its tool calls cannot act again and may not speak, so asking the
    // model at all buys a completion whose only possible use is text this path would blank. The old
    // terminal branch got here for free by never leaving; this pays the same by not asking.
    // THE STALL, and it became reachable when the lone decision stopped ending the turn (#639).
    // `ToolNode` SKIPS a call whose `tool_call_id` already has an answer in the history, so a model
    // that repeats a batch verbatim gets no new result and is asked again with the same history,
    // forever: the budget does not bound it either, because that counts tool RESULTS and none are
    // being produced. Asked of the CALLS rather than of the tools step's output, deliberately — an
    // empty step is not by itself a stall (a tool that answered nothing still leaves the model free
    // to reply, which is what a `/reset` landing mid-turn relies on), while a batch whose every id
    // is already answered provably cannot produce one.
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
    // `staySilent` is back in this condition, and round 18 is why it had to be. It left when the
    // branch above returned on `staySilent` alone — no round after the decision, so nothing to
    // instruct — and now that branch also asks whether the decision stood alone. On a PARALLEL batch
    // there IS a round after it, and "Conclua agora: responda ao cliente" is the exact opposite of
    // what the model just chose. Measured by the round-7 test, not by reading.
    const softLimit =
      hasTools &&
      !hardLimit &&
      !staySilent &&
      // …and for the rest of a turn that decided silence alone, for the same reason: the decision is
      // still standing two rounds later, and the wrap-up would be arguing with it (issue #639).
      !silentTurn &&
      toolCalls >= Math.max(1, max - 2);

    // WHERE THE WRAP-UP TRAVELS (issue #628): after the history where every destination takes a
    // system message there, inside the system prompt everywhere else, and in a human message never.
    //
    // After the history is what the cache wants. Providers cache a request by its exact prefix and
    // the system prompt opens every request, so a line appended to it changes the prefix at the first
    // message: the round it lands on cannot read what the round before wrote, and on GPT-5.6 it pays
    // a cache WRITE (1.25x input) on the whole prompt where a read (0.1x) was available. Measured on
    // one install: calls carrying the instruction read the cache 8 times in 311, calls without it
    // 399 in 1003.
    //
    // A SYSTEM message is what keeps it an instruction. The role is the one thing a customer cannot
    // forge: anyone can type "[Sistema] ..." into a chat, and it arrives in a human message. Sent in
    // a human message too, the real instruction would teach the model that such a line is to be
    // obeyed, and the customer's copy would be indistinguishable from it.
    //
    // So the late system message only goes where it is accepted, and the prompt keeps it everywhere
    // else — the cache miss those providers pay today, and nothing new.
    // NOTE: WHAT THE TURN CAN STILL DO, and on an observation that is not answering anybody (#629).
    // The budget is the same; the sentence after it is what changes, because the wrap-up's job is to
    // land the turn and an instruction the frame forbids is one the model has to argue with first.
    const wrapUpText = noReplyChannel
      ? `[Sistema] Você já usou ${toolCalls} de ${max} ferramentas permitidas neste turno. Conclua agora: se ainda falta registrar algo, use a última ferramenta; se não, encerre sem escrever nada.`
      : `[Sistema] Você já usou ${toolCalls} de ${max} ferramentas permitidas neste turno. Conclua agora: responda ao cliente com as informações que já tem. Só use outra ferramenta se for absolutamente imprescindível.`;
    const prompt =
      softLimit && !lateSystemAccepted
        ? `${systemPrompt}\n\n${wrapUpText}`
        : systemPrompt;
    const wrapUp =
      softLimit && lateSystemAccepted ? [new SystemMessage(wrapUpText)] : [];
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
    //
    // A turn that decided silence ALONE is the other case, and it takes no tools at all: there is
    // nothing for the model to reconsider and nothing left it may say, so the raw model's answer
    // carries no calls, `toolsCondition` ends the turn, and the text comes out below. That is also
    // what stops a model looping on `skip_reply` now that the decision is no longer terminal — the
    // budget it spends looping is what brings it here (issue #639).
    // No `!silentTurn` here, though the two cases are different: a turn that decided silence alone
    // and hit the budget already returned above, so this line is only ever reached by the parallel
    // one. The extra term survived every mutation, which is the shape of a condition that cannot
    // change an answer.
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
    const messages = [new SystemMessage(prompt), ...sent, ...wrapUp];
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
            silenced(
              await runModelCall(second.run, {
                primary: second.labels,
                onRetry: onModelRetry,
              }),
            ),
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

    const primaryLlm = hardLimit ? capped : llm;
    // NOTE: an explicit `signal` REPLACES the one LangGraph propagates to this call instead of joining
    // it (measured). Safe today because no caller hands `graph.invoke` a signal of its own; one that
    // starts to would need the two combined here.
    const response = await runModelCall(
      () =>
        primaryDeadlineMs === undefined
          ? primaryLlm.invoke(messages)
          : callWithDeadline(primaryDeadlineMs, (signal) =>
              primaryLlm.invoke(messages, { signal }),
            ),
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
    return { messages: [...narration, silenced(response)] };
  };

  // ONCE PER TURN, the same closure argument the two flags above make. It says the tool boundary
  // refused this turn's calls, which is what routes the graph to END instead of back to the model.
  let calledOffAtTools = false;
  const toolNode = hasTools ? new ToolNode(tools) : null;

  // THE REFUSAL IS A TOOL RESULT, AND THE TURN ENDS ON IT. Two requirements, and each of the two
  // obvious shortcuts breaks one of them:
  //
  //   - routing away from the tool node leaves an `AIMessage` carrying `tool_calls` that no
  //     `ToolMessage` answers, and that thread is what the NEXT turn loads. `@langchain/openai`
  //     replays those calls out of `additional_kwargs` (issue #454), so the vendor is handed a call
  //     with no answer and rejects the whole history — the conversation stops working, which is a
  //     worse outcome than the write this refusal exists to prevent;
  //   - answering "refused" back INTO the model invites it to call the same tool again, round after
  //     round to the recursion limit, spending tokens on a conversation the operator has already
  //     cleared. So the graph ENDS here. The runtime's own gate refuses the send of a turn that was
  //     called off, which is what keeps this text out of the conversation.
  //
  // AND IT REFUSES BY RETURNING, NEVER BY THROWING, which is why the ask is wrapped. The contract in
  // ./reset-episode.ts reserves the throwing answer for seams that are asked "before anything is
  // written" — and by the time this node runs, the assistant turn carrying the calls is ALREADY
  // checkpointed. Measured against the real checkpointer with a tools node that throws: the thread
  // comes back `[human, ai(tool_calls=call_x)]`, no `ToolMessage`, which is the broken sequence
  // above, reached by the mechanism meant to prevent it. Several of the fences the runtime hands
  // down read a job row and throw on a database transient whatever the strictness, so this is not a
  // hypothetical caller.
  //
  // An unreadable mark therefore lets the tools run, which is the same trade the sends make: it is
  // not evidence that anybody withdrew the run, and a turn whose database is failing is failing
  // through the machinery that already exists.
  const refuseCalledOffCalls = async (
    state: typeof MessagesAnnotation.State,
  ): Promise<{ messages: BaseMessage[] } | null> => {
    if (!stillWanted) return null;
    // No guard on an empty list, and the mutation battery is why: `toolsCondition` routes here only
    // when the last message is an assistant turn carrying tool calls, so the empty case is not a
    // case. A check for it survived every mutation, which is what a dead condition looks like.
    const last = state.messages.at(-1);
    const calls =
      last?.getType() === "ai" ? ((last as AIMessage).tool_calls ?? []) : [];
    const wanted = await stillWanted().catch((err) => {
      logger.warn(
        { err },
        "graph: could not read whether the turn is still wanted; letting its tool calls run",
      );
      return true;
    });
    if (wanted) return null;
    calledOffAtTools = true;
    logger.info(
      "graph: the turn was called off mid-invoke, so %d tool call(s) were refused instead of run",
      calls.length,
    );
    // AND AN EMPTY ASSISTANT TURN AFTER THEM, which is not decoration. The runtime reads the reply
    // off the LAST message of the result whatever its type (`lastAssistantText`), so a turn ending on
    // a `ToolMessage` offers the refusal's own sentence as the text to post. Today the gate at each
    // send refuses it — but the fences this graph is handed are not all monotonic: the
    // channel-redirect one answers false while an agent is disabled and TRUE once it is re-enabled,
    // so "called off here, still called off at the send" is a property of the caller rather than of
    // this seam. The empty turn is the same terminator the silence protocol ends on, and it makes
    // the refusal unpostable by construction rather than by the gate agreeing with this node.
    return {
      messages: [...calls.map(calledOffToolResult), new AIMessage("")],
    };
  };

  const builder = new StateGraph(MessagesAnnotation)
    .addNode("agent", agentNode)
    .addEdge(START, "agent");

  if (hasTools) {
    builder
      // EVERY TOOL GOES THROUGH HERE, which is the reason the guard lives at the node and not in the
      // tools themselves: native, HTTP, MCP, integrations and documents are all assembled into this
      // one list, and a guard written per tool is the per-call-site enforcement this repo keeps
      // having to undo — the tool added next week would simply not have it.
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
