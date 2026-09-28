// Static tool-name catalogs for the built-in sources, kept dependency-free so the config/HTTP
// layer (agent service, controllers) can validate tool-selection allowlists WITHOUT importing the
// tool builders, which pull in LangChain + the RAG/Chatwoot stacks. native.ts / rag.ts re-export
// these so existing importers keep their path.

export const NATIVE_TOOL_NAMES = [
  "handoff_to_human",
  "private_note",
  "set_custom_attribute",
  "set_labels",
  "resolve_conversation",
  "kanban_move_card",
  "update_kanban_task",
  "set_voice_preference",
  "react_to_message",
  "send_image",
  "open_case_in_inbox",
  "skip_reply",
  "calculator",
  "get_current_time",
] as const;
export type NativeToolName = (typeof NATIVE_TOOL_NAMES)[number];

// Natives that were renamed, old name to new one. A migration repairs existing rows, but nothing
// repairs a bundle exported earlier: read as an unknown native, the old name would be dropped and the
// capability lost from the restored agent. A removed name (`run_code`) is not listed, since dropping
// it is correct. Only the IMPORT boundary consults this; the API refuses the old name.
export const RENAMED_NATIVE_TOOLS: Readonly<Record<string, NativeToolName>> =
  Object.freeze({
    assign_label: "set_labels",
  });

// The new name for a legacy one, or the name itself when it was never renamed.
export function currentNativeToolName(name: string): string {
  return Object.hasOwn(RENAMED_NATIVE_TOOLS, name)
    ? (RENAMED_NATIVE_TOOLS[name] as string)
    : name;
}

// A name in the list above is RESERVED: the assembly drops any other tool that claims it
// (unique-names.ts), the HTTP tool writers refuse it, and an import renames a bundled tool that
// carries it. None of those reaches a row written BEFORE the name was native, so a name added here
// ships with a `*_rename_http_tools_named_after_natives` migration moving such rows to the first free
// `<name>_N` (enforced by tests/prisma/native-tool-names-renamed-by-migration.test.ts).
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
    set_labels: "conversation",
    resolve_conversation: "conversation",
    kanban_move_card: "conversation",
    update_kanban_task: "conversation",
    set_voice_preference: "conversation",
    react_to_message: "conversation",
    send_image: "conversation",
    open_case_in_inbox: "conversation",
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

// Native tools whose whole point is to put something in front of the customer. A muted (observer)
// turn is not offered them: each would cost a model round and fail in a way an operator reads as a
// broken integration. Listed in the catalog so the runtime that strips them (buildNativeTools) and
// the editor that must not offer them read one list instead of two that can drift.
export const CUSTOMER_DELIVERY_NATIVE_TOOL_NAMES: readonly NativeToolName[] = [
  "react_to_message",
  "send_image",
  // NOTE: its opening message reaches the customer in the destination inbox.
  "open_case_in_inbox",
];

// The tool that opens the customer's case in another inbox.
export const OPEN_CASE_TOOL_NAME = "open_case_in_inbox";
// The sentence that tool's result carries when it handed the conversation to people instead (its
// failure fallback, or the output check's policy), read by the hand-back rule (graph/handback.ts)
// the way `HANDOFF_DONE_PREFIX` is read off `handoff_to_human`.
export const OPEN_CASE_HANDED_MARK =
  "This conversation was handed to the human team";

export const RAG_TOOL_NAMES = ["search_knowledge", "suggest_kb_entry"] as const;
export type RagToolName = (typeof RAG_TOOL_NAMES)[number];

// The immediate close's own result, shared so a reader asking "did this turn close the
// conversation" matches the same literal the tool writes.
export const RESOLVE_DONE = "Conversation resolved.";

// What a successful `handoff_to_human` leaves in the thread, named once because two places compare
// against it. The AI message carrying the call is checkpointed before the tool runs, so only this
// TOOL RESULT separates a transfer that happened from one that threw or was refused by a
// precondition. The hand-back decision (../handback.ts) matches this prefix.
export const HANDOFF_DONE_PREFIX = "Handed off to a human";

// The tool that produces it. A result is only that tool's result if the tool node says so, and the
// NAME is a native's identity: not renameable, not namespaced, and reserved by the assembly even when
// unbuilt (../tools/unique-names.ts). Without the name, any external tool returning text that opens
// with the prefix above would announce a hand-back that never happened.
export const HANDOFF_TOOL_NAME = "handoff_to_human";
