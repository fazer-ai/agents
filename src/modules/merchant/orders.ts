import { z } from "zod";
import type {
  MerchantOrderStatus,
  PrismaClient,
} from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { optionalDbId } from "@/lib/db-id";
import {
  AppError,
  ConflictError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertUsableCount } from "@/lib/query-param";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";

// Merchant orders (per-tenant): the /orders console page lists them; writes come
// from the sales flow (an agent's create_order HTTP tool, or seeds) plus the
// operator's own status moves.

export const ORDER_STATUSES = [
  "DRAFT",
  "CONFIRMED",
  "PAID",
  "CANCELLED",
] as const;

// The documented lifecycle (docs/merchant.md): DRAFT -> CONFIRMED -> PAID, with
// CANCELLED reachable from either open stage. Terminal states take no writes.
const ORDER_TRANSITIONS: Record<
  MerchantOrderStatus,
  readonly MerchantOrderStatus[]
> = {
  DRAFT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PAID", "CANCELLED"],
  PAID: [],
  CANCELLED: [],
};

export interface MerchantOrderItemDto {
  id: string;
  productId: string | null;
  productName: string | null;
  qty: number;
  unitPrice: number;
}

export interface MerchantOrderDto {
  id: string;
  leadId: string | null;
  leadAuthorName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactAddress: string | null;
  status: MerchantOrderStatus;
  totalAmount: number;
  note: string | null;
  items: MerchantOrderItemDto[];
  createdAt: Date;
}

const SELECT = {
  id: true,
  leadId: true,
  contactName: true,
  contactPhone: true,
  contactAddress: true,
  status: true,
  totalAmount: true,
  note: true,
  createdAt: true,
  lead: { select: { authorName: true } },
  items: {
    orderBy: { id: "asc" as const },
    select: {
      id: true,
      productId: true,
      qty: true,
      unitPrice: true,
      product: { select: { name: true } },
    },
  },
} as const;

type OrderRow = {
  id: bigint;
  leadId: bigint | null;
  contactName: string | null;
  contactPhone: string | null;
  contactAddress: string | null;
  status: MerchantOrderStatus;
  totalAmount: { toString(): string };
  note: string | null;
  createdAt: Date;
  lead: { authorName: string } | null;
  items: {
    id: bigint;
    productId: bigint | null;
    qty: number;
    unitPrice: { toString(): string };
    product: { name: string } | null;
  }[];
};

function toDto(r: OrderRow): MerchantOrderDto {
  return {
    id: String(r.id),
    leadId: r.leadId === null ? null : String(r.leadId),
    leadAuthorName: r.lead?.authorName ?? null,
    contactName: r.contactName,
    contactPhone: r.contactPhone,
    contactAddress: r.contactAddress,
    status: r.status,
    totalAmount: Number(r.totalAmount),
    note: r.note,
    items: r.items.map((i) => ({
      id: String(i.id),
      productId: i.productId === null ? null : String(i.productId),
      productName: i.product?.name ?? null,
      qty: i.qty,
      unitPrice: Number(i.unitPrice),
    })),
    createdAt: r.createdAt,
  };
}

export interface OrdersPage {
  items: MerchantOrderDto[];
  nextCursor: string | null;
}

export async function listMerchantOrders(
  ctx: TenantContext,
  filter: { limit?: number; cursor?: bigint },
  base: PrismaClient = basePrisma,
): Promise<OrdersPage> {
  assertUsableCount(filter.limit, "limit");
  const take = Math.min(filter.limit ?? 50, 200);
  const rows = await runScopedOn(base, ctx, (db) =>
    db.merchantOrder.findMany({
      orderBy: { id: "desc" },
      take,
      ...(filter.cursor != null
        ? { cursor: { id: filter.cursor }, skip: 1 }
        : {}),
      select: SELECT,
    }),
  );
  const last = rows.at(-1);
  const nextCursor = rows.length === take && last ? String(last.id) : null;
  return { items: rows.map(toDto), nextCursor };
}

export async function getMerchantOrder(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<MerchantOrderDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.merchantOrder.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) {
    throw new NotFoundError("order not found", "errors.merchantOrderNotFound");
  }
  return toDto(row);
}

export const merchantOrderUpdateSchema = z
  .object({
    status: z.enum(ORDER_STATUSES),
  })
  .strict();
export type MerchantOrderUpdate = z.infer<typeof merchantOrderUpdateSchema>;

