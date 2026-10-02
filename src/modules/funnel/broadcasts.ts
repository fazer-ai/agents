import { z } from "zod";
import {
  Prisma,
  type BroadcastRecipientStatus,
  type BroadcastStatus,
  type MerchantLeadStatus,
  type PrismaClient,
} from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import {
  AppError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertUsableCount } from "@/lib/query-param";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";
import { LEAD_STATUSES } from "@/modules/merchant/leads";

// Broadcasts (per-tenant): the composer rail for one-to-many outreach. A
// broadcast is a template + an audience filter resolved ONCE at create into
// recipient rows, each carrying the rendered body the operator copies out by
// hand. There is deliberately no transport: "send" marks the rail complete and
// is where a real rail (zca-bridge / Zalo OA) would plug in later.
//
// Template vocabulary is intentionally small and literal: {{authorName}},
// {{authorHandle}}, {{platform}}, {{groupName}}. Anything else passes through
// untouched so the operator sees their typo instead of a silently blank field.

// Resolved audiences are capped so a filter mistake stays a page of work, not a
// thousand hand-sends.
export const BROADCAST_AUDIENCE_CAP = 500;

// Without an explicit status the audience is the ACTIVE funnel only: a
// broadcast that reaches CONVERTED/DEAD leads by default is a spam rail, so
// targeting them has to be named.
const DEFAULT_AUDIENCE_STATUSES: MerchantLeadStatus[] = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
];

export const audienceFilterSchema = z
  .object({
    // Leads matched to a product carrying ANY listed tag.
    tags: z.array(z.string().min(1).max(100)).max(50).optional(),
    minScore: z.number().int().min(0).max(1000).optional(),
    status: z
      .union([z.enum(LEAD_STATUSES), z.array(z.enum(LEAD_STATUSES)).max(5)])
      .optional(),
  })
  .strict();
export type AudienceFilter = z.infer<typeof audienceFilterSchema>;

export const broadcastCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    body: z.string().min(1).max(4000),
    audienceFilter: audienceFilterSchema.optional(),
  })
  .strict();
export type BroadcastCreate = z.infer<typeof broadcastCreateSchema>;

export const broadcastUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(4000).optional(),
    // The review gate: DRAFT <-> READY. SENT is only reached through send.
    status: z.enum(["DRAFT", "READY"]).optional(),
  })
  .strict();
export type BroadcastUpdate = z.infer<typeof broadcastUpdateSchema>;

export interface BroadcastRecipientDto {
  id: string;
  leadId: string;
  authorName: string;
  authorHandle: string | null;
  platform: string;
  leadScore: number;
  leadStatus: MerchantLeadStatus;
  body: string;
  status: BroadcastRecipientStatus;
  error: string | null;
  sentAt: Date | null;
}

export interface BroadcastDto {
  id: string;
  name: string;
  body: string;
  audienceFilter: Record<string, unknown>;
  status: BroadcastStatus;
  sentCount: number;
  sentAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  recipientCount: number;
  recipients?: BroadcastRecipientDto[];
}

const BROADCAST_SELECT = {
  id: true,
  name: true,
  body: true,
  audienceFilter: true,
  status: true,
  sentCount: true,
  sentAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { recipients: true } },
} as const;

export const RECIPIENT_SELECT = {
  id: true,
  leadId: true,
  body: true,
  status: true,
  error: true,
  sentAt: true,
  lead: {
    select: {
      authorName: true,
      authorHandle: true,
      platform: true,
      score: true,
      status: true,
    },
  },
} as const;

type RecipientRow = {
  id: bigint;
  leadId: bigint;
  body: string;
  status: BroadcastRecipientStatus;
  error: string | null;
  sentAt: Date | null;
  lead: {
    authorName: string;
    authorHandle: string | null;
    platform: string;
    score: number;
    status: MerchantLeadStatus;
  };
};

export type BroadcastRow = {
  id: bigint;
  name: string;
  body: string;
  audienceFilter: Prisma.JsonValue;
  status: BroadcastStatus;
  sentCount: number;
  sentAt: Date | null;
  createdBy: bigint | null;
  createdAt: Date;
  updatedAt: Date;
  _count: { recipients: number };
  recipients?: RecipientRow[];
};

function recipientToDto(r: RecipientRow): BroadcastRecipientDto {
  return {
    id: String(r.id),
    leadId: String(r.leadId),
    authorName: r.lead.authorName,
    authorHandle: r.lead.authorHandle,
    platform: r.lead.platform,
    leadScore: r.lead.score,
    leadStatus: r.lead.status,
    body: r.body,
    status: r.status,
    error: r.error,
    sentAt: r.sentAt,
  };
}

