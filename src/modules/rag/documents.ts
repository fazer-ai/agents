import type { PrismaClient } from "@/../generated/prisma/client";
import { broadcastDocumentEvent } from "@/api/features/realtime/realtime.service";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { cancelPendingJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { readEmbeddingSettings } from "@/modules/tenant-settings/service";
import { resolveVaultRefState } from "@/modules/vault/service";
import { chunkText } from "./chunk";
import { type EmbeddingConfig, embedTexts } from "./embeddings";
import { toVectorLiteral } from "./sql";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Re-export for callers (approval flow).
export { sysCtx };

// Embedding usability resolved WITHOUT throwing, so callers (the reindex pre-check, the ingest job)
// can branch on the exact reason instead of turning a missing prerequisite into a document FAILED.
//   not_configured    → no credentialRef in the tenant's embedding settings;
//   credential_pending → a ref is set but its vault secret is not filled yet (a pending entry);
//   credential_empty   → the secret resolved but is blank.
export type EmbeddingStatus =
  | { ok: true; config: EmbeddingConfig }
  | { ok: false; reason: "not_configured" }
  | {
      ok: false;
      reason: "credential_pending" | "credential_empty";
      credentialRef: string;
    };

export async function resolveEmbeddingStatus(
  db: ScopedDb,
  tenantId: bigint,
  model: string,
): Promise<EmbeddingStatus> {
  const settings = await readEmbeddingSettings(db, tenantId);
  if (!settings.credentialRef) return { ok: false, reason: "not_configured" };
  // NOTE: The three failures are distinguished from ONE read (see resolveVaultRefState). A ref whose
  // row is gone is not "pending": telling the operator to fill a credential that no longer exists
  // sends them looking for a row that is not there, so it falls back to the reason a workspace that
  // never configured one gets. An ACTIVE row holding a blank secret is neither — it is `empty`, and
  // that only stays distinguishable because the state and the value came from the same query.
  const resolved = await resolveVaultRefState<
    string | { apiKey: string; baseURL?: string }
  >(db, settings.credentialRef);
  if (resolved.state === "not_found")
    return { ok: false, reason: "not_configured" };
  if (resolved.state === "pending")
    return {
      ok: false,
      reason: "credential_pending",
      credentialRef: settings.credentialRef,
    };
  const raw = resolved.value;
  const { apiKey, baseURL: secretBaseURL } =
    typeof raw === "string" || !raw
      ? { apiKey: typeof raw === "string" ? raw : "", baseURL: undefined }
      : raw;
  if (!apiKey)
    return {
      ok: false,
      reason: "credential_empty",
      credentialRef: settings.credentialRef,
    };
  return {
    ok: true,
    config: { model, apiKey, baseURL: settings.baseURL ?? secretBaseURL },
  };
}

// NOTE: The English message carries the reason, and is not allowed to collapse into one generic
// sentence. MCP hands `AppError.message` to the caller verbatim and the translation key has no
// server-side locale entry, so outside the console the message is the only thing that says which of
// the three happened.
function embeddingBlockMessage(
  status: Exclude<EmbeddingStatus, { ok: true }>,
): string {
  if (status.reason === "credential_pending")
    return "embedding credential is not filled in yet";
  if (status.reason === "credential_empty")
    return "embedding credential is empty";
  return "embedding credential not configured";
}

export async function resolveEmbeddingConfig(
  db: ScopedDb,
  tenantId: bigint,
  model: string,
): Promise<EmbeddingConfig> {
  const status = await resolveEmbeddingStatus(db, tenantId, model);
  if (status.ok) return status.config;
  throw new AppError(
    embeddingBlockMessage(status),
    400,
    `errors.embedding.${embeddingBlock(status).reason}`,
  );
}

// Validation: chunkSize 100–8000, chunkOverlap 0–floor(chunkSize/2)
export function validateChunkParams(
  chunkSize: number,
  chunkOverlap: number,
): void {
  if (chunkSize < 100 || chunkSize > 8000) {
    throw new AppError("chunkSize must be between 100 and 8000", 400);
  }
  if (chunkOverlap < 0 || chunkOverlap > Math.floor(chunkSize / 2)) {
    throw new AppError(
      "chunkOverlap must be between 0 and floor(chunkSize/2)",
      400,
    );
  }
}

export interface CreateDocumentParams {
  tenantId: bigint;
  knowledgeBaseId: bigint;
  title: string;
  text: string;
  sourceType: "text" | "file" | "approval";
  fileName?: string;
  mimeType?: string;
  base?: PrismaClient;
}

export async function createDocument(
  params: CreateDocumentParams,
): Promise<{ id: bigint; status: string }> {
  const base = params.base ?? basePrisma;
  const { tenantId, knowledgeBaseId } = params;

  const doc = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const kb = await db.knowledgeBase.findUnique({
      where: { id: knowledgeBaseId },
      select: { id: true },
    });
    if (!kb) throw new NotFoundError("knowledge base not found");
    return db.knowledgeDocument.create({
      data: {
        tenantId,
        knowledgeBaseId,
        title: params.title,
        sourceType: params.sourceType,
        fileName: params.fileName,
        mimeType: params.mimeType,
        content: params.text,
        status: "PENDING",
      },
      select: { id: true, status: true },
    });
  });

  await enqueueJob({
    tenantId,
    kind: "RAG_INGEST",
    dedupeKey: `doc:${doc.id}`,
    runAt: new Date(),
    payload: { documentId: String(doc.id) },
    base,
  });

  broadcastDocumentEvent(tenantId, {
    knowledgeBaseId: String(knowledgeBaseId),
    documentId: String(doc.id),
    status: "PENDING",
  });

  return { id: doc.id, status: doc.status };
}

