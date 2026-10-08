import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { getDocumentProxy } from "unpdf";
import { PrismaClient } from "@/../generated/prisma/client";
import { buildDocumentTools } from "@/graph/tools/documents";
import type { TurnState } from "@/graph/tools/native";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  approveDocumentRequest,
  expireDueApprovalRequests,
  expiryJobKey,
  rejectDocumentRequest,
  renderApprovalPreview,
} from "@/modules/documents/approval";
import type { DocumentField } from "@/modules/documents/blocks";
import { documentStarter } from "@/modules/documents/starters";
import {
  createDocumentTemplate,
  getDocumentTemplate,
  updateDocumentTemplate,
} from "@/modules/documents/templates";

// A document an agent issues from a template that asks for approval: frozen on a request, numbered
// only when a person approves it, and never when nobody does (docs/documents.md, Approval).

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

const DIR = `/tmp/fazerai-doc-approval-${process.pid}`;
let tenantA = 0n;
let tenantB = 0n;
let templateId = 0n;
let fields: DocumentField[] = [];

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

function newTurnState(): TurnState {
  return {
    resolveRequested: false,
    pendingAttachments: [],
    imagesInFlight: 0,
    documentsInFlight: 0,
    attachmentsSeq: 0,
  };
}

function tool(turnState: TurnState, thread = 42) {
  const [built] = buildDocumentTools(
    [
      {
        templateId,
        name: "Orçamento",
        slug: "orcamento",
        description: null,
        fields,
      },
    ],
    {
      tenantId: tenantA,
      turnState,
      threadId: `${tenantA}:1:${thread}`,
      base: appDb,
      storageDir: DIR,
      timezone: "America/Sao_Paulo",
    },
  );
  if (!built) throw new Error("no tool built");
  return built;
}

const ARGS = {
  cliente: "Ana Ribeiro",
  itens: [{ description: "Consultoria", quantity: 2, unitPrice: 450 }],
  validade: "2026-09-05",
};

async function counts() {
  const [tpl] = await suDb.$queryRaw<{ last_number: number }[]>`
    SELECT last_number FROM document_templates WHERE id = ${templateId}`;
  const [docs] = await suDb.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM issued_documents WHERE template_id = ${templateId}`;
  const [reqs] = await suDb.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM document_approval_requests WHERE template_id = ${templateId}`;
  return {
    lastNumber: tpl?.last_number ?? -1,
    documents: Number(docs?.n ?? -1),
    requests: Number(reqs?.n ?? -1),
  };
}

async function latestRequestId(): Promise<bigint> {
  const row = await suDb.documentApprovalRequest.findFirst({
    where: { templateId },
    orderBy: { id: "desc" },
    select: { id: true },
  });
  if (!row) throw new Error("no request");
  return row.id;
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const page = await pdf.getPage(1);
  return (await page.getTextContent()).items
    .map((i) => ("str" in i ? i.str : ""))
    .join(" ");
}

