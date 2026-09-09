import { NATIVE_TOOL_NAMES, type NativeToolName } from "@/graph/tools/catalog";
import { readToolInstructions } from "@/modules/handoff/settings";

const NATIVE_SET = new Set<string>(NATIVE_TOOL_NAMES);

// Operator-authored "when to use this tool" guidance, keyed by native tool name, for tools whose ONLY
// per-agent config is that note (set_custom_attribute, set_labels, …). It is appended to the tool's
// model-facing description via withOperatorNote (see ToolCtx.toolInstructions) so the transfer/funnel/
// attribute logic lives WITH the tool instead of being buried in the system prompt.
//
// Stored flat at `settings.toolGuidance = { [toolName]: string }`. handoff_to_human / kanban_move_card
// keep their guidance in their own grouped config (settings.handoff.instructions /
// settings.kanban.instructions) because those tools carry other config too; `prepare` folds both
// sources into one toolInstructions map. Unknown keys and blank values are dropped; each note is
// trimmed and length-capped (readToolInstructions).
export function readToolGuidance(
  settings: unknown,
): Partial<Record<NativeToolName, string>> {
  const bag =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).toolGuidance
      : undefined;
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return {};
  const out: Partial<Record<NativeToolName, string>> = {};
  for (const [key, value] of Object.entries(bag as Record<string, unknown>)) {
    if (!NATIVE_SET.has(key)) continue;
    const note = readToolInstructions(value);
    if (note) out[key as NativeToolName] = note;
  }
  return out;
}