interface DocumentListRow {
  id: bigint;
  title: string;
  sourceType: string;
  fileName: string | null;
  mimeType: string | null;
  status: string;
  error: string | null;
  chunkCount: number | null;
  createdAt: Date;
  updatedAt: Date;
  contentChars: number;
}

export async function listDocuments(
  tenantId: bigint,
  knowledgeBaseId: bigint,
  base: PrismaClient = basePrisma,
): Promise<DocumentListRow[]> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const kb = await db.knowledgeBase.findUnique({
      where: { id: knowledgeBaseId },
      select: { id: true },
    });
    if (!kb) throw new NotFoundError("knowledge base not found");
    // NOTE: length(content) computes character count in Postgres without loading the content
    // column into the application layer. RLS is active via runScopedOn, so the GUC tenant fence
    // applies to this raw query too.
    const rows = await db.$queryRaw<DocumentListRow[]>`
      SELECT id,
             title,
             source_type      AS "sourceType",
             file_name        AS "fileName",
             mime_type        AS "mimeType",
             status,
             error,
             chunk_count      AS "chunkCount",
             created_at       AS "createdAt",
             updated_at       AS "updatedAt",
             length(content)  AS "contentChars"
      FROM knowledge_documents
      WHERE knowledge_base_id = ${knowledgeBaseId}
      ORDER BY created_at DESC`;
    return rows;
  });
}

export async function getDocument(
  tenantId: bigint,
  id: bigint,
  base: PrismaClient = basePrisma,
) {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const doc = await db.knowledgeDocument.findUnique({
      where: { id },
      select: {
        id: true,
        knowledgeBaseId: true,
        title: true,
        sourceType: true,
        fileName: true,
        mimeType: true,
        content: true,
        status: true,
        error: true,
        chunkCount: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!doc) throw new NotFoundError("document not found");
    return doc;
  });
}

export async function deleteDocument(
  tenantId: bigint,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const res = await db.knowledgeDocument.deleteMany({ where: { id } });
    if (res.count === 0) throw new NotFoundError("document not found");
  });
}

export interface UpdateDocumentParams {
  title?: string;
  text?: string;
}

// Edit a document's title and/or text. Changing the text RE-INGESTS it (status → PENDING → the
// RAG_INGEST job re-chunks + re-embeds, replacing the old chunks — same path as retry/create); a
// title-only edit just updates the metadata, no re-embed (the chunks are the content, not the title).
export async function updateDocument(
  tenantId: bigint,
  id: bigint,
  params: UpdateDocumentParams,
  base: PrismaClient = basePrisma,
): Promise<{ id: bigint; status: string }> {
  const hasTitle = params.title !== undefined;
  const hasText = params.text !== undefined;
  if (!hasTitle && !hasText) throw new AppError("nothing to update", 400);

  const { doc, reingest } = await runScopedOn(
    base,
    sysCtx(tenantId),
    async (db) => {
      const existing = await db.knowledgeDocument.findUnique({
        where: { id },
        select: { id: true, content: true },
      });
      if (!existing) throw new NotFoundError("document not found");
      const reingest = hasText && params.text !== existing.content;
      const updated = await db.knowledgeDocument.update({
        where: { id },
        data: {
          ...(hasTitle ? { title: params.title } : {}),
          ...(reingest
            ? { content: params.text, status: "PENDING", error: null }
            : {}),
        },
        select: { id: true, status: true, knowledgeBaseId: true },
      });
      return { doc: updated, reingest };
    },
  );

  if (reingest) {
    await enqueueJob({
      tenantId,
      kind: "RAG_INGEST",
      dedupeKey: `doc:${id}`,
      runAt: new Date(),
      payload: { documentId: String(id) },
      base,
    });
  }
  broadcastDocumentEvent(tenantId, {
    knowledgeBaseId: String(doc.knowledgeBaseId),
    documentId: String(id),
    status: doc.status,
  });

  return { id: doc.id, status: doc.status };
}

