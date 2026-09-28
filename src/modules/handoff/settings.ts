import { clipText } from "@/lib/text";
// Per-agent handoff targeting, read from `agent.settings.handoff`. Controls WHO receives the
// conversation when the `handoff_to_human` native tool fires (the summary-note behavior stays on the
// `Agent.transferWithSummary` column):
//   * "route"        → just set the conversation to open; Chatwoot's inbox routing assigns whoever
//                      (round-robin / assignment policy). Default.
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
  // A person answering the customer here (Chatwoot composer or the phone paired to the inbox's number)
  // ends the agent's attendance, like `handoff_to_human`: the conversation leaves `pending`, and the
  // gate, debounce flush and follow-ups go quiet with no new state. ON BY DEFAULT, unlike the rest of
  // the bag: the fork never moves a human-answered conversation out of `pending` itself, so off would
  // leave the agent answering over a colleague. A switch, not a constant, for flows where a person
  // seeds context and hands back; off restores the prior behaviour, and nothing else reads it.
  onHumanReply: boolean;
}

export const TAKEOVER_DEFAULTS: TakeoverConfig = { onHumanReply: true };

export function readTakeoverConfig(settings: unknown): TakeoverConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).takeover
      : undefined;
  if (!s || typeof s !== "object") return { ...TAKEOVER_DEFAULTS };
  // NOTE: explicit `false` is the only thing that turns it off. A bag with no key must project ON, and
  // so must any other value (a string, a null, a hand-edited number): the safe answer for an unreadable
  // switch keeps the agent off a conversation a person is holding.
  return {
    onHumanReply: (s as Record<string, unknown>).onHumanReply !== false,
  };
}

// The pinned target a transfer on THIS conversation may use, or null when the transfer goes to
// Chatwoot's own routing. The rule `buildToolset` applies to the handoff tool (a pin picked in
// another account names an id that is invalid here), for the transfer the runtime makes on its own,
// which has no model to fall back to `agent_choice` with.
export function pinnedHandoffTarget(
  hc: HandoffConfig,
  instanceId: bigint,
): { kind: "agent" | "team"; id: number } | null {
  if (hc.mode !== "pinned") return null;
  if (hc.targetInstanceId != null && hc.targetInstanceId !== Number(instanceId))
    return null;
  if (hc.targetAgentId) return { kind: "agent", id: hc.targetAgentId };
  if (hc.targetTeamId) return { kind: "team", id: hc.targetTeamId };
  return null;
}
