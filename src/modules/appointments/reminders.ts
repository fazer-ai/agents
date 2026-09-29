import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { type AgentNudge, parseThreadId, runAgentNudge } from "@/graph/nudge";
import {
  isRepairableNudgeRefusal,
  nextNudgeRetry,
  nudgeReachedConversation,
} from "@/graph/nudge-retry";
import type { RuntimeDeps } from "@/graph/runtime";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  loadAppointmentContext,
  parseStartMs,
} from "@/modules/appointments/context";
import {
  GOOGLE_CALENDAR_PROVIDER,
  reminderScopeId,
} from "@/modules/appointments/provider";
import {
  cancelAppointmentRecord,
  cancelThreadAppointmentRecords,
  type RecordAppointmentResult,
  recordAppointment,
  storedAppointmentStart,
} from "@/modules/appointments/record";
import {
  type ClaimedJob,
  cancelPendingJobsByPrefix,
  enqueueJob,
  jobRetired,
  jobRetiredStrict,
} from "@/modules/scheduler/service";
import {
  type JobContext,
  type JobResult,
  registerJobHandler,
} from "@/modules/scheduler/worker";
import { ensureFreshGoogleAccessToken } from "@/modules/vault/google-oauth";
import { readVaultRefId } from "@/modules/vault/service";

// Deterministic appointment reminders, with no Google polling: one APPOINTMENT_REMINDER job per
// configured offset (runAt = start minus offset). The handler checks the event is still alive and
// ahead, then runAgentNudge injects a system turn so the agent sends a service-window-gated reminder;
// the LAST one may ask the customer to confirm attendance. Cancelling drops the pending jobs.
// These rows are jobs and nothing more: whether an appointment EXISTS is `appointments` (record.ts).

const GCAL_ORIGIN = "https://www.googleapis.com/calendar/v3";
const FETCH_TIMEOUT_MS = 10_000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// The dedupeKey prefix for ALL of an appointment's reminders; cancelAppointment drops them by it.
// Keyed by the provider-scoped id (see reminderScopeId).
function reminderPrefix(provider: string, eventId: string): string {
  return `reminder:${reminderScopeId(provider, eventId)}:`;
}

export interface ReminderJob {
  offsetHours: number;
  runAt: Date;
  // The closest (smallest-offset) reminder: the one that may ask for confirmation.
  isLast: boolean;
}

