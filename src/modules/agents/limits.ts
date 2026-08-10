// Per-agent runtime limits, read from agent.settings.limits (Json, additive). Mirrors
// readDebounceConfig / readSttConfig.
//
// - maxToolCalls: the soft+hard cap on tool executions within a SINGLE turn. The graph counts tool
//   executions since the last customer message; at maxToolCalls-2 it nudges the model to wrap up, and
//   at maxToolCalls it invokes the model WITHOUT tools so the turn always ends in a text answer
//   instead of hitting LangGraph's GraphRecursionError.
// - maxHistoryTokens: ceiling on the persisted history sent to the model each turn (the graph
//   thread is per contact-inbox and grows without bound — see below). null = no ceiling.
// - forgetResolvedAfterDays: how long a finished attendance stays in that memory. null = forever.
//
// WHY THE LAST TWO EXIST. The checkpointer thread spans every conversation a contact has on one
// channel, and the agent node sends the whole history on every call. Nothing ever trimmed it, so a
// contact who came back a few times could reach a six-figure token count per turn — measured in the
// field: 79.8k tokens of context against a 15.8k floor (prompt + tool definitions), i.e. 64k of
// conversations that had already ended, re-sent on every single turn. That is paid twice: in
// provider rate limits (a 200k TPM org fits ~2.5 turns/min at that size) and in latency.
//
// The two knobs attack different halves and are meant to be used together:
//   forgetResolvedAfterDays drops what is over (a CLOSED attendance) — cutting on a real semantic
//     boundary rather than an arbitrary token offset. This is the cause.
//   maxHistoryTokens bounds what is still open (one long-running conversation never gets resolved,
//     so the retention sweep never sees it). This is the safety net.
//
// Both default to OFF: an instance that upgrades must not silently start forgetting.

export interface LimitsConfig {
  maxToolCalls: number;
  // Token ceiling for the message history handed to the model (system prompt and tool definitions
  // are NOT counted here — they are not trimmable). null disables trimming.
  maxHistoryTokens: number | null;
  // Days after a conversation is resolved before its memory may be dropped. null disables the
  // sweep. Keep this comfortably ABOVE the longest follow-up delay: the follow-up ladder runs on
  // this same thread on purpose, so forgetting too early makes a scheduled follow-up wake up with
  // no idea what the conversation was about.
  forgetResolvedAfterDays: number | null;
}

export const DEFAULT_MAX_TOOL_CALLS = 10;
const MIN_TOOL_CALLS = 1;
const MAX_TOOL_CALLS = 50;

// Floor chosen so a ceiling can never squeeze the history below "the current conversation": under
// ~2k tokens the model loses the turn it is answering, which reads as amnesia, not as thrift.
const MIN_HISTORY_TOKENS = 2_000;
const MAX_HISTORY_TOKENS = 1_000_000;

const MIN_FORGET_DAYS = 1;
const MAX_FORGET_DAYS = 3_650;

// Reads an optional positive-integer knob: absent/invalid → null (feature off), never a surprise
// default. `0` and negatives disable it too — the alternative (clamping 0 up to the minimum) would
// turn "off" into "the tightest possible setting", which is the opposite of the intent.
function readOptionalInt(
  raw: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const rounded = Math.round(raw);
  if (rounded <= 0) return null;
  return Math.min(max, Math.max(min, rounded));
}

export function readLimitsConfig(settings: unknown): LimitsConfig {
  const def: LimitsConfig = {
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    maxHistoryTokens: null,
    forgetResolvedAfterDays: null,
  };
  if (!settings || typeof settings !== "object") return def;
  const l = (settings as Record<string, unknown>).limits;
  if (!l || typeof l !== "object") return def;
  const bag = l as Record<string, unknown>;

  const v = bag.maxToolCalls;
  const maxToolCalls =
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(MAX_TOOL_CALLS, Math.max(MIN_TOOL_CALLS, Math.round(v)))
      : DEFAULT_MAX_TOOL_CALLS;

  return {
    maxToolCalls,
    maxHistoryTokens: readOptionalInt(
      bag.maxHistoryTokens,
      MIN_HISTORY_TOKENS,
      MAX_HISTORY_TOKENS,
    ),
    forgetResolvedAfterDays: readOptionalInt(
      bag.forgetResolvedAfterDays,
      MIN_FORGET_DAYS,
      MAX_FORGET_DAYS,
    ),
  };
}
