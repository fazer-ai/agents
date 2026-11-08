import logger from "@/api/lib/logger";
import config from "@/config";
import { sanitizeErrorMessage } from "@/lib/redact";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { CHATWOOT_ERRORS_KEY_KEY } from "@/modules/chatwoot/constants";
import { literalForChatwoot } from "@/modules/chatwoot/liquid";
import { parseChatwootMessages } from "@/modules/chatwoot/messages";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import type { GuardrailReport } from "@/modules/guardrails/gate";
import { formatSendOptions } from "./send";
import type { ConversationNoteFormat } from "./settings";

// What went wrong inside one turn that still ended, told to the team in the Chatwoot conversation:
// a tool that failed while the model carried on, a reply only the fallback model wrote, an empty
// model response answered on its second attempt, a guardrail that held the reply. One message per
// turn. A lost turn writes the failure note instead and never reaches this, since only a turn that
// returns posts it. The reason is a word from a closed list, never the error's text: a tool's error
// can quote the customer's data or an internal address, and everyone on the inbox reads this. The
// link to the turn on the Logs page is where the detail is (docs/chatwoot.md).

export interface FailedTool {
  name: string;
  failed: number;
  // The same tool succeeded on a later call of the same turn.
  recovered: boolean;
  // The flow line's cause (already sanitized), classified below, never quoted.
  cause: string;
}

export type TurnErrorItem =
  | {
      kind: "tool";
      name: string;
      failed: number;
      recovered: boolean;
      reason: string;
    }
  | { kind: "fallback"; reason: string }
  | { kind: "retry" }
  | { kind: "guardrail"; direction: "input" | "output"; action: string };

// Past this many tools the rest is counted, so a runaway turn still posts a short message.
export const TURN_ERRORS_MAX_TOOLS = 10;

// The closed list a reason is read into. The first line of an HTTP tool's failure is `HTTP <status>`
// (src/graph/tools/http.ts), and a provider's failure names its status the same way.
export function errorReason(cause: string): string {
  const http =
    /\bHTTP (\d{3})\b/.exec(cause) ??
    /\b(?:status|code)[ :=]+(\d{3})\b/i.exec(cause);
  if (http) return `HTTP ${http[1]}`;
  if (/time ?out|timed out|deadline|abort/i.test(cause))
    return "tempo esgotado";
  if (
    /ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|fetch failed|network|socket/i.test(
      cause,
    )
  )
    return "sem conexão";
  if (
    /\b(?:401|403)\b|unauthori[sz]ed|forbidden|credential|api key/i.test(cause)
  )
    return "credencial recusada";
  if (/\b429\b|rate.?limit/i.test(cause)) return "limite de uso";
  return "erro";
}

// Collects what one turn survived. The tools are the ToolFlowLogger's, read at the end; the rest is
// told as it happens by the turn's own callbacks.
export class TurnErrors {
  private fallback: string | null = null;
  private retried = false;
  private readonly guardrails: {
    direction: "input" | "output";
    action: string;
  }[] = [];

  fallbackAnswered(info: { reason: string; failure: string }): void {
    this.fallback = errorReason(`${info.failure} ${info.reason}`);
  }

  modelRetried(): void {
    this.retried = true;
  }

  // Only a screening that HELD the reply (replaced, suppressed, handed over): `observe` lets it
  // through, and a clean or unavailable screening held nothing.
  guardrail(r: GuardrailReport): void {
    if (
      r.outcome !== "replaced" &&
      r.outcome !== "suppressed" &&
      r.outcome !== "handed-off"
    )
      return;
    this.guardrails.push({
      direction: r.direction,
      action: r.action ?? r.outcome,
    });
  }

  items(tools: readonly FailedTool[]): TurnErrorItem[] {
    const out: TurnErrorItem[] = tools.map((t) => ({
      kind: "tool",
      name: t.name,
      failed: t.failed,
      recovered: t.recovered,
      reason: errorReason(t.cause),
    }));
    if (this.fallback !== null)
      out.push({ kind: "fallback", reason: this.fallback });
    if (this.retried && this.fallback === null) out.push({ kind: "retry" });
    for (const g of this.guardrails) out.push({ kind: "guardrail", ...g });
    return out;
  }
}

