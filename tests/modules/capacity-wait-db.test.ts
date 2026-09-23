import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import { runModelCall } from "@/graph/model-limit";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { flushDebounceJob } from "@/modules/debounce/handler";
import {
  type DebounceTickDeps,
  runDebounceTick,
} from "@/modules/debounce/worker";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";
import {
  claimDueDebounceJobs,
  enqueueJob,
  findWaitingDebounceJobs,
} from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// Issue #812, through the production writers: a reply that waited for capacity leaves one `capacity`
// warn on the delayed conversation's own tenant, naming which limit held it, and the alert bus
// receives it like any other warn. Two roads, both real: a due DEBOUNCE row stuck behind a full lane
// (the real waiting query, the real announcement), and a flush whose model call queues on the
// process-wide semaphore (flushDebounceJob → graph → runModelCall).

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
let inboxDbId = 0n;
let channelId = 0n;

const THRESHOLD_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const threadOf = (convId: number) => `${tenantId}:${instanceId}:${convId}`;

async function seedConversation(convId: number) {
  return suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: null,
      inboxId: inboxDbId,
      threadId: threadOf(convId),
      lastEventAt: new Date(),
      lastHandledMessageId: null,
    },
    select: { id: true },
  });
}

async function armDue(convId: number, runAt: Date) {
  await enqueueJob({
    base: appDb,
    tenantId,
    kind: "DEBOUNCE",
    dedupeKey: `debounce:${threadOf(convId)}`,
    runAt,
    payload: { threadId: threadOf(convId), agentBotId: 9, burstStartedAt: 1 },
    rearm: "new-work",
  });
}

class QuickModel extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType() {
    return "quick";
  }
  override bindTools() {
    return this;
  }
  async _generate(): Promise<ChatResult> {
    return {
      generations: [{ text: "pronto", message: new AIMessage("pronto") }],
    };
  }
}

