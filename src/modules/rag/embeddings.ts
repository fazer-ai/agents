import { OpenAIEmbeddings } from "@langchain/openai";
import { throughProvider } from "@/lib/provider-failure";

// Embedding wrapper. OpenAI-compatible by default (text-embedding-3-small → 1536 dims, matching
// the knowledge_chunks vector(1536) column). The API key is resolved from the vault by the
// caller (never inlined/logged). Embedding is network I/O and MUST run outside any transaction.

// The vector column width. A model producing a different dimensionality needs a schema migration;
// we guard at insert time rather than silently corrupting the index.
export const EMBEDDING_DIM = 1536;

export interface EmbeddingConfig {
  model: string;
  apiKey: string;
  baseURL?: string;
}

function client(cfg: EmbeddingConfig): OpenAIEmbeddings {
  return new OpenAIEmbeddings({
    model: cfg.model,
    apiKey: cfg.apiKey,
    ...(cfg.baseURL ? { configuration: { baseURL: cfg.baseURL } } : {}),
  });
}

export async function embedTexts(
  texts: string[],
  cfg: EmbeddingConfig,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  return throughProvider(() => client(cfg).embedDocuments(texts));
}

export async function embedQuery(
  text: string,
  cfg: EmbeddingConfig,
): Promise<number[]> {
  return throughProvider(() => client(cfg).embedQuery(text));
}
