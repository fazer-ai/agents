import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { registerMemoryRetentionHandler } from "@/modules/agents/memory-retention";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { getJobHandler, type JobResult } from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";

// MEMORY_SWEEP: drops the agent's graph memory for contact-inboxes whose conversations have all
// been resolved for longer than limits.forgetResolvedAfterDays — but ONLY when no scheduler job is
// still pending for them. That second condition is the one worth pinning: the follow-up ladder runs
// on this very thread so a follow-up remembers the conversation that earned it, and forgetting
// early would recreate a bug this project already fixed once — silently, since the follow-up still
// fires, just generic.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;

const FORGET_DAYS = 7;
// Long resolved (eligible), long resolved but with a pending follow-up (must survive), and one
// resolved only yesterday (inside the window).
const CI_STALE = 900_001;
const CI_PENDING_JOB = 900_002;
const CI_RECENT = 900_003;

async function seedThread(contactInboxId: number, resolvedDaysAgo: number) {
  const at = new Date(Date.now() - resolvedDaysAgo * 86_400_000);
  await suDb.$executeRawUnsafe(
    `INSERT INTO conversations
       (tenant_id, chatwoot_instance_id, chatwoot_conversation_id, contact_inbox_id, status,
        thread_id, last_event_at)
     VALUES (${tenantId}, ${instanceId}, ${contactInboxId}, ${contactInboxId}, 'resolved',
             '${tenantId}:${instanceId}:${contactInboxId}', '${at.toISOString()}')`,
  );
  await suDb.$executeRawUnsafe(
    `INSERT INTO agent_threads
       (tenant_id, chatwoot_instance_id, contact_inbox_id, thread_id)
     VALUES (${tenantId}, ${instanceId}, ${contactInboxId},
             '${tenantId}:${instanceId}:ci:${contactInboxId}')`,
  );
}

describe.skipIf(!dbUp)("agent memory retention", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "MemR", slug: `mem-r-${process.pid}` },
      })
    ).id;
    instanceId = (await seedChatwootInstance(suDb, { tenantId, accountId: 9 }))
      .id;
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "MemAgent",
          systemPrompt: "p",
          settings: { limits: { forgetResolvedAfterDays: FORGET_DAYS } },
        },
      })
    ).id;
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 1,
        name: "wa",
        agentId,
      },
    });

    await seedThread(CI_STALE, FORGET_DAYS + 3);
    await seedThread(CI_PENDING_JOB, FORGET_DAYS + 3);
    await seedThread(CI_RECENT, 1);

    // A follow-up still queued for the second thread's conversation.
    await suDb.$executeRawUnsafe(
      `INSERT INTO scheduler_jobs (tenant_id, kind, dedupe_key, status, run_at)
       VALUES (${tenantId}, 'FOLLOWUP',
               'followup:${tenantId}:${instanceId}:${CI_PENDING_JOB}', 'PENDING', NOW())`,
    );
  });

  afterAll(async () => {
    if (tenantId) {
      for (const t of [
        "scheduler_jobs",
        "agent_threads",
        "conversations",
        "inboxes",
        "agents",
        "chatwoot_instances",
        "chatwoot_deployments",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${t} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("forgets long-resolved threads, spares recent ones and any with a pending job", async () => {
    registerMemoryRetentionHandler();
    const handler = getJobHandler("MEMORY_SWEEP");
    expect(handler).toBeDefined();
    const job: ClaimedJob = {
      id: 1n,
      tenantId,
      kind: "MEMORY_SWEEP",
      payload: {},
      attempts: 0,
    };
    const result = (await (handler as NonNullable<typeof handler>)(
      job,
      appDb,
    )) as JobResult;

    expect(result.outcome).toBe("reschedule");
    if (result.outcome === "reschedule") {
      expect(result.runAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
    }

    const left = (
      await suDb.agentThread.findMany({
        where: { tenantId },
        select: { contactInboxId: true },
      })
    )
      .map((r) => r.contactInboxId)
      .sort();
    expect(left).toEqual([CI_PENDING_JOB, CI_RECENT]);
  });

  test("an agent without the knob forgets nothing", async () => {
    await suDb.agent.update({ where: { id: agentId }, data: { settings: {} } });
    await seedThread(900_004, FORGET_DAYS + 30);

    const handler = getJobHandler("MEMORY_SWEEP");
    await (handler as NonNullable<typeof handler>)(
      {
        id: 2n,
        tenantId,
        kind: "MEMORY_SWEEP",
        payload: {},
        attempts: 0,
      } as ClaimedJob,
      appDb,
    );

    const still = await suDb.agentThread.count({
      where: { tenantId, contactInboxId: 900_004 },
    });
    // Absence of config means "keep forever", exactly as before this feature existed.
    expect(still).toBe(1);
  });
});
