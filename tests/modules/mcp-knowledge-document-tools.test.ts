import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  knowledgeDocumentGet,
  knowledgeDocumentsList,
} from "@/modules/mcp/read";
import { knowledgeDocumentUpdate } from "@/modules/mcp/write-knowledge";
import { listDocuments } from "@/modules/rag/documents";

// Issue #708: a document can be read whole and edited in place through the MCP, and the list honours
// the `limit` it used to accept and ignore.

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

let tenantId = 0n;
let otherTenantId = 0n;
let kb = 0n;
let otherKb = 0n;
// A second base of the SAME tenant: its cursor is visible under RLS, so only the base check refuses it.
let siblingKb = 0n;
let doc = 0n;
// Five documents in `kb` besides `doc`, created one second apart so the order is known.
const listed: bigint[] = [];

const principal = (
  t: bigint,
  scopes = ["mcp:read", "mcp:write"],
): VerifiedToken => ({
  userId: 1n,
  tenantId: t,
  role: "TENANT_ADMIN",
  scopes,
  clientId: "c",
  jti: "j",
});
const deps = () => ({ base: appDb });

type Ok<T> = { ok: true; data: T };
function data<T>(r: unknown): T {
  const res = r as Ok<T> | { ok: false; error: string };
  if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
  return res.data;
}

