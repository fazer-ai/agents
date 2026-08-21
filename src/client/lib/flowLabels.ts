import type { TFunction } from "i18next";

// Human-friendly labels for the closed execution-flow vocabularies (src/modules/flowlog/stages.ts).
// Static t() literals (switch) so the i18next extractor picks them up directly — unknown values
// fall back to the raw string so the UI never renders blank.

export function flowStageLabel(stage: string, t: TFunction): string {
  switch (stage) {
    case "stt":
      return t("logs.stage.stt", "Transcription");
    case "embed":
      return t("logs.stage.embed", "Embedding");
    case "debounce":
      return t("logs.stage.debounce", "Message grouping");
    case "contact_auth":
      return t("logs.stage.contact_auth", "Contact authorization");
    case "generate":
      return t("logs.stage.generate", "Generation");
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
