// Per-agent notes the engine writes into the Chatwoot conversation for the team, read from
// `agent.settings.conversationNotes`. Off by default: a note per turn is noise for a team that never
// asked for it, and only explicit `true` turns one on.
// Where a turn's mid-turn errors are told: nowhere, a Chatwoot activity row (discreet, in the
// timeline's own gray), or a private note (stands out to whoever handles the conversation).
export const TURN_ERRORS_FORMATS = ["off", "activity", "note"] as const;
export type TurnErrorsFormat = (typeof TURN_ERRORS_FORMATS)[number];

export interface ConversationNotesConfig {
  // One private note per turn that called a tool, naming the tools and nothing they were given or
  // returned (docs/chatwoot.md, "Notes the engine writes about a turn").
  toolsUsed: boolean;
  // One message per turn that hit an error and still ended: a tool that failed, a reply only the
  // fallback model wrote, a guardrail that held the reply.
  errors: TurnErrorsFormat;
}

export const CONVERSATION_NOTES_DEFAULTS: ConversationNotesConfig = {
  toolsUsed: false,
  errors: "off",
};

export function readConversationNotesConfig(
  settings: unknown,
): ConversationNotesConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).conversationNotes
      : undefined;
  if (!s || typeof s !== "object") return { ...CONVERSATION_NOTES_DEFAULTS };
  const o = s as Record<string, unknown>;
  return {
    toolsUsed: o.toolsUsed === true,
    errors: (TURN_ERRORS_FORMATS as readonly unknown[]).includes(o.errors)
      ? (o.errors as TurnErrorsFormat)
      : "off",
  };
}
