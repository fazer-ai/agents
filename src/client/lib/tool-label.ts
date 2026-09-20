// The phrase the operator's timeline puts on a tool call, as a rule anything can call.
//
// It used to be a `switch` inside a hook inside ConversationDetailPage, which made it unreachable:
// rendering that page pulls auth, theme, toast, realtime and a live conversation, so the only thing
// that could be asserted about the labels was their source text. That was survivable while the rule
// was "one name, one phrase" and stopped being so the moment a phrase started depending on a second
// fact (issue #726).
//
// It answers with a KEY and the English default rather than translated text, because translating is
// `t()`'s job and the i18n extractor reads static calls. The keys are therefore declared to the
// extractor by the magic comments below, the same way every other dynamic key in the console is.
//
// Two surfaces read it: the persistent trail marker, and the transient live indicator. One rule for
// both is the point — a fix applied to the timeline alone leaves the bubble saying the agent ignored
// a customer it had just answered, which is the surface where nobody can check afterwards.

export interface ToolLabel {
  key: string;
  fallback: string;
}

// What the TURN did, as far as the caller knows. `delivered` absent or null means the question was
// not answered (a row written before this shipped, a path with no turn to ask), and unknown must
// read as the plain label: inventing either answer is how a true sentence gets replaced by a false
// one in the other direction.
export interface TurnFacts {
  delivered?: boolean | null;
}

// t('conversation.activity.handoff', 'Transferring to a human')
// t('conversation.activity.note', 'Writing an internal note')
// t('conversation.activity.attr', 'Updating details')
// t('conversation.activity.resolve', 'Wrapping up the conversation')
// t('conversation.activity.react', 'Reacting to a message')
// t('conversation.activity.skip', 'Decided not to respond')
// t('conversation.activity.skipAfterDelivery', 'Nothing further to add')
// t('conversation.activity.search', 'Searching the knowledge base')
// t('conversation.activity.suggest', 'Preparing a knowledge suggestion')
const BY_TOOL: Record<string, ToolLabel> = {
  handoff_to_human: {
    key: "conversation.activity.handoff",
    fallback: "Transferring to a human",
  },
  private_note: {
    key: "conversation.activity.note",
    fallback: "Writing an internal note",
  },
  set_custom_attribute: {
    key: "conversation.activity.attr",
    fallback: "Updating details",
  },
  resolve_conversation: {
    key: "conversation.activity.resolve",
    fallback: "Wrapping up the conversation",
  },
  react_to_message: {
    key: "conversation.activity.react",
    fallback: "Reacting to a message",
  },
  skip_reply: {
    key: "conversation.activity.skip",
    fallback: "Decided not to respond",
  },
  search_knowledge: {
    key: "conversation.activity.search",
    fallback: "Searching the knowledge base",
  },
  suggest_kb_entry: {
    key: "conversation.activity.suggest",
    fallback: "Preparing a knowledge suggestion",
  },
};

// The decision to stay quiet, said about a turn that had already spoken. The plain phrase asserts a
// silence, and on that turn the reply is on the screen one line above it — which is the reading that
// gets escalated as "the bot ignored the customer". This one keeps the row (the call really was
// made, and the operator investigating "why did it go quiet after transferring" needs to tell a
// chosen silence from a turn that died halfway) and stops it denying the reply.
const SKIP_AFTER_DELIVERY: ToolLabel = {
  key: "conversation.activity.skipAfterDelivery",
  fallback: "Nothing further to add",
};

// The translated-label key for a known native tool; null for an unknown or absent name, which is the
// caller's cue to fall back to a humanized name or a generic phrase.
export function toolLabel(
  tool: string | null,
  turn?: TurnFacts,
): ToolLabel | null {
  if (tool === "skip_reply" && turn?.delivered === true) {
    return SKIP_AFTER_DELIVERY;
  }
  return (tool && BY_TOOL[tool]) || null;
}
