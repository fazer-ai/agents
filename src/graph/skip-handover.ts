import logger from "@/api/lib/logger";
import { clipText } from "@/lib/text";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import type { SkipReplyReason } from "./silence";
import { RESOLVE_DONE } from "./tools/catalog";

// A silence a person has to see. Nothing takes a conversation out of `pending` once the agent stayed
// out of it (Chatwoot's auto-resolve only scopes `open`), so these silences move it to `open` with a
// private note: `not_for_us` / `needs_human` (the model's `skip_reply` reason), and `unanswered`, the
// deterministic floor for a conversation nobody on our side ever spoke in. The floor does not trust
// the model, which disobeys an instruction to stay quiet. `acknowledged` on an answered conversation
// changes nothing: it is the most frequent path, and a note there would teach operators to ignore
// the two that matter.

// WHETHER THIS TURN ALREADY CLOSED THE CONVERSATION, on the path where the close happens inside the
// tool (every proactive turn: no `turnState`, so `resolve_conversation` toggles on the spot). Read off
// the tool's own result under its name, which the assembly reserves for the native, and bounded at
// the last human message like every other reader of this turn. A conversation the same turn closed
// on purpose is not one to reopen for the queue.
export function resolvedThisTurn(
  messages: readonly {
    getType: () => string;
    name?: string;
    content?: unknown;
  }[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.getType() === "human") return false;
    if (
      m.getType() === "tool" &&
      m.name === "resolve_conversation" &&
      m.content === RESOLVE_DONE
    )
      return true;
  }
  return false;
}

export type SkipHandoverKind = "not_for_us" | "needs_human" | "unanswered";

export function skipHandoverKind(
  chosen: { reason: SkipReplyReason } | null,
  ourSideHasSpoken: boolean,
): SkipHandoverKind | null {
  // The model's own reason wins when it names a person, because it says more than the floor does.
  if (chosen?.reason === "not_for_us" || chosen?.reason === "needs_human")
    return chosen.reason;
  if (!ourSideHasSpoken) return "unanswered";
  return null;
}

// Same hardcoded pt-BR register as the other notes the runtime writes into a conversation (the
// outside-window follow-up, the test-mode notice). What the operator needs from it is why this
// conversation is in their queue with no new message in it.
const NOTE: Record<SkipHandoverKind, string> = {
  not_for_us:
    "🔕 O agente não respondeu porque isto não parece ser um atendimento (um aviso automático, uma cobrança, uma newsletter, uma oferta não solicitada). A conversa foi aberta para alguém da equipe conferir.",
  needs_human:
    "🔕 O agente não respondeu porque o pedido é real, mas ele não tem como resolvê-lo. A conversa foi aberta para alguém da equipe assumir.",
  unanswered:
    "🔕 O agente não respondeu, e ninguém do nosso lado falou nesta conversa ainda. Ela foi aberta para alguém da equipe conferir, em vez de ficar parada sem dono.",
};

export const SKIP_NOTE_DETAIL_MAX = 300;

// The model's one-line description, when it gave one. It is text the MODEL wrote, so it is flattened
// to a single line and bounded: it goes into a note only the team reads, and it must not be able to
// pass for more than one sentence of it.
export function skipHandoverNote(
  kind: SkipHandoverKind,
  detail: string | null,
): string {
  const flat = detail
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point.
    ?.replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const line = flat ? clipText(flat, SKIP_NOTE_DETAIL_MAX) : "";
  return line ? `${NOTE[kind]}\n\nNas palavras do agente: ${line}` : NOTE[kind];
}

// Status first, note after: a note without the status change claims "opened" about a parked
// conversation, while a status without the note is at least SEEN. The private note is inert (fork
// `app/models/message.rb`): it reopens nothing and never stamps `first_reply_created_at`. Best-effort
// and never throws: a failure leaves the conversation where it was, with a warn line.
export async function applySkipHandover(params: {
  client: ChatwootClient;
  conversationId: number;
  kind: SkipHandoverKind;
  detail: string | null;
  flow: FlowContext;
  // The caller's withdrawal fence, asked immediately before EACH write: a `/reset` or a superseding
  // run can land during the status change, and the note must not follow it into a conversation the
  // operator was just told was cleared. Only an explicit `false` stops it.
  stillWanted?: () => Promise<boolean>;
}): Promise<boolean> {
  const { client, conversationId, kind, flow } = params;
  const withdrawn = async () =>
    params.stillWanted ? !(await params.stillWanted()) : false;
  if (await withdrawn()) return false;
  try {
    await client.toggleStatus(conversationId, "open");
  } catch (err) {
    logger.warn(
      { err, conversationId: String(conversationId) },
      "skip handover: could not open the conversation",
    );
    emitFlowEvent(flow, {
      stage: "handoff",
      level: "warn",
      status: "error",
      detail: { outcome: "skip_handover_failed", reason: kind },
    });
    return false;
  }
  let noted = false;
  if (await withdrawn()) {
    emitFlowEvent(flow, {
      stage: "handoff",
      status: "ok",
      detail: { outcome: "opened_after_skip", reason: kind, noted },
    });
    return true;
  }
  noted = true;
  try {
    await client.sendPrivateNote(
      conversationId,
      skipHandoverNote(kind, params.detail),
    );
  } catch (err) {
    noted = false;
    logger.warn(
      { err, conversationId: String(conversationId) },
      "skip handover: opened, but the note did not post",
    );
  }
  emitFlowEvent(flow, {
    stage: "handoff",
    status: "ok",
    detail: { outcome: "opened_after_skip", reason: kind, noted },
  });
  return true;
}
