import type { TFunction } from "i18next";

// Human-friendly labels for the closed OUTBOUND_EVENTS set
// (src/modules/webhooks/outbound/events.ts). Keyed by the internal event string the API returns;
// static t() literals so the i18next extractor picks them up directly (no magic comments). Unknown
// or future events fall back to the raw string so the UI never renders blank.
export function webhookEventLabel(ev: string, t: TFunction): string {
  switch (ev) {
    case "conversation.created":
      return t(
        "webhooks.eventLabels.conversationCreated",
        "Conversation created",
      );
    case "conversation.status_changed":
      return t(
        "webhooks.eventLabels.conversationStatusChanged",
        "Conversation status changed",
      );
    case "conversation.handoff":
      return t(
        "webhooks.eventLabels.conversationHandoff",
        "Handed off to a human",
      );
    case "kanban.card_moved":
      return t("webhooks.eventLabels.kanbanCardMoved", "Kanban card moved");
    case "llm.usage":
      return t("webhooks.eventLabels.llmUsage", "LLM usage reported");
    case "document.approval_requested":
      return t(
        "webhooks.eventLabels.documentApprovalRequested",
        "Document approval requested",
      );
    case "document.approval_decided":
      return t(
        "webhooks.eventLabels.documentApprovalDecided",
        "Document approval decided",
      );
    case "document.approval_outcome":
      return t(
        "webhooks.eventLabels.documentApprovalOutcome",
        "Document approval outcome",
      );
    case "tenant.created":
      return t("webhooks.eventLabels.tenantCreated", "Workspace created");
    case "heartbeat":
      return t("webhooks.eventLabels.heartbeat", "Heartbeat (periodic signal)");
    default:
      return ev;
  }
}
