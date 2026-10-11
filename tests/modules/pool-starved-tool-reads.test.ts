import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import { clearTurnOwning } from "@/graph/thread-claim";
import {
  asSuperAdminOn,
  runScopedOn,
  setScopedTxMaxWaitForTest,
} from "@/lib/tenancy/multi-tenant";
import * as documents from "@/modules/rag/documents";
import * as embeddings from "@/modules/rag/embeddings";
import { EMBEDDING_DIM } from "@/modules/rag/embeddings";
import { searchKnowledge } from "@/modules/rag/service";
import { resolveInjectableCredentialEntry } from "@/modules/vault/injectable";
import { seedChatwootInstance } from "../utils/chatwoot";

// The reads a tool makes before its request, against a pool that really is full. A failed read ends
// the tool call with an error the model may escalate over, when the same read a moment later would
// have answered. Here a client of ONE connection is held by another transaction past `maxWait`, so
// the read's first transaction never starts, exactly as there; the hold ends when the retry reports
// that refusal, and the retry is what gets the answer. `maxWait` is shortened through its test seam,
// and the shipped value is held by the first test below.

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

// The wait for a connection a read is refused after, in place of the shipped two seconds.
const MAX_WAIT_MS = 100;

// The options a transaction is opened with, read off a base that records them. Both openers take
// the same options: the tenant-scoped one and the fleet one.
const OPENERS = {
  runScopedOn: (base: unknown) =>
    runScopedOn(
      base as Parameters<typeof runScopedOn>[0],
      { tenantId: 1n, userId: null, role: "TENANT_ADMIN" },
      async () => null,
    ),
  asSuperAdminOn: (base: unknown) =>
    asSuperAdminOn(
      base as Parameters<typeof asSuperAdminOn>[0],
      async () => null,
    ),
};

async function openedWith(opener: keyof typeof OPENERS): Promise<unknown> {
  let opened: unknown;
  const $transaction = async (_fn: unknown, options: unknown) => {
    opened = options;
  };
  await OPENERS[opener]({ $transaction, $extends: () => ({ $transaction }) });
  return opened;
}

describe.each(Object.keys(OPENERS) as (keyof typeof OPENERS)[])(
  "%s",
  (opener) => {
    test("waits the shipped two seconds for a connection", async () => {
      expect(await openedWith(opener)).toEqual({
        maxWait: 2_000,
        timeout: 5_000,
      });
    });

    test("is opened with the shortened wait", async () => {
      setScopedTxMaxWaitForTest(MAX_WAIT_MS);
      try {
        expect(await openedWith(opener)).toEqual({
          maxWait: MAX_WAIT_MS,
          timeout: 5_000,
        });
      } finally {
        setScopedTxMaxWaitForTest(undefined);
      }
    });
  },
);

describe.skipIf(!dbUp)("tool reads on a full pool", () => {
  let tenantId = 0n;
  let kbId = 0n;
  let vaultRef = "";
  let pool: PrismaClient;
  let embeddingConfig: { mockRestore(): void } | null = null;
  let warn: { mockRestore(): void } | null = null;
  let refusals = 0;
  let onRefusal: () => void = () => {};

  // Takes the pool's only connection, resolves once it has it, and keeps it until a read is refused
  // for want of it. The hold comes back in an object: an async function returning the promise itself
  // would adopt it and wait the hold out.
  async function holdPool(): Promise<{ done: Promise<void> }> {
    let taken: () => void = () => {};
    const has = new Promise<void>((r) => {
      taken = r;
    });
    const refused = new Promise<void>((r) => {
      onRefusal = r;
    });
    const held = pool.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        taken();
        await refused;
      },
      { timeout: 10_000 },
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
    setScopedTxMaxWaitForTest(MAX_WAIT_MS);
    // The line the retry writes for a transaction that never started is the refusal this file waits on.
    warn = spyOn(logger, "warn").mockImplementation(((msg: unknown) => {
      if (String(msg).includes("the database pool had no free connection")) {
        refusals += 1;
        onRefusal();
      }
    }) as never);
  });

  beforeEach(() => {
    refusals = 0;
  });

  afterAll(async () => {
    setScopedTxMaxWaitForTest(undefined);
    warn?.mockRestore();
    embeddingConfig?.mockRestore();
    await pool?.$disconnect();
    if (su && tenantId) await su.tenant.delete({ where: { id: tenantId } });
    await su?.$disconnect();
  });

  test("an HTTP tool's vault credential is read once the pool frees up, not failed", async () => {
    const held = await holdPool();
    const cred = await resolveInjectableCredentialEntry(
      pool,
      tenantId,
      vaultRef,
    );
    await held.done;
    expect(cred?.value).toBe("s3cret");
    expect(refusals).toBe(1);
  });

  test("search_knowledge's first read survives a full pool", async () => {
    const embed = spyOn(embeddings, "embedQuery").mockResolvedValue(
      Array.from({ length: EMBEDDING_DIM }, () => 0.01),
    );
    try {
      const held = await holdPool();
      const hits = await searchKnowledge({
        ctx: { tenantId, userId: null, role: "TENANT_ADMIN" },
        query: "horário",
        knowledgeBaseIds: [kbId],
        base: pool,
      });
      await held.done;
      expect(hits).toEqual([]);
      expect(embed).toHaveBeenCalledTimes(1);
      expect(refusals).toBe(1);
    } finally {
      embed.mockRestore();
    }
  });

  test("search_knowledge's vector read survives a pool that fills while the query is embedded", async () => {
    let hold: Promise<void> = Promise.resolve();
    const embed = spyOn(embeddings, "embedQuery").mockImplementation(
      async () => {
        // The pool fills between the two reads, which is where the embedding's network call sits.
        hold = (await holdPool()).done;
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
      expect(refusals).toBe(1);
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
    const held = await holdPool();
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
    expect(refusals).toBe(1);
  });
});
