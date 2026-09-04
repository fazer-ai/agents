import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import { broadcastDocumentEvent } from "@/api/features/realtime/realtime.service";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import {
  EMBEDDING_BLOCK_KEY,
  type EmbeddingBlockReason,
} from "@/lib/embedding-block";
import { AppError, NotFoundError } from "@/lib/errors";
import { sanitizeErrorMessage } from "@/lib/redact";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { firstUnstorableField } from "@/lib/text";
import { auditMutation, projectionMoved } from "@/modules/audit/service";
import { emitDeadLetter } from "@/modules/flowlog/dead-letter";
import {
  cancelPendingJob,
  enqueueJob,
  upsertJobRows,
} from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { readEmbeddingSettings } from "@/modules/tenant-settings/service";
import { resolveVaultEntryState } from "@/modules/vault/service";
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
  // NOTE: The three failures are distinguished from ONE read (see resolveVaultEntryState). A ref whose
  // row is gone is not "pending": telling the operator to fill a credential that no longer exists
  // sends them looking for a row that is not there, so it falls back to the reason a workspace that
  // never configured one gets. An ACTIVE row holding a blank secret is neither — it is `empty`, and
  // that only stays distinguishable because the state and the value came from the same query.
  const resolved = await resolveVaultEntryState<
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
  const raw = resolved.entry.secret;
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
    config: {
      model,
      apiKey,
      // The entry's baseUrl is honored ONLY for `openai_compatible`. `updateEmbeddingSettings`
      // validates that this ref resolves and NOT what kind it is, while three other kinds require a
      // baseUrl of their own (chatwoot_api_token, mcp_oauth, langfuse) and any kind at all may carry
      // one. Without the kind test, an operator who picks the Chatwoot credential here does not get
      // a 401 from OpenAI any more — they get every chunk of their knowledge base POSTed at the
      // Chatwoot host.
      baseURL:
        settings.baseURL ??
        (resolved.entry.kind === "openai_compatible"
          ? resolved.entry.baseUrl
          : null) ??
        secretBaseURL,
    },
  };
}

// NOTE: The English message carries the reason, and is not allowed to collapse into one generic
// sentence. The three keys DO have server-side entries now (EMBEDDING_BLOCK_KEY, issue #256), but
// only the console reads them: MCP hands `AppError.message` to the caller verbatim, on a surface
// with no locale and no structured error channel, so outside the console this message is still the
// only thing that says which of the three happened.
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
    EMBEDDING_BLOCK_KEY[embeddingBlock(status).reason],
  );
}

// The same rule asked of the ROW a patch will produce, rather than of the arguments it carries.
//
// A knowledge base holds both numbers, and `chunkOverlap <= floor(chunkSize/2)` relates them, so a
// patch that names one of them is still a statement about the pair. `updateKnowledgeBase` used to
// validate only when both arrived and, when one did, compared it against a constant — which meant
// either single-field update landed a state the two-field update refuses by name, and the refusal it
// did print named a bound it had not checked (issue #524).
//
// Merging here rather than at each caller is what keeps the rule single: the preview and the apply
// both hand it the row they read, and neither restates the arithmetic.
export function assertChunkingUpdatable(
  stored: { chunkSize: number; chunkOverlap: number },
  patch: { chunkSize?: number; chunkOverlap?: number },
): void {
  // NOTE: it answers a CHUNKING patch, and a patch naming neither number is not one. Without this
  // line a row already holding an invalid pair — the state the old branch let through, and the only
  // reason such rows exist — would refuse a rename, reporting a bound on a field the caller never
  // sent. The invariant is enforced going forward; it is not retroactive repair, and blocking
  // unrelated edits until someone fixes the chunking is not the same thing as fixing it.
  if (patch.chunkSize === undefined && patch.chunkOverlap === undefined) return;
  validateChunkParams(
    patch.chunkSize ?? stored.chunkSize,
    patch.chunkOverlap ?? stored.chunkOverlap,
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
    // NOTE: the ceiling is spelled out because a patch may not carry the chunk size it is measured
    // against: an operator sending only `chunkOverlap` cannot otherwise tell which number lost.
    throw new AppError(
      `chunkOverlap must be between 0 and ${Math.floor(chunkSize / 2)} (floor(chunkSize/2), for chunkSize ${chunkSize})`,
      400,
    );
  }
}

