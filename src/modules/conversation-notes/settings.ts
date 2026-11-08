// Per-agent notes the engine writes into the Chatwoot conversation for the team, read from
// `agent.settings.conversationNotes`. Off by default: a note per turn is noise for a team that never
// asked for it, and only explicit `true` turns one on.
export interface ConversationNotesConfig {
  // One private note per turn that called a tool, naming the tools and nothing they were given or
  // returned (docs/chatwoot.md, "Notes the engine writes about a turn").
  toolsUsed: boolean;
}

export const CONVERSATION_NOTES_DEFAULTS: ConversationNotesConfig = {
  toolsUsed: false,
};

export function readConversationNotesConfig(
  settings: unknown,
): ConversationNotesConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).conversationNotes
      : undefined;
  if (!s || typeof s !== "object") return { ...CONVERSATION_NOTES_DEFAULTS };
  return { toolsUsed: (s as Record<string, unknown>).toolsUsed === true };
}
