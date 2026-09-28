import { readProtectedLabels } from "@/modules/agents/tool-guidance";

// THE LABELS THE AGENT'S OWN CLOSE WRITES. An instruction to label on close is skipped about half
// of the time, and everything keyed on the label (a CSAT survey rule, a folder) misses those
// conversations. So the operator names the labels here and `resolve_conversation` writes them
// itself, merged into what the conversation carries, right before the status changes. Cleaned like
// the case labels (`crossInboxCase.caseLabels`): titles are lowercase, and a repeat is one label.
export const RESOLVE_LABELS_MAX = 20;

export function normalizeResolveLabels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const l of v) {
    if (typeof l !== "string") continue;
    const label = l.trim().toLowerCase();
    if (label && !out.includes(label)) out.push(label);
    if (out.length === RESOLVE_LABELS_MAX) break;
  }
  return out;
}

function resolveBlock(settings: unknown): Record<string, unknown> | null {
  const block =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).resolveConversation
      : undefined;
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  return block as Record<string, unknown>;
}

export function readResolveLabels(settings: unknown): string[] {
  return normalizeResolveLabels(resolveBlock(settings)?.assignLabels);
}

export function readResolveConversationConfig(settings: unknown): {
  assignLabels: string[];
} {
  return { assignLabels: readResolveLabels(settings) };
}

// The labels a bag both has the close write and fences off from `set_labels`. Asked of the bag a
// write LEAVES: REST stores the bag it is handed, MCP stores the merge, and the editor asks it of the
// bag it is about to send, before the grants go out.
export function protectedResolveLabels(bag: unknown): string[] {
  const fenced = new Set(readProtectedLabels(bag).map((l) => l.toLowerCase()));
  return readResolveLabels(bag).filter((l) => fenced.has(l));
}
