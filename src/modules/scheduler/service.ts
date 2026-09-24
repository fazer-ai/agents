import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { sanitizeErrorMessage } from "@/lib/redact";
import {
  asSuperAdminOn,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import { emitDeadLetter } from "@/modules/flowlog/dead-letter";
import {
  JOB_DEATH_LEVEL,
  JOB_DELETE_ON_DONE,
  JOB_RETRY_BASE_MS,
  kindsInLane,
  type SchedulerLane,
} from "@/modules/scheduler/lanes";

// Durable job store for the scheduler (follow-ups, sweeps, retries).
//
// A claim carries a TOKEN (`claimSeq`), and the three writes that finish a job CAS on it. The reason
// is that a row is re-armed IN PLACE: `enqueueJob` upserts the same physical row back to PENDING, so
// "the row is CLAIMED" never distinguished the run holding the claim from a later one. Guarded on
// status alone, a handler that finished late marked whatever arm existed DONE, and the work that arm
// stood for was never done by anyone (issue #164).
//
// The bump lives on the CLAIM and nowhere else, which is enough for both orderings and is why
// `enqueueJob` does not touch it. A re-arm that is not claimed again leaves the row PENDING, and the
// old CAS already refuses that; a re-arm that IS claimed again bumps past the token the first run
// holds. Adding a second bump on the re-arm would buy nothing and put a write on a hot path.
//
// The CLAIM is cross-tenant —
// it must see every tenant's due jobs — so it runs via asSuperAdmin with FOR UPDATE SKIP LOCKED;
// the GUC is transaction-local (set_config(...,true)) so it never leaks to the next request on a
// pooled connection. Each job's EFFECT and status update run under the job's OWN tenant scope
// (runScoped), so RLS still fences the work. `attempts` grows only on failure/crash and is CLEARED
// by a completed pass, whichever way it ends: rescheduleJob (issue #287) and completeJob (#339). So
// the cap bounds CONSECUTIVE failures rather than the row's lifetime; the reaper bounds crash loops
// by pushing exhausted jobs to DEAD. What a completed pass cannot reach is a row whose LAST pass
// failed, and there the budget outlives the work only if the next arm says it should: see `Rearm`.

const MAX_ATTEMPTS = 5;

// The lane's kinds as a SQL fragment, derived from the one table that assigns them (lanes.ts) rather
// than written out per claim. Three hand-kept literals is how a kind added to the enum ends up in no
// lane at all, or in two: nothing compared them, and the shared lane's was a NOT IN, so forgetting it
// there silently WIDENED that lane. The values are enum members from a compile-time map, never user
// input, so embedding them is safe — same property the literals had.
// Exported for tests/modules/scheduler-claim-limit.test.ts, which runs the real statement and must
// narrow it the way the lanes do rather than spell a filter of its own.
export function laneFilter(
  lane: SchedulerLane,
  trafficProportional?: boolean,
): Prisma.Sql {
  return Prisma.sql`kind IN (${Prisma.join(kindsInLane(lane, trafficProportional))})`;
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export type SchedulerJobKind =
  | "FOLLOWUP"
  | "FOLLOWUP_SWEEP"
  | "WEBHOOK_RETRY"
  | "DEBOUNCE"
  | "RAG_INGEST"
  | "HEARTBEAT"
  | "FLOWLOG_SWEEP"
  | "APPOINTMENT_REMINDER"
  | "REDIRECT_FOLLOWUP"
  | "MEMORY_COMPACT"
  | "INGEST_MESSAGE"
  | "DELIVERY_SWEEP"
  | "DELIVERY_RECOVERY"
  | "TAKEOVER_RECOVERY"
  | "HUMAN_REPLY_RECOVERY"
  | "SPEND_CEILING_POLL"
  | "OBSERVE"
  | "MEDIA_TEXT_FALLBACK"
  | "KNOWLEDGE_SOURCE_SYNC";

export interface ClaimedJob {
  id: bigint;
  tenantId: bigint;
  kind: SchedulerJobKind;
  payload: Record<string, unknown>;
  // The encrypted half, for the kinds that carry one. Kept OUT of `payload` because that is a Prisma
  // `Json` column, and this repository's rule is that an `encryptJson` blob lives in a plain String:
  // a Json payload is what gets logged or serialized whole, and it would take the ciphertext of a
  // contact's own message with it (CLAUDE.md, Encryption).
  //
  // OPTIONAL, so the compiler does not chase it through a dozen fixtures for kinds that carry
  // nothing. What guards a query that forgets to select it is the one handler that needs it: a
  // missing secret there is a hard failure, not an empty message quietly folded into a memory
  // (../../graph/ingest-job.ts).
  payloadSecret?: string | null;
  // The row's dedupe key, which is the operator's handle on WHICH work this is (`followup:<thread>`,
  // `doc:<id>`, `<reminder-prefix><offset>`) and the only field that survives into the dead-letter
  // line as something to act on (../flowlog/dead-letter.ts). Both claim paths select it.
  //
  // OPTIONAL for the same reason `payloadSecret` above is: a required field would be chased through
  // every hand-built fixture for a benefit only the two real claim paths deliver.
  dedupeKey?: string;
  attempts: number;
  // The token this claim holds. Hand it back to completeJob/rescheduleJob/failJob: those three CAS
  // on it, so a run that was superseded while it worked writes nothing (issue #164).
  claimSeq: number;
}

// What a re-arm of an existing row MEANS, answered by whoever arms it, because nothing the row
// itself carries can answer it (issue #339).
//
// It decides ONE thing: whether the failure budget of the pass that came before survives into this
// arm. It only ever matters on a row whose last pass FAILED, since a pass that completed clears the
// count on its way out (completeJob, rescheduleJob).
//
//   "new-work":  this arm stands for a unit of work the row has not run yet. The trigger is the
//                WORLD changing: a contact wrote, an operator asked for a re-index, an appointment
//                was booked. Carrying the previous unit's failures into this one is how four
//                transient blips spread over months make the next attendance dead-letter on its
//                first, and that contact never compacts again.
//
//   "same-work": this arm is the SAME unit being pushed again. The trigger is a CLOCK: a sweep that
//                re-enqueues every eligible thread each minute, a boot that re-arms the per-tenant
//                sweeps, a key that names one message. Clearing here would hand a genuinely broken
//                job five fresh attempts on a schedule, which is the cap doing nothing at all.
//
// There is deliberately no default. The rule is real but it is not derivable: the same status means
// opposite things to different callers (a DEAD row re-armed by armCompaction is a new attendance,
// the same row re-armed by the follow-up sweep is the same broken follow-up), and per kind does not
// separate them either, since FOLLOWUP's key is the thread and the sweep arms it for both. The
// knowledge is the caller's, so the caller is the one asked.
//
//   "once":      this arm is work that may run AT MOST ONCE, and the key is what says so: an
//                existing row, in whatever state, is left exactly as it is. The trigger is a
//                redelivery of the event that armed it, and re-arming a DONE row would do the work a
//                second time (issue #587: a text sent to the customer twice). Its kind must not be
//                deleted on DONE, or the row that remembers "already done" would be gone.
export type Rearm = "new-work" | "same-work" | "once";

export interface JobRowParams {
  tenantId: bigint;
  kind: SchedulerJobKind;
  dedupeKey: string;
  runAt: Date;
  payload?: Record<string, unknown>;
  // Written to the dedicated String column, never into `payload`. See ClaimedJob.payloadSecret.
  payloadSecret?: string | null;
  rearm: Rearm;
}

export interface EnqueueParams extends JobRowParams {
  base?: PrismaClient;
}

// Where a scheduler_jobs row comes into existence (`enqueueJobUnlessClaimed` writes the same
// `jobRowWrites`), and the reason it takes a ScopedDb rather than being folded into enqueueJob:
// armDebounce has to write inside its own advisory-lock transaction, so it cannot call something
// that opens a second one. It used to hand-copy this block
// instead, which is exactly how DEBOUNCE ended up with no answer to the `rearm` question at all.
// tests/modules/scheduler-row-writers.test.ts is the fence that keeps a third copy from appearing.
export async function upsertJobRow(
  db: ScopedDb,
  params: JobRowParams,
): Promise<bigint> {
  const { create, update } = jobRowWrites(params);
  const row = await db.schedulerJob.upsert({
    where: {
      tenantId_kind_dedupeKey: {
        tenantId: params.tenantId,
        kind: params.kind,
        dedupeKey: params.dedupeKey,
      },
    },
    create,
    update,
    select: { id: true },
  });
  return row.id;
}

// What arming a row writes, built once for both single-row writers so the two cannot drift.
function jobRowWrites(params: JobRowParams) {
  return {
    create: {
      tenantId: params.tenantId,
      kind: params.kind,
      dedupeKey: params.dedupeKey,
      runAt: params.runAt,
      payload: (params.payload ?? {}) as Prisma.InputJsonValue,
      payloadSecret: params.payloadSecret ?? null,
      status: "PENDING" as const,
    },
    // `once` arms a row that does not exist yet and leaves one that does exactly as it is: status,
    // run time, body and all. See `Rearm`.
    update:
      params.rearm === "once"
        ? {}
        : {
            runAt: params.runAt,
            status: "PENDING" as const,
            lastError: null,
            // NOTE: Re-arming with a payload is authoritative (the latest enqueue wins): this resets a
            // stale payload on a reused row, e.g. the follow-up sweep restarting a sequence at step 0 on
            // a row a prior run had advanced to a later step. A payload-less re-enqueue preserves the
            // existing.
            ...(params.payload !== undefined
              ? { payload: params.payload as Prisma.InputJsonValue }
              : {}),
            // NOTE: Re-armed together with the payload it belongs to: the two halves describe one
            // message, and a re-enqueue that refreshed only the JSON would leave a body from the previous
            // arming.
            ...(params.payload !== undefined
              ? { payloadSecret: params.payloadSecret ?? null }
              : {}),
            ...(params.rearm === "new-work" ? { attempts: 0 } : {}),
          },
  };
}

// The SET-BASED sibling of `upsertJobRow`, for a caller arming many rows inside one transaction.
//
// Same row and the same `rearm` question, in one round trip. `reindexKnowledgeBase` commits the
// status transition, the jobs and the audit row together, and a per-row loop there is N round trips
// against a transaction with a five-second budget: an imported base with a few thousand documents
// would blow the deadline and roll the whole reindex back.
//
// Deliberately narrower than the single-row version, because a bulk arming is a bulk arming: every
// row shares one `kind`, one `rearm` and one `runAt`, and carries its own dedupe key and payload.
// Anything that does not fit that shape stays on `upsertJobRow`.
//
// The payload is REQUIRED here, and that is the narrowing doing its job rather than an oversight.
// `upsertJobRow` treats an omitted payload as "keep the one already stored", and that meaning cannot
// survive the trip through an array: the rows travel as `text[]`, so an omission would have to be
// spelled as a JSON value, and every spelling of it (`{}`, `null`) is also a payload a caller might
// legitimately mean. Making it optional and coercing to `{}` is what the type USED to allow, and it
// silently replaced the stored payload and cleared its secret half on a re-arm that never asked to.
// Requiring it moves that from a runtime surprise to a compile error at the call site.
//
// It lives HERE, beside it, because `tests/modules/scheduler-row-writers.test.ts` fences row
// creation to this module.
export async function upsertJobRows(
  db: ScopedDb,
  params: {
    tenantId: bigint;
    kind: SchedulerJobKind;
    // Not "once": the set-based statement re-arms on conflict, and no caller arms once-only rows in bulk.
    rearm: Exclude<Rearm, "once">;
    runAt: Date;
    rows: { dedupeKey: string; payload: Record<string, unknown> }[];
  },
): Promise<number> {
  if (params.rows.length === 0) return 0;
  // NOTE: The rows travel as TWO ARRAYS and not as N tuples, because a tuple list carries one bind
  // parameter per column per row and Postgres refuses a statement with more than 65535 of them: at
  // five per row this breaks at 13108 documents, and nothing upstream caps how many a base may hold
  // (an import creates them in bulk). The whole reindex would fail on the statement that arms it,
  // rolling back a transition the operator asked for, and the size that trips it is a customer's
  // catalogue rather than anything we choose. Unnesting keeps the count at one parameter per COLUMN,
  // whatever the row count, and the shared halves bind once each instead of once per row.
  const keys = params.rows.map((r) => r.dedupeKey);
  const payloads = params.rows.map((r) => JSON.stringify(r.payload));
  return db.$executeRaw`
    INSERT INTO scheduler_jobs
      (tenant_id, kind, dedupe_key, run_at, payload, status, created_at, updated_at)
    SELECT ${params.tenantId}::bigint,
           ${params.kind}::"SchedulerJobKind",
           t.dedupe_key,
           ${params.runAt}::timestamptz,
           t.payload::jsonb,
           'PENDING'::"SchedulerJobStatus",
           now(),
           now()
      FROM unnest(${keys}::text[], ${payloads}::text[]) AS t(dedupe_key, payload)
    ON CONFLICT (tenant_id, kind, dedupe_key) DO UPDATE
       SET run_at = EXCLUDED.run_at,
           status = 'PENDING'::"SchedulerJobStatus",
           last_error = NULL,
           payload = EXCLUDED.payload,
           -- The payload is authoritative on a re-arm and its secret half travels with it, exactly
           -- as the single-row version does; this shape never carries one, so it is cleared rather
           -- than left behind from a previous arming.
           payload_secret = NULL,
           attempts = ${params.rearm === "new-work" ? Prisma.sql`0` : Prisma.sql`scheduler_jobs.attempts`},
           updated_at = now()`;
}

// One live row per (tenant, kind, dedupeKey): a re-enqueue re-arms run_at and resets to PENDING.
export async function enqueueJob(params: EnqueueParams): Promise<bigint> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, sysCtx(params.tenantId), (db) =>
    upsertJobRow(db, params),
  );
}

