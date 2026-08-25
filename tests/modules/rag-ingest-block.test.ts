import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  createDocument,
  readEmbeddingBlock,
  registerRagIngestHandler,
  resolveEmbeddingConfig,
} from "@/modules/rag/documents";
import { getJobHandler } from "@/modules/scheduler/worker";
import { updateEmbeddingSettings } from "@/modules/tenant-settings/service";
import {
  createPendingVaultEntry,
  createVaultEntry,
} from "@/modules/vault/service";

// The context these calls take: the tenant id came from a row this test created, so it carries
// TENANT_ADMIN — the role that tells `runScopedOn` the id never came from outside (issue #280).
const ctxOf = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// Issue #80: a document uploaded before the embedding credential exists lands UNINDEXED, and the
// console showed the same neutral badge whether it was waiting for a click or would never index
// until a credential was sorted out. The job knows which of the three reasons applies.
//
// The reason is NOT stamped on the document. One embedding credential serves the whole workspace, so
// the block belongs to the configuration, not to the row: a token written when the block happened
// would still be telling the operator to fill a credential they have since filled, with nothing to
// recompute it. `readEmbeddingBlock` answers the same question at the moment the console asks.

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

// One tenant per embedding state: the block is resolved from workspace-level settings, so sharing a
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
// any embedding call, so it needs no provider — which is why it is testable here even though the
// rest of the ingest job is not.
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
      claimSeq: 0,
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

async function seedDoc(tenantId: bigint, kb: bigint) {
  return createDocument({
    ctx: ctxOf(tenantId),
    knowledgeBaseId: kb,
    title: "T",
    text: "conteudo",
    sourceType: "text",
    base: appDb,
  });
}

