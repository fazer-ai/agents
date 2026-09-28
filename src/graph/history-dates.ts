import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { stampedSentAt } from "./markers";
import { formatParts, partsInTimezone } from "./time";

// The history, dated, as the model reads it: without it a customer who vanished for a week and came
// back with "segue" is answered as if everything above were happening now (`{{idade_ultima_mensagem}}`
// dates only the newest message). Rendered on the way to the provider from each message's stored
// instant (./markers.ts `sentAtStamp`), never into the checkpoint, where the summarizer and playground
// would quote it as the customer's words. Absolute (the rule in docs/graph.md): "há 3 dias" lies once
// re-read, and a fixed date keeps the prefix cacheable. Only what a person sent is dated: a model shown
// its own lines behind a date starts writing one to the customer. No stored instant, no date: unknown
// never becomes "now". Fixed format, in the agent's timezone.
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
  // NOTE: a copy: the message in state is the checkpoint's, and this one only travels to the provider.
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
