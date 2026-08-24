// Whether an issued document may be handed to anyone, as one pure decision.
//
// It is a VERDICT rather than a boolean predicate, and that is the whole point: the caller needs the
// storage key when the answer is yes, so a predicate leaves every caller re-reading the same field
// afterwards, in a branch nothing can reach. Carrying the key in the `ok` arm removes the branch.
//
// NOTE: the row's `status` is deliberately NOT consulted. It reads like a third clause and is not
// one: the CAS that flips a row to READY writes the storage key in the same statement, so the two
// always agree and `status !== "READY"` decides nothing `!pdfStorageKey` has not already decided.
// Measured — mutating that clause away broke no test, which is what a clause that does nothing looks
// like. Two questions, two clauses.

export type DocumentBlock = "not_rendered" | "revoked";

export interface DocumentDeliverability {
  pdfStorageKey: string | null;
  revoked: boolean;
}

export type DocumentVerdict =
  | { ok: true; pdfStorageKey: string }
  | { ok: false; block: DocumentBlock };

// Order matters: revoked wins over not-yet-rendered, because a document the team pulled back is a
// decision and "still rendering" is a state — reporting the state would tell the caller to try
// again, which is exactly the wrong instruction.
export function documentVerdict(doc: DocumentDeliverability): DocumentVerdict {
  if (doc.revoked) return { ok: false, block: "revoked" };
  if (!doc.pdfStorageKey) return { ok: false, block: "not_rendered" };
  return { ok: true, pdfStorageKey: doc.pdfStorageKey };
}