export async function retryDocument(
  tenantId: bigint,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const doc = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const existing = await db.knowledgeDocument.findUnique({
      where: { id },
      select: { id: true, status: true, knowledgeBaseId: true },
    });
    if (!existing) throw new NotFoundError("document not found");
    // FAILED = errored ingestion (retry); UNINDEXED = imported-but-never-indexed (first index). Both
    // re-run through the same PENDING → ingest path.
    if (existing.status !== "FAILED" && existing.status !== "UNINDEXED") {
      throw new AppError(
        "only FAILED or UNINDEXED documents can be re-indexed",
        409,
      );
    }
    await db.knowledgeDocument.updateMany({
      where: { id, status: { in: ["FAILED", "UNINDEXED"] } },
      data: { status: "PENDING", error: null },
    });
    return existing;
  });

  await enqueueJob({
    tenantId,
    kind: "RAG_INGEST",
    dedupeKey: `doc:${id}`,
    runAt: new Date(),
    payload: { documentId: String(id) },
    base,
  });

  broadcastDocumentEvent(tenantId, {
    knowledgeBaseId: String(doc.knowledgeBaseId),
    documentId: String(id),
    status: "PENDING",
  });
}

// Result of a bulk reindex. `blocked` is set (and `queued` is 0) when a PREREQUISITE is missing — the
// tenant's embedding credential is unconfigured or its secret is not filled yet — so nothing is queued
// and the docs are left where they are (a missing prerequisite is not an ingestion failure). Callers
// surface the block at the KB/tenant level (config health / a fill deeplink), not as red documents.
// The one vocabulary for "embedding is not usable", shared by the reindex result and by the live
// read the console renders from. `credential_empty` joined it so all three resolvable reasons have a
// name here instead of two of them collapsing into one.
export interface EmbeddingBlock {
  reason:
    | "embedding_not_configured"
    | "credential_pending"
    | "credential_empty";
  credentialRef?: string;
  vaultId?: string;
}

export interface ReindexResult {
  queued: number;
  blocked?: EmbeddingBlock;
}

// Maps a non-ok embedding status to the reindex `blocked` shape. A pending/empty credential parses the
// `vault:<id>` ref into `vaultId` so a transport can build the fill deeplink.
function embeddingBlock(
  status: Exclude<EmbeddingStatus, { ok: true }>,
): EmbeddingBlock {
  if (status.reason === "not_configured")
    return { reason: "embedding_not_configured" };
  const vaultId = status.credentialRef.startsWith("vault:")
    ? status.credentialRef.slice("vault:".length)
    : undefined;
  return {
    reason:
      status.reason === "credential_empty"
        ? "credential_empty"
        : "credential_pending",
    credentialRef: status.credentialRef,
    vaultId,
  };
}

