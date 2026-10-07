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
import { runningJobIds } from "./running";

// Durable job store for the scheduler (follow-ups, sweeps, retries).

// A claim carries a token (`claimSeq`) and the three writes that finish a job CAS on it: `enqueueJob`
// re-arms the same physical row in place, so status alone cannot tell the claiming run from a later
// arm. Only the claim bumps the token: a re-arm left PENDING already fails the old CAS, and one that
// is claimed again bumps past it, so a bump in `enqueueJob` would add a hot-path write for nothing.
// The claim is cross-tenant (asSuperAdmin, SKIP LOCKED); each job's effect runs under its own
// tenant scope, so RLS still fences the work. `attempts` is cleared by any completed pass, so
// MAX_ATTEMPTS bounds consecutive failures; the reaper pushes crash loops to DEAD. See `Rearm`.

const MAX_ATTEMPTS = 5;

// Whether a failure of this run puts the job back to PENDING rather than to DEAD: the run's own line
// can then say the work will be tried again, and leave the alarm to the death (when it comes).
export function jobRetriesAfterFailure(job: { attempts: number }): boolean {
  return job.attempts + 1 < MAX_ATTEMPTS;
}

// The lane's kinds as a SQL fragment, derived from lanes.ts (the one table that assigns them) so a kind
// lands in exactly one lane. The values are enum members from a compile-time map, never user input, so
// embedding them is safe. Exported so tests run the real claim statement with the lanes' own filter.
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
  | "KNOWLEDGE_SOURCE_SYNC"
  | "INBOUND_SWEEP"
  | "INBOUND_REDISPATCH"
  | "NOTHING_TO_ANSWER"
  | "SUGGESTION_REVIEW";

export interface ClaimedJob {
  id: bigint;
  tenantId: bigint;
  kind: SchedulerJobKind;
  payload: Record<string, unknown>;
  // The encrypted half, for the kinds that carry one. Kept out of `payload`, a Json column that gets
  // logged or serialized whole (CLAUDE.md, Encryption). The one handler that needs it treats a missing
  // secret as a hard failure (../../graph/ingest-job.ts).
  payloadSecret?: string | null;
  // The operator's handle on which work this is (`followup:<thread>`, `doc:<id>`, ...), and the only
  // field that survives into the dead-letter line as something to act on. Both claim paths select it.
  dedupeKey?: string;
  attempts: number;
  // The token this claim holds. Hand it back to completeJob/rescheduleJob/failJob, which CAS on it so
  // a run superseded while it worked writes nothing.
  claimSeq: number;
}

// What a re-arm of an existing row means, answered by the caller because the row cannot answer it.
// It decides whether the failure budget of a previous FAILED pass survives into this arm.
//   "new-work":  the world changed (a contact wrote, a re-index, a booking): attempts reset to 0.
//   "same-work": a clock re-pushes the same unit (a sweep, a boot re-arm): attempts carry over, or a
//                broken job would get five fresh attempts on every tick.
//   "once":      at most once: an existing row in any state is left untouched, so a redelivery never
//                redoes the work. Its kind must not be deleted on DONE.
// No default: the same row means opposite things to different callers, so the caller must choose.
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

// Where a scheduler_jobs row comes into existence. Takes a ScopedDb because armDebounce writes inside
// its own advisory-lock transaction and cannot open a second one.
// tests/modules/scheduler-row-writers.test.ts fences row creation to this module.
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

