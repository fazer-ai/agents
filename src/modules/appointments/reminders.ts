import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { type AgentNudge, parseThreadId, runAgentNudge } from "@/graph/nudge";
import type { RuntimeDeps } from "@/graph/runtime";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { loadAppointmentContext } from "@/modules/appointments/context";
import {
  type ClaimedJob,
  cancelPendingJobsByPrefix,
  enqueueJob,
} from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { ensureFreshGoogleAccessToken } from "@/modules/vault/google-oauth";

// Deterministic appointment reminders (n8n v3 parity, no Google polling). When the agent books an
// appointment, the Calendar toolpack calls enqueueAppointmentReminders → one APPOINTMENT_REMINDER
// scheduler job per configured offset, runAt = start − offset. The single-leader worker drains them:
// the handler verifies the event is still alive + in the future, then runAgentNudge injects a system
// turn so the agent sends a (service-window-gated) reminder — and, on the LAST reminder, may ask the
// customer to confirm attendance (the agent marks the event via calendar_confirm_appointment).
// Cancel / reschedule the appointment ⇒ cancelAppointmentReminders drops the pending jobs (re-armed
// on reschedule). Reminders live ONLY as scheduler rows; nothing is polled.

const GCAL_ORIGIN = "https://www.googleapis.com/calendar/v3";
const FETCH_TIMEOUT_MS = 10_000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// The dedupeKey prefix for ALL of an event's reminders — cancelAppointmentReminders drops them by it.
function reminderPrefix(eventId: string): string {
  return `reminder:${eventId}:`;
}

export interface ReminderJob {
  offsetHours: number;
  runAt: Date;
  // The closest (smallest-offset) reminder — the one that may ask for confirmation.
  isLast: boolean;
}

// Pure: turn a start time + offsets into the reminder jobs to enqueue. Offsets are de-duped, sorted
// DESCENDING (far → near), and any whose reminder time is already in the past (≤ now) is skipped. The
// SMALLEST surviving offset is flagged isLast. No I/O, no Date.now() — `now` is injected (testable).
export function computeReminderJobs(
  startISO: string,
  offsetsHours: number[],
  now: Date,
): ReminderJob[] {
  const startMs = Date.parse(startISO);
  if (Number.isNaN(startMs)) return [];
  const offsets = [
    ...new Set(offsetsHours.filter((h) => Number.isFinite(h) && h > 0)),
  ].sort((a, b) => b - a);
  if (offsets.length === 0) return [];
  const smallest = offsets[offsets.length - 1];
  const out: ReminderJob[] = [];
  for (const offset of offsets) {
    const runAt = new Date(startMs - offset * 3_600_000);
    if (runAt.getTime() <= now.getTime()) continue;
    out.push({ offsetHours: offset, runAt, isLast: offset === smallest });
  }
  return out;
}

export interface ScheduleAppointmentRemindersArgs {
  tenantId: bigint;
  threadId: string;
  eventId: string;
  calendarId: string;
  credentialRef: string | null;
  startISO: string;
  offsetsHours: number[];
  askConfirmationOnLast: boolean;
  // Carried into the job payload so the per-turn appointment context (and the reminder turn itself)
  // can describe the event without a Google call. Snapshotted at (re)arm time — a rename made
  // directly in Google Calendar goes stale until the next reschedule re-arms.
  summary?: string | null;
  calendarLabel?: string | null;
  base?: PrismaClient;
  now?: Date;
}

// Enqueue one APPOINTMENT_REMINDER job per surviving offset (dedupeKey `reminder:<eventId>:<offset>`,
// so a re-arm replaces the same row). Returns how many were enqueued. `enqueue` is injectable for
// hermetic tests.
export async function enqueueAppointmentReminders(
  args: ScheduleAppointmentRemindersArgs,
  enqueue: typeof enqueueJob = enqueueJob,
): Promise<number> {
  const now = args.now ?? new Date();
  const jobs = computeReminderJobs(args.startISO, args.offsetsHours, now);
  for (const j of jobs) {
    await enqueue({
      tenantId: args.tenantId,
      kind: "APPOINTMENT_REMINDER",
      dedupeKey: `${reminderPrefix(args.eventId)}${j.offsetHours}`,
      runAt: j.runAt,
      payload: {
        threadId: args.threadId,
        eventId: args.eventId,
        calendarId: args.calendarId,
        credentialRef: args.credentialRef,
        startISO: args.startISO,
        offsetHours: j.offsetHours,
        isLast: j.isLast,
        askConfirmation: args.askConfirmationOnLast,
        summary: args.summary ?? null,
        calendarLabel: args.calendarLabel ?? null,
      },
      base: args.base,
    });
  }
  return jobs.length;
}

