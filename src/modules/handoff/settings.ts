import { clipText } from "@/lib/text";
// Per-agent handoff targeting, read from `agent.settings.handoff`. Controls WHO receives the
// conversation when the `handoff_to_human` native tool fires (the summary-note behavior stays on the
// `Agent.transferWithSummary` column):
//   * "route"        → just set the conversation to open; Chatwoot's inbox routing assigns whoever
//                      (round-robin / assignment policy). Default — previous behavior, retrocompatible.
//   * "pinned"       → assign to a fixed agent OR team the operator picked (targetAgentId/targetTeamId).
//   * "agent_choice" → the model may pass a target NAME (agent or team), resolved against the live
//                      Chatwoot list at call time; the operator lists the options in the prompt.
import { TOOL_INSTRUCTIONS_MAX } from "@/modules/agents/text-caps";

export type HandoffMode = "route" | "pinned" | "agent_choice";

export interface HandoffConfig {
  mode: HandoffMode;
  // Chatwoot ids (numbers). For "pinned": at most one is set (agent takes precedence). Ignored for
  // the other modes.
  targetAgentId: number | null;
  targetTeamId: number | null;
  // Our ChatwootInstance DB id (a small BigInt stored as a number) the pinned target was picked from.
  // Agents/teams are account-scoped, so a pinned id is only valid in this account; the runtime applies
  // the pinned target ONLY when the conversation's instance matches, else it falls back to agent_choice
  // (the editor blocks pinning when the agent spans multiple accounts, this covers later binding drift).
  // null ⇒ legacy/single-account pinned (applied as before).
  targetInstanceId: number | null;
  // Optional operator-authored guidance, appended to the handoff_to_human tool description so the
  // transfer logic ("when / to whom to escalate") lives in one place instead of buried in the prompt.
  // null ⇒ no extra guidance. Trimmed + length-capped on read.
  instructions: string | null;
}

export const HANDOFF_DEFAULTS: HandoffConfig = {
  mode: "route",
  targetAgentId: null,
  targetTeamId: null,
  targetInstanceId: null,
  instructions: null,
};

// Cap operator guidance so it can't bloat the tool description / prompt budget unboundedly. The
// number lives in the shared table (with the write boundary and the editor that declare it), and is
// re-exported here so callers keep importing it next to the reader that applies it.
export { TOOL_INSTRUCTIONS_MAX } from "@/modules/agents/text-caps";

export function readToolInstructions(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? clipText(t, TOOL_INSTRUCTIONS_MAX) : null;
}

// Exported so the MCP argument schema can declare the choices without re-typing them: a mode
// added here reaches that schema by import rather than by somebody remembering.
export const HANDOFF_MODES = [
  "route",
  "pinned",
  "agent_choice",
] as const satisfies readonly HandoffMode[];

function posInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

export function readHandoffConfig(settings: unknown): HandoffConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).handoff
      : undefined;
  if (!s || typeof s !== "object") return { ...HANDOFF_DEFAULTS };
  const bag = s as Record<string, unknown>;
  const mode = typeof bag.mode === "string" ? bag.mode : "";
  return {
    mode: (HANDOFF_MODES as readonly string[]).includes(mode)
      ? (mode as HandoffMode)
      : "route",
    targetAgentId: posInt(bag.targetAgentId),
    targetTeamId: posInt(bag.targetTeamId),
    targetInstanceId: posInt(bag.targetInstanceId),
    instructions: readToolInstructions(bag.instructions),
  };
}
