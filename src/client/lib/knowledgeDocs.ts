// Merging a knowledge-document realtime event into the row the documents modal is showing.
//
// The rule that needed a name: the event is the whole truth about `error`. A reason belongs to the
// STATE it explains, so a transition that clears it server-side (a retry or a re-index putting the
// row back to PENDING, both of which write `error: null`) has to clear it here too. Carrying the
// previous value forward was almost invisible while a reason only reached a tooltip on a FAILED
// badge; an UNINDEXED row now renders "blocked" off that same field, so a document that WAS blocked
// and has since been re-queued would go on claiming it until the operator reloaded (issue #80).
//
// `chunkCount` is the opposite case and stays inherited: it is sent only on the event that sets it
// (READY), and the intermediate states do not mean the row has zero chunks.

export interface DocumentRowState {
  status: string;
  chunkCount: number | null;
  error: string | null;
}

export interface DocumentEventFields {
  status: string;
  chunkCount?: number;
  error?: string;
}

export function mergeDocumentEvent<T extends DocumentRowState>(
  row: T,
  event: DocumentEventFields,
): T {
  return {
    ...row,
    status: event.status,
    chunkCount: event.chunkCount ?? row.chunkCount,
    error: event.error ?? null,
  };
}
