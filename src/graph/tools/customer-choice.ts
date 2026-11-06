import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { contentToText } from "@/graph/message-text";
import { runModelCall } from "@/graph/model-limit";
import { DEFAULT_TIMEZONE, partsInTimezone } from "@/graph/time";
import {
  type GuardrailContextMessage,
  unclippedContext,
} from "@/modules/guardrails/context";
import { selectClosedPrefix } from "@/modules/memory/cut";

// The `customer_choice` precondition: a call runs only when every value its arguments choose for the
// customer was said or confirmed by the customer. An OpenAI model asked for "the quote" with three
// packages in the catalog issues the document in that same turn, with all three as line items or with
// one it picked, and a payment link or a booking the same way; a prompt rule, a tool description and
// an attribute the model sets itself are all satisfied by the model in that turn. What it cannot
// write is the customer's own messages, so this reads those (docs/graph.md, Tool preconditions).

// The open attendance as the judge reads it, oldest first: every customer, agent and attendant
// message, so "the second one" stays next to the question it answers even after a later exchange.
// Every message is whole: a refusal written after a cut would not reach the judge.
export interface ChoiceTranscript {
  exchange: GuardrailContextMessage[];
}

// Enough to hold the exchange that settles a choice, bounded so a long attendance does not make
// every guarded call cost pages of tokens. The bound drops the OLDEST whole messages, which can only
// take evidence for a choice away, never a retraction that came after it.
const TRANSCRIPT_MESSAGES_MAX = 40;
export const TRANSCRIPT_CHARS_MAX = 24_000;

// Null when there is nothing whole to read: no transcript (a rule's action, a voice call), or a
// latest customer message longer than the bound, which the judge may not decide on a part of.
export function choiceTranscript(
  messages: readonly BaseMessage[] | undefined,
): ChoiceTranscript | null {
  if (!Array.isArray(messages)) return null;
  // Cut by the conversation stamped on each message, as the memory cut does, before the
  // divider-bounded window: a divider is not always written, and a choice from an attendance that
  // closed must not authorize a call in this one.
  const { open } = selectClosedPrefix([...messages], {
    currentAttendanceClosed: false,
  });
  const window = unclippedContext(open, TRANSCRIPT_MESSAGES_MAX);
  const latestAt = window.findLastIndex((m) => m.role === "customer");
  let chars = 0;
  let from = window.length;
  while (from > 0) {
    const next = window[from - 1]?.text.length ?? 0;
    if (chars + next > TRANSCRIPT_CHARS_MAX) break;
    chars += next;
    from--;
  }
  if (latestAt >= 0 && latestAt < from) return null;
  return { exchange: window.slice(from) };
}

// The judge's instruction. The detail that tells one option from another has to be in the customer's
// words, which is what refuses "the package" read as one particular package; values the business
// supplies itself pass, which is what keeps prices and totals from refusing every document.
export const CHOICE_JUDGE_PROMPT =
  "You check one thing before an action runs for a customer. Answer YES if every choice these arguments make on the customer's behalf (which option or options, quantity, date, time, person) was stated or explicitly confirmed by the customer in their messages, including a short answer to a question the assistant asked. A detail that tells one option apart from another (a number of sessions, a size, a plan, a date, a time) must appear in the customer's own words, or in an assistant question the customer answered by choosing it: a customer asking for 'the package' or 'a session' has not chosen which one. Values the business supplies itself (prices from its catalog, the customer's own name, a validity date, totals) need no confirmation. Answer NO if the arguments pick an option, quantity, date, time or person the customer did not pick, or list several alternatives because the customer has not chosen yet. Answer with YES or NO only.";

// `today` is the business's date: without it a judge reads "Tuesday" against a date in the arguments
// with no calendar, and refuses a booking the customer did choose.
export function choiceJudgeInput(req: {
  tool: string;
  description: string;
  args: unknown;
  transcript: ChoiceTranscript;
  today: string;
}): string {
  const said = req.transcript.exchange
    .map((m) => `- ${m.role}: ${m.text}`)
    .join("\n");
  return `Today is ${req.today}.\nAction: ${req.tool}: ${req.description}\nArguments: ${JSON.stringify(req.args)}\n\nThe conversation, oldest first (customer, assistant, attendant):\n${said || "(none)"}`;
}

// The date as the judge reads it: ISO day and English weekday, in the agent's timezone.
export function judgeToday(now: Date, timezone: string): string {
  const p = partsInTimezone(now, timezone, "en-US");
  return `${p.YYYY}-${p.MM}-${p.DD} (${p.weekday})`;
}

// The judge waits inside a tool call the customer is waiting on, so it gets far less than a turn.
export const CHOICE_JUDGE_DEADLINE_MS = 20_000;

// Anything but an answer that starts with YES is a NO: an empty completion, a refusal to answer and
// an explanation all fail closed, like the precondition they decide.
export async function judgeChoice(
  model: BaseChatModel,
  input: string,
  callbacks: BaseCallbackHandler[],
): Promise<boolean> {
  const res = await runModelCall(
    (signal) =>
      model.invoke(
        [new SystemMessage(CHOICE_JUDGE_PROMPT), new HumanMessage(input)],
        // NOTE: an explicit callback list and an empty `configurable`, because this runs inside the
        // tool node: without them the call inherits the turn's own handlers from the async context,
        // and is billed to the turn's `agent` row and streamed as the reply.
        { signal, callbacks, configurable: {}, tags: [], metadata: {} },
      ),
    { deadlineMs: CHOICE_JUDGE_DEADLINE_MS },
  );
  return /^\s*\**\s*yes\b/i.test(contentToText(res.content));
}

export type ChoiceVerdict =
  | { chosen: true }
  | { chosen: false; reason: "unmet" | "unreadable"; err?: unknown };

export type ChoiceCheck = (req: {
  tool: string;
  description: string;
  args: unknown;
  messages: readonly BaseMessage[] | undefined;
}) => Promise<ChoiceVerdict>;

// The check a toolset hands its guarded tools. `model` is built lazily, on the first call, and stays
// null when the agent's own model cannot be built, which refuses. Every call goes to the judge: no
// text match tells a choice from a mention ("I don't want premium", "tell me about premium",
// "premium" inside "premium+"), and on 96 guarded calls of the live battery a match of every argument
// in the customer's latest message spared no judge call, since arguments carry prices the customer
// never types.
export function choiceCheck(deps: {
  model: () => BaseChatModel | null;
  callbacks: () => BaseCallbackHandler[];
  // The instant and zone the agent's own turn reads, the playground's simulated hour included.
  clock?: () => { now: Date; timezone?: string };
}): ChoiceCheck {
  return async (req) => {
    const transcript = choiceTranscript(req.messages);
    if (!transcript) {
      return {
        chosen: false,
        reason: "unreadable",
        err: new Error("no whole transcript to read"),
      };
    }
    try {
      const model = deps.model();
      if (!model) throw new Error("model not runnable");
      const clock = deps.clock?.();
      const yes = await judgeChoice(
        model,
        choiceJudgeInput({
          ...req,
          transcript,
          today: judgeToday(
            clock?.now ?? new Date(),
            clock?.timezone ?? DEFAULT_TIMEZONE,
          ),
        }),
        deps.callbacks(),
      );
      return yes ? { chosen: true } : { chosen: false, reason: "unmet" };
    } catch (err) {
      return { chosen: false, reason: "unreadable", err };
    }
  };
}
