import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  issueDocument,
  pageIssuedDocuments,
  revokeIssuedDocument,
} from "@/modules/documents/issue";
import {
  createDocumentTemplate,
  updateDocumentTemplate,
} from "@/modules/documents/templates";
import { issuedDocumentList } from "@/modules/mcp/read";

// The issued list answers "the customer is calling about ORC-0005": a search over the printed number
// (as the customer reads it) or the title, across every document of the tenant and not the page on
// screen, a cursor that reaches all of them, and the approval each one came from.

const BLOCKS = [{ id: "corpo", type: "text", text: "Olá {{cliente}}." }];
const FIELDS = [{ name: "cliente", type: "text", label: "Cliente" }];

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

const DIR = `${process.env.HOME}/.local/state/test-artifacts/issued-document-list-${process.pid}`;
let tenantA = 0n;
let tenantB = 0n;
let seq = 0;

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

async function template(t: bigint, name: string, prefix: string) {
  const tpl = await createDocumentTemplate(
    ctx(t),
    {
      name: `${name} ${process.pid}`,
      blocks: BLOCKS,
      fields: FIELDS,
      numberPrefix: prefix,
    },
    appDb,
  );
  return BigInt(tpl.id);
}

async function issue(t: bigint, templateId: bigint) {
  seq += 1;
  return issueDocument({
    ctx: ctx(t),
    templateId,
    idempotencyKey: `list-${process.pid}-${seq}`,
    values: { cliente: "Ana" },
    base: appDb,
    storageDir: DIR,
  });
}

const numbers = (docs: { number: string }[]) => docs.map((d) => d.number);

