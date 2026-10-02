import type {
  NurtureOutboxStatus,
  PrismaClient,
} from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { assertUsableCount } from "@/lib/query-param";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";

// The nurture outbox (per-tenant): the rendered follow-ups an operator reviews
// and sends BY HAND. Nothing here reaches an external platform — marking a row
// sent is the operator's own record that they delivered it.

export const OUTBOX_STATUSES = ["PENDING", "SENT", "CANCELLED"] as const;

export interface NurtureOutboxDto {
  id: string;
  enrollmentId: string;
  sequenceName: string;
  leadId: string;
  leadAuthorName: string;
  leadPlatform: string;
  leadSourceUrl: string | null;
  body: string;
  status: NurtureOutboxStatus;
  sentAt: Date | null;
  createdAt: Date;
}

const SELECT = {
  id: true,
  enrollmentId: true,
  leadId: true,
  body: true,
  status: true,
  sentAt: true,
  createdAt: true,
  enrollment: { select: { sequence: { select: { name: true } } } },
  lead: { select: { authorName: true, platform: true, sourceUrl: true } },
} as const;

type OutboxRow = {
  id: bigint;
  enrollmentId: bigint;
  leadId: bigint;
  body: string;
  status: NurtureOutboxStatus;
  sentAt: Date | null;
  createdAt: Date;
  enrollment: { sequence: { name: string } };
  lead: { authorName: string; platform: string; sourceUrl: string | null };
};

function toDto(r: OutboxRow): NurtureOutboxDto {
  return {
    id: String(r.id),
    enrollmentId: String(r.enrollmentId),
    sequenceName: r.enrollment.sequence.name,
    leadId: String(r.leadId),
    leadAuthorName: r.lead.authorName,
    leadPlatform: r.lead.platform,
    leadSourceUrl: r.lead.sourceUrl,
    body: r.body,
    status: r.status,
    sentAt: r.sentAt,
    createdAt: r.createdAt,
  };
}

export interface ListOutboxFilter {
  status?: NurtureOutboxStatus;
  leadId?: bigint;
  limit?: number;
  cursor?: bigint;
}

export interface OutboxPage {
  items: NurtureOutboxDto[];
  nextCursor: string | null;
}

export async function listNurtureOutbox(
  ctx: TenantContext,
  filter: ListOutboxFilter,
  base: PrismaClient = basePrisma,
): Promise<OutboxPage> {
  assertUsableCount(filter.limit, "limit");
  const take = Math.min(filter.limit ?? 50, 200);
  const rows = await runScopedOn(base, ctx, (db) =>
    db.nurtureOutbox.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.leadId !== undefined ? { leadId: filter.leadId } : {}),
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

// PENDING is the only state an operator action may leave from, and the
// compare-and-set is the whole fence: two tabs marking the same row cannot both
// win, because the second updateMany matches nothing.
async function transitionOutbox(
  ctx: TenantContext,
  id: bigint,
  to: "SENT" | "CANCELLED",
  action: "nurture_outbox.sent" | "nurture_outbox.cancel",
  extra: { sentAt?: Date } = {},
  base: PrismaClient = basePrisma,
): Promise<NurtureOutboxDto> {
  return runScopedOn(base, ctx, async (db) => {
    const current = await db.nurtureOutbox.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!current) {
      throw new NotFoundError(
        "outbox row not found",
        "errors.nurtureOutboxNotFound",
      );
    }
    const res = await db.nurtureOutbox.updateMany({
      where: { id, status: "PENDING" },
      data: { status: to, ...extra },
    });
    if (res.count === 0) {
      throw new AppError(
        "the outbox row is no longer pending",
        409,
        "errors.nurtureOutboxNotPending",
      );
    }
    const row = await db.nurtureOutbox.findUniqueOrThrow({
      where: { id },
      select: SELECT,
    });
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action,
      target: `nurture_outbox:${dto.id}`,
      before: { status: "PENDING" },
      after: { status: dto.status },
    });
    return dto;
  });
}

export function markOutboxSent(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<NurtureOutboxDto> {
  return transitionOutbox(
    ctx,
    id,
    "SENT",
    "nurture_outbox.sent",
    {
      sentAt: new Date(),
    },
    base,
  );
}

export function cancelOutboxItem(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<NurtureOutboxDto> {
  return transitionOutbox(
    ctx,
    id,
    "CANCELLED",
    "nurture_outbox.cancel",
    {},
    base,
  );
}
