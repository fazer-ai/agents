import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import { sanitizeErrorMessage } from "@/lib/redact";
import {
  asSuperAdminOn,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";
import { emitDeadLetter } from "@/modules/flowlog/dead-letter";
import { resolveVaultSecret } from "@/modules/vault/service";
import { sysCtx } from "./shared";
import { type OutreachSendInput, sendOutreach } from "./transports";

// The send pipeline the outreach worker drives for each claimed job:
//   claim (cross-tenant, FOR UPDATE SKIP LOCKED, APPROVED + ACTIVE account only)
//     -> reserve the account slot + read the credential (tenant-scoped tx)
//     -> transport send OUTSIDE any transaction (no network I/O in a scoped tx)
//     -> finalize (tenant-scoped tx): SENT / READY_FOR_MANUAL / retry / FAILED
// The slot reservation is one guarded UPDATE on the account row: day-reset, dailyCap and
// cooldownMin are all checked in the WHERE, so concurrent claims serialize on the row lock
// and cannot overspend the cap. A failed send releases the slot but keeps last_sent_at.

const MAX_ATTEMPTS = 3;
const MAX_ERROR_LEN = 500;
const MIN_DEFER_MS = 60_000;

export interface ClaimedOutreachJob {
  id: bigint;
  tenantId: bigint;
  accountId: bigint;
  leadId: bigint;
  kind: OutreachSendInput["job"]["kind"];
  body: string;
  attempts: number;
}

export interface OutreachBatchSummary {
  reaped: number;
  claimed: number;
  sent: number;
  readyForManual: number;
  deferred: number;
  retried: number;
  failed: number;
}

export type DeliverOutcome =
  | "sent"
  | "ready_for_manual"
  | "deferred"
  | "retried"
  | "failed";

function errMsg(err: unknown): string {
  return sanitizeErrorMessage(err, MAX_ERROR_LEN);
}

// ── claim ────────────────────────────────────────────────────────────────────

// Claims due APPROVED jobs cross-tenant, flipping them to SENDING inside the
// same statement (the UPDATE ... FROM picked pattern the outbound worker uses).
// The join on outreach_accounts means a PAUSED or BANNED account's jobs are
// never claimed at all; they stay APPROVED and resurface when the account is
// resumed. QUEUED rows are structurally unreachable here - approval is the
// only door.
export async function claimDueOutreachJobs(
  base: PrismaClient,
  limit: number,
  tenantId?: bigint,
): Promise<ClaimedOutreachJob[]> {
  const tenantClause =
    tenantId != null
      ? Prisma.sql`AND j2.tenant_id = ${tenantId}`
      : Prisma.empty;
  const lim = Math.min(Math.max(Math.floor(limit), 1), 100);
  return asSuperAdminOn(
    base,
    (db) => db.$queryRaw<ClaimedOutreachJob[]>`
      UPDATE outreach_jobs AS j
      SET status = 'SENDING', updated_at = now() AT TIME ZONE 'UTC'
      FROM (
        SELECT j2.id
        FROM outreach_jobs j2
        JOIN outreach_accounts a2 ON a2.id = j2.account_id
        WHERE j2.status = 'APPROVED'
          AND j2.scheduled_at <= now() AT TIME ZONE 'UTC'
          AND a2.status = 'ACTIVE'
          ${tenantClause}
        ORDER BY j2.scheduled_at, j2.id
        FOR UPDATE OF j2 SKIP LOCKED
        LIMIT ${lim}
      ) picked
      WHERE j.id = picked.id
      RETURNING
        j.id,
        j.tenant_id   AS "tenantId",
        j.account_id  AS "accountId",
        j.lead_id     AS "leadId",
        j.kind,
        j.body,
        j.attempts
    `,
  );
}

const STALE_SENDING_ERROR =
  "worker stopped mid-send; delivery is unknown - check the account before requeueing";

// A claimed row whose owner crashed mid-send is NOT rearmed automatically:
// whether the platform received that attempt is unknowable, and a duplicate
// outreach message is a worse outcome than a dropped one. The row goes FAILED
// with a note saying so, and the operator decides (requeue) once they have
// checked the account. The reserved slot is released for the same reason the
// ordinary failure path releases it.
export async function reapStaleSending(
  base: PrismaClient,
  staleMs: number,
  tenantId?: bigint,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const stale = await asSuperAdminOn(base, (db) =>
    db.outreachJob.findMany({
      where: {
        status: "SENDING",
        updatedAt: { lt: cutoff },
        ...(tenantId != null ? { tenantId } : {}),
      },
      select: { id: true, tenantId: true, accountId: true },
    }),
  );
  for (const job of stale) {
    const failed = await runScopedOn(base, sysCtx(job.tenantId), async (db) => {
      await releaseAccountSlot(db, job.accountId);
      const res = await db.outreachJob.updateMany({
        where: { id: job.id, status: "SENDING" },
        data: { status: "FAILED", error: STALE_SENDING_ERROR },
      });
      return res.count > 0;
    });
    if (failed) {
      // `error`, not `warn`: the send may have landed and the row cannot say.
      // Emitted after the write commits so the line never announces a death
      // the row then rolled back.
      emitDeadLetter({
        tenantId: job.tenantId,
        unit: "outreach_job",
        level: "error",
        error: STALE_SENDING_ERROR,
        detail: {
          jobId: String(job.id),
          accountId: String(job.accountId),
        },
        base,
      });
    }
  }
  return stale.length;
}

// ── slot reservation ─────────────────────────────────────────────────────────

interface SlotAccount {
  id: bigint;
  platform: string;
  handle: string;
  transport: string;
  credentialRef: string | null;
  dailyCap: number;
  cooldownMin: number;
  lastSentAt: Date | null;
  status: string;
}

// The ONE atomic rate gate: resets the daily counter when its UTC day rolled
// over, refuses when the account is not ACTIVE, when the cap is already spent,
// or while the cooldown since the last send attempt is still running.
// RETURNING nothing means "not sendable right now" - the caller reads the row
// for the reason.
async function consumeAccountSlot(
  db: ScopedDb,
  accountId: bigint,
): Promise<SlotAccount[]> {
  return db.$queryRaw<SlotAccount[]>`
    UPDATE outreach_accounts
    SET sent_today = CASE
          WHEN sent_today_date = (now() AT TIME ZONE 'UTC')::date THEN sent_today + 1
          ELSE 1
        END,
        sent_today_date = (now() AT TIME ZONE 'UTC')::date,
        last_sent_at = now() AT TIME ZONE 'UTC',
        updated_at = now() AT TIME ZONE 'UTC'
    WHERE id = ${accountId}
      AND status = 'ACTIVE'
      AND (sent_today_date IS NULL
           OR sent_today_date < (now() AT TIME ZONE 'UTC')::date
           OR sent_today < daily_cap)
      AND (last_sent_at IS NULL
           OR last_sent_at <= (now() AT TIME ZONE 'UTC') - (cooldown_min * interval '1 minute'))
    RETURNING id, platform, handle, transport,
              credential_ref AS "credentialRef",
              daily_cap      AS "dailyCap",
              cooldown_min   AS "cooldownMin",
              last_sent_at   AS "lastSentAt",
              status
  `;
}

// Give a reserved slot back after a send that never reached the platform. The
// sent_today_date guard keeps this from eating into a fresh day if the attempt
// straddled midnight UTC; the counter on a past date is already dead weight.
async function releaseAccountSlot(
  db: ScopedDb,
  accountId: bigint,
): Promise<void> {
  await db.$executeRaw`
    UPDATE outreach_accounts
    SET sent_today = GREATEST(sent_today - 1, 0), updated_at = now() AT TIME ZONE 'UTC'
    WHERE id = ${accountId}
      AND sent_today_date = (now() AT TIME ZONE 'UTC')::date
      AND sent_today > 0
  `;
}

// Where a refused slot sends the job back to: APPROVED with the earliest
// scheduledAt at which the block can be over. Not ACTIVE needs no deferral at
// all - the claim's ACTIVE join already holds it - but the row gets bumped a
// little anyway so it does not churn on every tick while paused.
function deferUntil(account: SlotAccount, now: Date): Date {
  const floor = new Date(now.getTime() + MIN_DEFER_MS);
  if (account.status !== "ACTIVE") return floor;
  // Cooldown still running: wake when it ends.
  if (
    account.lastSentAt &&
    account.lastSentAt.getTime() + account.cooldownMin * 60_000 > now.getTime()
  ) {
    return new Date(
      Math.max(
        account.lastSentAt.getTime() + account.cooldownMin * 60_000,
        floor.getTime(),
      ),
    );
  }
  // Only the cap remains: the counter resets at the next UTC day boundary.
  const tomorrowUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return tomorrowUtc > floor ? tomorrowUtc : floor;
}

// ── finalize ─────────────────────────────────────────────────────────────────

// The successful-send effects shared by the worker's transport path and the
// operator's mark-sent: the lead moves NEW -> CONTACTED (never a downgrade of
// QUALIFIED/CONVERTED) and the audit event is written. The job's own status /
// sentAt write is the caller's, because the two paths take it differently.
export async function recordJobSent(
  db: ScopedDb,
  ctx: TenantContext,
  job: { id: bigint; accountId: bigint; leadId: bigint },
): Promise<void> {
  await db.lead.updateMany({
    where: { id: job.leadId, status: "NEW" },
    data: { status: "CONTACTED" },
  });
  await auditMutation(db, ctx, {
    action: "outreach.sent",
    target: `outreach_job:${String(job.id)}`,
    after: {
      accountId: String(job.accountId),
      leadId: String(job.leadId),
    },
  });
}

// Retry bookkeeping: under the attempt budget the job goes back to APPROVED
// with a capped backoff; at the budget it is FAILED terminal (requeue is an
// operator decision through the REST surface).
async function recordFailure(
  db: ScopedDb,
  job: ClaimedOutreachJob,
  error: string,
  now: Date,
): Promise<"retried" | "failed"> {
  const attempts = job.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await db.outreachJob.update({
      where: { id: job.id },
      data: { status: "FAILED", attempts, error },
    });
    return "failed";
  }
  // Capped exponential backoff with half jitter - a down bridge gets breathing
  // room, and a burst of failures does not stampede it on retry.
  const backoff =
    Math.min(5 * 60_000 * 2 ** (attempts - 1), 30 * 60_000) *
    (0.5 + Math.random() / 2);
  await db.outreachJob.update({
    where: { id: job.id },
    data: {
      status: "APPROVED",
      attempts,
      error,
      scheduledAt: new Date(now.getTime() + backoff),
    },
  });
  return "retried";
}

