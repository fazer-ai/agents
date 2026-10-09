// Per-agent runtime limits, read from agent.settings.limits (Json, additive).
// - maxToolCalls: per-turn cap; at max-2 the model is nudged to wrap up, at max it runs WITHOUT tools
//   so the turn ends in text instead of LangGraph's GraphRecursionError.
// - maxHistoryTokens: null (no ceiling) by default, so an upgrade never silently starts forgetting.
// - retrySilence: a reactive turn ending with no reply, handoff or `skip_reply` is asked once more;
//   on unless `false`, since an unanswered customer is the worse failure.
// - maxTurnsPerHour: delivered turns per conversation per rolling hour (src/modules/turn-limit); ON
//   by default, and only an explicit 0 turns it off, so "no limit" is a stored choice.

export interface LimitsConfig {
  maxToolCalls: number;
  // Token ceiling for the message history only. The system prompt and the tool definitions are NOT
  // counted: they are not trimmable, and the operator's budget has to sit above them.
  maxHistoryTokens: number | null;
  retrySilence: boolean;
  // null = no limit.
  maxTurnsPerHour: number | null;
}

export const DEFAULT_MAX_TOOL_CALLS = 10;
const MIN_TOOL_CALLS = 1;
const MAX_TOOL_CALLS = 50;

// Floor chosen so a ceiling can never squeeze the window below the conversation being answered:
// under ~2k tokens the model loses the turn it is replying to, which reads as amnesia rather than
// as thrift. The window selector guarantees the same thing structurally; this only keeps the
// operator from configuring a number that could never do anything useful.
const MIN_HISTORY_TOKENS = 2_000;
const MAX_HISTORY_TOKENS = 1_000_000;

export const DEFAULT_MAX_TURNS_PER_HOUR = 60;
export const MAX_TURNS_PER_HOUR = 1_000;

export function readLimitsConfig(settings: unknown): LimitsConfig {
  const def: LimitsConfig = {
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    maxHistoryTokens: null,
    retrySilence: true,
    maxTurnsPerHour: DEFAULT_MAX_TURNS_PER_HOUR,
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

  // Absent, non-numeric, zero and negative all mean OFF. Clamping 0 up to the minimum would
  // turn "no ceiling" into "the tightest ceiling available", which is the opposite of the intent
  // and unrecoverable from the editor, where an emptied field is what an operator types to disable.
  const raw = bag.maxHistoryTokens;
  const rounded =
    typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : 0;
  const maxHistoryTokens =
    rounded > 0
      ? Math.min(MAX_HISTORY_TOKENS, Math.max(MIN_HISTORY_TOKENS, rounded))
      : null;

  // Only an explicit `false` turns it off: absent, null or anything else keeps the default.
  const retrySilence = bag.retrySilence !== false;

  const turns = bag.maxTurnsPerHour;
  const maxTurnsPerHour =
    typeof turns === "number" && Number.isFinite(turns)
      ? turns <= 0
        ? null
        : Math.min(MAX_TURNS_PER_HOUR, Math.max(1, Math.round(turns)))
      : DEFAULT_MAX_TURNS_PER_HOUR;

  return { maxToolCalls, maxHistoryTokens, retrySilence, maxTurnsPerHour };
}