// The operator moves an order along its lifecycle. The transition is written
// CAS-style (`where status = before`) so a concurrent move surfaces as a
// conflict rather than silently overwriting.
export async function updateMerchantOrderStatus(
  ctx: TenantContext,
  id: bigint,
  input: MerchantOrderUpdate,
  base: PrismaClient = basePrisma,
): Promise<MerchantOrderDto> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const data = parseInput(merchantOrderUpdateSchema, input);
  return runScopedOn(base, ctx, async (db) => {
    const before = await db.merchantOrder.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!before) {
      throw new NotFoundError(
        "order not found",
        "errors.merchantOrderNotFound",
      );
    }
    if (!ORDER_TRANSITIONS[before.status].includes(data.status)) {
      throw new ConflictError(
        `This order is ${before.status} and cannot become ${data.status}.`,
        "errors.merchantOrderState",
        { from: before.status, to: data.status },
      );
    }
    const { count } = await db.merchantOrder.updateMany({
      where: { id, status: before.status },
      data: { status: data.status },
    });
    if (count === 0) {
      throw new ConflictError(
        "This order changed state while the request was in flight",
        "errors.merchantOrderRace",
      );
    }
    const row = await db.merchantOrder.findUniqueOrThrow({
      where: { id },
      select: SELECT,
    });
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action: "merchant_order.update",
      target: `merchant_order:${dto.id}`,
      before: { status: before.status },
      after: { status: dto.status },
    });
    return dto;
  });
}

export const merchantOrderItemCreateSchema = z
  .object({
    productId: z.string().optional(),
    qty: z.number().int().min(1).max(10000).optional(),
    // VND unit price snapshot; falls back to the product's catalog price.
    unitPrice: z.number().min(0).max(999999999999999).optional(),
  })
  .strict();
export type MerchantOrderItemCreate = z.infer<
  typeof merchantOrderItemCreateSchema
>;

export const merchantOrderCreateSchema = z
  .object({
    leadId: z.string().optional(),
    contactName: z.string().max(300).optional(),
    contactPhone: z.string().max(60).optional(),
    contactAddress: z.string().max(1000).optional(),
    note: z.string().max(5000).optional(),
    // HTTP tools can't declare array-of-object inputs, so an agent supplies
    // `items` as a JSON string; a REST caller sends the real array.
    items: z.preprocess((v) => {
      if (typeof v !== "string") return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }, z.array(merchantOrderItemCreateSchema).min(1).max(100)),
  })
  .strict();
export type MerchantOrderCreate = z.infer<typeof merchantOrderCreateSchema>;

function orderAuditProjection(dto: MerchantOrderDto) {
  return {
    leadId: dto.leadId,
    contactName: dto.contactName,
    contactPhone: dto.contactPhone,
    status: dto.status,
    totalAmount: dto.totalAmount,
    items: dto.items.map((i) => ({
      productId: i.productId,
      qty: i.qty,
      unitPrice: i.unitPrice,
    })),
  };
}

export async function createMerchantOrder(
  ctx: TenantContext,
  input: MerchantOrderCreate,
  base: PrismaClient = basePrisma,
): Promise<MerchantOrderDto> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const tenantId = ctx.tenantId;
  const data = parseInput(merchantOrderCreateSchema, input);
  const leadId = optionalDbId(data.leadId, "leadId") ?? null;
  return runScopedOn(base, ctx, async (db) => {
    if (leadId !== null) {
      const lead = await db.lead.findUnique({
        where: { id: leadId },
        select: { id: true },
      });
      if (!lead) {
        throw new NotFoundError(
          "lead not found",
          "errors.merchantLeadNotFound",
        );
      }
    }
    const lines = await Promise.all(
      data.items.map(async (item) => {
        const productId = optionalDbId(item.productId, "productId") ?? null;
        let unitPrice = item.unitPrice;
        if (productId !== null) {
          const product = await db.merchantProduct.findUnique({
            where: { id: productId },
            select: { id: true, price: true },
          });
          if (!product) {
            throw new NotFoundError(
              "product not found",
              "errors.merchantProductNotFound",
            );
          }
          unitPrice ??= Number(product.price);
        }
        if (unitPrice === undefined) {
          throw new AppError(
            "An order item needs a productId or a unitPrice.",
            422,
            "errors.merchantOrderItemIncomplete",
          );
        }
        return { productId, qty: item.qty ?? 1, unitPrice };
      }),
    );
    const totalAmount = lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
    const row = await db.merchantOrder.create({
      data: {
        tenantId,
        leadId,
        contactName: data.contactName ?? null,
        contactPhone: data.contactPhone ?? null,
        contactAddress: data.contactAddress ?? null,
        note: data.note ?? null,
        totalAmount,
        items: {
          create: lines.map((l) => ({
            tenantId,
            productId: l.productId,
            qty: l.qty,
            unitPrice: l.unitPrice,
          })),
        },
      },
      select: SELECT,
    });
    if (leadId !== null) {
      await db.lead.update({
        where: { id: leadId },
        data: { status: "CONVERTED" },
      });
    }
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action: "merchant_order.create",
      target: `merchant_order:${dto.id}`,
      after: orderAuditProjection(dto),
    });
    return dto;
  });
}
