import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  approveApprovalItem,
  claimApprovalForStorage,
  createSuggestion,
  editApprovalItem,
} from "@/modules/rag/service";

// The context these calls take: the tenant id came from a row this test created, so it carries
// TENANT_ADMIN, the role that tells `runScopedOn` the id never came from outside.
const ctxOf = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// The composition, not any single piece. A suggestion is copied into the knowledge base on approval,
// so a hedge in it would be embedded and inherited by every later answer on the subject. These pin
// the two halves that prevent it: the reviewer's revision is what gets stored, and `rationale`
// (where the tool description sends every caveat) never reaches the base.

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

const HEDGED =
  "O prazo de entrega é de 5 dias úteis. Solicita-se validação da informação junto ao setor responsável.";
const REVISED = "O prazo de entrega é de 5 dias úteis.";
const RATIONALE = "Não consegui confirmar com o setor responsável.";

let tenantId = 0n;
let kbId = 0n;

// A base of its own per test: a proposal repeated for the same base lands on the row already there,
// and these tests propose the same two texts again and again.
let kbSeq = 0;
async function seed() {
  if (!tenantId) {
    const t = await suDb.tenant.create({
      data: { name: "AR", slug: `ar-${process.pid}` },
    });
    tenantId = t.id;
  }
  const kb = await suDb.knowledgeBase.create({
    data: {
      tenantId,
      name: `AR-KB-${++kbSeq}`,
      embeddingModel: "text-embedding-3-small",
    },
  });
  kbId = kb.id;
}

// The document approval just created: newest first, since each test approves exactly one.
async function lastApprovedText(): Promise<string | null> {
  const rows = await runScopedOn(appDb, ctx(tenantId), (db) =>
    db.knowledgeDocument.findMany({
      where: { knowledgeBaseId: kbId, sourceType: "approval" },
      orderBy: { id: "desc" },
      take: 1,
      select: { content: true },
    }),
  );
  return rows[0]?.content ?? null;
}

describe.skipIf(!dbUp)("approval review before approval", () => {
  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM knowledge_chunks WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM knowledge_documents WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM approval_queue_items WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM knowledge_bases WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // NOTE: the reviewer's text is what lands, and the hedge the agent wrote never reaches the base.
  test("an edited suggestion is approved as edited, not as proposed", async () => {
    await seed();
    const item = await createSuggestion({
      ctx: ctxOf(tenantId),
      knowledgeBaseId: kbId,
      proposedContent: HEDGED,
      proposedTitle: "Prazo",
      rationale: RATIONALE,
      base: appDb,
    });
    const edited = await editApprovalItem({
      ctx: ctxOf(tenantId),
      id: item.id,
      proposedContent: REVISED,
      base: appDb,
    });
    expect(edited).toBe("updated");
    const res = await approveApprovalItem({
      ctx: ctxOf(tenantId),
      id: item.id,
      demoMode: true,
      base: appDb,
    });
    expect(res.outcome).toBe("approved");
    const text = await lastApprovedText();
    expect(text).toBe(REVISED);
    expect(text).not.toContain("Solicita-se validação");
  });

  // NOTE: the other half of the contract the tool description states: doubt belongs in `rationale`
  // precisely because approval never carries it across.
  test("the rationale never reaches the knowledge base", async () => {
    await seed();
    const item = await createSuggestion({
      ctx: ctxOf(tenantId),
      knowledgeBaseId: kbId,
      proposedContent: REVISED,
      proposedTitle: "Prazo 2",
      rationale: RATIONALE,
      base: appDb,
    });
    await approveApprovalItem({
      ctx: ctxOf(tenantId),
      id: item.id,
      demoMode: true,
      base: appDb,
    });
    const text = await lastApprovedText();
    expect(text).toBe(REVISED);
    expect(text).not.toContain("Não consegui confirmar");
  });

  // NOTE: the claim returns the row's text in the same statement. Embedding the text read in the
  // FIRST phase would throw away a revision saved between that read and the claim, which the CAS
  // accepts, with both reviewers told it worked.
  test("the claim returns the text the row holds at claim time, not an earlier read", async () => {
    await seed();
    const item = await createSuggestion({
      ctx: ctxOf(tenantId),
      knowledgeBaseId: kbId,
      proposedContent: HEDGED,
      proposedTitle: "Prazo 3",
      base: appDb,
    });
    // Stands in for the concurrent reviewer: the edit lands before the claim runs.
    await editApprovalItem({
      ctx: ctxOf(tenantId),
      id: item.id,
      proposedContent: REVISED,
      base: appDb,
    });
    const claimed = await claimApprovalForStorage(
      ctxOf(tenantId),
      item.id,
      appDb,
    );
    expect(claimed?.proposedContent).toBe(REVISED);
    expect(claimed?.knowledgeBaseId).toBe(kbId);
  });

  test("a second claim on the same item gets nothing", async () => {
    await seed();
    const item = await createSuggestion({
      ctx: ctxOf(tenantId),
      knowledgeBaseId: kbId,
      proposedContent: REVISED,
      base: appDb,
    });
    expect(
      await claimApprovalForStorage(ctxOf(tenantId), item.id, appDb),
    ).not.toBeNull();
    expect(
      await claimApprovalForStorage(ctxOf(tenantId), item.id, appDb),
    ).toBeNull();
  });

  // Editing is a review step, so it must be closed once the item leaves review — otherwise a second
  // tab could rewrite the text of an entry already embedded, with no effect on the base.
  test("an approved item can no longer be edited", async () => {
    await seed();
    const item = await createSuggestion({
      ctx: ctxOf(tenantId),
      knowledgeBaseId: kbId,
      proposedContent: REVISED,
      base: appDb,
    });
    await approveApprovalItem({
      ctx: ctxOf(tenantId),
      id: item.id,
      demoMode: true,
      base: appDb,
    });
    expect(
      await editApprovalItem({
        ctx: ctxOf(tenantId),
        id: item.id,
        proposedContent: "tarde demais",
        base: appDb,
      }),
    ).toBe("not-pending");
  });
});
