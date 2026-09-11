// WHAT THE MODEL MAY SEE of a scope's labels. Dependency-free on purpose, like catalog.ts: the tool
// builder, the turn's preparation seam and the observer's prompt all need the same answer, and
// prepare.ts deliberately does not import the tool builders.

// THE CEILING, per scope. Every other model-facing list is capped — the account's vocabulary at 40,
// the handoff targets at 25, the attribute definitions at 30 — and a conversation's own set was not,
// although it is the one list an automation can grow without an operator ever looking at it.
// Uncapped it goes into the observer's prompt AND twice into the tool's description (the block and
// the argument), so a conversation somebody bulk-labelled can push a whole observation past the
// provider's context limit, and every retry of that tick fails the same way.
//
// A CAP AND NOT A REFUSAL, because it is safe by construction: a label the model was not shown is
// unseen, and unseen never becomes a removal (see applyLabelIntent). What falls off the end keeps
// standing exactly as it is.
export const SHOWN_LABELS_MAX = 40;

// The guarded labels subtracted, then the ceiling. ONE function because three places have to agree
// on the answer — the tool's description, the diff baseline it is compared against, and the
// observer's `<etiquetas-atuais>` block. Two of them computing "the same" list separately is how
// they end up describing different turns.
export function modelVisibleLabels(
  labels: string[],
  guarded?: string[],
): string[] {
  const guard = new Set(guarded ?? []);
  return labels.filter((l) => !guard.has(l)).slice(0, SHOWN_LABELS_MAX);
}