// The set-based sibling of `upsertJobRow`, for arming many rows inside one transaction: a per-row
// loop in `reindexKnowledgeBase` would be N round trips against a five-second transaction budget.
// Every row shares one `kind`, `rearm` and `runAt`. The payload is required because an omitted one
// ("keep the stored payload") cannot be spelled in a `text[]` without colliding with a real payload.
export async function upsertJobRows(
  db: ScopedDb,
  params: {
    tenantId: bigint;
    kind: SchedulerJobKind;
    // "once" inserts what is missing and leaves every existing row exactly as it is.
    rearm: Rearm;
    runAt: Date;
    rows: { dedupeKey: string; payload: Record<string, unknown> }[];
  },
): Promise<number> {
  if (params.rows.length === 0) return 0;
  // The rows travel as TWO ARRAYS and not as N tuples, because a tuple list carries one bind
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
    ${
      params.rearm === "once"
        ? Prisma.sql`ON CONFLICT (tenant_id, kind, dedupe_key) DO NOTHING`
        : Prisma.sql`ON CONFLICT (tenant_id, kind, dedupe_key) DO UPDATE
       SET run_at = EXCLUDED.run_at,
           status = 'PENDING'::"SchedulerJobStatus",
           last_error = NULL,
           payload = EXCLUDED.payload,
           -- The payload is authoritative on a re-arm and its secret half travels with it, exactly
           -- as the single-row version does; this shape never carries one, so it is cleared rather
           -- than left behind from a previous arming.
           payload_secret = NULL,
           attempts = ${params.rearm === "new-work" ? Prisma.sql`0` : Prisma.sql`scheduler_jobs.attempts`},
           updated_at = now()`
    }`;
}

// One live row per (tenant, kind, dedupeKey): a re-enqueue re-arms run_at and resets to PENDING.
export async function enqueueJob(params: EnqueueParams): Promise<bigint> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, sysCtx(params.tenantId), (db) =>
    upsertJobRow(db, params),
  );
}

// `enqueueJob` that never supersedes a run in flight, whose outcome the CAS would then discard: a
// CLAIMED row, or one whose handler still runs, is left alone (a dead claim is re-pended by the
// reaper). Two statements, since Prisma has no conditional upsert; the UPDATE re-checks its WHERE
// under the row lock. `leaveLaterRun`: a PENDING row deferred to later (backoff, business hours) that
// the caller calls its own stays put; the UPDATE is pinned to the `run_at` read, so a concurrent
// reschedule makes it match nothing. `stillWanted`: the arming decision re-asked at the write under
// the key's row lock, so the run it races cannot finish in between.
export async function enqueueJobUnlessClaimed(
  params: EnqueueParams & {
    leaveLaterRun?: (row: {
      payload: Prisma.JsonValue;
      lastError: string | null;
    }) => boolean | Promise<boolean>;
    stillWanted?: (db: ScopedDb) => Promise<boolean>;
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
    if (params.stillWanted) {
      await db.$queryRaw`
        SELECT id FROM scheduler_jobs
         WHERE tenant_id = ${params.tenantId}
           AND kind = ${params.kind}::"SchedulerJobKind"
           AND dedupe_key = ${params.dedupeKey}
         FOR UPDATE`;
      if (!(await params.stillWanted(db))) return false;
    }
    const later = params.leaveLaterRun
      ? await db.schedulerJob.findFirst({
          where: { ...key, status: "PENDING", runAt: { gt: new Date() } },
          select: { runAt: true, payload: true, lastError: true },
        })
      : null;
    if (later && (await params.leaveLaterRun?.(later))) return false;
    // A row whose handler still runs counts as claimed even after its deadline re-pended it:
    // re-armed under it, that handler's committed work could no longer be written. Same set every
    // claim excludes.
    const running = runningJobIds();
    const updated = await db.schedulerJob.updateMany({
      where: {
        ...key,
        status: { not: "CLAIMED" },
        ...(running.length > 0 ? { id: { notIn: running } } : {}),
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

// The prefix cancel, fenced on the episode: only rows whose `atMessageId` is at or below the /reset
// command's own message id. A customer message arriving while the command works arms a burst the
// operator wants classified, and it must survive (../../graph/reset-episode.ts). A row with no
// `atMessageId` (a resolve verdict) is left to the tick's reopen fence. One statement, not
// read-then-update: a burst joining the row in between would raise its `atMessageId` past the boundary.
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

// Retires PENDING and CLAIMED rows under one dedupe key, for commands like /reset where the claimed
// row is the run about to post at the customer. The row survives (its key is reusable), unlike in
// `revokeJobsByKeyPrefixOn`. Two marks: `cancelledAt` is what `jobRetired` reads, but a re-arm replaces
// the payload; the `claim_seq` bump survives that and also fences the run's final CAS. One atomic
// statement, unconditional over arm time: a caller that must spare later work runs it before its slow
// steps. DEAD rows keep their dead-letter (cancelThreadAppointmentReminders cannot use this fence:
// there `cancelledAt` also marks the appointment cancelled).
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

// The same retirement on the caller's connection. Inside the caller's transaction the UPDATE holds
// the key's row lock until commit, so a concurrent arm lands after the retirement, which the mirror's
// episode release needs. `keepEpisode` spares the named episode's own work, since the key names the
// conversation and outlives any one episode; a payload with no `originDisplayId` counts as a previous
// episode's.
export async function retireJobsByDedupeKeyOn(
  db: ScopedDb,
  tenantId: bigint,
  kind: SchedulerJobKind,
  dedupeKey: string,
  keepEpisode?: { originDisplayId: number | null },
): Promise<number> {
  const stamp = JSON.stringify({ cancelledAt: new Date().toISOString() });
  // A cleared pairing names the episode `null`, which is a real episode with work of its own,
  // distinct from no `keepEpisode` at all (which retires everything).
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
  // The connection to read on, when the caller already holds one. From inside a transaction, opening a
  // second connection stalls on an exhausted pool while holding the lock (`DB_POOL_MAX=1` is supported).
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

// Whether this run was called off on purpose (a /reset, a customer reply ending the episode): the
// retirement tombstone is on the row. For a caller that already knows its token moved (its CAS failed).
// Unreadable answers no, so the caller reports rather than stays quiet about a possible loss.
export async function jobCancelledOnPurpose(
  job: ClaimedJob,
  base: PrismaClient = basePrisma,
): Promise<boolean> {
  const row = await readJobRetirement(job, base).catch(() => null);
  return (
    (row?.payload as { cancelledAt?: unknown } | null)?.cancelledAt != null
  );
}

// `jobRetired` without the lenient guess, for the thread's critical section: there a wrong "still
// wanted" recreates the graph state /reset just cleared, before any CAS fences it. A failed read
// propagates, sending the job through the scheduler's bounded retry (worker.ts `fail`).
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

// The same question as a SQL predicate, for a write whose condition must be evaluated by the writing
// statement itself: the command it races retires, then clears what the write would restore, so any
// read/act pair can be split between them. Kept beside `isRetired`: tests/modules/scheduler.test.ts
// asserts the two agree on every row state, including an absent row (not retired).
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

// Payload key naming the claim whose death was announced. A missing row cannot say whether its death
// was announced (the revoke deletes DEAD INGEST_MESSAGE rows, a later successful attempt deletes it
// too), so the two announcers, the dead-letter line and the revoke, race to stamp the row, serialized
// on its row lock: whoever stamps first announces. It names the claim rather than being a flag, since
// a re-arm without a payload keeps the stamp and a later death of the same row must still be announced.
// See docs/logs.md.
export const DEAD_LETTER_ANNOUNCED = "deadLetterAnnouncedFor";

// The reaper's road to DEAD writes no `last_error` (a crashed claim never reaches `failJob`, which
// always writes one), so a DEAD row with NULL came from the reaper. Shared by `announceReaped`
// (./worker.ts) and the revoke, which has only the row. Derived rather than stored on the row, since
// rows already DEAD carry NULL and still need a non-blank line.
export const REAPED_DEATH_ERROR = "reaped: the claim never finished";

// The other empty: `failJob` with an empty or whitespace-only error writes ''. That claim finished and
// failed, so it must not read as REAPED_DEATH_ERROR. NULL is the reaper, '' is this.
export const UNRECORDED_DEATH_ERROR =
  "dead-lettered: the failure recorded no message";

// The announcer's claim on the dead-letter line: `true` means this call owns the line and must write
// it; `false` (row moved on, re-armed, or already announced) means silence. DEAD for THIS claim, since
// a later death of the same row announces itself. `updated_at` stays: announcing is not a transition.
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

// A death whose row was erased before anyone announced it, handed back rather than announced inside
// the caller's transaction: a line emitted there survives a rollback that restores the DEAD row
// unmarked, and the next announcer would write it again. The caller announces once its write is
// durable (`announceErasedDeaths`); tests/modules/scheduler-erased-death-announced.test.ts fences that.
export interface ErasedDeath {
  tenantId: bigint;
  kind: SchedulerJobKind;
  jobId: bigint;
  dedupeKey: string;
  error: string;
  // The transaction that deleted the row (the caller's `xid8`), so the announcement can ask Postgres
  // whether it committed.
  xid: string;
}

export async function announceErasedDeaths(
  deaths: ErasedDeath[],
  base: PrismaClient = basePrisma,
): Promise<void> {
  // NOTE: never throws. This is the announcement's one awaited query, and a pool timeout here would
  // abort the caller's work (for /reset, after memory was already deleted). A trail line that cannot
  // be written is no reason to fail the work it describes (docs/logs.md).
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
  // The deletion is confirmed by the commit log. The caller's own view is unreliable (an aborted
  // block accepts COMMIT and replies ROLLBACK without an error), and an absent row only proves someone
  // deleted it. Only `committed` earns a line: a lost line leaves the death findable, a duplicate
  // cannot be retracted. `in progress` means the caller announced too early. One query per xid,
  // because `pg_xact_status` raises on a future id and one bad id would sink the whole batch.
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
  // And the row must still be gone, since a `ROLLBACK TO SAVEPOINT` can undo the DELETE inside a
  // transaction that commits; each check covers what the other cannot. Known gap: a third actor (a
  // second revoke deleting the restored row) satisfies the row check. It stays closed only while
  // /reset is the sole caller, serialized per thread by `withKeyedQueue` in one process; a second
  // caller or replica reopens it (docs/logs.md).
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

// Revokes PENDING, CLAIMED and (for delete-on-done kinds) DEAD rows under a dedupe key prefix: after a
// memory reset nothing queued against the thread may run. A handler already running learns it by
// re-checking its claimSeq under the lock before its irreversible write (../../graph/ingest-job.ts).
// Takes the caller's scoped connection: /reset holds an advisory lock on it, and a second transaction
// deadlocks when the pool is at its last connection (`DB_POOL_MAX=1` is supported).
export async function revokeJobsByKeyPrefixOn(
  db: ScopedDb,
  kind: SchedulerJobKind,
  prefix: string,
  // Only rows at or below this message id, when given: a customer message arriving while /reset waits
  // arms its own ingestion (armIngest takes no queue) and must survive. Omitted means everything,
  // unlike `cancelPendingJobsByPrefixUpToMessage`: text from before the reset must never land back.
  // Read from the key suffix (`ingest:<thread>:<messageId>`), not `payload.messageId`, which Prisma's
  // JSON filters cannot see when absent; evaluated inside the DELETE, since read-then-delete lets a
  // concurrent arm escape. An unparseable suffix is deleted: only proof of "above" spares a row.
  atOrBelowMessageId?: number,
): Promise<{ count: number; erasedDeaths: ErasedDeath[] }> {
  {
    // No `status` here on purpose: the delete spells its statuses in raw SQL (DEAD included) and
    // the retire overrides them, so a status in this shared shape would decide nothing.
    const where = {
      kind,
      dedupeKey: { startsWith: prefix },
    };
    // NOTE: deleted when the kind is delete-on-done: a revoked ingestion can never reach `completeJob`
    // (no claim matches), so a DONE row would hold the encrypted body forever on a table nothing sweeps.
    if (JOB_DELETE_ON_DONE[kind]) {
      // A deleted DEAD row may be the only record of a death, so this statement returns the
      // deaths nobody announced (see DEAD_LETTER_ANNOUNCED) for the caller to announce after commit.
      // One statement with RETURNING, so no concurrent announcer slips in between. The stamp is tested
      // in RETURNING, not WHERE: a DELETE blocked on the announcer's UPDATE re-evaluates WHERE, and a
      // stamp there would spare the row the reset must erase. `_` and `%` are escaped by hand.
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

// A claim's test-only isolation: one tenant, or the few a test seeded (the claims are cross-tenant, so
// a test of tenants sharing one cannot fence to a single tenant). Unset in production.
export type TenantFence = bigint | readonly bigint[];

// The claim's statement, exported so a test runs the exact SQL the lanes run
// (tests/modules/scheduler-claim-limit.test.ts). A MATERIALIZED CTE, not `id IN (SELECT ... FOR
// UPDATE SKIP LOCKED LIMIT n)`: as a semi-join the subquery can be re-executed per outer row, each run
// skipping what the last one locked, so the claim returns every due row and ignores the LIMIT every
// lane's budget is made of. MATERIALIZED guarantees one evaluation.
export function claimSql(
  lim: number,
  now: Date,
  kindFilter: Prisma.Sql,
  tenantId?: TenantFence,
  excludeIds?: bigint[],
  keyPrefix?: string,
  // Share the slots between tenants instead of oldest-first. Only the debounce lane asks for it.
  share?: boolean,
): Prisma.Sql {
  // The prefix branch (the turn barrier) takes future-dated rows, since a job deferred for a
  // previous turn is exactly what a starting turn is missing, but not rows in failure backoff, or
  // back-to-back turns would burn all attempts in seconds. The two are told apart by `last_error`
  // (a backoff carries its error, a stood-down row does not), not by `attempts`. A row left here is
  // still PENDING, so `countOwedByKeyPrefix` still reports the thread as owing it.
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
  // Shared ranking: each due row ranks by its tenant's rows in flight (`excludeIds` of this
  // lane's kinds) plus its place in that tenant's queue, lowest first, ties to the older row. One
  // tenant's burst queues behind itself; a lone tenant still takes every slot. Ranked without the lock,
  // then locked (Postgres refuses FOR UPDATE with a window function). The lock step repeats every
  // predicate on `s`, because Postgres re-checks only the locked relation's conditions against a row
  // changed since the snapshot.
  const due = share
    ? Prisma.sql`
    inflight AS (
      ${
        excludeIds && excludeIds.length > 0
          ? Prisma.sql`SELECT tenant_id, count(*)::int AS n FROM scheduler_jobs
      WHERE id IN (${Prisma.join(excludeIds)}) AND ${kindFilter} GROUP BY tenant_id`
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
  // Rows this process is already executing. The CAS already stops a stale completion; this stops the
  // same key from being executed twice at once, which for an expensive handler (a summary model call)
  // means paying twice for one result. See src/modules/memory/worker.ts.
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
    >(
      claimSql(
        lim,
        now,
        kindFilter,
        tenantId,
        // NOTE: plus every row whose handler still runs here, including one a deadline already failed
        // back to PENDING (./running.ts).
        [...new Set([...(excludeIds ?? []), ...runningJobIds()])],
        keyPrefix,
        share,
      ),
    );
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

// The main (slow) tick claims everything except debounce, which needs the fast tick to honor the
// per-agent window. `tenantId` is test-only isolation: the claim is cross-tenant, and concurrent
// suites on the shared test database would steal each other's jobs. Unset in production.
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

// The observe lane: OBSERVE only, claimed by the shared tick with its own limit (./lanes.ts,
// observeClaimLimit).
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

// The fast debounce tick claims only debounce jobs. `excludeIds` is the drain's in-flight set
// (../debounce/worker.ts), which the claim also reads to share the slots between tenants.
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

// Who is waiting for a slot of the debounce lane: rows due by `dueBefore` and still PENDING, oldest
// first. Read-only, asked only to announce a wait, so a bounded page is enough (the rest come later).
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

// Terminal success, CAS on the claim's token so a superseded run marks nothing done. Returns whether
// the write landed: a refused CAS is the only evidence the run was superseded, and runClaimed logs it.
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
          // NOTE: `attempts` is cleared as rescheduleJob does: the pass proved the job works, and a
          // permanent dedupeKey would otherwise inherit failures across months. `lastError` stays as
          // part of the DONE record. `payloadSecret` is cleared: a retained row is kept for its key,
          // never its body, which can carry a customer's words.
          data: { status: "DONE", attempts: 0, payloadSecret: null },
        }),
  );
  return { applied: count > 0 };
}

// Not a failure (e.g. out-of-hours): back to PENDING at a new time with `attempts` and `lastError`
// cleared. A cleared error is how the barrier tells a stood-down row from one in backoff (claimSql's
// prefix branch); a cleared budget makes MAX_ATTEMPTS bound consecutive failures, so a
// self-rescheduling job (FLOWLOG_SWEEP, HEARTBEAT) does not die of failures spread over weeks. A
// broken job still dies: its failures are never interleaved with a completed pass. An optional
// `payload` replaces the row's payload (e.g. advancing a follow-up's stepIndex). Returns whether the
// write landed, as completeJob does.
export async function rescheduleJob(
  tenantId: bigint,
  id: bigint,
  claimSeq: number,
  runAt: Date,
  payload?: Record<string, unknown>,
  base: PrismaClient = basePrisma,
  // Merged into the row's current payload (jsonb `||`) inside the CAS instead of replacing it: the
  // reminder cancel stamps `cancelledAt` without bumping the token, and a replacement from the
  // claim-time snapshot would erase that tombstone.
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

// Failure: attempts++, retry with backoff until the cap, then DEAD. The error goes through
// `sanitizeErrorMessage`: a character Postgres refuses would fail the whole transition and leave the
// row CLAIMED, and it keeps credential-shaped text out of the column. `deadLettered` says whether THIS
// call dead-lettered the job; a row re-armed mid-run fails the CAS and survives with another run queued.
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
  // NOTE: `applied` is separate because `deadLettered: false` is also a healthy retry, so the caller
  // could not tell a recorded failure from a refused one.
  return { deadLettered: dead && count > 0, applied: count > 0 };
}

// Takes back a run its deadline failed, so the outcome of the work it committed can be written. Only
// the row exactly as `failJob` left it: PENDING under the same token, with that failure's attempts
// and error (a re-arm keeps the token but clears `last_error`). A dead-lettered row is not taken back.
// `claimed_at` is renewed so the reaper does not take the row before the outcome lands.
export async function reclaimAfterDeadline(
  tenantId: bigint,
  id: bigint,
  claimSeq: number,
  // What the run was claimed with and failed with: the values `failJob` wrote.
  attempts: number,
  error: string,
  base: PrismaClient = basePrisma,
): Promise<{ applied: boolean }> {
  const count = await runScopedOn(
    base,
    sysCtx(tenantId),
    (db) =>
      db.$executeRaw`
        UPDATE scheduler_jobs
           SET status = 'CLAIMED'::"SchedulerJobStatus",
               claimed_at = now(),
               updated_at = now()
         WHERE id = ${id}
           AND tenant_id = ${tenantId}
           AND status = 'PENDING'
           AND claim_seq = ${claimSeq}
           AND attempts = ${attempts + 1}
           AND last_error = ${sanitizeErrorMessage(error)}`,
  );
  return { applied: count > 0 };
}

// Reaper: a CLAIMED row older than `staleMs` is presumed crashed and goes back to PENDING (attempts++
// so poison eventually dies). Cross-tenant; `tenantId` is the same test-only fence as the claim's.
// Returns every row it touched: the reaper is the second road to DEAD, besides `failJob`.
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

// Full-jitter backoff with an exponent clamp. The base is the kind's (lanes.ts).
export function backoffMs(attempt: number, baseMs: number): number {
  const exp = Math.min(attempt, 8);
  const ceiling = baseMs * 2 ** exp;
  // deterministic-ish jitter without Math.random (varies by attempt); good enough for spacing.
  return Math.floor(
    ceiling / 2 + ((ceiling / 2) * ((attempt * 2654435761) % 1000)) / 1000,
  );
}
