// Merging a knowledge-document realtime event into the row the documents modal shows. An event that
// CHANGES the status states the row's error completely: a reason belongs to the state it explains,
// and a retry or re-index back to PENDING writes `error: null`, so a re-queued UNINDEXED row must
// stop rendering "blocked". An event that repeats the status is a partial patch: a title-only
// `updateDocument` broadcasts the unchanged status with no error, and clearing on it would drop a
// live failure. Every server path that clears the column moves the status, and every path that sets
// one sends it. `chunkCount` is inherited: only READY sends it, and other states do not mean zero.

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
// server chose (src/lib/embedding-block.ts) or a raw provider diagnostic, and only a token has a
// sentence. Pure and returning the PARTS, not a translated string, so the decision is reachable by
// a table test and `t` (the component's hook binding) stays out. `null` means "not a token": show
// the string as-is, since an invented sentence would bury the only clue for an unknown failure.
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

// The older spelling of each reason. `KnowledgeDocument.error` is a stored column nothing rewrites,
// so rows that failed on an older release still carry `errors.embedding.<snake_case>`; mapping them
// here makes that history readable without a data migration over a column the app can rebuild.
// Frozen: the producer emits only the camel-case keys. A row predating even these falls through to
// `null`, which shows the stored string, the honest answer for a token nobody recognizes.
const LEGACY_DOC_ERROR_ALIAS: Record<string, string> = {
  "errors.embedding.embedding_not_configured": "errors.embeddingNotConfigured",
  "errors.embedding.credential_pending": "errors.embeddingPending",
  "errors.embedding.credential_empty": "errors.embeddingEmpty",
};

export function docErrorEntry(error: string): DocErrorEntry | null {
  const token = LEGACY_DOC_ERROR_ALIAS[error] ?? error;
  return DOC_ERROR_TEXT[token] ?? null;
}
