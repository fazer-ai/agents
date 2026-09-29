import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { EMBEDDING_DIM } from "@/modules/rag/embeddings";
import { insertChunks, searchChunks } from "@/modules/rag/sql";

// Validates the raw pgvector SQL against the real DB: vector literal binding, KNN <=> ordering,
// ef_search, ANY(ARRAY[...]::bigint[]), and the RLS fence on raw SQL.

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

// A unit vector pointing at one dimension — cosine distance is 0 to itself, 1 to an orthogonal one.
function unit(dim: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[dim] = 1;
  return v;
}

let t1 = 0n;
let t2 = 0n;
let kb1 = 0n;
let doc1 = 0n;

describe.skipIf(!dbUp)("rag sql (pgvector)", () => {
  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "R1", slug: `r1-${process.pid}` },
    });
    const b = await suDb.tenant.create({
      data: { name: "R2", slug: `r2-${process.pid}` },
    });
    t1 = a.id;
    t2 = b.id;
    const kb = await suDb.knowledgeBase.create({
      data: {
        tenantId: t1,
        name: "KB",
        embeddingModel: "text-embedding-3-small",
      },
    });
    kb1 = kb.id;
    // knowledge_chunks requires a document_id FK after the knowledge_documents migration.
    const doc = await suDb.knowledgeDocument.create({
      data: {
        tenantId: t1,
        knowledgeBaseId: kb1,
        title: "Test document",
        sourceType: "text",
        content: "test content",
        status: "READY",
      },
    });
    doc1 = doc.id;
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

  test("insert + KNN returns the nearest chunk first", async () => {
    await runScopedOn(appDb, ctx(t1), (db) =>
      insertChunks(db, [
        {
          tenantId: t1,
          knowledgeBaseId: kb1,
          documentId: doc1,
          content: "A",
          embedding: unit(0),
        },
        {
          tenantId: t1,
          knowledgeBaseId: kb1,
          documentId: doc1,
          content: "B",
          embedding: unit(1),
        },
        {
          tenantId: t1,
          knowledgeBaseId: kb1,
          documentId: doc1,
          content: "C",
          embedding: unit(2),
        },
      ]),
    );

    const hits = await runScopedOn(appDb, ctx(t1), (db) =>
      searchChunks(db, {
        knowledgeBaseIds: [kb1],
        queryEmbedding: unit(0),
        limit: 3,
      }),
    );
    expect(hits.length).toBe(3);
    expect(hits[0]?.content).toBe("A");
    expect(Number(hits[0]?.distance)).toBeCloseTo(0, 5);
  });

  test("RLS fences raw SQL: another tenant sees no chunks even with the kb id", async () => {
    const hits = await runScopedOn(appDb, ctx(t2), (db) =>
      searchChunks(db, {
        knowledgeBaseIds: [kb1],
        queryEmbedding: unit(0),
        limit: 3,
      }),
    );
    expect(hits).toEqual([]);
  });

  test("rejects a wrong-dimension embedding (fails loud)", async () => {
    await expect(
      runScopedOn(appDb, ctx(t1), (db) =>
        insertChunks(db, [
          {
            tenantId: t1,
            knowledgeBaseId: kb1,
            documentId: doc1,
            content: "bad",
            embedding: [1, 2, 3],
          },
        ]),
      ),
    ).rejects.toThrow(/dimension/);
  });
});
