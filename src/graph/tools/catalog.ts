// Static tool-name catalogs for the built-in sources, kept dependency-free so the config/HTTP
// layer (agent service, controllers) can validate tool-selection allowlists WITHOUT importing the
// tool builders, which pull in LangChain + the RAG/Chatwoot stacks. native.ts / rag.ts re-export
// these so existing importers keep their path.

export const NATIVE_TOOL_NAMES = [
  "handoff_to_human",
  "private_note",
  "set_custom_attribute",
  "assign_label",
  "resolve_conversation",
  "kanban_move_card",
  "update_kanban_task",
  "set_voice_preference",
  "react_to_message",
  "send_image",
  "skip_reply",
  "calculator",
  "get_current_time",
] as const;
export type NativeToolName = (typeof NATIVE_TOOL_NAMES)[number];

// Native tools split into two families: `conversation` tools act on the current Chatwoot
// conversation (handoff/note/resolve/…) and need a live client + conversation id; `utility` tools
// are context-free (calculator, clock) and therefore safe to expose in the playground too.
export type NativeToolCategory = "conversation" | "utility";

export const NATIVE_TOOL_CATEGORY: Record<NativeToolName, NativeToolCategory> =
  {
    handoff_to_human: "conversation",
    private_note: "conversation",
    set_custom_attribute: "conversation",
    assign_label: "conversation",
    resolve_conversation: "conversation",
    kanban_move_card: "conversation",
    update_kanban_task: "conversation",
    set_voice_preference: "conversation",
    react_to_message: "conversation",
    send_image: "conversation",
    skip_reply: "conversation",
    calculator: "utility",
    get_current_time: "utility",
  };

export const UTILITY_NATIVE_TOOL_NAMES = NATIVE_TOOL_NAMES.filter(
  (n) => NATIVE_TOOL_CATEGORY[n] === "utility",
);

// Conversation-scoped native tools. The playground exposes these but SIMULATES them (no real
// Chatwoot call / fleet event), so the agent's decision to call them is testable.
export const CONVERSATION_NATIVE_TOOL_NAMES = NATIVE_TOOL_NAMES.filter(
  (n) => NATIVE_TOOL_CATEGORY[n] === "conversation",
);

export const RAG_TOOL_NAMES = ["search_knowledge", "suggest_kb_entry"] as const;
export type RagToolName = (typeof RAG_TOOL_NAMES)[number];