export function broadcastToDto(r: BroadcastRow): BroadcastDto {
  return {
    id: String(r.id),
    name: r.name,
    body: r.body,
    audienceFilter:
      typeof r.audienceFilter === "object" && r.audienceFilter !== null
        ? (r.audienceFilter as Record<string, unknown>)
        : {},
    status: r.status,
    sentCount: r.sentCount,
    sentAt: r.sentAt,
    createdBy: r.createdBy === null ? null : String(r.createdBy),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    recipientCount: r._count.recipients,
    recipients: r.recipients?.map(recipientToDto),
  };
}

// The broadcast's audit projection keeps the message body out of the trail
// (like every message body in this codebase): identity + shape only.
export function broadcastAuditProjection(dto: BroadcastDto) {
  return {
    name: dto.name,
    status: dto.status,
    audienceFilter: dto.audienceFilter,
    recipientCount: dto.recipientCount,
    sentCount: dto.sentCount,
  };
}

// Resolves the template for one lead. A token with no value (no group, no
// handle) renders as an empty string - the operator reads the rendered row
// before it goes out, so a blank reads as "fill me in", not as a hidden field.
export function renderBroadcastBody(
  template: string,
  lead: {
    authorName: string;
    authorHandle: string | null;
    platform: string;
    groupName: string | null;
  },
): string {
  return template
    .replaceAll("{{authorName}}", lead.authorName)
    .replaceAll("{{author}}", lead.authorName)
    .replaceAll("{{authorHandle}}", lead.authorHandle ?? "")
    .replaceAll("{{platform}}", lead.platform)
    .replaceAll("{{groupName}}", lead.groupName ?? "");
}

function audienceWhere(filter: AudienceFilter): Prisma.LeadWhereInput {
  const statuses =
    filter.status === undefined
      ? DEFAULT_AUDIENCE_STATUSES
      : Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
  return {
    status: { in: statuses },
    ...(filter.minScore !== undefined ? { score: { gte: filter.minScore } } : {}),
    ...(filter.tags && filter.tags.length > 0
      ? { matches: { some: { product: { tags: { hasSome: filter.tags } } } } }
      : {}),
  };
}

// Which leads the filter selects. Preview-shaped so POST create and a future
// "preview audience" both resolve through one path.
async function resolveAudienceOn(
  db: ScopedDb,
  filter: AudienceFilter,
): Promise<
  {
    id: bigint;
    authorName: string;
    authorHandle: string | null;
    platform: string;
    groupName: string | null;
    score: number;
  }[]
> {
  return db.lead.findMany({
    where: audienceWhere(filter),
    // Best leads first so a capped audience drops the tail, not the head.
    orderBy: [{ score: "desc" }, { id: "desc" }],
    take: BROADCAST_AUDIENCE_CAP,
    select: {
      id: true,
      authorName: true,
      authorHandle: true,
      platform: true,
      groupName: true,
      score: true,
    },
  });
}

export async function createBroadcast(
  ctx: TenantContext,
  input: BroadcastCreate,
  base: PrismaClient = basePrisma,
): Promise<BroadcastDto> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const tenantId = ctx.tenantId;
  const data = parseInput(broadcastCreateSchema, input);
  const filter = data.audienceFilter ?? {};
  return runScopedOn(base, ctx, async (db) => {
    const audience = await resolveAudienceOn(db, filter);
    const broadcast = await db.broadcast.create({
      data: {
        tenantId,
        name: data.name,
        body: data.body,
        audienceFilter: filter as Prisma.InputJsonValue,
        createdBy: ctx.userId,
      },
      select: BROADCAST_SELECT,
    });
    // Flat createMany (not a nested write): the tenancy extension only injects
    // tenant_id on top-level writes, so each row names it here.
    if (audience.length > 0) {
      await db.broadcastRecipient.createMany({
        data: audience.map((lead) => ({
          tenantId,
          broadcastId: broadcast.id,
          leadId: lead.id,
          body: renderBroadcastBody(data.body, lead),
        })),
      });
    }
    const row = await db.broadcast.findUniqueOrThrow({
      where: { id: broadcast.id },
      select: { ...BROADCAST_SELECT, recipients: { select: RECIPIENT_SELECT } },
    });
    const dto = broadcastToDto(row);
    await auditMutation(db, ctx, {
      action: "merchant_broadcast.create",
      target: `broadcast:${dto.id}`,
      after: broadcastAuditProjection(dto),
    });
    return dto;
  });
}

export interface BroadcastsPage {
  items: BroadcastDto[];
  nextCursor: string | null;
}

export async function listBroadcasts(
  ctx: TenantContext,
  filter: { limit?: number; cursor?: bigint } = {},
  base: PrismaClient = basePrisma,
): Promise<BroadcastsPage> {
  assertUsableCount(filter.limit, "limit");
  const take = Math.min(filter.limit ?? 50, 200);
  const rows = await runScopedOn(base, ctx, (db) =>
    db.broadcast.findMany({
      orderBy: { id: "desc" },
      take,
      ...(filter.cursor != null
        ? { cursor: { id: filter.cursor }, skip: 1 }
        : {}),
      select: BROADCAST_SELECT,
    }),
  );
  const last = rows.at(-1);
  const nextCursor = rows.length === take && last ? String(last.id) : null;
  return { items: rows.map(broadcastToDto), nextCursor };
}

