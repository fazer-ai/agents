import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { issueDocument } from "@/modules/documents/issue";
import {
  createDocumentTemplate,
  documentTemplateWriteProblem,
  getDocumentTemplate,
  listDocumentTemplates,
  nextNumberUnderPrefix,
  updateDocumentTemplate,
} from "@/modules/documents/templates";
import { documentTemplateUpdate } from "@/modules/mcp/write-documents";

// A printed number (prefix and counter, within a tenant) names one document and is never issued twice
// (docs/documents.md, Numbering): the template shows where numbering continues, an operator can move
// it forward or back down to just above the highest number issued, and issuance follows the tenant's
// prefix rather than the template's counter alone.

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

const DIR = `${process.env.HOME}/.local/state/test-artifacts/document-numbering-${process.pid}`;
let tenantA = 0n;
let tenantB = 0n;
let seq = 0;

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

async function template(t: bigint, prefix: string | null, extra = {}) {
  seq += 1;
  const tpl = await createDocumentTemplate(
    ctx(t),
    {
      name: `Numeração ${process.pid} ${seq}`,
      blocks: BLOCKS,
      fields: FIELDS,
      numberPrefix: prefix,
      ...extra,
    },
    appDb,
  );
  return BigInt(tpl.id);
}

async function issue(t: bigint, templateId: bigint) {
  seq += 1;
  const doc = await issueDocument({
    ctx: ctx(t),
    templateId,
    idempotencyKey: `num-${process.pid}-${seq}`,
    values: { cliente: "Ana" },
    base: appDb,
    storageDir: DIR,
  });
  return doc.number;
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

describe.skipIf(!dbUp)("document numbering", () => {
  beforeAll(async () => {
    tenantA = (
      await suDb.tenant.create({
        data: { name: "NumA", slug: `num-a-${process.pid}` },
      })
    ).id;
    tenantB = (
      await suDb.tenant.create({
        data: { name: "NumB", slug: `num-b-${process.pid}` },
      })
    ).id;
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      for (const table of [
        "audit_logs",
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

  test("the template says where numbering continues, and an operator moves it", async () => {
    const id = await template(tenantA, "PRO-");
    expect(
      (await getDocumentTemplate(ctx(tenantA), id, appDb)).nextNumber,
    ).toBe(1);
    const moved = await updateDocumentTemplate(
      ctx(tenantA),
      id,
      { nextNumber: 1500 },
      appDb,
    );
    expect(moved.nextNumber).toBe(1500);
    expect(await issue(tenantA, id)).toBe("PRO-1500");
    expect(await issue(tenantA, id)).toBe("PRO-1501");
    // Down again, as far as one above the highest issued, and no further.
    const back = await updateDocumentTemplate(
      ctx(tenantA),
      id,
      { nextNumber: 1502 },
      appDb,
    );
    expect(back.nextNumber).toBe(1502);
    const refused = await refusal(
      updateDocumentTemplate(ctx(tenantA), id, { nextNumber: 1501 }, appDb),
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.message).toContain("PRO-1501");
    expect(refused.message).toContain("change the prefix");
    // The dry run answers the same, before anything is written.
    expect(
      await documentTemplateWriteProblem(
        ctx(tenantA),
        { nextNumber: 1501 },
        appDb,
        { deriveSlugFromName: false, excludeId: id },
      ),
    ).toContain("PRO-1501");
    expect(
      await documentTemplateWriteProblem(
        ctx(tenantA),
        { nextNumber: 1502 },
        appDb,
        { deriveSlugFromName: false, excludeId: id },
      ),
    ).toBeNull();
    // A new prefix starts its own sequence.
    const fresh = await updateDocumentTemplate(
      ctx(tenantA),
      id,
      { numberPrefix: "PRO2-", nextNumber: 1 },
      appDb,
    );
    expect(fresh.nextNumber).toBe(1);
    expect(await issue(tenantA, id)).toBe("PRO2-0001");
  });

  test("two templates on one prefix never print the same number", async () => {
    const first = await template(tenantA, "DUP-");
    const second = await template(tenantA, "DUP-");
    expect(await issue(tenantA, first)).toBe("DUP-0001");
    expect(await issue(tenantA, first)).toBe("DUP-0002");
    // The second template's own counter is still 0; the prefix's sequence is at 2.
    expect(
      (await getDocumentTemplate(ctx(tenantA), second, appDb)).nextNumber,
    ).toBe(3);
    expect(await issue(tenantA, second)).toBe("DUP-0003");
    expect(await issue(tenantA, first)).toBe("DUP-0004");
    const listed = await listDocumentTemplates(ctx(tenantA), appDb);
    expect(listed.find((t) => t.id === String(second))?.nextNumber).toBe(5);
    // Setting the number through the other template is checked against the whole prefix.
    const refused = await refusal(
      updateDocumentTemplate(ctx(tenantA), second, { nextNumber: 4 }, appDb),
    );
    expect(refused.statusCode).toBe(409);
  });

  test("concurrent issuances from two templates on one prefix take distinct numbers", async () => {
    const a = await template(tenantA, "RACE-");
    const b = await template(tenantA, "RACE-");
    const numbers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => issue(tenantA, i % 2 ? a : b)),
    );
    expect(new Set(numbers).size).toBe(8);
  });

  test("a prefix moved onto one already used, and a new template on it, continue past it", async () => {
    const old = await template(tenantA, "MOV-");
    await issue(tenantA, old);
    await issue(tenantA, old);
    const other = await template(tenantA, "OUTRO-");
    await updateDocumentTemplate(
      ctx(tenantA),
      other,
      { numberPrefix: "MOV-" },
      appDb,
    );
    expect(await issue(tenantA, other)).toBe("MOV-0003");
    const created = await template(tenantA, "MOV-");
    expect(
      (await getDocumentTemplate(ctx(tenantA), created, appDb)).nextNumber,
    ).toBe(4);
    // Created with a number already printed under the prefix: refused, nothing created.
    const refused = await refusal(template(tenantA, "MOV-", { nextNumber: 2 }));
    expect(refused.statusCode).toBe(409);
  });

  test("another tenant's numbers are not this one's", async () => {
    const mine = await template(tenantB, "PRO-");
    expect(
      (await getDocumentTemplate(ctx(tenantB), mine, appDb)).nextNumber,
    ).toBe(1);
    const set = await updateDocumentTemplate(
      ctx(tenantB),
      mine,
      { nextNumber: 2 },
      appDb,
    );
    expect(set.nextNumber).toBe(2);
  });

  test("a next number that is not a whole number from 1 is refused", async () => {
    const id = await template(tenantA, "BAD-");
    for (const value of [0, -3, 1.5, 2_147_483_648]) {
      const refused = await refusal(
        updateDocumentTemplate(ctx(tenantA), id, { nextNumber: value }, appDb),
      );
      expect(refused.statusCode).toBe(400);
    }
  });

  test("where numbering would continue under another prefix, read and previewed before the save", async () => {
    const used = await template(tenantA, "VIA-");
    for (let i = 0; i < 3; i++) await issue(tenantA, used);
    const moving = await template(tenantA, "LIVRE-");
    // The counter stays with the template; the destination prefix's highest number decides.
    expect(
      await nextNumberUnderPrefix(ctx(tenantA), moving, "VIA-", appDb),
    ).toBe(4);
    expect(
      await nextNumberUnderPrefix(ctx(tenantA), moving, undefined, appDb),
    ).toBe(1);
    expect(
      await nextNumberUnderPrefix(ctx(tenantA), used, "NOVO-", appDb),
    ).toBe(4);
    // The MCP dry run of a prefix move shows the number it moves to, as the apply will.
    const dry = await documentTemplateUpdate(
      {
        userId: 1n,
        tenantId: tenantA,
        role: "TENANT_ADMIN",
        scopes: ["mcp:read", "mcp:write"],
        clientId: "c",
        jti: "j",
      },
      { document_template_id: String(moving), number_prefix: "VIA-" },
      { base: appDb },
    );
    if (!dry.ok) throw new Error("the dry run was refused");
    const diff = JSON.stringify((dry.data as { diff: unknown }).diff);
    expect(diff).toContain("nextNumber");
    expect(diff).toContain("4");
    const applied = await updateDocumentTemplate(
      ctx(tenantA),
      moving,
      { numberPrefix: "VIA-" },
      appDb,
    );
    expect(applied.nextNumber).toBe(4);
  });
});
