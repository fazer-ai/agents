// Why a tenant's embedding credential cannot be used, as a token that survives the trip from the
// server to the operator's screen: `resolveEmbeddingConfig` throws, the RAG ingest stores the
// `translationKey` in `KnowledgeDocument.error`, a realtime event carries it, and the documents modal
// renders it, with nothing validating the string on the way. Both ends read this map, and a test
// asserts the console covers it entry for entry, so a new reason fails a test instead of putting a
// raw token on screen.

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