// Cancel every pending reminder for an appointment (on cancel / before a reschedule re-arms them).
export async function cancelAppointmentReminders(
  tenantId: bigint,
  eventId: string,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await cancelPendingJobsByPrefix(
    tenantId,
    "APPOINTMENT_REMINDER",
    reminderPrefix(eventId),
    base,
  );
  // NOTE: Tombstone EVERY row of this event (fired DONE rows included). Cancelling marks jobs DONE,
  // which is indistinguishable from "fired" — without the stamp, the per-turn appointment context
  // would keep presenting a cancelled appointment as live until its start passed. A reschedule
  // re-arm replaces the payload wholesale (enqueueJob's upsert is authoritative), clearing the stamp
  // on the offsets that survive. One atomic jsonb merge, never read-modify-write: a concurrent
  // re-arm's payload is stamped or replaced whole, so a stale snapshot can never clobber it.
  await runScopedOn(base, sysCtx(tenantId), async (db) => {
    // LIKE needs its own escaping (Google recurrence ids carry `_`).
    const likePrefix = `${reminderPrefix(eventId).replace(/[\\%_]/g, "\\$&")}%`;
    const stamp = JSON.stringify({ cancelledAt: new Date().toISOString() });
    await db.$executeRaw`
      UPDATE scheduler_jobs
         SET payload = payload || ${stamp}::jsonb, updated_at = now()
       WHERE tenant_id = ${tenantId}
         AND kind = 'APPOINTMENT_REMINDER'
         AND dedupe_key LIKE ${likePrefix}`;
  });
}

// True while this conversation (by thread) has at least one LIVE appointment — a queued reminder row
// (PENDING/CLAIMED) or an already-fired one whose start is still ahead, tombstones excluded: the shared
// projectAppointmentEvents predicate, via loadAppointmentContext. The follow-up handler uses it to
// pause re-engagement while a booking is live (FollowUpConfig.pauseWhileAppointment): a customer who
// just booked should not get "still there?" nudges until the appointment passes / is cancelled.
// NOTE: Anchoring on PENDING rows alone went blind after the LAST reminder fired (issue #39).
// Tenant-scoped.
export async function hasLiveAppointment(
  tenantId: bigint,
  threadId: string,
  base: PrismaClient = basePrisma,
): Promise<boolean> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const events = await loadAppointmentContext(db, tenantId, threadId);
    return events.length > 0;
  });
}

export interface ReminderNudgeArgs {
  isLast: boolean;
  askConfirmation: boolean;
  summary: string;
  startISO: string;
  eventId: string;
  calendarId: string;
}

// Pure: the system nudge for a reminder. The event's identity travels as fenced-data refs (the ids
// the calendar tools take as arguments — issue #22: without them the agent that answers the reply
// cannot tell WHICH appointment the reminder was about), and the instructions point at the refs by
// key. On the last reminder with confirmation enabled, instruct the agent to ask for confirmation
// and to mark the event via calendar_confirm_appointment.
export function reminderNudge(a: ReminderNudgeArgs): AgentNudge {
  const wantsConfirmation = a.isLast && a.askConfirmation;
  return {
    source: "appointment_reminder",
    kind: "reminder",
    summary: `Upcoming appointment "${a.summary}" starting at ${a.startISO}.`,
    refs: { event_id: a.eventId, calendar_id: a.calendarId },
    instructions: wantsConfirmation
      ? "This is the final reminder before the appointment. Remind the customer warmly of the date and time, and ASK them to confirm they will attend. If they confirm, call calendar_confirm_appointment with eventId set to the event_id value from the fenced data line (and calendarId set to the calendar_id value)."
      : "Remind the customer warmly of their upcoming appointment, stating the date and time. Keep it short and natural. If they ask to reschedule or cancel, use calendar_update_event / calendar_cancel_event with eventId set to the event_id value from the fenced data line (and calendarId set to the calendar_id value).",
  };
}

