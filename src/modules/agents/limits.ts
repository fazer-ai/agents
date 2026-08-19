// Per-agent runtime limits, read from agent.settings.limits (Json, additive). Mirrors
// readDebounceConfig / readSttConfig.
//
// - maxToolCalls: the soft+hard cap on tool executions within a SINGLE turn. The graph counts tool
//   executions since the last customer message; at maxToolCalls-2 it nudges the model to wrap up,
//   and at maxToolCalls it invokes the model WITHOUT tools so the turn always ends in a text answer
//   instead of hitting LangGraph's GraphRecursionError.
// - maxHistoryTokens: ceiling on the persisted history handed to the model each turn. null = no
//   ceiling, which is the historical behavior and stays the default: an instance that upgrades must
//   never silently start forgetting. See src/graph/history-window.ts for what the ceiling buys.

export interface LimitsConfig {
  maxToolCalls: number;
  // Token ceiling for the message history only. The system prompt and the tool definitions are NOT
  // counted: they are not trimmable, and the operator's budget has to sit above them.
  maxHistoryTokens: number | null;
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

export function readLimitsConfig(settings: unknown): LimitsConfig {
  const def: LimitsConfig = {
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    maxHistoryTokens: null,
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

  // NOTE: Absent, non-numeric, zero and negative all mean OFF. Clamping 0 up to the minimum would
  // turn "no ceiling" into "the tightest ceiling available", which is the opposite of the intent
  // and unrecoverable from the editor, where an emptied field is what an operator types to disable.
  const raw = bag.maxHistoryTokens;
  const rounded =
    typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : 0;
  const maxHistoryTokens =
    rounded > 0
      ? Math.min(MAX_HISTORY_TOKENS, Math.max(MIN_HISTORY_TOKENS, rounded))
      : null;

  return { maxToolCalls, maxHistoryTokens };
}