// What failed, without the counts: the same tool failing for the same reason on the next turn is
// the same news, however many calls it took.
export function turnErrorsKey(items: readonly TurnErrorItem[]): string {
  return items
    .map((i) =>
      i.kind === "tool"
        ? `tool:${i.name}:${i.reason}:${i.recovered ? "r" : "n"}`
        : i.kind === "fallback"
          ? `fallback:${i.reason}`
          : i.kind === "guardrail"
            ? `guardrail:${i.direction}:${i.action}`
            : "retry",
    )
    .sort()
    .join("|");
}

function line(i: TurnErrorItem): string {
  switch (i.kind) {
    case "tool": {
      const times = i.failed > 1 ? ` ${i.failed}x` : "";
      return i.recovered
        ? `- Ferramenta ${i.name}: falhou${times} (${i.reason}). Se recuperou: funcionou numa nova chamada.`
        : `- Ferramenta ${i.name}: falhou${times} (${i.reason}). Não se recuperou: o agente seguiu sem ela.`;
    }
    case "fallback":
      return `- Modelo principal: falhou (${i.reason}). Se recuperou: o modelo de fallback respondeu.`;
    case "retry":
      return "- Modelo: devolveu uma resposta vazia. Se recuperou: respondeu na segunda tentativa.";
    case "guardrail":
      return `- Guardrail (${i.direction === "input" ? "entrada" : "saída"}): segurou a resposta (ação: ${i.action}). Não se recuperou: a resposta do modelo não foi enviada.`;
  }
}

export function turnLogsUrl(turnId: string): string {
  return `${config.publicUrl.replace(/\/+$/, "")}/logs?turnId=${encodeURIComponent(turnId)}`;
}

export function turnErrorsText(
  items: readonly TurnErrorItem[],
  turnId: string,
): string | null {
  if (items.length === 0) return null;
  const tools = items.filter((i) => i.kind === "tool");
  const others = items.filter((i) => i.kind !== "tool");
  const shown = [...tools.slice(0, TURN_ERRORS_MAX_TOOLS), ...others].map(line);
  const rest = tools.length - TURN_ERRORS_MAX_TOOLS;
  if (rest > 0) shown.push(`- E mais ${rest} ferramenta(s) com falha.`);
  return [
    "Erros neste turno do agente:",
    ...shown,
    `Detalhes do turno: ${turnLogsUrl(turnId)}`,
  ].join("\n");
}

// The key of the newest turn-errors message on the conversation's latest page, if any. A message
// older than that page is old enough to say again.
async function lastErrorsKey(
  client: Pick<ChatwootClient, "getMessages">,
  conversationId: number,
): Promise<string | null> {
  const rows = parseChatwootMessages(await client.getMessages(conversationId));
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r?.activityNote === "errors") return r.activityErrorsKey ?? null;
  }
  return null;
}

// Best-effort: the turn is over when this runs, so a message that does not land costs the team a
// line and nothing else. Never throws.
export async function postTurnErrors(params: {
  client: Pick<ChatwootClient, "sendMessage" | "getMessages">;
  conversationId: number;
  format: ConversationNoteFormat;
  items: readonly TurnErrorItem[];
  flow: FlowContext;
}): Promise<"posted" | "nothing" | "repeated" | "failed"> {
  if (params.format === "off") return "nothing";
  const text = turnErrorsText(params.items, params.flow.turnId);
  if (text === null) return "nothing";
  const key = turnErrorsKey(params.items);
  try {
    // NOTE: The same failure turn after turn is one message, not a timeline of them.
    if ((await lastErrorsKey(params.client, params.conversationId)) === key)
      return "repeated";
    // NOTE: A tool name is the operator's, but Chatwoot renders a message through Liquid, so it is
    // escaped like any text we did not write.
    await params.client.sendMessage(
      params.conversationId,
      literalForChatwoot(text),
      {
        ...formatSendOptions(params.format),
        activity: "errors",
        activityAttributes: { [CHATWOOT_ERRORS_KEY_KEY]: key },
      },
    );
    return "posted";
  } catch (err) {
    const message = sanitizeErrorMessage(err);
    logger.warn(
      "conversation-notes: turn-errors message not posted (conv=%s): %s",
      String(params.conversationId),
      message,
    );
    emitFlowEvent(params.flow, {
      stage: "generate",
      level: "info",
      status: "error",
      detail: { turnErrorsMessage: "failed" },
      errorMessage: message,
    });
    return "failed";
  }
}
