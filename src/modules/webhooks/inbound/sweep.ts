import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type ClaimedJob,
  enqueueJob,
  upsertJobRow,
} from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import {
  PROCESSING_STALE_MS,
  processInboundDelivery,
  staleClaim,
} from "./service";

// Brings back inbound deliveries stranded between the ack and the dispatch (issue #817).
//
// The receptor acks the sender first and dispatches afterwards, detached, so a process that dies in
// between, or a dispatch whose transaction rolls back, leaves the row PENDING or PROCESSING with the
// sender holding a 2xx and no reason to send it again. Before this, only a redelivery from the
// sender ever called `processInboundDelivery` a second time.
//
// Two kinds, the same split as DELIVERY_SWEEP and DELIVERY_RECOVERY and for the same reason
// (../../scheduler/lanes.ts): the sweep is one indexed query per tenant, and the work it finds can
// run an agent turn. So the sweep only ARMS one INBOUND_REDISPATCH per stranded row, and that job
// calls the very processor the route calls. Nothing is re-implemented here: the claim is the
// processor's own compare-and-set, so a re-dispatch racing the route, a redelivery, or another
// re-dispatch takes the row at most once, and the attempt cap and the dead-letter announcement for a
// row that exhausted it are the processor's too.

// Cadence of the sweep, and it is the half of the delay that is ours to choose: a row is only
// stranded once PROCESSING_STALE_MS has passed, and then waits up to one interval more. Two minutes
// because a pass reads a partial index that holds only the unfinished rows (a handful), so a shorter
// wait costs next to nothing, and what waits is a payment or an operator's event the sender will not
// resend.
const SWEEP_INTERVAL_MS = 2 * 60_000;
// One pass's ceiling, against a pathological backlog (a long outage of the database under steady
// traffic). The rest waits one interval.
const BATCH = 200;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// The job that re-dispatches one delivery, keyed by the delivery AND the attempt count the sweep saw.
//
// Armed `once`, so a key that already has a row is left alone whatever state that row is in. The
// attempt count is what makes that the right rule: every claim the processor takes increments it, so
// a delivery that strands AGAIN after a re-dispatch claimed it shows a new count and gets a new job,
// while a delivery whose dispatch throws before anything commits (the claim rolls back with it, count
// unchanged) is not re-armed pass after pass. That one runs out its own job's retries and dies on the
// scheduler's dead-letter line, instead of looping every five minutes forever.
export function redispatchKey(deliveryId: bigint, attempts: number): string {
  return `inbound-delivery:${deliveryId}:${attempts}`;
}

export async function sweepStrandedInbound(params: {
  tenantId: bigint;
  base?: PrismaClient;
  now?: number;
}): Promise<{ armed: number }> {
  const base = params.base ?? basePrisma;
  const now = params.now ?? Date.now();
  // PENDING is measured from receipt, with the same window: the route dispatches within
  // milliseconds of the ack, so a PENDING row that old was never claimed, and taking it any earlier
  // would only race the route (harmless, the claim is a CAS, but pointless). PROCESSING is measured
  // by the processor's own rule, shared rather than restated (`staleClaim`).
  const cutoff = new Date(now - PROCESSING_STALE_MS);
  return runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    const rows = await db.inboundDelivery.findMany({
      where: {
        OR: [
          { status: "PENDING", receivedAt: { lt: cutoff } },
          { status: "PROCESSING", OR: [...staleClaim(now)] },
        ],
      },
      select: { id: true, attempts: true },
      orderBy: { receivedAt: "asc" },
      take: BATCH,
    });
    let armed = 0;
    for (const row of rows) {
      const before = await db.schedulerJob.count({
        where: {
          tenantId: params.tenantId,
          kind: "INBOUND_REDISPATCH",
          dedupeKey: redispatchKey(row.id, row.attempts),
        },
      });
      await upsertJobRow(db, {
        tenantId: params.tenantId,
        kind: "INBOUND_REDISPATCH",
        dedupeKey: redispatchKey(row.id, row.attempts),
        runAt: new Date(now),
        payload: { deliveryId: String(row.id) },
        rearm: "once",
      });
      if (before === 0) armed += 1;
    }
    if (armed > 0) {
      logger.warn(
        "inbound sweep: tenant %s had %d stranded deliveries; re-dispatch armed",
        String(params.tenantId),
        armed,
      );
    }
    return { armed };
  });
}

async function inboundSweepHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  await sweepStrandedInbound({ tenantId: job.tenantId, base });
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
  };
}

async function inboundRedispatchHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const deliveryId = parseDbId(
    typeof job.payload.deliveryId === "string" ? job.payload.deliveryId : null,
  );
  // Only the sweep writes this payload, so a malformed one is a bug and not a transient: retrying it
  // would change nothing, and failing it is what puts it on the dead-letter line.
  if (deliveryId === null) {
    return { outcome: "fail", error: "inbound redispatch: no delivery id" };
  }
  // A throw propagates on purpose: the scheduler's retry ladder is what outlasts the outage that made
  // the dispatch throw, and its dead-letter line is what says the event was lost when it does not.
  await processInboundDelivery({ deliveryId, tenantId: job.tenantId, base });
  return { outcome: "done" };
}

let registered = false;
export function registerInboundSweepHandlers(): void {
  if (registered) return;
  registerJobHandler("INBOUND_SWEEP", inboundSweepHandler);
  registerJobHandler("INBOUND_REDISPATCH", inboundRedispatchHandler);
  registered = true;
}

// Arms the tenant's perpetual sweep row. `same-work`, like every per-tenant sweep: a boot or a new
// integration re-arming it is the same unit of work, and clearing its failure count there would hand
// a sweep that keeps failing a fresh budget every time.
export async function ensureInboundSweep(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "INBOUND_SWEEP",
    dedupeKey: "inbound-sweep",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
    rearm: "same-work",
    base,
  });
}

// Arms the sweep for every tenant that can receive an inbound delivery at all, which is a tenant
// holding an instance with a route token (called once at boot). Only those: a tenant with no inbound
// surface has nothing to strand, and a row per tenant would be a query every five minutes for
// nothing. A tenant that creates its first inbound instance later is armed there
// (`createIntegrationInstance`). Best-effort per tenant, like the other boot arms.
export async function ensureAllInboundSweeps(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenants = await asSuperAdminOn(base, (db) =>
    db.integrationInstance.findMany({
      where: { routeTokenHash: { not: null } },
      select: { tenantId: true },
      distinct: ["tenantId"],
    }),
  );
  for (const t of tenants) {
    try {
      await ensureInboundSweep(t.tenantId, base);
    } catch (err) {
      logger.warn(
        { tenantId: String(t.tenantId), err },
        "inbound sweep arm failed for tenant; continuing",
      );
    }
  }
}
