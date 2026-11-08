// Per-agent messages the engine writes into the Chatwoot conversation for the team, read from
// `agent.settings.conversationNotes`. Every kind takes the same format, off by default: a message per
// turn is noise for a team that never asked for it.

// Where a kind is told: nowhere, a Chatwoot activity row (discreet, in the timeline's own gray, and
// notifies nobody), or a private note (stands out to whoever handles the conversation).
export const CONVERSATION_NOTE_FORMATS = ["off", "activity", "note"] as const;
export type ConversationNoteFormat = (typeof CONVERSATION_NOTE_FORMATS)[number];

export interface ConversationNotesConfig {
  // One message per turn that called a tool, naming the tools and nothing they were given or
  // returned (docs/chatwoot.md, "Notes the engine writes about a turn").
  toolsUsed: ConversationNoteFormat;
  // One message per turn that hit an error and still ended: a tool that failed, a reply only the
  // fallback model wrote, a guardrail that held the reply.
  errors: ConversationNoteFormat;
}

export const CONVERSATION_NOTES_DEFAULTS: ConversationNotesConfig = {
  toolsUsed: "off",
  errors: "off",
};

function formatOf(v: unknown): ConversationNoteFormat {
  return (CONVERSATION_NOTE_FORMATS as readonly unknown[]).includes(v)
    ? (v as ConversationNoteFormat)
    : "off";
}

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
    // NOTE: A `toolsUsed` stored before it took a format was a switch that posted a private note.
    toolsUsed: o.toolsUsed === true ? "note" : formatOf(o.toolsUsed),
    errors: formatOf(o.errors),
  };
}
