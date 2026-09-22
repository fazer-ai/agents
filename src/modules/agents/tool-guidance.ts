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
// The allowed list (issue #638) is bounded by the same number, read by the same function.
export const ALLOWED_LABELS_MAX = PROTECTED_LABELS_MAX;

// LABELS `set_labels` MAY NEITHER ADD NOR REMOVE (issue #568 review; issue #695 dropped the third
// property, "and never sees").
//
// The tool names a DELTA: `add` and `remove`, with a label nobody names left as it is. So the guard
// is no longer what keeps another system's label alive — not naming it is — and what the guard
// still does is refuse the two verbs, in both directions, because a tenant relies on the add half
// to keep one agent's taxonomy out of another agent's reach.
//
// It stopped HIDING, and that is the point of #695. Under the replace contract a guarded label had
// to be withdrawn from the model's sight, because being shown one was the first half of being able
// to delete it by omission; under the delta, seeing it costs nothing and not seeing it costs a
// fenced agent inventing a synonym for the canonical value (measured 2026-09-11: `duvidas-evento`,
// outside the catalogue, written by an agent whose fence hid `dúvidas-evento` from it).
//
// Per agent rather than per instance because the console's tool panel is where an operator
// configures this tool, and because two agents on one account can disagree about which labels are
// theirs. Empty or absent ⇒ the tool reaches everything, which is the behaviour before this list.
export function readProtectedLabels(settings: unknown): string[] {
  return readLabelList(settings, "protected");
}

// THE LABELS `set_labels` MAY ADD, when the operator declared them (issue #638). The other half of
// the same block: `protected` is what the tool may not touch, this is what it may use. Without it
// the model's array is the taxonomy, a title Chatwoot does not have is CREATED there, and nothing
// can name a label in a log because nothing tells an operator's title from an invented one. Same
// ceiling and the same reader as `protected`, so the two lists are bounded and cleaned alike.
// Empty or absent ⇒ no list, which is the behaviour before it existed: an install that classifies
// without one must not stop classifying on upgrade.
export function readAllowedLabels(settings: unknown): string[] {
  return readLabelList(settings, "allowed");
}

// What a title outside `allowed` meets. `refuse` (the default) does not write it and names it back
// to the model; `accept` writes it as before and only counts it on the trail. Anything else reads
// as the default, the strict side, because an unknown value is a typo and the list exists to fence.
export type OutsideAllowedLabels = "refuse" | "accept";
export function readOutsideAllowedLabels(
  settings: unknown,
): OutsideAllowedLabels {
  const block = setLabelsBlock(settings);
  return block?.outsideAllowed === "accept" ? "accept" : "refuse";
}

function setLabelsBlock(settings: unknown): Record<string, unknown> | null {
  const block =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).setLabels
      : undefined;
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  return block as Record<string, unknown>;
}

function readLabelList(
  settings: unknown,
  key: "protected" | "allowed",
): string[] {
  const raw = setLabelsBlock(settings)?.[key];
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
