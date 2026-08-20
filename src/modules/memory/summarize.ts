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
  isMemoryHead,
  isNudgeTurn,
} from "@/graph/markers";
import { contentToText } from "@/graph/message-text";
import { runModelCall } from "@/graph/model-limit";
import { DATA_FENCE } from "@/graph/nudge";

// Condenses the raw turns of a closed attendance into the memory the agent keeps of it.
//
// Shaped after src/modules/guardrails/analyze.ts, and for the same reason: this is a model call that
// happens outside a turn, so it needs its own timeout and an explicit "could not be produced" state.
// A summary that came back empty and a summary that never ran are the same value without it, and
// they call for opposite actions — the first means the attendance had nothing worth remembering, the
// second means the thread must be left exactly as it is and retried.
//
// It is not on any customer's critical path: the job runs after the reply was posted.

const SUMMARIZE_TIMEOUT_MS = 60_000;

// The summary is prepended to every future turn of this contact, once per closed attendance, so its
// size is a recurring cost. Long enough for what was agreed, short enough that twenty of them do not
// become the context problem they were built to solve.
export const ATTENDANCE_SUMMARY_MAX = 1200;

// How much raw transcript is handed to the summarizer. A thread that accumulated many attendances
// (compaction newly enabled, or a run that kept failing) can be larger than the model's own window,
// and a call that fails on size would never recover on retry. Clipped from the FRONT, keeping the
// most recent turns, because that is the half a later attendance is most likely to refer back to.
//
// The char cap is the floor, and it is deliberately not derived from the model: this repo has no
// table of context windows and would not keep one honest. What the operator DID declare is
// `agent.settings.limits.maxHistoryTokens`, and when it is set it applies here too — the same
// budget, on the same model, measured by the same estimator the ceiling uses. Conservative in the
// right direction: this call carries no tool definitions, so the overhead the ceiling sits under
// (15.8k tokens on the install that motivated it) is absent here.
const TRANSCRIPT_MAX_CHARS = 60_000;

// The estimator runs low (see src/graph/token-count.ts), so convergence is by measurement rather
// than arithmetic: shrink by the measured overshoot and re-measure. Bounded, because a text whose
// estimate does not fall is a bug, not a reason to loop.
const CLIP_PASSES = 6;

function clipTranscript(
  joined: string,
  maxHistoryTokens: number | null,
): string {
  let text =
    joined.length > TRANSCRIPT_MAX_CHARS
      ? joined.slice(joined.length - TRANSCRIPT_MAX_CHARS)
      : joined;
  if (!maxHistoryTokens || maxHistoryTokens <= 0) return text;
  for (let pass = 0; pass < CLIP_PASSES; pass++) {
    const estimate = estimateTokenCount(text);
    if (estimate <= maxHistoryTokens) break;
    const keep = Math.floor((text.length * maxHistoryTokens) / estimate);
    if (keep <= 0) return "";
    text = text.slice(text.length - keep);
  }
  return text;
}

export const TRANSCRIPT_TAG = "<transcricao>";
const TRANSCRIPT_CLOSE = "</transcricao>";

// Anything in the transcript that reads as the fence's own tag, in every spelling it could take. The
// text inside is written by the customer, who would otherwise be able to close the fence and address
// the summarizer directly — and what the summarizer writes is what the agent believes forever after.
const FENCE_TAG = /<\s*\/?\s*transcricao[^>]*>/gi;

// Escolhido por medição, não por gosto: bateria A/B com n=32 por célula em gpt-5.4-mini, sobre dois
// diálogos (o cenário 1 simples; o 2 com o valor mudando no meio, uma restrição dita uma única vez
// logo no começo e nenhum fechamento). Números re-derivados contra este HEAD; o harness lê o prompt
// deste arquivo, então dá para repetir a conta:
//
//                        fatos completos      nome (cen. 2)   escrita vazada    mediana de tamanho
//   este prompt          32/32 e 31/32            31/32           3/64            310 e 340
//   variante A           32/32 e 31/32            32/32           3/64            370 e 451
//   variante C           32/32 e 26/32            27/32           0/64            261 e 339
//
// Invenção: 0/32 em todas as seis células. Nenhuma variante inventou nada, que é o eixo em que
// nenhuma delas podia falhar.
//
//   variante A  os mesmos quatro bullets enumerando o que preservar. Mesma retenção, mesma ausência
//               de invenção, e resumo 19% (cenário 1) a 33% (cenário 2) mais longo. É só isso que
//               separa os dois, e é o suficiente: texto a mais sem fato a mais é contexto pago em
//               todo turno seguinte, para sempre.
//   variante C  este mais "usando o mesmo alfabeto dela do começo ao fim", mirando o vazamento.
//               ZEROU o vazamento — e derrubou a retenção do nome do cliente para 27/32 no diálogo
//               difícil. Rejeitada por isso: esquecer quem é o cliente é dano de memória, o
//               vazamento é cosmético.
//
// CORREÇÃO de uma medição anterior, registrada porque o número estava publicado aqui e neste repo
// público: a rodada que escolheu este prompt afirmava vazamento de 8/64 na variante A contra 4/128
// aqui, com p≈0,01, e afirmava que C não mexia no vazamento. Nenhuma das duas se reproduziu. O
// vazamento não distingue A deste prompt (3/64 nos dois), e C na verdade o elimina. O fenômeno gira
// em torno de 3-5%, e nenhuma das duas rodadas tem n para separar variantes nessa faixa — tratar
// aquele p≈0,01 como resultado foi erro meu. O que decide A contra este é o comprimento, e o que
// rejeita C é a retenção do nome; as duas coisas se repetem e são grandes o bastante para enxergar.
//
// "Escrita vazada" é um pedaço em cirílico/persa/bengali no meio de uma frase em português ("com
// обещa de retorno", "com মূল্য de R$ 250,00"): artefato do modelo e não do texto acima. O sentido
// sobrevive, mas aquilo fica gravado e reaparece em todo turno seguinte, então está registrado aqui
// como conhecido e medido em vez de descoberto por um operador. Não há pós-processamento tirando
// caractere não-latino: a regra do idioma é deliberada, e um cliente que fala russo tem que receber
// memória em cirílico.
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

