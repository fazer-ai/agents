import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { type AgentNudge, parseThreadId, runAgentNudge } from "@/graph/nudge";
import { isRepairableNudgeRefusal, nextNudgeRetry } from "@/graph/nudge-retry";
import type { RuntimeDeps } from "@/graph/runtime";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  loadAppointmentContext,
  parseStartMs,
} from "@/modules/appointments/context";
import {
  type ClaimedJob,
  cancelPendingJobsByPrefix,
  enqueueJob,
  jobRetired,
  jobRetiredStrict,
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
      // NOTE: Armed when a customer books or reschedules, so the row being reused means the
      // appointment MOVED: the previous arm was cancelled (cancelAppointmentReminders) and this is
      // a different send, at a different time, for a start the previous one no longer describes.
      rearm: "new-work",
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

// Retire every appointment reminder THIS conversation armed: pending rows cancelled, every row
// tombstoned. /reset is the caller.
//
// Scoped by the thread the rows carry in their payload, and never by the event: the reminders are
// keyed `reminder:<eventId>:<offset>`, so a command that only knows the thread cannot reach them by
// dedupe key — but the event is the wrong widening. A reschedule re-arms the surviving offsets with
// the payload of whatever conversation asked for it (enqueueJob's upsert is authoritative), while
// already-fired rows keep the OLD thread; going from a fired row's event id back to the whole
// `reminder:<eventId>:` prefix would cancel and tombstone the LIVE reminders of the conversation that
// now owns the appointment. The thread predicate is the same lookup `loadAppointmentContext` uses per
// turn, and it cannot reach outside the conversation that typed the command.
//
// ALL rows, not just PENDING ones: `loadAppointmentContext` re-reads fired rows too, and a fired
// reminder whose start is still ahead is exactly what keeps the appointment block in the prompt after
// the operator was told the conversation was cleared. The tombstone is what tells the two apart —
// cancelling marks a job DONE, which is indistinguishable from "fired". One atomic statement, never
// read-modify-write, so a concurrent re-arm's payload is stamped or replaced whole.
//
// The calendar event itself is deliberately NOT touched. Deleting a real booking is not what the
// operator asked for by typing /reset, and it is not undoable.
//
// UNCONDITIONAL, and that is why the caller runs it BEFORE its slow work rather than after. /reset is
// not atomic with the conversation: a turn arriving during the cleanup can book or reschedule, and
// retiring what that turn armed loses reminders for real appointments (the command also clears
// `lastInboundAt`, so nothing re-arms them). Sparing them by age does not work — enqueueJob upserts on
// `reminder:<eventId>:<offset>`, so a reschedule keeps the row's `created_at` and a claim moves its
// `updated_at`; both columns answer a question about the ROW, not about the arm. Ordering answers it
// instead: retire first, and an arm that lands afterwards revives its own row, because that same
// upsert writes `status: PENDING` with a fresh payload and run time. What is left is the window
// between reading the command and this statement committing, where "before or after the command" has
// no answer to get right.
//
// TWO scopes in one statement, over different row sets. The `cancelledAt` stamp is the APPOINTMENT's
// cancel marker, not a note about a run: projectAppointmentEvents and the follow-up sweep both read
// it, and to both a row whose start is still ahead is a LIVE appointment until the stamp lands. So it
// goes on every row of the thread, DEAD ones included — fencing it on status would leave a
// dead-lettered reminder in the prompt, and follow-ups paused on it, after the operator was told the
// conversation had been cleared. The STATUS transition is the narrower scope: only a queued or
// in-flight row has a run to call off, and moving a DEAD row to DONE would erase the dead-letter an
// operator may still need to read (the same reason retireJobsByDedupeKey fences the whole statement —
// there the stamp has no reader but jobRetired, so it can).
//
// Returns the number of rows the command reached — retired or merely tombstoned.
export async function cancelThreadAppointmentReminders(
  tenantId: bigint,
  threadId: string,
  base: PrismaClient = basePrisma,
): Promise<number> {
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
  // The calendar's own start, kept as the string it sent (offset included) rather than as an instant:
  // it is what the reminder says out loud, and re-rendering it would move the time the customer reads
  // into another zone. Null when the event carries no start we can parse.
  startISO: string | null;
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
//
// The live answer wins whenever the lookup gave one, because the payload's start is a snapshot from
// the moment the row was armed and an event edited directly in Google (never through the agent, which
// re-arms the reminders) can have moved in either direction. When the lookup could not be made or
// carried no readable start, the snapshot is the only thing left that knows, and it decides.
export function authoritativeReminderStart(
  live: { startISO: string | null } | undefined,
  snapshotStartISO: string,
): string {
  return live?.startISO ?? snapshotStartISO;
}

// Has the appointment this reminder announces already begun? A reminder that arrives after the start
// is worse than none: it tells someone already in the appointment that it is coming up.
//
// This only became reachable when the handler learned to retry: a job used to run exactly once, at
// `start - offset`, so the start was ahead by construction. A retry can land hours later, and a
// Google GET failing at that moment used to leave nothing between it and the customer.
//
// An absent or unreadable start is NOT "started", and that falls out of the comparison rather than
// needing a guard: the parser answers NaN, and every comparison with NaN is false. Refusing to remind
// on a date nobody can read would drop a customer-facing message over a field the agent wrote.
//
// `parseStartMs`, never a bare `Date.parse`: this repo already learned that one (issue #39's
// neighbours). A start can reach a payload from the model's own tool input, and `Date.parse` rolls an
// impossible date forward instead of refusing it, so `2026-02-31` becomes March and a reminder is
// judged against a day that does not exist. The same parser reads the sweep's side, and the two
// answering differently is how a reminder gets dropped by one and kept by the other.
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

  // Was this reminder retired while it sat claimed? `cancelPendingJob` and its prefix sibling reach
  // PENDING rows only, so a row the worker had already picked up survives every cancellation — and
  // the reminder then fires at the customer about an appointment the operator was told had been
  // cleared. The tombstone is the fence: `cancelThreadAppointmentReminders` (and the per-event
  // cancel) stamp `cancelledAt` on EVERY row of the match, claimed ones included, precisely so an
  // in-flight handler has something to see. The handler is the half that was missing.
  //
  // Re-read rather than trusted from `job.payload`: that snapshot is from claim time, which is
  // exactly the moment before the stamp lands. A read that fails does NOT suppress the reminder —
  // an unknown answer must not silently drop a customer-facing message that was legitimately armed.
  // Opens its own short scope. It used to take the caller's connection, because the nudge's thread
  // claim ran inside an advisory-lock transaction and a second connection there would stall the lock
  // under DB_POOL_MAX=1. That claim holds no transaction any more (issue #225), so there is nothing
  // to borrow and nothing to stall.
  const retired = (): Promise<boolean> => jobRetired(job, base);
  // Strict at the thread claim, where guessing wrong recreates state /reset cleared (see
  // jobRetiredStrict). The two asks above it can afford the lenient answer.
  const retiredStrict = (): Promise<boolean> => jobRetiredStrict(job, base);

  // NOTE: Asked TWICE, and the two calls buy different things. Here it saves the Google round trip, which
  // holds this handler for up to ten seconds. After it — see below — is where the window actually
  // closes, because a /reset arriving during that call would otherwise find the answer already read.
  if (await retired()) return { outcome: "done" };

  // Verify the event before nudging: skip if it was cancelled / deleted / already started (e.g. edited
  // directly in Google). A transient lookup failure (undefined) falls through to nudging anyway.
  // Summary preference: live Google value > the snapshot enriched into the payload > generic.
  let summary =
    typeof p.summary === "string" && p.summary ? p.summary : "your appointment";
  let live: EventStatus | undefined;
  if (credentialRef) {
    live = await fetchEventStatus(
      tenantId,
      credentialRef,
      calendarId,
      eventId,
      base,
    );
    if (live) {
      if (live.notFound || live.cancelled) return { outcome: "done" };
      if (live.summary) summary = live.summary;
    }
  }

  if (reminderAlreadyStarted(live, startISO, Date.now())) {
    return { outcome: "done" };
  }

  // NOTE: The boundary that matters: the last thing before the customer hears from us. The check above
  // ran before a network call long enough for the reset to land inside it.
  if (await retired()) return { outcome: "done" };

  const outcome = await runAgentNudge({
    tenantId,
    threadId,
    // And once more inside, where the nudge re-asks its own questions across the model call. Three
    // reads is not belt-and-braces: each covers a different slow step (the Google fetch, the nudge's
    // setup, the judge's call), and the stamp can land in any of them.
    // Two questions, asked at every point the nudge re-asks anything, because a model turn is long
    // enough for either answer to change inside it. The appointment ceiling is the new one: a retry
    // scheduled minutes before the start would otherwise pass the check above and still be composing
    // when the start arrives, which is precisely the message this handler must never send.
    stillWanted: async ({ strict }) =>
      !(await (strict ? retiredStrict() : retired())) &&
      !reminderAlreadyStarted(live, startISO, Date.now()),
    nudge: reminderNudge({
      isLast,
      askConfirmation,
      summary,
      // The same value the start check just used, for the reason its header gives.
      startISO: authoritativeReminderStart(live, startISO),
      eventId,
      calendarId,
    }),
    base,
    deps,
  });
  // NOTE: A reminder offset is an occasion, and it is spent exactly once. When the nudge posted nothing
  // for a reason that may be repaired, retrying the SAME row is what keeps the customer's reminder
  // from disappearing because a credential was broken for ten minutes.
  //
  // Only the LAST offset is retried, and that is the whole answer to the duplicate: offsets are whole
  // hours and the backoff ladder spans two, so a retried 2h reminder would come due alongside the 1h
  // one and a credential that recovered in between would send both, back to back. An earlier offset
  // has a later one behind it to carry the message, so it yields instead of waiting. The last one has
  // nothing behind it, and its ceiling is the appointment itself (the start check above).
  if (isRepairableNudgeRefusal(outcome) && isLast) {
    const retry = nextNudgeRetry(job.payload);
    if (retry.retry) {
      // Patched, never replaced: the per-event cancel merges its tombstone onto this row without
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
  registerJobHandler("APPOINTMENT_REMINDER", (job, base) =>
    appointmentReminderHandler(job, base),
  );
  registered = true;
  logger.debug("appointment-reminder handler registered");
}
