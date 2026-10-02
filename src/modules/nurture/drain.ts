import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";
import {
  type ClaimedJob,
  enqueueJobUnlessClaimed,
} from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { nurtureStepsSchema } from "./sequences";
import { renderNurtureTemplate } from "./templates";

// The NURTURE_DRAIN lane: one perpetual job row per tenant, self-rescheduling,
// that walks due ACTIVE enrollments and stages each step as a PENDING outbox
// row for an operator to send by hand. The claim is FOR UPDATE SKIP LOCKED
// inside the tenant-scoped transaction, so the whole pass is safe under the
// single-replica rule and the row's own status flip is the fence on retries.

// How far out an idle drain sleeps. A new enrollment nudges the row earlier
// (ensureNurtureDrain below), so a long idle wait never delays real work.
const DRAIN_IDLE_MS = 15 * 60_000;
// One pass's ceiling, against a backfill of due enrollments after an outage:
// the rest waits for the next wake, which is their own next_run_at anyway.
const DRAIN_BATCH = 50;
const DRAIN_DEDUPE_KEY = "nurture-drain";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN", actorType: "system" };
}

export async function drainNurtureEnrollments(params: {
  tenantId: bigint;
  base?: PrismaClient;
  now?: Date;
}): Promise<{ processed: number }> {
  const base = params.base ?? basePrisma;
  const now = params.now ?? new Date();
  const ctx = sysCtx(params.tenantId);
  return runScopedOn(base, ctx, async (db) => {
    // The claim names the ACTIVE sequences too, so a paused sequence's
    // enrollments stay ACTIVE-but-unclaimed (resuming fires them at once)
    // instead of spinning inside every pass.
    const due = await db.$queryRaw<{ id: bigint }[]>`
      SELECT e.id
        FROM nurture_enrollments e
        JOIN nurture_sequences s ON s.id = e.sequence_id AND s.active
       WHERE e.tenant_id = ${params.tenantId}
         AND e.status = 'ACTIVE'::"NurtureEnrollmentStatus"
         AND e.next_run_at <= ${now}
       ORDER BY e.next_run_at
       LIMIT ${DRAIN_BATCH}
       FOR UPDATE OF e SKIP LOCKED`;
    let processed = 0;
    for (const { id } of due) {
      const row = await db.nurtureEnrollment.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          stepIndex: true,
          leadId: true,
          lead: { select: { authorName: true, platform: true } },
          sequence: { select: { steps: true } },
        },
      });
      if (row?.status !== "ACTIVE") continue;
      const parsed = nurtureStepsSchema.safeParse(row.sequence.steps);
      if (!parsed.success) {
        // Writes validate steps, so this is an older or hand-edited row: an
        // enrollment that can never render must not hold the claim open.
        await db.nurtureEnrollment.update({
          where: { id },
          data: { status: "CANCELLED" },
        });
        continue;
      }
      const steps = parsed.data;
      const step = steps[row.stepIndex];
      if (!step) {
        await db.nurtureEnrollment.update({
          where: { id },
          data: { status: "DONE" },
        });
        continue;
      }
      const topMatch = await db.leadProductMatch.findFirst({
        where: { leadId: row.leadId },
        orderBy: { score: "desc" },
        select: { product: { select: { name: true } } },
      });
      const body = renderNurtureTemplate(step.bodyTemplate, {
        name: row.lead.authorName,
        product: topMatch?.product.name ?? null,
        platform: row.lead.platform,
      });
      const outbox = await db.nurtureOutbox.create({
        data: {
          tenantId: params.tenantId,
          enrollmentId: row.id,
          leadId: row.leadId,
          body,
        },
        select: { id: true },
      });
      const nextIndex = row.stepIndex + 1;
      await db.nurtureEnrollment.update({
        where: { id },
        data:
          nextIndex >= steps.length
            ? { status: "DONE" }
            : {
                stepIndex: nextIndex,
                nextRunAt: new Date(
                  now.getTime() + (steps[nextIndex]?.delayMin ?? 0) * 60_000,
                ),
              },
      });
      await auditMutation(db, ctx, {
        action: "nurture_outbox.render",
        target: `nurture_outbox:${outbox.id}`,
        after: {
          enrollmentId: String(row.id),
          leadId: String(row.leadId),
          stepIndex: row.stepIndex,
          channel: step.channel,
        },
      });
      processed++;
    }
    return { processed };
  });
}

// The earliest due step left in the tenant, if any: the drain wakes then
// rather than on a fixed interval, so a step's delayMin is what it says.
async function nextDueAt(
  tenantId: bigint,
  base: PrismaClient,
): Promise<Date | null> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const row = await db.nurtureEnrollment.findFirst({
      where: { status: "ACTIVE", sequence: { active: true } },
      orderBy: { nextRunAt: "asc" },
      select: { nextRunAt: true },
    });
    return row?.nextRunAt ?? null;
  });
}

async function nurtureDrainHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  await drainNurtureEnrollments({ tenantId: job.tenantId, base });
  const next = await nextDueAt(job.tenantId, base);
  const idleAt = new Date(Date.now() + DRAIN_IDLE_MS);
  // Wake at the next due step; sleep long when nothing is armed — a new
  // enrollment nudges the row back early (ensureNurtureDrain).
  const runAt = next && next < idleAt ? next : idleAt;
  return { outcome: "reschedule", runAt };
}

let registered = false;
export function registerNurtureDrainHandler(): void {
  if (registered) return;
  registerJobHandler("NURTURE_DRAIN", nurtureDrainHandler);
  registered = true;
}

// Arms (or nudges) the tenant's perpetual drain row. `same-work` like every
// per-tenant sweep: re-arming is the same unit of work, and clearing its
// failure budget would hand a failing pass fresh attempts on every enroll.
// enqueueJobUnlessClaimed because an in-flight pass must not be re-pended.
export async function ensureNurtureDrain(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJobUnlessClaimed({
    tenantId,
    kind: "NURTURE_DRAIN",
    dedupeKey: DRAIN_DEDUPE_KEY,
    runAt: new Date(Date.now() + 5_000),
    rearm: "same-work",
    base,
  });
}

// Arms the drain for every tenant holding an ACTIVE enrollment (called once at
// boot), the same best-effort-per-tenant discipline as the other boot arms:
// a tenant with nothing enrolled has nothing to drain, and one whose first
// enrollment lands later is armed there (enrollLead).
export async function ensureAllNurtureDrains(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenants = await asSuperAdminOn(base, (db) =>
    db.nurtureEnrollment.findMany({
      where: { status: "ACTIVE" },
      select: { tenantId: true },
      distinct: ["tenantId"],
    }),
  );
  for (const t of tenants) {
    try {
      await ensureNurtureDrain(t.tenantId, base);
    } catch (err) {
      logger.warn(
        { tenantId: String(t.tenantId), err },
        "nurture drain arm failed for tenant; continuing",
      );
    }
  }
}
