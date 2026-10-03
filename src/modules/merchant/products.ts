import { z } from "zod";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import {
  AppError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";
import { normalizeVi } from "./scorer";

// Merchant catalog (per-tenant): the products the rule-based scorer matches lead
// text against, and the rows the /catalog console page lists. Prices are VND.

export type ProductAttributes = Record<string, string | number | boolean>;

export interface MerchantProductDto {
  id: string;
  name: string;
  description: string | null;
  price: number;
  stock: number;
  tags: string[];
  imageUrl: string | null;
  active: boolean;
  // PIM-lite: the shop-taxonomy node the tagger (or the operator) filed the
  // product under, the extracted facets, and when/by whom it was last tagged
  // ("manual" | "llm"; null = never tagged).
  category: string | null;
  attributes: ProductAttributes | null;
  taggedAt: Date | null;
  tagSource: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  description: true,
  price: true,
  stock: true,
  tags: true,
  imageUrl: true,
  active: true,
  category: true,
  attributes: true,
  taggedAt: true,
  tagSource: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDto(r: {
  id: bigint;
  name: string;
  description: string | null;
  price: { toString(): string };
  stock: number;
  tags: string[];
  imageUrl: string | null;
  active: boolean;
  category: string | null;
  attributes: unknown;
  taggedAt: Date | null;
  tagSource: string | null;
  createdAt: Date;
  updatedAt: Date;
}): MerchantProductDto {
  return {
    id: String(r.id),
    name: r.name,
    description: r.description,
    price: Number(r.price),
    stock: r.stock,
    tags: r.tags,
    imageUrl: r.imageUrl,
    active: r.active,
    category: r.category,
    attributes: (r.attributes as ProductAttributes | null) ?? null,
    taggedAt: r.taggedAt,
    tagSource: r.tagSource,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const attributeValueSchema = z.union([
  z.string().max(300),
  z.number(),
  z.boolean(),
]);

// `attributes` is a free-form bag keyed by caller-chosen names, so the record
// stays `z.unknown()` (a constrained value would put the caller's key in the
// refusal path) and each value is checked by hand, naming `attributes` alone.
function parseAttributeValues(raw: Record<string, unknown>): ProductAttributes {
  const out: ProductAttributes = {};
  for (const [key, value] of Object.entries(raw)) {
    const parsed = attributeValueSchema.safeParse(value);
    if (!parsed.success) {
      throw new AppError(
        "The value sent in attributes is not valid.",
        422,
        "errors.invalidRequestValue",
        { field: "attributes" },
        "attributes",
      );
    }
    out[key] = parsed.data;
  }
  return out;
}

export const merchantProductCreateSchema = z
  .object({
    name: z.string().min(1).max(300),
    description: z.string().max(5000).optional(),
    // VND is zero-decimal; the column is DECIMAL(15,0).
    price: z.number().min(0).max(999999999999999),
    stock: z.number().int().min(0).optional(),
    tags: z.array(z.string().min(1).max(100)).max(50).optional(),
    imageUrl: z.string().max(2000).optional(),
    active: z.boolean().optional(),
    // PIM-lite fields an operator may set by hand. `tagSource` stays
    // caller-declared: only the tagger writes "llm", but nothing in this schema
    // gains by refusing the spelling (the audit row records who wrote what).
    category: z.string().min(1).max(200).nullish(),
    attributes: z.record(z.string(), z.unknown()).nullish(),
    tagSource: z.enum(["manual", "llm"]).nullish(),
    taggedAt: z.iso.datetime().nullish(),
  })
  .strict();
export type MerchantProductCreate = z.infer<typeof merchantProductCreateSchema>;

export const merchantProductUpdateSchema = merchantProductCreateSchema
  .partial()
  .strict();
export type MerchantProductUpdate = z.infer<typeof merchantProductUpdateSchema>;

function auditProjection(dto: MerchantProductDto) {
  return {
    name: dto.name,
    description: dto.description,
    price: dto.price,
    stock: dto.stock,
    tags: dto.tags,
    imageUrl: dto.imageUrl,
    active: dto.active,
    category: dto.category,
    attributes: dto.attributes,
    tagSource: dto.tagSource,
  };
}

export function assertMerchantProductCreatable(input: MerchantProductCreate) {
  const data = parseInput(merchantProductCreateSchema, input);
  return {
    ...data,
    attributes:
      data.attributes == null
        ? data.attributes
        : parseAttributeValues(data.attributes),
  };
}

export function assertMerchantProductUpdatable(patch: MerchantProductUpdate) {
  const data = parseInput(merchantProductUpdateSchema, patch);
  return {
    ...data,
    attributes:
      data.attributes == null
        ? data.attributes
        : parseAttributeValues(data.attributes),
  };
}

// Structured listing filters, applied BEFORE the text match: the SQL `where`
// narrows by category/price first (both indexed-friendly column comparisons),
// then the tag/text match runs over that narrowed set in JS — substring and
// array matching there is diacritics-insensitive via normalizeVi, the same
// normalization the scorer already gives post text ("ao" finds "áo").
export interface MerchantProductFilter {
  q?: string;
  category?: string;
  // Products must carry EVERY listed tag (AND semantics: the caller is
  // narrowing a catalog, so each extra tag shrinks the answer set).
  tags?: string[];
  priceMax?: number;
}

// The in-memory half of the filter, exported so the precedence is testable
// without a database. Runs after the SQL where.
export function matchesProductFilter(
  row: { name: string; description: string | null; tags: string[] },
  filter: Pick<MerchantProductFilter, "tags" | "q">,
): boolean {
  if (filter.tags && filter.tags.length > 0) {
    const owned = new Set(row.tags.map((t) => normalizeVi(t).trim()));
    const wantsAll = filter.tags.every((t) => owned.has(normalizeVi(t).trim()));
    if (!wantsAll) return false;
  }
  const q = filter.q?.trim();
  if (q) {
    const needle = normalizeVi(q);
    const hay = normalizeVi(
      `${row.name} ${row.description ?? ""} ${row.tags.join(" ")}`,
    );
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export async function listMerchantProducts(
  ctx: TenantContext,
  filter: MerchantProductFilter = {},
  base: PrismaClient = basePrisma,
): Promise<MerchantProductDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.merchantProduct.findMany({
      where: {
        ...(filter.category
          ? { category: { equals: filter.category, mode: "insensitive" } }
          : {}),
        ...(filter.priceMax !== undefined
          ? { price: { lte: filter.priceMax } }
          : {}),
      },
      select: SELECT,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  );
  return rows.filter((r) => matchesProductFilter(r, filter)).map(toDto);
}

export async function getMerchantProduct(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<MerchantProductDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.merchantProduct.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) {
    throw new NotFoundError(
      "product not found",
      "errors.merchantProductNotFound",
    );
  }
  return toDto(row);
}

// The columns a caller may write through create/update. tagSource/taggedAt are
// accepted on the wire (the schema above) so an import can carry them, but the
// tagger is the only path that writes "llm".
function writableData(data: {
  name?: string;
  description?: string | null;
  price?: number;
  stock?: number;
  tags?: string[];
  imageUrl?: string | null;
  active?: boolean;
  category?: string | null;
  attributes?: ProductAttributes | null;
  tagSource?: string | null;
  taggedAt?: string | null;
}) {
  return {
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.description !== undefined
      ? { description: data.description }
      : {}),
    ...(data.price !== undefined ? { price: data.price } : {}),
    ...(data.stock !== undefined ? { stock: data.stock } : {}),
    ...(data.tags !== undefined ? { tags: data.tags } : {}),
    ...(data.imageUrl !== undefined ? { imageUrl: data.imageUrl } : {}),
    ...(data.active !== undefined ? { active: data.active } : {}),
    ...(data.category !== undefined ? { category: data.category } : {}),
    // Nullable Json columns take Prisma.DbNull for SQL NULL; a raw null is rejected.
    ...(data.attributes !== undefined
      ? {
          attributes: (data.attributes === null
            ? Prisma.DbNull
            : data.attributes) as Prisma.InputJsonValue,
        }
      : {}),
    ...(data.tagSource !== undefined ? { tagSource: data.tagSource } : {}),
    ...(data.taggedAt !== undefined
      ? { taggedAt: data.taggedAt === null ? null : new Date(data.taggedAt) }
      : {}),
  };
}

export async function createMerchantProduct(
  ctx: TenantContext,
  input: MerchantProductCreate,
  base: PrismaClient = basePrisma,
): Promise<MerchantProductDto> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const tenantId = ctx.tenantId;
  const data = assertMerchantProductCreatable(input);
  return runScopedOn(base, ctx, async (db) => {
    const row = await db.merchantProduct.create({
      data: {
        tenantId,
        name: data.name,
        description: data.description ?? null,
        price: data.price,
        stock: data.stock ?? 0,
        tags: data.tags ?? [],
        imageUrl: data.imageUrl ?? null,
        active: data.active ?? true,
        ...writableData({
          category: data.category,
          attributes: data.attributes,
          tagSource: data.tagSource,
          taggedAt: data.taggedAt,
        }),
      },
      select: SELECT,
    });
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action: "merchant_product.create",
      target: `merchant_product:${dto.id}`,
      after: auditProjection(dto),
    });
    return dto;
  });
}

export async function updateMerchantProduct(
  ctx: TenantContext,
  id: bigint,
  patch: MerchantProductUpdate,
  base: PrismaClient = basePrisma,
): Promise<MerchantProductDto> {
  const data = assertMerchantProductUpdatable(patch);
  return runScopedOn(base, ctx, async (db) => {
    const current = await db.merchantProduct.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!current) {
      throw new NotFoundError(
        "product not found",
        "errors.merchantProductNotFound",
      );
    }
    const before = toDto(current);
    const row = await db.merchantProduct.update({
      where: { id },
      data: writableData(data),
      select: SELECT,
    });
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action: "merchant_product.update",
      target: `merchant_product:${dto.id}`,
      before: auditProjection(before),
      after: auditProjection(dto),
    });
    return dto;
  });
}

export async function deleteMerchantProduct(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    const current = await db.merchantProduct.findUnique({
      where: { id },
      select: SELECT,
    });
    const res = await db.merchantProduct.deleteMany({ where: { id } });
    if (res.count === 0 || !current) {
      throw new NotFoundError(
        "product not found",
        "errors.merchantProductNotFound",
      );
    }
    await auditMutation(db, ctx, {
      action: "merchant_product.delete",
      target: `merchant_product:${id}`,
      before: auditProjection(toDto(current)),
    });
  });
}
