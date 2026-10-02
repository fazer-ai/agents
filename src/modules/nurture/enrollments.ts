import { z } from "zod";
import type {
  NurtureEnrollmentStatus,
  PrismaClient,
} from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { requireDbId } from "@/lib/db-id";
import {
  AppError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertUsableCount } from "@/lib/query-param";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";
import { ensureNurtureDrain } from "./drain";
import { parseNurtureSteps } from "./sequences";

// Nurture enrollments (per-tenant): one lead inside one sequence, walked step
// by step by the NURTURE_DRAIN scheduler job. One ACTIVE enrollment per
// (tenant, sequence, lead) — the partial unique index is the hard guard, and
// enrollLead answers the live row on a repeat call instead of fighting it.

export const ENROLLMENT_STATUSES = ["ACTIVE", "DONE", "CANCELLED"] as const;

export interface NurtureEnrollmentDto {
  id: string;
  sequenceId: string;
  sequenceName: string;
  leadId: string;
  leadAuthorName: string;
  stepIndex: number;
  stepCount: number;
  nextRunAt: Date;
  status: NurtureEnrollmentStatus;
  createdAt: Date;
}

const SELECT = {
  id: true,
  sequenceId: true,
  leadId: true,
  stepIndex: true,
  nextRunAt: true,
  status: true,
  createdAt: true,
  sequence: { select: { name: true, steps: true } },
  lead: { select: { authorName: true } },
} as const;

type EnrollmentRow = {
  id: bigint;
  sequenceId: bigint;
  leadId: bigint;
  stepIndex: number;
  nextRunAt: Date;
  status: NurtureEnrollmentStatus;
  createdAt: Date;
  sequence: { name: string; steps: unknown };
  lead: { authorName: string };
};

function toDto(r: EnrollmentRow): NurtureEnrollmentDto {
  let stepCount = 0;
  try {
    stepCount = parseNurtureSteps(r.sequence.steps).length;
  } catch {
    stepCount = 0;
  }
  return {
    id: String(r.id),
    sequenceId: String(r.sequenceId),
    sequenceName: r.sequence.name,
    leadId: String(r.leadId),
    leadAuthorName: r.lead.authorName,
    stepIndex: r.stepIndex,
    stepCount,
    nextRunAt: r.nextRunAt,
    status: r.status,
    createdAt: r.createdAt,
  };
}

export const enrollLeadSchema = z
  .object({
    sequenceId: z.string().min(1).max(30),
    leadId: z.string().min(1).max(30),
  })
  .strict();
export type EnrollLeadInput = z.infer<typeof enrollLeadSchema>;

export interface ListEnrollmentsFilter {
  sequenceId?: bigint;
  leadId?: bigint;
  status?: NurtureEnrollmentStatus;
  limit?: number;
  cursor?: bigint;
}

export interface EnrollmentsPage {
  items: NurtureEnrollmentDto[];
  nextCursor: string | null;
}

export async function listNurtureEnrollments(
  ctx: TenantContext,
  filter: ListEnrollmentsFilter,
  base: PrismaClient = basePrisma,
): Promise<EnrollmentsPage> {
  assertUsableCount(filter.limit, "limit");
  const take = Math.min(filter.limit ?? 50, 200);
  const rows = await runScopedOn(base, ctx, (db) =>
    db.nurtureEnrollment.findMany({
      where: {
        ...(filter.sequenceId !== undefined
          ? { sequenceId: filter.sequenceId }
          : {}),
        ...(filter.leadId !== undefined ? { leadId: filter.leadId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
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

export async function enrollLead(
  ctx: TenantContext,
  input: EnrollLeadInput,
  base: PrismaClient = basePrisma,
): Promise<NurtureEnrollmentDto> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const tenantId = ctx.tenantId;
  const data = parseInput(enrollLeadSchema, input);
  const sequenceId = requireDbId(data.sequenceId, "sequenceId");
  const leadId = requireDbId(data.leadId, "leadId");
  const dto = await runScopedOn(base, ctx, async (db) => {
    const sequence = await db.nurtureSequence.findUnique({
      where: { id: sequenceId },
      select: { id: true, active: true, steps: true },
    });
    if (!sequence) {
      throw new NotFoundError(
        "nurture sequence not found",
        "errors.nurtureSequenceNotFound",
      );
    }
    if (!sequence.active) {
      throw new AppError(
        "the sequence is paused",
        422,
        "errors.nurtureSequenceInactive",
      );
    }
    // The scoped read is what proves the lead is this tenant's: an FK checks
    // nothing under RLS (docs/tenancy.md, "an FK does not validate ownership").
    const lead = await db.lead.findUnique({
      where: { id: leadId },
      select: { id: true },
    });
    if (!lead) {
      throw new NotFoundError("lead not found", "errors.merchantLeadNotFound");
    }
    const steps = parseNurtureSteps(sequence.steps);
    const existing = await db.nurtureEnrollment.findFirst({
      where: { sequenceId, leadId, status: "ACTIVE" },
      select: SELECT,
    });
    if (existing) return toDto(existing);
    const row = await db.nurtureEnrollment.create({
      data: {
        tenantId,
        sequenceId,
        leadId,
        stepIndex: 0,
        // steps is non-empty by schema (min 1); the optional chain is only the
        // noUncheckedIndexedAccess spelling of that guarantee.
        nextRunAt: new Date(Date.now() + (steps[0]?.delayMin ?? 0) * 60_000),
      },
      select: SELECT,
    });
    const created = toDto(row);
    await auditMutation(db, ctx, {
      action: "nurture_enrollment.create",
      target: `nurture_enrollment:${created.id}`,
      after: {
        sequenceId: created.sequenceId,
        leadId: created.leadId,
        status: created.status,
      },
    });
    return created;
  });
  // Outside the scoped transaction: arms (or nudges) the tenant's drain row so
  // a new enrollment does not wait out an idle reschedule.
  await ensureNurtureDrain(tenantId, base);
  return dto;
}

export async function cancelEnrollment(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<NurtureEnrollmentDto> {
  return runScopedOn(base, ctx, async (db) => {
    const current = await db.nurtureEnrollment.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!current) {
      throw new NotFoundError(
        "nurture enrollment not found",
        "errors.nurtureEnrollmentNotFound",
      );
    }
    const before = toDto(current);
    if (before.status !== "ACTIVE") return before;
    const row = await db.nurtureEnrollment.update({
      where: { id },
      data: { status: "CANCELLED" },
      select: SELECT,
    });
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action: "nurture_enrollment.cancel",
      target: `nurture_enrollment:${dto.id}`,
      before: { status: before.status },
      after: { status: dto.status },
    });
    return dto;
  });
}