// The refusal, in the core rather than at a transport, because three roads reach these writes: the
// REST endpoints, the MCP write tool, and the agent's own suggestion being published. `unstorable`
// carries the field and the offending code point, which is the whole difference between an answer a
// caller can act on and the 500 this replaces.
export function refuseUnstorable(
  fields: readonly (readonly [string, string | null | undefined])[],
): void {
  const bad = firstUnstorableField(fields);
  if (bad) {
    // The PARTS, not the sentence. `translationKey` is translated per the request's Accept-Language
    // and `message` is only the untranslated fallback, so interpolating an English sentence into a
    // pt-BR template would answer in two languages at once. What stays English either way is the
    // field name, which names the request field to change the way a schema path does.
    throw new AppError(
      bad.message,
      400,
      "errors.unstorableText",
      { field: bad.what, codePoints: bad.codePoints.join(" ") },
      // On the WIRE as well, and not only interpolated into the sentence. The params are what the
      // locale template reads; `field` is what a console keys on to put the sentence under the box
      // holding the character (#231). Without it every one of these answered `{ error }` alone and
      // the four titles/texts this helper guards could not be placed anywhere.
      bad.what,
    );
  }
}

export interface CreateDocumentParams {
  ctx: TenantContext;
  knowledgeBaseId: bigint;
  title: string;
  text: string;
  sourceType: "text" | "file" | "approval";
  fileName?: string;
  mimeType?: string;
  base?: PrismaClient;
}

// What a document's audit row carries, and the one thing it never does.
//
// Identity and shape: which base it belongs to, its title, where it came from, the file it arrived
// as, and its indexing status. NEVER `content`. This is the payload most likely to carry a
// customer's data, the row is append-only and readable by every tenant admin, and it outlives the
// document — so the body is not in the projection and is not compared either: `chars` says a text
// moved and how big it is, which is what a reader of the trail needs from it.
type DocAuditRow = {
  id: bigint;
  knowledgeBaseId: bigint;
  title: string;
  sourceType: string;
  fileName: string | null;
  mimeType: string | null;
  status: string;
  chars: number;
};

function docAuditProjection(r: DocAuditRow) {
  return {
    id: String(r.id),
    knowledgeBaseId: String(r.knowledgeBaseId),
    title: r.title,
    sourceType: r.sourceType,
    fileName: r.fileName,
    mimeType: r.mimeType,
    status: r.status,
    chars: r.chars,
  };
}

// The row a projection is built from, with the row LOCKED and the body left in the database.
//
// `length(content)` rather than the column: an uploaded document holds up to 2,000,000 characters,
// and pulling that across the wire to count it would put multi-megabyte transfers and allocations
// inside a transaction that has five seconds to finish — for a number Postgres already knows.
// `compareText` is the same idea applied to the edit's own question: the caller has to send the new
// text anyway, so the comparison happens where the old text already is and what comes back is a
// boolean instead of the previous body.
async function readDocForAudit(
  db: ScopedDb,
  id: bigint,
  compareText: string | null,
): Promise<{ row: DocAuditRow; textMoved: boolean } | null> {
  const rows = await db.$queryRaw<
    {
      id: bigint;
      knowledge_base_id: bigint;
      title: string;
      source_type: string;
      file_name: string | null;
      mime_type: string | null;
      status: string;
      chars: number;
      text_moved: boolean;
    }[]
  >`
    SELECT id, knowledge_base_id, title, source_type, file_name, mime_type, status,
           length(content) AS chars,
           (content IS DISTINCT FROM ${compareText}::text) AS text_moved
      FROM knowledge_documents
     WHERE id = ${id}
       FOR UPDATE`;
  const r = rows[0];
  if (!r) return null;
  return {
    row: {
      id: r.id,
      knowledgeBaseId: r.knowledge_base_id,
      title: r.title,
      sourceType: r.source_type,
      fileName: r.file_name,
      mimeType: r.mime_type,
      status: r.status,
      chars: Number(r.chars),
    },
    textMoved: r.text_moved,
  };
}

