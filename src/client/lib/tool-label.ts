// The phrase the operator's timeline puts on a tool call, as a rule anything can call (and a test
// can reach without rendering ConversationDetailPage). It answers with a KEY and the English default,
// not translated text, because translating is `t()`'s job and the i18n extractor reads static calls;
// the keys are declared by the magic comments below. Two surfaces read it, the persistent trail
// marker and the transient live indicator, and one rule for both is the point: a fix on the timeline
// alone would leave the bubble saying the agent ignored a customer it had just answered.

export interface ToolLabel {
  key: string;
  fallback: string;
}

// What the TURN did, as far as the caller knows. `delivered` absent or null means the question was
// not answered (an older row, a path with no turn to ask), and unknown must read as the plain label:
// inventing either answer is how a true sentence gets replaced by a false one in the other direction.
export interface TurnFacts {
  delivered?: boolean | null;
}

// t('conversation.activity.handoff', 'Transferring to a human')
// t('conversation.activity.note', 'Writing an internal note')
// t('conversation.activity.attr', 'Updating details')
// t('conversation.activity.resolve', 'Wrapping up the conversation')
// t('conversation.activity.openCase', 'Opening the case in another inbox')
// t('conversation.activity.react', 'Reacting to a message')
// t('conversation.activity.skip', 'Decided not to respond')
// t('conversation.activity.skipAfterDelivery', 'Nothing further to add')
// t('conversation.activity.search', 'Searching the knowledge base')
// t('conversation.activity.suggest', 'Preparing a knowledge suggestion')
// A Map and not an object literal, because the key comes from the OPERATOR: a custom HTTP tool or
// an MCP server may be named `constructor` or `toString`, and an object literal answers those with
// the inherited member, which is truthy. The label would come out as `t(undefined, undefined)`, an
// empty phrase, not even the humanized name an unknown tool gets.
const BY_TOOL = new Map<string, ToolLabel>(
  Object.entries({
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
    open_case_in_inbox: {
      key: "conversation.activity.openCase",
      fallback: "Opening the case in another inbox",
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
  }),
);

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
  return (tool && BY_TOOL.get(tool)) || null;
}
