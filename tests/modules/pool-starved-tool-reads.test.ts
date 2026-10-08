import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { clearTurnOwning } from "@/graph/thread-claim";
import * as documents from "@/modules/rag/documents";
import * as embeddings from "@/modules/rag/embeddings";
import { EMBEDDING_DIM } from "@/modules/rag/embeddings";
import { searchKnowledge } from "@/modules/rag/service";
import { resolveInjectableCredentialEntry } from "@/modules/vault/injectable";
import { seedChatwootInstance } from "../utils/chatwoot";

// The reads a tool makes before its request, against a pool that really is full. A failed read ends
// the tool call with an error the model may escalate over, when the same read a moment later would
// have answered. Here a client of ONE connection is held by another transaction past `maxWait` (2s), so the
// read's first transaction never starts, exactly as there; the hold then ends and the retry is what
// gets the answer.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

// Longer than `maxWait`, so the first attempt is refused; shorter than the retry deadline.
const HOLD_MS = 2_400;

describe.skipIf(!dbUp)("tool reads on a full pool", () => {
  let tenantId = 0n;
  let kbId = 0n;
  let vaultRef = "";
  let pool: PrismaClient;
  let embeddingConfig: { mockRestore(): void } | null = null;

  // Takes the pool's only connection for `ms`, and resolves once it has it. The hold comes back in
  // an object: an async function returning the promise itself would adopt it and wait the hold out.
  async function holdPool(ms: number): Promise<{ done: Promise<void> }> {
    let taken: () => void = () => {};
    const has = new Promise<void>((r) => {
      taken = r;
    });
    const held = pool.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        taken();
        await new Promise((r) => setTimeout(r, ms));
      },
      { timeout: ms + 5_000 },
    );
    await has;
    return { done: held };
  }

  beforeAll(async () => {
    const db = su as PrismaClient;
    tenantId = (
      await db.tenant.create({
        data: { name: "POOL", slug: `pool-1122-${process.pid}` },
      })
    ).id;
    kbId = (await db.knowledgeBase.create({ data: { tenantId, name: "FAQ" } }))
      .id;
    const entry = await db.vaultEntry.create({
      data: { tenantId, name: "api-key", secret: encryptJson("s3cret") },
      select: { id: true },
    });
    vaultRef = `vault:${entry.id}`;
    // The search's config read, stubbed like the suite next door: a tenant without an embedding key
    // refuses before the vector read this file is about.
    embeddingConfig = spyOn(
      documents,
      "resolveEmbeddingConfig",
    ).mockResolvedValue({
      model: "text-embedding-3-small",
      apiKey: "sk-probe",
    });
    pool = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl as string, max: 1 }),
    });
  });

  afterAll(async () => {
    embeddingConfig?.mockRestore();
    await pool?.$disconnect();
    if (su && tenantId) await su.tenant.delete({ where: { id: tenantId } });
    await su?.$disconnect();
  });

  test("an HTTP tool's vault credential is read once the pool frees up, not failed", async () => {
    const held = await holdPool(HOLD_MS);
    const cred = await resolveInjectableCredentialEntry(
      pool,
      tenantId,
      vaultRef,
    );
    await held.done;
    expect(cred?.value).toBe("s3cret");
  });

  test("search_knowledge's first read survives a full pool", async () => {
    const embed = spyOn(embeddings, "embedQuery").mockResolvedValue(
      Array.from({ length: EMBEDDING_DIM }, () => 0.01),
    );
    try {
      const held = await holdPool(HOLD_MS);
      const hits = await searchKnowledge({
        ctx: { tenantId, userId: null, role: "TENANT_ADMIN" },
        query: "horário",
        knowledgeBaseIds: [kbId],
        base: pool,
      });
      await held.done;
      expect(hits).toEqual([]);
      expect(embed).toHaveBeenCalledTimes(1);
    } finally {
      embed.mockRestore();
    }
  });

  test("search_knowledge's vector read survives a pool that fills while the query is embedded", async () => {
    let hold: Promise<void> = Promise.resolve();
    const embed = spyOn(embeddings, "embedQuery").mockImplementation(
      async () => {
        // The pool fills between the two reads, which is where the embedding's network call sits.
        hold = (await holdPool(HOLD_MS)).done;
        return Array.from({ length: EMBEDDING_DIM }, () => 0.01);
      },
    );
    try {
      const hits = await searchKnowledge({
        ctx: { tenantId, userId: null, role: "TENANT_ADMIN" },
        query: "horário",
        knowledgeBaseIds: [kbId],
        base: pool,
      });
      await hold;
      expect(hits).toEqual([]);
    } finally {
      embed.mockRestore();
    }
  });
  test("a turn's lease is released once the pool frees up, not left to read as a running turn", async () => {
    const db = su as PrismaClient;
    const inst = await seedChatwootInstance(db, {
      tenantId,
      accountId: 9,
      baseUrl: "https://203.0.113.21:9",
    });
    const contactInboxId = 4_242;
    const graphThreadId = `${tenantId}:${inst.id}:ci:${contactInboxId}`;
    await db.agentThread.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        contactInboxId,
        threadId: graphThreadId,
        turnHolders: 1,
        turnEpoch: 7n,
        turnHeldUntil: new Date(Date.now() + 5 * 60_000),
      },
    });
    const held = await holdPool(HOLD_MS);
    await clearTurnOwning(
      { tenantId, instanceId: inst.id, contactInboxId, graphThreadId },
      pool,
      { epoch: 7n, heldBefore: false },
    );
    await held.done;
    const row = await db.agentThread.findFirstOrThrow({
      where: { tenantId, contactInboxId },
      select: { turnHolders: true, turnHeldUntil: true },
    });
    expect(row).toEqual({ turnHolders: 0, turnHeldUntil: null });
  });
});
