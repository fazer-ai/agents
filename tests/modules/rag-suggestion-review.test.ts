import { afterAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { knowledgeApprove } from "@/modules/mcp/write-knowledge";
import {
  approveApprovalItem,
  createSuggestion,
  listApprovals,
  listPendingApprovals,
  rejectApprovalItem,
  requeueDiscardedItem,
} from "@/modules/rag/service";
import {
  releaseDeadReview,
  runSuggestionReview,
} from "@/modules/rag/suggestion-review";
import type { ClaimedJob } from "@/modules/scheduler/service";

// The suggestion reviewer and the floor in front of it: a proposal from the agent waits in SCREENING
// until a model has compared it with what the base, the queue and earlier rejections hold; every way
// the review can fail puts it in the pending list unreviewed, and nothing it discards is lost.

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

let tenantId = 0n;
let agentId = 0n;
let seq = 0;

async function seedTenant() {
  if (tenantId) return;
  const t = await suDb.tenant.create({
    data: { name: "SR", slug: `sr-${process.pid}` },
  });
  tenantId = t.id;
  const agent = await suDb.agent.create({
    data: {
      tenantId,
      name: "SR agent",
      systemPrompt: "x",
      modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
    },
  });
  agentId = agent.id;
}

async function newKb(): Promise<bigint> {
  await seedTenant();
  const kb = await suDb.knowledgeBase.create({
    data: {
      tenantId,
      name: `SR-KB-${++seq}`,
      embeddingModel: "text-embedding-3-small",
    },
  });
  return kb.id;
}

// A unit vector on one axis: the same axis is distance 0, another is distance 1.
function axis(i: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[i] = 1;
  return v;
}

async function seedDocument(
  kbId: bigint,
  content: string,
  at: number,
  externalId: string | null = null,
): Promise<bigint> {
  const doc = await suDb.knowledgeDocument.create({
    data: {
      tenantId,
      knowledgeBaseId: kbId,
      title: `Doc ${at}`,
      sourceType: "text",
      content,
      status: "READY",
      externalId,
    },
  });
  await suDb.$executeRawUnsafe(
    `INSERT INTO knowledge_chunks (tenant_id, knowledge_base_id, document_id, content, embedding)
     VALUES ($1, $2, $3, $4, $5::vector)`,
    tenantId,
    kbId,
    doc.id,
    content,
    `[${axis(at).join(",")}]`,
  );
  return doc.id;
}

function propose(
  kbId: bigint,
  content: string,
  opts: { thread?: string; agent?: boolean } = {},
) {
  return createSuggestion({
    ctx: ctxOf(tenantId),
    knowledgeBaseId: kbId,
    proposedContent: content,
    proposedTitle: "Título",
    threadId: opts.thread ?? `${tenantId}:7:${++seq}`,
    agentId: opts.agent === false ? undefined : agentId,
    base: appDb,
  });
}

function jobFor(itemId: bigint): ClaimedJob {
  return {
    id: 0n,
    tenantId,
    kind: "SUGGESTION_REVIEW",
    payload: { itemId: String(itemId) },
    dedupeKey: String(itemId),
  } as unknown as ClaimedJob;
}

// The reviewer, scripted: answers with `reply` and keeps what it was shown.
function scripted(reply: string) {
  const seen: BaseMessage[][] = [];
  const model = new FakeListChatModel({ responses: [reply] });
  const original = model.invoke.bind(model);
  model.invoke = ((messages: BaseMessage[], options?: unknown) => {
    seen.push(messages);
    return original(messages, options as never);
  }) as typeof model.invoke;
  return { model: model as unknown as BaseChatModel, seen };
}

function failing(): BaseChatModel {
  return {
    invoke: async () => {
      throw new Error("provider down");
    },
  } as unknown as BaseChatModel;
}

async function review(itemId: bigint, model: BaseChatModel, vector: number[]) {
  return runSuggestionReview(jobFor(itemId), appDb, {
    makeModel: () => model,
    embedText: async () => vector,
  });
}

async function item(id: bigint) {
  return suDb.approvalQueueItem.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      reviewerComment: true,
      replacesDocumentId: true,
      matchedItemId: true,
      matchedDocumentId: true,
      rejectionReason: true,
    },
  });
}

