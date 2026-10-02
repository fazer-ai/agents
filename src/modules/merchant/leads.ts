import { z } from "zod";
import type {
  MerchantLeadStatus,
  PrismaClient,
} from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { NotFoundError, TenantTargetRequiredError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertUsableCount } from "@/lib/query-param";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";
import { scoreLeadText } from "./scorer";

// Merchant leads (per-tenant): social posts that signalled buying intent, scored
// by the rule-based Vietnamese scorer (scorer.ts) at ingest. A lead carries its
// product matches so the console can show "why this person".

export const LEAD_PLATFORMS = [
  "facebook",
  "instagram",
  "threads",
  "tiktok",
  "zalo",
  "whatsapp",
  "telegram",
  "web",
  "other",
] as const;

export const LEAD_STATUSES = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "CONVERTED",
  "DEAD",
] as const;

export interface LeadMatchDto {
  productId: string;
  productName: string;
  score: number;
  reason: string | null;
}

export interface LeadDto {
  id: string;
  platform: string;
  authorName: string;
  authorHandle: string | null;
  text: string;
  sourceUrl: string | null;
  groupName: string | null;
  score: number;
  status: MerchantLeadStatus;
  matches: LeadMatchDto[];
  createdAt: Date;
}

const SELECT = {
  id: true,
  platform: true,
  authorName: true,
  authorHandle: true,
  text: true,
  sourceUrl: true,
  groupName: true,
  score: true,
  status: true,
  createdAt: true,
  matches: {
    orderBy: { score: "desc" as const },
    select: {
      score: true,
      reason: true,
      product: { select: { id: true, name: true } },
    },
  },
} as const;

type LeadRow = {
  id: bigint;
  platform: string;
  authorName: string;
  authorHandle: string | null;
  text: string;
  sourceUrl: string | null;
  groupName: string | null;
  score: number;
  status: MerchantLeadStatus;
  createdAt: Date;
  matches: {
    score: number;
    reason: string | null;
    product: { id: bigint; name: string };
  }[];
};

function toDto(r: LeadRow): LeadDto {
  return {
    id: String(r.id),
    platform: r.platform,
    authorName: r.authorName,
    authorHandle: r.authorHandle,
    text: r.text,
    sourceUrl: r.sourceUrl,
    groupName: r.groupName,
    score: r.score,
    status: r.status,
    matches: r.matches.map((m) => ({
      productId: String(m.product.id),
      productName: m.product.name,
      score: m.score,
      reason: m.reason,
    })),
    createdAt: r.createdAt,
  };
}

export const leadIngestSchema = z
  .object({
    platform: z.enum(LEAD_PLATFORMS),
    authorName: z.string().min(1).max(300),
    authorHandle: z.string().max(300).optional(),
    text: z.string().min(1).max(20000),
    groupName: z.string().max(300).optional(),
    sourceUrl: z.string().max(2000).optional(),
  })
  .strict();
export type LeadIngestInput = z.infer<typeof leadIngestSchema>;

export interface ListLeadsFilter {
  limit?: number;
  cursor?: bigint;
  status?: MerchantLeadStatus;
}

export interface LeadsPage {
  items: LeadDto[];
  nextCursor: string | null;
}

function clampLimit(limit: number | undefined): number {
  assertUsableCount(limit, "limit");
  return Math.min(limit ?? 50, 200);
}

export async function listLeads(
  ctx: TenantContext,
  filter: ListLeadsFilter,
  base: PrismaClient = basePrisma,
): Promise<LeadsPage> {
  const take = clampLimit(filter.limit);
  const rows = await runScopedOn(base, ctx, (db) =>
    db.lead.findMany({
      where: filter.status ? { status: filter.status } : {},
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

export async function getLead(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<LeadDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.lead.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) {
    throw new NotFoundError("lead not found", "errors.merchantLeadNotFound");
  }
  return toDto(row);
}

// One ingest: score the post text against the tenant's active catalog, write the
// lead and its product matches in the same transaction. The scorer is pure and
// synchronous, so there is no network I/O inside the scoped transaction.
export async function ingestLead(
  ctx: TenantContext,
  input: LeadIngestInput,
  base: PrismaClient = basePrisma,
): Promise<LeadDto> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const tenantId = ctx.tenantId;
  const data = parseInput(leadIngestSchema, input);
  return runScopedOn(base, ctx, async (db) => {
    const products = await db.merchantProduct.findMany({
      where: { active: true },
      select: { id: true, name: true, tags: true },
    });
    const scored = scoreLeadText(data.text, products);
    const lead = await db.lead.create({
      data: {
        tenantId,
        platform: data.platform,
        authorName: data.authorName,
        authorHandle: data.authorHandle ?? null,
        text: data.text,
        sourceUrl: data.sourceUrl ?? null,
        groupName: data.groupName ?? null,
        score: scored.score,
      },
      select: { id: true },
    });
    if (scored.matches.length > 0) {
      // Flat createMany (not a nested write): the tenancy extension only
      // injects tenant_id on top-level writes, so each row names it here.
      await db.leadProductMatch.createMany({
        data: scored.matches.map((m) => ({
          tenantId,
          leadId: lead.id,
          productId: m.productId,
          score: m.score,
          reason: m.reason,
        })),
      });
    }
    const row = await db.lead.findUniqueOrThrow({
      where: { id: lead.id },
      select: SELECT,
    });
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action: "merchant_lead.ingest",
      target: `lead:${dto.id}`,
      after: {
        platform: dto.platform,
        authorName: dto.authorName,
        score: dto.score,
        signals: scored.signals,
        matches: dto.matches.map((m) => m.productId),
      },
    });
    return dto;
  });
}
