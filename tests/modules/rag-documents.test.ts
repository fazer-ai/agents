import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  reindexKnowledgeBase,
  retryDocument,
} from "@/modules/rag/documents";
import { updateEmbeddingSettings } from "@/modules/tenant-settings/service";
import { createVaultEntry } from "@/modules/vault/service";

// The context these calls take: the tenant id came from a row this test created, so it carries
// TENANT_ADMIN — the role that tells `runScopedOn` the id never came from outside (issue #280).
const ctxOf = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// Integration tests for the KnowledgeDocument CRUD layer. Skipped when the DB is unavailable.
// These tests do NOT exercise the RAG_INGEST job handler (that requires a real embedding
// credential); they validate the document lifecycle (create, list, get, delete, retry).

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

function ctx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

let t1 = 0n;
let t2 = 0n;
let kb1 = 0n;

describe.skipIf(!dbUp)("rag documents", () => {
  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "D1", slug: `d1-${process.pid}` },
    });
    const b = await suDb.tenant.create({
      data: { name: "D2", slug: `d2-${process.pid}` },
    });
    t1 = a.id;
    t2 = b.id;
    const kb = await suDb.knowledgeBase.create({
      data: {
        tenantId: t1,
        name: "DocKB",
        embeddingModel: "text-embedding-3-small",
      },
    });
    kb1 = kb.id;
    // Configure a usable embedding credential for t1 so reindex isn't blocked by the prerequisite
    // check. The secret is never used here (these tests don't run the real embed API); it only needs
    // to resolve non-empty.
    const embed = await createVaultEntry(
      ctx(t1),
      "test-embed",
      "sk-test-key",
      "generic",
      appDb,
    );
    await updateEmbeddingSettings(ctx(t1), { credentialRef: embed.ref }, appDb);
  });

  afterAll(async () => {
    for (const t of [t1, t2]) {
      if (!t) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM knowledge_chunks WHERE tenant_id = ${t}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM knowledge_documents WHERE tenant_id = ${t}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM knowledge_bases WHERE tenant_id = ${t}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${t}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("createDocument creates a PENDING document and enqueues RAG_INGEST", async () => {
    const result = await createDocument({
      ctx: ctxOf(t1),
      knowledgeBaseId: kb1,
      title: "Test Doc",
      text: "Hello world",
      sourceType: "text",
      base: appDb,
    });

    expect(result.status).toBe("PENDING");
    expect(result.id).toBeGreaterThan(0n);

    // Verify it exists in the DB.
    const doc = await runScopedOn(appDb, ctx(t1), (db) =>
      db.knowledgeDocument.findUnique({
        where: { id: result.id },
        select: { id: true, status: true, title: true, content: true },
      }),
    );
    expect(doc).not.toBeNull();
    expect(doc?.title).toBe("Test Doc");
    expect(doc?.content).toBe("Hello world");
    expect(doc?.status).toBe("PENDING");

    // Verify a RAG_INGEST job was enqueued.
    const job = await suDb.schedulerJob.findFirst({
      where: {
        tenantId: t1,
        kind: "RAG_INGEST",
        dedupeKey: `doc:${result.id}`,
      },
    });
    expect(job).not.toBeNull();
    expect(job?.status).toBe("PENDING");
  });

  test("listDocuments returns documents for the KB with contentChars", async () => {
    const doc = await createDocument({
      ctx: ctxOf(t1),
      knowledgeBaseId: kb1,
      title: "List Test",
      text: "Content",
      sourceType: "text",
      base: appDb,
    });

    const docs = await listDocuments(ctxOf(t1), kb1, appDb);
    const found = docs.find((d) => d.id === doc.id);
    expect(found).toBeDefined();
    expect(found?.title).toBe("List Test");
    expect(found?.status).toBe("PENDING");
    // contentChars must be the character count of "Content" (7) without loading the full column.
    expect(Number(found?.contentChars)).toBe(7);
  });

  test("getDocument returns the document with content", async () => {
    const created = await createDocument({
      ctx: ctxOf(t1),
      knowledgeBaseId: kb1,
      title: "Get Test",
      text: "Get content here",
      sourceType: "text",
      base: appDb,
    });

    const doc = await getDocument(ctxOf(t1), created.id, appDb);
    expect(doc.id).toBe(created.id);
    expect(doc.content).toBe("Get content here");
    expect(doc.knowledgeBaseId).toBe(kb1);
  });

  test("getDocument throws NotFoundError for unknown id", async () => {
    await expect(getDocument(ctxOf(t1), 999999999n, appDb)).rejects.toThrow(
      "document not found",
    );
  });

  test("deleteDocument removes the document", async () => {
    const created = await createDocument({
      ctx: ctxOf(t1),
      knowledgeBaseId: kb1,
      title: "Delete Test",
      text: "To be deleted",
      sourceType: "text",
      base: appDb,
    });

    await deleteDocument(ctxOf(t1), created.id, appDb);

    await expect(getDocument(ctxOf(t1), created.id, appDb)).rejects.toThrow(
      "document not found",
    );
  });

  test("deleteDocument throws NotFoundError for unknown id", async () => {
    await expect(deleteDocument(ctxOf(t1), 999999999n, appDb)).rejects.toThrow(
      "document not found",
    );
  });

  test("retryDocument re-queues a FAILED document", async () => {
    const created = await createDocument({
      ctx: ctxOf(t1),
      knowledgeBaseId: kb1,
      title: "Retry Test",
      text: "Will fail",
      sourceType: "text",
      base: appDb,
    });

    // Manually mark as FAILED.
    await runScopedOn(appDb, ctx(t1), (db) =>
      db.knowledgeDocument.updateMany({
        where: { id: created.id },
        data: { status: "FAILED", error: "test error" },
      }),
    );

    await retryDocument(ctxOf(t1), created.id, appDb);

    const doc = await getDocument(ctxOf(t1), created.id, appDb);
    expect(doc.status).toBe("PENDING");
    expect(doc.error).toBeNull();
  });

  // Issue #339. A document's ingest job is keyed `doc:<id>`, so one row serves the document for as
  // long as it exists. FAILED is reached by EXHAUSTING the budget, which is precisely the state the
  // retry button is for: without a fresh budget the retry is worth one attempt, and every press
  // after the first dead-letters again on the first blip.
  test("retryDocument gives the ingest its whole budget back", async () => {
    const created = await createDocument({
      ctx: ctxOf(t1),
      knowledgeBaseId: kb1,
      title: "Retry Budget Test",
      text: "Failed five times",
      sourceType: "text",
      base: appDb,
    });
    await suDb.schedulerJob.updateMany({
      where: { kind: "RAG_INGEST", dedupeKey: `doc:${created.id}` },
      data: { status: "DEAD", attempts: 5 },
    });
    await runScopedOn(appDb, ctx(t1), (db) =>
      db.knowledgeDocument.updateMany({
        where: { id: created.id },
        data: { status: "FAILED", error: "embeddings unavailable" },
      }),
    );

    await retryDocument(ctxOf(t1), created.id, appDb);

    const job = await suDb.schedulerJob.findFirstOrThrow({
      where: { kind: "RAG_INGEST", dedupeKey: `doc:${created.id}` },
      select: { status: true, attempts: true },
    });
    expect(job.status).toBe("PENDING");
    expect(job.attempts).toBe(0);
  });

  test("retryDocument re-queues an UNINDEXED document", async () => {
    const created = await createDocument({
      ctx: ctxOf(t1),
      knowledgeBaseId: kb1,
      title: "Unindexed Retry Test",
      text: "Imported, not indexed",
      sourceType: "text",
      base: appDb,
    });

    // Imported agents land their documents as UNINDEXED (no auto-ingest); a manual re-index
    // re-runs them through the same PENDING path as a FAILED retry.
    await runScopedOn(appDb, ctx(t1), (db) =>
      db.knowledgeDocument.updateMany({
        where: { id: created.id },
        data: { status: "UNINDEXED" },
      }),
    );

    await retryDocument(ctxOf(t1), created.id, appDb);

    const doc = await getDocument(ctxOf(t1), created.id, appDb);
    expect(doc.status).toBe("PENDING");
  });

  test("retryDocument throws for a non-FAILED, non-UNINDEXED document", async () => {
    const created = await createDocument({
      ctx: ctxOf(t1),
      knowledgeBaseId: kb1,
      title: "Retry Guard Test",
      text: "Still pending",
      sourceType: "text",
      base: appDb,
    });

    // Document is PENDING (neither FAILED nor UNINDEXED) — re-index should reject.
    await expect(retryDocument(ctxOf(t1), created.id, appDb)).rejects.toThrow(
      "only FAILED or UNINDEXED documents can be re-indexed",
    );
  });

  test("reindexKnowledgeBase queues every UNINDEXED document", async () => {
    // Fresh base so only these two documents are UNINDEXED in it.
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId: t1, name: `ReindexKB-${process.pid}` },
      select: { id: true },
    });
    const d1 = await suDb.knowledgeDocument.create({
      data: {
        tenantId: t1,
        knowledgeBaseId: kb.id,
        title: "A",
        sourceType: "text",
        content: "a",
        status: "UNINDEXED",
      },
      select: { id: true },
    });
    const d2 = await suDb.knowledgeDocument.create({
      data: {
        tenantId: t1,
        knowledgeBaseId: kb.id,
        title: "B",
        sourceType: "text",
        content: "b",
        status: "UNINDEXED",
      },
      select: { id: true },
    });

    const result = await reindexKnowledgeBase(ctxOf(t1), kb.id, appDb);
    expect(result.queued).toBe(2);

    const docs = await suDb.knowledgeDocument.findMany({
      where: { knowledgeBaseId: kb.id },
      select: { status: true },
    });
    expect(docs.every((doc) => doc.status === "PENDING")).toBe(true);

    const jobs = await suDb.schedulerJob.count({
      where: {
        tenantId: t1,
        kind: "RAG_INGEST",
        dedupeKey: { in: [`doc:${d1.id}`, `doc:${d2.id}`] },
      },
    });
    expect(jobs).toBe(2);
  });

  test("reindexKnowledgeBase blocks (queues nothing) when embedding is not configured", async () => {
    // t2 has no embedding credential configured — the prerequisite is missing.
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId: t2, name: `NoEmbedKB-${process.pid}` },
      select: { id: true },
    });
    await suDb.knowledgeDocument.create({
      data: {
        tenantId: t2,
        knowledgeBaseId: kb.id,
        title: "X",
        sourceType: "text",
        content: "x",
        status: "UNINDEXED",
      },
    });
    const result = await reindexKnowledgeBase(ctxOf(t2), kb.id, appDb);
    expect(result.queued).toBe(0);
    expect(result.blocked?.reason).toBe("embedding_not_configured");
    // The doc must stay UNINDEXED — a missing prerequisite is not a document failure.
    const docs = await suDb.knowledgeDocument.findMany({
      where: { knowledgeBaseId: kb.id },
      select: { status: true },
    });
    expect(docs.every((d) => d.status === "UNINDEXED")).toBe(true);
  });

  test("reindexKnowledgeBase recovers FAILED docs only with includeFailed", async () => {
    const kb = await suDb.knowledgeBase.create({
      data: {
        tenantId: t1,
        name: `FailedKB-${process.pid}`,
        embeddingModel: "text-embedding-3-small",
      },
      select: { id: true },
    });
    const failed = await suDb.knowledgeDocument.create({
      data: {
        tenantId: t1,
        knowledgeBaseId: kb.id,
        title: "F",
        sourceType: "text",
        content: "f",
        status: "FAILED",
        error: "old error",
      },
      select: { id: true },
    });
    // The default sweep skips FAILED docs (they keep their own retry path).
    const skip = await reindexKnowledgeBase(ctxOf(t1), kb.id, appDb);
    expect(skip.queued).toBe(0);
    // include_failed re-queues them in one call, clearing the error.
    const recover = await reindexKnowledgeBase(ctxOf(t1), kb.id, appDb, {
      includeFailed: true,
    });
    expect(recover.queued).toBe(1);
    const doc = await suDb.knowledgeDocument.findUnique({
      where: { id: failed.id },
      select: { status: true, error: true },
    });
    expect(doc?.status).toBe("PENDING");
    expect(doc?.error).toBeNull();
  });

  test("RLS fences: tenant 2 cannot see tenant 1 documents", async () => {
    const created = await createDocument({
      ctx: ctxOf(t1),
      knowledgeBaseId: kb1,
      title: "RLS Test",
      text: "Cross-tenant attempt",
      sourceType: "text",
      base: appDb,
    });

    // t2 should not find t1's document.
    await expect(getDocument(ctxOf(t2), created.id, appDb)).rejects.toThrow(
      "document not found",
    );
  });

  test("listDocuments throws NotFoundError for unknown KB", async () => {
    await expect(listDocuments(ctxOf(t1), 999999999n, appDb)).rejects.toThrow(
      "knowledge base not found",
    );
  });
});
