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

// A name in the list above is RESERVED: the assembly drops any other tool that claims it, granted or
// not (unique-names.ts, #457); the HTTP tool writers refuse it (tool-definitions/service.ts, which
// REST, the console and MCP all reach); an import renames a bundled tool that carries it. None of
// those reaches a row a tenant wrote BEFORE the name was native, which would sit in the console and
// never reach the model — so a name added here ships with a migration named
// `*_rename_http_tools_named_after_natives` that moves such rows to the first free `<name>_N`, the
// way the import does. tests/prisma/native-tool-names-renamed-by-migration.test.ts asks for it.
export function isNativeToolName(name: string): name is NativeToolName {
  return (NATIVE_TOOL_NAMES as readonly string[]).includes(name);
}

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

// WHAT A SUCCESSFUL `handoff_to_human` LEAVES IN THE THREAD, named here because two places compare
// against it and a second spelling is how a comparison goes quietly false (issue #457).
//
// The tool's model-facing return is the only trace in the channel that separates a transfer that
// HAPPENED from one that did not: the AI message carrying the call is checkpointed before the tool
// runs, so it is written just as much when `toggleStatus` throws and when an operator's precondition
// refuses the call — and both of those leave the conversation bot-owned, with nothing to announce
// the end of. The hand-back decision (../handback.ts) matches this prefix on the TOOL RESULT.
export const HANDOFF_DONE_PREFIX = "Handed off to a human";

// The tool that produces it, named here for the same reason. A result is only that tool's result if
// the tool node says so, and the NAME is the identity for a native: `handoff_to_human` is not
// renameable and not namespaced, and the assembly RESERVES every native name — including the ones
// this agent's allowlist left unbuilt (../tools/unique-names.ts), which is the half ordering alone
// could not defend. See ../../modules/agents/tool-preconditions.ts, which restricts preconditions to
// this same set on exactly that argument. Without the name, any enabled external tool that happened
// to return text opening with the prefix above would announce a hand-back that never happened.
export const HANDOFF_TOOL_NAME = "handoff_to_human";
