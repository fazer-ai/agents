import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { stampedSentAt } from "./markers";
import { formatParts, partsInTimezone } from "./time";

// THE HISTORY, DATED, as the model reads it (issue #755). Without this the thread is plain text: the
// customer who asked for a quote, vanished for a week and came back with "segue" is answered as if
// everything above that word were happening now. `{{idade_ultima_mensagem}}` (#749) dates the LAST
// message only, which is exactly the one that is fresh in that case.
//
// Rendered HERE, on the way to the provider, from the instant stored on each message
// (markers.ts, `sentAtStamp`), and never written into the checkpoint: the summarizer and the
// playground read the stored text, and a date baked into it would be quoted as the customer's words.
//
// ABSOLUTE, for the rule docs/graph.md states for every fact a turn writes: a date ages without lying,
// "há 3 dias" lies the moment it is re-read, and the history is re-read on every turn. It also keeps
// the prefix byte-identical from one turn to the next, so the provider's prompt cache still holds it.
// The age of the newest message stays with the prompt variable, which is rendered fresh each turn.
//
// Only what a person sent carries a date: the customer's messages and a human agent's replies. An
// assistant reply is not dated, on purpose — a model shown its own past lines behind a bracketed date
// starts writing one in front of its next, and that line goes to the customer.
//
// Fixed format, in the agent's timezone. A message with no stored instant is shown as it always was:
// unknown never becomes "now".
export const HISTORY_DATE_FORMAT = "DD/MM/YYYY HH:mm";

export function historyDate(at: Date, timezone: string): string {
  return `[${formatParts(partsInTimezone(at, timezone), HISTORY_DATE_FORMAT)}]`;
}

function dated(message: BaseMessage, timezone: string): BaseMessage {
  if (message.getType() !== "human") return message;
  const at = stampedSentAt(message);
  if (!at) return message;
  const stamp = historyDate(at, timezone);
  const content =
    typeof message.content === "string"
      ? `${stamp} ${message.content}`
      : [{ type: "text" as const, text: stamp }, ...message.content];
  // A copy: the message in state is the checkpoint's, and this one only travels to the provider.
  return new HumanMessage({
    ...(message.id ? { id: message.id } : {}),
    ...(message.name ? { name: message.name } : {}),
    content,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
  });
}

export function datedHistory(
  messages: BaseMessage[],
  timezone: string,
): BaseMessage[] {
  return messages.map((m) => dated(m, timezone));
}
