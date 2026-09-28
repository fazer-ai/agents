// WHAT THE MODEL MAY SEE of a scope's labels. Dependency-free on purpose, like catalog.ts: the tool
// builder, the turn's preparation seam and the observer's prompt all need the same answer, and
// prepare.ts deliberately does not import the tool builders.

// THE CEILING, per scope. Every other model-facing list is capped, and a conversation's own set is
// the one an automation can grow unseen: uncapped, it lands in the observer's prompt and twice in
// the tool's description, and a bulk-labelled conversation pushes every retry past the context
// limit. A cap and not a refusal: a label the call does not name is not touched, so the cut is a
// display decision with no reach into the write, and what falls off the end keeps standing.
export const SHOWN_LABELS_MAX = 40;

// THE CEILING, and nothing else: a protected label is SHOWN (the guard runs on the write), which
// stops an agent inventing a name for a canonical value it never saw. One function because the
// tool's description, what the tool records as shown and the observer's `<etiquetas-atuais>` block
// must agree.
export function modelVisibleLabels(labels: string[]): string[] {
  return labels.slice(0, SHOWN_LABELS_MAX);
}
