import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  applyMerchantImport,
  csvToRowInputs,
  parseCsv,
  validateImportRows,
} from "@/modules/merchant/import";
import { tagMerchantProductWithLlm } from "@/modules/merchant/tagging";

// The import's dry-run contract is "parse + validate, write nothing": a fake
// tx that records every mutation makes that checkable, and the same fake
// carries the upsert-by-name and tag-merge assertions.

const ctx: TenantContext = { tenantId: 7n, userId: 3n, role: "TENANT_ADMIN" };

interface FakeRow {
  id: bigint;
  tenantId: bigint;
  name: string;
  description: string | null;
  price: number;
  stock: number;
  tags: string[];
  category: string | null;
  attributes: unknown;
  taggedAt: Date | null;
  tagSource: string | null;
  imageUrl: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function fakeDb(seed: FakeRow[] = []) {
  const store = [...seed];
  const audits: { action: string; target: string }[] = [];
  let nextId = 100n;
  const tx = {
    $executeRaw: async () => 0,
    auditLog: {
      create: async ({
        data,
      }: {
        data: { action: string; target: string };
      }) => {
        audits.push({ action: data.action, target: data.target });
        return {};
      },
    },
    merchantProduct: {
      findFirst: async ({ where }: { where: { name?: string } }) =>
        store.find((r) => r.name === where.name) ?? null,
      findUnique: async ({ where }: { where: { id: bigint } }) =>
        store.find((r) => r.id === where.id) ?? null,
      create: async ({ data }: { data: Partial<FakeRow> }) => {
        const row: FakeRow = {
          id: nextId++,
          tenantId: 7n,
          name: data.name ?? "",
          description: data.description ?? null,
          price: Number(data.price ?? 0),
          stock: data.stock ?? 0,
          tags: data.tags ?? [],
          category: data.category ?? null,
          attributes: data.attributes ?? null,
          taggedAt: data.taggedAt ?? null,
          tagSource: data.tagSource ?? null,
          imageUrl: data.imageUrl ?? null,
          active: data.active ?? true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: bigint };
        data: Partial<FakeRow>;
      }) => {
        const row = store.find((r) => r.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
      findMany: async () => store,
    },
  };
  // runScopedOn only needs $extends + $transaction on the base client.
  const base = {
    $extends: () => ({ $transaction: (fn: (t: unknown) => unknown) => fn(tx) }),
  } as unknown as PrismaClient;
  return { base, store, audits };
}

function seedRow(over: Partial<FakeRow>): FakeRow {
  return {
    id: 5n,
    tenantId: 7n,
    name: "Serum BHA",
    description: null,
    price: 289000,
    stock: 10,
    tags: ["manual"],
    category: null,
    attributes: null,
    taggedAt: null,
    tagSource: null,
    imageUrl: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe("parseCsv", () => {
  test("splits plain rows and drops the trailing newline row", () => {
    expect(parseCsv("a,b\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("handles quoted commas, escaped quotes and CRLF", () => {
    expect(parseCsv('name,desc\r\n"váy, đỏ","nói ""to"" rõ"')).toEqual([
      ["name", "desc"],
      ["váy, đỏ", 'nói "to" rõ'],
    ]);
  });
});

describe("csvToRowInputs", () => {
  test("maps English headers to row fields", () => {
    const rows = csvToRowInputs(
      "name,price,stock,description,tags\nSerum,289000,12,Cho da dầu,serum|bha",
    );
    expect(rows).toEqual([
      {
        name: "Serum",
        price: "289000",
        stock: "12",
        description: "Cho da dầu",
        tags: "serum|bha",
      },
    ]);
  });

  test("maps Vietnamese header spellings onto the same fields", () => {
    const rows = csvToRowInputs("ten,gia,ton kho\nÁo thun,150000,5");
    expect(rows).toEqual([{ name: "Áo thun", price: "150000", stock: "5" }]);
  });
});

describe("validateImportRows (the dry-run half)", () => {
  test("coerces price/stock strings and splits the tags cell on |", () => {
    const { rows, ok } = validateImportRows([
      { name: "Serum", price: "289000", stock: "12", tags: "serum|bha" },
    ]);
    expect(ok).toBe(1);
    expect(rows[0]?.data).toEqual({
      name: "Serum",
      price: 289000,
      stock: 12,
      description: null,
      tags: ["serum", "bha"],
    });
    expect(rows[0]?.line).toBe(2);
  });

  test("flags bad rows without rejecting the whole batch", () => {
    const { rows, ok } = validateImportRows([
      { name: "", price: "100" },
      { name: "Áo", price: "không-phải-số" },
      { name: "Váy", price: "300000" },
    ]);
    expect(ok).toBe(1);
    expect(rows[0]?.errors.length).toBeGreaterThan(0);
    expect(rows[1]?.errors.length).toBeGreaterThan(0);
    expect(rows[2]?.data?.name).toBe("Váy");
  });
});

describe("applyMerchantImport", () => {
  test("creates new rows and updates name-collisions, audited per row", async () => {
    const { base, store, audits } = fakeDb([
      seedRow({ id: 9n, name: "Serum" }),
    ]);
    const preview = validateImportRows([
      { name: "Serum", price: "300000", stock: "7", tags: "new" },
      { name: "Váy đầm", price: "450000", tags: "váy|nữ" },
    ]);
    const result = await applyMerchantImport(ctx, preview.rows, {
      base,
      tagging: false,
    });
    expect(result).toEqual({
      created: 1,
      updated: 1,
      productIds: ["9", "100"],
    });
    // The update replaced the stated fields; the create got tenantId injected.
    expect(store.find((r) => r.name === "Serum")?.price).toBe(300000);
    expect(store.find((r) => r.name === "Váy đầm")?.tags).toEqual([
      "váy",
      "nữ",
    ]);
    expect(audits.map((a) => a.action)).toEqual([
      "merchant_product.update",
      "merchant_product.create",
    ]);
  });

  test("skips invalid rows entirely (they never reach the db)", async () => {
    const { base, store } = fakeDb();
    const preview = validateImportRows([
      { name: "", price: "x" },
      { name: "Áo", price: "100000" },
    ]);
    const result = await applyMerchantImport(ctx, preview.rows, {
      base,
      tagging: false,
    });
    expect(result.created).toBe(1);
    expect(store).toHaveLength(1);
    expect(store[0]?.name).toBe("Áo");
  });
});

describe("tagMerchantProductWithLlm (gateway stubbed)", () => {
  const gatewayOk = (content: unknown): typeof fetch =>
    (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(content) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

  test("writes category/attributes/merged tags and stamps tagSource=llm", async () => {
    const { base, store } = fakeDb([
      seedRow({ id: 5n, tags: ["manual-tag"], name: "Serum trị mụn BHA" }),
    ]);
    const outcome = await tagMerchantProductWithLlm(ctx, 5n, {
      base,
      fetchImpl: gatewayOk({
        category: "my pham/skincare",
        tags: ["serum", "manual-tag"],
        attributes: { size: "30ml", priceSegment: "trung bình" },
      }),
      timeoutMs: 5_000,
    });
    expect(outcome.ok).toBe(true);
    const row = store[0] as FakeRow;
    expect(row.category).toBe("mỹ phẩm/skincare");
    // manual tag preserved AND deduped against the model's spelling.
    expect(row.tags).toEqual(["manual-tag", "serum"]);
    expect(row.attributes).toEqual({
      size: "30ml",
      priceSegment: "trung bình",
    });
    expect(row.tagSource).toBe("llm");
    expect(row.taggedAt).toBeInstanceOf(Date);
  });

  test("a refusal answer writes nothing and reports unparseable", async () => {
    const { base, store, audits } = fakeDb([seedRow({ id: 5n })]);
    const refusalFetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Xin lỗi, tôi không thể giúp." } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const outcome = await tagMerchantProductWithLlm(ctx, 5n, {
      base,
      fetchImpl: refusalFetch,
      timeoutMs: 5_000,
    });
    expect(outcome).toEqual({ ok: false, reason: "unparseable" });
    expect(store[0]?.tagSource).toBeNull();
    expect(store[0]?.taggedAt).toBeNull();
    expect(audits).toHaveLength(0);
  });

  test("a gateway error reports gateway and writes nothing", async () => {
    const { base, store } = fakeDb([seedRow({ id: 5n })]);
    const down = (async () =>
      new Response("oops", { status: 502 })) as unknown as typeof fetch;
    const outcome = await tagMerchantProductWithLlm(ctx, 5n, {
      base,
      fetchImpl: down,
      timeoutMs: 5_000,
    });
    expect(outcome.ok).toBe(false);
    expect(store[0]?.tagSource).toBeNull();
  });
});