// `enqueueJob` for a caller whose re-arm must never supersede a run in flight (issue #786). The
// upsert puts a CLAIMED row back to PENDING, the worker claims it again, and the running claim's
// outcome is discarded by the CAS on its token. Right when the arm carries input the run has not
// seen (a debounce burst that continues); wrong for the follow-up sweep, a clock re-pushing the
// episode the claim is executing, where it dropped the step-1 reschedule. A claim that died is
// re-pended by the reaper, so leaving it alone cannot strand the row.
//
// Two statements, since Prisma has no conditional upsert: the UPDATE re-checks its WHERE under the
// row lock, so a claim that commits first makes it match nothing, and the INSERT then skips.
//
// NOR OVER A RUN ALREADY SCHEDULED FOR LATER, when the caller asks (issue #796). A PENDING row whose
// `run_at` is still ahead was put there by its handler on purpose — a retry backoff, business hours,
// the cadence of a step that is not due yet — and the re-arm would pull it back to now and replace its
// payload, which drops the retry count the backoff was keeping. For a clock that re-pushes the same
// episode every minute that turned each of those deferrals into a run every minute. A row that is
// already due, finished, or absent is armed as before. The caller says which deferred rows are its own
// work (`leaveLaterRun` reads the row's payload, and its `lastError`, which is what tells a failure
// backoff from a row that merely stood down): a deferral left by an EARLIER episode is not, and the
// arm must replace it instead of waiting days for a step that no longer applies. Read first, then the
// UPDATE is pinned to the `run_at` that was read, so a handler rescheduling in between makes it match
// nothing, and the INSERT skips.
export async function enqueueJobUnlessClaimed(
  params: EnqueueParams & {
    leaveLaterRun?: (row: {
      payload: Prisma.JsonValue;
      lastError: string | null;
    }) => boolean | Promise<boolean>;
  },
): Promise<boolean> {
  const base = params.base ?? basePrisma;
  const { create, update } = jobRowWrites(params);
  return runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    const key = {
      tenantId: params.tenantId,
      kind: params.kind,
      dedupeKey: params.dedupeKey,
    };
    const later = params.leaveLaterRun
      ? await db.schedulerJob.findFirst({
          where: { ...key, status: "PENDING", runAt: { gt: new Date() } },
          select: { runAt: true, payload: true, lastError: true },
        })
      : null;
    if (later && (await params.leaveLaterRun?.(later))) return false;
    const updated = await db.schedulerJob.updateMany({
      where: {
        ...key,
        status: { not: "CLAIMED" },
        ...(later
          ? { status: "PENDING", runAt: later.runAt }
          : params.leaveLaterRun
            ? { NOT: { status: "PENDING", runAt: { gt: new Date() } } }
            : {}),
      },
      data: update,
    });
    if (updated.count > 0) return true;
    const created = await db.schedulerJob.createMany({
      data: [create],
      skipDuplicates: true,
    });
    return created.count > 0;
  });
}

// A customer reply (or opt-out) makes a pending proactive job moot: CAS-cancel the live PENDING
// row for this (kind, dedupeKey) so a stale follow-up never fires after the customer is back. A
// CLAIMED (in-flight) job is left to its own gate/idle re-check; the next sweep re-arms via upsert
// if inactivity returns. Tenant-scoped (we know the tenant), so RLS fences it. Returns true if a
// pending job was actually cancelled.
export async function cancelPendingJob(
  tenantId: bigint,
  kind: SchedulerJobKind,
  dedupeKey: string,
  base: PrismaClient = basePrisma,
): Promise<boolean> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const res = await db.schedulerJob.updateMany({
      where: { kind, dedupeKey, status: "PENDING" },
      data: { status: "DONE" },
    });
    return res.count > 0;
  });
}

// Like cancelPendingJob, but cancels EVERY pending job whose dedupeKey starts with `prefix` — used to
// drop all of an appointment's reminders at once (dedupeKey `reminder:<eventId>:<offset>`) when the
// appointment is cancelled or rescheduled, without having to know each configured offset. Tenant-scoped
// (RLS fences it). Returns the number of pending jobs cancelled.
export async function cancelPendingJobsByPrefix(
  tenantId: bigint,
  kind: SchedulerJobKind,
  prefix: string,
  base: PrismaClient = basePrisma,
): Promise<number> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const res = await db.schedulerJob.updateMany({
      where: { kind, status: "PENDING", dedupeKey: { startsWith: prefix } },
      data: { status: "DONE" },
    });
    return res.count;
  });
}

// The same cancel, FENCED ON THE EPISODE the rows belong to (issue #477 review, round 21).
//
// `/reset` retires the verdicts armed before it, and the plain prefix cancel above cannot tell them
// from the ones armed after: the command's own work takes seconds — a live refresh, the memory
// clear, a dozen Chatwoot calls — and a customer message landing in that stretch arrives AFTER the
// reset, arms a burst the operator wants classified, and was then marked DONE by a cancel that ran
// later and asked nothing. Moving the cancel earlier only narrows the window; the boundary closes
// it, and the boundary is the one the whole command is already written in — the command's own
// message id in Chatwoot's sequence (../../graph/reset-episode.ts).
//
// AT OR BELOW, and only for a row that NAMES a message, exactly as `resetLandedAfter` reads it: a
// row with no `atMessageId` is a resolve verdict, which orders against nothing here and is stood
// down by the tick's own reopen fence instead — the command is an incoming message, so a
// conversation that was resolved no longer is.
//
// One statement, not read-then-update: a burst joining the row between a read and a write would
// raise its `atMessageId` past the boundary, and the cancel would retire the episode it just became.
export async function cancelPendingJobsByPrefixUpToMessage(
  tenantId: bigint,
  kind: SchedulerJobKind,
  prefix: string,
  atOrBelowMessageId: number,
  base: PrismaClient = basePrisma,
): Promise<number> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const res = await db.schedulerJob.updateMany({
      where: {
        kind,
        status: "PENDING",
        dedupeKey: { startsWith: prefix },
        payload: { path: ["atMessageId"], lte: atOrBelowMessageId },
      },
      data: { status: "DONE" },
    });
    return res.count;
  });
}