const NEVER: BaseChatModel = failing();

// TOP-LEVEL, so it runs after both describes and only once.
afterAll(async () => {
  if (!dbUp) return;
  if (tenantId) {
    for (const table of [
      "knowledge_chunks",
      "knowledge_documents",
      "approval_queue_items",
      "scheduler_jobs",
      "audit_logs",
      "knowledge_bases",
      "agents",
    ]) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
      );
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
  }
  await suDb.$disconnect();
  await appDb.$disconnect();
});

describe.skipIf(!dbUp)("the floor in front of the reviewer", () => {
  test("case, punctuation and spacing do not make a new entry, in any conversation", async () => {
    const kb = await newKb();
    const a = await propose(kb, "Prazo de reembolso: 7 dias.");
    const b = await propose(kb, "prazo de reembolso   7 dias");
    const c = await propose(kb, "PRAZO DE REEMBOLSO, 7 DIAS!");
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(c).toEqual({ id: a.id, created: false });
  });

  test("a different word, number or base is a new entry", async () => {
    const kb = await newKb();
    const other = await newKb();
    const a = await propose(kb, "Prazo de reembolso: 7 dias.");
    const b = await propose(kb, "Prazo de reembolso: 30 dias.");
    const c = await propose(other, "Prazo de reembolso: 7 dias.");
    expect([a.created, b.created, c.created]).toEqual([true, true, true]);
  });

  test("a sign, a decimal separator, a percent or a symbol keeps two facts apart", async () => {
    const kb = await newKb();
    // Each pair differs by ONE kept character, so each rule is proved on its own.
    const pairs = [
      ["Saldo mínimo de -10 reais.", "Saldo mínimo de 10 reais."],
      ["Desconto de 10% no boleto.", "Desconto de 10 no boleto."],
      ["O frete custa 1,5 real.", "O frete custa 1 5 real."],
      ["Mantenha a 10 °C.", "Mantenha a 10 C."],
    ];
    for (const [x, y] of pairs) {
      const a = await propose(kb, x as string);
      const b = await propose(kb, y as string);
      expect([a.created, b.created]).toEqual([true, true]);
    }
    // The kept characters do not undo the floor: case and the final period still fold.
    const same = await propose(kb, "SALDO MÍNIMO DE -10 REAIS");
    expect(same.created).toBe(false);
  });

  test("a rejected entry is not proposed again", async () => {
    const kb = await newKb();
    const a = await propose(kb, "Entrega grátis acima de 100 reais.", {
      agent: false,
    });
    await rejectApprovalItem({ ctx: ctxOf(tenantId), id: a.id, base: appDb });
    expect(await propose(kb, "entrega grátis acima de 100 reais")).toEqual({
      id: a.id,
      created: false,
    });
  });

  test("proposals racing on one burst leave one row and no error", async () => {
    const kb = await newKb();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => propose(kb, "Horário: 9h às 18h.")),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });

  test("the agent's proposal waits for the reviewer, with its job armed in the same write", async () => {
    const kb = await newKb();
    const a = await propose(kb, "Aceitamos pix e cartão.");
    expect((await item(a.id)).status).toBe("SCREENING");
    const job = await suDb.schedulerJob.findFirst({
      where: { tenantId, kind: "SUGGESTION_REVIEW", dedupeKey: String(a.id) },
      select: { status: true },
    });
    expect(job?.status).toBe("PENDING");
    const pending = await listPendingApprovals(ctxOf(tenantId), appDb);
    expect(pending.map((p) => p.id)).not.toContain(String(a.id));
  });

  test("a proposal through the REST route skips the reviewer", async () => {
    const kb = await newKb();
    const a = await propose(kb, "Atendemos aos sábados.", { agent: false });
    expect((await item(a.id)).status).toBe("PENDING");
    const job = await suDb.schedulerJob.findFirst({
      where: { tenantId, kind: "SUGGESTION_REVIEW", dedupeKey: String(a.id) },
    });
    expect(job).toBeNull();
  });
});

