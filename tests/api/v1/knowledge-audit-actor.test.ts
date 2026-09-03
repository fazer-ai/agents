import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// The knowledge family's trail, driven through the console's own doors (issue #396).
//
// `tests/modules/audit-knowledge-family.test.ts` proves the SERVICES record. This file answers the
// half it cannot see: whether the twelve mutating routes of `knowledge.controller.ts` reach those
// services with a principal at all. None of them wrote anything before this, and one of them
// (`PATCH /documents/:id`) had no MCP twin either, so the console was its ONLY door and it recorded
// nothing.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

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

setupPrismaMock();

const BODY = "corpo-do-documento-9396-rest";
const PROPOSAL = "proposta-do-agente-9396-rest";

const documents = await import("@/modules/rag/documents");
const service = await import("@/modules/rag/service");
// COPIES taken before the mocks are installed: Bun updates the imported namespace in place, so a
// wrapper that called the module by name would call itself.
const realDocs = { ...documents };
const realSvc = { ...service };

mock.module("@/modules/rag/documents", () => ({
  ...realDocs,
  createDocument: mock((p: Parameters<typeof documents.createDocument>[0]) =>
    realDocs.createDocument({ ...p, base: app }),
  ),
  updateDocument: mock(
    (
      ctx: TenantContext,
      id: bigint,
      p: Parameters<typeof documents.updateDocument>[2],
    ) => realDocs.updateDocument(ctx, id, p, app),
  ),
  deleteDocument: mock((ctx: TenantContext, id: bigint) =>
    realDocs.deleteDocument(ctx, id, app),
  ),
  retryDocument: mock((ctx: TenantContext, id: bigint) =>
    realDocs.retryDocument(ctx, id, app),
  ),
  reindexKnowledgeBase: mock(
    (
      ctx: TenantContext,
      id: bigint,
      _base: unknown,
      opts: Parameters<typeof documents.reindexKnowledgeBase>[3],
    ) => realDocs.reindexKnowledgeBase(ctx, id, app, opts),
  ),
  listDocuments: (ctx: TenantContext, id: bigint) =>
    realDocs.listDocuments(ctx, id, app),
  getDocument: (ctx: TenantContext, id: bigint) =>
    realDocs.getDocument(ctx, id, app),
  readEmbeddingBlock: (ctx: TenantContext) =>
    realDocs.readEmbeddingBlock(ctx, app),
}));

mock.module("@/modules/rag/service", () => ({
  ...realSvc,
  createKnowledgeBase: mock(
    (p: Parameters<typeof service.createKnowledgeBase>[0]) =>
      realSvc.createKnowledgeBase({ ...p, base: app }),
  ),
  updateKnowledgeBase: mock(
    (p: Parameters<typeof service.updateKnowledgeBase>[0]) =>
      realSvc.updateKnowledgeBase({ ...p, base: app }),
  ),
  deleteKnowledgeBase: mock(
    (p: Parameters<typeof service.deleteKnowledgeBase>[0]) =>
      realSvc.deleteKnowledgeBase({ ...p, base: app }),
  ),
  createSuggestion: mock((p: Parameters<typeof service.createSuggestion>[0]) =>
    realSvc.createSuggestion({ ...p, base: app }),
  ),
  editApprovalItem: mock((p: Parameters<typeof service.editApprovalItem>[0]) =>
    realSvc.editApprovalItem({ ...p, base: app }),
  ),
  approveApprovalItem: mock(
    (p: Parameters<typeof service.approveApprovalItem>[0]) =>
      realSvc.approveApprovalItem({ ...p, base: app }),
  ),
  rejectApprovalItem: mock(
    (p: Parameters<typeof service.rejectApprovalItem>[0]) =>
      realSvc.rejectApprovalItem({ ...p, base: app }),
  ),
  listKnowledgeBases: (ctx: TenantContext) =>
    realSvc.listKnowledgeBases(ctx, app),
  getKnowledgeBase: (p: Parameters<typeof service.getKnowledgeBase>[0]) =>
    realSvc.getKnowledgeBase({ ...p, base: app }),
  listPendingApprovals: (ctx: TenantContext) =>
    realSvc.listPendingApprovals(ctx, app),
}));

const server = (await import("@/app")).default;

// TOP-LEVEL, outside the describe: an `afterAll` inside a `describe.skipIf(...)` that skips does NOT
// run, while this one does, and the wrappers are already installed for the whole worker.
afterAll(() => {
  mock.module("@/modules/rag/documents", () => realDocs);
  mock.module("@/modules/rag/service", () => realSvc);
});

const ADMIN_ID = 9397n;
let tenantId = 0n;
let cookie = "";

const rows = async () =>
  (await su?.auditLog.findMany({
    where: { tenantId },
    orderBy: { id: "asc" },
  })) ?? [];

async function clearAudit() {
  await su?.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
  );
}