// Pure: turn a start time + offsets into the reminder jobs to enqueue. Offsets are de-duped, sorted
// DESCENDING (far to near), and any whose reminder time is already in the past (<= now) is skipped.
// The SMALLEST surviving offset is flagged isLast. No I/O: `now` is injected.
export function computeReminderJobs(
  startISO: string,
  offsetsHours: number[],
  now: Date,
): ReminderJob[] {
  // NOTE: parseStartMs, never a bare Date.parse: arming and liveness of the SAME appointment have
  // to read one parser, or a start the record refuses ("2026-02-30") would still arm reminders.
  const startMs = parseStartMs(startISO);
  if (!Number.isFinite(startMs)) return [];
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
  // The system that owns the booking; defaults to Google Calendar. It keys the dedupe AND travels in
  // the payload, but never inside eventId: the id is what the reminder turn quotes back and what a
  // Google lookup asks for, so it stays exactly as the owning system stated it, and the provider
  // rides beside it.
  provider?: string;
  eventId: string;
  // Null when no Google calendar is behind the booking, and it reaches the nudge as an absent ref:
  // "primary" for a foreign booking would hand the model a Google id nobody issued.
  calendarId: string | null;
  credentialRef: string | null;
  startISO: string;
  offsetsHours: number[];
  askConfirmationOnLast: boolean;
  // Carried into the job payload so the per-turn appointment context (and the reminder turn itself)
  // can describe the event without a Google call. Snapshotted at (re)arm time: a rename made
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
      dedupeKey: `${reminderPrefix(
        args.provider ?? GOOGLE_CALENDAR_PROVIDER,
        args.eventId,
      )}${j.offsetHours}`,
      // NOTE: Armed when a customer books or reschedules, so the row being reused means the
      // appointment MOVED: the previous arm was cancelled (cancelAppointment) and this is
      // a different send, at a different time, for a start the previous one no longer describes.
      rearm: "new-work",
      runAt: j.runAt,
      payload: {
        threadId: args.threadId,
        provider: args.provider ?? GOOGLE_CALENDAR_PROVIDER,
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

export interface AppointmentBookedArgs {
  tenantId: bigint;
  threadId: string;
  // The system that owns the booking. Absent means Google Calendar.
  provider?: string;
  eventId: string;
  startISO: string;
  summary?: string | null;
  calendarId?: string | null;
  calendarLabel?: string | null;
  credentialRef?: string | null;
  // The reminder POLICY, or null for "arm nothing". Null is an ordinary answer, not an error: an
  // integration with reminders switched off books real appointments.
  reminders: {
    offsetsHours: number[];
    askConfirmationOnLast: boolean;
  } | null;
  // RECORD ONLY: keep the appointment and touch NO reminder, neither retire nor arm. Distinct from
  // `reminders: null`, which is a re-statement with the policy off and so retires what was armed.
  // An OBSERVER restating the responder's booking must neither cancel its reminders nor arm its own.
  recordOnly?: boolean;
  base?: PrismaClient;
  now?: Date;
}

export interface AppointmentBookedResult {
  record: RecordAppointmentResult;
  remindersArmed: number;
}

// Whether the stored booking stands at a DIFFERENT time from the one being re-stated. Absent record
// means false: there is nothing armed to go stale.
async function startMoved(
  args: AppointmentBookedArgs,
  startReadable: boolean,
): Promise<boolean> {
  if (!startReadable) return false;
  const previous = await storedAppointmentStart(
    args.tenantId,
    args.eventId,
    args.base ?? basePrisma,
    args.provider ?? GOOGLE_CALENDAR_PROVIDER,
  );
  if (!previous) return false;
  return previous.getTime() !== parseStartMs(args.startISO);
}

// An appointment was booked in this conversation: write the RECORD and arm whatever reminders the
// policy asks for, through ONE entry point so no reason not to arm becomes a reason to forget it.
// ARM FIRST, RECORD LAST, and record on the error path too: the appointment must be known even when
// the scheduler write fails, and a `/reset` racing a key with no claim row can then only find both
// halves live together (the record's upsert clears the tombstone as `enqueueJob` revives a row).
export async function appointmentBooked(
  args: AppointmentBookedArgs,
  // Injectable so a test can make arming fail without breaking the record write too.
  enqueue: typeof enqueueJob = enqueueJob,
): Promise<AppointmentBookedResult> {
  let remindersArmed = 0;
  let armError: unknown;
  // NOTE: Set inside the try, read after it: the record below is skipped when a record-only
  // RESCHEDULE failed to clean up, and "never got far enough to know" must read as "it moved".
  let movedUnderRecordOnly = args.recordOnly === true;
  // NOTE: Judged ONCE, before either half. An unreadable start is not a re-statement: the record
  // refuses it, so retiring here would strand the previous booking with its reminders gone.
  const startReadable = Number.isFinite(parseStartMs(args.startISO));
  try {
    // NOTE: RETIRE FIRST, and unconditionally (`reminders: null` is a re-statement too): arming only
    // writes offsets still ahead, so a booking moved EARLIER would keep the ones it outran.
    // `recordOnly` skips both halves, except for a booking that MOVED: a reminder carries the time it
    // was armed for, so a preserved one would announce the obsolete time. Retired, never re-armed.
    movedUnderRecordOnly =
      args.recordOnly === true &&
      startReadable &&
      (await startMoved(args, startReadable));
    if (movedUnderRecordOnly) {
      await retireReminderJobs(
        args.tenantId,
        args.provider ?? GOOGLE_CALENDAR_PROVIDER,
        args.eventId,
        args.base ?? basePrisma,
        // NOTE: No arm follows, so the tombstone stands alone, as in `cancelAppointment`.
        false,
      );
    }
    if (startReadable && !args.recordOnly) {
      await retireReminderJobs(
        args.tenantId,
        args.provider ?? GOOGLE_CALENDAR_PROVIDER,
        args.eventId,
        args.base ?? basePrisma,
        // NOTE: A re-statement: the arm right below replaces the payload of every offset that survives,
        // taking the tombstone with it, so the token is the only mark that outlives it.
        true,
      );
      if (args.reminders) {
        remindersArmed = await enqueueAppointmentReminders(
          {
            tenantId: args.tenantId,
            threadId: args.threadId,
            provider: args.provider,
            eventId: args.eventId,
            // NOTE: "primary" only for Google: a foreign booking has no calendar at all.
            calendarId:
              args.calendarId ??
              ((args.provider ?? GOOGLE_CALENDAR_PROVIDER) ===
              GOOGLE_CALENDAR_PROVIDER
                ? "primary"
                : null),
            credentialRef: args.credentialRef ?? null,
            startISO: args.startISO,
            offsetsHours: args.reminders.offsetsHours,
            askConfirmationOnLast: args.reminders.askConfirmationOnLast,
            summary: args.summary,
            calendarLabel: args.calendarLabel,
            base: args.base,
            now: args.now,
          },
          enqueue,
        );
      }
    }
  } catch (e) {
    armError = e;
  }
  // NOTE: The record is skipped on exactly one failure: a record-only reschedule whose cleanup threw.
  // Writing the NEW start would make the retry see equal starts and never retire the stale reminders,
  // and the appointment is already recorded there (that is how `startMoved` answered true).
  if (armError !== undefined && movedUnderRecordOnly) throw armError;
  const record = await recordAppointment({
    tenantId: args.tenantId,
    threadId: args.threadId,
    provider: args.provider,
    externalId: args.eventId,
    startISO: args.startISO,
    summary: args.summary,
    calendarId: args.calendarId,
    calendarLabel: args.calendarLabel,
    base: args.base,
  });
  // NOTE: Rethrown AFTER the record lands, so the caller still reports the failed arming (prepare.ts binds
  // it to a flowlog warn) while the appointment itself is known.
  if (armError !== undefined) throw armError;
  return { record, remindersArmed };
}

// The appointment stopped standing (cancelled, or about to be re-armed by a reschedule): retire the
// RECORD first, because every reader consults it: if the job cleanup throws halfway, what is left is
// a reminder that the handler's own tombstone check will drop.
export async function cancelAppointment(
  tenantId: bigint,
  eventId: string,
  base: PrismaClient = basePrisma,
  provider: string = GOOGLE_CALENDAR_PROVIDER,
): Promise<void> {
  await cancelAppointmentRecord(tenantId, eventId, base, provider);
  // NOTE: No arm follows a cancel, so the tombstone stands alone and the in-flight run keeps its token.
  await retireReminderJobs(tenantId, provider, eventId, base, false);
}

// The JOBS half of the cancel above, on its own because re-arming needs it without the record half.
// Every reminder of this appointment stops: pending rows called off, every row tombstoned. This is
// what makes a RE-ARM complete: arming writes only offsets still ahead, so a booking moved EARLIER
// would keep the offsets it outran, firing with the old start after the appointment happened.
async function retireReminderJobs(
  tenantId: bigint,
  provider: string,
  eventId: string,
  base: PrismaClient,
  // Whether an arm follows and may REPLACE the payload of the offsets that survive. Required rather
  // than defaulted: the two callers want opposite answers (see the token bump below).
  armFollows: boolean,
): Promise<void> {
  await cancelPendingJobsByPrefix(
    tenantId,
    "APPOINTMENT_REMINDER",
    reminderPrefix(provider, eventId),
    base,
  );
  // NOTE: Tombstone EVERY row of this event, fired DONE rows included: a cancelled job is DONE like a
  // fired one. One atomic jsonb merge, so a concurrent re-arm's payload is stamped or replaced whole.
  // The claim token moves ONLY when an arm follows: the re-arm's upsert wipes the stamp off a row a
  // running handler already claimed, and only the moved token still stops that stale send. On a
  // cancel the stamp stands alone, and an unmoved token lets the in-flight run's `rescheduleJob` CAS
  // merge its retry counter forward.
  await runScopedOn(base, sysCtx(tenantId), async (db) => {
    // NOTE: LIKE needs its own escaping (Google recurrence ids carry `_`).
    const likePrefix = `${reminderPrefix(provider, eventId).replace(
      /[\\%_]/g,
      "\\$&",
    )}%`;
    const stamp = JSON.stringify({ cancelledAt: new Date().toISOString() });
    await db.$executeRaw`
      UPDATE scheduler_jobs
         SET payload = payload || ${stamp}::jsonb,
             claim_seq = claim_seq + ${armFollows ? 1 : 0},
             updated_at = now()
       WHERE tenant_id = ${tenantId}
         AND kind = 'APPOINTMENT_REMINDER'
         AND dedupe_key LIKE ${likePrefix}`;
  });
}

// Retire every appointment reminder THIS conversation armed; /reset is the caller. Returns the rows
// reached. Scoped by the payload's thread, never widened to the event: a reschedule re-arms the
// event's rows under the conversation that now owns it. The calendar event is NOT touched: deleting
// a real booking is not what /reset asks for, and it is not undoable.

// The caller runs this BEFORE its slow work, so an arm landing afterwards revives its own row.
// Sparing rows by age cannot work: the upsert on `reminder:<eventId>:<offset>` keeps `created_at`
// across a reschedule and a claim moves `updated_at`, so both date the ROW, not the arm. The stamp
// goes on EVERY row (DEAD included, since the follow-up sweep reads it); the status moves only on
// PENDING/CLAIMED rows, so a dead-letter an operator may need stays readable.
export async function cancelThreadAppointments(
  tenantId: bigint,
  threadId: string,
  base: PrismaClient = basePrisma,
): Promise<number> {
  await cancelThreadAppointmentRecords(tenantId, threadId, base);
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const stamp = JSON.stringify({ cancelledAt: new Date().toISOString() });
    return db.$executeRaw`
      UPDATE scheduler_jobs
         SET status = CASE
                        WHEN status IN ('PENDING', 'CLAIMED')
                          THEN 'DONE'::"SchedulerJobStatus"
                        ELSE status
                      END,
             payload = payload || ${stamp}::jsonb,
             claim_seq = claim_seq + 1,
             updated_at = now()
       WHERE tenant_id = ${tenantId}
         AND kind = 'APPOINTMENT_REMINDER'
         AND payload->>'threadId' = ${threadId}`;
  });
}

