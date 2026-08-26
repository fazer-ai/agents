import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { parseStartMs } from "@/modules/appointments/context";

// The record that a commitment exists in a conversation, and the ONLY thing the four readers of
// "is this conversation holding an appointment?" consult.
//
// It exists as its own unit because a reminder job and an appointment answer different questions. A
// job is written because something has to be SENT — so it is legitimately absent when the operator
// switched reminders off, and legitimately absent when the booking is sooner than the smallest
// configured offset (`computeReminderJobs` drops every offset whose time has passed; measured on
// main: a booking 30 minutes out with the default `[24, 1]` produced zero rows). While the rows WERE
// the record, both of those made `followUp.pauseWhileAppointment` inert with no error anywhere, and
// left the agent's own prompt without the appointment it was being asked about (issue #376).
//
// Writing is unconditional; arming reminders is the conditional half, and it lives in reminders.ts.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface RecordAppointmentArgs {
  tenantId: bigint;
  // The per-conversation thread (`tenant:instance:convId`).
  threadId: string;
  // The booking's identity in the system that owns it (a Google Calendar event id today).
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
// reports it (prepare.ts binds a flowlog warn), and the appointment simply has no record — the same
// place the reader lands anyway, since nothing can decide liveness from a start it cannot parse.
export type RecordAppointmentResult = "recorded" | "unreadable-start";

// Upsert by (tenant, externalId): a reschedule of the same booking MOVES the record rather than
// leaving a second one behind, and it CLEARS the tombstone, because the same appointment being
// re-booked is the appointment standing again.
export async function recordAppointment(
  args: RecordAppointmentArgs,
): Promise<RecordAppointmentResult> {
  const startMs = parseStartMs(args.startISO);
  if (!Number.isFinite(startMs)) return "unreadable-start";
  const base = args.base ?? basePrisma;
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
        tenantId_externalId: {
          tenantId: args.tenantId,
          externalId: args.externalId,
        },
      },
      create: { tenantId: args.tenantId, externalId: args.externalId, ...data },
      update: data,
    }),
  );
  return "recorded";
}

// The appointment stopped standing. Never a delete: a cancelled appointment has to stay
// distinguishable from one that never existed, and the reminder handler still has rows pointing at
// it. Silent when there is no record — the caller cancels reminders whether or not one was written.
export async function cancelAppointmentRecord(
  tenantId: bigint,
  externalId: string,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.appointment.updateMany({
      where: { tenantId, externalId, cancelledAt: null },
      data: { cancelledAt: new Date() },
    }),
  );
}

// Every appointment THIS conversation holds stops standing. /reset is the caller, and the scope is
// the thread for the reason reminders.ts gives at length: a command that knows only the thread must
// not reach an appointment a later conversation now owns.
//
// Returns how many records it reached.
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
