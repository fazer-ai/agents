import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { buildRagTools } from "@/graph/tools/rag";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  createSuggestion,
  editApprovalItem,
  rejectApprovalItem,
} from "@/modules/rag/service";

// A conversation that proposes the same entry again lands on the row it already has. The
// observer's tick is stateless and rereads the whole conversation, so without a key every burst put
// the same rule in the queue once more, byte for byte, under a reworded title.

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

const ctxOf = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

const RULE = "Reembolsos são aceitos em até 7 dias após a compra.";

let tenantId = 0n;
let kbId = 0n;
let otherKbId = 0n;
let threadSeq = 0;
// A fresh conversation per test, so no test sees another's row.
const nextThread = () => `${tenantId}:41:${++threadSeq}`;

async function seed() {
  if (tenantId) return;
  const t = await suDb.tenant.create({
    data: { name: "DEDUP", slug: `dedup-${process.pid}` },
  });
  tenantId = t.id;
  const kb = await suDb.knowledgeBase.create({
    data: {
      tenantId,
      name: "DEDUP-KB",
      embeddingModel: "text-embedding-3-small",
    },
  });
  kbId = kb.id;
  const other = await suDb.knowledgeBase.create({
    data: {
      tenantId,
      name: "DEDUP-KB-2",
      embeddingModel: "text-embedding-3-small",
    },
  });
  otherKbId = other.id;
}

function suggest(
  threadId: string | undefined,
  content: string,
  title = "Prazo",
  knowledgeBaseId = kbId,
) {
  return createSuggestion({
    ctx: ctxOf(tenantId),
    knowledgeBaseId,
    proposedContent: content,
    proposedTitle: title,
    threadId,
    base: appDb,
  });
}

async function rowsOf(threadId: string | null) {
  return runScopedOn(appDb, ctxOf(tenantId), (db) =>
    db.approvalQueueItem.findMany({
      where: { threadId },
      orderBy: { id: "asc" },
      select: { id: true, status: true, proposedTitle: true },
    }),
  );
}

describe.skipIf(!dbUp)("a repeated suggestion from one conversation", () => {
  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM approval_queue_items WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM knowledge_bases WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("lands on the row it already has, whatever the title says", async () => {
    await seed();
    const thread = nextThread();
    const first = await suggest(thread, RULE, "Prazo de reembolso");
    const again = await suggest(thread, RULE, "Política de reembolso");
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
    const rows = await rowsOf(thread);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.proposedTitle).toBe("Prazo de reembolso");
  });

  test("two proposals racing on one burst leave one row and no error", async () => {
    await seed();
    const thread = nextThread();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => suggest(thread, RULE)),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await rowsOf(thread)).toHaveLength(1);
  });

  test("a rejected entry is not queued again by the same conversation", async () => {
    await seed();
    const thread = nextThread();
    const first = await suggest(thread, RULE);
    expect(
      await rejectApprovalItem({
        ctx: ctxOf(tenantId),
        id: first.id,
        base: appDb,
      }),
    ).toBe("rejected");
    const again = await suggest(thread, RULE);
    expect(again).toEqual({ id: first.id, created: false });
    expect((await rowsOf(thread)).map((r) => r.status)).toEqual(["REJECTED"]);
  });

  test("an entry the reviewer rewrote still holds the proposal it came from", async () => {
    await seed();
    const thread = nextThread();
    const first = await suggest(thread, RULE);
    await editApprovalItem({
      ctx: ctxOf(tenantId),
      id: first.id,
      proposedContent: "Reembolsos: até 7 dias corridos após a compra.",
      base: appDb,
    });
    expect(await suggest(thread, RULE)).toEqual({
      id: first.id,
      created: false,
    });
    expect(await rowsOf(thread)).toHaveLength(1);
  });

  test("different content, or another conversation, is a new suggestion", async () => {
    await seed();
    const thread = nextThread();
    const other = nextThread();
    const a = await suggest(thread, RULE);
    const b = await suggest(thread, `${RULE} Exceto itens personalizados.`);
    const c = await suggest(other, RULE);
    expect([a.created, b.created, c.created]).toEqual([true, true, true]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  test("the key is the hash the migration computes for the rows written before it", async () => {
    // NOTE: The backfill hashes the stored text in SQL, so a new proposal only lands on an old row if
    // both sides hash the same bytes, untrimmed and in their case.
    await seed();
    const thread = nextThread();
    const text = `  ${RULE}\n`;
    await suggest(thread, text);
    const [row] = await suDb.$queryRaw<{ same: boolean }[]>`
      SELECT content_hash = encode(sha256(convert_to(proposed_content, 'UTF8')), 'hex') AS same
        FROM approval_queue_items WHERE thread_id = ${thread}`;
    expect(row?.same).toBe(true);
    expect((await suggest(thread, RULE)).created).toBe(true);
  });

  test("the same text for another base is another entry", async () => {
    await seed();
    const thread = nextThread();
    const a = await suggest(thread, RULE, "Prazo", kbId);
    const b = await suggest(thread, RULE, "Prazo", otherKbId);
    expect([a.created, b.created]).toEqual([true, true]);
    expect(await suggest(thread, RULE, "Outro", otherKbId)).toEqual({
      id: b.id,
      created: false,
    });
    expect(await rowsOf(thread)).toHaveLength(2);
  });

  test("a suggestion with no conversation is never collapsed", async () => {
    await seed();
    const a = await suggest(undefined, `${RULE} (rota REST)`);
    const b = await suggest(undefined, `${RULE} (rota REST)`);
    expect([a.created, b.created]).toEqual([true, true]);
    expect(a.id).not.toBe(b.id);
  });

  test("the tool tells the model the entry is already with a human", async () => {
    await seed();
    const thread = nextThread();
    const [tool] = buildRagTools(
      { tenantId, base: appDb, knowledgeBaseIds: [kbId], threadId: thread },
      ["suggest_kb_entry"],
    );
    if (!tool) throw new Error("suggest_kb_entry not built");
    const first = String(await tool.invoke({ content: RULE, title: "Prazo" }));
    const again = String(
      await tool.invoke({ content: RULE, title: "Reembolso" }),
    );
    expect(first).toContain("queued for human review");
    expect(again).toContain("already suggested from this conversation");
    expect(await rowsOf(thread)).toHaveLength(1);
  });
});
