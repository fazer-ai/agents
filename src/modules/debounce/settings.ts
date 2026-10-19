import { clampToRange } from "@/lib/number-range";
import { DEBOUNCE_RANGES } from "@/modules/agents/number-ranges";

// Per-agent debounce configuration, read from `agent.settings.debounce`. The write schema refuses a
// number outside DEBOUNCE_RANGES; this reader still falls back on a malformed value and
// clamps one stored before that, so a bad row can never break the flush. Surfaced in the agent editor.

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
  const windowSeconds = clampToRange(
    bag.windowSeconds,
    DEBOUNCE_RANGES.windowSeconds,
    DEBOUNCE_DEFAULTS.windowSeconds,
  );
  const maxMessagesPerBurst = clampToRange(
    bag.maxMessagesPerBurst,
    DEBOUNCE_RANGES.maxMessagesPerBurst,
    DEBOUNCE_DEFAULTS.maxMessagesPerBurst,
  );
  // maxWindow can never be shorter than the window itself.
  const maxWindowSeconds = clampToRange(
    bag.maxWindowSeconds,
    { ...DEBOUNCE_RANGES.maxWindowSeconds, min: windowSeconds },
    Math.max(DEBOUNCE_DEFAULTS.maxWindowSeconds, windowSeconds),
  );
  return { enabled, windowSeconds, maxMessagesPerBurst, maxWindowSeconds };
}
