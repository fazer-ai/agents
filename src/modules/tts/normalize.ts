import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { runModelCall } from "@/graph/model-limit";

// The reply, rewritten to be SPOKEN. Runs after prepareSpeechText, on the audio path only, on its own
// model call (buildSpeechNormalizer): currency, numbers, dates, times and abbreviations in words, and
// an enumeration said the way a person says it rather than recited. Same language as the reply, so it
// is not hard-coded to one locale the way a regex pass would be. Plain text in, plain text out: no
// SSML (fragmented and brittle across providers and model versions, see docs/tts.md).
//
// This is a REWRITE, and the fact-preservation rule in the prompt is what keeps it from becoming an
// invention. The main agent is told nothing about any of it: it writes the answer, this rewrites a
// copy for the ear, and Chatwoot's transcript plus the checkpointer keep the original.
//
// Best-effort: the CALLER wraps this in try/catch and falls back to the un-normalized text, so a slow
// or failing rewrite never blocks or breaks the audio reply.

const NORMALIZE_TIMEOUT_MS = 20_000;

// Measured, not composed. The wording this replaces ("changing ONLY what a TTS would read wrong" +
// "preserve the wording") forbade the one thing the reported reply needed, and measuring showed a
// worse problem than style: rewriting "08:00, 08:30 e 09:00" item by item FUSES the last two into
// "oito e trinta e nove horas", which a listener hears as 08:39, a time that was never offered.
//
// Rate on that exact reply, n=24 per arm, temperature 0, old wording → this one:
//   fused:      gpt-5.4-mini 17/24 → 1/24 · gpt-4o-mini 5/24 → 0/24 · gpt-5.4 10/24 → 0/24
//   fact lost:  gpt-5.4-mini  0/24 → 0/24 · gpt-4o-mini 0/24 → 0/24 · gpt-5.4 17/24 → 0/24
// Two other fixtures (a 14h/14h30/15h offer and a three-price list) score zero on both arms.
//
// Each line here bought something in that measurement, which is the bar for adding another:
//   * "keep every fact" is what buys the freedom to restructure. It REPLACES "preserve the wording";
//   * the enumeration line is what breaks the fusion;
//   * the date line exists because gpt-5.4 read "18/08" as "dezoito do zero oito" in 17/24 runs and
//     the enumeration rule alone made that more consistent, not less (24/24). With it: 0/24.
// A longer variant that also spelled the fusion out measured identically (16/96 fused either way) and
// was dropped: on #95, spelling a rule out at length made a prompt measurably worse.
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
  const res = await runModelCall(() =>
    model.invoke([new SystemMessage(SYSTEM_PROMPT), new HumanMessage(text)], {
      signal: AbortSignal.timeout(NORMALIZE_TIMEOUT_MS),
      callbacks,
    }),
  );
  const out = messageText(res.content).trim();
  return out || text;
}