// What a claim is left as when the slot cannot be taken (cap, cooldown, or an
// account that flipped to PAUSED/BANNED between the claim join and the
// reservation): back to APPROVED, due when the block can be over.
async function deferJob(
  db: ScopedDb,
  job: ClaimedOutreachJob,
  runAt: Date,
): Promise<void> {
  await db.outreachJob.update({
    where: { id: job.id },
    data: { status: "APPROVED", scheduledAt: runAt },
  });
}

// ── one claimed job ──────────────────────────────────────────────────────────

interface Prepared {
  account: SlotAccount;
  lead: {
    authorName: string;
    authorHandle: string | null;
    sourceUrl: string | null;
  };
  credential: unknown;
}

type PhaseOne =
  | { outcome: "failed"; error: string }
  | { outcome: "deferred" }
  | { outcome: "send"; prepared: Prepared };

function deadJobDetail(job: ClaimedOutreachJob): Record<string, unknown> {
  return { jobId: String(job.id), accountId: String(job.accountId) };
}

export async function deliverOutreachJob(
  base: PrismaClient,
  job: ClaimedOutreachJob,
  opts: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<DeliverOutcome> {
  const now = opts.now ?? new Date();
  const ctx = sysCtx(job.tenantId);

  // Phase 1 (scoped tx, no network): reserve the account slot and gather what
  // the send needs. A refusal inside here writes the job's new state in the
  // same transaction and returns the outcome.
  const phaseOne: PhaseOne = await runScopedOn(base, ctx, async (db) => {
    const account = await db.outreachAccount.findUnique({
      where: { id: job.accountId },
      select: {
        id: true,
        platform: true,
        handle: true,
        transport: true,
        credentialRef: true,
        dailyCap: true,
        cooldownMin: true,
        lastSentAt: true,
        status: true,
      },
    });
    if (!account) {
      const error = "account removed";
      await db.outreachJob.update({
        where: { id: job.id },
        data: { status: "FAILED", error },
      });
      return { outcome: "failed", error };
    }
    const slots = await consumeAccountSlot(db, job.accountId);
    if (slots.length === 0) {
      await deferJob(db, job, deferUntil(account, now));
      return { outcome: "deferred" };
    }
    const lead = await db.lead.findUnique({
      where: { id: job.leadId },
      select: { authorName: true, authorHandle: true, sourceUrl: true },
    });
    if (!lead) {
      const error = "lead removed";
      await releaseAccountSlot(db, job.accountId);
      await db.outreachJob.update({
        where: { id: job.id },
        data: { status: "FAILED", error },
      });
      return { outcome: "failed", error };
    }
    const slotAccount = slots[0];
    if (!slotAccount) {
      // consumeAccountSlot returned a row and then did not - unreachable in
      // practice, but the type cannot prove it. Defer rather than crash.
      await deferJob(db, job, deferUntil(account, now));
      return { outcome: "deferred" };
    }
    let credential: unknown = null;
    if (slotAccount.credentialRef) {
      try {
        credential = await resolveVaultSecret(db, slotAccount.credentialRef);
      } catch (err) {
        // A credential that does not resolve is a config problem, not a retry:
        // failed once, the operator fixes the entry and requeues.
        const error = `credential unresolved: ${errMsg(err)}`;
        await releaseAccountSlot(db, job.accountId);
        await db.outreachJob.update({
          where: { id: job.id },
          data: { status: "FAILED", error },
        });
        return { outcome: "failed", error };
      }
    }
    return {
      outcome: "send",
      prepared: { account: slotAccount, lead, credential },
    };
  });

  if (phaseOne.outcome === "failed") {
    // Every terminal write in this function owes a dead_letter line. `warn`,
    // not `error`: the Jobs page lists the FAILED row with its reason and a
    // Requeue action - the operator's way back. Emitted after the committing
    // transaction so the line never announces a death the row rolled back.
    emitDeadLetter({
      tenantId: job.tenantId,
      unit: "outreach_job",
      level: "warn",
      error: phaseOne.error,
      detail: deadJobDetail(job),
      base,
    });
    return "failed";
  }
  if (phaseOne.outcome === "deferred") return "deferred";
  const { account, lead, credential } = phaseOne.prepared;

  // Phase 2: the transport call, deliberately outside any transaction. A
  // thrown error is a retryable failure; the outcome drives phase 3.
  let sendResult:
    | { ok: true; outcome: "sent" | "ready_for_manual" }
    | { ok: false; error: string };
  try {
    sendResult = {
      ok: true,
      outcome: await sendOutreach({
        account,
        job: { id: job.id, kind: job.kind, body: job.body },
        lead,
        credential,
        fetchImpl: opts.fetchImpl,
      }),
    };
  } catch (err) {
    sendResult = { ok: false, error: errMsg(err) };
  }
  const sendError = sendResult.ok ? null : sendResult.error;

  // Phase 3 (scoped tx): record the outcome.
  const outcome = await runScopedOn(base, ctx, async (db) => {
    if (!sendResult.ok) {
      await releaseAccountSlot(db, job.accountId);
      return recordFailure(db, job, sendResult.error, now);
    }
    if (sendResult.outcome === "ready_for_manual") {
      // The account's slot stays consumed: the send is owed to a human now,
      // and the queue budget counts it from this moment.
      await db.outreachJob.update({
        where: { id: job.id },
        data: { status: "READY_FOR_MANUAL", error: null },
      });
      return "ready_for_manual" as const;
    }
    await db.outreachJob.update({
      where: { id: job.id },
      data: { status: "SENT", sentAt: new Date(), error: null },
    });
    await recordJobSent(db, ctx, job);
    return "sent" as const;
  });
  if (outcome === "failed") {
    emitDeadLetter({
      tenantId: job.tenantId,
      unit: "outreach_job",
      level: "warn",
      error: sendError ?? "retry budget exhausted",
      detail: deadJobDetail(job),
      base,
    });
  }
  return outcome;
}
