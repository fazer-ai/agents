import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  createDocument,
  deleteDocument,
  type EmbeddingBlock,
  getDocument,
  listDocuments,
  readEmbeddingBlock,
  reindexKnowledgeBase,
  retryDocument,
  updateDocument,
} from "@/modules/rag/documents";
import { extractText } from "@/modules/rag/loaders";
import {
  approveApprovalItem,
  createKnowledgeBase,
  createSuggestion,
  deleteKnowledgeBase,
  editApprovalItem,
  getKnowledgeBase,
  listKnowledgeBases,
  listPendingApprovals,
  rejectApprovalItem,
  searchKnowledge,
  updateKnowledgeBase,
} from "@/modules/rag/service";
import type { ChunkHit } from "@/modules/rag/sql";

// Knowledge base + human-approval REST surface (same core the agent tools and MCP project over).
// Reads need auth; mutations and approvals require TENANT_ADMIN (the approval gate is the
// load-bearing "nothing enters a KB without a human" invariant — it must be enforced server-side,
// not by the UI).
//
// i18n anchor — keys referenced via AppError third argument (not direct translate() calls),
// so they are declared here for the i18n extractor (keepRemoved: false). Keep in sync with
// src/modules/rag/loaders.ts and src/modules/rag/documents.ts.
// translate('errors.documentTooLarge', 'Document is too large to process')
// translate('errors.embeddingEmpty', 'The embedding credential is empty.')
// translate('errors.embeddingNotConfigured', 'Embeddings are not configured for this workspace.')
// translate('errors.embeddingPending', 'The embedding credential is not filled in yet.')
// translate('errors.knowledgeBaseNotFound', 'Knowledge base not found.')
// translate('errors.noExtractableText', 'No extractable text found in this {{kind}} file')
// translate('errors.unstorableText', '{{field}} contains characters that cannot be stored ({{codePoints}})')
// translate('errors.unsupportedFileType', 'Unsupported file type: {{type}}')

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

// What the documents endpoint may say about an embedding block. `reason` ONLY: the block also
// carries the credentialRef and its vault id, which the reindex endpoint returns so a TENANT_ADMIN
// can be deeplinked to the entry to fill. This endpoint is open to ANY authenticated role, so
// passing those through would tell an AGENT which vault record backs the workspace's embedding
// settings. Nothing on the screen reads them.
export function readerSafeBlock(
  block: EmbeddingBlock | null,
): { reason: EmbeddingBlock["reason"] } | null {
  return block ? { reason: block.reason } : null;
}

// One search hit on the wire. Written out field by field, NOT as a spread of the row: `ChunkHit`
// carries three bigint columns and the spread published all of them, with only two given a spelling
// JSON accepts. `documentId` rode out as a BigInt and every search that MATCHED something answered
// 500 (issue #253) — the empty-result case serialized fine, so the endpoint looked half-alive. The
// two other readers of `ChunkHit` (the MCP tool and the agent's search_knowledge) already project
// explicitly; this is the one that did not. A column added to the row now reaches the client only
// when someone gives it a spelling here.
export function searchHitDto(h: ChunkHit) {
  return {
    id: String(h.id),
    knowledgeBaseId: String(h.knowledgeBaseId),
    knowledgeBaseName: h.knowledgeBaseName,
    documentId: String(h.documentId),
    documentTitle: h.documentTitle,
    content: h.content,
    metadata: h.metadata,
    distance: h.distance,
  };
}