export async function getBroadcast(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<BroadcastDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.broadcast.findUnique({
      where: { id },
      select: {
        ...BROADCAST_SELECT,
        recipients: { orderBy: { id: "asc" }, select: RECIPIENT_SELECT },
      },
    }),
  );
  if (!row) {
    throw new NotFoundError(
      "broadcast not found",
      "errors.merchantBroadcastNotFound",
    );
  }
  return broadcastToDto(row);
}

export async function getBroadcastRowOn(
  db: ScopedDb,
  id: bigint,
): Promise<BroadcastRow> {
  const row = await db.broadcast.findUnique({
    where: { id },
    select: {
      ...BROADCAST_SELECT,
      recipients: { orderBy: { id: "asc" }, select: RECIPIENT_SELECT },
    },
  });
  if (!row) {
    throw new NotFoundError(
      "broadcast not found",
      "errors.merchantBroadcastNotFound",
    );
  }
  return row;
}

// Editable while DRAFT or READY; a SENT broadcast is the record of what went
// out. Editing the body re-renders every still-PENDING recipient so the list
// always shows the text it would actually send, and knocks READY back to
// DRAFT: a changed message is one that needs the review gate again.
export async function updateBroadcast(
  ctx: TenantContext,
  id: bigint,
  input: BroadcastUpdate,
  base: PrismaClient = basePrisma,
): Promise<BroadcastDto> {
  const data = parseInput(broadcastUpdateSchema, input);
  return runScopedOn(base, ctx, async (db) => {
    const current = await getBroadcastRowOn(db, id);
    if (current.status === "SENT") {
      throw new AppError(
        "a sent broadcast can no longer be edited",
        409,
        "errors.merchantBroadcastNotEditable",
      );
    }
    const nextBody = data.body ?? current.body;
    const bodyChanged = nextBody !== current.body;
    await db.broadcast.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(bodyChanged ? { body: nextBody } : {}),
        // An explicit status wins; a body/name edit on READY implies it is
        // back under review.
        ...(data.status !== undefined
          ? { status: data.status }
          : bodyChanged && current.status === "READY"
            ? { status: "DRAFT" as const }
            : {}),
      },
    });
    if (bodyChanged) {
      const pending = (current.recipients ?? []).filter(
        (r) => r.status === "PENDING",
      );
      const leads = await db.lead.findMany({
        where: { id: { in: pending.map((r) => r.leadId) } },
        select: {
          id: true,
          authorName: true,
          authorHandle: true,
          platform: true,
          groupName: true,
        },
      });
      const byId = new Map(leads.map((l) => [l.id, l]));
      for (const r of pending) {
        const lead = byId.get(r.leadId);
        if (!lead) continue;
        await db.broadcastRecipient.update({
          where: { id: r.id },
          data: { body: renderBroadcastBody(nextBody, lead) },
        });
      }
    }
    const row = await getBroadcastRowOn(db, id);
    const dto = broadcastToDto(row);
    await auditMutation(db, ctx, {
      action: "merchant_broadcast.update",
      target: `broadcast:${id}`,
      before: broadcastAuditProjection(broadcastToDto(current)),
      after: broadcastAuditProjection(dto),
    });
    return dto;
  });
}

// "Send" marks every PENDING recipient SENT and closes the broadcast. There is
// no outward transport on this rail - the operator copies each recipient's
// rendered body to the platform by hand; this is where a zca-bridge / Zalo OA
// send would plug in.
export async function sendBroadcast(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<BroadcastDto> {
  return runScopedOn(base, ctx, async (db) => {
    const current = await getBroadcastRowOn(db, id);
    if (current.status === "SENT") {
      throw new AppError(
        "this broadcast was already sent",
        409,
        "errors.merchantBroadcastNotEditable",
      );
    }
    const now = new Date();
    const marked = await db.broadcastRecipient.updateMany({
      where: { broadcastId: id, status: "PENDING" },
      data: { status: "SENT", sentAt: now },
    });
    const sentCount = (current.recipients ?? []).filter(
      (r) => r.status === "SENT",
    ).length + marked.count;
    await db.broadcast.update({
      where: { id },
      data: { status: "SENT", sentAt: now, sentCount },
    });
    const row = await getBroadcastRowOn(db, id);
    const dto = broadcastToDto(row);
    await auditMutation(db, ctx, {
      action: "merchant_broadcast.send",
      target: `broadcast:${id}`,
      before: { status: current.status },
      after: { status: dto.status, sentCount: dto.sentCount },
    });
    return dto;
  });
}
