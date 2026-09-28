// Whether an issued document may be handed to anyone, as one pure VERDICT that carries the storage
// key in its `ok` arm. `status` is deliberately NOT consulted: the CAS that flips a row to READY
// writes the storage key in the same statement, so `!pdfStorageKey` already decides it.

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
