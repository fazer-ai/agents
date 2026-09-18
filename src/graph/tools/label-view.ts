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
// A CAP AND NOT A REFUSAL, because it is safe by construction, and #695 made the reason simpler
// rather than changing the answer. It used to rest on the diff: a label past the cut was not shown,
// so it could not be "shown and left out", so it survived. It now rests on the contract itself — a
// label the call does not name is not touched — so the cut is a display decision with no reach into
// the write at all. What falls off the end keeps standing exactly as it is.
export const SHOWN_LABELS_MAX = 40;

// THE CEILING, and nothing else. This used to subtract `settings.setLabels.protected` as well,
// because under the replace contract showing a label was the first half of making it deletable by
// omission — so "protected" and "hidden" could not be separated. Under the delta contract they are
// separate: the guard is enforced on the way in, and a protected label is SHOWN, which is what
// stops an agent inventing a name for a canonical value it was never allowed to see (issue #695).
//
// ONE function because three places have to agree on the answer: the tool's description, what the
// tool records as shown, and the observer's `<etiquetas-atuais>` block.
export function modelVisibleLabels(labels: string[]): string[] {
  return labels.slice(0, SHOWN_LABELS_MAX);
}
