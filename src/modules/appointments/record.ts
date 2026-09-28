import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { parseStartMs } from "@/modules/appointments/context";
import { GOOGLE_CALENDAR_PROVIDER } from "@/modules/appointments/provider";

// The record that a commitment exists in a conversation, and the ONLY thing the four readers of
// "is this conversation holding an appointment?" consult.
//
// A reminder job is not this record: a job exists only when something has to be SENT, so it is
// absent when reminders are off or the booking is sooner than every offset. Writing the record is
// unconditional; arming reminders is the conditional half, in reminders.ts.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface RecordAppointmentArgs {
  tenantId: bigint;
  // The per-conversation thread (`tenant:instance:convId`).
  threadId: string;
  // The system that owns the booking. Defaults to Google Calendar.
  provider?: string;
  // The booking's identity WITHIN that provider (a Google Calendar event id, a row id in the
  // operator's own system).
  externalId: string;
  // The start as the owning system stated it, offset included. Stored verbatim AND parsed.
  startISO: string;
  summary?: string | null;
  calendarId?: string | null;
  calendarLabel?: string | null;
  base?: PrismaClient;
}

// "unreadable-start" rather than a throw: the caller is a tool that already booked a real
// appointment, and the booking must not be undone because we could not judge its start. The caller
// reports it (prepare.ts binds a flowlog warn), and the appointment simply has no record: nothing
// can decide liveness from a start it cannot parse anyway.
export type RecordAppointmentResult = "recorded" | "unreadable-start";

// Upsert by (tenant, provider, externalId): a reschedule of the same booking MOVES the record rather
// than leaving a second one behind, and it CLEARS the tombstone, because the same appointment being
// re-booked is the appointment standing again. The provider is part of the key: two operator
// systems that both count from 1 must not overwrite each other's bookings.
export async function recordAppointment(
  args: RecordAppointmentArgs,
): Promise<RecordAppointmentResult> {
  const startMs = parseStartMs(args.startISO);
  if (!Number.isFinite(startMs)) return "unreadable-start";
  const base = args.base ?? basePrisma;
  const provider = args.provider ?? GOOGLE_CALENDAR_PROVIDER;
  const startAt = new Date(startMs);
  const data = {
    threadId: args.threadId,
    startAt,
    startIso: args.startISO,
    summary: args.summary ?? null,
    calendarId: args.calendarId ?? null,
    calendarLabel: args.calendarLabel ?? null,
    cancelledAt: null,
  };
  await runScopedOn(base, sysCtx(args.tenantId), (db) =>
    db.appointment.upsert({
      where: {
        tenantId_provider_externalId: {
          tenantId: args.tenantId,
          provider,
          externalId: args.externalId,
        },
      },
      create: {
        tenantId: args.tenantId,
        provider,
        externalId: args.externalId,
        ...data,
      },
      update: data,
    }),
  );
  return "recorded";
}

// THE START THIS APPOINTMENT IS CURRENTLY RECORDED AT, or null when nothing is recorded. Read by
// the record-only path: preserving the reminders already armed is right for a re-statement of the
// SAME booking and wrong for one that moved, because a reminder carries the time it was armed for
// and would announce the obsolete one.
export async function storedAppointmentStart(
  tenantId: bigint,
  externalId: string,
  base: PrismaClient = basePrisma,
  provider: string = GOOGLE_CALENDAR_PROVIDER,
): Promise<Date | null> {
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.appointment.findUnique({
      where: {
        tenantId_provider_externalId: { tenantId, provider, externalId },
      },
      select: { startAt: true, cancelledAt: true },
    }),
  );
  // NOTE: A cancelled record has no reminders left to protect, so it reads as nothing recorded.
  return row && !row.cancelledAt ? row.startAt : null;
}

// The appointment stopped standing. Never a delete: a cancelled appointment has to stay
// distinguishable from one that never existed, and the reminder handler still has rows pointing at
// it. Silent when there is no record: the caller cancels reminders whether or not one was written.
export async function cancelAppointmentRecord(
  tenantId: bigint,
  externalId: string,
  base: PrismaClient = basePrisma,
  provider: string = GOOGLE_CALENDAR_PROVIDER,
): Promise<void> {
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.appointment.updateMany({
      where: { tenantId, provider, externalId, cancelledAt: null },
      data: { cancelledAt: new Date() },
    }),
  );
}

// Every appointment THIS conversation holds stops standing; returns how many records it reached.
// /reset is the caller, and the scope is the thread: a command that knows only the thread must not
// reach an appointment a later conversation now owns.
export async function cancelThreadAppointmentRecords(
  tenantId: bigint,
  threadId: string,
  base: PrismaClient = basePrisma,
): Promise<number> {
  const { count } = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.appointment.updateMany({
      where: { tenantId, threadId, cancelledAt: null },
      data: { cancelledAt: new Date() },
    }),
  );
  return count;
}
