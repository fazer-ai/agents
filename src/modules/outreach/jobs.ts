import { z } from "zod";
import type {
  OutreachJobKind,
  OutreachJobStatus,
  PrismaClient,
} from "@/../generated/prisma/client";
import { Prisma } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { requireDbId } from "@/lib/db-id";
import {
  AppError,
  ConflictError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertUsableCount } from "@/lib/query-param";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { auditMutation } from "@/modules/audit/service";
import { assertAccountQueueable, effectiveSentToday } from "./accounts";
import { recordJobSent } from "./send";
import {
  assertOutreachEnabled,
  OUTREACH_JOB_KINDS,
  OUTREACH_JOB_STATUSES,
} from "./shared";

// Outreach jobs: one intended touch against one lead from one account. Every
// job is born QUEUED; only an operator approve() makes it claimable, and the
// worker never sends QUEUED work. The (tenant, lead, account, kind) unique key
// is the per-lead dedupe - the same lead can never be double-messaged the same
// way from the same account, even across requeues.

export interface OutreachJobDto {
  id: string;
  accountId: string;
  accountHandle: string;
  accountPlatform: string;
  leadId: string;
  leadAuthorName: string;
  leadAuthorHandle: string | null;
  // The lead's post text, clipped for the queue table - the operator approves
  // the JOB's body, but the snippet is what reminds them who this is.
  leadText: string;
  kind: OutreachJobKind;
  body: string;
  status: OutreachJobStatus;
  scheduledAt: Date;
  sentAt: Date | null;
  error: string | null;
  attempts: number;
  createdAt: Date;
}

const SELECT = {
  id: true,
  accountId: true,
  leadId: true,
  kind: true,
  body: true,
  status: true,
  scheduledAt: true,
  sentAt: true,
  error: true,
  attempts: true,
  createdAt: true,
  account: { select: { handle: true, platform: true } },
  lead: { select: { authorName: true, authorHandle: true, text: true } },
} as const;

type JobRow = {
  id: bigint;
  accountId: bigint;
  leadId: bigint;
  kind: OutreachJobKind;
  body: string;
  status: OutreachJobStatus;
  scheduledAt: Date;
  sentAt: Date | null;
  error: string | null;
  attempts: number;
  createdAt: Date;
  account: { handle: string; platform: string };
  lead: { authorName: string; authorHandle: string | null; text: string };
};

function toDto(r: JobRow): OutreachJobDto {
  return {
    id: String(r.id),
    accountId: String(r.accountId),
    accountHandle: r.account.handle,
    accountPlatform: r.account.platform,
    leadId: String(r.leadId),
    leadAuthorName: r.lead.authorName,
    leadAuthorHandle: r.lead.authorHandle,
    leadText: clipText(r.lead.text, 200),
    kind: r.kind,
    body: r.body,
    status: r.status,
    scheduledAt: r.scheduledAt,
    sentAt: r.sentAt,
    error: r.error,
    attempts: r.attempts,
    createdAt: r.createdAt,
  };
}