function stubClient(sent: Array<[number, string]>) {
  const client = {
    getMessages: async (conversationId: number) => ({
      payload: [
        {
          id: 100,
          content: `oi da conversa ${conversationId}`,
          message_type: 0,
          private: false,
        },
      ],
    }),
    sendMessage: async (conversationId: number, content: string) => {
      sent.push([conversationId, content]);
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

// Every permit of the model semaphore, held until released.
async function holdEveryPermit(): Promise<() => void> {
  const cap = config.agent.modelConcurrency;
  const releases: Array<() => void> = [];
  for (let i = 0; i < cap; i++) {
    void runModelCall(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
  }
  while (releases.length < cap) await sleep(1);
  return () => {
    for (const r of releases.splice(0)) r();
  };
}

// The capacity lines written for one conversation, which is what each case produced.
async function capacityLines(conversationId: bigint) {
  return flowLogRows(suDb, {
    where: { tenantId, conversationId, stage: "capacity" },
    orderBy: { id: "asc" },
  });
}

async function deliveriesFor() {
  await settleFlowEvents();
  for (let i = 0; i < 40; i++) {
    const rows = await suDb.alertDelivery.findMany({
      where: { channelId },
      select: { stage: true, level: true, summary: true, count: true },
    });
    if (rows.length > 0) return rows;
    await sleep(50);
  }
  return [];
}

describe.skipIf(!dbUp)("a reply waiting for capacity (issue #812)", () => {
  let saved: number;
  beforeAll(async () => {
    saved = config.agent.capacityWaitAlertMs;
    config.agent.capacityWaitAlertMs = THRESHOLD_MS;
    const t = await suDb.tenant.create({
      data: { name: "CAP", slug: `cap-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: {
          debounce: { enabled: true, windowSeconds: 15 },
          split: { enabled: false },
        },
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `cap-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "Suporte",
        agentId: agent.id,
      },
    });
    inboxDbId = inbox.id;
    const ch = await suDb.alertChannel.create({
      data: {
        tenantId,
        name: "ops",
        type: "webhook",
        url: "https://alerts.example.com/hook",
        minLevel: "warn",
      },
      select: { id: true },
    });
    channelId = ch.id;
  });

  afterAll(async () => {
    config.agent.capacityWaitAlertMs = saved;
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      for (const table of [
        "alert_deliveries",
        "alert_channels",
        "scheduler_jobs",
        "llm_usage",
        "conversations",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "vault_entries",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a flush stuck behind a full lane is announced on its conversation, naming the lane", async () => {
    const holder = await seedConversation(4101);
    const waiter = await seedConversation(4102);
    const t0 = Date.now();
    await armDue(4101, new Date(t0 - 1_000));
    const hung: Array<() => void> = [];
    const deps: DebounceTickDeps = {
      claim: (limit, _base, now, _tenant, excludeIds) =>
        claimDueDebounceJobs(limit, appDb, now, tenantId, excludeIds),
      run: () =>
        new Promise<void>((resolve) => {
          hung.push(resolve);
        }),
      waiting: (dueBefore, exclude) =>
        findWaitingDebounceJobs(dueBefore, exclude, appDb, tenantId),
    };
    try {
      await (
        await runDebounceTick(appDb, 1, { ...deps, now: () => new Date(t0) })
      ).reported;
      await armDue(4102, new Date(t0));
      await (
        await runDebounceTick(appDb, 1, {
          ...deps,
          now: () => new Date(t0 + THRESHOLD_MS + 200),
        })
      ).reported;
      // Asked again while it still waits: one line, not one per tick.
      await (
        await runDebounceTick(appDb, 1, {
          ...deps,
          now: () => new Date(t0 + THRESHOLD_MS + 2_000),
        })
      ).reported;
      // The conversation holding the slot waited for nothing.
      expect(await capacityLines(holder.id)).toEqual([]);
      const lines = await capacityLines(waiter.id);
      expect(lines).toHaveLength(1);
      const line = lines[0];
      expect(line?.level).toBe("warn");
      expect(line?.source).toBe("inbox");
      expect(line?.conversationId).toBe(waiter.id);
      expect(line?.conversationId).not.toBe(holder.id);
      expect(line?.detail).toMatchObject({
        waitedOn: "debounce_lane",
        thresholdMs: THRESHOLD_MS,
      });
      expect(
        (line?.detail as { waitedMs?: number } | undefined)?.waitedMs ?? 0,
      ).toBeGreaterThanOrEqual(THRESHOLD_MS);
      const deliveries = await deliveriesFor();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.summary).toContain("waitedOn=debounce_lane");
    } finally {
      for (const r of hung.splice(0)) r();
      await sleep(0);
      await runDebounceTick(appDb, 1, { claim: async () => [] });
      await clearFlowLog(suDb, { tenantId });
      await suDb.alertDelivery.deleteMany({ where: { channelId } });
    }
  });

  test("a flush whose model call queues on the semaphore is announced on its conversation, naming the semaphore", async () => {
    const conv = await seedConversation(4201);
    await armDue(4201, new Date(Date.now() - 1_000));
    const [job] = await claimDueDebounceJobs(1, appDb, new Date(), tenantId);
    expect(job).toBeDefined();
    if (!job) return;
    const release = await holdEveryPermit();
    const sent: Array<[number, string]> = [];
    try {
      const flush = flushDebounceJob({
        job,
        base: appDb,
        deps: {
          makeModel: () => new QuickModel(),
          makeClient: stubClient(sent),
          checkpointer: new MemorySaver(),
        },
      });
      // NOTE: waits for the line rather than for a fixed time: under a loaded suite the flush can take
      // longer than the threshold to reach the queue at all.
      let lines = await capacityLines(conv.id);
      for (let i = 0; i < 100 && lines.length === 0; i++) {
        await sleep(50);
        lines = await capacityLines(conv.id);
      }
      // Written while the reply is still waiting, before any permit came free.
      expect(sent).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.conversationId).toBe(conv.id);
      expect(lines[0]?.source).toBe("inbox");
      expect(lines[0]?.level).toBe("warn");
      expect(lines[0]?.detail).toMatchObject({
        waitedOn: "model_semaphore",
        thresholdMs: THRESHOLD_MS,
      });
      release();
      await flush;
      // The line does not change the delivery: one reply, once the permit arrived.
      expect(sent).toHaveLength(1);
      expect(await capacityLines(conv.id)).toHaveLength(1);
      const deliveries = await deliveriesFor();
      expect(deliveries[0]?.summary).toContain("waitedOn=model_semaphore");
    } finally {
      release();
    }
  });
});