// The whole write is held to what the columns can store, before anything is read or enqueued. It is
// not a hypothetical shape: `extractText` decodes an uploaded .txt with `TextDecoder("utf-8")`, so a
// file carrying a 0x00 byte hands a NUL straight to `content`, and Postgres refuses one in a `text`
// column (22021). Nothing caught it between the write and the transport, so an operator uploading a
// file got a 500 naming neither the file nor the reason (issue #247).
//
// REFUSED, not repaired, which is the opposite of what #218 and #243 do with the same characters.
// The rule is who can act on the answer: there the writer is a third party's webhook or an exception
// message and nobody reads a rejection, so repairing keeps the event. Here it is a person who chose
// this file, or a client calling an API that answers them, and silently deleting bytes out of a
// document an agent is about to answer from is worse than saying it cannot be stored.
export async function createDocument(
  params: CreateDocumentParams,
): Promise<{ id: bigint; status: string }> {
  const base = params.base ?? basePrisma;
  const { ctx, knowledgeBaseId } = params;
  const tenantId = ctx.tenantId as bigint;
  refuseUnstorable([
    ["title", params.title],
    ["text", params.text],
    ["fileName", params.fileName],
    ["mimeType", params.mimeType],
  ]);

  const doc = await runScopedOn(base, ctx, async (db) => {
    const kb = await db.knowledgeBase.findUnique({
      where: { id: knowledgeBaseId },
      select: { id: true },
    });
    if (!kb) throw new NotFoundError("knowledge base not found");
    const created = await db.knowledgeDocument.create({
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
    const audited = await readDocForAudit(db, created.id, null);
    if (audited) {
      await auditMutation(db, ctx, {
        action: "knowledge_document.create",
        target: `knowledge_document:${created.id}`,
        after: docAuditProjection(audited.row),
      });
    }
    return created;
  });

  await enqueueJob({
    tenantId,
    kind: "RAG_INGEST",
    dedupeKey: `doc:${doc.id}`,
    runAt: new Date(),
    // NOTE: A document that was just created: no row can exist under this key yet, so the answer is
    // only ever about the insert. It is still stated, because a field nobody has to answer is a
    // default.
    rearm: "new-work",
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
  ctx: TenantContext,
  knowledgeBaseId: bigint,
  base: PrismaClient = basePrisma,
): Promise<DocumentListRow[]> {
  return runScopedOn(base, ctx, async (db) => {
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
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
) {
  return runScopedOn(base, ctx, async (db) => {
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
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    // NOTE: Read with the row LOCKED before the delete, so the row describes the document actually
    // removed rather than a version an edit replaced in between.
    const existing = await readDocForAudit(db, id, null);
    const res = await db.knowledgeDocument.deleteMany({ where: { id } });
    if (res.count === 0) throw new NotFoundError("document not found");
    if (existing) {
      await auditMutation(db, ctx, {
        action: "knowledge_document.delete",
        target: `knowledge_document:${id}`,
        before: docAuditProjection(existing.row),
      });
    }
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
  ctx: TenantContext,
  id: bigint,
  params: UpdateDocumentParams,
  base: PrismaClient = basePrisma,
): Promise<{ id: bigint; status: string }> {
  const tenantId = ctx.tenantId as bigint;
  const hasTitle = params.title !== undefined;
  const hasText = params.text !== undefined;
  if (!hasTitle && !hasText) throw new AppError("nothing to update", 400);
  // Same rule as the create, and asked here too because an edit is a write of its own: the create's
  // check says nothing about the text an update carries.
  refuseUnstorable([
    ["title", params.title],
    ["text", params.text],
  ]);

  const { doc, reingest } = await runScopedOn(base, ctx, async (db) => {
    // NOTE: LOCKED, because this reading is both the reingest decision and the row's `before`, and
    // two overlapping edits would otherwise each compare against a text the other one replaced. The
    // comparison happens in the DATABASE, where the old text already is: what comes back is whether
    // it moved, not the previous body.
    const existing = await readDocForAudit(
      db,
      id,
      hasText ? (params.text as string) : null,
    );
    if (!existing) throw new NotFoundError("document not found");
    // `hasText` here rather than in the statement: a null comparand is DISTINCT FROM any content,
    // so the SQL answers `true` for a title-only edit. Asking it in the query would mean binding the
    // body a second time, which is the transfer this helper exists to avoid.
    const reingest = hasText && existing.textMoved;
    await db.knowledgeDocument.update({
      where: { id },
      data: {
        ...(hasTitle ? { title: params.title } : {}),
        ...(reingest
          ? { content: params.text, status: "PENDING", error: null }
          : {}),
      },
      select: { id: true },
    });
    const after = await readDocForAudit(db, id, null);
    if (!after) throw new NotFoundError("document not found");
    const updated = after.row;
    const beforeProj = docAuditProjection(existing.row);
    const afterProj = docAuditProjection(updated);
    // NOTE: The action this issue invents: `PATCH /v1/knowledge/documents/:id` has no MCP twin, so
    // an edit to a document reached the trail through nothing at all. Recorded only when it moved,
    // which for a body means its LENGTH moved or the title did: the text itself is neither carried
    // nor compared here (`reingest` above compares it, and that is the ingest's business).
    if (reingest || projectionMoved(beforeProj, afterProj)) {
      await auditMutation(db, ctx, {
        action: "knowledge_document.update",
        target: `knowledge_document:${id}`,
        before: beforeProj,
        after: { ...afterProj, reindexed: reingest },
      });
    }
    return { doc: updated, reingest };
  });

  if (reingest) {
    await enqueueJob({
      tenantId,
      kind: "RAG_INGEST",
      dedupeKey: `doc:${id}`,
      runAt: new Date(),
      // NOTE: The document's CONTENT changed, so this is a different index of a different text. The
      // key is the document and lives as long as it does, so without the reset an ingest that
      // failed once would follow the document through every edit it ever gets.
      rearm: "new-work",
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

// FAILED = errored ingestion (retry); UNINDEXED = imported-but-never-indexed (first index). Both
// re-run through the same PENDING → ingest path; anything else is already on it or already done.
//
// Split out so the MCP preview can ask the same question the apply asks (#490). Its row passes a
// document id that names no row, so it proved the ownership check and never this — and the preview
// was already READING the status, to report it in a note saying "Re-queues a FAILED document",
// while answering ok for a document that is not one (#510).
export function assertDocumentRetryable(status: string): void {
  if (status !== "FAILED" && status !== "UNINDEXED") {
    throw new AppError(
      "only FAILED or UNINDEXED documents can be re-indexed",
      409,
    );
  }
}

export async function retryDocument(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenantId = ctx.tenantId as bigint;
  const doc = await runScopedOn(base, ctx, async (db) => {
    // NOTE: LOCKED, because the status read here is the row's `before` and the 409 above it. Without
    // it a concurrent ingest can move the document between the reading and the write, and the row
    // would name a state this retry did not leave.
    await db.$queryRaw`SELECT id FROM knowledge_documents WHERE id = ${id} FOR UPDATE`;
    const existing = await db.knowledgeDocument.findUnique({
      where: { id },
      select: { id: true, status: true, knowledgeBaseId: true },
    });
    if (!existing) throw new NotFoundError("document not found");
    assertDocumentRetryable(existing.status);
    const { count } = await db.knowledgeDocument.updateMany({
      where: { id, status: { in: ["FAILED", "UNINDEXED"] } },
      data: { status: "PENDING", error: null },
    });
    // NOTE: The condition IS the test: two operators pressing the button on the same failed document
    // would otherwise both record a retry only one of them started.
    if (count > 0) {
      await auditMutation(db, ctx, {
        action: "knowledge_document.retry",
        target: `knowledge_document:${id}`,
        before: { id: String(id), status: existing.status },
        after: { id: String(id), status: "PENDING" },
      });
    }
    return existing;
  });

  await enqueueJob({
    tenantId,
    kind: "RAG_INGEST",
    dedupeKey: `doc:${id}`,
    runAt: new Date(),
    // NOTE: An operator asked for this, on a document sitting in FAILED or UNINDEXED. FAILED is
    // reached by exhausting the budget, so without the reset the retry button is worth exactly one
    // attempt, and every press after the first fails straight back to DEAD.
    rearm: "new-work",
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
  reason: EmbeddingBlockReason;
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
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<EmbeddingBlock | null> {
  const tenantId = ctx.tenantId as bigint;
  const status = await runScopedOn(base, ctx, (db) =>
    resolveEmbeddingStatus(db, tenantId, ""),
  );
  return status.ok ? null : embeddingBlock(status);
}

// Queues ingestion for every UNINDEXED document in a knowledge base — the bulk "index all" after an
// agent import that bundled the source text. Pass `includeFailed` to also re-queue FAILED docs (bulk
// recovery of genuine ingestion errors — the same PENDING → ingest path as the per-document retry). If
// the embedding prerequisite is missing, nothing is queued and `blocked` explains why (docs stay put).
export async function reindexKnowledgeBase(
  ctx: TenantContext,
  knowledgeBaseId: bigint,
  base: PrismaClient = basePrisma,
  opts: { includeFailed?: boolean; dryRun?: boolean } = {},
): Promise<ReindexResult> {
  const tenantId = ctx.tenantId as bigint;
  const statuses = opts.includeFailed ? ["UNINDEXED", "FAILED"] : ["UNINDEXED"];
  const outcome = await runScopedOn(base, ctx, async (db) => {
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
    // NOTE: WHICH documents the write moved, not which ones the listing above found. Two operators
    // pressing reindex on the same base both read the same `targets`, and the second one moves none
    // of them: it must neither record a queue it did not fill NOR re-arm the jobs below, which is
    // why the ids come back from the UPDATE itself rather than from the snapshot.
    //
    const moved = await db.$queryRaw<{ id: bigint }[]>`
      UPDATE knowledge_documents
         SET status = 'PENDING', error = NULL, updated_at = now()
       WHERE tenant_id = ${tenantId}
         AND knowledge_base_id = ${knowledgeBaseId}
         AND status IN (${Prisma.join(statuses.map((v) => Prisma.sql`${v}`))})
      RETURNING id`;
    // NOTE: The jobs IN THE SAME TRANSACTION as the transition they answer for. Enqueuing after the
    // commit is what the single-document paths do, and in a loop of N it is the shape that leaves
    // documents sitting in PENDING with no job: they are no longer UNINDEXED, so the next bulk
    // reindex does not select them either, and only a per-document retry gets them back. Committing
    // the status, the jobs and the row together makes the count in that row true by construction.
    await upsertJobRows(db, {
      tenantId,
      kind: "RAG_INGEST",
      runAt: new Date(),
      // NOTE: Same as the single-document retry, in bulk: an operator asked for the whole base to
      // be indexed again, and a document that failed on a previous embedding provider is exactly
      // the one this is for.
      rearm: "new-work",
      rows: moved.map((d) => ({
        dedupeKey: `doc:${d.id}`,
        payload: { documentId: String(d.id) },
      })),
    });
    if (moved.length > 0) {
      await auditMutation(db, ctx, {
        action: "knowledge.reindex",
        target: `knowledge_base:${knowledgeBaseId}`,
        after: {
          queued: moved.length,
          includeFailed: opts.includeFailed === true,
        },
      });
    }
    return { docs: moved, blocked: undefined };
  });

  if (outcome.blocked) {
    return { queued: 0, blocked: embeddingBlock(outcome.blocked) };
  }
  // dry-run: report how many WOULD be queued, without enqueuing.
  if (opts.dryRun) return { queued: outcome.docs.length };

  for (const d of outcome.docs) {
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
    // the reason (e.g. embedding credential missing); otherwise the message itself (diagnostic).
    //
    // `sanitizeErrorMessage` rather than a cut: the diagnostic branch carries what the embedding
    // provider answered, and `error` is a `text` column that refuses a NUL outright. It also bounds
    // the non-Error branch, which `String(err)` left unbounded (issue #243).
    const message =
      err instanceof AppError && err.translationKey
        ? err.translationKey
        : sanitizeErrorMessage(err, 500);
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
      // NOTE: TERMINAL, which is not obvious from here — the row is now FAILED, the re-armed job re-reads
      // it, finds it is no longer PENDING and returns `done`, so this document is never indexed
      // again without somebody asking. The broadcast above reaches a console that is OPEN right now
      // and nothing else; the trail is what is left for the operator who was not watching, and the
      // only thing an alert channel can subscribe to (issue #356).
      //
      // `warn`, and it is the one site of the four that is: the document list shows FAILED with the
      // stored reason and offers a re-index, so the operator has their own way back to it. The
      // others lost work with no surface at all.
      emitDeadLetter({
        tenantId,
        unit: "knowledge_document",
        level: "warn",
        // NOTE: either the i18n key of a known AppError or the sanitized provider text, whichever
        // the row itself stores — the two say different things to a reader and the line must not
        // diverge from the column beside it.
        error: message,
        detail: {
          documentId: String(documentId),
          knowledgeBaseId: String(doc.knowledgeBaseId),
        },
        base,
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
