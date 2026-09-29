import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type ClaimedJob,
  enqueueJob,
  upsertJobRows,
} from "@/modules/scheduler/service";
import {
  type JobContext,
  type JobResult,
  registerJobHandler,
} from "@/modules/scheduler/worker";
import {
  PROCESSING_STALE_MS,
  type ProcessDeps,
  processInboundDelivery,
} from "./service";

// Brings back inbound deliveries stranded between the ack and the dispatch: the sender holds a 2xx
// and will not resend. The sweep only ARMS one INBOUND_REDISPATCH per stranded row (the work can run
// an agent turn, ../../scheduler/lanes.ts), and that job calls the same processor the route calls,
// whose compare-and-set claim takes the row at most once. Full contract in docs/integrations.md.

// Cadence of the sweep: a row waits PROCESSING_STALE_MS plus up to one interval. A pass reads a
// partial index over the unfinished rows only, so a short interval costs next to nothing.
const SWEEP_INTERVAL_MS = 2 * 60_000;
// One pass's ceiling, against a pathological backlog (a long outage of the database under steady
// traffic). The rest waits one interval; rows already armed are not counted against it.
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
  const cutoff = new Date(now - PROCESSING_STALE_MS);
  return runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    // ONE STATEMENT, with the already-armed exclusion before the LIMIT: a row whose
    // re-dispatch died stays stranded, and filtered afterwards enough of them would fill every pass.
    // The stranded rule is `staleClaim` (./service.ts) and the key is `redispatchKey`, both restated
    // in SQL; tests/modules/inbound-sweep.test.ts pins them.
    const rows = await db.$queryRaw<{ id: bigint; attempts: number }[]>`
      SELECT d.id, d.attempts
        FROM inbound_deliveries d
       WHERE d.tenant_id = ${params.tenantId}
         AND (
               (d.status = 'PENDING' AND d.received_at < ${cutoff})
            OR (d.status = 'PROCESSING'
                AND (d.claimed_at < ${cutoff}
                     OR (d.claimed_at IS NULL AND d.received_at < ${cutoff})))
         )
         AND NOT EXISTS (
               SELECT 1 FROM scheduler_jobs j
                WHERE j.tenant_id = d.tenant_id
                  AND j.kind = 'INBOUND_REDISPATCH'
                  AND j.dedupe_key = 'inbound-delivery:' || d.id || ':' || d.attempts
         )
       ORDER BY d.id
       LIMIT ${BATCH}`;
    // One statement for the arms too: a row at a time is a round trip each inside a transaction with
    // a five-second budget, and a backlog big enough to need this sweep is the one that would blow
    // it. `once`, so a concurrent pass (another replica) that armed the same key first wins and this
    // one changes nothing.
    const armed = await upsertJobRows(db, {
      tenantId: params.tenantId,
      kind: "INBOUND_REDISPATCH",
      rearm: "once",
      runAt: new Date(now),
      rows: rows.map((r) => ({
        dedupeKey: redispatchKey(r.id, r.attempts),
        payload: { deliveryId: String(r.id) },
      })),
    });
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

// The re-dispatch itself, apart from its registration so a test can hand it a fake nudge (`deps`) and
// see the deadline arrive where the turn runs.
export async function redispatchInbound(
  job: ClaimedJob,
  base: PrismaClient,
  ctx?: JobContext,
  deps?: ProcessDeps,
): Promise<JobResult> {
  const deliveryId = parseDbId(
    typeof job.payload.deliveryId === "string" ? job.payload.deliveryId : null,
  );
  // Only the sweep writes this payload, so a malformed one is a bug and not a transient: retrying it
  // would change nothing, and failing it is what puts it on the dead-letter line.
  if (deliveryId === null) {
    return { outcome: "fail", error: "inbound redispatch: no delivery id" };
  }
  // NOTE: A throw propagates on purpose: the scheduler's retry ladder is what outlasts the outage
  // that made the dispatch throw, and its dead-letter line is what says the event was lost when it
  // does not. The run's signal goes down to the nudge turn: a turn past the deadline would
  // otherwise keep going beside the next attempt the sweep arms once the claim goes stale.
  await processInboundDelivery({
    deliveryId,
    tenantId: job.tenantId,
    base,
    signal: ctx?.signal,
    deps,
  });
  return { outcome: "done" };
}

async function inboundRedispatchHandler(
  job: ClaimedJob,
  base: PrismaClient,
  ctx?: JobContext,
): Promise<JobResult> {
  return redispatchInbound(job, base, ctx);
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
