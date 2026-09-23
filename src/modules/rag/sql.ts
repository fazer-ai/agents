import { Prisma } from "@/../generated/prisma/client";
import type { ScopedDb } from "@/lib/tenancy";
import { FOOTER_TAIL_CHARS } from "./contact-footer";
import { EMBEDDING_DIM } from "./embeddings";

// Raw pgvector access (Prisma cannot model vector(N) or the HNSW operator). All calls run INSIDE a
// runScoped tx so the app.tenant_id GUC is set and RLS scopes every row to the tenant; tenant_id
// is also passed explicitly so the RLS WITH CHECK passes on insert. No network here.

// pgvector text literal: "[f1,f2,...]". Reject NaN/Infinity and a wrong dimensionality (the column
// is fixed-width) so a misconfigured embedding fails loud instead of corrupting the index.
export function toVectorLiteral(vec: number[]): string {
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `embedding dimension ${vec.length} != ${EMBEDDING_DIM} (column width)`,
    );
  }
  for (const n of vec) {
    if (!Number.isFinite(n))
      throw new Error("embedding contains non-finite value");
  }
  return `[${vec.join(",")}]`;
}

export interface InsertChunkInput {
  tenantId: bigint;
  knowledgeBaseId: bigint;
  documentId: bigint;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export async function insertChunks(
  db: ScopedDb,
  chunks: InsertChunkInput[],
): Promise<number> {
  let n = 0;
  for (const c of chunks) {
    const vec = toVectorLiteral(c.embedding);
    await db.$executeRaw`
      INSERT INTO knowledge_chunks (tenant_id, knowledge_base_id, document_id, content, embedding, metadata, created_at)
      VALUES (${c.tenantId}, ${c.knowledgeBaseId}, ${c.documentId}, ${c.content}, ${vec}::vector, ${JSON.stringify(c.metadata ?? {})}::jsonb, now())`;
    n++;
  }
  return n;
}

export interface SearchChunksParams {
  knowledgeBaseIds: bigint[];
  queryEmbedding: number[];
  limit: number;
  efSearch?: number;
}

export interface ChunkHit {
  id: bigint;
  knowledgeBaseId: bigint;
  knowledgeBaseName: string;
  // Owning document (FK, always present). Surfaced in the playground Sources panel so the operator can
  // open the exact document that grounded the answer; never sent to the customer.
  documentId: bigint;
  documentTitle: string;
  content: string;
  // Free-form chunk metadata (title/sourceUrl/… when the ingest supplied them). Used to build the
  // structured source ref for the playground trace; never sent to the customer.
  metadata: unknown;
  distance: number;
}

// What the query reads to decide the contact footer (issue #747), stripped before a hit leaves the
// service: the base's switch, and whether this passage is the tail of its document, the only place a
// footer lives.
export interface ChunkRow extends ChunkHit {
  stripContactFooters: boolean;
  atDocumentEnd: boolean;
  // The document's last FOOTER_TAIL_CHARS, where its footer is found for a passage that overlaps it
  // without being the tail. null when the base does not strip.
  documentTail: string | null;
}

export async function searchChunks(
  db: ScopedDb,
  params: SearchChunksParams,
): Promise<ChunkRow[]> {
  if (params.knowledgeBaseIds.length === 0) return [];
  const vec = toVectorLiteral(params.queryEmbedding);
  const limit = Math.min(Math.max(Math.floor(params.limit), 1), 50);
  // SET LOCAL takes no bind param; clamp to a validated integer and interpolate via Prisma.raw.
  const ef = Math.min(Math.max(Math.floor(params.efSearch ?? 100), 1), 1000);
  await db.$executeRaw(Prisma.raw(`SET LOCAL hnsw.ef_search = ${ef}`));
  // ANY(ARRAY[...]::bigint[]) — Prisma.join serializes the ids; the explicit cast keeps them bigint
  // (a bare tagged template would serialize to text[]). RLS already fences by tenant; the kb filter
  // narrows to the (tenant-owned, validated) bases.
  // `atDocumentEnd`: the chunker trims each chunk, and splits on paragraphs first, so the document's
  // last chunk is exactly the tail of its (right-trimmed) text. Any mismatch (a document mid-reindex,
  // an unusual whitespace) reads as "not the tail", which only means nothing is stripped.
  // Asked only of a base that switched stripping on: the comparison reads the whole document, which
  // can be millions of characters, and on every other base its answer is thrown away.
  const rows = await db.$queryRaw<ChunkRow[]>`
    SELECT c.id,
           c.knowledge_base_id AS "knowledgeBaseId",
           kb.name AS "knowledgeBaseName",
           c.document_id AS "documentId",
           d.title AS "documentTitle",
           c.content,
           c.metadata,
           (c.embedding <=> ${vec}::vector) AS distance,
           kb.strip_contact_footers AS "stripContactFooters",
           CASE WHEN kb.strip_contact_footers
                THEN right(rtrim(d.content, E' \t\r\n'), length(c.content)) = c.content
                ELSE false END AS "atDocumentEnd",
           CASE WHEN kb.strip_contact_footers
                THEN right(rtrim(d.content, E' \t\r\n'), ${FOOTER_TAIL_CHARS})
                ELSE NULL END AS "documentTail"
    FROM knowledge_chunks c
    JOIN knowledge_bases kb ON kb.id = c.knowledge_base_id
    JOIN knowledge_documents d ON d.id = c.document_id
    WHERE c.knowledge_base_id = ANY(ARRAY[${Prisma.join(params.knowledgeBaseIds)}]::bigint[])
    ORDER BY c.embedding <=> ${vec}::vector
    LIMIT ${limit}`;
  return rows;
}
