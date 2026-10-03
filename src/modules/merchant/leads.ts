import { z } from "zod";
import type {
  MerchantLeadStatus,
  PrismaClient,
} from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { NotFoundError, TenantTargetRequiredError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertUsableCount } from "@/lib/query-param";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
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
  // Discovery provenance: which configured source scanned this post, and the
  // upstream post id it carries. Both null on a manually-ingested lead.
  sourceId: string | null;
  sourceName: string | null;
  externalId: string | null;
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
  sourceId: true,
  externalId: true,
  source: { select: { name: true } },
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
  sourceId: bigint | null;
  externalId: string | null;
  source: { name: string } | null;
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
    sourceId: r.sourceId === null ? null : String(r.sourceId),
    sourceName: r.source?.name ?? null,
    externalId: r.externalId,
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

// What the discovery scanner feeds in on top of a plain post: the upstream id
// the dedupe key is built from, and which configured source found it. Never
// part of leadIngestSchema - the REST ingest endpoint cannot forge provenance.
export interface ScannedLeadInput extends LeadIngestInput {
  externalId: string;
  sourceId: bigint;
}

export interface ListLeadsFilter {
  limit?: number;
  cursor?: bigint;
  status?: MerchantLeadStatus;
  // Restrict to the leads one configured source produced (/sources/:id/leads).
  sourceId?: bigint;
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
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.sourceId !== undefined ? { sourceId: filter.sourceId } : {}),
      },
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

export const leadUpdateSchema = z
  .object({
    status: z.enum(LEAD_STATUSES),
  })
  .strict();
export type LeadUpdateInput = z.infer<typeof leadUpdateSchema>;

// The operator's own call on a lead's stage: every enum value is a legal
// target (a human deciding "this one is qualified" is the whole point of the
// funnel), so the write validates the value, not the transition. Implicit
// moves still happen beside it - a draft going out marks CONTACTED, an order
// marks CONVERTED.
export async function updateLeadStatus(
  ctx: TenantContext,
  id: bigint,
  input: LeadUpdateInput,
  base: PrismaClient = basePrisma,
): Promise<LeadDto> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const data = parseInput(leadUpdateSchema, input);
  return runScopedOn(base, ctx, async (db) => {
    const current = await db.lead.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!current) {
      throw new NotFoundError("lead not found", "errors.merchantLeadNotFound");
    }
    const row = await db.lead.update({
      where: { id },
      data: { status: data.status },
      select: SELECT,
    });
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action: "merchant_lead.update",
      target: `lead:${dto.id}`,
      before: { status: current.status },
      after: { status: dto.status },
    });
    return dto;
  });
}

// One ingest: score the post text against the tenant's active catalog, write the
// lead and its product matches in the same transaction. The scorer is pure and
// synchronous, so there is no network I/O inside the scoped transaction.
//
// `provenance` marks a scanned post (source + upstream id); when it is present
// the (tenant, platform, external_id) dedupe key is checked FIRST and an
// existing row answers null instead of a second lead.
async function ingestLeadOn(
  db: ScopedDb,
  ctx: TenantContext,
  tenantId: bigint,
  data: LeadIngestInput,
  provenance?: { sourceId: bigint; externalId: string },
): Promise<LeadDto | null> {
  if (provenance) {
    const existing = await db.lead.findUnique({
      where: {
        tenantId_platform_externalId: {
          tenantId,
          platform: data.platform,
          externalId: provenance.externalId,
        },
      },
      select: { id: true },
    });
    if (existing) return null;
  }
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
      sourceId: provenance?.sourceId ?? null,
      externalId: provenance?.externalId ?? null,
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
      ...(provenance
        ? {
            sourceId: String(provenance.sourceId),
            externalId: provenance.externalId,
          }
        : {}),
    },
  });
  return dto;
}

export async function ingestLead(
  ctx: TenantContext,
  input: LeadIngestInput,
  base: PrismaClient = basePrisma,
): Promise<LeadDto> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const tenantId = ctx.tenantId;
  const data = parseInput(leadIngestSchema, input);
  const dto = await runScopedOn(base, ctx, (db) =>
    ingestLeadOn(db, ctx, tenantId, data),
  );
  // The manual path carries no provenance, so ingestLeadOn never answers null.
  return dto as LeadDto;
}

// The discovery door into the same ingest: a scanned post with its provenance.
// Answers null when (tenant, platform, externalId) already has a lead - the
// caller counts it as deduped, not as an error.
export async function ingestScannedLead(
  ctx: TenantContext,
  input: ScannedLeadInput,
  base: PrismaClient = basePrisma,
): Promise<LeadDto | null> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const tenantId = ctx.tenantId;
  // Split provenance off BEFORE parseInput: leadIngestSchema is strict, and an
  // extra key on the record is a rejection, not a detail.
  const { sourceId, externalId: rawExternalId, ...post } = input;
  const data = parseInput(leadIngestSchema, post);
  const externalId = rawExternalId.trim();
  // Unreachable through the scanner path (normalize guarantees a non-empty id,
  // hashing content when the upstream gave none) - a caller-side invariant.
  if (externalId === "") {
    throw new Error("scanned lead requires externalId");
  }
  return runScopedOn(base, ctx, (db) =>
    ingestLeadOn(db, ctx, tenantId, data, {
      sourceId,
      externalId,
    }),
  );
}