// One step further than the two cancels above: PENDING **and** CLAIMED rows under one dedupe key. They
// leave a claimed job to its own gate, and for an ordinary cancel that is right — the run holding the
// claim is the one doing the work. It is wrong for a command like /reset, where the claimed row is
// precisely the one already on its way to posting at the customer. A status change is something that
// run will never look at, so this leaves a tombstone it can SEE, via `jobRetired` below.
//
// One step SHORT of `revokeJobsByKeyPrefixOn`, which follows: the row here survives, because its key
// is reusable and the work behind it may legitimately come back. A revoked ingestion cannot — its row
// holds the message body itself, so there the row is deleted rather than marked.
//
// Two marks, because neither survives alone. `cancelledAt` is the direct answer, and a re-arm wipes
// it: `enqueueJob`'s upsert replaces the payload wholesale, so a customer who books again would make
// the retired run "wanted" once more. `claim_seq` survives that rewrite, and a token that moved says
// the same thing in one word — this run was superseded. The bump also fences whatever the run writes
// at the end, since completeJob/rescheduleJob/failJob all CAS on the token the claim handed out.
//
// One atomic statement, never read-modify-write, so a concurrent re-arm's payload is stamped or
// replaced whole. Unconditional over ARM TIME by design: a caller that cannot afford to retire work
// armed after it asked runs this BEFORE its slow steps, so that re-arm lands afterwards and revives
// its own row.
//
// Fenced on STATUS, though: only a queued or in-flight row has a run to call off. A DEAD row is left
// alone because marking it DONE would erase the dead-letter an operator may still need to read, and
// nothing is executing it for the claim_seq bump to fence — the same rule revokeJobsByKeyPrefixOn
// states below. The fence is safe here because this stamp has exactly one reader, jobRetired, which
// asks about a RUN. It is not safe everywhere: cancelThreadAppointmentReminders writes the same shape
// and cannot use it, because there `cancelledAt` also marks the APPOINTMENT cancelled and is read by
// projectAppointmentEvents / the follow-up sweep, for whom a DEAD row is still a live appointment.
// Returns the number of rows retired.
export async function retireJobsByDedupeKey(
  tenantId: bigint,
  kind: SchedulerJobKind,
  dedupeKey: string,
  base: PrismaClient = basePrisma,
): Promise<number> {
  return runScopedOn(base, sysCtx(tenantId), (db) =>
    retireJobsByDedupeKeyOn(db, tenantId, kind, dedupeKey),
  );
}

// The same retirement on the CALLER'S connection, for a caller whose atomicity matters — the same
// shape and the same reason as `revokeJobsByKeyPrefixOn` above.
//
// It is not only about sharing a pool slot here. Run inside the caller's transaction this UPDATE
// takes the row lock on the dedupe key and holds it to commit, so a concurrent arm on that key
// blocks and lands AFTER the retirement rather than before it. That ordering is the whole point for
// the mirror's episode release: work armed for the NEW episode must survive the retirement of the
// old one, and outside the transaction there is a window where it does not.
//
// `keepEpisode` is for a caller whose dedupe key outlives the thing being retired. The key names the
// CONVERSATION, so every episode that conversation ever has shares it, and a retirement that runs
// after the NEXT episode's work was armed would take that with it — which is reachable, not
// theoretical: a mirror write whose retirement was rejected holds the pairing back and the same
// delivery goes on to arm anyway, so the payload that finally applies the pairing is the one that
// would kill it. Given, the retirement leaves the named episode's own work standing. A payload that
// does not state an episode is the previous one's by construction: it predates the field, or it came
// from a Chatwoot that does not speak about pairings at all.
export async function retireJobsByDedupeKeyOn(
  db: ScopedDb,
  tenantId: bigint,
  kind: SchedulerJobKind,
  dedupeKey: string,
  keepEpisode?: { originDisplayId: number | null },
): Promise<number> {
  const stamp = JSON.stringify({ cancelledAt: new Date().toISOString() });
  // Two questions, not one: whether an episode was named at all, and which. A cleared pairing names
  // the episode `null`, and that is a real episode with work of its own — distinct from "no episode
  // given", which retires everything the way this always did.
  const keeps = keepEpisode !== undefined;
  const keepOrigin =
    keepEpisode?.originDisplayId != null
      ? String(keepEpisode.originDisplayId)
      : null;
  return db.$executeRaw`
      UPDATE scheduler_jobs
         SET status = 'DONE',
             payload = payload || ${stamp}::jsonb,
             claim_seq = claim_seq + 1,
             updated_at = now()
       WHERE tenant_id = ${tenantId}
         AND kind = ${kind}::"SchedulerJobKind"
         AND dedupe_key = ${dedupeKey}
         AND status IN ('PENDING', 'CLAIMED')
         AND NOT (
               ${keeps}::boolean
           AND jsonb_exists(payload, 'originDisplayId')
           AND payload->>'originDisplayId' IS NOT DISTINCT FROM ${keepOrigin}::text
         )`;
}

function readJobRetirement(
  job: ClaimedJob,
  base: PrismaClient,
  scoped?: ScopedDb,
): Promise<{ payload: unknown; claimSeq: number } | null> {
  const read = (db: ScopedDb) =>
    db.schedulerJob.findUnique({
      where: { id: job.id },
      select: { payload: true, claimSeq: true },
    });
  return scoped ? read(scoped) : runScopedOn(base, sysCtx(job.tenantId), read);
}

function isRetired(
  job: ClaimedJob,
  row: { payload: unknown; claimSeq: number } | null,
): boolean {
  if (!row) return false;
  const retired =
    (row.payload as { cancelledAt?: unknown } | null)?.cancelledAt != null ||
    row.claimSeq !== job.claimSeq;
  if (retired) {
    logger.info(
      "scheduler: claimed job retired, standing down (kind=%s job=%s)",
      job.kind,
      String(job.id),
    );
  }
  return retired;
}

// The other half of the tombstone, for the handler holding the claim: has this run been superseded
// while it worked? Re-READ rather than trusted from `job.payload`, because that snapshot is from
// claim time, which is exactly the moment before a stamp would land.
//
// Unreadable is NOT retired. An unknown must not silently drop a customer-facing message that was
// legitimately armed — the caller asks this to withhold work, so the uncertain answer is the one that
// lets it proceed and be fenced by the CAS at the end. `jobRetiredStrict` is for the callers whose
// fence comes BEFORE that one and cannot afford the guess.
export async function jobRetired(
  job: ClaimedJob,
  base: PrismaClient = basePrisma,
  // The connection to read on, when the caller already holds one. No production caller does since the
  // thread's critical section stopped being one long transaction (issue #225), so every `stillWanted`
  // now opens its own short scope. Kept, and kept tested, because the rule it encodes still binds
  // anything asked from inside a transaction: opening a second connection there stalls on an
  // exhausted pool while still holding the lock, and `DB_POOL_MAX=1` is a supported setting.
  scoped?: ScopedDb,
): Promise<boolean> {
  const row = await readJobRetirement(job, base, scoped).catch(
    (err: unknown) => {
      logger.warn(
        "scheduler: could not re-read the retirement of a claimed job (kind=%s job=%s): %s",
        job.kind,
        String(job.id),
        err instanceof Error ? err.message : String(err),
      );
      return null;
    },
  );
  return isRetired(job, row);
}

// THE SAME QUESTION, ASKED WHERE A GUESS IS THE EXPENSIVE ANSWER. `jobRetired` swallows an
// unreadable row as "still wanted" because for most callers the cost of guessing wrong is a message
// sent one time too many, fenced later by the CAS. Inside the thread's critical section the cost is
// the opposite and it lands before any fence: the run recreates the graph state /reset just cleared,
// and the operator is told the conversation was wiped while the agent keeps answering from it.
//
// The read can now fail where it could not before. It used to borrow the enclosing transaction's live
// connection; since that transaction is gone (issue #225) it opens its own short scope, which can
// exhaust `maxWait` under exactly the pool pressure this whole change is about. Propagating sends the
// job back through the scheduler's own bounded retry (worker.ts `fail`), which is what an unknown
// deserves here.
export async function jobRetiredStrict(
  job: ClaimedJob,
  base: PrismaClient = basePrisma,
  // Same connection rule as the lenient probe above. The redirect ladder's composite fence asks from
  // inside its own read, and a second connection opened there would be a round trip this question
  // does not need.
  scoped?: ScopedDb,
): Promise<boolean> {
  return isRetired(job, await readJobRetirement(job, base, scoped));
}

