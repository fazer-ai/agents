import { z } from "zod";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  isRangeOrdered,
  isRealDate,
  parseExceptions,
  parseSchedule,
  parseWindows,
  type Schedule,
  type ScheduleException,
  scheduleExceptionSchema,
  type WindowSpec,
  windowSpecSchema,
} from "./hours";

// Business-hours schedules (per-tenant). An agent references one via Agent.businessHoursId; the
// follow-up scheduler and out-of-hours behavior use the windows + timezone. API-created rows are
// always source=LOCAL; CHATWOOT_MIRROR rows are written by the inbox sync (a separate path).

export interface BusinessHoursDto {
  id: string;
  name: string;
  timezone: string;
  windows: WindowSpec[];
  exceptions: ScheduleException[];
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  timezone: true,
  windows: true,
  exceptions: true,
  source: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDto(r: {
  id: bigint;
  name: string;
  timezone: string;
  windows: unknown;
  exceptions: unknown;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}): BusinessHoursDto {
  return {
    id: String(r.id),
    name: r.name,
    timezone: r.timezone,
    windows: parseWindows(r.windows),
    exceptions: parseExceptions(r.exceptions),
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function assertValidTimezone(tz: string): void {
  try {
    // Throws RangeError for an unknown IANA zone.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new AppError(
      `invalid timezone: ${tz}`,
      400,
      "errors.invalidTimezone",
    );
  }
}

// Reject windows whose end is not strictly after their start: such a window can
// never be open (overnight windows are not supported) and would silently behave
// as a no-op. The editor prevents this client-side; this guards the REST/MCP paths.
function assertValidWindows(windows: WindowSpec[]): void {
  for (const w of windows) {
    if (!isRangeOrdered(w)) {
      throw new AppError(
        `invalid window for day ${w.day}: end (${w.end}) must be after start (${w.start})`,
        400,
        "errors.invalidBusinessHoursWindow",
      );
    }
  }
}

// Same contract for the exception ranges, plus the two things a regex cannot decide: that the date is
// a day that exists (2026-02-30 parses and would roll over into March), and that a dated span does
// not run backwards. A RECURRING span may: its end month-day precedes its start when it wraps the
// year end, which is how a Dec 23 → Jan 2 shutdown is written.
function assertValidExceptions(exceptions: ScheduleException[]): void {
  for (const e of exceptions) {
    if (!isRealDate(e.date) || (e.dateEnd && !isRealDate(e.dateEnd))) {
      throw new AppError(
        `invalid exception date: ${e.dateEnd ? `${e.date}..${e.dateEnd}` : e.date} is not a calendar date`,
        400,
        "errors.invalidBusinessHoursException",
      );
    }
    if (e.dateEnd && !e.recurring && e.dateEnd < e.date) {
      throw new AppError(
        `invalid exception span: end (${e.dateEnd}) is before start (${e.date})`,
        400,
        "errors.invalidBusinessHoursException",
      );
    }
    for (const r of e.ranges) {
      if (!isRangeOrdered(r)) {
        throw new AppError(
          `invalid range on ${e.date}: end (${r.end}) must be after start (${r.start})`,
          400,
          "errors.invalidBusinessHoursException",
        );
      }
    }
  }
}

export const businessHoursCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    timezone: z.string().min(1).max(64).optional(),
    windows: z.array(windowSpecSchema).max(200).optional(),
    exceptions: z.array(scheduleExceptionSchema).max(400).optional(),
  })
  .strict();
export type BusinessHoursCreate = z.infer<typeof businessHoursCreateSchema>;

export const businessHoursUpdateSchema = businessHoursCreateSchema
  .partial()
  .strict();
export type BusinessHoursUpdate = z.infer<typeof businessHoursUpdateSchema>;

export async function listBusinessHours(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<BusinessHoursDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.businessHours.findMany({ select: SELECT, orderBy: { name: "asc" } }),
  );
  return rows.map(toDto);
}

export async function getBusinessHours(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<BusinessHoursDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.businessHours.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) {
    throw new NotFoundError(
      "business hours not found",
      "errors.businessHoursNotFound",
    );
  }
  return toDto(row);
}

// The whole schedule behind an id that arrives as a STRING from an integration config, for the
// availability paths. Null (⇒ "always on" at the caller) for a non-numeric, deleted, or other-tenant
// id: the read is scoped, so RLS is what fences the last case. Separate from getBusinessHours, which
// is the API projection and throws for a missing row.
export async function readSchedule(
  ctx: TenantContext,
  id: string,
  base: PrismaClient = basePrisma,
): Promise<Schedule | null> {
  const parsed = parseDbId(id);
  if (parsed === null) return null;
  const row = await runScopedOn(base, ctx, (db) =>
    db.businessHours.findUnique({
      where: { id: parsed },
      select: { windows: true, exceptions: true, timezone: true },
    }),
  );
  return row ? parseSchedule(row) : null;
}

export async function createBusinessHours(
  ctx: TenantContext,
  input: BusinessHoursCreate,
  base: PrismaClient = basePrisma,
): Promise<BusinessHoursDto> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const data = businessHoursCreateSchema.parse(input);
  if (data.timezone) assertValidTimezone(data.timezone);
  if (data.windows) assertValidWindows(data.windows);
  if (data.exceptions) assertValidExceptions(data.exceptions);
  return runScopedOn(base, ctx, async (db) => {
    const row = await db.businessHours.create({
      data: {
        tenantId,
        name: data.name,
        ...(data.timezone ? { timezone: data.timezone } : {}),
        windows: (data.windows ?? []) as Prisma.InputJsonValue,
        exceptions: (data.exceptions ?? []) as Prisma.InputJsonValue,
        source: "LOCAL",
      },
      select: SELECT,
    });
    return toDto(row);
  });
}

export async function updateBusinessHours(
  ctx: TenantContext,
  id: bigint,
  patch: BusinessHoursUpdate,
  base: PrismaClient = basePrisma,
): Promise<BusinessHoursDto> {
  const data = businessHoursUpdateSchema.parse(patch);
  if (data.timezone) assertValidTimezone(data.timezone);
  if (data.windows) assertValidWindows(data.windows);
  if (data.exceptions) assertValidExceptions(data.exceptions);
  return runScopedOn(base, ctx, async (db) => {
    const current = await db.businessHours.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!current) {
      throw new NotFoundError(
        "business hours not found",
        "errors.businessHoursNotFound",
      );
    }
    await db.businessHours.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
        ...(data.windows !== undefined
          ? { windows: data.windows as Prisma.InputJsonValue }
          : {}),
        ...(data.exceptions !== undefined
          ? { exceptions: data.exceptions as Prisma.InputJsonValue }
          : {}),
      },
    });
    const row = await db.businessHours.findUniqueOrThrow({
      where: { id },
      select: SELECT,
    });
    return toDto(row);
  });
}

export async function deleteBusinessHours(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    // Detach any agent pointing here (plain reference, no FK cascade) before removing.
    await db.agent.updateMany({
      where: { businessHoursId: id },
      data: { businessHoursId: null },
    });
    const res = await db.businessHours.deleteMany({ where: { id } });
    if (res.count === 0) {
      throw new NotFoundError(
        "business hours not found",
        "errors.businessHoursNotFound",
      );
    }
  });
}
