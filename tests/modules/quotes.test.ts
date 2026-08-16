import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { renderQuotePdf } from "@/lib/pdf";
import type { TenantContext } from "@/lib/tenancy";
import { generateQuote, getQuotePdf } from "@/modules/quotes/service";

function pdfHeader(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(u8.subarray(0, 5)).toString("latin1");
}

describe("renderQuotePdf", () => {
  test("renders a valid PDF with PT-BR accents under Bun", async () => {
    const buf = await renderQuotePdf({
      tenantName: "Ação & Manutenção",
      title: "Orçamento",
      customerName: "José da Conceição",
      currency: "BRL",
      items: [
        {
          description: "Serviço de instalação",
          quantity: 1,
          unitPrice: 1299.9,
        },
      ],
      notes: "Válido por 7 dias.",
    });
    expect(pdfHeader(new Uint8Array(buf))).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(500);
  });
});

// ── DB-gated: idempotent generation + scoped retrieval ──
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

const DIR = `/tmp/fazerai-quotes-${process.pid}`;
let tenantA = 0n;
let tenantB = 0n;
function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

const snapshot = {
  title: "Orçamento mensal",
  currency: "BRL",
  items: [{ description: "Plano", quantity: 1, unitPrice: 199.9 }],
};

describe.skipIf(!dbUp)("generateQuote / getQuotePdf", () => {
  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "QuoteA", slug: `quote-a-${process.pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "QuoteB", slug: `quote-b-${process.pid}` },
    });
    tenantB = b.id;
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (tid)
        await suDb.$executeRawUnsafe(
          `DELETE FROM quotes WHERE tenant_id = ${tid}`,
        );
      if (tid)
        await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
    await rm(DIR, { recursive: true, force: true });
  });

  test("generates a READY quote and a retrievable PDF", async () => {
    const q = await generateQuote({
      tenantId: tenantA,
      idempotencyKey: "k1",
      snapshot,
      base: appDb,
      storageDir: DIR,
    });
    expect(q.status).toBe("READY");
    const { bytes } = await getQuotePdf(ctx(tenantA), BigInt(q.id), appDb, DIR);
    expect(pdfHeader(bytes)).toBe("%PDF-");
  });

  test("is idempotent: same idempotencyKey → same quote, no duplicate", async () => {
    const first = await generateQuote({
      tenantId: tenantA,
      idempotencyKey: "k2",
      snapshot,
      base: appDb,
      storageDir: DIR,
    });
    const second = await generateQuote({
      tenantId: tenantA,
      idempotencyKey: "k2",
      snapshot,
      base: appDb,
      storageDir: DIR,
    });
    expect(second.id).toBe(first.id);
    const count = await suDb.quote.count({
      where: { tenantId: tenantA, idempotencyKey: "k2" },
    });
    expect(count).toBe(1);
  });

  test("a tenant cannot retrieve another tenant's quote PDF", async () => {
    const q = await generateQuote({
      tenantId: tenantA,
      idempotencyKey: "k3",
      snapshot,
      base: appDb,
      storageDir: DIR,
    });
    expect(
      getQuotePdf(ctx(tenantB), BigInt(q.id), appDb, DIR),
    ).rejects.toThrow();
  });
});
