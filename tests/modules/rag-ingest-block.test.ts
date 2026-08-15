import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  type ServerEvent,
  setPublisher,
} from "@/api/features/realtime/realtime.service";
import { encryptJson } from "@/api/lib/crypto";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  createDocument,
  registerRagIngestHandler,
} from "@/modules/rag/documents";
import { getJobHandler } from "@/modules/scheduler/worker";
import { updateEmbeddingSettings } from "@/modules/tenant-settings/service";
import {
  createPendingVaultEntry,
  createVaultEntry,
} from "@/modules/vault/service";

// Issue #80: a document uploaded before the embedding credential exists lands UNINDEXED with the
// reason DISCARDED (`error: null`), so "I still have to click index" and "this will never index
// until someone fills a credential" render identically. The job knows which of the three it is —
// it branches on `resolveEmbeddingStatus` and then throws the answer away.
//
// Reverting PENDING → UNINDEXED instead of failing the document is deliberate and stays: a missing
// prerequisite is not a document failure. What these tests pin is that the REASON survives, both on
// the row the console reads and on the realtime event it re-renders from.

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

// One tenant per embedding state: the block is resolved from tenant-level settings, so sharing a
// tenant between cases would make each test depend on the previous one's credential.
const tenants: bigint[] = [];

async function seedTenant(slug: string): Promise<{ id: bigint; kb: bigint }> {
  const t = await suDb.tenant.create({
    data: { name: slug, slug: `${slug}-${process.pid}` },
  });
  tenants.push(t.id);
  const kb = await suDb.knowledgeBase.create({
    data: {
      tenantId: t.id,
      name: `${slug}-kb`,
      embeddingModel: "text-embedding-3-small",
    },
  });
  return { id: t.id, kb: kb.id };
}

// Runs the REAL job handler, the same entry point the scheduler uses. The block path returns before
// any embedding call, so it needs no provider — which is exactly why it is testable here even though
// the rest of the ingest job is not.
async function runIngest(tenantId: bigint, documentId: bigint) {
  registerRagIngestHandler();
  const handler = getJobHandler("RAG_INGEST");
  if (!handler) throw new Error("RAG_INGEST handler not registered");
  return handler(
    {
      id: 0n,
      tenantId,
      kind: "RAG_INGEST",
      payload: { documentId: String(documentId) },
      attempts: 0,
    },
    appDb,
  );
}

async function readDoc(tenantId: bigint, documentId: bigint) {
  return runScopedOn(appDb, ctx(tenantId), (db) =>
    db.knowledgeDocument.findUnique({
      where: { id: documentId },
      select: { status: true, error: true, chunkCount: true },
    }),
  );
}