// The SAME question as a SQL predicate, for the one caller that cannot ask it and then act: a write
// whose condition has to be evaluated by the statement that writes, because the command it races
// does two things in order (retire, then clear what the write would restore) and any read/act pair
// can be split between them.
//
// It lives HERE, touching the function above, because the two are one rule written twice and that is
// how a rule starts drifting. tests/modules/scheduler.test.ts asserts they agree on every state a
// row can be in — including the absent one, where both answer "not retired" for the reason the
// function documents: an unknown is not a retirement.
export function jobNotRetiredSql(job: ClaimedJob): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1
      FROM scheduler_jobs sj
     WHERE sj.id = ${job.id}
       AND sj.tenant_id = ${job.tenantId}
       AND (
         sj.claim_seq <> ${job.claimSeq}
         OR sj.payload->>'cancelledAt' IS NOT NULL
       ))`;
}

// WHO OWES THE ANNOUNCEMENT OF A DEATH, WRITTEN ON THE ROW BECAUSE THE ROW IS WHAT GETS ERASED
// (issue #737).
//
// The generic dead-letter line re-reads the row before writing, and used to treat a MISSING row as
// "the work completed" — true for a `JOB_DELETE_ON_DONE` kind only while the completion is the ONLY
// thing that deletes it. For `INGEST_MESSAGE` it is not: the revoke below deletes `DEAD` rows too,
// deliberately, because the row holds the encrypted message body and a `/reset` that left it would
// confirm "memory cleared" over a stored copy of the conversation. A reset landing between the DEAD
// write and that re-read therefore erased the evidence, and the loss went unannounced in BOTH
// places at once — no job row, and no `dead_letter` line either.
//
// "No row" has two origins and cannot classify on its own, which is why the answer is not a smarter
// read. The other origin is a genuine re-do: after the DEAD write the only road back to a deleted
// row is re-arm → re-claim → `completeJob` (which CASes on `CLAIMED`), so a missing row can also
// mean the message WAS ingested, by a later attempt. Announcing every missing row would page an
// operator about losses that did not happen and turn a `/reset` into a burst of errors.
//
// So the two candidates claim the announcement instead, and the claim is a token written INTO the
// row: whoever stamps it first owns the line, and the loser stays quiet. They serialize on the row
// lock, so under READ COMMITTED the orderings are exhaustive — if this UPDATE commits first the
// DELETE re-evaluates `jsonb_exists` against the stamped version and skips its own announcement; if
// the DELETE commits first this UPDATE matches nothing and returns 0.
//
// `payload` rather than a column of its own, and not only to save a migration: the token is about a
// single run of a single row, and `retireJobsByDedupeKeyOn` already writes `cancelledAt` there for
// the same reason.
//
// It holds the CLAIM the death belonged to, and mere presence is not the question (review round 1).
// A re-arm replaces the payload only when the caller supplies one, and three production callers do
// not (`ensureTenantSweep`, `ensureFlowlogSweep`, `ensureTenantHeartbeat`). Testing for the key
// alone, a row that had died once and been announced would carry the token forever: re-armed, run
// successfully any number of times, then dead again, and that second death would be suppressed by
// the first one's receipt. Naming the claim makes the token answer the only question worth asking,
// which is whether THIS death was announced, and a stale token names a claim that no longer exists.
export const DEAD_LETTER_ANNOUNCED = "deadLetterAnnouncedFor";

// What the reaper's road to DEAD says about itself, in ONE place because it is said TWICE: by
// `announceReaped` (../scheduler/worker.ts), which has the reaped job in hand, and by the revoke,
// which has only the row. The row is what is left when the death's own caller is gone, and this road
// writes no `last_error` — nothing reaches `failJob` when a claim crashes — so a DEAD row with an
// empty one came from here, `failJob` being the only other road and one that always writes it.
//
// Writing the sentence ONTO the row was tried and dropped. It made the row self-describing, which is
// worth something, but it is not what this issue is about, and it made the fallback below
// untestable: with the row carrying the sentence the fallback never fires, and the two mutations
// then mask each other (each alone is invisible because the other covers it). The fallback is the
// one that has to stay, because a row that was already DEAD before any of this shipped carries a
// null and is exactly the case the operator cannot afford to see announced blank.
export const REAPED_DEATH_ERROR = "reaped: the claim never finished";

// And the OTHER empty, which is not the same empty. `failJob` writes `sanitizeErrorMessage(error)`,
// and a handler that throws an empty (or whitespace-only) message makes that the empty STRING — a
// death by the `failJob` road that says nothing about itself. Folding it into the sentence above
// with a `||` was wrong in the one way this line cannot afford: it tells the operator the claim
// never finished, about a claim that finished and failed. NULL is the reaper, `''` is this.
export const UNRECORDED_DEATH_ERROR =
  "dead-lettered: the failure recorded no message";

// The claim, for the announcer. `true` means this call owns the line and must write it; `false`
// means the row moved on, was re-armed, or somebody else already owns it — and in every one of those
// the right thing is silence.
//
// It REPLACES the re-read it descends from rather than adding to it, so the announcement costs the
// same one round trip it always did. The three conditions are the ones that read were already
// making: DEAD, and DEAD for THIS claim (a row re-armed, re-claimed and dead AGAIN belongs to a later
// attempt, which announces its own death with its own error), plus the token.
//
// `updated_at` is deliberately left where it is. Stamping is bookkeeping about the announcement, not
// a transition of the work, and moving the column would make a dead row look like it did something.
export async function claimDeadLetterAnnouncement(
  job: { id: bigint; tenantId: bigint; claimSeq: number },
  base: PrismaClient = basePrisma,
): Promise<boolean> {
  const stamp = JSON.stringify({
    [DEAD_LETTER_ANNOUNCED]: String(job.claimSeq),
  });
  const count = await runScopedOn(
    base,
    sysCtx(job.tenantId),
    (db) => db.$executeRaw`
      UPDATE scheduler_jobs
         SET payload = payload || ${stamp}::jsonb
       WHERE id = ${job.id}
         AND status = 'DEAD'
         AND claim_seq = ${job.claimSeq}
         AND payload->>${DEAD_LETTER_ANNOUNCED} IS DISTINCT FROM ${String(job.claimSeq)}`,
  );
  return count > 0;
}

// A death whose row was erased before anyone announced it, handed BACK rather than announced on the
// spot (review round 1). The revoke runs on the caller's connection, inside the caller's
// transaction, and for `/reset` that transaction is the safety net the command is built on: it
// deletes the memory rows first and the checkpoint last so a failed checkpoint delete rolls the rows
// back and leaves a clean retry. A line emitted from inside it survives a rollback that puts the
// DEAD row back unmarked, and the next announcer writes the same death a second time.
//
// So the shape is the reaper's: the statement produces the deaths, and announcing them is a separate
// call the caller makes once its own write is durable. `tests/modules/scheduler-erased-death-
// announced.test.ts` is the fence that keeps a second caller from forgetting it, the way
// `announceReaped` was forgotten by three lanes.
export interface ErasedDeath {
  tenantId: bigint;
  kind: SchedulerJobKind;
  jobId: bigint;
  dedupeKey: string;
  error: string;
  // A TRANSAÇÃO que apagou a linha, para o anúncio poder perguntar ao Postgres se ela durou. É o
  // `xid8` da transação do CHAMADOR, porque é nela que o `DELETE` corre.
  xid: string;
}

export async function announceErasedDeaths(
  deaths: ErasedDeath[],
  base: PrismaClient = basePrisma,
): Promise<void> {
  // NEVER THROWS, and the boundary is here rather than at each call site (review round 5). This is
  // the one place in the announcement that AWAITS a query, so a pool timeout on it would propagate
  // into whatever the caller was doing — for `/reset`, aborting the cleanup steps and the
  // acknowledgement AFTER the memory was already deleted, which is the one outcome the command's
  // step-by-step error handling exists to prevent. A trail line that cannot be written is not a
  // reason to fail the work it describes (docs/logs.md), and the same rule already governs
  // `dispatchDeadLetter`.
  try {
    await announceErasedDeathsOrThrow(deaths, base);
  } catch (err) {
    logger.warn(
      { err, deaths: deaths.length },
      "scheduler: erased-death announcement failed",
    );
  }
}

async function announceErasedDeathsOrThrow(
  deaths: ErasedDeath[],
  base: PrismaClient,
): Promise<void> {
  if (deaths.length === 0) return;
  // THE DELETION IS CONFIRMED BY THE DATABASE, NOT INFERRED FROM ANYTHING ELSE (review rounds 3
  // and 5).
  //
  // Two inferences were tried and both are wrong. Asking the CALLER whether its step threw fails
  // because a Postgres block already in the aborted state accepts `COMMIT` and replies `ROLLBACK`
  // without an error, so any `try/catch` inside the caller's callback makes the promise resolve
  // over a transaction that kept nothing (measured). Asking whether the ROW is back fails because
  // absence proves that SOMEBODY deleted it, not that THIS revoke did: a reset that rolled back,
  // with a second queued reset deleting the restored row and announcing it, leaves the first one
  // looking at an absent row and announcing the same death again.
  //
  // `pg_xact_status` answers the actual question. The revoke's DELETE runs in the caller's
  // transaction and hands back its `xid8`; here the commit log says `committed`, `aborted` or
  // `in progress`, and only the first earns a line. Anything else stays quiet, which is the cheap
  // side of the trade: a lost line leaves the death where the next reader finds it, a duplicated
  // one cannot be retracted. `in progress` also means the caller announced before its own
  // transaction ended, which is a misuse worth naming out loud.
  //
  // ONE QUERY PER TRANSACTION, not one for the batch, and the difference is a whole batch (measured
  // by the scenario runner). `pg_xact_status` RAISES on an id in the future instead of answering
  // null, so a single `unnest` over the batch loses every death in it to the one id that could not
  // be read — and the outer catch that keeps this from breaking the caller is exactly what makes
  // that silent. The ids are few (the deaths one `/reset` erased on one thread), so asking one at a
  // time costs nothing and contains the damage to the row it belongs to. Anything unreadable stays
  // quiet, on the same trade as everything else here.
  const xids = [...new Set(deaths.map((d) => d.xid))];
  const status = new Map<string, string | null>();
  for (const xid of xids) {
    try {
      const rows = await asSuperAdminOn(base, (db) =>
        db.$queryRaw<Array<{ st: string | null }>>(Prisma.sql`
          SELECT pg_xact_status(${xid}::xid8) AS st`),
      );
      status.set(xid, rows[0]?.st ?? null);
    } catch (err) {
      logger.warn({ err, xid }, "scheduler: unreadable transaction id");
      status.set(xid, null);
    }
  }
  // AND THE ROW, which is a SECOND question and not the same one asked twice. The commit log says
  // the transaction committed; it does not say this DELETE survived it, because a `ROLLBACK TO
  // SAVEPOINT` undoes the statement inside a transaction that goes on to commit (constructed and
  // measured: `committed` with the row back). Nothing in the app issues savepoints today, so this
  // too would hold by ABSENCE — and the pair is not redundant, because each covers what the other
  // cannot: the commit log catches the reset whose row a SECOND reset deleted and announced, where
  // absence proves nothing; the row catches the statement undone inside a committed transaction,
  // where the commit log proves nothing.
  //
  // O QUE O PAR AINDA NÃO FECHA, medido e registrado em vez de escondido: as duas perguntas passam
  // individualmente e a combinação erra quando um TERCEIRO ator satisfaz a segunda. Revoke 1 tem o
  // `DELETE` desfeito por savepoint numa transação que commita; revoke 2 apaga a linha restaurada de
  // verdade e anuncia; revoke 1 então vê `committed` e a linha ausente, e escreve a segunda linha.
  // Fecharia conferindo um efeito que só ESTE statement poderia ter produzido, e o statement apaga,
  // ou seja, não deixa nenhum: o preço de fechá-lo é uma tabela ou coluna nova para registrar a
  // própria exclusão, e contra um caminho que ninguém percorre ele não se paga agora.
  //
  // E a tranca que segura isso NÃO é o savepoint ser raro, que é a leitura fácil e a errada. É não
  // existir um segundo chamador: enquanto o `/reset` for o único, o revoke 2 da sequência só pode
  // ser outro `/reset` na mesma thread, e `withKeyedQueue` os serializa no mesmo processo. Num
  // segundo chamador, ou em duas réplicas, essa serialização some ANTES de o savepoint entrar na
  // conta. Por isso a condição está escrita aqui e a obrigação de anunciar tem cerca de fonte: as
  // duas apontam para a mesma pessoa, a que for escrever o segundo chamador.
  const vivos = new Set<bigint>();
  const porTenant = new Map<bigint, bigint[]>();
  for (const death of deaths) {
    const ids = porTenant.get(death.tenantId);
    if (ids) ids.push(death.jobId);
    else porTenant.set(death.tenantId, [death.jobId]);
  }
  for (const [tenantId, ids] of porTenant) {
    const rows = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.schedulerJob.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      }),
    );
    for (const row of rows) vivos.add(row.id);
  }
  for (const death of deaths) {
    const st = status.get(death.xid) ?? null;
    if (st !== "committed" || vivos.has(death.jobId)) {
      if (st === "in progress") {
        logger.warn(
          { jobId: String(death.jobId), kind: death.kind },
          "scheduler: erased-death announcement asked before the caller's transaction ended",
        );
      }
      continue;
    }
    emitDeadLetter({
      tenantId: death.tenantId,
      unit: "job",
      level: JOB_DEATH_LEVEL[death.kind],
      error: death.error,
      detail: {
        kind: death.kind,
        jobId: String(death.jobId),
        dedupeKey: death.dedupeKey,
        // Not required by the line's contract, and kept because the operator would otherwise go
        // looking for a job row that no longer exists: it says the death is real and the record of
        // it was erased on purpose.
        erasedBy: "revoke",
      },
      base,
    });
  }
}

