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

// The outcomes of a guardrail line that could not set up a screening at all. Nothing was judged, so
// the gate failed open and the message went on unchecked, on rows written before `detail.unchecked`
// existed too. `analysis_failed` is not here: on those older rows it also covers a screening that
// failed in part while another check tripped and stopped the message.
const GUARDRAIL_NEVER_JUDGED_OUTCOMES = new Set([
  "credential_not_found",
  "model_unavailable",
]);

// What a guardrail line that could not judge meant for the message, in words, or null for any other
// line, including a screening that failed in part and still tripped (`unchecked: false`).
export function guardrailUncheckedLabel(
  stage: string,
  detail: Record<string, unknown> | null,
  t: TFunction,
): string | null {
  if (stage !== "guardrail" || !detail) return null;
  // The external check's lines read through `guardrailExternalLabel`.
  if (detail.check === "external") return null;
  if (detail.held === true) {
    switch (detail.direction) {
      case "input":
        return t(
          "logs.guardrailHeld.input",
          "The check failed, so the customer's message was held and a hand-over to the team was requested",
        );
      case "output":
        return t(
          "logs.guardrailHeld.output",
          "The check failed, so the reply was held and a hand-over to the team was requested",
        );
      default:
        return null;
    }
  }
  if (detail.unchecked === false) return null;
  const outcome = typeof detail.outcome === "string" ? detail.outcome : null;
  const unchecked =
    detail.unchecked === true ||
    (outcome !== null && GUARDRAIL_NEVER_JUDGED_OUTCOMES.has(outcome));
  if (!unchecked) {
    if (outcome !== "analysis_failed") return null;
    return t(
      "logs.guardrailUnchecked.unknown",
      "The check failed; this older line does not record whether the message was let through",
    );
  }
  switch (detail.direction) {
    case "input":
      return t(
        "logs.guardrailUnchecked.input",
        "The check failed, so the customer's message was let through unchecked",
      );
    case "output":
      return t(
        "logs.guardrailUnchecked.output",
        "The check failed, so the reply was let through unchecked",
      );
    default:
      return null;
  }
}

// A line the external check wrote (detail.check = "external"), as the row's headline: what the
// operator's endpoint decided, how long it took, and its reason; or, on a failure, why and what
// happened to the reply. Null for any other line.
export function guardrailExternalLabel(
  stage: string,
  detail: Record<string, unknown> | null,
  t: TFunction,
): string | null {
  if (stage !== "guardrail" || !detail || detail.check !== "external")
    return null;
  const ms = typeof detail.latencyMs === "number" ? detail.latencyMs : null;
  const reason =
    typeof detail.endpointReason === "string" ? detail.endpointReason : null;
  let head: string;
  if (detail.outcome === "external_failed") {
    const cause =
      typeof detail.cause === "string"
        ? typeof detail.httpStatus === "number"
          ? `${detail.cause} ${detail.httpStatus}`
          : detail.cause
        : "?";
    head =
      detail.held === true
        ? t("logs.guardrailExternal.failedHeld", {
            defaultValue:
              "The external check could not decide ({{cause}}), so the reply was held and a hand-over to the team was requested",
            cause,
          })
        : t("logs.guardrailExternal.failedPassed", {
            defaultValue:
              "The external check could not decide ({{cause}}), so the reply was let through unchecked",
            cause,
          });
  } else if (detail.decision === "allow") {
    head = t(
      "logs.guardrailExternal.allow",
      "The external check allowed the reply",
    );
  } else if (detail.decision === "replace") {
    head = t(
      "logs.guardrailExternal.replace",
      "The external check replaced the reply with its own text",
    );
  } else if (detail.decision === "block") {
    head = t("logs.guardrailExternal.block", {
      defaultValue: "The external check blocked the reply ({{action}})",
      action: typeof detail.action === "string" ? detail.action : "?",
    });
  } else return null;
  return [
    head,
    ms === null
      ? null
      : t("logs.guardrailExternal.latency", {
          defaultValue: "took {{ms}} ms",
          ms,
        }),
    reason
      ? t("logs.guardrailExternal.reason", {
          defaultValue: "reason: {{reason}}",
          reason,
        })
      : typeof detail.reasonChars === "number"
        ? t("logs.guardrailExternal.reasonKept", {
            defaultValue:
              "a reason was given ({{chars}} characters), kept in the conversation's note",
            chars: detail.reasonChars,
          })
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
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

// A tool result's size, as the playground trace and a `tool` flow line carry it: characters and the
// estimated tokens the result adds to every later model call of the turn. Null when there is no size
// to show (a line written before sizes were recorded, or a thrown tool error, which returned nothing).
export function toolResultSizeLabel(
  size: unknown,
  t: TFunction,
  lng: string,
): string | null {
  if (!size || typeof size !== "object") return null;
  const { chars, tokens } = size as { chars?: unknown; tokens?: unknown };
  if (typeof chars !== "number" || typeof tokens !== "number") return null;
  const n = new Intl.NumberFormat(lng);
  return t("logs.toolResultSize", {
    defaultValue: "{{chars}} chars · ~{{tokens}} tokens",
    chars: n.format(chars),
    tokens: n.format(tokens),
  });
}