interface EventStatus {
  notFound?: boolean;
  cancelled?: boolean;
  startMs: number | null;
  summary: string;
}

// Best-effort GET of the event (status/summary/start) to decide whether a reminder is still warranted.
// Returns undefined when the token/event cannot be resolved (a transient error) — the caller then
// nudges anyway (a redundant reminder beats a missed one). Anti-SSRF on the fixed Google origin.
async function fetchEventStatus(
  tenantId: bigint,
  credentialRef: string,
  calendarId: string,
  eventId: string,
  base: PrismaClient,
): Promise<EventStatus | undefined> {
  const entryId = credentialRef.startsWith("vault:")
    ? BigInt(credentialRef.slice("vault:".length))
    : null;
  if (entryId === null) return undefined;
  let token: string;
  try {
    token = await ensureFreshGoogleAccessToken(sysCtx(tenantId), entryId, base);
  } catch {
    return undefined;
  }
  const url = `${GCAL_ORIGIN}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?fields=status,summary,start`;
  await assertSafeOutboundUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "agents",
      },
      redirect: "error",
      signal: ctrl.signal,
    });
    if (res.status === 404 || res.status === 410)
      return { notFound: true, startMs: null, summary: "" };
    if (res.status < 200 || res.status >= 300) return undefined;
    const data = (await res.json()) as Record<string, unknown>;
    const start = (data.start ?? {}) as { dateTime?: unknown; date?: unknown };
    const startStr =
      typeof start.dateTime === "string"
        ? start.dateTime
        : typeof start.date === "string"
          ? start.date
          : null;
    const startMs = startStr ? Date.parse(startStr) : null;
    return {
      cancelled: data.status === "cancelled",
      startMs: startMs != null && !Number.isNaN(startMs) ? startMs : null,
      summary: typeof data.summary === "string" ? data.summary : "",
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function appointmentReminderHandler(
  job: ClaimedJob,
  base: PrismaClient,
  deps?: RuntimeDeps,
): Promise<JobResult> {
  const p = job.payload;
  const threadId = typeof p.threadId === "string" ? p.threadId : null;
  const eventId = typeof p.eventId === "string" ? p.eventId : null;
  if (!threadId || !eventId) return { outcome: "done" };
  const parsed = parseThreadId(threadId);
  if (!parsed || parsed.tenantId !== job.tenantId) return { outcome: "done" };
  const calendarId =
    typeof p.calendarId === "string" ? p.calendarId : "primary";
  const credentialRef =
    typeof p.credentialRef === "string" ? p.credentialRef : null;
  const startISO = typeof p.startISO === "string" ? p.startISO : "";
  const isLast = p.isLast === true;
  const askConfirmation = p.askConfirmation === true;
  const tenantId = job.tenantId;

  // Verify the event before nudging: skip if it was cancelled / deleted / already started (e.g. edited
  // directly in Google). A transient lookup failure (undefined) falls through to nudging anyway.
  // Summary preference: live Google value > the snapshot enriched into the payload > generic.
  let summary =
    typeof p.summary === "string" && p.summary ? p.summary : "your appointment";
  if (credentialRef) {
    const ev = await fetchEventStatus(
      tenantId,
      credentialRef,
      calendarId,
      eventId,
      base,
    );
    if (ev) {
      if (ev.notFound || ev.cancelled) return { outcome: "done" };
      if (ev.startMs != null && ev.startMs <= Date.now())
        return { outcome: "done" };
      if (ev.summary) summary = ev.summary;
    }
  }

  await runAgentNudge({
    tenantId,
    threadId,
    nudge: reminderNudge({
      isLast,
      askConfirmation,
      summary,
      startISO,
      eventId,
      calendarId,
    }),
    base,
    deps,
  });
  return { outcome: "done" };
}

let registered = false;
export function registerAppointmentReminderHandler(): void {
  if (registered) return;
  registerJobHandler("APPOINTMENT_REMINDER", (job, base) =>
    appointmentReminderHandler(job, base),
  );
  registered = true;
  logger.debug("appointment-reminder handler registered");
}