export const knowledgeController = new Elysia({
  prefix: "/v1/knowledge",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  .get(
    "/bases",
    async ({ tenantContext }) => {
      const bases = await listKnowledgeBases(ctxOrThrow(tenantContext));
      // BigInt is not JSON-serializable (Elysia 500s) and the Eden treaty types must match the
      // wire — serialize ids to string at the boundary (service keeps bigint for internal callers).
      return {
        instance: instanceIdentity,
        bases: bases.map((b) => ({ ...b, id: String(b.id) })),
      };
    },
    {
      requireAuth: true,
      detail: doc(
        "List knowledge bases",
        "List all knowledge bases for the current tenant.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .post(
    "/bases",
    async ({ tenantContext, body }) => {
      const base = await createKnowledgeBase({
        ctx: ctxOrThrow(tenantContext),
        name: body.name,
        description: body.description,
        embeddingModel: body.embeddingModel,
      });
      return { instance: instanceIdentity, base: { id: String(base.id) } };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Create knowledge base",
        "Create a new knowledge base for the current tenant.",
      ),
      response: errors(400, 401, 403, 404, 422),
      body: t.Object({
        name: t.String({
          minLength: 1,
          description: "Human-readable name of the knowledge base.",
        }),
        description: t.Optional(
          t.String({
            description: "Optional description of the knowledge base.",
          }),
        ),
        embeddingModel: t.Optional(
          t.String({
            description:
              "Embedding model identifier used to index documents. Defaults to the configured model.",
          }),
        ),
      }),
    },
  )
  .get(
    "/bases/:id",
    async ({ tenantContext, params }) => {
      const kb = await getKnowledgeBase({
        ctx: ctxOrThrow(tenantContext),
        id: BigInt(params.id),
      });
      return {
        instance: instanceIdentity,
        base: { ...kb, id: String(kb.id) },
      };
    },
    {
      requireAuth: true,
      detail: doc("Get knowledge base", "Fetch a single knowledge base by id."),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({
          description: "Knowledge base id (BigInt as a string).",
        }),
      }),
    },
  )
  .patch(
    "/bases/:id",
    async ({ tenantContext, params, body }) => {
      await updateKnowledgeBase({
        ctx: ctxOrThrow(tenantContext),
        id: BigInt(params.id),
        name: body.name,
        description: body.description,
        chunkSize: body.chunkSize,
        chunkOverlap: body.chunkOverlap,
      });
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Update knowledge base",
        "Update a knowledge base name, description, or chunking parameters.",
      ),
      response: errors(400, 401, 403, 404, 422),
      params: t.Object({
        id: t.String({
          description: "Knowledge base id (BigInt as a string).",
        }),
      }),
      body: t.Object({
        name: t.Optional(
          t.String({
            minLength: 1,
            description: "New name for the knowledge base.",
          }),
        ),
        description: t.Optional(
          t.Union([t.String(), t.Null()], {
            description: "New description, or null to clear it.",
          }),
        ),
        chunkSize: t.Optional(
          t.Integer({
            minimum: 100,
            maximum: 8000,
            description:
              "Maximum characters per chunk when splitting documents for embedding.",
          }),
        ),
        chunkOverlap: t.Optional(
          t.Integer({
            minimum: 0,
            maximum: 4000,
            description:
              "Number of overlapping characters between consecutive chunks.",
          }),
        ),
      }),
    },
  )
  .delete(
    "/bases/:id",
    async ({ tenantContext, params }) => {
      await deleteKnowledgeBase({
        ctx: ctxOrThrow(tenantContext),
        id: BigInt(params.id),
      });
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Delete knowledge base",
        "Delete a knowledge base and all of its documents.",
      ),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({
          description: "Knowledge base id (BigInt as a string).",
        }),
      }),
    },
  )
  .get(
    "/embedding-block",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      // The question is about the WORKSPACE — one embedding credential serves every base — so it
      // gets an endpoint of its own rather than riding on a per-base document list. A console
      // watching a live modal asks this repeatedly; making it re-download a base's documents to
      // learn whether a credential is filled is the wrong trade, and pairing a workspace answer with
      // a base-scoped request means every caller has to remember they are not the same scope.
      block: readerSafeBlock(
        await readEmbeddingBlock(ctxOrThrow(tenantContext)),
      ),
    }),
    {
      requireAuth: true,
      detail: doc(
        "Read the embedding block",
        "Whether anything is preventing this workspace from indexing, and which of the reasons it is. Null when indexing would work.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/bases/:id/documents",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const docs = await listDocuments(ctx, BigInt(params.id));
      const block = await readEmbeddingBlock(ctx);
      return {
        instance: instanceIdentity,
        // The tenant's CURRENT embedding block (null when indexing would work). Resolved per read,
        // not stamped on the rows when they were blocked: a token stored back then would still be
        // telling the operator to fill a credential they have since filled (issue #80).
        //
        embeddingBlock: readerSafeBlock(block),
        documents: docs.map((d) => ({
          ...d,
          id: String(d.id),
          knowledgeBaseId: params.id,
        })),
      };
    },
    {
      requireAuth: true,
      detail: doc("List documents", "List the documents in a knowledge base."),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({
          description: "Knowledge base id (BigInt as a string).",
        }),
      }),
    },
  )
  .post(
    "/bases/:id/documents",
    async ({ tenantContext, params, body }) => {
      const doc = await createDocument({
        ctx: ctxOrThrow(tenantContext),
        knowledgeBaseId: BigInt(params.id),
        title: body.title,
        text: body.text,
        sourceType: "text",
      });
      return {
        instance: instanceIdentity,
        document: { id: String(doc.id), status: doc.status },
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Add text document",
        "Add a plain-text document to a knowledge base for embedding.",
      ),
      response: errors(400, 401, 403, 404, 422),
      params: t.Object({
        id: t.String({
          description: "Knowledge base id (BigInt as a string).",
        }),
      }),
      body: t.Object({
        title: t.String({
          minLength: 1,
          description: "Title of the document.",
        }),
        text: t.String({
          minLength: 1,
          description: "Raw text content to ingest and embed.",
        }),
      }),
    },
  )
  .post(
    "/bases/:id/documents/upload",
    async ({ tenantContext, params, body }) => {
      const file = body.file as File;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { text } = await extractText({
        name: file.name,
        type: file.type,
        bytes,
      });
      const doc = await createDocument({
        ctx: ctxOrThrow(tenantContext),
        knowledgeBaseId: BigInt(params.id),
        title: body.title ?? file.name,
        text,
        sourceType: "file",
        fileName: file.name,
        mimeType: file.type || undefined,
      });
      return {
        instance: instanceIdentity,
        document: { id: String(doc.id), status: doc.status },
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Upload document file",
        "Upload a file (e.g. PDF, DOCX, TXT), extract its text, and ingest it into a knowledge base.",
      ),
      response: errors(400, 401, 403, 404, 413, 415, 422),
      params: t.Object({
        id: t.String({
          description: "Knowledge base id (BigInt as a string).",
        }),
      }),
      body: t.Object({
        file: t.File({
          description: "The file to upload; its text is extracted server-side.",
        }),
        title: t.Optional(
          t.String({
            description:
              "Optional document title. Defaults to the uploaded file name.",
          }),
        ),
      }),
    },
  )
  .get(
    "/documents/:id",
    async ({ tenantContext, params }) => {
      const doc = await getDocument(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
      );
      return {
        instance: instanceIdentity,
        document: {
          ...doc,
          id: String(doc.id),
          knowledgeBaseId: String(doc.knowledgeBaseId),
        },
      };
    },
    {
      requireAuth: true,
      detail: doc(
        "Get document",
        "Fetch a single document by id, including its ingestion status.",
      ),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({ description: "Document id (BigInt as a string)." }),
      }),
    },
  )
  .patch(
    "/documents/:id",
    async ({ tenantContext, params, body }) => {
      const doc = await updateDocument(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
        {
          title: body.title,
          text: body.text,
        },
      );
      return {
        instance: instanceIdentity,
        document: { id: String(doc.id), status: doc.status },
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Update document",
        "Edit a document's title and/or text. Changing the text re-ingests and re-embeds it.",
      ),
      response: errors(400, 401, 403, 404, 422),
      params: t.Object({
        id: t.String({ description: "Document id (BigInt as a string)." }),
      }),
      body: t.Object({
        title: t.Optional(
          t.String({
            minLength: 1,
            description: "New title for the document.",
          }),
        ),
        text: t.Optional(
          t.String({
            minLength: 1,
            description: "New text content; re-ingested and re-embedded.",
          }),
        ),
      }),
    },
  )
  .delete(
    "/documents/:id",
    async ({ tenantContext, params }) => {
      await deleteDocument(ctxOrThrow(tenantContext), BigInt(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Delete document",
        "Delete a document and its embeddings from the knowledge base.",
      ),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({ description: "Document id (BigInt as a string)." }),
      }),
    },
  )
  .post(
    "/documents/:id/retry",
    async ({ tenantContext, params }) => {
      await retryDocument(ctxOrThrow(tenantContext), BigInt(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Retry document ingestion",
        "Re-run ingestion and embedding for a document that previously failed.",
      ),
      response: errors(400, 401, 403, 404, 409),
      params: t.Object({
        id: t.String({ description: "Document id (BigInt as a string)." }),
      }),
    },
  )
  .post(
    "/bases/:id/reindex",
    async ({ tenantContext, params, query }) => {
      const result = await reindexKnowledgeBase(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
        undefined,
        { includeFailed: query.includeFailed === true },
      );
      return { instance: instanceIdentity, ...result };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Index pending knowledge-base documents",
        "Queue ingestion + embedding for every not-yet-indexed (UNINDEXED) document in the base, e.g. after importing an agent that bundled its documents. Pass includeFailed=true to also re-queue FAILED documents (bulk recovery). If the tenant's embedding credential is unconfigured or its secret is not filled yet, nothing is queued and `blocked` explains why (the documents keep their status).",
      ),
      response: errors(400, 401, 403, 404, 422),
      params: t.Object({
        id: t.String({
          description: "Knowledge base id (BigInt as a string).",
        }),
      }),
      query: t.Object({
        includeFailed: t.Optional(
          t.Boolean({
            description:
              "Also re-queue FAILED documents (bulk recovery of genuine ingestion errors), not just UNINDEXED.",
          }),
        ),
      }),
    },
  )
  .post(
    "/search",
    async ({ tenantContext, body }) => {
      const hits = await searchKnowledge({
        ctx: ctxOrThrow(tenantContext),
        query: body.query,
        knowledgeBaseIds: body.knowledgeBaseIds?.map((s) => BigInt(s)),
        limit: body.limit,
      });
      return { instance: instanceIdentity, hits: hits.map(searchHitDto) };
    },
    {
      requireAuth: true,
      detail: doc(
        "Search knowledge",
        "Run a semantic search across one or more knowledge bases and return ranked chunks.",
      ),
      response: errors(400, 401, 403, 404, 422),
      body: t.Object({
        query: t.String({
          minLength: 1,
          description: "Natural-language search query.",
        }),
        knowledgeBaseIds: t.Optional(
          t.Array(t.String(), {
            description:
              "Restrict the search to these knowledge base ids (BigInt as strings). Omit to search all of the tenant's bases.",
          }),
        ),
        limit: t.Optional(
          t.Integer({
            minimum: 1,
            maximum: 20,
            description: "Maximum number of chunks to return.",
          }),
        ),
      }),
    },
  )
  .post(
    "/suggestions",
    async ({ tenantContext, body }) => {
      const suggestion = await createSuggestion({
        ctx: ctxOrThrow(tenantContext),
        knowledgeBaseId: BigInt(body.knowledgeBaseId),
        proposedContent: body.content,
        proposedTitle: body.title,
        rationale: body.rationale,
      });
      return {
        instance: instanceIdentity,
        suggestion: { id: String(suggestion.id) },
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Suggest knowledge entry",
        "Create a pending suggestion to add an entry to a knowledge base, awaiting human approval.",
      ),
      response: errors(400, 401, 403, 404, 422),
      body: t.Object({
        knowledgeBaseId: t.String({
          description: "Target knowledge base id (BigInt as a string).",
        }),
        content: t.String({
          minLength: 1,
          description: "Proposed content of the knowledge entry.",
        }),
        title: t.Optional(
          t.String({ description: "Proposed title for the entry." }),
        ),
        rationale: t.Optional(
          t.String({ description: "Why this entry is being suggested." }),
        ),
      }),
    },
  )
  .get(
    "/approvals",
    async ({ tenantContext }) => {
      const approvals = await listPendingApprovals(ctxOrThrow(tenantContext));
      return { instance: instanceIdentity, approvals };
    },
    {
      requireAuth: true,
      detail: doc(
        "List pending approvals",
        "List knowledge-base suggestions awaiting human approval.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .patch(
    "/approvals/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      result: await editApprovalItem({
        ctx: ctxOrThrow(tenantContext),
        id: BigInt(params.id),
        proposedTitle: body.title,
        proposedContent: body.content,
        rationale: body.rationale,
      }),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Edit pending approval",
        "Edit the title, content, or rationale of a pending knowledge-base suggestion before approving it.",
      ),
      response: errors(400, 401, 403, 404, 422),
      params: t.Object({
        id: t.String({ description: "Approval item id (BigInt as a string)." }),
      }),
      body: t.Object({
        title: t.Optional(
          t.String({ description: "Revised title for the suggested entry." }),
        ),
        content: t.Optional(
          t.String({ description: "Revised content for the suggested entry." }),
        ),
        rationale: t.Optional(
          t.String({ description: "Revised rationale for the suggestion." }),
        ),
      }),
    },
  )
  .post(
    "/approvals/:id/approve",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      result: await approveApprovalItem({
        ctx: ctxOrThrow(tenantContext),
        id: BigInt(params.id),
      }),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Approve suggestion",
        "Approve a pending suggestion, committing the entry into its knowledge base.",
      ),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({ description: "Approval item id (BigInt as a string)." }),
      }),
    },
  )
  .post(
    "/approvals/:id/reject",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      result: await rejectApprovalItem({
        ctx: ctxOrThrow(tenantContext),
        id: BigInt(params.id),
      }),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Reject suggestion",
        "Reject a pending suggestion so it is not added to the knowledge base.",
      ),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({ description: "Approval item id (BigInt as a string)." }),
      }),
    },
  );
