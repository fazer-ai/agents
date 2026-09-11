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

// A guarded label is never CAPPED, only bounded in count: an operator label is a Chatwoot label, and
// Chatwoot is the authority on how long one may be. What this reader throws away is what the tool
// could not match anyway — a non-string, a blank, a duplicate — because a guard entry that never
// equals a real label is a guard that silently protects nothing.
export const PROTECTED_LABELS_MAX = 50;

// LABELS `set_labels` MAY NEITHER ADD NOR REMOVE, and never sees (issue #568 review).
//
// The tool takes the complete list a scope should end up with, so a label standing on the
// conversation before the turn is shown to the model and survives only if the model repeats it.
// That is the contract working as designed, and it is fine for a classification. It is not fine for
// a label that belongs to somebody else: `agente-off` is what keeps an agent off a conversation and
// a testing label is what keeps a rehearsal out of the metrics, both written and read back by
// something that is not this agent. Measured, not assumed: with `["compra-de-ingresso"]` asked for,
// the tool answered `removed "cancelamento", "agente-off", "vip"`.
//
// Per agent rather than per instance because the console's tool panel is where an operator
// configures this tool, and because two agents on one account can disagree about which labels are
// theirs. Empty or absent ⇒ the tool reaches everything, which is the behaviour before this list.
export function readProtectedLabels(settings: unknown): string[] {
  const block =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).setLabels
      : undefined;
  if (!block || typeof block !== "object" || Array.isArray(block)) return [];
  const raw = (block as Record<string, unknown>).protected;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const label = entry.trim();
    if (!label || out.includes(label)) continue;
    out.push(label);
    if (out.length === PROTECTED_LABELS_MAX) break;
  }
  return out;
}