describe.skipIf(!dbUp)(
  "rag ingest: the embedding block keeps its reason",
  () => {
    afterAll(async () => {
      setPublisher(() => undefined);
      for (const t of tenants) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM knowledge_chunks WHERE tenant_id = ${t}`,
        );
        await suDb.$executeRawUnsafe(
          `DELETE FROM knowledge_documents WHERE tenant_id = ${t}`,
        );
        await suDb.$executeRawUnsafe(
          `DELETE FROM knowledge_bases WHERE tenant_id = ${t}`,
        );
        await suDb.$executeRawUnsafe(
          `DELETE FROM vault_entries WHERE tenant_id = ${t}`,
        );
        await suDb.$executeRawUnsafe(
          `DELETE FROM scheduler_jobs WHERE tenant_id = ${t}`,
        );
        await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${t}`);
      }
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("no embedding credential at all: the document says so", async () => {
      const { id, kb } = await seedTenant("blk-none");
      const doc = await createDocument({
        tenantId: id,
        knowledgeBaseId: kb,
        title: "T",
        text: "conteudo",
        sourceType: "text",
        base: appDb,
      });
      await runIngest(id, doc.id);
      const row = await readDoc(id, doc.id);
      expect(row?.status).toBe("UNINDEXED");
      expect(row?.chunkCount).toBe(0);
      expect(row?.error).toBe("errors.embeddingNotConfigured");
    });

    // The distinction that matters most to the operator: a ref EXISTS, so "not configured" would send
    // them to create a credential they already created. What they have to do is fill it.
    test("the credential exists but was never filled: a distinct reason", async () => {
      const { id, kb } = await seedTenant("blk-pend");
      const entry = await createPendingVaultEntry(
        ctx(id),
        { name: "embed-ref", kind: "generic" },
        appDb,
      );
      await updateEmbeddingSettings(
        ctx(id),
        { credentialRef: entry.ref },
        appDb,
      );
      const doc = await createDocument({
        tenantId: id,
        knowledgeBaseId: kb,
        title: "T",
        text: "conteudo",
        sourceType: "text",
        base: appDb,
      });
      await runIngest(id, doc.id);
      const row = await readDoc(id, doc.id);
      expect(row?.status).toBe("UNINDEXED");
      expect(row?.error).toBe("errors.embeddingPending");
    });

    // Seeded by a direct write on purpose: `createVaultEntry` refuses an empty secret in every shape
    // (`errors.emptyVaultSecret` for a bare string, `errors.invalidVaultValue` for an object with a
    // blank field), so today this state can only come from a row written before that validation
    // existed. The branch is in `resolveEmbeddingStatus` regardless, and a reason it resolves must not
    // be the one it flattens to.
    test("the credential resolved to a blank secret: its own reason", async () => {
      const { id, kb } = await seedTenant("blk-empty");
      const blank = await suDb.vaultEntry.create({
        data: {
          tenantId: id,
          name: "embed-blank",
          kind: "generic",
          status: "active",
          secret: encryptJson({ apiKey: "" }),
        },
      });
      const entry = { ref: `vault:${blank.id}` };
      await updateEmbeddingSettings(
        ctx(id),
        { credentialRef: entry.ref },
        appDb,
      );
      const doc = await createDocument({
        tenantId: id,
        knowledgeBaseId: kb,
        title: "T",
        text: "conteudo",
        sourceType: "text",
        base: appDb,
      });
      await runIngest(id, doc.id);
      const row = await readDoc(id, doc.id);
      expect(row?.status).toBe("UNINDEXED");
      expect(row?.error).toBe("errors.embeddingEmpty");
    });

    // The console re-renders the row from this event without re-fetching, so a reason that reaches the
    // column but not the event leaves the open screen showing the old, mute badge until a reload.
    test("the realtime event carries the reason too", async () => {
      const { id, kb } = await seedTenant("blk-evt");
      const seen: ServerEvent[] = [];
      setPublisher((_topic, data) => {
        seen.push(JSON.parse(data) as ServerEvent);
      });
      try {
        const doc = await createDocument({
          tenantId: id,
          knowledgeBaseId: kb,
          title: "T",
          text: "conteudo",
          sourceType: "text",
          base: appDb,
        });
        await runIngest(id, doc.id);
        const blocked = seen.find(
          (e) =>
            e.type === "knowledge-document" &&
            (e as { status?: string }).status === "UNINDEXED",
        );
        expect(blocked).toBeDefined();
        expect((blocked as { error?: string }).error).toBe(
          "errors.embeddingNotConfigured",
        );
      } finally {
        setPublisher(() => undefined);
      }
    });

    // A reason that outlives the block would be worse than no reason: the operator fills the
    // credential, re-indexes, and the row still explains why it could not be indexed.
    test("a later re-index clears the reason", async () => {
      const { id, kb } = await seedTenant("blk-clear");
      const doc = await createDocument({
        tenantId: id,
        knowledgeBaseId: kb,
        title: "T",
        text: "conteudo",
        sourceType: "text",
        base: appDb,
      });
      await runIngest(id, doc.id);
      expect((await readDoc(id, doc.id))?.error).toBe(
        "errors.embeddingNotConfigured",
      );
      const entry = await createVaultEntry(
        ctx(id),
        "embed-real",
        "sk-test-key",
        "generic",
        appDb,
      );
      await updateEmbeddingSettings(
        ctx(id),
        { credentialRef: entry.ref },
        appDb,
      );
      const { reindexKnowledgeBase } = await import("@/modules/rag/documents");
      await reindexKnowledgeBase(id, kb, appDb);
      const row = await readDoc(id, doc.id);
      expect(row?.status).toBe("PENDING");
      expect(row?.error).toBeNull();
    });
  },
);
