import { z } from "zod";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { NotFoundError, TenantTargetRequiredError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";

// Nurture sequences (per-tenant): the ordered follow-up steps a lead is walked
// through. A step names how long to wait after the previous touch
// (`delayMin`), what to stage in the outbox (`bodyTemplate`, the {{placeholders}}
// in ./templates.ts) and which channel the operator sends it on (`channel`).

export const NURTURE_CHANNELS = ["dm", "reply"] as const;
export type NurtureChannel = (typeof NURTURE_CHANNELS)[number];

export interface NurtureStep {
  delayMin: number;
  bodyTemplate: string;
  channel: NurtureChannel;
}

const stepSchema = z
  .object({
    // 0 = fire on the next drain pass; ~30 days is the longest a sequence may wait.
    delayMin: z.number().int().min(0).max(43200),
    bodyTemplate: z.string().min(1).max(5000),
    channel: z.enum(NURTURE_CHANNELS),
  })
  .strict();

export const nurtureStepsSchema = z.array(stepSchema).min(1).max(20);

export const nurtureSequenceCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    steps: nurtureStepsSchema,
    active: z.boolean().optional(),
  })
  .strict();
export type NurtureSequenceCreate = z.infer<typeof nurtureSequenceCreateSchema>;

export const nurtureSequenceUpdateSchema = nurtureSequenceCreateSchema
  .partial()
  .strict();
export type NurtureSequenceUpdate = z.infer<typeof nurtureSequenceUpdateSchema>;

export interface NurtureSequenceDto {
  id: string;
  name: string;
  steps: NurtureStep[];
  active: boolean;
  activeEnrollments: number;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  steps: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { enrollments: { where: { status: "ACTIVE" as const } } } },
} as const;

type SequenceRow = {
  id: bigint;
  name: string;
  steps: unknown;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count: { enrollments: number };
};

// Steps stored in the column were validated on write; a row that does not
// parse anyway (an older image, a hand edit) surfaces as a write-time AppError
// on update and as a cancelled enrollment in the drain, never as a crash.
export function parseNurtureSteps(raw: unknown): NurtureStep[] {
  return parseInput(nurtureStepsSchema, raw);
}

function toDto(r: SequenceRow): NurtureSequenceDto {
  return {
    id: String(r.id),
    name: r.name,
    steps: parseNurtureSteps(r.steps),
    active: r.active,
    activeEnrollments: r._count.enrollments,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function auditProjection(dto: NurtureSequenceDto) {
  return { name: dto.name, steps: dto.steps, active: dto.active };
}

export async function listNurtureSequences(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<NurtureSequenceDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.nurtureSequence.findMany({
      orderBy: { id: "desc" },
      select: SELECT,
    }),
  );
  return rows.map(toDto);
}

export async function getNurtureSequence(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<NurtureSequenceDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.nurtureSequence.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) {
    throw new NotFoundError(
      "nurture sequence not found",
      "errors.nurtureSequenceNotFound",
    );
  }
  return toDto(row);
}

export async function createNurtureSequence(
  ctx: TenantContext,
  input: NurtureSequenceCreate,
  base: PrismaClient = basePrisma,
): Promise<NurtureSequenceDto> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const tenantId = ctx.tenantId;
  const data = parseInput(nurtureSequenceCreateSchema, input);
  return runScopedOn(base, ctx, async (db) => {
    const row = await db.nurtureSequence.create({
      data: {
        tenantId,
        name: data.name,
        steps: data.steps as Prisma.InputJsonValue,
        active: data.active ?? true,
      },
      select: SELECT,
    });
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action: "nurture_sequence.create",
      target: `nurture_sequence:${dto.id}`,
      after: auditProjection(dto),
    });
    return dto;
  });
}

export async function updateNurtureSequence(
  ctx: TenantContext,
  id: bigint,
  patch: NurtureSequenceUpdate,
  base: PrismaClient = basePrisma,
): Promise<NurtureSequenceDto> {
  const data = parseInput(nurtureSequenceUpdateSchema, patch);
  return runScopedOn(base, ctx, async (db) => {
    const current = await db.nurtureSequence.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!current) {
      throw new NotFoundError(
        "nurture sequence not found",
        "errors.nurtureSequenceNotFound",
      );
    }
    const before = toDto(current);
    const row = await db.nurtureSequence.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.steps !== undefined
          ? { steps: data.steps as Prisma.InputJsonValue }
          : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
      select: SELECT,
    });
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action: "nurture_sequence.update",
      target: `nurture_sequence:${dto.id}`,
      before: auditProjection(before),
      after: auditProjection(dto),
    });
    return dto;
  });
}

export async function deleteNurtureSequence(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    const current = await db.nurtureSequence.findUnique({
      where: { id },
      select: SELECT,
    });
    const res = await db.nurtureSequence.deleteMany({ where: { id } });
    if (res.count === 0 || !current) {
      throw new NotFoundError(
        "nurture sequence not found",
        "errors.nurtureSequenceNotFound",
      );
    }
    await auditMutation(db, ctx, {
      action: "nurture_sequence.delete",
      target: `nurture_sequence:${id}`,
      before: auditProjection(toDto(current)),
    });
  });
}
