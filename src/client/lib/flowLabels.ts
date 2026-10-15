import type { TFunction } from "i18next";

// Human-friendly labels for the closed execution-flow vocabularies (src/modules/flowlog/stages.ts).
// Static t() literals (switch) so the i18next extractor picks them up directly — unknown values
// fall back to the raw string so the UI never renders blank.

export function flowStageLabel(stage: string, t: TFunction): string {
  switch (stage) {
    case "route":
      return t("logs.stage.route", "Routing");
    case "command":
      return t("logs.stage.command", "Control command");
    case "stt":
      return t("logs.stage.stt", "Transcription");
    case "vision":
      return t("logs.stage.vision", "Image reading");
    case "embed":
      return t("logs.stage.embed", "Embedding");
    case "delivery":
      return t("logs.stage.delivery", "Interrupted delivery");
    case "debounce":
      return t("logs.stage.debounce", "Message grouping");
    case "contact_auth":
      return t("logs.stage.contact_auth", "Contact authorization");
    case "spend_ceiling":
      return t("logs.stage.spend_ceiling", "Spend ceiling");
    case "turn_limit":
      return t("logs.stage.turn_limit", "Turn limit");
    case "proactive_limit":
      return t("logs.stage.proactive_limit", "Proactive limit");
    case "proactive_breaker":
      return t("logs.stage.proactive_breaker", "Proactive breaker");
    case "generate":
      return t("logs.stage.generate", "Generation");
    case "guardrail":
      return t("logs.stage.guardrail", "Guardrail check");
    case "tool":
      return t("logs.stage.tool", "Tool call");
    case "normalize":
      return t("logs.stage.normalize", "Speech rewrite");
    case "tts":
      return t("logs.stage.tts", "Audio synthesis");
    case "tts_check":
      return t("logs.stage.tts_check", "Audio check");
    case "split":
      return t("logs.stage.split", "Delivery");
    case "channel_error":
      return t("logs.stage.channel_error", "Channel failure");
    case "handoff":
      return t("logs.stage.handoff", "Handoff");
    case "memory":
      return t("logs.stage.memory", "Memory");
    case "observe":
      return t("logs.stage.observe", "Observation");
    case "webhook":
      return t("logs.stage.webhook", "Outbound webhook");
    case "dead_letter":
      return t("logs.stage.dead_letter", "Abandoned work");
    case "capacity":
      return t("logs.stage.capacity", "Capacity");
    default:
      return stage;
  }
}

export function flowLevelLabel(level: string, t: TFunction): string {
  switch (level) {
    case "info":
      return t("logs.level.info", "Info");
    case "warn":
      return t("logs.level.warn", "Warning");
    case "error":
      return t("logs.level.error", "Error");
    default:
      return level;
  }
}

// The outcomes of a guardrail line that could not judge. The gate fails open on every one of them,
// so the message went on unchecked even on a row written before `detail.unchecked` existed.
const GUARDRAIL_UNCHECKED_OUTCOMES = new Set([
  "analysis_failed",
  "credential_not_found",
  "model_unavailable",
]);

// What a guardrail line that could not judge meant for the message, in words, or null for any other
// line.
export function guardrailUncheckedLabel(
  stage: string,
  detail: Record<string, unknown> | null,
  t: TFunction,
): string | null {
  if (stage !== "guardrail" || !detail) return null;
  const unchecked =
    detail.unchecked === true ||
    (typeof detail.outcome === "string" &&
      GUARDRAIL_UNCHECKED_OUTCOMES.has(detail.outcome));
  if (!unchecked) return null;
  switch (detail.direction) {
    case "input":
      return t(
        "logs.guardrailUnchecked.input",
        "The check failed, so the customer's message reached the agent unchecked",
      );
    case "output":
      return t(
        "logs.guardrailUnchecked.output",
        "The check failed, so the reply went out unchecked",
      );
    default:
      return null;
  }
}

export function guardrailClassifierLabel(
  classifier: unknown,
  t: TFunction,
): string | null {
  switch (classifier) {
    case "chat":
      return t("logs.guardrailClassifier.chat", "language model");
    case "decisions":
      return t("logs.guardrailClassifier.decisions", "classification API");
    default:
      return null;
  }
}
