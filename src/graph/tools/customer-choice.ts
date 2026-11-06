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
import { clipText } from "@/lib/text";
import { guardrailContext } from "@/modules/guardrails/context";

// The `customer_choice` precondition: a call runs only when every value its arguments choose for the
// customer was said or confirmed by the customer. An OpenAI model asked for "the quote" with three
// packages in the catalog issues the document in that same turn, with all three as line items or with
// one it picked, and a payment link or a booking the same way; a prompt rule, a tool description and
// an attribute the model sets itself are all satisfied by the model in that turn. What it cannot
// write is the customer's own messages, so this reads those (docs/graph.md, Tool preconditions).

// What the customer said in the open attendance, oldest first, and the agent's or an attendant's
// last message before the customer's latest one (the question a short "yes" or "the second one"
// answers). Null when the call carries no transcript: a rule's action or a voice call.
export interface ChoiceTranscript {
  customer: string[];
  lastQuestion: string;
}

// Enough to hold the exchange that settles a choice, bounded so a long attendance does not make
// every guarded call cost a page of tokens.
const TRANSCRIPT_MESSAGES_MAX = 40;
const MESSAGE_CHARS_MAX = 2000;

export function choiceTranscript(
  messages: readonly BaseMessage[] | undefined,
): ChoiceTranscript | null {
  if (!Array.isArray(messages)) return null;
  const context = guardrailContext(messages, TRANSCRIPT_MESSAGES_MAX);
  const lastCustomer = context.findLastIndex((m) => m.role === "customer");
  if (lastCustomer < 0) return { customer: [], lastQuestion: "" };
  const before = context.findLast(
    (m, i) => i < lastCustomer && m.role !== "customer",
  );
  return {
    customer: context
      .filter((m) => m.role === "customer")
      .map((m) => clipText(m.text, MESSAGE_CHARS_MAX)),
    lastQuestion: before ? clipText(before.text, MESSAGE_CHARS_MAX) : "",
  };
}

// Lowercased, accents and punctuation folded to single spaces, so "10 Sessões," in a message matches
// the line item "10 sessoes".
function folded(text: string): string {
  return ` ${text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

function leaves(value: unknown, out: unknown[]): void {
  if (Array.isArray(value)) for (const v of value) leaves(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) leaves(v, out);
  else out.push(value);
}

// Whether every value in the arguments appears, whole-word, in the customer's own messages. A pass
// spares the model call; a miss decides nothing, since "the second one" or "yes" chooses a value
// without spelling it. Only strings and numbers can be found: any other leaf (a boolean, a null)
// sends the call to the judge.
export function literallyChosen(args: unknown, customer: string[]): boolean {
  const values: unknown[] = [];
  leaves(args, values);
  const said = folded(customer.join("\n"));
  let found = 0;
  for (const v of values) {
    if (typeof v !== "string" && typeof v !== "number") return false;
    const needle = folded(String(v));
    if (needle.trim() === "") continue;
    if (!said.includes(needle)) return false;
    found++;
  }
  return found > 0;
}

// The judge's instruction. The detail that tells one option from another has to be in the customer's
// words, which is what refuses "the package" read as one particular package; values the business
// supplies itself pass, which is what keeps prices and totals from refusing every document.
export const CHOICE_JUDGE_PROMPT =
  "You check one thing before an action runs for a customer. Answer YES if every choice these arguments make on the customer's behalf (which option or options, quantity, date, time, person) was stated or explicitly confirmed by the customer in their messages, including a short answer to the assistant's last question. A detail that tells one option apart from another (a number of sessions, a size, a plan, a date, a time) must appear in the customer's own words, or in an assistant question the customer answered by choosing it: a customer asking for 'the package' or 'a session' has not chosen which one. Values the business supplies itself (prices from its catalog, the customer's own name, a validity date, totals) need no confirmation. Answer NO if the arguments pick an option, quantity, date, time or person the customer did not pick, or list several alternatives because the customer has not chosen yet. Answer with YES or NO only.";

// `today` is the business's date: without it a judge reads "Tuesday" against a date in the arguments
// with no calendar, and refuses a booking the customer did choose.
export function choiceJudgeInput(req: {
  tool: string;
  description: string;
  args: unknown;
  transcript: ChoiceTranscript;
  today: string;
}): string {
  const said = req.transcript.customer.map((m) => `- ${m}`).join("\n");
  return `Today is ${req.today}.\nAction: ${req.tool}: ${req.description}\nArguments: ${JSON.stringify(req.args)}\n\nCustomer's messages, oldest first:\n${said || "(none)"}\n\nAssistant's last message before the customer's latest one: ${req.transcript.lastQuestion || "(none)"}`;
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
  | { chosen: true; by: "literal" | "judge" }
  | { chosen: false; reason: "unmet" | "unreadable"; err?: unknown };

export type ChoiceCheck = (req: {
  tool: string;
  description: string;
  args: unknown;
  messages: readonly BaseMessage[] | undefined;
}) => Promise<ChoiceVerdict>;

// The check a toolset hands its guarded tools. `model` is built lazily, on the first call that needs
// a judge, and stays null when the agent's own model cannot be built, which refuses.
export function choiceCheck(deps: {
  model: () => BaseChatModel | null;
  callbacks: () => BaseCallbackHandler[];
  timezone?: string;
  now?: () => Date;
}): ChoiceCheck {
  return async (req) => {
    const transcript = choiceTranscript(req.messages);
    if (!transcript) {
      return {
        chosen: false,
        reason: "unreadable",
        err: new Error("no transcript"),
      };
    }
    if (literallyChosen(req.args, transcript.customer)) {
      return { chosen: true, by: "literal" };
    }
    try {
      const model = deps.model();
      if (!model) throw new Error("model not runnable");
      const yes = await judgeChoice(
        model,
        choiceJudgeInput({
          ...req,
          transcript,
          today: judgeToday(
            deps.now?.() ?? new Date(),
            deps.timezone ?? DEFAULT_TIMEZONE,
          ),
        }),
        deps.callbacks(),
      );
      return yes
        ? { chosen: true, by: "judge" }
        : { chosen: false, reason: "unmet" };
    } catch (err) {
      return { chosen: false, reason: "unreadable", err };
    }
  };
}