// One line per message, in order. Tool CALLS travel as the tool's name and tool RESULTS do not
// travel at all: their payloads are the heaviest part of a tool-driven thread and the least
// summarizable, and whatever the agent actually did with a result it said out loud in the reply that
// follows. Sending them would spend the summarizer's window on ids and ISO timestamps, and would
// hand a second model call customer data that never reached the customer.
export function renderTranscript(
  messages: BaseMessage[],
  maxHistoryTokens: number | null = null,
): string {
  const lines: string[] = [];
  for (const m of messages) {
    const type = m.getType();
    if (type === "tool") continue;
    // The head is rendered FROM the rows, so feeding it back would summarize a summary.
    if (isMemoryHead(m)) continue;
    let text = contentToText(m.content).trim();
    // A proactive nudge rides as a HUMAN turn (src/graph/nudge.ts), so left in it is quoted to the
    // summarizer as the CUSTOMER asking for whatever the operator's follow-up guidance says — and
    // that lands in the permanent memory, which is what the agent believes from then on. The nudge's
    // own directive is not part of the attendance; the agent's REPLY to it is, and stays.
    //
    // The marker covers every nudge written from here on. The DATA_FENCE fallback covers the ones
    // already sitting in threads written before it: the fence is embedded by renderNudge in every
    // nudge and stripped out of the external payload by sanitizeFreeText, so it cannot arrive from
    // the event data. A customer CAN type it, and typing it costs them that one message in the
    // summary — the trade runs the safe way, unlike leaving operator instructions in.
    if (isNudgeTurn(m) || (type === "human" && text.includes(DATA_FENCE)))
      continue;
    // System markers ride as HumanMessages (src/graph/markers.ts), and the ingestion path folds the
    // divider into the customer's own turn — so this strips the marker and keeps the words around it,
    // rather than dropping the message. Left in, the system's directive would be quoted back to the
    // summarizer as something the CUSTOMER said; dropped whole, a real customer message would go
    // missing from the memory of that attendance. An attendance whose only stored message IS the bare
    // divider (an input guardrail answered the first turn before the model ran) renders nothing at
    // all, and costs no generation.
    //
    // Keyed on the TEXT, not on the marker, which is the one place in this codebase where that is the
    // right way round. What happens here is not a decision about the message, it is trimming a known
    // prefix off it — and trimming is only safe when the prefix is actually there. A marker-keyed
    // trim would cut CONVERSATION_DIVIDER.length characters off whatever the message happens to hold,
    // which is the customer's words the moment the two disagree. It also covers, for free, the
    // threads written before the marker existed: on the first compaction after an upgrade those
    // dividers are plain text, and left in they are quoted to the summarizer as things the CONTACT
    // said. A customer can open a message with this exact text and lose that prefix from the summary;
    // they never lose the rest of the message, which is what keeps the trade safe in this direction.
    //
    // The CUT still decides from the stamp and only from the stamp (src/graph/markers.ts). The worst
    // case here is a clipped prefix; there it is a boundary in the wrong place.
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
  // Usage + trace handlers. This is a BILLED generation like any other, and one that runs without a
  // customer waiting on it, which is exactly how a model call ends up invisible in the cost report:
  // nobody notices a missing row on a call nobody is watching.
  callbacks?: BaseCallbackHandler[],
  // The agent's declared history ceiling (null = none). See TRANSCRIPT_MAX_CHARS.
  maxHistoryTokens: number | null = null,
): Promise<AttendanceSummaryResult> {
  const transcript = renderTranscript(messages, maxHistoryTokens);
  // NOTE: An attendance whose messages carry no text at all (only tool traffic) has nothing to
  // remember. That is a legitimate empty summary, not a failure, so it must not carry `error`.
  if (!transcript.trim()) return { summary: "" };

  try {
    const res = await runModelCall(() =>
      model.invoke(
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
          signal: AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS),
          ...(callbacks ? { callbacks } : {}),
        },
      ),
    );
    const text = contentToText(res.content).trim();
    if (!text) return { summary: "", error: "empty completion" };
    return { summary: text.slice(0, ATTENDANCE_SUMMARY_MAX) };
  } catch (err) {
    logger.warn({ err }, "memory: attendance summary failed, thread untouched");
    return {
      summary: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
