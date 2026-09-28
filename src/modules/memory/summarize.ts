import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { estimateTokenCount } from "tokenx";
import logger from "@/api/lib/logger";
import {
  CONVERSATION_DIVIDER,
  HUMAN_AGENT_NOTE,
  isHumanAgentTurn,
  isHumanHandback,
  isMemoryHead,
  isNudgeTurn,
} from "@/graph/markers";
import { contentToText } from "@/graph/message-text";
import { runModelCall } from "@/graph/model-limit";
import { DATA_FENCE } from "@/graph/nudge";
import { providerFailure } from "@/lib/provider-failure";
import { clipText, clipTextEnd } from "@/lib/text";

// Condenses the raw turns of a closed attendance into the memory the agent keeps of it. A model call
// outside a turn, so it has its own timeout and an explicit "could not be produced" state: an empty
// summary means nothing worth remembering, a failed one means leave the thread as is and retry.
// Shaped after src/modules/guardrails/analyze.ts. Runs after the reply was posted.

const SUMMARIZE_TIMEOUT_MS = 60_000;

// The summary is prepended to every future turn of this contact, once per closed attendance, so its
// size is a recurring cost. Long enough for what was agreed, short enough that twenty of them do not
// become the context problem they were built to solve.
export const ATTENDANCE_SUMMARY_MAX = 1200;

// How much raw transcript is handed to the summarizer, clipped from the FRONT (recent turns matter
// most): a thread with many raw attendances can exceed the model's window, and a size failure never
// recovers on retry. Not derived from the model (no table of context windows here); when the agent
// declares `limits.maxHistoryTokens`, that budget applies too, measured by the ceiling's estimator.
const TRANSCRIPT_MAX_CHARS = 60_000;

// The estimator runs low (see src/graph/token-count.ts), so convergence is by measurement rather
// than arithmetic: shrink by the measured overshoot and re-measure. Bounded, because a text whose
// estimate does not fall is a bug, not a reason to loop.
const CLIP_PASSES = 6;

function clipTranscript(
  joined: string,
  maxHistoryTokens: number | null,
): string {
  let text = clipTextEnd(joined, TRANSCRIPT_MAX_CHARS);
  if (!maxHistoryTokens || maxHistoryTokens <= 0) return text;
  for (let pass = 0; pass < CLIP_PASSES; pass++) {
    const estimate = estimateTokenCount(text);
    if (estimate <= maxHistoryTokens) break;
    const keep = Math.floor((text.length * maxHistoryTokens) / estimate);
    if (keep <= 0) return "";
    text = clipTextEnd(text, keep);
  }
  return text;
}

export const TRANSCRIPT_TAG = "<transcricao>";
const TRANSCRIPT_CLOSE = "</transcricao>";

// Anything in the transcript that reads as the fence's own tag, in every spelling it could take. The
// text inside is written by the customer, who would otherwise be able to close the fence and address
// the summarizer directly, and what the summarizer writes is what the agent believes forever after.
const FENCE_TAG = /<\s*\/?\s*transcricao[^>]*>/gi;

// Chosen by an A/B battery that reads this prompt (scripts/measure-summary-battery.ts). Enumerating
// what to preserve made summaries longer with no more facts; demanding one alphabet removed leaked
// non-Latin fragments but lost the customer's name more often. Leaked script is a known cosmetic
// model artifact and is not stripped: a customer who writes Russian gets memory in Cyrillic.
const SYSTEM_PROMPT = `Você registra a memória de um atendimento que acabou, para o atendente que vai falar com este mesmo cliente da próxima vez.

Escreva um resumo curto do atendimento entre as tags de transcrição, guardando o que um próximo atendimento precisaria saber.

Regras:
- Escreva no mesmo idioma da conversa.
- Só registre o que está na transcrição. Não deduza, não complete e não invente nada.
- Se algo ficou ambíguo, diga que ficou ambíguo em vez de escolher uma versão.
- Não escreva saudações, não se dirija ao cliente e não faça perguntas.
- Responda apenas com o resumo, sem preâmbulo e sem formatação de título.`;

export interface AttendanceSummaryResult {
  // The summary text, already clipped. Empty when nothing was produced.
  summary: string;
  // Set when the summary could not be produced at all (model error, timeout, empty completion). The
  // caller must leave the thread untouched and let the job retry.
  error?: string;
}

