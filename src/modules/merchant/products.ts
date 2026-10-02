import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { NotFoundError, TenantTargetRequiredError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";

// Merchant catalog (per-tenant): the products the rule-based scorer matches lead
// text against, and the rows the /catalog console page lists. Prices are VND.

export interface MerchantProductDto {
  id: string;
  name: string;
  description: string | null;
  price: number;
  stock: number;
  tags: string[];
  imageUrl: string | null;
  active: boolean;
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
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
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
  };
}

export function assertMerchantProductCreatable(input: MerchantProductCreate) {
  return parseInput(merchantProductCreateSchema, input);
}

export function assertMerchantProductUpdatable(patch: MerchantProductUpdate) {
  return parseInput(merchantProductUpdateSchema, patch);
}

export async function listMerchantProducts(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<MerchantProductDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.merchantProduct.findMany({
      select: SELECT,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  );
  return rows.map(toDto);
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
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined
          ? { description: data.description }
          : {}),
        ...(data.price !== undefined ? { price: data.price } : {}),
        ...(data.stock !== undefined ? { stock: data.stock } : {}),
        ...(data.tags !== undefined ? { tags: data.tags } : {}),
        ...(data.imageUrl !== undefined ? { imageUrl: data.imageUrl } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
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