describe.skipIf(!dbUp)("MCP knowledge document tools", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "KD708", slug: `kd-708-${process.pid}` },
      })
    ).id;
    otherTenantId = (
      await suDb.tenant.create({
        data: { name: "KD708B", slug: `kd-708-b-${process.pid}` },
      })
    ).id;
    kb = (
      await suDb.knowledgeBase.create({
        data: { tenantId, name: "Base 708" },
      })
    ).id;
    otherKb = (
      await suDb.knowledgeBase.create({
        data: { tenantId: otherTenantId, name: "Other 708" },
      })
    ).id;
    siblingKb = (
      await suDb.knowledgeBase.create({
        data: { tenantId, name: "Sibling 708" },
      })
    ).id;
    const base = Date.UTC(2026, 8, 1);
    const mk = async (title: string, i: number, kbId = kb, t = tenantId) =>
      (
        await suDb.knowledgeDocument.create({
          data: {
            tenantId: t,
            knowledgeBaseId: kbId,
            title,
            sourceType: "text",
            content: `${title} body`,
            status: "INDEXED",
            chunkCount: 1,
            createdAt: new Date(base + i * 1000),
          },
        })
      ).id;
    doc = await mk("Horários", 0);
    for (let i = 1; i <= 5; i++) listed.push(await mk(`Doc ${i}`, i));
    await mk("Alheio", 9, otherKb, otherTenantId);
    await mk("Irmão", 10, siblingKb);
  });

  afterAll(async () => {
    for (const tid of [tenantId, otherTenantId]) {
      if (!tid) continue;
      for (const tbl of [
        "scheduler_jobs",
        "audit_logs",
        "knowledge_documents",
        "knowledge_bases",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("knowledge_document_get returns the document with its whole text", async () => {
    const r = data<{ document: Record<string, unknown> }>(
      await knowledgeDocumentGet(
        principal(tenantId, ["mcp:read"]),
        { document_id: String(doc) },
        deps(),
      ),
    );
    expect(r.document.id).toBe(String(doc));
    expect(r.document.knowledgeBaseId).toBe(String(kb));
    expect(r.document.title).toBe("Horários");
    expect(r.document.content).toBe("Horários body");
  });

  test("knowledge_document_get does not reach another tenant's document", async () => {
    const r = await knowledgeDocumentGet(
      principal(otherTenantId, ["mcp:read"]),
      { document_id: String(doc) },
      deps(),
    );
    expect(r.ok).toBe(false);
  });

  test("knowledge_document_update previews by default and changes nothing", async () => {
    const r = data<Record<string, unknown>>(
      await knowledgeDocumentUpdate(
        principal(tenantId),
        { document_id: String(doc), text: "Abrimos às 8h" },
        deps(),
      ),
    );
    expect(r.dryRun).toBe(true);
    expect(r.reindexes).toBe(true);
    const row = await suDb.knowledgeDocument.findUniqueOrThrow({
      where: { id: doc },
    });
    expect(row.content).toBe("Horários body");
    expect(row.status).toBe("INDEXED");
  });

  // Issue #857: the title is part of every chunk's vector, so renaming re-embeds.
  test("a title-only edit keeps the id and re-indexes", async () => {
    const preview = data<Record<string, unknown>>(
      await knowledgeDocumentUpdate(
        principal(tenantId),
        { document_id: String(doc), title: "Horário de atendimento" },
        deps(),
      ),
    );
    expect(preview.reindexes).toBe(true);
    const r = data<Record<string, unknown>>(
      await knowledgeDocumentUpdate(
        principal(tenantId),
        {
          document_id: String(doc),
          title: "Horário de atendimento",
          dry_run: false,
        },
        deps(),
      ),
    );
    expect(r.applied).toBe(true);
    const row = await suDb.knowledgeDocument.findUniqueOrThrow({
      where: { id: doc },
    });
    expect(row.title).toBe("Horário de atendimento");
    expect(row.status).toBe("PENDING");
  });

  // The preview must refuse what the apply refuses: a title of spaces passes the empty-string check
  // but not the service's blank one, so a preview that said ok would promise an edit that fails.
  test("a blank title is refused by the preview and by the apply alike", async () => {
    for (const dry_run of [undefined, false]) {
      const r = (await knowledgeDocumentUpdate(
        principal(tenantId),
        { document_id: String(doc), title: "   ", dry_run },
        deps(),
      )) as { ok: boolean; error?: string };
      expect(r.ok).toBe(false);
      expect(r.error).toContain("title must not be blank");
    }
  });

  test("a text edit keeps the id, re-queues the document, and is audited", async () => {
    const r = data<Record<string, unknown>>(
      await knowledgeDocumentUpdate(
        principal(tenantId),
        { document_id: String(doc), text: "Abrimos às 8h", dry_run: false },
        deps(),
      ),
    );
    expect(r.applied).toBe(true);
    expect(r.status).toBe("PENDING");
    const row = await suDb.knowledgeDocument.findUniqueOrThrow({
      where: { id: doc },
    });
    expect(row.content).toBe("Abrimos às 8h");
    const job = await suDb.schedulerJob.findFirst({
      where: { tenantId, kind: "RAG_INGEST", dedupeKey: `doc:${doc}` },
    });
    expect(job).not.toBeNull();
    const audit = await suDb.auditLog.findFirst({
      where: {
        tenantId,
        action: "knowledge_document.update",
        target: `knowledge_document:${doc}`,
      },
    });
    expect(audit).not.toBeNull();
  });

  test("an update with nothing to change is refused, even as a preview", async () => {
    for (const dry_run of [undefined, false]) {
      const r = await knowledgeDocumentUpdate(
        principal(tenantId),
        { document_id: String(doc), dry_run },
        deps(),
      );
      expect(r.ok).toBe(false);
    }
  });

  // Review round 3: the REST twin refuses an empty field, and an empty text would wipe the content.
  test("an empty title or text is refused, on preview and on apply", async () => {
    for (const empty of [{ title: "" }, { text: "" }]) {
      for (const dry_run of [undefined, false]) {
        const r = await knowledgeDocumentUpdate(
          principal(tenantId),
          { document_id: String(doc), ...empty, dry_run },
          deps(),
        );
        expect(r.ok).toBe(false);
      }
    }
    const row = await suDb.knowledgeDocument.findUniqueOrThrow({
      where: { id: doc },
    });
    expect(row.content.length).toBeGreaterThan(0);
  });

  // Review round 1: the apply refuses a NUL or a lone surrogate, so the preview must too, or it
  // approves an edit that cannot happen.
  test("a text the column cannot hold is refused by the preview, not only by the apply", async () => {
    for (const bad of [{ text: "a\u0000b" }, { title: "x\uD800" }]) {
      const r = await knowledgeDocumentUpdate(
        principal(tenantId),
        { document_id: String(doc), ...bad },
        deps(),
      );
      expect(r.ok).toBe(false);
    }
  });

  // The service re-embeds only a text that moved, so the preview must not promise more.
  test("a preview with the current text does not promise a re-index", async () => {
    const row = await suDb.knowledgeDocument.findUniqueOrThrow({
      where: { id: doc },
    });
    const r = data<Record<string, unknown>>(
      await knowledgeDocumentUpdate(
        principal(tenantId),
        { document_id: String(doc), text: row.content },
        deps(),
      ),
    );
    expect(r.reindexes).toBe(false);
  });

  test("a read-only token cannot edit", async () => {
    const r = await knowledgeDocumentUpdate(
      principal(tenantId, ["mcp:read"]),
      { document_id: String(doc), title: "x", dry_run: false },
      deps(),
    );
    expect(r.ok).toBe(false);
  });

  test("the list honours limit and pages with the cursor, newest first", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = data<{
        documents: { id: string }[];
        nextCursor: string | null;
      }>(
        await knowledgeDocumentsList(
          principal(tenantId, ["mcp:read"]),
          { knowledge_base_id: String(kb), limit: 2, cursor },
          deps(),
        ),
      );
      expect(page.documents.length).toBeLessThanOrEqual(2);
      seen.push(...page.documents.map((d) => d.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([...listed].reverse().map(String).concat(String(doc)));
  });

  test("without limit the list is the whole base, and says there is no next page", async () => {
    const page = data<{ documents: unknown[]; nextCursor: string | null }>(
      await knowledgeDocumentsList(
        principal(tenantId, ["mcp:read"]),
        { knowledge_base_id: String(kb) },
        deps(),
      ),
    );
    expect(page.documents).toHaveLength(6);
    expect(page.nextCursor).toBeNull();
  });

  test("a forged cursor, or a bad limit, is refused rather than restarting the list", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
    for (const cursor of ["abc", String(doc), "1_", "_1", "1_2_3"]) {
      await expect(
        listDocuments(ctx, kb, appDb, { limit: 2, cursor }),
      ).rejects.toThrow("cursor");
    }
    await expect(listDocuments(ctx, kb, appDb, { limit: 0 })).rejects.toThrow(
      "limit",
    );
  });

  // The client this exists for is a sync, and a sync edits the base while it reads it.
  test("deleting the row a cursor stopped at does not end the walk", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
    const extra: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      extra.push(
        (
          await suDb.knowledgeDocument.create({
            data: {
              tenantId,
              knowledgeBaseId: siblingKb,
              title: `Walk ${i}`,
              sourceType: "text",
              content: "w",
              status: "INDEXED",
              createdAt: new Date(Date.UTC(2026, 7, 1) + i * 1000),
            },
          })
        ).id,
      );
    }
    const first = await listDocuments(ctx, siblingKb, appDb, { limit: 2 });
    const stoppedAt = first.documents.at(-1)?.id;
    expect(first.nextCursor).not.toBeNull();
    await suDb.knowledgeDocument.delete({ where: { id: stoppedAt as bigint } });
    const second = await listDocuments(ctx, siblingKb, appDb, {
      limit: 2,
      cursor: first.nextCursor as string,
    });
    const seen = [...first.documents, ...second.documents].map((d) => d.id);
    // Every row that still exists was read once, and nothing was read twice.
    const remaining = await suDb.knowledgeDocument.findMany({
      where: { knowledgeBaseId: siblingKb },
      select: { id: true },
    });
    for (const r of remaining) expect(seen).toContain(r.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(extra.length).toBe(3);
  });
});
