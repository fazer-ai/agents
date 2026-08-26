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
  | "INGEST_MESSAGE"
  | "DELIVERY_SWEEP"
  | "DELIVERY_RECOVERY";

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
export type Rearm = "new-work" | "same-work";

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

// The ONE place a scheduler_jobs row comes into existence, and the reason it takes a ScopedDb rather
// than being folded into enqueueJob: armDebounce has to write inside its own advisory-lock
// transaction, so it cannot call something that opens a second one. It used to hand-copy this block
// instead, which is exactly how DEBOUNCE ended up with no answer to the `rearm` question at all.
// tests/modules/scheduler-row-writers.test.ts is the fence that keeps a third copy from appearing.
export async function upsertJobRow(
  db: ScopedDb,
  params: JobRowParams,
): Promise<bigint> {
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
    select: { id: true },
  });
  return row.id;
}

// One live row per (tenant, kind, dedupeKey): a re-enqueue re-arms run_at and resets to PENDING.
export async function enqueueJob(params: EnqueueParams): Promise<bigint> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, sysCtx(params.tenantId), (db) =>
    upsertJobRow(db, params),
  );
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
        dedupeKey: string;
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
                payload_secret AS "payloadSecret", dedupe_key AS "dedupeKey",
                attempts, claim_seq AS "claimSeq"`);
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
          data: { status: "DONE", attempts: 0 },
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
            runAt: new Date(now.getTime() + backoffMs(next)),
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

// Full-jitter backoff with an exponent clamp (base 2s).
function backoffMs(attempt: number): number {
  const exp = Math.min(attempt, 8);
  const ceiling = 2_000 * 2 ** exp;
  // deterministic-ish jitter without Math.random (varies by attempt); good enough for spacing.
  return Math.floor(
    ceiling / 2 + ((ceiling / 2) * ((attempt * 2654435761) % 1000)) / 1000,
  );
}
