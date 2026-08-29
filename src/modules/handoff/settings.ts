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

// Per-agent conversation TAKEOVER, read from `agent.settings.takeover`.
//
// A block of its own rather than a field on `handoff` above, and the reason is a write boundary, not
// taxonomy. `handoff` is config OF the handoff_to_human tool: the console's Tools tab owns it and
// REPLACES it wholesale on every save (serializeHandoff), so a field that tab's form did not carry
// would be silently reset to its default the next time anybody touched a tool. This one is not
// tool-coupled either — it applies whether or not the agent has that tool at all.
export interface TakeoverConfig {
  // A person answering the customer in this conversation ends the agent's attendance on it, the same
  // way the `handoff_to_human` tool does: the conversation leaves `pending` for the human queue, and
  // the gate, the debounce flush and the follow-up ladder all go quiet on it with no new state.
  // Covers both routes a person can answer by — the Chatwoot composer and the phone paired to the
  // number the inbox is connected to (issue #430).
  //
  // ON BY DEFAULT, which is the opposite of how the rest of the settings bag defaults, so the reason
  // is written down here the way `memory` writes its own. Without it the agent answers OVER a
  // colleague who is already in the thread: MEASURED on a live fork, a composer reply and a phone
  // reply both leave the conversation `pending` and bot-owned (the fork hard-returns false from
  // `captain_pending_conversation?`, so Chatwoot's own
  // `mark_pending_conversation_as_open_for_human_response` never fires), and on one production
  // deployment the agent replied 31 seconds after an attendant's voice note and the follow-up ladder
  // re-engaged a thread a person was running. Defaulting it off would mean every install keeps that
  // behaviour until an operator goes looking for a switch they have no reason to suspect exists.
  //
  // It is a switch and not a constant because "a human spoke" is not universally a handoff: a flow
  // where a person seeds context and hands the thread BACK to the agent is coherent, and this is the
  // only knob that keeps it possible. Turning it off restores exactly the previous behaviour —
  // nothing else reads it.
  onHumanReply: boolean;
}

export const TAKEOVER_DEFAULTS: TakeoverConfig = { onHumanReply: true };

export function readTakeoverConfig(settings: unknown): TakeoverConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).takeover
      : undefined;
  if (!s || typeof s !== "object") return { ...TAKEOVER_DEFAULTS };
  // Explicit `false` is the only thing that turns it off. A bag written before this block existed has
  // no key at all and must project ON, and so must a bag carrying any other value — a string, a null,
  // a number from a hand-edited blob — because the safe answer for an unreadable switch is the one
  // that keeps the agent off a conversation a person is holding.
  return {
    onHumanReply: (s as Record<string, unknown>).onHumanReply !== false,
  };
}
