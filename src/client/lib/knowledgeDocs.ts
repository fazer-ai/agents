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

// Localizing a blocked document's reason: the `error` column carries either a stable token the
// server chose (see src/lib/embedding-block.ts) or a raw provider diagnostic, and only the first
// kind has a sentence to show.
//
// Pure, and returning the PARTS rather than a translated string, for two reasons. It is a decision
// (which of the two kinds is this?) and decisions belong out of the render path where a table test
// can reach them; and `t` is a hook binding the component owns, so a function that called it could
// not be tested without mounting anything.
//
// `null` means "not a token": show the string as-is. Inventing a sentence for an unrecognized value
// would bury the diagnostic that is the only clue for an unknown failure.
export interface DocErrorEntry {
  key: string;
  fallback: string;
}

const DOC_ERROR_TEXT: Record<string, DocErrorEntry> = {
  "errors.embeddingNotConfigured": {
    key: "knowledge.docError.embeddingNotConfigured",
    fallback:
      "The embedding credential is not configured for this workspace. Set it under Components, then index again.",
  },
  "errors.embeddingPending": {
    key: "knowledge.docError.embeddingPending",
    fallback:
      "The embedding credential has not been filled in yet. Fill it in, then index again.",
  },
  "errors.embeddingEmpty": {
    key: "knowledge.docError.embeddingEmpty",
    fallback:
      "The embedding credential is empty. Fill it in, then index again.",
  },
};

// The spelling the producer used BEFORE issue #256, one per reason. `KnowledgeDocument.error` is a
// stored column and nothing rewrites it when the producer changes, so every row that failed on an
// older release still carries `errors.embedding.<snake_case>` — and would go on showing the raw token
// in the tooltip until someone re-indexed it. Neither branch matched those rows before this change
// either (that IS the bug), so this is not a regression being papered over: it is the one cheap way
// to make the history readable without a data migration over a column the app can rebuild anyway.
//
// One-way and frozen: the producer emits only the camel-case keys now, so nothing is added here
// again. A row that predates even these spellings still falls through to `null`, which shows the
// stored string, which is the honest answer for a token nobody recognizes.
const LEGACY_DOC_ERROR_ALIAS: Record<string, string> = {
  "errors.embedding.embedding_not_configured": "errors.embeddingNotConfigured",
  "errors.embedding.credential_pending": "errors.embeddingPending",
  "errors.embedding.credential_empty": "errors.embeddingEmpty",
};

export function docErrorEntry(error: string): DocErrorEntry | null {
  const token = LEGACY_DOC_ERROR_ALIAS[error] ?? error;
  return DOC_ERROR_TEXT[token] ?? null;
}
