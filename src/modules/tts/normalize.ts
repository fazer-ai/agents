import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { runModelCall } from "@/graph/model-limit";

// The reply, rewritten to be SPOKEN. Runs after prepareSpeechText, on the audio path only, on its own
// model call: currency, numbers, dates, times and abbreviations in words, enumerations said as a
// person says them, in the reply's language. Plain text, no SSML (brittle across providers, see
// docs/tts.md). The prompt's fact-preservation rule keeps the rewrite from inventing; the original
// stays in Chatwoot and the checkpointer. Best-effort: the caller falls back to the raw text.

const NORMALIZE_TIMEOUT_MS = 20_000;

// Measured, not composed (docs/tts.md): rewriting "08:00, 08:30 e 09:00" item by item fuses the last
// two into a time never offered. Each line bought something in that measurement, which is the bar
// for adding another: "keep every fact" replaces "preserve the wording" and buys the freedom to
// restructure, the enumeration line breaks the fusion, and the date line stops "18/08" being read
// digit by digit. Spelling a rule out at length measured no better, and can make a prompt worse.
const SYSTEM_PROMPT =
  "You prepare an assistant's chat message to be read aloud by a text-to-speech engine. " +
  "Rewrite it so it SOUNDS like a person speaking, in the SAME language as the message.\n" +
  "- Write currency, numbers, percentages, dates, times, phone numbers, ordinals and unit symbols the " +
  "way they are spoken, and expand common abbreviations (street and title abbreviations, etc.).\n" +
  "- Offer a set of options the way a person would say them out loud, not as a comma-separated list: " +
  "repeat the word that introduces each option instead of stacking them behind a single one, and do " +
  "not announce them with a colon.\n" +
  "- Say a date the way it is said aloud, naming the month, never digit group by digit group.\n" +
  "- Join clipped, telegraphic sentences into connected speech, and drop commas that exist only for " +
  "the eye.\n" +
  "- Keep every fact exactly as given: each number, date, time, amount, name and place in the message " +
  "must appear in your output with the SAME value. Never introduce a fact that is not in the message.\n" +
  "- Do not translate, summarize, answer, or leave anything out. Do not add quotes, markdown, or any " +
  "preface. Output only the rewritten text.";

function messageText(content: BaseMessage["content"]): string {
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
      .join("");
  }
  return "";
}

// Rewrites `text` for natural speech via the model. Returns the original text if the model yields
// nothing. Throws on a model/timeout error (the caller falls back to the un-normalized text).
// `callbacks` carries the turn's usage/trace handlers: this is a billed model call like any other, and
// without them it is spent money with no row, no span and no webhook event.
export async function llmNormalizeForSpeech(
  model: BaseChatModel,
  text: string,
  callbacks?: BaseCallbackHandler[],
): Promise<string> {
  const res = await runModelCall(
    (signal) =>
      model.invoke([new SystemMessage(SYSTEM_PROMPT), new HumanMessage(text)], {
        signal,
        callbacks,
      }),
    { deadlineMs: NORMALIZE_TIMEOUT_MS },
  );
  const out = messageText(res.content).trim();
  return out || text;
}