// One line per message, in order. Tool CALLS travel as the tool's name and tool RESULTS not at all:
// they are the heaviest and least summarizable part, the reply that follows restates what mattered,
// and sending them would hand a second model call customer data that never reached the customer.
export function renderTranscript(
  messages: BaseMessage[],
  maxHistoryTokens: number | null = null,
): string {
  const lines: string[] = [];
  for (const m of messages) {
    const type = m.getType();
    if (type === "tool") continue;
    // NOTE: the head is rendered FROM the rows, so feeding it back would summarize a summary.
    if (isMemoryHead(m)) continue;
    let text = contentToText(m.content).trim();
    // NOTE: a proactive nudge rides as a HUMAN turn and would be remembered as the customer asking for
    // the operator's guidance; the agent's reply to it stays. DATA_FENCE catches nudges written before
    // the marker: renderNudge embeds it and sanitizeFreeText strips it from event data, so only a
    // customer typing it loses that one message from the summary.
    if (isNudgeTurn(m) || (type === "human" && text.includes(DATA_FENCE)))
      continue;
    // NOTE: the hand-back note is not dialogue, so it is dropped: unmarked it would render as
    // `cliente:`, the system's words remembered as the contact's. A human agent's reply also rides as
    // a HumanMessage, so its branch is marker-gated (a chat cannot carry metadata) and only trims the
    // note by exact match.
    if (isHumanHandback(m)) continue;
    if (isHumanAgentTurn(m)) {
      if (text.startsWith(HUMAN_AGENT_NOTE)) {
        text = text.slice(HUMAN_AGENT_NOTE.length).trim();
      }
      if (text) lines.push(`atendente: ${text}`);
      continue;
    }
    // NOTE: ingestion folds the divider into the customer's own turn, so the marker is stripped and
    // the words kept. Keyed on the TEXT, not the marker: trimming is only safe when the prefix is
    // there, and this also covers dividers written before the marker. The CUT still decides from the
    // stamp only (src/graph/markers.ts).
    if (type === "human" && text.startsWith(CONVERSATION_DIVIDER)) {
      text = text.slice(CONVERSATION_DIVIDER.length).trim();
    }
    if (type === "human") {
      if (text) lines.push(`cliente: ${text}`);
      continue;
    }
    if (text) lines.push(`atendente: ${text}`);
    const calls = (m as { tool_calls?: { name?: unknown }[] }).tool_calls;
    if (Array.isArray(calls) && calls.length > 0) {
      const names = calls
        .map((c) => (typeof c?.name === "string" ? c.name : "?"))
        .join(", ");
      lines.push(`atendente [usou ferramenta: ${names}]`);
    }
  }
  const joined = lines.join("\n").replace(FENCE_TAG, "");
  return clipTranscript(joined, maxHistoryTokens);
}

export async function summarizeAttendance(
  model: BaseChatModel,
  messages: BaseMessage[],
  // Usage + trace handlers: a billed generation nobody waits on is how cost goes missing.
  callbacks?: BaseCallbackHandler[],
  // The agent's declared history ceiling (null = none). See TRANSCRIPT_MAX_CHARS.
  maxHistoryTokens: number | null = null,
): Promise<AttendanceSummaryResult> {
  const transcript = renderTranscript(messages, maxHistoryTokens);
  // NOTE: An attendance whose messages carry no text at all (only tool traffic) has nothing to
  // remember. That is a legitimate empty summary, not a failure, so it must not carry `error`.
  if (!transcript.trim()) return { summary: "" };

  // NOTE: held so `signal.aborted` can be read afterwards, the only reading of "it timed out" that
  // does not come from someone else's error. `runModelCall` makes a signal per attempt after waiting
  // on the model semaphore (a signal made outside would spend its budget queueing), so this holds the
  // LAST attempt's signal, the one the error came from.
  let attemptSignal: AbortSignal | undefined;
  try {
    const res = await runModelCall(
      (signal) => {
        attemptSignal = signal;
        return model.invoke(
          [
            new SystemMessage(SYSTEM_PROMPT),
            // NOTE: The transcript is never interpolated into the system prompt. Everything in a
            // system message reads to the model as an instruction from the operator, and this text was
            // written by the customer.
            new HumanMessage(
              `${TRANSCRIPT_TAG}\n${transcript}\n${TRANSCRIPT_CLOSE}`,
            ),
          ],
          {
            signal,
            ...(callbacks ? { callbacks } : {}),
          },
        );
      },
      { deadlineMs: SUMMARIZE_TIMEOUT_MS },
    );
    const text = contentToText(res.content).trim();
    if (!text) return { summary: "", error: "empty completion" };
    return { summary: clipText(text, ATTENDANCE_SUMMARY_MAX) };
  } catch (err) {
    logger.warn({ err }, "memory: attendance summary failed, thread untouched");
    return {
      summary: "",
      error: providerFailure(err, attemptSignal?.aborted === true),
    };
  }
}