// True while this conversation (by thread) holds at least one LIVE appointment: a record that has
// not been cancelled and whose start is still ahead, read through loadAppointmentContext so this and
// the prompt block cannot disagree. The follow-up handler uses it to pause re-engagement while a
// booking stands (FollowUpConfig.pauseWhileAppointment): a customer who just booked should not get
// "still there?" nudges until the appointment passes or is cancelled. Tenant-scoped.
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
  // The system that owns the booking, named to the model for a foreign one (two systems may both
  // answer `42`). Omitted for Google, identified by calendar_id instead, as in the context block.
  provider: string;
  // Null for a booking with no Google calendar behind it: the ref is then omitted rather than
  // carrying "primary", the same rule the context block follows.
  calendarId: string | null;
  // The clock at SEND time, injected. Required so a caller cannot silently drop the temporal
  // grounding from the reminder.
  now: Date;
  // Whether the calendar tools can act on THIS appointment. False for a declared booking with no
  // Google event behind it; the discriminator is the credential, which every Calendar booking has.
  canOperate: boolean;
}

const DAY_MS = 86_400_000;

// An all-day date (`2026-09-18`) or a wall clock written without an offset: the two shapes whose
// instant `parseStartMs` invents in UTC.
const ALL_DAY_OR_LOCAL =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?$/;

