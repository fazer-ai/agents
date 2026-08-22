import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import {
  asSuperAdminOn,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import {
  JOB_DELETE_ON_DONE,
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
// (runScoped), so RLS still fences the work. `attempts` grows only on failure/crash (a reschedule
// for out-of-hours is free), and the reaper bounds crash loops by pushing exhausted jobs to DEAD.

const MAX_ATTEMPTS = 5;

// The lane's kinds as a SQL fragment, derived from the one table that assigns them (lanes.ts) rather
// than written out per claim. Three hand-kept literals is how a kind added to the enum ends up in no
// lane at all, or in two: nothing compared them, and the shared lane's was a NOT IN, so forgetting it
// there silently WIDENED that lane. The values are enum members from a compile-time map, never user
// input, so embedding them is safe — same property the literals had.
function laneFilter(
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
  | "INGEST_MESSAGE";

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
  attempts: number;
  // The token this claim holds. Hand it back to completeJob/rescheduleJob/failJob: those three CAS
  // on it, so a run that was superseded while it worked writes nothing (issue #164).
  claimSeq: number;
}

export interface EnqueueParams {
  tenantId: bigint;
  // Written to the dedicated String column, never into `payload`. See ClaimedJob.payloadSecret.
  payloadSecret?: string | null;
  kind: SchedulerJobKind;
  dedupeKey: string;
  runAt: Date;
  payload?: Record<string, unknown>;
  // Start this row's retry budget over. Off by default, because most kinds key their dedupeKey to
  // one unit of work (a conversation's follow-up, a document's ingest) and a re-arm there is the
  // SAME work being retried. A kind whose key is permanent — one row per contact thread, reused by
  // every attendance forever — needs it: without it, four transient failures spread over months make
  // the next attendance dead-letter on its first, and that thread never compacts again.
  resetAttempts?: boolean;
  base?: PrismaClient;
}

// One live row per (tenant, kind, dedupeKey): a re-enqueue re-arms run_at and resets to PENDING.
export async function enqueueJob(params: EnqueueParams): Promise<bigint> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    const row = await db.schedulerJob.upsert({
      where: {
        tenantId_kind_dedupeKey: {
          tenantId: params.tenantId,
          kind: params.kind,
          dedupeKey: params.dedupeKey,
        },
      },
      create: {
        tenantId: params.tenantId,
        kind: params.kind,
        dedupeKey: params.dedupeKey,
        runAt: params.runAt,
        payload: (params.payload ?? {}) as Prisma.InputJsonValue,
        payloadSecret: params.payloadSecret ?? null,
        status: "PENDING",
      },
      update: {
        runAt: params.runAt,
        status: "PENDING",
        lastError: null,
        // Re-arming with a payload is authoritative (the latest enqueue wins) — this resets a stale
        // payload on a reused row, e.g. the follow-up sweep restarting a sequence at step 0 on a row
        // a prior run had advanced to a later step. A payload-less re-enqueue preserves the existing.
        ...(params.payload !== undefined
          ? { payload: params.payload as Prisma.InputJsonValue }
          : {}),
        // Re-armed together with the payload it belongs to: the two halves describe one message, and
        // a re-enqueue that refreshed only the JSON would leave a body from the previous arming.
        ...(params.payload !== undefined
          ? { payloadSecret: params.payloadSecret ?? null }
          : {}),
        ...(params.resetAttempts ? { attempts: 0 } : {}),
      },
      select: { id: true },
    });
    return row.id;
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

// REVOKED, not merely cancelled: PENDING **and** CLAIMED rows under a dedupeKey prefix are retired.
//
// The difference from the two above is deliberate and is the whole reason this exists separately.
// They leave a CLAIMED job to its own gate, because there the work is still wanted and the in-flight
// run is the one doing it. Here the work has been REVOKED — a memory reset means the operator asked
// for everything queued against this thread to stop existing, including the message a job claimed a
// second ago and is holding while it waits on the reset's own lock.
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
): Promise<number> {
  {
    const where = {
      kind,
      // DEAD included, and only for a kind whose rows are deleted. A job that exhausted its retries
      // before the reset is not going to run, but its row still holds the encrypted message body,
      // and nothing sweeps this table — so a reset that left it would confirm "memory cleared" over
      // a stored copy of the conversation.
      status: {
        in: ["PENDING" as const, "CLAIMED" as const, "DEAD" as const],
      },
      dedupeKey: { startsWith: prefix },
    };
    // DELETED where the kind says a finished row leaves nothing behind. Marking it DONE is how the
    // two cancellations above retire a row, and for a reusable key that is exactly right — but a
    // revoked ingestion can never reach `completeJob`, which is where JOB_DELETE_ON_DONE is normally
    // spent, because by then the row is no longer CLAIMED by anyone and the CAS matches nothing. It
    // would sit there forever holding the encrypted message body the reset was asked to erase, on a
    // table nothing sweeps. Reading the same map is what keeps the two answers from drifting.
    if (JOB_DELETE_ON_DONE[kind]) {
      return (await db.schedulerJob.deleteMany({ where })).count;
    }
    // Retired, not deleted, for a reusable key — and a DEAD row is left alone there: marking it DONE
    // would erase the dead-letter the operator may still need to see.
    return (
      await db.schedulerJob.updateMany({
        where: { ...where, status: { in: ["PENDING", "CLAIMED"] } },
        data: { status: "DONE" },
      })
    ).count;
  }
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
  tenantId?: bigint,
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
): Promise<ClaimedJob[]> {
  const lim = Math.min(Math.max(Math.floor(limit), 1), 100);
  const dueClause =
    keyPrefix === undefined
      ? Prisma.sql`AND run_at <= ${now}`
      : Prisma.sql`AND dedupe_key LIKE ${`${keyPrefix}%`}`;
  const tenantClause =
    tenantId != null ? Prisma.sql`AND tenant_id = ${tenantId}` : Prisma.empty;
  const excludeClause =
    excludeIds && excludeIds.length > 0
      ? Prisma.sql`AND id NOT IN (${Prisma.join(excludeIds)})`
      : Prisma.empty;
  return asSuperAdminOn(base, async (db) => {
    const rows = await db.$queryRaw<
      Array<{
        id: bigint;
        tenantId: bigint;
        kind: SchedulerJobKind;
        payload: unknown;
        payloadSecret: string | null;
        attempts: number;
        claimSeq: number;
      }>
    >(Prisma.sql`
      UPDATE scheduler_jobs
      SET status = 'CLAIMED', claim_seq = claim_seq + 1, claimed_at = ${now}, updated_at = now()
      WHERE id IN (
        SELECT id FROM scheduler_jobs
        WHERE status = 'PENDING' ${dueClause} AND ${kindFilter}
          ${tenantClause} ${excludeClause}
        ORDER BY run_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${lim}
      )
      RETURNING id, tenant_id AS "tenantId", kind, payload,
                payload_secret AS "payloadSecret", attempts, claim_seq AS "claimSeq"`);
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      kind: r.kind,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      payloadSecret: r.payloadSecret,
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

// The fast debounce tick claims ONLY debounce jobs.
export function claimDueDebounceJobs(
  limit: number,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
  tenantId?: bigint,
): Promise<ClaimedJob[]> {
  return claimWhere(limit, base, now, laneFilter("debounce"), tenantId);
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
          data: { status: "DONE" },
        }),
  );
  return { applied: count > 0 };
}

// Not a failure (e.g. out-of-hours): back to PENDING at a new time, attempts UNCHANGED. An optional
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
): Promise<{ applied: boolean }> {
  const { count } = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.schedulerJob.updateMany({
      where: { id, status: "CLAIMED", claimSeq },
      data: {
        status: "PENDING",
        runAt,
        ...(payload !== undefined
          ? { payload: payload as Prisma.InputJsonValue }
          : {}),
      },
    }),
  );
  return { applied: count > 0 };
}

// Failure: attempts++; retry with backoff until the cap, then DEAD.
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
        ? { status: "DEAD", attempts: next, lastError: error.slice(0, 500) }
        : {
            status: "PENDING",
            attempts: next,
            runAt: new Date(now.getTime() + backoffMs(next)),
            lastError: error.slice(0, 500),
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
    tenantId != null ? Prisma.sql`AND tenant_id = ${tenantId}` : Prisma.empty;
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
      RETURNING id, tenant_id, kind, payload, payload_secret, attempts, claim_seq, status`);
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      kind: r.kind as ClaimedJob["kind"],
      payload: (r.payload ?? {}) as ClaimedJob["payload"],
      payloadSecret: r.payload_secret,
      attempts: r.attempts,
      claimSeq: r.claim_seq,
      status: r.status,
    }));
  });
}

// Full-jitter backoff with an exponent clamp (base 2s).
function backoffMs(attempt: number): number {
  const exp = Math.min(attempt, 8);
  const ceiling = 2_000 * 2 ** exp;
  // deterministic-ish jitter without Math.random (varies by attempt); good enough for spacing.
  return Math.floor(
    ceiling / 2 + ((ceiling / 2) * ((attempt * 2654435761) % 1000)) / 1000,
  );
}
