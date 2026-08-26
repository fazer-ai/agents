import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type ClaimedJob,
  cancelPendingJob,
  enqueueJob,
} from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { emitOutbound } from "./service";

// Periodic emitter for the `heartbeat` outbound event (a liveness ping a monitor subscribes to).
// It rides the existing scheduler — NOT a wall-clock cron — via a single self-re-arming SchedulerJob
// per tenant (dedupeKey constant, so the unique(tenantId, kind, dedupeKey) constraint guarantees AT
// MOST ONE row per tenant regardless of how many heartbeat subscriptions exist). The job is armed
// LAZILY (only while the tenant has an enabled `heartbeat` subscription) and self-terminates when the
// last one is gone, so an unsubscribed tenant carries no job: 0 subs → 0 jobs, 1..N subs → 1 job.

const HEARTBEAT_DEDUPE_KEY = "heartbeat";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Arms (or re-arms) the single per-tenant heartbeat job. Idempotent — enqueueJob upserts on
// (tenant, kind, dedupeKey), so calling this for the 2nd..Nth subscription keeps exactly one row.
async function ensureTenantHeartbeat(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "HEARTBEAT",
    dedupeKey: HEARTBEAT_DEDUPE_KEY,
    // NOTE: One perpetual row per tenant, re-armed by every subscription mutation. Reconciliation
    // is not new work: a heartbeat that keeps failing would otherwise get five fresh attempts each
    // time a subscription is toggled. A pass that ran clears the count on its own.
    rearm: "same-work",
    runAt: new Date(Date.now() + config.heartbeat.intervalMs),
    base,
  });
}

// Reconciles the per-tenant heartbeat job against the current subscription state. Called after every
// subscription mutation: arm if any enabled `heartbeat` subscription remains, else cancel the pending
// job (the handler also self-terminates as a backstop for an already-CLAIMED job). Best-effort: a
// failure here never blocks the subscription write (mirrors emitOutbound's best-effort call sites).
export async function syncTenantHeartbeat(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  try {
    const active = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.webhookSubscription.count({
        where: { enabled: true, events: { has: "heartbeat" } },
      }),
    );
    if (active > 0) {
      await ensureTenantHeartbeat(tenantId, base);
    } else {
      await cancelPendingJob(tenantId, "HEARTBEAT", HEARTBEAT_DEDUPE_KEY, base);
    }
  } catch (err) {
    logger.warn(
      { err, tenantId: String(tenantId) },
      "failed to sync heartbeat scheduler job",
    );
  }
}

// Emits one heartbeat and decides the job's fate in a single query: emitOutbound returns the number
// of matched (enabled) subscriptions, so 0 means the last subscriber is gone → let the job die; >0 →
// re-arm for the next interval. occurred_at is already stamped in the envelope; `version` lets a
// liveness monitor see the running build.
export async function heartbeatHandler(
  job: ClaimedJob,
  base: PrismaClient = basePrisma,
): Promise<JobResult> {
  const tenantId = job.tenantId;
  const matched = await runScopedOn(base, sysCtx(tenantId), (db) =>
    emitOutbound(db, tenantId, "heartbeat", {
      at: new Date().toISOString(),
      version: config.packageInfo.version,
    }),
  );
  if (matched === 0) return { outcome: "done" };
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + config.heartbeat.intervalMs),
  };
}

let registered = false;
export function registerHeartbeatHandler(): void {
  if (registered) return;
  registerJobHandler("HEARTBEAT", heartbeatHandler);
  registered = true;
}
