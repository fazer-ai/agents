// What a monitoring agent DOES with what it reads (issue #477), configured under
// `agent.settings.monitoring`. Read leniently, like every other behavior block: a missing or
// malformed field takes its default.
//
// WHAT USED TO BE HERE and is deliberately gone (issue #568): the label groups. A monitoring agent
// was a classifier, and this block told it what to classify into — a taxonomy with its own screen,
// its own schema, its own write-time assertions and its own cross-agent conflict rules. None of
// that belonged to the MODE. A watcher is the ordinary agent that cannot answer the customer, and
// what it does with a conversation is what its prompt and its tools say, exactly as for a
// responder: labelling is `set_labels`, and which labels exclude each other is a sentence in the
// operator's own prompt, not a structure the product stores.
//
// What is left is what is genuinely about OBSERVING: when to look, and how much to read.

export type MonitoringAnalysis = "incremental" | "on_resolve";

export interface MonitoringConfig {
  // `incremental`: a turn per debounced burst of customer messages, and a final one on resolve.
  // `on_resolve`: the final one only.
  analysis: MonitoringAnalysis;
  // How much of the conversation the model reads, in messages, newest first.
  window: { messages: number };
  // The burst window the OBSERVE job coalesces on, separate from the responder's debounce because
  // a watcher's work can wait longer than a reply.
  debounce: { windowSeconds: number; maxWindowSeconds: number };
}

export const MONITORING_DEFAULTS: Readonly<MonitoringConfig> = Object.freeze({
  analysis: "incremental",
  window: { messages: 20 },
  debounce: { windowSeconds: 20, maxWindowSeconds: 60 },
});

export const WINDOW_MESSAGES_MIN = 4;
export const WINDOW_MESSAGES_MAX = 60;
export const OBSERVE_WINDOW_MIN_SECONDS = 3;
export const OBSERVE_WINDOW_MAX_SECONDS = 600;

function clampInt(v: unknown, min: number, max: number, fallback: number) {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.round(v), min), max);
}

export function readMonitoringConfig(settings: unknown): MonitoringConfig {
  const def = MONITORING_DEFAULTS;
  const m =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).monitoring
      : undefined;
  if (!m || typeof m !== "object") {
    return {
      ...def,
      window: { ...def.window },
      debounce: { ...def.debounce },
    };
  }
  const bag = m as Record<string, unknown>;
  const window =
    bag.window && typeof bag.window === "object"
      ? (bag.window as Record<string, unknown>)
      : {};
  const debounce =
    bag.debounce && typeof bag.debounce === "object"
      ? (bag.debounce as Record<string, unknown>)
      : {};
  const windowSeconds = clampInt(
    debounce.windowSeconds,
    OBSERVE_WINDOW_MIN_SECONDS,
    OBSERVE_WINDOW_MAX_SECONDS,
    def.debounce.windowSeconds,
  );
  const maxWindowSeconds = clampInt(
    debounce.maxWindowSeconds,
    windowSeconds,
    OBSERVE_WINDOW_MAX_SECONDS,
    Math.max(def.debounce.maxWindowSeconds, windowSeconds),
  );
  return {
    analysis: bag.analysis === "on_resolve" ? "on_resolve" : "incremental",
    window: {
      messages: clampInt(
        window.messages,
        WINDOW_MESSAGES_MIN,
        WINDOW_MESSAGES_MAX,
        def.window.messages,
      ),
    },
    debounce: { windowSeconds, maxWindowSeconds },
  };
}