export const outreachJobCreateSchema = z
  .object({
    accountId: z.string().min(1).max(30),
    leadId: z.string().min(1).max(30),
    kind: z.enum(OUTREACH_JOB_KINDS),
    body: z.string().min(1).max(5000),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type OutreachJobCreate = z.input<typeof outreachJobCreateSchema>;

// The statuses that still count against the account's queue budget: everything
// not yet terminal. READY_FOR_MANUAL counts because the send is owed even if
// the operator never confirms it.
const PENDING_STATUSES: OutreachJobStatus[] = [
  "QUEUED",
  "APPROVED",
  "SENDING",
  "READY_FOR_MANUAL",
];

function clampLimit(limit: number | undefined): number {
  assertUsableCount(limit, "limit");
  return Math.min(limit ?? 50, 200);
}

export interface ListOutreachJobsFilter {
  limit?: number;
  cursor?: bigint;
  status?: OutreachJobStatus;
  accountId?: bigint;
}

export interface OutreachJobsPage {
  items: OutreachJobDto[];
  nextCursor: string | null;
}

export async function listOutreachJobs(
  ctx: TenantContext,
  filter: ListOutreachJobsFilter,
  base: PrismaClient = basePrisma,
): Promise<OutreachJobsPage> {
  assertOutreachEnabled();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const take = clampLimit(filter.limit);
  const rows = await runScopedOn(base, ctx, (db) =>
    db.outreachJob.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.accountId !== undefined
          ? { accountId: filter.accountId }
          : {}),
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

export async function getOutreachJob(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<OutreachJobDto> {
  assertOutreachEnabled();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const row = await runScopedOn(base, ctx, (db) =>
    db.outreachJob.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) {
    throw new NotFoundError(
      "outreach job not found",
      "errors.outreachJobNotFound",
    );
  }
  return toDto(row);
}

// Queue a new job. Rules: account exists in this tenant and is not BANNED, the
// lead exists in this tenant, and the account still has room - pending jobs
// plus today's sends together stay under dailyCap, so a queue cannot be built
// past what the account is allowed to send. The unique (tenant, lead, account,
// kind) key dedupes; a replay answers 409.
export async function queueOutreachJob(
  ctx: TenantContext,
  input: OutreachJobCreate,
  base: PrismaClient = basePrisma,
): Promise<OutreachJobDto> {
  assertOutreachEnabled();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const tenantId = ctx.tenantId;
  const data = parseInput(outreachJobCreateSchema, input);
  const accountId = requireDbId(data.accountId, "accountId");
  const leadId = requireDbId(data.leadId, "leadId");
  const scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
    throw new AppError(
      "The value sent in scheduledAt is not valid.",
      422,
      "errors.invalidRequestValue",
      { field: "scheduledAt" },
      "scheduledAt",
    );
  }
  try {
    return await runScopedOn(base, ctx, async (db) => {
      const account = await db.outreachAccount.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          status: true,
          dailyCap: true,
          sentToday: true,
          sentTodayDate: true,
        },
      });
      if (!account) {
        throw new NotFoundError(
          "outreach account not found",
          "errors.outreachAccountNotFound",
        );
      }
      assertAccountQueueable(account);
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
      const pending = await db.outreachJob.count({
        where: { accountId, status: { in: PENDING_STATUSES } },
      });
      if (effectiveSentToday(account) + pending >= account.dailyCap) {
        throw new AppError(
          "This outreach account has reached its daily cap",
          422,
          "errors.outreachDailyCap",
        );
      }
      const row = await db.outreachJob.create({
        data: {
          tenantId,
          accountId,
          leadId,
          kind: data.kind,
          body: data.body,
          scheduledAt: scheduledAt ?? undefined,
        },
        select: SELECT,
      });
      const dto = toDto(row);
      await auditMutation(db, ctx, {
        action: "outreach_job.queue",
        target: `outreach_job:${dto.id}`,
        after: {
          accountId: dto.accountId,
          leadId: dto.leadId,
          kind: dto.kind,
          scheduledAt: dto.scheduledAt.toISOString(),
        },
      });
      return dto;
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ConflictError(
        "This lead already has an outreach job of this kind on this account",
        "errors.outreachJobDuplicate",
      );
    }
    throw err;
  }
}

// One guarded transition, shared by approve/cancel/requeue: the job must sit in
// exactly the state the transition is defined from, or the request is a 409
// against the current row rather than a silent no-op.
async function transitionJob(
  ctx: TenantContext,
  id: bigint,
  from: OutreachJobStatus[],
  to: OutreachJobStatus,
  action:
    | "outreach_job.approve"
    | "outreach_job.cancel"
    | "outreach_job.requeue",
  base: PrismaClient,
): Promise<OutreachJobDto> {
  assertOutreachEnabled();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return runScopedOn(base, ctx, async (db) => {
    const before = await db.outreachJob.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!before) {
      throw new NotFoundError(
        "outreach job not found",
        "errors.outreachJobNotFound",
      );
    }
    if (!from.includes(before.status)) {
      throw new ConflictError(
        `This job is ${before.status} and cannot make this transition.`,
        "errors.outreachJobState",
        { status: before.status },
      );
    }
    const { count } = await db.outreachJob.updateMany({
      where: { id, status: { in: from } },
      data: { status: to },
    });
    // Lost the race to the worker or another operator between the read and the
    // write: report it as a state conflict rather than pretending it landed.
    if (count === 0) {
      throw new ConflictError(
        "This job changed state while the request was in flight",
        "errors.outreachJobRace",
      );
    }
    await auditMutation(db, ctx, {
      action,
      target: `outreach_job:${String(id)}`,
      before: { status: before.status },
      after: { status: to },
    });
    const row = await db.outreachJob.findUniqueOrThrow({
      where: { id },
      select: SELECT,
    });
    return toDto(row);
  });
}

