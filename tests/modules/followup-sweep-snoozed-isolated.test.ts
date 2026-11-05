import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import { followUpSweepHandler } from "@/modules/followups/handlers";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "@/tests/utils/flowlog";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";

// The snoozed selection runs first in the follow-up sweep's pass, and its failure is its own: the pass
// still arms the inactivity follow-up, counts the failures in a row, announces them once they repeat,
// and stamps when it completed. Catches a snoozed timeout that stops the follow-ups of every inbox.
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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const INBOX = 17_001;
const CONV = 170_001;
const BOOM = "canceling statement due to statement timeout";
let tenantId = 0n;
let instanceId = 0n;
let sweepJobId = 0n;

const threadId = () => `${tenantId}:${instanceId}:${CONV}`;

function job(payload: Record<string, unknown>): ClaimedJob {
  return {
    id: sweepJobId,
    tenantId,
    kind: "FOLLOWUP_SWEEP",
    payload,
    attempts: 0,
    claimSeq: 0,
  };
}

const failingSnoozed = async () => {
  throw new Error(BOOM);
};

describe.skipIf(!dbUp)("the snoozed selection fails on its own", () => {
  beforeAll(async () => {
    sweepJobId = await burnSchedulerJobId(suDb);
    const t = await suDb.tenant.create({
      data: { name: "Sweep 1700", slug: `sweep1700-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1_700,
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "sweep",
        systemPrompt: "x",
        followUpArmedAt: new Date(Date.now() - 24 * 60 * 60_000),
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {
          followUp: {
            enabled: true,
            steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "a" }],
          },
        },
      },
      select: { id: true },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX,
        name: "sweep",
        agentId: agent.id,
        channelType: "Channel::Api",
      },
      select: { id: true },
    });
    // Idle for two minutes after our reply: the inactivity selection takes it for step 0.
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inbox.id,
        chatwootConversationId: CONV,
        status: "pending",
        threadId: threadId(),
        lastEventAt: new Date(Date.now() - 2 * 60_000),
        lastInboundAt: new Date(Date.now() - 3 * 60_000),
        lastRepliedMessageId: 1,
      },
    });
  });

  afterAll(async () => {
    await clearFlowLog(suDb, { tenantId });
    for (const table of [
      "scheduler_jobs",
      "conversations",
      "inboxes",
      "agents",
      "chatwoot_instances",
    ]) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
      );
    }
    await suDb.tenant.delete({ where: { id: tenantId } });
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("the pass still arms the inactivity follow-up and does not throw", async () => {
    const before = Date.now();
    const result = await followUpSweepHandler(job({}), appDb, {
      sweepSnoozed: failingSnoozed,
    });
    expect(result.outcome).toBe("reschedule");
    const payload =
      result.outcome === "reschedule" ? (result.payload ?? {}) : {};
    expect(payload.snoozedFailures).toBe(1);
    expect(payload.completedAt as number).toBeGreaterThanOrEqual(before);
    const armed = await suDb.schedulerJob.count({
      where: {
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: `followup:${threadId()}`,
      },
    });
    expect(armed).toBe(1);
  });

  test("the failure log does not carry a credential the error echoed", async () => {
    // Assembled at run time so no scanner reads the fixture as a real key.
    const key = ["sk", "A1b2C3d4E5f6G7h8J9k0"].join("-");
    const warn = spyOn(logger, "warn");
    try {
      await followUpSweepHandler(job({}), appDb, {
        sweepSnoozed: async () => {
          throw new Error(`upstream echoed ${key}`);
        },
      });
      // An Error stringifies to `{}`; the logger writes its message and stack, so they are read here too.
      const logged = JSON.stringify(warn.mock.calls, (_k, v) =>
        v instanceof Error ? { message: v.message, stack: v.stack } : v,
      );
      expect(logged).toContain("the snoozed selection failed");
      expect(logged).not.toContain(key);
    } finally {
      warn.mockRestore();
    }
  });

  test("the failures in a row are announced once they reach five, and a success clears them", async () => {
    await clearFlowLog(suDb, { tenantId });
    const announced = async () => {
      // flowlog-scope: tenant-wide — the subject is how many announcements a run of failed passes
      // wrote, and the case empties this file's tenant first.
      const rows = await flowLogRows(suDb, {
        where: { tenantId, stage: "dead_letter" },
        orderBy: { id: "asc" },
      });
      return rows.filter(
        (r) => (r.detail as Record<string, unknown> | null)?.part === "snoozed",
      );
    };
    const four = await followUpSweepHandler(
      job({ snoozedFailures: 3 }),
      appDb,
      {
        sweepSnoozed: failingSnoozed,
      },
    );
    expect(four.outcome === "reschedule" && four.payload?.snoozedFailures).toBe(
      4,
    );
    expect(await announced()).toHaveLength(0);
    await followUpSweepHandler(job({ snoozedFailures: 4 }), appDb, {
      sweepSnoozed: failingSnoozed,
    });
    const lines = await announced();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.errorMessage).toContain(BOOM);
    expect(
      (lines[0]?.detail as Record<string, unknown> | undefined)?.kind,
    ).toBe("FOLLOWUP_SWEEP");
    const ok = await followUpSweepHandler(job({ snoozedFailures: 7 }), appDb, {
      sweepSnoozed: async () => 0,
    });
    expect(ok.outcome === "reschedule" && ok.payload?.snoozedFailures).toBe(0);
  });
});
