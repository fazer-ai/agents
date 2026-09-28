import { NATIVE_TOOL_NAMES, type NativeToolName } from "@/graph/tools/catalog";
import { readToolInstructions } from "@/modules/handoff/settings";

const NATIVE_SET = new Set<string>(NATIVE_TOOL_NAMES);

// Operator-authored "when to use this tool" notes at `settings.toolGuidance = { [toolName]: string }`,
// appended to the tool's description (withOperatorNote). handoff_to_human and kanban_move_card keep
// theirs in their own block (`handoff.instructions`, `kanban.instructions`); `prepare` merges both.
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
// The allowed list is bounded by the same number, read by the same function.
export const ALLOWED_LABELS_MAX = PROTECTED_LABELS_MAX;

// Labels `set_labels` may neither add nor remove. The model still SEES them: hiding a guarded label
// makes a fenced agent invent a synonym for it. Per agent, since two agents on one account can
// disagree about which labels are theirs. Empty or absent: the tool reaches every label.
export function readProtectedLabels(settings: unknown): string[] {
  return readLabelList(settings, "protected");
}

// The labels `set_labels` may add, when declared; without a list, a title Chatwoot lacks is created
// there. Empty or absent: no list, so an install that classifies without one keeps classifying.
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