describe.skipIf(!dbUp)("issued document list", () => {
  let quote = 0n;
  let receipt = 0n;
  // ORC-0001..ORC-0025 and REC-0001..REC-0003, oldest first.
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    tenantA = (
      await suDb.tenant.create({
        data: { name: "ListA", slug: `list-a-${process.pid}` },
      })
    ).id;
    tenantB = (
      await suDb.tenant.create({
        data: { name: "ListB", slug: `list-b-${process.pid}` },
      })
    ).id;
    quote = await template(tenantA, "Orçamento", "ORC-");
    receipt = await template(tenantA, "Recibo 10%_off", "REC-");
    for (let i = 0; i < 25; i++) {
      const d = await issue(tenantA, quote);
      ids[d.number] = d.id;
    }
    for (let i = 0; i < 3; i++) {
      const d = await issue(tenantA, receipt);
      ids[d.number] = d.id;
    }
    // The other tenant prints the same numbers.
    const theirs = await template(tenantB, "Orçamento", "ORC-");
    for (let i = 0; i < 5; i++) await issue(tenantB, theirs);
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      for (const table of [
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

  test("a search reaches a document past the first page, by printed number, counter or title", async () => {
    const first = await pageIssuedDocuments(ctx(tenantA), { limit: 20 }, appDb);
    expect(numbers(first.documents)).not.toContain("ORC-0002");
    const full = await pageIssuedDocuments(
      ctx(tenantA),
      { limit: 20, query: "ORC-0002" },
      appDb,
    );
    expect(numbers(full.documents)).toEqual(["ORC-0002"]);
    expect(full.nextBefore).toBeNull();
    // Case does not matter, and the counter alone finds it among the others that contain it.
    const lower = await pageIssuedDocuments(
      ctx(tenantA),
      { query: "orc-0002" },
      appDb,
    );
    expect(numbers(lower.documents)).toEqual(["ORC-0002"]);
    const counter = await pageIssuedDocuments(
      ctx(tenantA),
      { query: "2" },
      appDb,
    );
    expect(numbers(counter.documents)).toContain("ORC-0002");
    expect(numbers(counter.documents)).toContain("REC-0002");
    const title = await pageIssuedDocuments(
      ctx(tenantA),
      { query: "recibo" },
      appDb,
    );
    expect(numbers(title.documents)).toEqual([
      "REC-0003",
      "REC-0002",
      "REC-0001",
    ]);
    const none = await pageIssuedDocuments(
      ctx(tenantA),
      { query: "XYZ-9999" },
      appDb,
    );
    expect(none.documents).toEqual([]);
    expect(none.nextBefore).toBeNull();
  });

  test("LIKE wildcards in a search are text", async () => {
    const percent = await pageIssuedDocuments(
      ctx(tenantA),
      { query: "%" },
      appDb,
    );
    expect(numbers(percent.documents)).toEqual([
      "REC-0003",
      "REC-0002",
      "REC-0001",
    ]);
    const underscore = await pageIssuedDocuments(
      ctx(tenantA),
      { query: "%_off" },
      appDb,
    );
    expect(underscore.documents).toHaveLength(3);
    const lone = await pageIssuedDocuments(ctx(tenantA), { query: "_" }, appDb);
    expect(lone.documents).toHaveLength(3);
  });

  test("the cursor walks every document of the tenant exactly once, with and without a search", async () => {
    const seen: string[] = [];
    let before: bigint | undefined;
    for (;;) {
      const page = await pageIssuedDocuments(
        ctx(tenantA),
        { limit: 7, before },
        appDb,
      );
      seen.push(...numbers(page.documents));
      if (!page.nextBefore) break;
      before = BigInt(page.nextBefore);
    }
    expect(seen).toHaveLength(28);
    expect(new Set(seen).size).toBe(28);
    expect(seen[0]).toBe("REC-0003");
    expect(seen.at(-1)).toBe("ORC-0001");

    const matched: string[] = [];
    before = undefined;
    for (;;) {
      const page = await pageIssuedDocuments(
        ctx(tenantA),
        { limit: 2, before, query: "ORC-001" },
        appDb,
      );
      matched.push(...numbers(page.documents));
      if (!page.nextBefore) break;
      before = BigInt(page.nextBefore);
    }
    expect(matched).toEqual([
      "ORC-0019",
      "ORC-0018",
      "ORC-0017",
      "ORC-0016",
      "ORC-0015",
      "ORC-0014",
      "ORC-0013",
      "ORC-0012",
      "ORC-0011",
      "ORC-0010",
    ]);
  });

  test("a full last page says there is nothing after it", async () => {
    const page = await pageIssuedDocuments(
      ctx(tenantA),
      { limit: 3, query: "recibo" },
      appDb,
    );
    expect(page.documents).toHaveLength(3);
    expect(page.nextBefore).toBeNull();
  });

  test("a search stays in its tenant", async () => {
    const mine = await pageIssuedDocuments(
      ctx(tenantB),
      { query: "ORC-0002" },
      appDb,
    );
    expect(mine.documents).toHaveLength(1);
    expect(mine.documents[0]?.id).not.toBe(ids["ORC-0002"]);
    const past = await pageIssuedDocuments(
      ctx(tenantB),
      { query: "ORC-0020" },
      appDb,
    );
    expect(past.documents).toEqual([]);
  });

  test("the printed prefix is the one frozen on the document, and a revoked one is still found", async () => {
    await updateDocumentTemplate(
      ctx(tenantA),
      receipt,
      { numberPrefix: "RCB-" },
      appDb,
    );
    const old = await pageIssuedDocuments(
      ctx(tenantA),
      { query: "REC-0001" },
      appDb,
    );
    expect(numbers(old.documents)).toEqual(["REC-0001"]);
    const renamed = await pageIssuedDocuments(
      ctx(tenantA),
      { query: "RCB-0001" },
      appDb,
    );
    expect(renamed.documents).toEqual([]);
    await revokeIssuedDocument(
      ctx(tenantA),
      BigInt(ids["REC-0001"] as string),
      appDb,
    );
    const revoked = await pageIssuedDocuments(
      ctx(tenantA),
      { query: "REC-0001" },
      appDb,
    );
    expect(revoked.documents[0]?.revoked).toBe(true);
  });

  test("a document names the approval it was issued from, and only that one", async () => {
    const approved = ids["ORC-0003"] as string;
    const request = await suDb.documentApprovalRequest.create({
      data: {
        tenantId: tenantA,
        templateId: quote,
        title: "Orçamento",
        idempotencyKey: `list-approval-${process.pid}`,
        status: "APPROVED",
        expiresAt: new Date(Date.now() + 86_400_000),
        issuedDocumentId: BigInt(approved),
      },
    });
    const page = await pageIssuedDocuments(
      ctx(tenantA),
      { query: "ORC-000" },
      appDb,
    );
    const byNumber = new Map(page.documents.map((d) => [d.number, d]));
    expect(byNumber.get("ORC-0003")?.approvalRequestId).toBe(
      String(request.id),
    );
    expect(byNumber.get("ORC-0004")?.approvalRequestId).toBeNull();
  });

  test("the MCP read takes the same search and cursor", async () => {
    const principal = {
      userId: 1n,
      tenantId: tenantA,
      role: "TENANT_ADMIN" as const,
      scopes: ["mcp:read"],
      clientId: "c",
      jti: "j",
    };
    const found = await issuedDocumentList(
      principal,
      { q: "ORC-0002" },
      { base: appDb },
    );
    if (!found.ok) throw new Error("the read was refused");
    const docs = (found.data as { documents: { number: string }[] }).documents;
    expect(numbers(docs)).toEqual(["ORC-0002"]);
    const older = await issuedDocumentList(
      principal,
      { before: ids["ORC-0003"], limit: 5 },
      { base: appDb },
    );
    if (!older.ok) throw new Error("the read was refused");
    expect(
      numbers((older.data as { documents: { number: string }[] }).documents),
    ).toEqual(["ORC-0002", "ORC-0001"]);
    // Where the next page starts, as the REST list answers it: null exactly on the last page.
    const walked: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await issuedDocumentList(
        principal,
        { limit: 7, ...(cursor ? { before: cursor } : {}) },
        { base: appDb },
      );
      if (!page.ok) throw new Error("the read was refused");
      const data = page.data as {
        documents: { number: string }[];
        nextBefore: string | null;
      };
      walked.push(...numbers(data.documents));
      if (!data.nextBefore) break;
      cursor = data.nextBefore;
    }
    expect(walked).toHaveLength(28);
    expect(new Set(walked).size).toBe(28);
    const full = await issuedDocumentList(
      principal,
      { q: "recibo", limit: 3 },
      { base: appDb },
    );
    if (!full.ok) throw new Error("the read was refused");
    expect((full.data as { nextBefore: string | null }).nextBefore).toBeNull();
    const bad = await issuedDocumentList(
      principal,
      { before: "abc" },
      { base: appDb },
    );
    expect(bad.ok).toBe(false);
  });
});