// The LOCAL offset the start states, in minutes, or null when it states none (all-day, offset-less
// wall clock, `Z`). Null is NOT a fallback to UTC: this offset is the only thing that names the
// CUSTOMER'S calendar day, and UTC says where the instant is, never where the reader is.
function statedLocalOffsetMinutes(startISO: string): number | null {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(startISO);
  if (!m) return null;
  const minutes = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  // NOTE: A ZERO offset is `Z` under another spelling (ISO 8601 makes `-00:00` mean "unknown"): a
  // booking API serializing UTC this way states an instant, not a local calendar.
  return minutes === 0 ? null : minutes;
}

// Coarse on purpose: "about" is the register a reminder speaks in, and a distance to the minute
// would invite the model to read precision into a value the scheduler does not promise (a job can
// run late, and the retry ladder spans hours).
function distancePhrase(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.round(ms / DAY_MS)} days`;
}

// How far the zone's offset at `now` may sit from the offset the START states: daylight-saving steps
// of an hour, two (Antarctica/Troll) and thirty minutes (Lord Howe).
const DST_SKEWS_MINUTES = [-120, -60, -30, 0, 30, 60, 120] as const;

// WHICH CALENDAR DAY, or null when the answer would depend on an hour we do not hold. The stated
// offset is the zone's offset at the APPOINTMENT, and `now` may sit across a DST transition (the
// payload has no IANA zone). The day is claimed only when every skew agrees; otherwise the distance
// carries the sentence alone, near local midnight, and a wrong day is never stated.
function relativeDay(
  startMs: number,
  nowMs: number,
  offset: number,
): string | null {
  const dayOf = (ms: number, off: number) =>
    Math.floor((ms + off * 60_000) / DAY_MS);
  const start = dayOf(startMs, offset);
  const deltas = DST_SKEWS_MINUTES.map(
    (skew) => start - dayOf(nowMs, offset + skew),
  );
  if (new Set(deltas).size !== 1) return null;
  const days = deltas[0] as number;
  if (days === 0) return "on that same calendar day (today)";
  if (days === 1) return "on the calendar day after it (tomorrow)";
  return `${days} calendar days after it (in ${days} days)`;
}

// How far off the appointment is at SEND time, as facts the model cannot work out: the reminder turn
// states the start but not NOW, so the model would reuse the last relative word in the thread. The
// day is computed here, never derived from `offsetHours` (retries and moves make that stale), and
// the word is left to the model in the conversation's language. It rides in the instructions, not
// `refs`, since `nudgeOccasionKey` hashes refs. The distance needs a real instant, the day also a
// stated local offset; an all-day or offset-less start gets neither, and a past one gets nothing.
// New rows stay out of the offset-less case because `tool-definitions/appointment.ts` resolves a
// bare wall clock into the agent's time zone before it is stored.
export function reminderTemporalGrounding(startISO: string, now: Date): string {
  const startMs = parseStartMs(startISO);
  const nowMs = now.getTime();
  if (!Number.isFinite(startMs) || startMs <= nowMs) return "";
  const offset = statedLocalOffsetMinutes(startISO);
  // NOTE: For an all-day or offset-less start the instant is a placeholder for ordering, so a
  // distance there would be the placeholder talking, not the appointment.
  const distance = ALL_DAY_OR_LOCAL.test(startISO)
    ? null
    : distancePhrase(startMs - nowMs);
  const day = offset === null ? null : relativeDay(startMs, nowMs, offset);
  // NOTE: `offset !== null` is redundant with `day`, but the narrowing is not: `sentOn` needs it.
  if (day && distance && offset !== null) {
    // NOTE: DATED, because this turn is persisted in the thread and a "today" in it is still there
    // tomorrow. The date is the appointment's LOCAL one (the offset that decided the day).
    const sentOn = new Date(nowMs + offset * 60_000).toISOString().slice(0, 10);
    return ` This reminder is being sent on ${sentOn} in the appointment's own time zone, and the appointment falls ${day}, starting in about ${distance}; word the day and time in the conversation's language, from these values and never from what was said earlier in the conversation.`;
  }
  if (distance) {
    return ` This appointment starts in about ${distance}, and nothing here places it on a named calendar day: word the date and time naturally in the conversation's language, from the start in the fenced data, and do not describe which day it is relative to now.`;
  }
  return "";
}

