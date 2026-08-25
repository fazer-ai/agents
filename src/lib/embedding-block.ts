// Why a tenant's embedding credential cannot be used, as a token that survives the trip from the
// server to the operator's screen.
//
// The trip is what makes this a module rather than two string literals. `resolveEmbeddingConfig`
// throws, the RAG ingest catch stores the thrown `translationKey` in `KnowledgeDocument.error`
// (rather than the message, so the console can localize it), a realtime event carries the same
// column value, and the documents modal renders it in a tooltip. Four hops, two of them across the
// server/client line, and nothing in between validates the string.
//
// So both ends read the SAME map, and the test asserts the console covers it entry for entry: a
// reason added here with no branch on the other side fails a test instead of putting a raw token on
// screen, which is exactly what the two spellings did before (issue #256).

import type { ErrorTranslationKey } from "@/lib/errors";

export type EmbeddingBlockReason =
  | "embedding_not_configured"
  | "credential_pending"
  | "credential_empty";

// Typed as the catalog's keys, so a token here is by construction a key the API can translate for a
// REST caller: the same value is both the wire token the console matches and the i18n key `onError`
// resolves.
export const EMBEDDING_BLOCK_KEY: Record<
  EmbeddingBlockReason,
  ErrorTranslationKey
> = {
  embedding_not_configured: "errors.embeddingNotConfigured",
  credential_pending: "errors.embeddingPending",
  credential_empty: "errors.embeddingEmpty",
};