// The tenant's CURRENT embedding block, or null when indexing would work. Read at the moment the
// console asks rather than stamped on a document when the block happened: one credential serves
// every base, so this is a property of the configuration and it changes when the configuration
// changes — the row that failed under it has no way to know.
//
// NOTE: No model argument. `resolveEmbeddingStatus` only echoes the model back on the OK path, so a
// block never depends on which base is being looked at — which is also why the caller does not have
// to load a knowledge base (and pay its chunk count) to ask this question.
export async function readEmbeddingBlock(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<EmbeddingBlock | null> {
  const status = await runScopedOn(base, sysCtx(tenantId), (db) =>
    resolveEmbeddingStatus(db, tenantId, ""),
  );
  return status.ok ? null : embeddingBlock(status);
}

// Queues ingestion for every UNINDEXED document in a knowledge base — the bulk "index all" after an
// agent import that bundled the source text. Pass `includeFailed` to also re-queue FAILED docs (bulk
// recovery of genuine ingestion errors — the same PENDING → ingest path as the per-document retry). If
// the embedding prerequisite is missing, nothing is queued and `blocked` explains why (docs stay put).
export async function reindexKnowledgeBase(
  tenantId: bigint,
  knowledgeBaseId: bigint,
  base: PrismaClient = basePrisma,
  opts: { includeFailed?: boolean; dryRun?: boolean } = {},
): Promise<ReindexResult> {
  const statuses = opts.includeFailed ? ["UNINDEXED", "FAILED"] : ["UNINDEXED"];
  const outcome = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const kb = await db.knowledgeBase.findUnique({
      where: { id: knowledgeBaseId },
      select: { id: true, embeddingModel: true },
    });
    if (!kb) throw new NotFoundError("knowledge base not found");
    const targets = await db.knowledgeDocument.findMany({
      where: { knowledgeBaseId, status: { in: statuses } },
      select: { id: true },
    });
    if (targets.length === 0)
      return { docs: [] as { id: bigint }[], blocked: undefined };
    // Prerequisite check: if embedding is not usable, do NOT enqueue. Leave the docs where they are
    // (UNINDEXED stays UNINDEXED) and report the block so the caller points the operator at the fix
    // instead of running each doc into a FAILED it didn't earn.
    const emb = await resolveEmbeddingStatus(db, tenantId, kb.embeddingModel);
    if (!emb.ok) return { docs: targets, blocked: emb };
    // dry-run previews the count (below) without touching the docs.
    if (opts.dryRun) return { docs: targets, blocked: undefined };
    await db.knowledgeDocument.updateMany({
      where: { knowledgeBaseId, status: { in: statuses } },
      data: { status: "PENDING", error: null },
    });
    return { docs: targets, blocked: undefined };
  });

  if (outcome.blocked) {
    return { queued: 0, blocked: embeddingBlock(outcome.blocked) };
  }
  // dry-run: report how many WOULD be queued, without enqueuing.
  if (opts.dryRun) return { queued: outcome.docs.length };

  for (const d of outcome.docs) {
    await enqueueJob({
      tenantId,
      kind: "RAG_INGEST",
      dedupeKey: `doc:${d.id}`,
      runAt: new Date(),
      payload: { documentId: String(d.id) },
      base,
    });
    broadcastDocumentEvent(tenantId, {
      knowledgeBaseId: String(knowledgeBaseId),
      documentId: String(d.id),
      status: "PENDING",
    });
  }

  return { queued: outcome.docs.length };
}

// ── RAG_INGEST job handler ──