async function refusal(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe.skipIf(!dbUp)("document approval", () => {
  beforeAll(async () => {
    tenantA = (
      await suDb.tenant.create({
        data: { name: "ApprA", slug: `appr-a-${process.pid}` },
      })
    ).id;
    tenantB = (
      await suDb.tenant.create({
        data: { name: "ApprB", slug: `appr-b-${process.pid}` },
      })
    ).id;
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: starter.name,
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
        numberPrefix: "ORC-",
      },
      appDb,
    );
    templateId = BigInt(tpl.id);
    fields = tpl.fields as DocumentField[];
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      for (const table of [
        "scheduler_jobs",
        "document_approval_requests",
        "issued_documents",
        "document_templates",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
    await rm(DIR, { recursive: true, force: true });
  });

  test("a new template issues without approval and waits 24h when switched on", async () => {
    const tpl = await getDocumentTemplate(ctx(tenantA), templateId, appDb);
    expect(tpl.requiresApproval).toBe(false);
    expect(tpl.approvalTtlHours).toBe(24);
  });

  test("the validity takes 1 to 168 whole hours and refuses the rest unchanged", async () => {
    for (const ok of [1, 168, 24]) {
      const t = await updateDocumentTemplate(
        ctx(tenantA),
        templateId,
        { approvalTtlHours: ok },
        appDb,
      );
      expect(t.approvalTtlHours).toBe(ok);
    }
    for (const bad of [0, -1, 169, 1.5]) {
      const e = await refusal(
        updateDocumentTemplate(
          ctx(tenantA),
          templateId,
          { approvalTtlHours: bad },
          appDb,
        ),
      );
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain("approvalTtlHours");
    }
    const after = await getDocumentTemplate(ctx(tenantA), templateId, appDb);
    expect(after.approvalTtlHours).toBe(24);
  });

  test("the agent's call on an approval template stores a request and takes no number", async () => {
    await updateDocumentTemplate(
      ctx(tenantA),
      templateId,
      { requiresApproval: true },
      appDb,
    );
    const before = await counts();
    const turnState = newTurnState();
    const out = String(await tool(turnState).invoke(ARGS));
    const again = String(await tool(newTurnState()).invoke(ARGS));
    const after = await counts();
    expect(out).toContain("revisão");
    expect(again).toBe(out);
    expect(turnState.pendingAttachments).toHaveLength(0);
    expect(after.requests - before.requests).toBe(1);
    expect(after.documents).toBe(before.documents);
    expect(after.lastNumber).toBe(before.lastNumber);
    const id = await latestRequestId();
    const row = await suDb.documentApprovalRequest.findUniqueOrThrow({
      where: { id },
    });
    expect(row.status).toBe("PENDING");
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(
      23.9 * 3_600_000,
    );
    const job = await suDb.schedulerJob.findFirst({
      where: {
        tenantId: tenantA,
        kind: "DOCUMENT_APPROVAL_EXPIRY",
        dedupeKey: expiryJobKey(id),
      },
    });
    expect(job?.runAt.getTime()).toBe(row.expiresAt.getTime());
  });

  test("a retried call keeps its request after the switch is turned off", async () => {
    const turnArgs = { ...ARGS, cliente: "Retry" };
    await tool(newTurnState(), 50).invoke(turnArgs);
    await updateDocumentTemplate(
      ctx(tenantA),
      templateId,
      { requiresApproval: false },
      appDb,
    );
    const before = await counts();
    const turnState = newTurnState();
    const out = String(await tool(turnState, 50).invoke(turnArgs));
    await updateDocumentTemplate(
      ctx(tenantA),
      templateId,
      { requiresApproval: true },
      appDb,
    );
    expect(out).toContain("revisão");
    expect(turnState.pendingAttachments).toHaveLength(0);
    expect(await counts()).toEqual(before);
  });

  test("the preview prints a placeholder where the number goes and consumes nothing", async () => {
    const id = await latestRequestId();
    const before = await counts();
    const { bytes } = await renderApprovalPreview(ctx(tenantA), id, appDb);
    const text = await pdfText(bytes);
    expect(text).toContain("numerado na aprovação");
    expect(text).not.toMatch(/ORC-\d/);
    expect(await counts()).toEqual(before);
  });

  test("approving issues the frozen snapshot, numbered, dated as the reviewer saw it", async () => {
    const id = await latestRequestId();
    const frozen = await suDb.documentApprovalRequest.findUniqueOrThrow({
      where: { id },
    });
    // The snapshot is dated; approving a day later must not move that date.
    const tomorrow = new Date(Date.now() + 20 * 3_600_000);
    const before = await counts();
    const [a, b] = await Promise.all([
      approveDocumentRequest({
        ctx: ctx(tenantA),
        requestId: id,
        base: appDb,
        storageDir: DIR,
        now: tomorrow,
      }),
      approveDocumentRequest({
        ctx: ctx(tenantA),
        requestId: id,
        base: appDb,
        storageDir: DIR,
        now: tomorrow,
      }),
    ]);
    const after = await counts();
    expect(a.document.id).toBe(b.document.id);
    expect(after.documents - before.documents).toBe(1);
    expect(after.lastNumber - before.lastNumber).toBe(1);
    expect(a.document.number).toBe(
      `ORC-${String(after.lastNumber).padStart(4, "0")}`,
    );
    const issued = await suDb.issuedDocument.findUniqueOrThrow({
      where: { id: BigInt(a.document.id) },
    });
    expect((issued.snapshot as { issuedDate?: string }).issuedDate).toBe(
      (frozen.snapshot as { issuedDate?: string }).issuedDate,
    );
    expect((issued.snapshot as { values?: unknown }).values).toEqual(
      (frozen.snapshot as { values?: unknown }).values,
    );
    const req = await suDb.documentApprovalRequest.findUniqueOrThrow({
      where: { id },
    });
    expect(req.status).toBe("APPROVED");
    expect(req.issuedDocumentId).toBe(issued.id);
    const later = await approveDocumentRequest({
      ctx: ctx(tenantA),
      requestId: id,
      base: appDb,
      storageDir: DIR,
    });
    expect(later.document.id).toBe(a.document.id);
    expect((await counts()).lastNumber).toBe(after.lastNumber);
  });

  test("a request that is not pending, or not this tenant's, issues nothing", async () => {
    const approved = await latestRequestId();
    const rejected = await refusal(
      rejectDocumentRequest({
        ctx: ctx(tenantA),
        requestId: approved,
        base: appDb,
      }),
    );
    expect(rejected.statusCode).toBe(409);
    await tool(newTurnState(), 43).invoke({ ...ARGS, cliente: "Bia" });
    const fresh = await latestRequestId();
    const before = await counts();
    const foreign = await refusal(
      approveDocumentRequest({
        ctx: ctx(tenantB),
        requestId: fresh,
        base: appDb,
        storageDir: DIR,
      }),
    );
    expect(foreign.statusCode).toBe(404);
    const missing = await refusal(
      approveDocumentRequest({
        ctx: ctx(tenantA),
        requestId: 9_000_000_000n,
        base: appDb,
        storageDir: DIR,
      }),
    );
    expect(missing.statusCode).toBe(404);
    const done = await rejectDocumentRequest({
      ctx: ctx(tenantA),
      requestId: fresh,
      note: "preço errado",
      base: appDb,
    });
    expect(done.status).toBe("REJECTED");
    expect(done.note).toBe("preço errado");
    const second = await refusal(
      approveDocumentRequest({
        ctx: ctx(tenantA),
        requestId: fresh,
        base: appDb,
        storageDir: DIR,
      }),
    );
    expect(second.statusCode).toBe(409);
    expect(await counts()).toEqual(before);
  });

  test("expiry moves only overdue pending requests, and approval refuses one even before it runs", async () => {
    await tool(newTurnState(), 44).invoke({ ...ARGS, cliente: "Caio" });
    const overdue = await latestRequestId();
    await tool(newTurnState(), 45).invoke({ ...ARGS, cliente: "Duda" });
    const future = await latestRequestId();
    await suDb.documentApprovalRequest.update({
      where: { id: overdue },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const before = await counts();
    const late = await refusal(
      approveDocumentRequest({
        ctx: ctx(tenantA),
        requestId: overdue,
        base: appDb,
        storageDir: DIR,
      }),
    );
    expect(late.translationKey).toBe("errors.documentApprovalExpired");
    expect(await expireDueApprovalRequests(tenantA, new Date(), appDb)).toEqual(
      [],
    );
    const statuses = await suDb.documentApprovalRequest.findMany({
      where: { templateId },
      select: { id: true, status: true },
    });
    const by = new Map(statuses.map((s) => [s.id, s.status]));
    expect(by.get(overdue)).toBe("EXPIRED");
    expect(by.get(future)).toBe("PENDING");
    expect([...by.values()].filter((s) => s === "APPROVED")).toHaveLength(1);
    expect(await counts()).toEqual(before);
  });
});
