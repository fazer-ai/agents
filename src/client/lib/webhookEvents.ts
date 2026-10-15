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

// The name of an event family in the console. `null` is the group of events with no family.
export function webhookFamilyLabel(
  family: string | null,
  t: TFunction,
): string {
  switch (family) {
    case "conversation":
      return t("webhooks.families.conversation", "Conversations");
    case "document":
      return t("webhooks.families.document", "Documents");
    case "kanban":
      return t("webhooks.families.kanban", "Kanban board");
    case "llm":
      return t("webhooks.families.llm", "Usage");
    case "tenant":
      return t("webhooks.families.tenant", "Workspace");
    case null:
      return t("webhooks.families.system", "System");
    default:
      return family;
  }
}

// One line on when an event fires and what its `data` carries, under its label in the form.
export function webhookEventDescription(
  ev: string,
  t: TFunction,
): string | null {
  switch (ev) {
    case "conversation.created":
      return t(
        "webhooks.eventDescriptions.conversationCreated",
        "A new conversation arrives. Ids, inbox, status and who it is assigned to.",
      );
    case "conversation.status_changed":
      return t(
        "webhooks.eventDescriptions.conversationStatusChanged",
        "A conversation changes status (open, pending, snoozed, resolved). The new and the previous one.",
      );
    case "conversation.handoff":
      return t(
        "webhooks.eventDescriptions.conversationHandoff",
        "A person is assigned to the conversation. Conversation and inbox ids.",
      );
    case "kanban.card_moved":
      return t(
        "webhooks.eventDescriptions.kanbanCardMoved",
        "The agent moves a card to another step. Card, step and conversation.",
      );
    case "llm.usage":
      return t(
        "webhooks.eventDescriptions.llmUsage",
        "A model call is billed. Model, step and token counts.",
      );
    case "tenant.created":
      return t(
        "webhooks.eventDescriptions.tenantCreated",
        "A workspace is created on this instance.",
      );
    case "document.approval_requested":
      return t(
        "webhooks.eventDescriptions.documentApprovalRequested",
        "A document waits for a person to approve it. Request, template, conversation and expiry.",
      );
    case "document.approval_decided":
      return t(
        "webhooks.eventDescriptions.documentApprovalDecided",
        "An approval is approved, rejected or expires. Status, reviewer and issued document.",
      );
    case "document.approval_outcome":
      return t(
        "webhooks.eventDescriptions.documentApprovalOutcome",
        "What the decision came to in the conversation: delivered, noted, not sent or handed over.",
      );
    case "heartbeat":
      return t(
        "webhooks.eventDescriptions.heartbeat",
        "A periodic signal that the instance is up.",
      );
    default:
      return null;
  }
}
