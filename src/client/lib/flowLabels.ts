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
    case "split":
      return t("logs.stage.split", "Delivery");
    case "handoff":
      return t("logs.stage.handoff", "Handoff");
    case "memory":
      return t("logs.stage.memory", "Memory");
    case "webhook":
      return t("logs.stage.webhook", "Outbound webhook");
    case "dead_letter":
      return t("logs.stage.dead_letter", "Abandoned work");
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