// Pure: the system nudge for a reminder. The event's identity travels as fenced-data refs (the ids
// the calendar tools take), so the agent answering the reply knows WHICH appointment it was about.
// On the last reminder with confirmation enabled, the agent asks for confirmation. Without the
// calendar tools behind it, the same reminder goes out and only the tool sentence changes.
export function reminderNudge(a: ReminderNudgeArgs): AgentNudge {
  const wantsConfirmation = a.isLast && a.askConfirmation;
  const base = wantsConfirmation
    ? "This is the final reminder before the appointment. Remind the customer warmly of the date and time, and ASK them to confirm they will attend."
    : "Remind the customer warmly of their upcoming appointment, stating the date and time. Keep it short and natural.";
  const tools = wantsConfirmation
    ? " If they confirm, call calendar_confirm_appointment with eventId set to the event_id value from the fenced data line (and calendarId set to the calendar_id value)."
    : " If they ask to reschedule or cancel, use calendar_update_event / calendar_cancel_event with eventId set to the event_id value from the fenced data line (and calendarId set to the calendar_id value).";
  // NOTE: Names no tool and asserts no absence: the operator may have granted this booking system's
  // own tool this turn, so a flat "you have no tool" could be false.
  const noTools = wantsConfirmation
    ? " Record what they answer in your reply, and mark the appointment as confirmed with this booking system's own tool if you have one."
    : " If they ask to reschedule or cancel, use this booking system's own tool if you have one, and otherwise say you will pass the request on.";
  return {
    source: "appointment_reminder",
    kind: "reminder",
    summary: `Upcoming appointment "${a.summary}" starting at ${a.startISO}.`,
    refs: {
      event_id: a.eventId,
      calendar_id: a.calendarId,
      // NOTE: `booking_system`, not `source`: the renderer already emits `source=appointment_reminder`
      // on this line. Falsy refs are dropped, so Google's own name never reaches the model here.
      booking_system:
        a.provider === GOOGLE_CALENDAR_PROVIDER ? null : a.provider,
    },
    instructions: `${base}${reminderTemporalGrounding(a.startISO, a.now)}${
      a.canOperate ? tools : noTools
    }`,
  };
}

