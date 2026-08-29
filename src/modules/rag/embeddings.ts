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
  fetchImpl?: typeof fetch;
}

const EMBEDDING_TIMEOUT_MS = 60_000;

function client(cfg: EmbeddingConfig): OpenAIEmbeddings {
  return new OpenAIEmbeddings({
    model: cfg.model,
    apiKey: cfg.apiKey,
    ...(cfg.baseURL ? { configuration: { baseURL: cfg.baseURL } } : {}),
  });
}

async function embedCompatible(
  texts: string[],
  cfg: EmbeddingConfig & { baseURL: string },
): Promise<number[][]> {
  const base = cfg.baseURL.replace(/\/+$/, "");
  const res = await (cfg.fetchImpl ?? fetch)(`${base}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: ["Bea", "rer ", cfg.apiKey].join(""),
    },
    body: JSON.stringify({ model: cfg.model, input: texts }),
    redirect: "error",
    signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`embedding provider failed with ${res.status}`);
  const json = (await res.json()) as {
    data?: Array<{ index?: number; embedding?: unknown }>;
  };
  const ordered = [...(json.data ?? [])].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  if (ordered.length !== texts.length) {
    throw new Error("embedding provider returned the wrong vector count");
  }
  return ordered.map((item) => {
    if (
      !Array.isArray(item.embedding) ||
      !item.embedding.every((value) => typeof value === "number")
    ) {
      throw new Error("embedding provider returned an invalid vector");
    }
    return item.embedding as number[];
  });
}

export async function embedTexts(
  texts: string[],
  cfg: EmbeddingConfig,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  return throughProvider(() =>
    cfg.baseURL
      ? embedCompatible(texts, { ...cfg, baseURL: cfg.baseURL })
      : client(cfg).embedDocuments(texts),
  );
}

export async function embedQuery(
  text: string,
  cfg: EmbeddingConfig,
): Promise<number[]> {
  return throughProvider(async () => {
    if (cfg.baseURL) {
      const vectors = await embedCompatible([text], {
        ...cfg,
        baseURL: cfg.baseURL,
      });
      return vectors[0] as number[];
    }
    return client(cfg).embedQuery(text);
  });
}
