// Merging a knowledge-document realtime event into the row the documents modal is showing.
//
// The rule that needed a name: an event that CHANGES the status states the row's error completely,
// and an event that repeats the status is a partial patch.
//
// A reason belongs to the state it explains, so a transition that clears it server-side (a retry or
// a re-index putting the row back to PENDING, both of which write `error: null`) has to clear it
// here too. Carrying the previous value forward was almost invisible while a reason only reached a
// tooltip on a FAILED badge; an UNINDEXED row now renders "blocked" off that same field, so a
// document that WAS blocked and has since been re-queued would go on claiming it until the operator
// reloaded (issue #80).
//
// The same-status half is why this is not simply "trust the event". `updateDocument` on a title-only
// edit leaves `error` untouched in the database and broadcasts the unchanged status with no error at
// all — clearing on that event would drop a live failure from every open modal. Every server path
// that clears the column also moves the status (PENDING on retry/re-index/re-ingest, READY on
// success), and every path that sets one sends it (FAILED, and the embedding block), so the two
// halves cover all of them.
//
// `chunkCount` is inherited unconditionally: it is sent only on the event that establishes it
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
  const restated = event.status === row.status;
  return {
    ...row,
    status: event.status,
    chunkCount: event.chunkCount ?? row.chunkCount,
    error: event.error ?? (restated ? row.error : null),
  };
}