interface EventStatus {
  notFound?: boolean;
  cancelled?: boolean;
  // The calendar's own start, kept as the string it sent (offset included) rather than as an instant:
  // it is what the reminder says out loud, and re-rendering it would move the time the customer reads
  // into another zone. Null when the event carries no start we can parse.
  startISO: string | null;
  summary: string;
}

// Best-effort GET of the event (status/summary/start) to decide whether a reminder is still warranted.
// Returns undefined when the token/event cannot be resolved (a transient error); the caller then
// nudges anyway (a redundant reminder beats a missed one). Anti-SSRF on the fixed Google origin.
async function fetchEventStatus(
  tenantId: bigint,
  credentialRef: string,
  calendarId: string,
  eventId: string,
  base: PrismaClient,
): Promise<EventStatus | undefined> {
  const entryId = readVaultRefId(credentialRef);
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
      return { notFound: true, startISO: null, summary: "" };
    if (res.status < 200 || res.status >= 300) return undefined;
    const data = (await res.json()) as Record<string, unknown>;
    const start = (data.start ?? {}) as { dateTime?: unknown; date?: unknown };
    const startStr =
      typeof start.dateTime === "string"
        ? start.dateTime
        : typeof start.date === "string"
          ? start.date
          : null;
    return {
      cancelled: data.status === "cancelled",
      startISO:
        startStr && !Number.isNaN(parseStartMs(startStr)) ? startStr : null,
      summary: typeof data.summary === "string" ? data.summary : "",
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// The start this reminder is judged AND worded by, and it has to be one value: the check that lets a
// retry through and the sentence the customer reads must not come from different clocks, or a
// reminder allowed because the calendar now says 3pm goes out announcing the 10am it replaced.
// The live answer wins whenever the lookup gave one (an event edited directly in Google moves
// without a re-arm); otherwise the armed snapshot decides.
export function authoritativeReminderStart(
  live: { startISO: string | null } | undefined,
  snapshotStartISO: string,
): string {
  return live?.startISO ?? snapshotStartISO;
}

// Has the appointment this reminder announces already begun? A reminder that arrives after the
// start is worse than none: it tells someone already in the appointment that it is coming up. A
// retry can land hours after `start - offset`. An unreadable start is NOT "started" (the parser
// answers NaN and every comparison with NaN is false): refusing would drop a customer-facing
// message over a field the agent wrote. `parseStartMs`, never `Date.parse`, which rolls
// `2026-02-31` forward into March; the sweep reads with the same parser, so the two agree.
export function reminderAlreadyStarted(
  live: { startISO: string | null } | undefined,
  snapshotStartISO: string,
  now: number,
): boolean {
  return (
    parseStartMs(authoritativeReminderStart(live, snapshotStartISO)) <= now
  );
}

export async function appointmentReminderHandler(
  job: ClaimedJob,
  base: PrismaClient,
  deps?: RuntimeDeps,
  // The run's context: its signal goes to the nudge, and a reminder that reached the conversation
  // commits it.
  ctx?: JobContext,
): Promise<JobResult> {
  const p = job.payload;
  const threadId = typeof p.threadId === "string" ? p.threadId : null;
  const eventId = typeof p.eventId === "string" ? p.eventId : null;
  if (!threadId || !eventId) {
    logger.warn(
      "appointmentReminder: payload without threadId or eventId (job=%s), dropped",
      String(job.id),
    );
    return { outcome: "done" };
  }
  const parsed = parseThreadId(threadId);
  if (!parsed || parsed.tenantId !== job.tenantId) {
    logger.warn(
      "appointmentReminder: thread %s does not belong to the job's tenant (job=%s), dropped",
      threadId,
      String(job.id),
    );
    return { outcome: "done" };
  }
  // NOTE: Null survives all the way to the nudge's refs (see ReminderNudgeArgs.calendarId).
  const calendarId = typeof p.calendarId === "string" ? p.calendarId : null;
  const credentialRef =
    typeof p.credentialRef === "string" ? p.credentialRef : null;
  // NOTE: Absent on rows armed before providers existed, all of them Google.
  const provider =
    typeof p.provider === "string" && p.provider
      ? p.provider
      : GOOGLE_CALENDAR_PROVIDER;
  const startISO = typeof p.startISO === "string" ? p.startISO : "";
  const isLast = p.isLast === true;
  const askConfirmation = p.askConfirmation === true;
  const tenantId = job.tenantId;

  // NOTE: Retired while it sat claimed? Cancels reach PENDING rows only, so the fence is the
  // `cancelledAt` stamp every cancel puts on claimed rows too, re-read here rather than trusted from
  // the claim-time payload. A read that fails does NOT suppress a legitimately armed reminder.
  // The clock is read FRESH on every call (the appointment ceiling is re-judged across a long model
  // call); a test passes a fixed one through deps to assert a calendar day deterministically.
  const nowMs = (): number => (deps?.now?.() ?? new Date()).getTime();
  const retired = (): Promise<boolean> => jobRetired(job, base);
  // NOTE: Strict at the thread claim, where guessing wrong recreates state /reset cleared (see
  // jobRetiredStrict). The two asks above it can afford the lenient answer.
  const retiredStrict = (): Promise<boolean> => jobRetiredStrict(job, base);

  // NOTE: Asked TWICE. Here it saves the Google round trip (up to ten seconds); the second ask, after
  // it, is where the window closes on a /reset that lands during that call.
  if (await retired()) return { outcome: "done" };

  // NOTE: Skip an event cancelled, deleted or already started (e.g. edited directly in Google); a
  // transient lookup failure still nudges. Summary: live Google value, then snapshot, then generic.
  let summary =
    typeof p.summary === "string" && p.summary ? p.summary : "your appointment";
  let live: EventStatus | undefined;
  // NOTE: Both, not just the credential: a Google lookup asks for an event ON a calendar.
  if (credentialRef && calendarId) {
    live = await fetchEventStatus(
      tenantId,
      credentialRef,
      calendarId,
      eventId,
      base,
    );
    if (live) {
      if (live.notFound || live.cancelled) {
        logger.info(
          "appointmentReminder: event %s is %s, not sent (thread=%s)",
          eventId,
          live.notFound ? "gone" : "cancelled",
          threadId,
        );
        return { outcome: "done" };
      }
      if (live.summary) summary = live.summary;
    }
  }

  if (reminderAlreadyStarted(live, startISO, nowMs())) {
    logger.info(
      "appointmentReminder: event %s already started, not sent (thread=%s)",
      eventId,
      threadId,
    );
    return { outcome: "done" };
  }

  // NOTE: The boundary that matters: the last thing before the customer hears from us. The check above
  // ran before a network call long enough for the reset to land inside it.
  if (await retired()) return { outcome: "done" };

  const outcome = await runAgentNudge({
    signal: ctx?.signal,
    tenantId,
    threadId,
    // NOTE: The agent resolving after the booking is the ordinary close ("anything else?" / "no"),
    // and the reminder is for the customer's own appointment, so a close of ours is still ours.
    deliverToResolved: true,
    // NOTE: Re-asked inside the nudge across the model call, which is long enough for either answer
    // to change: the stamp can land, and a retry minutes before the start can still be composing
    // when the start arrives.
    stillWanted: async ({ strict }) =>
      !(await (strict ? retiredStrict() : retired())) &&
      !reminderAlreadyStarted(live, startISO, nowMs()),
    nudge: reminderNudge({
      isLast,
      askConfirmation,
      canOperate: credentialRef !== null,
      provider,
      summary,
      // NOTE: The same value the start check just used, for the reason its header gives.
      startISO: authoritativeReminderStart(live, startISO),
      // NOTE: The clock HERE, not the armed offset: only the send time knows how far it actually is.
      now: new Date(nowMs()),
      eventId,
      calendarId,
    }),
    base,
    deps,
  });
  // NOTE: sent is spent: a run past its deadline that got this far has its `done` written, or its
  // retry sends the reminder a second time.
  if (nudgeReachedConversation(outcome)) ctx?.commit();
  else
    logger.info(
      "appointmentReminder: nothing reached the conversation (outcome=%s thread=%s event=%s)",
      outcome,
      threadId,
      eventId,
    );
  // NOTE: A repairable refusal retries the SAME row, but only for the LAST offset: the backoff ladder
  // spans hours, so a retried earlier offset would land beside the next one and send both. An
  // earlier offset has a later one to carry the message; the last one's ceiling is the start itself.
  if (isRepairableNudgeRefusal(outcome) && isLast) {
    const retry = nextNudgeRetry(job.payload);
    if (retry.retry) {
      // NOTE: Patched, never replaced: the per-event cancel merges its tombstone onto this row without
      // bumping the claim token, so writing back the claim-time snapshot would pass the compare-and-set
      // and un-cancel an appointment the operator already cancelled.
      return {
        outcome: "reschedule",
        runAt: retry.runAt,
        payloadPatch: { nudgeRetries: retry.attempt },
      };
    }
    logger.warn(
      "appointmentReminder: giving up after %d %s retries (thread=%s), the reminder is not sent",
      retry.attempt,
      outcome,
      threadId,
    );
  }
  return { outcome: "done" };
}

let registered = false;
export function registerAppointmentReminderHandler(): void {
  if (registered) return;
  registerJobHandler("APPOINTMENT_REMINDER", (job, base, ctx) =>
    appointmentReminderHandler(job, base, undefined, ctx),
  );
  registered = true;
  logger.debug("appointment-reminder handler registered");
}
