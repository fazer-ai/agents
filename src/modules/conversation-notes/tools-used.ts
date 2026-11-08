import logger from "@/api/lib/logger";
import { sanitizeErrorMessage } from "@/lib/redact";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { literalForChatwoot } from "@/modules/chatwoot/liquid";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { formatSendOptions } from "./send";
import type { ConversationNoteFormat } from "./settings";

// The tools one turn called, as the private note the team reads in Chatwoot. Names only: an
// argument or a result is the customer's data (a CPF, an address), and the note is read by
// everyone on the inbox. One note per turn, so a turn of many calls is one line in the timeline.

// Past this many distinct tools the rest is counted, so a runaway turn still posts a short note.
export const TOOLS_USED_NOTE_MAX_NAMES = 20;

export interface CalledTool {
  name: string;
  calls: number;
}

export function toolsUsedNoteText(
  called: readonly CalledTool[],
): string | null {
  if (called.length === 0) return null;
  const shown = called
    .slice(0, TOOLS_USED_NOTE_MAX_NAMES)
    .map((t) => (t.calls > 1 ? `${t.name} (${t.calls}x)` : t.name));
  const rest = called.length - shown.length;
  return `Ferramentas usadas pelo agente neste turno: ${shown.join(", ")}${rest > 0 ? ` e mais ${rest}` : ""}.`;
}

// Best-effort: the turn is over when this runs, so a note that does not land costs the team a line
// and nothing else. Never throws.
export async function postToolsUsedNote(params: {
  client: Pick<ChatwootClient, "sendMessage">;
  conversationId: number;
  format: ConversationNoteFormat;
  called: readonly CalledTool[];
  flow: FlowContext;
}): Promise<"posted" | "nothing" | "failed"> {
  if (params.format === "off") return "nothing";
  const text = toolsUsedNoteText(params.called);
  if (text === null) return "nothing";
  try {
    // NOTE: A tool name is the operator's, but Chatwoot renders a note through Liquid, so it is
    // escaped like any text we did not write.
    await params.client.sendMessage(
      params.conversationId,
      literalForChatwoot(text),
      { ...formatSendOptions(params.format), activity: "tools" },
    );
    return "posted";
  } catch (err) {
    const message = sanitizeErrorMessage(err);
    logger.warn(
      "conversation-notes: tools-used note not posted (conv=%s): %s",
      String(params.conversationId),
      message,
    );
    emitFlowEvent(params.flow, {
      stage: "generate",
      level: "info",
      status: "error",
      detail: { toolsUsedNote: "failed" },
      errorMessage: message,
    });
    return "failed";
  }
}