function req(path: string, init: RequestInit = {}): Request {
  return new BunRequest(`http://localhost/api/v1/knowledge${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...init.headers },
  });
}

// The routes answer BigInts as strings, and only the id is read back here.
async function idFrom(r: Response, key: string): Promise<string> {
  const body = (await r.json()) as Record<string, { id: string } | undefined>;
  const found = body[key];
  if (!found) throw new Error(`no ${key} in the response`);
  return found.id;
}

describe.skipIf(!dbUp)("the Knowledge page names who wrote", () => {
  beforeAll(async () => {
    if (!su || !app) return;
    const t = await su.tenant.create({
      data: { name: "KBREST", slug: `kbrest-${process.pid}` },
    });
    tenantId = t.id;
    const entry = await su.vaultEntry.create({
      data: {
        tenantId,
        name: `emb-${process.pid}`,
        kind: "openai",
        status: "active",
        secret: encryptJson("sk-embedding-9397"),
      },
      select: { id: true },
    });
    await su.tenant.update({
      where: { id: tenantId },
      data: { settings: { embedding: { credentialRef: `vault:${entry.id}` } } },
    });
    mockFindUnique.mockImplementation(() =>
      Promise.resolve({
        id: ADMIN_ID,
        tenantId,
        email: "admin@example.com",
        passwordHash: "x",
        googleId: null,
        name: null,
        role: "TENANT_ADMIN" as const,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const token = await new SignJWT({
      userId: ADMIN_ID.toString(),
      email: "admin@example.com",
      role: "TENANT_ADMIN",
      tenantId: tenantId.toString(),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(config.jwtSecret));
    cookie = `fazerai_auth_token=${token}`;
    await clearAudit();
  });

  afterAll(async () => {
    // `dbUp`, not `su`: the probe assigns the client and only then checks the connection, so a
    // configured-but-unreachable database leaves `su` truthy while the suite skips.
    if (dbUp && su && tenantId) {
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("the whole knowledge journey, from the console, names the operator on every row", async () => {
    await clearAudit();

    // One test rather than twelve because the state is a chain: a document needs a base, an
    // approval needs a suggestion, and splitting it would rebuild the chain per case.
    const created = await server.handle(
      req("/bases", {
        method: "POST",
        body: JSON.stringify({ name: "Base REST", description: "d" }),
      }),
    );
    expect(created.status).toBe(200);
    const kbId = await idFrom(created, "base");

    expect(
      (
        await server.handle(
          req(`/bases/${kbId}`, {
            method: "PATCH",
            body: JSON.stringify({ name: "Base REST revisada" }),
          }),
        )
      ).status,
    ).toBe(200);

    const doc = await server.handle(
      req(`/bases/${kbId}/documents`, {
        method: "POST",
        body: JSON.stringify({ title: "Documento", text: BODY }),
      }),
    );
    expect(doc.status).toBe(200);
    const docId = await idFrom(doc, "document");

    expect(
      (
        await server.handle(
          req(`/documents/${docId}`, {
            method: "PATCH",
            body: JSON.stringify({ text: `${BODY} revisado` }),
          }),
        )
      ).status,
    ).toBe(200);

    // The retry route only opens on a document the ingest already gave up on.
    await su?.knowledgeDocument.update({
      where: { id: BigInt(docId) },
      data: { status: "FAILED", error: "boom" },
    });
    expect(
      (
        await server.handle(
          req(`/documents/${docId}/retry`, { method: "POST" }),
        )
      ).status,
    ).toBe(200);

    await su?.knowledgeDocument.update({
      where: { id: BigInt(docId) },
      data: { status: "UNINDEXED" },
    });
    expect(
      (await server.handle(req(`/bases/${kbId}/reindex`, { method: "POST" })))
        .status,
    ).toBe(200);

    const suggested = await server.handle(
      req("/suggestions", {
        method: "POST",
        body: JSON.stringify({
          knowledgeBaseId: kbId,
          title: "Sugestão",
          content: PROPOSAL,
          rationale: "porque sim",
        }),
      }),
    );
    expect(suggested.status).toBe(200);
    const approvalId = await idFrom(suggested, "suggestion");

    expect(
      (
        await server.handle(
          req(`/approvals/${approvalId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: "Sugestão revisada" }),
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await server.handle(
          req(`/approvals/${approvalId}/approve`, { method: "POST" }),
        )
      ).status,
    ).toBe(200);

    const rejected = await server.handle(
      req("/suggestions", {
        method: "POST",
        body: JSON.stringify({
          knowledgeBaseId: kbId,
          title: "Outra sugestão",
          content: PROPOSAL,
        }),
      }),
    );
    const rejectId = await idFrom(rejected, "suggestion");
    expect(
      (
        await server.handle(
          req(`/approvals/${rejectId}/reject`, { method: "POST" }),
        )
      ).status,
    ).toBe(200);

    expect(
      (await server.handle(req(`/documents/${docId}`, { method: "DELETE" })))
        .status,
    ).toBe(200);
    expect(
      (await server.handle(req(`/bases/${kbId}`, { method: "DELETE" }))).status,
    ).toBe(200);

    const all = await rows();
    expect(all.map((r) => r.action)).toEqual([
      "knowledge.create",
      "knowledge.update",
      "knowledge_document.create",
      "knowledge_document.update",
      "knowledge_document.retry",
      "knowledge.reindex",
      // No row for the suggestion: it is a proposal, and the queue item is its record until
      // somebody decides.
      "knowledge.edit",
      "knowledge.approve",
      "knowledge_document.create",
      "knowledge.reject",
      "knowledge_document.delete",
      "knowledge.delete",
    ]);
    // The whole point of moving the trail down a layer: the console had no `audit` in it, so every
    // one of these rows exists only because the service writes it, and each names the session that
    // asked.
    for (const r of all) {
      expect(r.actorId).toBe(ADMIN_ID);
      expect(r.actorType).toBe("user");
      expect(r.tenantId).toBe(tenantId);
    }
    const dumped = JSON.stringify(all, (_k, v) =>
      typeof v === "bigint" ? String(v) : v,
    );
    expect(dumped).not.toContain(BODY);
    expect(dumped).not.toContain(PROPOSAL);
  });
});