async function runIngestJobForTenant(
  tenantId: bigint,
  documentId: bigint,
  base: PrismaClient,
): Promise<JobResult> {
  // 1. Load document + KB config (scoped read, no network).
  const loaded = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    // NOTE: the content is deliberately NOT read here. It is read by the claim below, in the same
    // transaction that takes the mark — see there for why the two cannot be separated.
    const doc = await db.knowledgeDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        status: true,
        knowledgeBaseId: true,
      },
    });
    if (!doc) return null;
    // If it somehow ended up not PENDING (e.g. a duplicate job), skip.
    if (doc.status !== "PENDING") return null;
    const kb = await db.knowledgeBase.findUnique({
      where: { id: doc.knowledgeBaseId },
      select: {
        id: true,
        embeddingModel: true,
        chunkSize: true,
        chunkOverlap: true,
      },
    });
    if (!kb) return null;
    return { doc, kb };
  });
  if (!loaded) return { outcome: "done" };
  const { doc, kb } = loaded;

  // Prerequisite check BEFORE touching the doc: if embedding is not usable (unconfigured, or the
  // credential's secret is not filled yet) this is a missing prerequisite, NOT a document failure.
  // Revert PENDING → UNINDEXED so a later reindex retries once embedding is ready; the block is
  // surfaced at the KB/tenant level (config health), not as a red FAILED doc.
  const emb = await runScopedOn(base, sysCtx(tenantId), (db) =>
    resolveEmbeddingStatus(db, tenantId, kb.embeddingModel),
  );
  if (!emb.ok) {
    // NOTE: The reason is NOT written onto the document. The block is a property of the tenant's
    // embedding configuration at a point in time — one credential serves every base — so a token
    // stamped here would still be claiming "fill the credential" after the operator filled it, with
    // nothing to recompute it (issue #80). `readEmbeddingBlock` answers the same question live, at
    // the moment the console asks. The row stays what it is: not indexed, no failure of its own.
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.knowledgeDocument.updateMany({
        where: { id: documentId, status: "PENDING" },
        data: { status: "UNINDEXED", error: null },
      }),
    );
    broadcastDocumentEvent(tenantId, {
      knowledgeBaseId: String(doc.knowledgeBaseId),
      documentId: String(documentId),
      status: "UNINDEXED",
    });
    return { outcome: "done" };
  }

  // NOTE: PENDING → PROCESSING marks the document as owned by THIS run, and the text to index is
  // read back under the same transaction. The two are one step because an edit landing between them
  // leaves the row PENDING — the value it already had — so a claim taken on separately-read text
  // still succeeds, and the run would go on to index text the document no longer has while holding
  // a mark that says it may publish. The UPDATE holds this row's lock for the rest of the
  // transaction, so the content read after it is the content as of the claim.
  const claimed = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const { count } = await db.knowledgeDocument.updateMany({
      where: { id: documentId, status: "PENDING" },
      data: { status: "PROCESSING" },
    });
    if (count === 0) return null;
    return db.knowledgeDocument.findUnique({
      where: { id: documentId },
      select: { content: true },
    });
  });
  if (!claimed) return { outcome: "done" };
  broadcastDocumentEvent(tenantId, {
    knowledgeBaseId: String(doc.knowledgeBaseId),
    documentId: String(documentId),
    status: "PROCESSING",
  });

  try {
    // 2. Chunk + embed (NO transaction, network I/O). Embedding config came from the prerequisite
    // check above.
    const chunks = await chunkText(claimed.content, {
      chunkSize: kb.chunkSize,
      chunkOverlap: kb.chunkOverlap,
    });
    const vectors = chunks.length ? await embedTexts(chunks, emb.config) : [];

    // NOTE: step 4, publish — release the mark, then replace the chunks (one scoped transaction).
    const published = await runScopedOn(base, sysCtx(tenantId), async (db) => {
      // NOTE: only the run still holding the mark may publish (issue #163). An edit landing during
      // the embed above sets the row back to PENDING to ask for a re-index, and an unconditional
      // `READY` erased that marker, leaving the new text in the row and the old text in the index.
      // Releasing BEFORE the chunk writes is the rest of it: a stale run returns having written
      // nothing, so the previous index survives until the re-armed job replaces it, and a live run
      // holds this row lock for the rest of the transaction, so no edit lands mid-write.
      const released = await db.knowledgeDocument.updateMany({
        where: { id: documentId, status: "PROCESSING" },
        data: { status: "READY", chunkCount: chunks.length, error: null },
      });
      if (released.count === 0) return false;
      // Delete old chunks for this document.
      await db.knowledgeChunk.deleteMany({ where: { documentId } });
      // Insert new chunks with documentId.
      for (let i = 0; i < chunks.length; i++) {
        const vec = toVectorLiteral(vectors[i] as number[]);
        await db.$executeRaw`
          INSERT INTO knowledge_chunks (tenant_id, knowledge_base_id, document_id, content, embedding, metadata, created_at)
          VALUES (${tenantId}, ${doc.knowledgeBaseId}, ${documentId}, ${chunks[i]}, ${vec}::vector, ${JSON.stringify({ documentId: String(documentId) })}::jsonb, now())`;
      }
      return true;
    });
    if (!published) return { outcome: "done" };

    broadcastDocumentEvent(tenantId, {
      knowledgeBaseId: String(doc.knowledgeBaseId),
      documentId: String(documentId),
      status: "READY",
      chunkCount: chunks.length,
    });

    return { outcome: "done" };
  } catch (err) {
    // Store the i18n key (a stable token) when the failure is a known AppError, so the UI can localize
    // the reason (e.g. embedding credential missing); otherwise the raw message (diagnostic).
    const message =
      err instanceof AppError && err.translationKey
        ? err.translationKey
        : err instanceof Error
          ? err.message.slice(0, 500)
          : String(err);
    logger.error({ err, documentId: String(documentId) }, "RAG ingest failed");
    // NOTE: the same release, and for the same reason. A failure belongs to the content this run
    // read, so stamping it on a document that has since been edited both reports the wrong thing
    // and buries the re-index (FAILED is no more PENDING than READY is, and the re-armed job
    // returns on it). Leaving the row PENDING lets the re-armed job try the new content instead.
    const stamped = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.knowledgeDocument.updateMany({
        where: { id: documentId, status: "PROCESSING" },
        data: { status: "FAILED", error: message },
      }),
    );
    if (stamped.count > 0) {
      broadcastDocumentEvent(tenantId, {
        knowledgeBaseId: String(doc.knowledgeBaseId),
        documentId: String(documentId),
        status: "FAILED",
        error: message,
      });
    }
    return { outcome: "fail", error: message };
  }
}

let registered = false;
export function registerRagIngestHandler(): void {
  if (registered) return;
  registerJobHandler("RAG_INGEST", async (job, base) => {
    const rawId = job.payload.documentId;
    if (typeof rawId !== "string") return { outcome: "done" };
    const documentId = BigInt(rawId);
    return runIngestJobForTenant(job.tenantId, documentId, base);
  });
  registered = true;
}

export { cancelPendingJob };
