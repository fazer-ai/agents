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
  createApprovalRequest,
  expireDueApprovalRequests,
  expiryJobKey,
  getApprovalRequest,
  issueOrRequestApproval,
  KeyAnswered,
  listApprovalRequests,
  rejectDocumentRequest,
  renderApprovalPreview,
} from "@/modules/documents/approval";
import type { DocumentField } from "@/modules/documents/blocks";
import {
  freezeDocumentSnapshot,
  issueDocument,
} from "@/modules/documents/issue";
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
        "audit_logs",
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
    // One trail row for the decision, however many callers raced to make it.
    const trail = await suDb.auditLog.findMany({
      where: { tenantId: tenantA, target: `document_approval:${id}` },
    });
    expect(trail.map((t) => t.action)).toEqual(["document_approval.approve"]);
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

  test("an approved request answers with its document after the template is deleted", async () => {
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const doomed = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: "Apagado depois",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
        requiresApproval: true,
      },
      appDb,
    );
    const [built] = buildDocumentTools(
      [
        {
          templateId: BigInt(doomed.id),
          name: doomed.name,
          slug: doomed.slug,
          description: null,
          fields: doomed.fields as DocumentField[],
        },
      ],
      {
        tenantId: tenantA,
        turnState: newTurnState(),
        threadId: `${tenantA}:1:60`,
        base: appDb,
        storageDir: DIR,
      },
    );
    await built?.invoke(ARGS);
    const request = await suDb.documentApprovalRequest.findFirstOrThrow({
      where: { templateId: BigInt(doomed.id) },
    });
    const first = await approveDocumentRequest({
      ctx: ctx(tenantA),
      requestId: request.id,
      base: appDb,
      storageDir: DIR,
    });
    await suDb.documentTemplate.delete({ where: { id: BigInt(doomed.id) } });
    const again = await approveDocumentRequest({
      ctx: ctx(tenantA),
      requestId: request.id,
      base: appDb,
      storageDir: DIR,
    });
    expect(again.document.id).toBe(first.document.id);
    expect(again.document.number).toBe(first.document.number);
  });

  test("a caller cannot issue under the key an approval reuses", async () => {
    const e = await refusal(
      issueDocument({
        ctx: ctx(tenantA),
        templateId,
        idempotencyKey: "approval:1",
        values: ARGS,
        base: appDb,
        storageDir: DIR,
      }),
    );
    expect(e.statusCode).toBe(400);
    expect(e.message).toContain("reserved");
  });

  test("a document an older build stored under the prefix still answers its retry", async () => {
    const legacy = await issueDocument({
      ctx: ctx(tenantA),
      templateId,
      idempotencyKey: "legado-antigo",
      values: { ...ARGS, cliente: "Legado REST" },
      base: appDb,
      storageDir: DIR,
    });
    await suDb.issuedDocument.update({
      where: { id: BigInt(legacy.id) },
      data: { idempotencyKey: "approval:legado" },
    });
    const before = await suDb.documentTemplate.findUniqueOrThrow({
      where: { id: templateId },
      select: { lastNumber: true },
    });
    const retry = await issueDocument({
      ctx: ctx(tenantA),
      templateId,
      idempotencyKey: "approval:legado",
      values: ARGS,
      base: appDb,
      storageDir: DIR,
    });
    expect(retry.id).toBe(legacy.id);
    expect(retry.number).toBe(legacy.number);
    const after = await suDb.documentTemplate.findUniqueOrThrow({
      where: { id: templateId },
      select: { lastNumber: true },
    });
    expect(after.lastNumber).toBe(before.lastNumber);
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
    const trail = await suDb.auditLog.findMany({
      where: { tenantId: tenantA, target: `document_approval:${fresh}` },
    });
    expect(trail.map((t) => t.action)).toEqual(["document_approval.reject"]);
    expect(JSON.stringify(trail.map((t) => [t.before, t.after]))).not.toContain(
      "preço errado",
    );
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

  test("a template deleted between the read and the request is a terminal refusal", async () => {
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const gone = await createDocumentTemplate(
      ctx(tenantA),
      {
        name: "Some no meio",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
        requiresApproval: true,
      },
      appDb,
    );
    const frozen = await freezeDocumentSnapshot({
      ctx: ctx(tenantA),
      base: appDb,
      templateId: BigInt(gone.id),
      values: ARGS,
      now: new Date(),
    });
    await suDb.documentTemplate.delete({ where: { id: BigInt(gone.id) } });
    const e = await refusal(
      createApprovalRequest({
        ctx: ctx(tenantA),
        base: appDb,
        frozen,
        idempotencyKey: `gone-${gone.id}`,
        now: new Date(),
      }),
    );
    expect(e.translationKey).toBe("errors.documentTemplateNotFound");
  });

  test("a request is not written over a key a document already answers", async () => {
    const key = `raced-${process.pid}`;
    await issueDocument({
      ctx: ctx(tenantA),
      templateId,
      idempotencyKey: key,
      values: ARGS,
      base: appDb,
      storageDir: DIR,
    });
    const frozen = await freezeDocumentSnapshot({
      ctx: ctx(tenantA),
      base: appDb,
      templateId,
      values: ARGS,
      now: new Date(),
    });
    const before = await counts();
    let answered: unknown;
    try {
      await createApprovalRequest({
        ctx: ctx(tenantA),
        base: appDb,
        frozen,
        idempotencyKey: key,
        now: new Date(),
      });
    } catch (e) {
      answered = e;
    }
    expect(answered).toBeInstanceOf(KeyAnswered);
    expect((answered as KeyAnswered).by).toBe("document");
    expect(await counts()).toEqual(before);
  });

  test("an issuance that meets a request written while it decided answers with the request", async () => {
    await updateDocumentTemplate(
      ctx(tenantA),
      templateId,
      { requiresApproval: false },
      appDb,
    );
    const key = `race-issue-${process.pid}`;
    const model = await suDb.documentApprovalRequest.findFirstOrThrow({
      where: { templateId },
    });
    const before = await counts();
    let call: Promise<unknown> | undefined;
    await suDb.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`document-key:${tenantA}:${key}`})::bigint)`;
        call = issueOrRequestApproval({
          ctx: ctx(tenantA),
          base: appDb,
          storageDir: DIR,
          templateId,
          idempotencyKey: key,
          values: ARGS,
          now: new Date(),
        });
        // The call has looked both tables up and is waiting on the key's lock.
        for (let i = 0; i < 200; i++) {
          const [w] = await suDb.$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
          if (Number(w?.n ?? 0) > 0) break;
          await Bun.sleep(25);
        }
        await tx.documentApprovalRequest.create({
          data: {
            tenantId: tenantA,
            templateId,
            title: model.title,
            idempotencyKey: key,
            snapshot: model.snapshot as object,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });
      },
      { timeout: 20_000 },
    );
    const outcome = (await call) as { kind: string };
    await updateDocumentTemplate(
      ctx(tenantA),
      templateId,
      { requiresApproval: true },
      appDb,
    );
    expect(outcome.kind).toBe("approval");
    const after = await counts();
    expect(after.documents).toBe(before.documents);
    expect(after.lastNumber).toBe(before.lastNumber);
  });

  test("a repeated call is told what became of its request", async () => {
    const args = { ...ARGS, cliente: "Repetido" };
    await tool(newTurnState(), 70).invoke(args);
    const id = await latestRequestId();
    await rejectDocumentRequest({
      ctx: ctx(tenantA),
      requestId: id,
      base: appDb,
    });
    const rejected = String(await tool(newTurnState(), 70).invoke(args));
    expect(rejected).toContain("não aprovou");
    await suDb.documentApprovalRequest.update({
      where: { id },
      data: { status: "PENDING", expiresAt: new Date(Date.now() - 1_000) },
    });
    const lapsed = String(await tool(newTurnState(), 70).invoke(args));
    expect(lapsed).toContain("venceu");
    await suDb.documentApprovalRequest.update({
      where: { id },
      data: { status: "REJECTED" },
    });
  });

  test("approval never adopts a document written under a key that predates the request", async () => {
    await tool(newTurnState(), 80).invoke({ ...ARGS, cliente: "Legado" });
    const id = await latestRequestId();
    // A row an older build could have written: the REST route accepted any key before the prefix
    // was reserved.
    const planted = await issueDocument({
      ctx: ctx(tenantA),
      templateId,
      idempotencyKey: `x-${id}`,
      values: { ...ARGS, cliente: "Outro cliente" },
      base: appDb,
      storageDir: DIR,
    });
    await suDb.issuedDocument.update({
      where: { id: BigInt(planted.id) },
      data: { idempotencyKey: `approval:${id}` },
    });
    const { document } = await approveDocumentRequest({
      ctx: ctx(tenantA),
      requestId: id,
      base: appDb,
      storageDir: DIR,
    });
    expect(document.id).not.toBe(planted.id);
    const issued = await suDb.issuedDocument.findUniqueOrThrow({
      where: { id: BigInt(document.id) },
    });
    expect(
      (issued.snapshot as { values?: { cliente?: string } }).values?.cliente,
    ).toBe("Legado");
  });

  test("listing and reading a request leave the frozen snapshot in the database", async () => {
    await tool(newTurnState(), 81).invoke({ ...ARGS, cliente: "Leve" });
    const id = await latestRequestId();
    // Its own client, because the shared one is built without the query log and the claim is about
    // what Postgres was asked.
    const espiao = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
      log: [{ emit: "event", level: "query" }],
    } as never) as unknown as PrismaClient;
    const sql: string[] = [];
    (
      espiao as unknown as {
        $on: (e: string, f: (q: { query: string }) => void) => void;
      }
    ).$on("query", (q) => {
      if (q.query.includes("document_approval_requests")) sql.push(q.query);
    });
    try {
      const listed = await listApprovalRequests(ctx(tenantA), {}, espiao);
      expect(listed.some((r) => r.id === String(id))).toBe(true);
      const read = await getApprovalRequest(ctx(tenantA), id, espiao);
      expect(read.id).toBe(String(id));
      const metadata = sql.splice(0);
      expect(metadata.length).toBeGreaterThanOrEqual(2);
      for (const q of metadata) expect(q).not.toContain('"snapshot"');
      await renderApprovalPreview(ctx(tenantA), id, espiao);
      expect(sql.some((q) => q.includes('"snapshot"'))).toBe(true);
    } finally {
      await espiao.$disconnect();
    }
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
    const approvedBefore = (
      await suDb.documentApprovalRequest.findMany({
        where: { templateId, status: "APPROVED" },
        select: { id: true },
      })
    ).map((r) => r.id);
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
    expect(approvedBefore.length).toBeGreaterThan(0);
    for (const approved of approvedBefore) {
      expect(by.get(approved)).toBe("APPROVED");
    }
    expect(await counts()).toEqual(before);
  });
});
