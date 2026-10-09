import { projectDecisionsBlock } from "@/modules/decisions/config";

// What a monitoring agent DOES with what it reads, configured under `agent.settings.monitoring`.
// Read leniently, like every other behavior block: a missing or malformed field takes its default.
// It holds only what is about OBSERVING (when to look, how much to read): what a watcher does with
// a conversation is its prompt and tools, as for a responder (labelling is `set_labels`).

export type MonitoringAnalysis = "incremental" | "on_resolve";

// HOW the watcher decides: `llm` is the ordinary graph with the agent's prompt and tools;
// `decisions` asks a classification API typed questions and turns the answers
// into tool calls by rule (modules/decisions, docs/decisions.md). Anything else reads as `llm`, so a
// row written before the key existed, or with a value this build does not know, keeps today's path.
export type MonitoringEngine = "llm" | "decisions";

export interface MonitoringConfig {
  engine: MonitoringEngine;
  // The `decisions` engine's block, CARRIED as stored and validated where it is used
  // (modules/decisions/config.ts): this reader is the one every rewrite of `monitoring` goes through
  // (the MCP merge, the console's save), so a block it did not carry would be deleted by them.
  decisions: Record<string, unknown> | null;
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
  engine: "llm",
  decisions: null,
  analysis: "incremental",
  window: { messages: 20 },
  debounce: { windowSeconds: 20, maxWindowSeconds: 60 },
});

export const WINDOW_MESSAGES_MIN = 4;
export const WINDOW_MESSAGES_MAX = 60;
// ZERO IS A SETTING, not a floor to round up from: the observation is due the moment the message is
// ingested, one model call per customer message, for an operator who wants the verdict while the
// conversation is happening. The drain is woken at the row's own instant (`wakeObserveDrainAt`), so
// a window below the drain's interval is honored and not rounded up to it.
export const OBSERVE_WINDOW_MIN_SECONDS = 0;
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
    engine: bag.engine === "decisions" ? "decisions" : "llm",
    decisions: projectDecisionsBlock(bag.decisions),
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