export function approveOutreachJob(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<OutreachJobDto> {
  // QUEUED -> APPROVED is the one transition that makes a job sendable.
  return transitionJob(
    ctx,
    id,
    ["QUEUED"],
    "APPROVED",
    "outreach_job.approve",
    base,
  );
}

export function cancelOutreachJob(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<OutreachJobDto> {
  // SENDING is absent on purpose: by the time a request could name the job the
  // send has already resolved one way or the other.
  return transitionJob(
    ctx,
    id,
    ["QUEUED", "APPROVED", "READY_FOR_MANUAL"],
    "CANCELLED",
    "outreach_job.cancel",
    base,
  );
}

export function requeueOutreachJob(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<OutreachJobDto> {
  // A failed send goes back to QUEUED, not APPROVED: the requeue is a new send
  // decision and needs the same explicit approval the first one did.
  return transitionJob(
    ctx,
    id,
    ["FAILED"],
    "QUEUED",
    "outreach_job.requeue",
    base,
  );
}

// The operator's confirmation that a READY_FOR_MANUAL job was sent by hand.
// Same successful-send effects as the worker's transport path: SENT + sentAt,
// the lead moves to CONTACTED, and the audit event is written.
export async function markOutreachJobSent(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<OutreachJobDto> {
  assertOutreachEnabled();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return runScopedOn(base, ctx, async (db) => {
    const before = await db.outreachJob.findUnique({
      where: { id },
      select: { id: true, status: true, accountId: true, leadId: true },
    });
    if (!before) {
      throw new NotFoundError(
        "outreach job not found",
        "errors.outreachJobNotFound",
      );
    }
    if (before.status !== "READY_FOR_MANUAL") {
      throw new ConflictError(
        `This job is ${before.status} and cannot make this transition.`,
        "errors.outreachJobState",
        { status: before.status },
      );
    }
    const { count } = await db.outreachJob.updateMany({
      where: { id, status: "READY_FOR_MANUAL" },
      data: { status: "SENT", sentAt: new Date(), error: null },
    });
    if (count === 0) {
      throw new ConflictError(
        "This job changed state while the request was in flight",
        "errors.outreachJobRace",
      );
    }
    await recordJobSent(db, ctx, before);
    const row = await db.outreachJob.findUniqueOrThrow({
      where: { id },
      select: SELECT,
    });
    return toDto(row);
  });
}

export interface OutreachStats {
  accounts: {
    total: number;
    active: number;
    paused: number;
    banned: number;
    sentToday: number;
  };
  jobs: Record<OutreachJobStatus, number>;
}

export async function outreachStats(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<OutreachStats> {
  assertOutreachEnabled();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return runScopedOn(base, ctx, async (db) => {
    const accountRows = await db.outreachAccount.findMany({
      select: { status: true, sentToday: true, sentTodayDate: true },
    });
    const jobGroups = await db.outreachJob.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const jobs = Object.fromEntries(
      OUTREACH_JOB_STATUSES.map((s) => [s, 0]),
    ) as Record<OutreachJobStatus, number>;
    for (const g of jobGroups) jobs[g.status] = g._count._all;
    return {
      accounts: {
        total: accountRows.length,
        active: accountRows.filter((r) => r.status === "ACTIVE").length,
        paused: accountRows.filter((r) => r.status === "PAUSED").length,
        banned: accountRows.filter((r) => r.status === "BANNED").length,
        sentToday: accountRows.reduce((n, r) => n + effectiveSentToday(r), 0),
      },
      jobs,
    };
  });
}
