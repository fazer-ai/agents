// Per-agent debounce configuration, read from the free-form `agent.settings.debounce` bag (same
// pattern as grounding.maxDistance). The writer (UI/REST/MCP) is opaque to validation, so this
// reader is the single source of defaults + clamping: any malformed/out-of-range value collapses to
// a safe default, so a bad setting can never break the flush. Surfaced in the agent editor UI.

export interface DebounceConfig {
  enabled: boolean;
  // How long to wait after the LAST inbound message before flushing (the coalescing window).
  windowSeconds: number;
  // Hard cap on messages coalesced into one turn (context/cost guard). The most recent N are kept.
  maxMessagesPerBurst: number;
  // Anti-starvation ceiling: a burst is flushed at most this long after it STARTED, even if the
  // customer keeps typing (each message would otherwise push the window).
  maxWindowSeconds: number;
}

// Defaults match the n8n workflows' behavior (a ~15s coalescing wait, on by default) while adding
// the guards n8n lacked (per-burst cap, anti-starvation ceiling).
export const DEBOUNCE_DEFAULTS: DebounceConfig = {
  enabled: true,
  windowSeconds: 15,
  maxMessagesPerBurst: 20,
  maxWindowSeconds: 60,
};

// windowSeconds floor is tied to the worker cadence (a window shorter than the tick is pointless);
// keep it in sync with DEBOUNCE_WORKER_INTERVAL_MS's documented minimum (3s).
export const WINDOW_MIN_SECONDS = 3;
export const WINDOW_MAX_SECONDS = 120;
const MAX_MESSAGES_FLOOR = 1;
const MAX_MESSAGES_CEIL = 50;
const MAX_WINDOW_CEIL = 600;

function clampInt(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.round(v), min), max);
}

// Reads agent.settings.debounce, applying defaults + clamps. Returns DEBOUNCE_DEFAULTS when absent.
export function readDebounceConfig(settings: unknown): DebounceConfig {
  const d =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).debounce
      : undefined;
  if (!d || typeof d !== "object") return { ...DEBOUNCE_DEFAULTS };
  const bag = d as Record<string, unknown>;
  const enabled =
    typeof bag.enabled === "boolean" ? bag.enabled : DEBOUNCE_DEFAULTS.enabled;
  const windowSeconds = clampInt(
    bag.windowSeconds,
    WINDOW_MIN_SECONDS,
    WINDOW_MAX_SECONDS,
    DEBOUNCE_DEFAULTS.windowSeconds,
  );
  const maxMessagesPerBurst = clampInt(
    bag.maxMessagesPerBurst,
    MAX_MESSAGES_FLOOR,
    MAX_MESSAGES_CEIL,
    DEBOUNCE_DEFAULTS.maxMessagesPerBurst,
  );
  // maxWindow can never be shorter than the window itself.
  const maxWindowSeconds = clampInt(
    bag.maxWindowSeconds,
    windowSeconds,
    MAX_WINDOW_CEIL,
    Math.max(DEBOUNCE_DEFAULTS.maxWindowSeconds, windowSeconds),
  );
  return { enabled, windowSeconds, maxMessagesPerBurst, maxWindowSeconds };
}