describe.skipIf(!dbUp)(
  "rag: the embedding block is read, not remembered",
  () => {
    afterAll(async () => {
      for (const t of tenants) {
        for (const table of [
          "knowledge_chunks",
          "knowledge_documents",
          "knowledge_bases",
          "vault_entries",
          "scheduler_jobs",
        ]) {
          await suDb.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${t}`,
          );
        }
        await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${t}`);
      }
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    // Reverting PENDING → UNINDEXED instead of failing the document is deliberate and stays: a missing
    // prerequisite is not a document failure, and the row carries no reason of its own.
    test("a blocked ingest leaves the document unindexed with no error of its own", async () => {
      const { id, kb } = await seedTenant("blk-none");
      const doc = await seedDoc(id, kb);
      await runIngest(id, doc.id);
      const row = await readDoc(id, doc.id);
      expect(row?.status).toBe("UNINDEXED");
      expect(row?.chunkCount).toBe(0);
      expect(row?.error).toBeNull();
    });

    test("no credential at all reads as not configured", async () => {
      const { id } = await seedTenant("blk-unset");
      expect(await readEmbeddingBlock(ctxOf(id), appDb)).toEqual({
        reason: "embedding_not_configured",
      });
    });

    // The distinction that matters most: a ref EXISTS, so "not configured" would send the operator to
    // create a credential they already created. What they have to do is fill it — and the vault id
    // rides along so the console can deeplink straight at it.
    test("a credential that was never filled reads as pending, with its ref", async () => {
      const { id } = await seedTenant("blk-pend");
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
      const block = await readEmbeddingBlock(ctxOf(id), appDb);
      expect(block?.reason).toBe("credential_pending");
      expect(block?.credentialRef).toBe(entry.ref);
      expect(block?.vaultId).toBe(entry.ref.slice("vault:".length));
    });

    // Review finding, round 2: an ACTIVE row whose secret is a blank string also fails to resolve.
    // Answering that with a second "does the row exist" query called it not_found, which is the one
    // thing it is not — state and value now come from the same read.
    test("an active credential holding a blank secret reads as empty", async () => {
      const { id } = await seedTenant("blk-blank");
      const row = await suDb.vaultEntry.create({
        data: {
          tenantId: id,
          name: "embed-blank",
          kind: "generic",
          status: "active",
          secret: encryptJson(""),
        },
      });
      await updateEmbeddingSettings(
        ctx(id),
        { credentialRef: `vault:${row.id}` },
        appDb,
      );
      expect((await readEmbeddingBlock(ctxOf(id), appDb))?.reason).toBe(
        "credential_empty",
      );
    });

    // Review finding, round 2: `tryResolveVaultSecret` answers null for a DELETED entry exactly as it
    // does for an unfilled one, so a dangling ref used to be reported as "pending" — telling the
    // operator to fill a credential that is not there.
    test("a ref whose credential was deleted is not reported as pending", async () => {
      const { id } = await seedTenant("blk-gone");
      const entry = await createPendingVaultEntry(
        ctx(id),
        { name: "embed-doomed", kind: "generic" },
        appDb,
      );
      await updateEmbeddingSettings(
        ctx(id),
        { credentialRef: entry.ref },
        appDb,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${id}`,
      );
      expect((await readEmbeddingBlock(ctxOf(id), appDb))?.reason).toBe(
        "embedding_not_configured",
      );
    });

    // Review finding, round 3, and the reason the reason is not stored: after the operator fixes the
    // credential the documents are still UNINDEXED (nothing re-indexes them on its own), so a
    // remembered token would go on explaining a block that no longer exists.
    test("filling the credential clears the block, with the documents untouched", async () => {
      const { id, kb } = await seedTenant("blk-fixed");
      const doc = await seedDoc(id, kb);
      await runIngest(id, doc.id);
      expect((await readEmbeddingBlock(ctxOf(id), appDb))?.reason).toBe(
        "embedding_not_configured",
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
      expect(await readEmbeddingBlock(ctxOf(id), appDb)).toBeNull();
      // The document did not move — it is still waiting for someone to index it, which is exactly the
      // state the badge must now describe instead of "blocked".
      expect((await readDoc(id, doc.id))?.status).toBe("UNINDEXED");
    });

    // Review finding, round 4: this shape also rides on the documents list, which any authenticated
    // role can read, while the reindex endpoint that needs the deeplink is TENANT_ADMIN. The ref is
    // still resolved here — the controller is what drops it — so the split has to stay visible.
    test("the block carries the vault ref for the admin path that needs it", async () => {
      const { id } = await seedTenant("blk-ref");
      const entry = await createPendingVaultEntry(
        ctx(id),
        { name: "embed-ref2", kind: "generic" },
        appDb,
      );
      await updateEmbeddingSettings(
        ctx(id),
        { credentialRef: entry.ref },
        appDb,
      );
      const block = await readEmbeddingBlock(ctxOf(id), appDb);
      expect(block?.credentialRef).toBe(entry.ref);
    });

    // MCP hands `AppError.message` to the caller verbatim and the key has no server-side locale entry,
    // so off-console the message is the only thing that names the reason.
    test("the thrown message names the reason, not just the key", async () => {
      const { id } = await seedTenant("blk-msg");
      const notConfigured = await runScopedOn(appDb, ctx(id), (db) =>
        resolveEmbeddingConfig(db, id, "text-embedding-3-small").catch(
          (e: Error) => e,
        ),
      );
      expect(String((notConfigured as Error).message)).toContain(
        "not configured",
      );

      const entry = await createPendingVaultEntry(
        ctx(id),
        { name: "embed-unfilled", kind: "generic" },
        appDb,
      );
      await updateEmbeddingSettings(
        ctx(id),
        { credentialRef: entry.ref },
        appDb,
      );
      const pending = await runScopedOn(appDb, ctx(id), (db) =>
        resolveEmbeddingConfig(db, id, "text-embedding-3-small").catch(
          (e: Error) => e,
        ),
      );
      expect(String((pending as Error).message)).toContain("not filled in");
      expect(String((pending as Error).message)).not.toBe(
        String((notConfigured as Error).message),
      );
    });
  },
);
