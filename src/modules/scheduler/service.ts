import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";

// Durable job store for the scheduler (follow-ups, sweeps, retries). The CLAIM is cross-tenant —
// it must see every tenant's due jobs — so it runs via asSuperAdmin with FOR UPDATE SKIP LOCKED;
// the GUC is transaction-local (set_config(...,true)) so it never leaks to the next request on a
// pooled connection. Each job's EFFECT and status update run under the job's OWN tenant scope
// (runScoped), so RLS still fences the work. `attempts` grows only on failure/crash (a reschedule
// for out-of-hours is free), and the reaper bounds crash loops by pushing exhausted jobs to DEAD.

const MAX_ATTEMPTS = 5;

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
  | "REDIRECT_FOLLOWUP";

export interface ClaimedJob {
  id: bigint;
  tenantId: bigint;
  kind: SchedulerJobKind;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface EnqueueParams {
  tenantId: bigint;
  kind: SchedulerJobKind;
  dedupeKey: string;
  runAt: Date;
  payload?: Record<string, unknown>;
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
): Promise<ClaimedJob[]> {
  const lim = Math.min(Math.max(Math.floor(limit), 1), 100);
  const tenantClause =
    tenantId != null ? Prisma.sql`AND tenant_id = ${tenantId}` : Prisma.empty;
  return asSuperAdminOn(base, async (db) => {
    const rows = await db.$queryRaw<
      Array<{
        id: bigint;
        tenantId: bigint;
        kind: SchedulerJobKind;
        payload: unknown;
        attempts: number;
      }>
    >(Prisma.sql`
      UPDATE scheduler_jobs SET status = 'CLAIMED', claimed_at = ${now}, updated_at = now()
      WHERE id IN (
        SELECT id FROM scheduler_jobs
        WHERE status = 'PENDING' AND run_at <= ${now} AND ${kindFilter}
          ${tenantClause}
        ORDER BY run_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${lim}
      )
      RETURNING id, tenant_id AS "tenantId", kind, payload, attempts`);
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      kind: r.kind,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      attempts: r.attempts,
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
  return claimWhere(limit, base, now, Prisma.sql`kind <> 'DEBOUNCE'`, tenantId);
}

// The fast debounce tick claims ONLY debounce jobs.
export function claimDueDebounceJobs(
  limit: number,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
  tenantId?: bigint,
): Promise<ClaimedJob[]> {
  return claimWhere(limit, base, now, Prisma.sql`kind = 'DEBOUNCE'`, tenantId);
}

// Terminal success.
export async function completeJob(
  tenantId: bigint,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.schedulerJob.updateMany({
      where: { id, status: "CLAIMED" },
      data: { status: "DONE" },
    }),
  );
}

// Not a failure (e.g. out-of-hours): back to PENDING at a new time, attempts UNCHANGED. An optional
// `payload` REPLACES the row's payload (used to advance a multi-step follow-up's stepIndex on the
// same row — the dedupeKey is stable, so this never races the upsert vs the completeJob CAS). Omit
// it to keep the current payload.
export async function rescheduleJob(
  tenantId: bigint,
  id: bigint,
  runAt: Date,
  payload?: Record<string, unknown>,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.schedulerJob.updateMany({
      where: { id, status: "CLAIMED" },
      data: {
        status: "PENDING",
        runAt,
        ...(payload !== undefined
          ? { payload: payload as Prisma.InputJsonValue }
          : {}),
      },
    }),
  );
}

// Failure: attempts++; retry with backoff until the cap, then DEAD.
export async function failJob(
  tenantId: bigint,
  id: bigint,
  attempts: number,
  error: string,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
): Promise<void> {
  const next = attempts + 1;
  const dead = next >= MAX_ATTEMPTS;
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.schedulerJob.updateMany({
      where: { id, status: "CLAIMED" },
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
}

// Reaper: a CLAIMED row older than `staleMs` is presumed crashed → back to PENDING (attempts++ so
// poison eventually dies). Cross-tenant, so asSuperAdmin. `tenantId` is the same test-only fence as
// the claim's: without it, a concurrent suite's reap bumps this run's attempts underneath it.
export async function reapStaleJobs(
  staleMs: number,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
  tenantId?: bigint,
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleMs);
  const tenantClause =
    tenantId != null ? Prisma.sql`AND tenant_id = ${tenantId}` : Prisma.empty;
  return asSuperAdminOn(base, async (db) => {
    const requeued = await db.$executeRaw(Prisma.sql`
      UPDATE scheduler_jobs
      SET status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'DEAD'::"SchedulerJobStatus" ELSE 'PENDING'::"SchedulerJobStatus" END,
          attempts = attempts + 1,
          claimed_at = NULL,
          updated_at = now()
      WHERE status = 'CLAIMED' AND claimed_at < ${cutoff} ${tenantClause}`);
    return requeued;
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