// REVOKED, not merely cancelled: PENDING **and** CLAIMED rows under a dedupeKey prefix are retired.
//
// The last and strongest of the four, and the difference is deliberate. The two cancels reach PENDING
// rows only. `retireJobsByDedupeKey` reaches the claimed one too but LEAVES it, because its key is
// reusable and the work may legitimately be armed again. Here the work has been REVOKED — a memory
// reset means the operator asked for everything queued against this thread to stop existing,
// including the message a job claimed a second ago and is holding while it waits on the reset's own
// lock — and the row goes with it.
//
// Retiring the row is only half of that: it does not stop a handler already running in memory. The
// other half is the handler re-asking, under the lock, whether its own row is still CLAIMED by it
// (../../graph/ingest-job.ts) — the same claimSeq CAS that already guards completion, moved in front
// of the write it cannot take back.
// Takes the caller's ALREADY-SCOPED connection rather than a client to open a transaction on. The one
// caller is /reset, which runs this from inside the advisory lock it holds on that very connection —
// starting a second transaction there is a deadlock the moment the pool is down to its last one, and
// `DB_POOL_MAX=1` is a supported setting. Nothing here needs a transaction of its own anyway: the
// caller's is the one whose atomicity matters.
export async function revokeJobsByKeyPrefixOn(
  db: ScopedDb,
  kind: SchedulerJobKind,
  prefix: string,
  // UP TO THIS MESSAGE, when the caller has one (issue #736). `/reset` is not instantaneous: its
  // memory step waits for `withKeyedQueue('ingest:<thread>')` behind whatever ingestion is in
  // flight, and `armIngest` does NOT take that queue — it calls `enqueueJob` straight through. So a
  // customer message landing in that stretch arrives AFTER the command, arms its own ingestion, and
  // unqualified this deleted it. The loss is silent twice over: the row is deleted rather than
  // retired, and INGEST_MESSAGE is JOB_DELETE_ON_DONE, so afterwards "deleted by the revoke",
  // "ingested" and "never armed" are the same zero rows.
  //
  // OMITTED MEANS EVERYTHING, and that is not the same choice `cancelPendingJobsByPrefixUpToMessage`
  // makes. A command that named no message writes no boundary, and the OBSERVE cancel SKIPS itself
  // there because a verdict with nothing to order against is better left to the tick's own fence.
  // This one must still run: its duty is to stop text from BEFORE the reset landing back in a
  // cleared thread, and that duty does not depend on the command having an id. The two are one line
  // apart and part company here, which is why it is said out loud.
  //
  // READ FROM THE KEY, not from `payload.messageId`, and evaluated INSIDE the delete. Two things
  // forced that, and they pull in the same direction.
  //
  // The key, because `payload` is a convenience copy a row could be missing, and Prisma renders
  // every JSON path comparison with a `JSONB_TYPEOF(...) = 'number'` guard — inside a `NOT` as much
  // as outside it, measured — so no filter the query builder can express even sees such a row.
  // Whichever way the payload form is written it gets one of the two sides wrong: as `lte` the
  // undecidable row BELOW the boundary survives holding text the reset was asked to erase, and as
  // "delete what is not provably above" the one ABOVE it is deleted, which is the customer message
  // this fence exists to save. `ingestDedupeKey` builds `ingest:<thread>:<messageId>` from
  // `ingestKeyPrefix`, so what follows the prefix IS the message id, in decimal.
  //
  // Inside the delete, because reading the ids first and deleting by id opens a window this
  // statement does not have (PR review round 1): `runScopedOn` runs at READ COMMITTED and
  // `armIngest` takes neither the ingestion queue nor the thread row, so a delayed pre-reset
  // delivery arming between the read and the delete is absent from the id list and SURVIVES the
  // reset. One statement sees rows committed up to its own start, which is the same window the
  // unqualified sweep always had rather than a wider one.
  //
  // The unreadable suffix is DELETED, and that asymmetry is deliberate: "above" is what spares a
  // row, so a key this cannot parse is not spared on evidence nobody has. The bound is therefore
  // meaningful only for a kind whose key ends in the message id, which is the one caller it has.
  atOrBelowMessageId?: number,
): Promise<{ count: number; erasedDeaths: ErasedDeath[] }> {
  {
    // NO `status` HERE, and its absence is load-bearing: the two branches below disagree about
    // which statuses they touch, and each one says so where it acts. The delete spells them in the
    // raw statement (a DEAD row is erased with the others) and the retire overrides them
    // (`PENDING`/`CLAIMED` only). A `status` in this shared shape would decide nothing in either —
    // measured: a mutant removing DEAD from it survived the whole suite, because the delete had
    // stopped reading it when #739 turned that half into one raw statement.
    const where = {
      kind,
      dedupeKey: { startsWith: prefix },
    };
    // DELETED where the kind says a finished row leaves nothing behind. Marking it DONE is how the
    // two cancellations above retire a row, and for a reusable key that is exactly right — but a
    // revoked ingestion can never reach `completeJob`, which is where JOB_DELETE_ON_DONE is normally
    // spent, because by then the row is no longer CLAIMED by anyone and the CAS matches nothing. It
    // would sit there forever holding the encrypted message body the reset was asked to erase, on a
    // table nothing sweeps. Reading the same map is what keeps the two answers from drifting.
    if (JOB_DELETE_ON_DONE[kind]) {
      // AND THE ROW IT ERASES MAY BE THE ONLY RECORD THAT A DEATH HAPPENED (issue #737). Deleting a
      // DEAD row destroys the evidence the generic announcement re-reads, so this statement owes
      // the line that announcement can no longer write — see DEAD_LETTER_ANNOUNCED above for why
      // the two cannot both write it and cannot both stay quiet. The line is not WRITTEN here: the
      // deaths go back to the caller, who announces once its own transaction is durable
      // (`announceErasedDeaths`).
      //
      // ONE statement with RETURNING, never a read followed by a delete: the announcement decision
      // has to be made by the statement that deletes, or a concurrent announcer slips between the
      // two and the death is reported twice.
      //
      // The stamp is tested in RETURNING and NOT in the WHERE, which is the whole difference between
      // announcing and erasing. Under READ COMMITTED a DELETE blocked on a concurrent UPDATE
      // re-evaluates its WHERE against the updated row, so a stamp in there would make the row
      // SURVIVE the revoke the moment the announcer won the race — trading the erasure the operator
      // asked for against a log line. RETURNING hands back the post-UPDATE version either way, so
      // the row always goes and only the announcement is conditional.
      //
      // Raw, so the prefix is escaped by hand: this function takes any prefix, and `_` and `%` are
      // ordinary characters in a dedupe key.
      const like = `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
      const erased = await db.$queryRaw<
        Array<{
          id: bigint;
          tenant_id: bigint;
          dedupe_key: string;
          last_error: string | null;
          xid: string;
          unannounced_death: boolean;
        }>
      >(Prisma.sql`
        DELETE FROM scheduler_jobs
         WHERE kind = ${kind}::"SchedulerJobKind"
           -- DEAD included, and only here, where the row is DELETED. A job that exhausted its
           -- retries before the reset is not going to run, but its row still holds the encrypted
           -- message body, and nothing sweeps this table — so a reset that left it would confirm
           -- "memory cleared" over a stored copy of the conversation. And spared on the other side
           -- of the boundary for the same reason: a DEAD row for a message that arrived AFTER the
           -- command holds a body the reset was never asked to erase, and deleting it also throws
           -- away a dead-letter the operator may still need to read.
           AND status IN ('PENDING', 'CLAIMED', 'DEAD')
           AND dedupe_key LIKE ${like}
           ${
             atOrBelowMessageId === undefined
               ? Prisma.empty
               : Prisma.sql`AND NOT (
                   substring(dedupe_key from char_length(${prefix}) + 1) ~ '^[0-9]{1,18}$'
                   AND (substring(dedupe_key from char_length(${prefix}) + 1))::bigint > ${atOrBelowMessageId}
                 )`
}
        RETURNING id, tenant_id, dedupe_key, last_error,
                  pg_current_xact_id()::text AS xid,
                  (status = 'DEAD'
                   AND payload->>${DEAD_LETTER_ANNOUNCED}
                       IS DISTINCT FROM claim_seq::text)
                  AS unannounced_death`);
      return {
        count: erased.length,
        erasedDeaths: erased
          // Only a DEATH, and only one nobody has claimed. A PENDING or CLAIMED row is work the
          // operator asked to call off, and calling it a loss would turn one `/reset` into a burst
          // of errors about messages that were never owed.
          .filter((row) => row.unannounced_death)
          .map((row) => ({
            tenantId: row.tenant_id,
            kind,
            jobId: row.id,
            dedupeKey: row.dedupe_key,
            // What the ROW remembers, because whoever could explain this death is not here. The
            // two empties are told apart on purpose: see UNRECORDED_DEATH_ERROR.
            error:
              row.last_error === null
                ? REAPED_DEATH_ERROR
                : row.last_error || UNRECORDED_DEATH_ERROR,
            xid: row.xid,
          })),
      };
    }
    // Retired, not deleted, for a reusable key — and a DEAD row is left alone there: marking it DONE
    // would erase the dead-letter the operator may still need to see.
    // Nothing is erased, so nothing is owed: the announcement the DEAD row's own road will write is
    // still ahead of it.
    return {
      count: (
        await db.schedulerJob.updateMany({
          where: { ...where, status: { in: ["PENDING", "CLAIMED"] } },
          data: { status: "DONE" },
        })
      ).count,
      erasedDeaths: [],
    };
  }
}

// A claim's test-only isolation: one tenant, or the few a test seeded. The claims are cross-tenant by
// design, so a test that wants to see tenants share one cannot fence it to a single tenant (issue
// #810). Unset in production.
export type TenantFence = bigint | readonly bigint[];

// THE CLAIM'S STATEMENT, built here rather than inline so a test can run the exact SQL the lanes
// run (tests/modules/scheduler-claim-limit.test.ts). Exported for that and for nothing else.
//
// A CTE, and `MATERIALIZED` spelled out, because the obvious form is WRONG (issue #627). Written as
// `WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)` this is a SEMI-JOIN, and a semi-join
// keeps the UPDATE's target on the OUTER side — so the subquery is the inner one, and when the
// planner puts no `Materialize` above it the inner side is re-executed once per outer row. Each
// re-execution SKIPs what the one before it just locked and hands back a DIFFERENT n rows, so every
// row the outer scan reaches ends up matching and the claim returns as many rows as are due.
// Measured on CI inside one transaction, on the same parameters: `SELECT ... LIMIT 5` gave 5 while
// the claim gave 10.
//
// It is the LIMIT that every lane's budget is made of — the traffic share, the observe cap, the
// batch itself — so the failure is not a test's: a tick could claim the whole backlog and run it at
// once, which is the head-of-line blocking the lanes exist to prevent.
//
// `MATERIALIZED` is the executor-level guarantee of ONE evaluation. A `FOR UPDATE` CTE is not
// inlined today, so the keyword is redundant today; it stays because what this depends on is the
// single evaluation, and saying so is what keeps a later Postgres (or a later edit that drops the
// `FOR UPDATE`) from quietly restoring the bug.
export function claimSql(
  lim: number,
  now: Date,
  kindFilter: Prisma.Sql,
  tenantId?: TenantFence,
  excludeIds?: bigint[],
  keyPrefix?: string,
  // Share the slots between tenants instead of handing them out oldest-first (issue #810). Only the
  // debounce lane asks for it; see claimDueDebounceJobs.
  share?: boolean,
): Prisma.Sql {
  // The prefix branch takes a row whose run_at is still in the FUTURE, and only for a row that has
  // never failed. Both halves matter and they answer different questions.
  //
  // Future-dated rows are what the barrier is for: a job DEFERRED for a previous turn sits a minute
  // out, and those are precisely the messages a starting turn is missing.
  //
  // A row that FAILED is future-dated too, and for the opposite reason — `failJob` increments
  // attempts and pushes run_at out by a backoff. Ignoring run_at for those makes the backoff
  // unreachable: every turn on the thread opens a fresh drain, and a handful in quick succession
  // (a burst with debounce off, a turn and a nudge) spends all five attempts within seconds and
  // dead-letters the message, on a database failure that was transient. The drain's `excludeIds`
  // answers that WITHIN one drain; this is the same question ACROSS them.
  //
  // TOLD APART BY `last_error`, NOT BY `attempts`. The first version of this asked whether the job
  // had ever failed, which is a different question wearing the same clothes: a job that failed once
  // and LATER stood down for a turn read as backing off, and the barrier skipped the very message it
  // exists to fold in. The error is the state, and it is cleared the moment the row leaves it. Both
  // columns now clear on a completed pass (issue #287), so the two agree here; `last_error` remains
  // the one to read, because it is the column that says which STATE the row is in rather than how
  // much budget it has left.
  //
  // Nothing is lost by waiting: a row left here is still PENDING, so `countOwedByKeyPrefix` reports
  // the thread as owing something and the one reader that cannot be corrected afterwards still
  // refuses to summarise without it.
  const dueClause =
    keyPrefix === undefined
      ? Prisma.sql`AND run_at <= ${now}`
      : Prisma.sql`AND dedupe_key LIKE ${`${keyPrefix}%`} AND (last_error IS NULL OR run_at <= ${now})`;
  const tenantClause =
    tenantId == null
      ? Prisma.empty
      : typeof tenantId === "bigint"
        ? Prisma.sql`AND tenant_id = ${tenantId}`
        : Prisma.sql`AND tenant_id IN (${Prisma.join([...tenantId])})`;
  const excludeClause =
    excludeIds && excludeIds.length > 0
      ? Prisma.sql`AND id NOT IN (${Prisma.join(excludeIds)})`
      : Prisma.empty;
  // SHARED, NOT OLDEST-FIRST (issue #810). Each due row ranks by its tenant's SHARE: how many of
  // that tenant's rows are already in flight, plus the row's place in that tenant's own queue. The
  // lowest share goes first and ties go to the older row, so every free slot goes to the tenant with
  // the least in flight: one tenant's burst queues behind itself instead of in front of everyone, and
  // a tenant alone still takes every slot, because nothing is ever left idle.
  //
  // The rows in flight are exactly `excludeIds` (the drain's in-flight set), whatever their status:
  // a row re-armed to PENDING during its own flush is still running and still counts.
  //
  // Ranked WITHOUT the lock and then locked: Postgres refuses FOR UPDATE on a query with a window
  // function. A row the ranking counted and SKIP LOCKED then skips only moves the queue up by one.
  //
  // The lock step repeats every predicate on the locked row itself. The ranking reads the statement's
  // snapshot, and when a row changed after it Postgres re-checks only the LOCKED relation's own
  // conditions against the new version: a re-arm that pushed run_at into the future in between would
  // otherwise still be claimed and flushed inside its new window. `ranked` names its columns apart so
  // the repeated clauses can only resolve to `s`.
  const due = share
    ? Prisma.sql`
    inflight AS (
      ${
        excludeIds && excludeIds.length > 0
          ? Prisma.sql`SELECT tenant_id, count(*)::int AS n FROM scheduler_jobs
      WHERE id IN (${Prisma.join(excludeIds)}) GROUP BY tenant_id`
          : Prisma.sql`SELECT NULL::bigint AS tenant_id, 0 AS n WHERE false`
      }
    ),
    ranked AS (
      SELECT j.id AS ranked_id, j.run_at AS ranked_run_at,
        COALESCE(f.n, 0) + ROW_NUMBER() OVER (PARTITION BY j.tenant_id ORDER BY j.run_at, j.id) AS share
      FROM (
        SELECT id, tenant_id, run_at FROM scheduler_jobs
        WHERE status = 'PENDING' ${dueClause} AND ${kindFilter}
          ${tenantClause} ${excludeClause}
      ) j
      LEFT JOIN inflight f ON f.tenant_id = j.tenant_id
    ),
    due AS MATERIALIZED (
      SELECT s.id FROM scheduler_jobs s JOIN ranked r ON r.ranked_id = s.id
      WHERE status = 'PENDING' ${dueClause} AND ${kindFilter}
        ${tenantClause} ${excludeClause}
      ORDER BY r.share, r.ranked_run_at, r.ranked_id
      FOR UPDATE OF s SKIP LOCKED
      LIMIT ${lim}
    )`
    : Prisma.sql`
    due AS MATERIALIZED (
      SELECT id FROM scheduler_jobs
      WHERE status = 'PENDING' ${dueClause} AND ${kindFilter}
        ${tenantClause} ${excludeClause}
      ORDER BY run_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${lim}
    )`;
  return Prisma.sql`
    WITH ${due}
    UPDATE scheduler_jobs
    SET status = 'CLAIMED', claim_seq = claim_seq + 1, claimed_at = ${now}, updated_at = now()
    FROM due
    WHERE scheduler_jobs.id = due.id
    RETURNING scheduler_jobs.id, scheduler_jobs.tenant_id AS "tenantId",
              scheduler_jobs.kind, scheduler_jobs.payload,
              scheduler_jobs.payload_secret AS "payloadSecret",
              scheduler_jobs.dedupe_key AS "dedupeKey",
              scheduler_jobs.attempts, scheduler_jobs.claim_seq AS "claimSeq"`;
}

// Claims up to `limit` due jobs across ALL tenants matching `kindFilter` (FOR UPDATE SKIP LOCKED so
// replicas/ticks do not double-claim). FIFO by run_at. attempts is NOT incremented here (a claim is
// not a failure). The kind literals are fixed in code (never user input), so embedding them in the
// SQL fragment is safe; Postgres coerces the literal to the enum exactly like 'PENDING'.
async function claimWhere(
  limit: number,
  base: PrismaClient,
  now: Date,
  kindFilter: Prisma.Sql,
  tenantId?: TenantFence,
  // Rows this process is already executing, kept out of the claim itself. Since `claimSeq` this is no
  // longer what stops a stale completion — the CAS does that for every kind — so what it still buys
  // is narrower and worth naming: it stops the same key from being EXECUTED twice at once. For a
  // caller whose handler is expensive (a summary is a model call held for up to 60s while every
  // attendance boundary re-arms the same key), two concurrent runs mean two model calls paid for,
  // and only one of them can land. See src/modules/memory/worker.ts.
  excludeIds?: bigint[],
  // Restrict to one dedupeKey prefix, and take rows whose run_at is still in the FUTURE. Both are
  // for the barrier below, and the second is the half that matters: a job deferred for a turn sits
  // with run_at a minute out, and those are precisely the messages a starting turn is missing.
  keyPrefix?: string,
  share?: boolean,
): Promise<ClaimedJob[]> {
  const lim = Math.min(Math.max(Math.floor(limit), 1), 100);
  return asSuperAdminOn(base, async (db) => {
    const rows = await db.$queryRaw<
      Array<{
        id: bigint;
        tenantId: bigint;
        kind: SchedulerJobKind;
        payload: unknown;
        payloadSecret: string | null;
        dedupeKey: string;
        attempts: number;
        claimSeq: number;
      }>
    >(claimSql(lim, now, kindFilter, tenantId, excludeIds, keyPrefix, share));
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      kind: r.kind,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      payloadSecret: r.payloadSecret,
      dedupeKey: r.dedupeKey,
      attempts: r.attempts,
      claimSeq: r.claimSeq,
    }));
  });
}

// The main scheduler tick (slow cadence) claims everything EXCEPT debounce — DEBOUNCE jobs need the
// dedicated fast tick to honor the per-agent window, and leaving them here would make a flush wait
// up to a full scheduler interval. (A stray DEBOUNCE here would still be handled correctly, but the
// fast worker is the intended drain.)
// NOTE: `tenantId` is test-only isolation, same as the alert worker's. The claim is cross-tenant by
// design (single-leader in production), so two suites running at once against the shared test
// database steal each other's jobs — the LIMIT fills with the other run's rows, or SKIP LOCKED hands
// them over outright, and the test that enqueued a job simply does not find it back. Leave it unset
// in production.
export function claimDueJobs(
  limit: number,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
  tenantId?: bigint,
): Promise<ClaimedJob[]> {
  return claimWhere(limit, base, now, laneFilter("shared", false), tenantId);
}

// The traffic-proportional half of the shared lane, claimed separately and with its own limit. One
// FIFO batch cannot hold both: these rows are armed for `now` and arrive at the rate contacts write,
// so ordered by run_at they are always the oldest and always fill it, and a fixed-rate kind that
// exists to arrive on time never gets claimed at all (../scheduler/lanes.ts,
// JOB_TRAFFIC_PROPORTIONAL). Splitting the claim is what reserves the rest of the batch for them.
export function claimDueTrafficJobs(
  limit: number,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
  tenantId?: bigint,
): Promise<ClaimedJob[]> {
  return claimWhere(limit, base, now, laneFilter("shared", true), tenantId);
}

// The observe lane (issue #621): OBSERVE only, claimed by the shared tick with a limit of its own
// (./lanes.ts, observeClaimLimit) rather than from the traffic share it used to wait in behind
// ingestion.
export function claimDueObserveJobs(
  limit: number,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
  tenantId?: bigint,
): Promise<ClaimedJob[]> {
  return claimWhere(limit, base, now, laneFilter("observe"), tenantId);
}

// Claims every PENDING job of one kind whose dedupeKey starts with `prefix`, DUE OR NOT. The one
// caller is the turn barrier (../../graph/ingest-job.ts): a turn is about to read this thread and
// must not read it without the messages already queued for it, and a job deferred a minute ago for
// a previous turn is exactly such a message. Tenant-scoped by the caller, ordered by run_at so the
// oldest queued message is folded in first.
export function claimPendingByKeyPrefix(
  kind: SchedulerJobKind,
  prefix: string,
  limit: number,
  base: PrismaClient = basePrisma,
  tenantId?: bigint,
  // Rows this drain already handled. Required in practice, not an optimization: ignoring run_at is
  // what lets the barrier see a deferred job, and it also defeats FAILURE backoff — a row that just
  // failed is due again immediately, so a looping drain would burn every attempt in milliseconds.
  excludeIds?: bigint[],
): Promise<ClaimedJob[]> {
  return claimWhere(
    limit,
    base,
    new Date(),
    Prisma.sql`kind = ${kind}::"SchedulerJobKind"`,
    tenantId,
    excludeIds,
    prefix,
  );
}

// Whether anything of one kind is still OWED under a dedupeKey prefix — PENDING (queued, or deferred
// into the future) or CLAIMED (executing right now, somewhere). The one caller is the ingestion
// barrier, and only its compaction reader consults the answer: for a turn an owed message is one late
// reply, for compaction it is a message summarised out of existence.
//
// DEAD is deliberately NOT owed. A dead-lettered message will never arrive, so counting it would
// stall every future compaction of that thread forever, trading a lost message for a memory that
// stops being written at all.
export function countOwedByKeyPrefix(
  kind: SchedulerJobKind,
  prefix: string,
  base: PrismaClient = basePrisma,
  tenantId?: bigint,
): Promise<number> {
  return asSuperAdminOn(base, (db) =>
    db.schedulerJob.count({
      where: {
        ...(tenantId != null ? { tenantId } : {}),
        kind,
        status: { in: ["PENDING", "CLAIMED"] },
        dedupeKey: { startsWith: prefix },
      },
    }),
  );
}

// The fast debounce tick claims ONLY debounce jobs. `excludeIds` is the drain's in-flight set
// (../debounce/worker.ts), which is also what the claim reads to share the slots between tenants: the
// lane is cross-tenant, and oldest-first let one tenant's burst take every slot (issue #810).
export function claimDueDebounceJobs(
  limit: number,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
  tenantId?: TenantFence,
  excludeIds?: bigint[],
): Promise<ClaimedJob[]> {
  return claimWhere(
    limit,
    base,
    now,
    laneFilter("debounce"),
    tenantId,
    excludeIds,
    undefined,
    true,
  );
}

// A due row of the debounce lane that nobody has claimed yet.
export interface WaitingDebounceJob {
  id: bigint;
  tenantId: bigint;
  runAt: Date;
  dedupeKey: string;
}

// Who is waiting for a slot of the debounce lane: its rows due at or before `dueBefore` and still
// PENDING, oldest first (issue #812). Read-only. The drain asks only while its lane is full, and only
// to announce a wait, so a bounded page is enough: the rows past it are announced on a later tick.
export function findWaitingDebounceJobs(
  dueBefore: Date,
  excludeIds: bigint[],
  base: PrismaClient = basePrisma,
  tenantId?: bigint,
  limit = 100,
): Promise<WaitingDebounceJob[]> {
  return asSuperAdminOn(base, (db) =>
    db.schedulerJob.findMany({
      where: {
        ...(tenantId != null ? { tenantId } : {}),
        kind: { in: kindsInLane("debounce") },
        status: "PENDING",
        runAt: { lte: dueBefore },
        ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
      },
      orderBy: { runAt: "asc" },
      take: limit,
      select: { id: true, tenantId: true, runAt: true, dedupeKey: true },
    }),
  );
}

// The compaction lane claims ONLY compaction jobs. It exists for BUDGET, not for duration: it fires
// for every agent on every closed attendance (it ships on by default) and takes permits from the same
// model semaphore a customer's turn queues on, so its batch is sized to a fraction of that budget
// (see defaultBatchSize). Duration alone would no longer justify it — the shared tick drains
// concurrently now — which is exactly the rule written down in lanes.ts.
export function claimDueCompactionJobs(
  limit: number,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
  tenantId?: bigint,
  excludeIds?: bigint[],
): Promise<ClaimedJob[]> {
  return claimWhere(
    limit,
    base,
    now,
    laneFilter("compaction"),
    tenantId,
    excludeIds,
  );
}

// Terminal success. `claimSeq` is the token the claim handed out: without it the CAS matches
// whatever CLAIMED row happens to exist, which is how a run that finished late marked SOMEONE ELSE'S
// arm done (issue #164).
//
// Returns whether the write LANDED, for the same reason failJob returns whether it dead-lettered: a
// CAS that refuses is the only evidence that this run was superseded, and refusing in silence is how
// the ordering stays invisible — which is the complaint the token was added to answer, not one to
// reproduce one layer down. The caller decides what to do with it; runClaimed logs it.
export async function completeJob(
  tenantId: bigint,
  id: bigint,
  claimSeq: number,
  kind: SchedulerJobKind,
  base: PrismaClient = basePrisma,
): Promise<{ applied: boolean }> {
  // Same CAS either way, so a superseded claim still writes nothing. Deleting is NOT a handler's job
  // to do for itself: a handler that removed its own row would leave this call matching nothing, and
  // the caller reads that as "claim superseded, outcome discarded" — a warning on every successful
  // run, saying something that did not happen.
  const { count } = await runScopedOn(base, sysCtx(tenantId), (db) =>
    JOB_DELETE_ON_DONE[kind]
      ? db.schedulerJob.deleteMany({
          where: { id, status: "CLAIMED", claimSeq },
        })
      : db.schedulerJob.updateMany({
          where: { id, status: "CLAIMED", claimSeq },
          // NOTE: `attempts` is cleared for the same reason rescheduleJob clears it (issue #287):
          // reaching here means the handler neither threw nor reported failure, so the pass proved
          // the job works and the budget it spent was for a state it is no longer in. DONE is
          // simply the other ending of that same pass, and leaving the count on the row is what
          // made a kind whose dedupeKey is permanent (one row per thread, per document, reused
          // forever) inherit failures across months of healthy work and retire on the fifth (issue
          // #339).
          //
          // `lastError` deliberately stays: a DONE row is the RECORD that the work happened, the
          // last error is part of that record, and nothing reads it as state here. The two future-
          // dated PENDING states that `lastError` does tell apart (backoff vs stood down) are
          // rescheduleJob's problem, and a re-arm clears it before the row is claimable again
          // anyway.
          //
          // `payloadSecret` is cleared too: a retained row is kept for its KEY (the dedupe a later
          // enqueue lands on), never for its body, and the body is the part that can carry a
          // customer's words (issue #587, review round 5). A re-arm writes its own.
          data: { status: "DONE", attempts: 0, payloadSecret: null },
        }),
  );
  return { applied: count > 0 };
}

// Not a failure (e.g. out-of-hours): back to PENDING at a new time, with the failure budget and
// `lastError` both CLEARED, because the row is no longer in the state that error describes. That is
// also what makes the two future-dated states tellable apart: a row waiting on a backoff still
// carries the error that caused it, a row that merely stood down carries none. The ingestion
// barrier reads that difference — see claimWhere's prefix branch. `enqueueJob` already clears
// `lastError` on a re-arm, for the same reason.
//
// `attempts` is reset here, which is what makes MAX_ATTEMPTS bound CONSECUTIVE failures rather than
// the row's lifetime (issue #287). Reaching this call means the handler neither threw nor reported
// failure — runClaimed routes those to failJob — so the pass proved the job works, and the budget it
// spent was for a state it is no longer in. Without this, a job that reschedules itself forever
// (FLOWLOG_SWEEP, FOLLOWUP_SWEEP, HEARTBEAT) accumulates every failure it has ever had across weeks
// of healthy passes and dead-letters on the fifth, permanently and silently.
//
// It does NOT hand a broken unit of work an unbounded retry, and the reason is the shape of a
// failure rather than a rule stated here: failJob re-pends with a backoff, so the next claim runs
// the same work again and fails again. Consecutive failures are never interleaved with a completed
// pass, so a genuinely failing FOLLOWUP step or MEMORY_COMPACT still burns its five and dies. What
// this does exempt is a job that fails INTERMITTENTLY, which is a job that works, and one that
// dies for good in silence is the worse of the two outcomes. completeJob clears it for the same
// reason, on the other ending of the same pass (issue #339).
//
// An optional
// `payload` REPLACES the row's payload (used to advance a multi-step follow-up's stepIndex on the
// same row — the dedupeKey is stable, so this never races the upsert vs the completeJob CAS). Omit
// it to keep the current payload.
// Returns whether the write LANDED — see completeJob.
export async function rescheduleJob(
  tenantId: bigint,
  id: bigint,
  claimSeq: number,
  runAt: Date,
  payload?: Record<string, unknown>,
  base: PrismaClient = basePrisma,
  // Merged into the row's CURRENT payload (jsonb `||`) inside the same compare-and-set, instead of
  // replacing it. The difference matters on a row another writer stamps while the handler runs: the
  // per-event reminder cancel merges `cancelledAt` onto rows of ANY status without bumping the claim
  // token, so a replacement written from the claim-time snapshot passes the CAS and erases the
  // tombstone, re-arming a cancelled reminder (issue #281's review). A handler that only needs to
  // carry a counter forward has no business overwriting what it never read.
  payloadPatch?: Record<string, unknown>,
): Promise<{ applied: boolean }> {
  if (payloadPatch !== undefined) {
    const patch = JSON.stringify(payloadPatch);
    const count = await runScopedOn(
      base,
      sysCtx(tenantId),
      (db) =>
        db.$executeRaw`
        UPDATE scheduler_jobs
           SET status = 'PENDING'::"SchedulerJobStatus",
               run_at = ${runAt},
               last_error = NULL,
               attempts = 0,
               payload = payload || ${patch}::jsonb,
               updated_at = now()
         WHERE id = ${id}
           AND tenant_id = ${tenantId}
           AND status = 'CLAIMED'
           AND claim_seq = ${claimSeq}`,
    );
    return { applied: count > 0 };
  }
  const { count } = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.schedulerJob.updateMany({
      where: { id, status: "CLAIMED", claimSeq },
      data: {
        status: "PENDING",
        runAt,
        lastError: null,
        attempts: 0,
        ...(payload !== undefined
          ? { payload: payload as Prisma.InputJsonValue }
          : {}),
      },
    }),
  );
  return { applied: count > 0 };
}

// Failure: attempts++; retry with backoff until the cap, then DEAD.
//
// `sanitizeErrorMessage`, not a bare cut: `error` is whatever a job handler threw, and THIS write is
// the transition itself. A character Postgres refuses (a NUL, an orphan surrogate) takes the whole
// statement with it, and then the row keeps its CLAIMED status and its old `attempts`: nothing
// reclaims it and nothing reports it. What used to guard this column was every handler's own habit
// of not quoting a third party, never anything stated here (issue #243). The same call is what keeps
// a credential-shaped substring out of the column.
// Returns whether this call is the one that DEAD-LETTERED the job — the attempt count alone does not
// say so. The CAS is on `status = 'CLAIMED'` AND on the claim's own token, so a job re-armed mid-run
// (`armDebounce` upserts the claimed row back to PENDING) fails to match on either count: the row
// survives with another run already queued, and a caller reading `attempts` would call a live job
// dead. Anything hanging off "this work is definitively lost" has to hang off this, not off the
// failure (issue #71).
export async function failJob(
  tenantId: bigint,
  id: bigint,
  claimSeq: number,
  attempts: number,
  kind: SchedulerJobKind,
  error: string,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
): Promise<{ deadLettered: boolean; applied: boolean }> {
  const next = attempts + 1;
  const dead = next >= MAX_ATTEMPTS;
  const { count } = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.schedulerJob.updateMany({
      where: { id, status: "CLAIMED", claimSeq },
      data: dead
        ? {
            status: "DEAD",
            attempts: next,
            lastError: sanitizeErrorMessage(error),
          }
        : {
            status: "PENDING",
            attempts: next,
            runAt: new Date(
              now.getTime() + backoffMs(next, JOB_RETRY_BASE_MS[kind]),
            ),
            lastError: sanitizeErrorMessage(error),
          },
    }),
  );
  // `deadLettered` alone cannot carry this: false is also what a healthy non-terminal retry returns,
  // so the caller cannot tell a recorded failure from one the guard refused. Reported separately for
  // the same reason completeJob reports it (issue #164 review round 2) — the failure ordering is no
  // less invisible than the success one.
  return { deadLettered: dead && count > 0, applied: count > 0 };
}

// Reaper: a CLAIMED row older than `staleMs` is presumed crashed → back to PENDING (attempts++ so
// poison eventually dies). Cross-tenant, so asSuperAdmin. `tenantId` is the same test-only fence as
// the claim's: without it, a concurrent suite's reap bumps this run's attempts underneath it.
// Returns every row it touched, because the reaper is the SECOND way a job reaches DEAD: a claim that
// crashed or hung is killed here, not by `failJob`, and a caller that hangs its "this work is
// definitively lost" reaction off failJob alone would never hear about those (issue #71 review).
export interface ReapedJob extends ClaimedJob {
  status: "PENDING" | "DEAD";
}

export async function reapStaleJobs(
  staleMs: number,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
  tenantId?: bigint,
  // Restrict the reap to one kind. A lane with its own worker reaps its OWN stale claims, because
  // the worker flags are independent: with the scheduler disabled and that lane enabled, nothing
  // else re-pends a row left CLAIMED by a process that died mid-job, and the dedicated tick only
  // claims PENDING ones. Reaping the same kind from both places is harmless — the second pass finds
  // the row already re-pended.
  kind?: ClaimedJob["kind"],
): Promise<ReapedJob[]> {
  const cutoff = new Date(now.getTime() - staleMs);
  const tenantClause =
    tenantId == null
      ? Prisma.empty
      : typeof tenantId === "bigint"
        ? Prisma.sql`AND tenant_id = ${tenantId}`
        : Prisma.sql`AND tenant_id IN (${Prisma.join([...tenantId])})`;
  const kindClause =
    kind != null ? Prisma.sql`AND kind = ${kind}` : Prisma.empty;
  return asSuperAdminOn(base, async (db) => {
    const rows = await db.$queryRaw<
      Array<{
        id: bigint;
        tenant_id: bigint;
        kind: string;
        payload: unknown;
        payload_secret: string | null;
        dedupe_key: string;
        attempts: number;
        claim_seq: number;
        status: "PENDING" | "DEAD";
      }>
    >(Prisma.sql`
      UPDATE scheduler_jobs
      SET status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'DEAD'::"SchedulerJobStatus" ELSE 'PENDING'::"SchedulerJobStatus" END,
          attempts = attempts + 1,
          claimed_at = NULL,
          updated_at = now()
      WHERE status = 'CLAIMED' AND claimed_at < ${cutoff} ${tenantClause} ${kindClause}
      RETURNING id, tenant_id, kind, payload, payload_secret, dedupe_key,
                attempts, claim_seq, status`);
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      kind: r.kind as ClaimedJob["kind"],
      payload: (r.payload ?? {}) as ClaimedJob["payload"],
      payloadSecret: r.payload_secret,
      dedupeKey: r.dedupe_key,
      attempts: r.attempts,
      claimSeq: r.claim_seq,
      status: r.status,
    }));
  });
}

// Full-jitter backoff with an exponent clamp. The base is the kind's (lanes.ts, issue #744).
export function backoffMs(attempt: number, baseMs: number): number {
  const exp = Math.min(attempt, 8);
  const ceiling = baseMs * 2 ** exp;
  // deterministic-ish jitter without Math.random (varies by attempt); good enough for spacing.
  return Math.floor(
    ceiling / 2 + ((ceiling / 2) * ((attempt * 2654435761) % 1000)) / 1000,
  );
}
