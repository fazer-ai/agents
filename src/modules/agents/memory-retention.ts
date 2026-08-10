import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import {
  asSuperAdminOn,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import { readLimitsConfig } from "@/modules/agents/limits";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";

// Retention sweep for the AGENT MEMORY (the LangGraph checkpointer thread), driven by the per-agent
// `limits.forgetResolvedAfterDays`. One MEMORY_SWEEP job per tenant, armed at boot and self-rearming
// every 24h — same shape as FLOWLOG_SWEEP.
//
// WHY: the graph thread is keyed per contact-inbox and spans every conversation that contact ever
// had on the channel; the agent node sends all of it on every call, and nothing ever dropped the
// finished ones. A contact who came back a handful of times reaches a five-to-six-figure token count
// per turn, paid on every message forever. Forgetting a CLOSED attendance is the cheap half of the
// fix (the other half is `limits.maxHistoryTokens`, which bounds a conversation still in progress).
//
// TWO CONDITIONS, and the second is the one that matters:
//   1. every conversation on the thread has been resolved for longer than the window, and
//   2. the thread has NO pending scheduler job.
// (2) is not belt-and-braces. The follow-up ladder deliberately runs on this same thread so a
// follow-up remembers the conversation that earned it — the code comments call out a past bug where
// the nudge ran on the per-conversation thread and lost that memory. `pauseWhileAppointment` can
// also push a follow-up well past any day count. So "N days" is the slack; "no pending job" is the
// guarantee. Wiping a thread with a follow-up still queued would recreate that bug on a timer, and
// it would fail silently: the follow-up still fires, just generic.

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Bound the work per tick: a tenant with a long backlog gets drained over several days rather than
// holding one long transaction (and a slow DELETE against the checkpointer, which every live turn
// also writes to).
const MAX_THREADS_PER_SWEEP = 200;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

interface ForgettableThread {
  thread_id: string;
  contact_inbox_id: number;
}

// Threads whose every conversation has been closed for longer than `days` and that carry no live
// scheduler job. `last_event_at` is the mirror's timestamp of the last Chatwoot event on the
// conversation — the closest thing we have to "when this attendance actually went quiet".
async function findForgettableThreads(
  db: ScopedDb,
  instanceId: bigint,
  days: number,
  limit: number,
): Promise<ForgettableThread[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  return db.$queryRaw<ForgettableThread[]>(Prisma.sql`
    SELECT t.thread_id, t.contact_inbox_id
    FROM agent_threads t
    WHERE t.chatwoot_instance_id = ${instanceId}
      AND EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.contact_inbox_id = t.contact_inbox_id
          AND c.chatwoot_instance_id = t.chatwoot_instance_id
      )
      -- No conversation on this thread is still open, snoozed, or recently closed.
      AND NOT EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.contact_inbox_id = t.contact_inbox_id
          AND c.chatwoot_instance_id = t.chatwoot_instance_id
          AND (c.status <> 'resolved'
               OR c.last_event_at IS NULL
               OR c.last_event_at >= ${cutoff})
      )
      -- Nothing scheduled that will want this memory (follow-up ladder, reminders, redirect chain).
      AND NOT EXISTS (
        SELECT 1 FROM scheduler_jobs j
        JOIN conversations c2
          ON c2.contact_inbox_id = t.contact_inbox_id
         AND c2.chatwoot_instance_id = t.chatwoot_instance_id
        WHERE j.status IN ('PENDING', 'CLAIMED')
          AND j.dedupe_key LIKE '%' || c2.thread_id
      )
    LIMIT ${limit}`);
}

async function memorySweepHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const tenantId = job.tenantId;
  const reschedule: JobResult = {
    outcome: "reschedule",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
  };

  // The window is per AGENT, but the memory is per contact-inbox (an inbox has one agent), so the
  // sweep runs per instance using the agents bound to it. An agent with the knob off contributes
  // nothing — absence of config means "keep forever", as before.
  const targets: [bigint, number][] = await runScopedOn(
    base,
    sysCtx(tenantId),
    async (db) => {
      const agents = await db.agent.findMany({
        select: { id: true, settings: true },
      });
      const windowByAgent = new Map<bigint, number>();
      for (const a of agents) {
        const days = readLimitsConfig(a.settings).forgetResolvedAfterDays;
        if (days != null) windowByAgent.set(a.id, days);
      }
      if (windowByAgent.size === 0) return [];

      const inboxes = await db.inbox.findMany({
        where: { agentId: { in: [...windowByAgent.keys()] } },
        select: { agentId: true, chatwootInstanceId: true },
      });
      const perInstance = new Map<bigint, number>();
      for (const ib of inboxes) {
        const days = ib.agentId == null ? null : windowByAgent.get(ib.agentId);
        if (days == null) continue;
        // Two agents on one instance with different windows: the LONGEST wins. Forgetting early is
        // the destructive direction, so the tie-break goes to the more conservative agent.
        const cur = perInstance.get(ib.chatwootInstanceId);
        perInstance.set(
          ib.chatwootInstanceId,
          cur == null ? days : Math.max(cur, days),
        );
      }
      return [...perInstance.entries()];
    },
  );
  if (targets.length === 0) return reschedule;

  // Imported lazily, and only once there is something to forget: getCheckpointer opens a dedicated
  // Postgres pool, and a sweep for a tenant that opted out should not pay for one. (It also keeps
  // the pg driver off the import graph of anything that merely registers this handler.)
  const { getCheckpointer } = await import("@/graph/checkpointer");
  const checkpointer = await getCheckpointer();
  let forgotten = 0;

  for (const [instanceId, days] of targets) {
    const threads = await runScopedOn(base, sysCtx(tenantId), (db) =>
      findForgettableThreads(db, instanceId, days, MAX_THREADS_PER_SWEEP),
    );
    for (const t of threads) {
      try {
        // Checkpointer first: it is the expensive part and the one that must not survive. If the
        // marker delete fails afterwards, the next sweep simply finds the row again — whereas the
        // reverse order could leave a huge orphan thread nobody ever looks for.
        await checkpointer.deleteThread(t.thread_id);
        await runScopedOn(base, sysCtx(tenantId), (db) =>
          db.agentThread.deleteMany({
            where: {
              tenantId,
              chatwootInstanceId: instanceId,
              contactInboxId: t.contact_inbox_id,
            },
          }),
        );
        forgotten++;
      } catch (err) {
        // One bad thread must not deprive the rest of the sweep.
        logger.warn(
          { tenantId: String(tenantId), threadId: t.thread_id, err },
          "memory sweep: failed to forget thread; continuing",
        );
      }
    }
  }

  if (forgotten > 0) {
    logger.info(
      { tenantId: String(tenantId), forgotten },
      "memory sweep: forgot resolved-conversation memory",
    );
  }
  return reschedule;
}

let registered = false;
export function registerMemoryRetentionHandler(): void {
  if (registered) return;
  registerJobHandler("MEMORY_SWEEP", memorySweepHandler);
  registered = true;
}

// Arms the per-tenant memory sweep (idempotent — enqueueJob upserts one live row per
// (tenant, kind, dedupeKey)). Armed for every tenant regardless of config: the handler is the one
// that checks whether any agent opted in, so turning the knob on does not require a restart.
export async function ensureMemorySweep(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "MEMORY_SWEEP",
    dedupeKey: "memory-sweep",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
    base,
  });
}

export async function ensureAllMemorySweeps(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenants = await asSuperAdminOn(base, (db) =>
    db.tenant.findMany({ select: { id: true } }),
  );
  for (const t of tenants) {
    try {
      await ensureMemorySweep(t.id, base);
    } catch (err) {
      logger.warn(
        { tenantId: String(t.id), err },
        "memory sweep re-arm failed for tenant; continuing",
      );
    }
  }
}
