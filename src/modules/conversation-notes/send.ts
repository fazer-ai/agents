import type { ConversationNoteFormat } from "./settings";

// How a message in a format reaches Chatwoot: an activity row (`message_type: activity`, notifies
// nobody) or a private note. Neither is shown to the contact nor delivered to the channel. Until the
// fork creates an activity row without a sender, the API attributes it to the contact, which moves the
// contact's `last_activity_at` (docs/chatwoot.md).
export function formatSendOptions(
  format: Exclude<ConversationNoteFormat, "off">,
): { private: true } | { messageType: "activity" } {
  return format === "note" ? { private: true } : { messageType: "activity" };
}