describe.skipIf(!dbUp)("the suggestion reviewer", () => {
  test("nothing similar is new without calling the model", async () => {
    const kb = await newKb();
    const a = await propose(kb, "Estacionamento gratuito para clientes.");
    expect(await review(a.id, NEVER, axis(1))).toEqual({ outcome: "done" });
    const row = await item(a.id);
    expect(row.status).toBe("PENDING");
    expect(row.reviewerComment).toContain("Nothing similar");
  });

  test("a reworded repeat of a pending proposal is discarded, shown with its match, and can be requeued", async () => {
    const kb = await newKb();
    const first = await propose(kb, "Reembolso em até 7 dias após a compra.");
    await review(first.id, NEVER, axis(2));
    const again = await propose(
      kb,
      "Aceitamos devolução do dinheiro até 7 dias depois da compra.",
    );
    const { model, seen } = scripted(
      JSON.stringify({
        verdict: "duplicate",
        comment: "Mesma regra da sugestão pendente.",
        matched_item: `item:${first.id}`,
      }),
    );
    await review(again.id, model, axis(2));
    expect(seen).toHaveLength(1);
    const row = await item(again.id);
    expect(row.status).toBe("DISCARDED");
    expect(row.matchedItemId).toBe(first.id);
    const discarded = await listApprovals(ctxOf(tenantId), "discarded", appDb);
    const shown = discarded.find((d) => d.id === String(again.id));
    expect(shown?.reviewerComment).toBe("Mesma regra da sugestão pendente.");
    expect(shown?.match).toMatchObject({
      kind: "suggestion",
      id: String(first.id),
    });
    expect(
      await requeueDiscardedItem({
        ctx: ctxOf(tenantId),
        id: again.id,
        base: appDb,
      }),
    ).toBe("requeued");
    expect((await item(again.id)).status).toBe("PENDING");
  });

  test("a repeat of a document already in the base is discarded against that document", async () => {
    const kb = await newKb();
    const doc = await seedDocument(
      kb,
      "Funcionamos de segunda a sexta, das 9h às 18h.",
      3,
    );
    const a = await propose(kb, "O horário é de 9h às 18h em dias úteis.");
    const { model } = scripted(
      JSON.stringify({
        verdict: "duplicate",
        comment: "Já está no documento de horário.",
        matched_document: `doc:${doc}`,
      }),
    );
    await review(a.id, model, axis(3));
    const row = await item(a.id);
    expect(row.status).toBe("DISCARDED");
    expect(row.matchedDocumentId).toBe(doc);
  });

  test("a correction of a document is pending with the document to replace, and approving replaces it", async () => {
    const kb = await newKb();
    const doc = await seedDocument(kb, "Frete grátis acima de 150 reais.", 4);
    const a = await propose(kb, "Frete grátis acima de 120 reais.");
    const { model } = scripted(
      JSON.stringify({
        verdict: "replace",
        comment: "Atualiza o valor mínimo do frete grátis.",
        replaces_document: `doc:${doc}`,
      }),
    );
    await review(a.id, model, axis(4));
    const row = await item(a.id);
    expect(row.status).toBe("PENDING");
    expect(row.replacesDocumentId).toBe(doc);
    const pending = await listPendingApprovals(ctxOf(tenantId), appDb);
    expect(
      pending.find((p) => p.id === String(a.id))?.replacesDocument,
    ).toMatchObject({
      id: String(doc),
      synced: false,
    });
    expect(pending.find((p) => p.id === String(a.id))?.replaceUnavailable).toBe(
      false,
    );
    const before = await suDb.knowledgeDocument.count({
      where: { knowledgeBaseId: kb },
    });
    const res = await approveApprovalItem({
      ctx: ctxOf(tenantId),
      id: a.id,
      demoMode: true,
      base: appDb,
    });
    expect(res).toMatchObject({
      outcome: "approved",
      replacedDocumentId: String(doc),
    });
    const stored = await suDb.knowledgeDocument.findUniqueOrThrow({
      where: { id: doc },
      select: { content: true },
    });
    expect(stored.content).toBe("Frete grátis acima de 120 reais.");
    expect(
      await suDb.knowledgeDocument.count({ where: { knowledgeBaseId: kb } }),
    ).toBe(before);
  });

  test("approving as new leaves the document the reviewer named untouched", async () => {
    const kb = await newKb();
    const doc = await seedDocument(kb, "Troca em até 30 dias.", 5);
    const a = await propose(kb, "Troca em até 15 dias.");
    const { model } = scripted(
      JSON.stringify({
        verdict: "replace",
        comment: "c",
        replaces_document: String(doc),
      }),
    );
    await review(a.id, model, axis(5));
    const res = await approveApprovalItem({
      ctx: ctxOf(tenantId),
      id: a.id,
      asNew: true,
      demoMode: true,
      base: appDb,
    });
    expect(res).toEqual({ outcome: "approved", chunks: 0 });
    const stored = await suDb.knowledgeDocument.findUniqueOrThrow({
      where: { id: doc },
      select: { content: true },
    });
    expect(stored.content).toBe("Troca em até 30 dias.");
  });

  test("a replacement whose document is gone claims nothing and can be approved as new", async () => {
    const kb = await newKb();
    const doc = await seedDocument(kb, "Parcelamos em 3x.", 6);
    const a = await propose(kb, "Parcelamos em 6x.");
    const { model } = scripted(
      JSON.stringify({
        verdict: "replace",
        comment: "c",
        replaces_document: `doc:${doc}`,
      }),
    );
    await review(a.id, model, axis(6));
    await suDb.knowledgeDocument.delete({ where: { id: doc } });
    const listed = await listApprovals(ctxOf(tenantId), "pending", appDb);
    expect(listed.find((l) => l.id === String(a.id))?.replaceUnavailable).toBe(
      true,
    );
    expect(
      await approveApprovalItem({
        ctx: ctxOf(tenantId),
        id: a.id,
        demoMode: true,
        base: appDb,
      }),
    ).toEqual({ outcome: "replace-unavailable" });
    expect((await item(a.id)).status).toBe("PENDING");
    expect(
      await approveApprovalItem({
        ctx: ctxOf(tenantId),
        id: a.id,
        asNew: true,
        demoMode: true,
        base: appDb,
      }),
    ).toEqual({ outcome: "approved", chunks: 0 });
  });

  test("over MCP, the preview refuses a replacement that is gone just as the apply does", async () => {
    const kb = await newKb();
    const doc = await seedDocument(kb, "Retirada na loja em 2 dias.", 9);
    const a = await propose(kb, "Retirada na loja em 1 dia.");
    const { model } = scripted(
      JSON.stringify({
        verdict: "replace",
        comment: "c",
        replaces_document: `doc:${doc}`,
      }),
    );
    await review(a.id, model, axis(9));
    await suDb.knowledgeDocument.delete({ where: { id: doc } });
    const principal = {
      userId: 1n,
      tenantId,
      clientId: "c",
      jti: "j",
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
    } as unknown as VerifiedToken;
    const args = { approval_id: String(a.id) };
    const preview = await knowledgeApprove(principal, args, { base: appDb });
    const applied = await knowledgeApprove(
      principal,
      { ...args, dry_run: false },
      { base: appDb },
    );
    expect([preview.ok, applied.ok]).toEqual([false, false]);
    expect(JSON.stringify(preview)).toContain("as_new");
    expect((await item(a.id)).status).toBe("PENDING");
    const asNew = await knowledgeApprove(
      principal,
      { ...args, as_new: true },
      { base: appDb },
    );
    expect(asNew.ok).toBe(true);
  });

  test("a document a source sync took over after the review is not replaced on approval", async () => {
    const kb = await newKb();
    const doc = await seedDocument(kb, "Entregamos em 10 dias.", 7);
    const a = await propose(kb, "Entregamos em 5 dias.");
    const { model } = scripted(
      JSON.stringify({
        verdict: "replace",
        comment: "c",
        replaces_document: `doc:${doc}`,
      }),
    );
    await review(a.id, model, axis(7));
    await suDb.knowledgeDocument.update({
      where: { id: doc },
      data: { externalId: "portal:42" },
    });
    const listed = await listApprovals(ctxOf(tenantId), "pending", appDb);
    expect(listed.find((l) => l.id === String(a.id))?.replaceUnavailable).toBe(
      true,
    );
    expect(
      await approveApprovalItem({
        ctx: ctxOf(tenantId),
        id: a.id,
        demoMode: true,
        base: appDb,
      }),
    ).toEqual({ outcome: "replace-unavailable" });
    expect((await item(a.id)).status).toBe("PENDING");
    const kept = await suDb.knowledgeDocument.findUniqueOrThrow({
      where: { id: doc },
    });
    expect(kept.content).toBe("Entregamos em 10 dias.");
  });

  test("only a discarded proposal can be requeued", async () => {
    const kb = await newKb();
    const a = await propose(kb, "Atendemos aos sábados até o meio-dia.");
    await review(a.id, NEVER, axis(8));
    expect((await item(a.id)).status).toBe("PENDING");
    await rejectApprovalItem({ ctx: ctxOf(tenantId), id: a.id, base: appDb });
    expect(
      await requeueDiscardedItem({
        ctx: ctxOf(tenantId),
        id: a.id,
        base: appDb,
      }),
    ).toBe("not-discarded");
    expect((await item(a.id)).status).toBe("REJECTED");
  });

  test("a document a source sync owns is never offered for replacement", async () => {
    const kb = await newKb();
    const doc = await seedDocument(
      kb,
      "Política de privacidade v1.",
      7,
      "art-1",
    );
    const a = await propose(kb, "Política de privacidade v2.");
    const { model } = scripted(
      JSON.stringify({
        verdict: "replace",
        comment: "c",
        replaces_document: `doc:${doc}`,
      }),
    );
    await review(a.id, model, axis(7));
    const row = await item(a.id);
    expect(row.status).toBe("PENDING");
    expect(row.replacesDocumentId).toBeNull();
  });

  test("a duplicate that names nothing it was shown is queued unreviewed", async () => {
    const kb = await newKb();
    await seedDocument(kb, "Aceitamos boleto.", 8);
    const a = await propose(kb, "Pagamento por boleto bancário.");
    const { model } = scripted(
      JSON.stringify({
        verdict: "duplicate",
        comment: "c",
        matched_document: "doc:999999999",
      }),
    );
    await review(a.id, model, axis(8));
    const row = await item(a.id);
    expect(row.status).toBe("PENDING");
    expect(row.reviewerComment).toBeNull();
  });

  test("a failing or unreadable reviewer queues the proposal unreviewed", async () => {
    const kb = await newKb();
    await seedDocument(kb, "Entregamos em todo o Brasil.", 9);
    const a = await propose(kb, "Entrega para todo o país.");
    await review(a.id, failing(), axis(9));
    expect((await item(a.id)).status).toBe("PENDING");
    const b = await propose(kb, "Enviamos para todos os estados.");
    await review(b.id, scripted("acho que é repetida").model, axis(9));
    expect(await item(b.id)).toMatchObject({
      status: "PENDING",
      reviewerComment: null,
    });
  });

  test("an embedding failure queues the proposal unreviewed", async () => {
    const kb = await newKb();
    const a = await propose(kb, "Temos loja física em Curitiba.");
    await runSuggestionReview(jobFor(a.id), appDb, {
      makeModel: () => NEVER,
      embedText: async () => {
        throw new Error("embedding provider down");
      },
    });
    expect((await item(a.id)).status).toBe("PENDING");
  });

  test("a review job that died releases its proposal", async () => {
    const kb = await newKb();
    const a = await propose(kb, "Garantia de 90 dias.");
    await releaseDeadReview(jobFor(a.id), "boom", appDb);
    expect((await item(a.id)).status).toBe("PENDING");
  });

  test("the reviewer reads a rejection with the person's reason", async () => {
    const kb = await newKb();
    const wrong = await propose(kb, "Prazo de entrega: 7 dias.");
    await review(wrong.id, NEVER, axis(10));
    await rejectApprovalItem({
      ctx: ctxOf(tenantId),
      id: wrong.id,
      reason: "O prazo certo é 30 dias.",
      base: appDb,
    });
    expect((await item(wrong.id)).rejectionReason).toBe(
      "O prazo certo é 30 dias.",
    );
    const fixed = await propose(kb, "Prazo de entrega: 30 dias.");
    const { model, seen } = scripted(
      JSON.stringify({ verdict: "new", comment: "Corrige o prazo." }),
    );
    await review(fixed.id, model, axis(10));
    const shown = seen[0]?.map((m) => String(m.content)).join("\n") ?? "";
    expect(shown).toContain("O prazo certo é 30 dias.");
    expect(shown).toContain(`item:${wrong.id}`);
    expect(await item(fixed.id)).toMatchObject({
      status: "PENDING",
      reviewerComment: "Corrige o prazo.",
    });
  });

  test("a rejection reason stays out of the audit line, and an over-long one is refused", async () => {
    const kb = await newKb();
    const a = await propose(kb, "Abrimos aos domingos.", { agent: false });
    await rejectApprovalItem({
      ctx: ctxOf(tenantId),
      id: a.id,
      reason: "motivo-sigiloso-4471",
      base: appDb,
    });
    const audit = await suDb.auditLog.findMany({
      where: { tenantId, target: `approval:${a.id}` },
      select: { after: true },
    });
    expect(JSON.stringify(audit)).not.toContain("motivo-sigiloso-4471");
    const b = await propose(kb, "Abrimos aos feriados.", { agent: false });
    await expect(
      rejectApprovalItem({
        ctx: ctxOf(tenantId),
        id: b.id,
        reason: "x".repeat(1001),
        base: appDb,
      }),
    ).rejects.toThrow("1000");
    expect((await item(b.id)).status).toBe("PENDING");
  });

  test("over the spend ceiling the proposal is queued unreviewed, without calling the model", async () => {
    const kb = await newKb();
    await seedDocument(kb, "Cobramos taxa de entrega de 10 reais.", 12);
    const a = await propose(kb, "A taxa de entrega é 10 reais.");
    const monthStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    );
    await suDb.tenant.update({
      where: { id: tenantId },
      data: {
        settings: { spendCeiling: { enabled: true, monthlyInboxUsd: 10 } },
      },
    });
    await suDb.spendCostSnapshot.upsert({
      where: {
        tenantId_source_monthStart: { tenantId, source: "inbox", monthStart },
      },
      create: {
        tenantId,
        source: "inbox",
        monthStart,
        costUsd: 1000,
        polledAt: new Date(),
      },
      update: { costUsd: 1000, polledAt: new Date() },
    });
    try {
      const { model, seen } = scripted(
        JSON.stringify({
          verdict: "duplicate",
          comment: "c",
          matched_document: "doc:1",
        }),
      );
      await review(a.id, model, axis(12));
      expect(seen).toHaveLength(0);
      expect(await item(a.id)).toMatchObject({
        status: "PENDING",
        reviewerComment: null,
      });
    } finally {
      await suDb.tenant.update({
        where: { id: tenantId },
        data: { settings: {} },
      });
      await suDb.spendCostSnapshot.deleteMany({ where: { tenantId } });
    }
  });

  test("a proposal another review already moved is left alone", async () => {
    const kb = await newKb();
    const a = await propose(kb, "Wi-fi gratuito na loja.");
    await runScopedOn(appDb, ctxOf(tenantId), (db) =>
      db.approvalQueueItem.update({
        where: { id: a.id },
        data: { status: "PENDING" },
      }),
    );
    expect(await review(a.id, NEVER, axis(11))).toEqual({ outcome: "done" });
    expect((await item(a.id)).reviewerComment).toBeNull();
  });
});
