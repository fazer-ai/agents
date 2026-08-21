import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { clearTurnInFlight, markTurnInFlight } from "@/graph/inflight";
import { hasLiveAppointment } from "@/modules/appointments/reminders";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  ensureAllTenantSweeps,
  followUpHandler,
  registerFollowUpHandlers,
} from "@/modules/followups/handlers";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { getJobHandler } from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";

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
let agentId = 0n;

const CHATWOOT_INBOX_ID = 42;
const REPLY = "Olá! Posso ajudar?";

function fakeModel() {
  return new FakeListChatModel({ responses: [REPLY] });
}

function stubClient(over: { liveMeta?: Record<string, unknown> } = {}) {
  const sent: Array<[number, string]> = [];
  const notes: Array<[number, string]> = [];
  const labelSets: string[][] = [];
  const resolved: number[] = [];
  let currentLabels: string[] = [];
  const client = {
    // NOTE: `liveMeta` lets a test make the LIVE state (the requireLiveBotOwnership probe) agree
    // with the mirrored assignee it seeded — the default `{}` reads as unassigned.
    getConversation: async (c: number) => ({
      id: c,
      status: "pending",
      meta: over.liveMeta ?? {},
    }),
    sendMessage: async (c: number, t: string) => {
      sent.push([c, t]);
      return {};
    },
    sendPrivateNote: async (c: number, t: string) => {
      notes.push([c, t]);
      return {};
    },
    getConversationLabels: async () => currentLabels,
    setConversationLabels: async (_c: number, labels: string[]) => {
      currentLabels = labels;
      labelSets.push(labels);
      return {};
    },
    toggleStatus: async (c: number, _status: string) => {
      resolved.push(c);
      return {};
    },
  } as unknown as ChatwootClient;
  return { sent, notes, labelSets, resolved, makeClient: async () => client };
}

function threadOf(convId: number) {
  return `${tenantId}:${instanceId}:${convId}`;
}

function jobFor(convId: number, stepIndex?: number): ClaimedJob {
  return {
    id: 1n,
    tenantId,
    kind: "FOLLOWUP",
    payload:
      stepIndex === undefined
        ? { threadId: threadOf(convId) }
        : { threadId: threadOf(convId), stepIndex },
    attempts: 0,
    claimSeq: 0,
  };
}

type StepFixture = {
  delayValue: number;
  delayUnit: string;
  instructions: string;
  assignLabel?: string;
  resolve?: boolean;
};

// A two-step sequence: step 0 (1 min) then a last step (1 day) that assigns a label and resolves.
const TWO_STEPS: StepFixture[] = [
  { delayValue: 1, delayUnit: "minutes", instructions: "first" },
  {
    delayValue: 1,
    delayUnit: "days",
    instructions: "last",
    assignLabel: "sem-resposta",
    resolve: true,
  },
];

async function setAgentSteps(steps: StepFixture[]) {
  await suDb.agent.update({
    where: { id: agentId },
    data: { settings: { followUp: { enabled: true, steps } } },
  });
}

async function seedConversation(
  convId: number,
  over: {
    lastEventAt?: Date;
    lastInboundAt?: Date | null;
    lastFollowUpAt?: Date | null;
    status?: string;
    assigneeType?: string | null;
    assigneeId?: number | null;
  } = {},
) {
  // Two minutes ago so the inactivity threshold (1min delay agent) is exceeded.
  const lastEventAt = over.lastEventAt ?? new Date(Date.now() - 2 * 60_000);
  await suDb.conversation.upsert({
    where: {
      tenantId_chatwootInstanceId_chatwootConversationId: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
      },
    },
    create: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbId,
      chatwootConversationId: convId,
      status: over.status ?? "pending",
      assigneeType: over.assigneeType ?? null,
      assigneeId: over.assigneeId ?? null,
      threadId: threadOf(convId),
      lastEventAt,
      lastInboundAt:
        over.lastInboundAt !== undefined
          ? over.lastInboundAt
          : new Date(Date.now() - 3 * 60_000),
      lastFollowUpAt:
        over.lastFollowUpAt !== undefined ? over.lastFollowUpAt : null,
    },
    update: {
      lastEventAt,
      lastInboundAt:
        over.lastInboundAt !== undefined
          ? over.lastInboundAt
          : new Date(Date.now() - 3 * 60_000),
      lastFollowUpAt:
        over.lastFollowUpAt !== undefined ? over.lastFollowUpAt : null,
      status: over.status ?? "pending",
      assigneeType: over.assigneeType ?? null,
      assigneeId: over.assigneeId ?? null,
    },
  });
}

async function lastFollowUpOf(convId: number): Promise<Date | null> {
  const row = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { lastFollowUpAt: true },
  });
  return row.lastFollowUpAt;
}

describe.skipIf(!dbUp)("followUpHandler — watermark guard", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "FUT", slug: `fut-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 5,
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
        followUpArmedAt: new Date(Date.now() - 30 * 86_400_000),
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        // 1-minute delay so the inactivity threshold (2min lastEventAt) is exceeded.
        settings: {
          followUp: {
            enabled: true,
            steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
          },
        },
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 5,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `fu-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "Suporte",
        agentId,
        // Official WhatsApp (Cloud API) so the 24h window applies — test (g) asserts a note outside it.
        channelType: "Channel::Whatsapp",
        provider: "whatsapp_cloud",
      },
    });
    inboxDbId = inbox.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "scheduler_jobs",
        "llm_usage",
        "conversations",
        "inboxes",
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

  test("(a) does NOT re-fire when lastFollowUpAt >= lastInboundAt", async () => {
    const now = new Date();
    const inboundBefore = new Date(now.getTime() - 10 * 60_000);
    const followedUp = new Date(now.getTime() - 5 * 60_000);
    // lastInboundAt < lastFollowUpAt — client has not spoken since
    await seedConversation(1001, {
      lastInboundAt: inboundBefore,
      lastFollowUpAt: followedUp,
    });
    const s = stubClient();
    const result = await followUpHandler(jobFor(1001), appDb, {
      makeModel: fakeModel,
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(result).toEqual({ outcome: "done" });
    // Handler returned early — no message sent, watermark unchanged.
    expect(s.sent).toEqual([]);
    const wm = await lastFollowUpOf(1001);
    expect(wm?.getTime()).toBe(followedUp.getTime());
  });

  test("(b) re-fires when client spoke after the last follow-up", async () => {
    const now = new Date();
    const followedUp = new Date(now.getTime() - 10 * 60_000);
    const inboundAfter = new Date(now.getTime() - 5 * 60_000);
    // lastInboundAt > lastFollowUpAt — new episode opened
    await seedConversation(1002, {
      lastInboundAt: inboundAfter,
      lastFollowUpAt: followedUp,
    });
    const s = stubClient();
    const result = await followUpHandler(jobFor(1002), appDb, {
      makeModel: fakeModel,
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(result).toEqual({ outcome: "done" });
    // A message was sent to the customer.
    expect(s.sent.length).toBeGreaterThan(0);
    // Watermark advanced past the previous followedUp.
    const wm = await lastFollowUpOf(1002);
    expect(wm).not.toBeNull();
    expect((wm as Date).getTime()).toBeGreaterThan(followedUp.getTime());
  });

  test("(c) watermark is written even when nudge silences (no message sent)", async () => {
    // Use a model that replies with an empty string → runAgentNudge silences.
    await seedConversation(1003, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    const s = stubClient();
    await followUpHandler(jobFor(1003), appDb, {
      makeModel: () => new FakeListChatModel({ responses: [""] }),
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    // Nothing was sent.
    expect(s.sent).toEqual([]);
    // But the watermark was still written.
    const wm = await lastFollowUpOf(1003);
    expect(wm).not.toBeNull();
  });

  test("(d) the 1-minute delay floor is operative (single-step agent fires)", async () => {
    // Confirm the agent with delayValue=1 actually fires here (it passed the inactivity gate,
    // meaning the floor is 1, not 5).
    await seedConversation(1004, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    const s = stubClient();
    const result = await followUpHandler(jobFor(1004), appDb, {
      makeModel: fakeModel,
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(result).toEqual({ outcome: "done" });
    const wm = await lastFollowUpOf(1004);
    expect(wm).not.toBeNull();
  });

  test("(e) multi-step: step 0 fires and reschedules to step 1 (payload carries stepIndex)", async () => {
    await setAgentSteps(TWO_STEPS);
    await seedConversation(1005, {
      lastInboundAt: new Date(Date.now() - 3 * 60_000),
      lastFollowUpAt: null,
    });
    const s = stubClient();
    const result = await followUpHandler(jobFor(1005, 0), appDb, {
      makeModel: fakeModel,
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(result.outcome).toBe("reschedule");
    if (result.outcome === "reschedule") {
      expect(result.payload).toEqual({
        threadId: threadOf(1005),
        stepIndex: 1,
      });
    }
    expect(s.sent.length).toBeGreaterThan(0); // step 0 message sent
    // Step 0 has no label/resolve.
    expect(s.labelSets).toEqual([]);
    expect(s.resolved).toEqual([]);
    expect(await lastFollowUpOf(1005)).not.toBeNull();
  });

  test("(f) a later step is dropped when the client spoke since the last step", async () => {
    await setAgentSteps(TWO_STEPS);
    const now = Date.now();
    await seedConversation(1006, {
      lastFollowUpAt: new Date(now - 5 * 60_000),
      lastInboundAt: new Date(now - 2 * 60_000), // spoke AFTER the last follow-up
    });
    const s = stubClient();
    const result = await followUpHandler(jobFor(1006, 1), appDb, {
      makeModel: fakeModel,
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(result).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
  });

  test("(g) last step fires: message + deterministic label + resolve", async () => {
    await setAgentSteps(TWO_STEPS);
    const day = 24 * 60 * 60_000;
    await seedConversation(1007, {
      lastEventAt: new Date(Date.now() - 3 * day),
      lastFollowUpAt: new Date(Date.now() - 2 * day),
      lastInboundAt: new Date(Date.now() - 3 * day), // still silent since the last step
    });
    const s = stubClient();
    const result = await followUpHandler(jobFor(1007, 1), appDb, {
      makeModel: fakeModel,
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(result).toEqual({ outcome: "done" }); // no further step
    // NOTE: A 1-day cadence means the client has been silent past WhatsApp's 24h window, so the
    // proactive message is delivered as a private note (noted-window). Labels still fire, but the
    // auto-resolve is SKIPPED: nothing reached the customer, so resolving would close the
    // conversation unanswered.
    expect(s.notes.length).toBeGreaterThan(0);
    expect(s.sent).toEqual([]);
    expect(s.labelSets).toContainEqual(["sem-resposta"]);
    expect(s.resolved).toEqual([]);
  });

  test("(h) last step actions fire EVEN when the agent stays silent", async () => {
    await setAgentSteps(TWO_STEPS);
    const day = 24 * 60 * 60_000;
    await seedConversation(1008, {
      lastEventAt: new Date(Date.now() - 3 * day),
      lastFollowUpAt: new Date(Date.now() - 2 * day),
      lastInboundAt: new Date(Date.now() - 3 * day),
    });
    const s = stubClient();
    const result = await followUpHandler(jobFor(1008, 1), appDb, {
      makeModel: () => new FakeListChatModel({ responses: [""] }), // silent
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(result).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]); // nothing sent
    // But the deterministic actions still ran.
    expect(s.labelSets).toContainEqual(["sem-resposta"]);
    expect(s.resolved).toContain(1008);
  });

  test("(i) a test-mode agent does NOT follow up until /teste activates the conversation", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await suDb.agent.update({
      where: { id: agentId },
      data: { mode: "test" },
    });
    try {
      await seedConversation(1009, {
        lastInboundAt: new Date(Date.now() - 5 * 60_000),
        lastFollowUpAt: null,
      });
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: 1009 },
        data: { testActivatedAt: null },
      });
      const s = stubClient();
      const result = await followUpHandler(jobFor(1009), appDb, {
        makeModel: fakeModel,
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      });
      expect(result).toEqual({ outcome: "done" });
      expect(s.sent).toEqual([]);
      expect(s.notes).toEqual([]);
      // Silenced: the watermark must NOT advance (the episode is untouched).
      expect(await lastFollowUpOf(1009)).toBeNull();
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { mode: "production" },
      });
    }
  });

  test("(j) a test-mode agent follows up once the conversation is activated", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await suDb.agent.update({
      where: { id: agentId },
      data: { mode: "test" },
    });
    try {
      await seedConversation(1010, {
        lastInboundAt: new Date(Date.now() - 5 * 60_000),
        lastFollowUpAt: null,
      });
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: 1010 },
        data: { testActivatedAt: new Date() },
      });
      const s = stubClient();
      const result = await followUpHandler(jobFor(1010), appDb, {
        makeModel: fakeModel,
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      });
      expect(result).toEqual({ outcome: "done" });
      expect(s.sent.length).toBeGreaterThan(0);
      expect(await lastFollowUpOf(1010)).not.toBeNull();
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { mode: "production" },
      });
    }
  });

  test("(l) backs off (reschedules) instead of nudging while a turn is in flight", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await seedConversation(1011, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    const s = stubClient();
    // A webhook turn for this conversation is executing right now.
    markTurnInFlight(threadOf(1011));
    try {
      const result = await followUpHandler(jobFor(1011), appDb, {
        makeModel: fakeModel,
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      });
      expect(result.outcome).toBe("reschedule");
      // Nothing sent, watermark untouched: the nudge was deferred, not fired mid-turn.
      expect(s.sent).toEqual([]);
      expect(s.notes).toEqual([]);
      expect(await lastFollowUpOf(1011)).toBeNull();
    } finally {
      clearTurnInFlight(threadOf(1011));
    }
    // Once the turn clears, the same job fires normally.
    const s2 = stubClient();
    const result2 = await followUpHandler(jobFor(1011), appDb, {
      makeModel: fakeModel,
      makeClient: s2.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(result2).toEqual({ outcome: "done" });
    expect(s2.sent.length).toBeGreaterThan(0);
    expect(await lastFollowUpOf(1011)).not.toBeNull();
  });

  test("(k) ensureAllTenantSweeps re-arms the FOLLOWUP_SWEEP for an existing tenant (boot self-heal)", async () => {
    // The sweep is self-perpetuating but its single row can be lost (DB reset, external truncate);
    // without a boot re-arm, follow-ups silently die for the whole tenant until an agent is saved.
    // Simulate the loss, then assert the boot path re-creates exactly one live sweep row.
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId} AND kind = 'FOLLOWUP_SWEEP'`,
    );
    await ensureAllTenantSweeps(appDb);
    const count = await suDb.schedulerJob.count({
      where: { tenantId, kind: "FOLLOWUP_SWEEP", dedupeKey: "sweep" },
    });
    expect(count).toBe(1);
  });

  test("(m) follow-up is paused while a pending appointment reminder exists", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await seedConversation(1012, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    // A future appointment for THIS conversation: a pending reminder job keyed by the thread.
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_m:1",
        status: "PENDING",
        runAt: new Date(Date.now() + 60 * 60_000),
        payload: { threadId: threadOf(1012), eventId: "ev_m" },
      },
    });
    const s = stubClient();
    const result = await followUpHandler(jobFor(1012), appDb, {
      makeModel: fakeModel,
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    // Held (rescheduled), NOT nudged and NOT ended — so it resumes once the appointment passes.
    expect(result.outcome).toBe("reschedule");
    expect(s.sent).toEqual([]);
    expect(s.notes).toEqual([]);
    expect(await lastFollowUpOf(1012)).toBeNull();
  });

  test("(n) pauseWhileAppointment=false fires the follow-up despite the reminder", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          followUp: {
            enabled: true,
            steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
            pauseWhileAppointment: false,
          },
        },
      },
    });
    await seedConversation(1013, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_n:1",
        status: "PENDING",
        runAt: new Date(Date.now() + 60 * 60_000),
        payload: { threadId: threadOf(1013), eventId: "ev_n" },
      },
    });
    const s = stubClient();
    const result = await followUpHandler(jobFor(1013), appDb, {
      makeModel: fakeModel,
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    // The agent opted out of pausing, so the follow-up fires normally.
    expect(result).toEqual({ outcome: "done" });
    expect(s.sent.length).toBeGreaterThan(0);
  });

  // NOTE: Chatwoot ≥ 4.16.2 auto-assigns the connected Agent Bot at conversation creation, so
  // `assignee_type = 'AgentBot'` is the NORMAL bot-owned state — the sweep must treat it exactly
  // like unassigned (shouldBotHandle's `!== 'User'`), or follow-up never fires in ordinary
  // operation (issue #27).
  test("(o) sweep enqueues for a bot-owned conversation (AgentBot) and skips a human-owned one", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          followUp: {
            enabled: true,
            steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
          },
        },
      },
    });
    await seedConversation(1020, {
      assigneeType: "AgentBot",
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await seedConversation(1021, {
      assigneeType: "User",
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    registerFollowUpHandlers();
    const sweep = getJobHandler("FOLLOWUP_SWEEP");
    expect(sweep).toBeDefined();
    await sweep?.(
      {
        id: 999n,
        tenantId,
        kind: "FOLLOWUP_SWEEP",
        payload: {},
        attempts: 0,
        claimSeq: 0,
      },
      appDb,
    );
    const botJob = await suDb.schedulerJob.findFirst({
      where: {
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: `followup:${threadOf(1020)}`,
      },
    });
    const humanJob = await suDb.schedulerJob.findFirst({
      where: {
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: `followup:${threadOf(1021)}`,
      },
    });
    expect(botJob).not.toBeNull();
    expect(humanJob).toBeNull();
  });

  // NOTE: The permissive sweep makes a conversation owned by a DIFFERENT Agent Bot reachable, so
  // the nudge's ownership gate must exclude it by id — our bot messages only its own conversations.
  test("(p) a conversation owned by a FOREIGN Agent Bot is never messaged; our own is", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    // NOTE: Our bot is chatwootAgentBotId 5 (beforeAll); 777 is another bot on the same account.
    await seedConversation(1030, {
      assigneeType: "AgentBot",
      assigneeId: 777,
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    const foreign = stubClient({
      liveMeta: { assignee_type: "AgentBot", assignee: { id: 777 } },
    });
    await followUpHandler(jobFor(1030), appDb, {
      makeModel: fakeModel,
      makeClient: foreign.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(foreign.sent).toEqual([]);

    await seedConversation(1031, {
      assigneeType: "AgentBot",
      assigneeId: 5,
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    const ours = stubClient({
      liveMeta: { assignee_type: "AgentBot", assignee: { id: 5 } },
    });
    await followUpHandler(jobFor(1031), appDb, {
      makeModel: fakeModel,
      makeClient: ours.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(ours.sent).toEqual([[1031, REPLY]]);
  });

  // NOTE: Firing a reminder marks its row DONE. Suppression anchored on PENDING rows alone goes
  // blind after the LAST reminder fires while the appointment is still ahead (issue #39) — both
  // the handler re-check and the sweep must treat "DONE with a future start" as a live appointment,
  // tombstoned (cancelled) rows excluded.
  test("(q) follow-up stays paused after the LAST reminder fired while the appointment is ahead", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await seedConversation(1040, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    // NOTE: The last reminder already fired (DONE, runAt in the past) but the appointment is 2h ahead.
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_q:0",
        status: "DONE",
        runAt: new Date(Date.now() - 60 * 60_000),
        payload: {
          threadId: threadOf(1040),
          eventId: "ev_q",
          startISO: new Date(Date.now() + 2 * 3_600_000).toISOString(),
        },
      },
    });
    const s = stubClient();
    const result = await followUpHandler(jobFor(1040), appDb, {
      makeModel: fakeModel,
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(result.outcome).toBe("reschedule");
    expect(s.sent).toEqual([]);
    expect(s.notes).toEqual([]);
    expect(await lastFollowUpOf(1040)).toBeNull();
  });

  test("(r) sweep skips conversations with a live appointment: DONE + future start, and CLAIMED", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await seedConversation(1041, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_r:0",
        status: "DONE",
        runAt: new Date(Date.now() - 60 * 60_000),
        payload: {
          threadId: threadOf(1041),
          eventId: "ev_r",
          startISO: new Date(Date.now() + 2 * 3_600_000).toISOString(),
        },
      },
    });
    // NOTE: The reminder's OWN turn runs with the row CLAIMED — also live, even without a startISO.
    await seedConversation(1042, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_r2:0",
        status: "CLAIMED",
        runAt: new Date(),
        payload: { threadId: threadOf(1042), eventId: "ev_r2" },
      },
    });
    registerFollowUpHandlers();
    const sweep = getJobHandler("FOLLOWUP_SWEEP");
    await sweep?.(
      {
        id: 998n,
        tenantId,
        kind: "FOLLOWUP_SWEEP",
        payload: {},
        attempts: 0,
        claimSeq: 0,
      },
      appDb,
    );
    for (const convId of [1041, 1042]) {
      expect(
        await suDb.schedulerJob.findFirst({
          where: {
            tenantId,
            kind: "FOLLOWUP",
            dedupeKey: `followup:${threadOf(convId)}`,
          },
        }),
      ).toBeNull();
    }
  });

  test("(s) sweep resumes once the appointment start has passed (DONE, past start)", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await seedConversation(1043, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_s:0",
        status: "DONE",
        runAt: new Date(Date.now() - 3 * 3_600_000),
        payload: {
          threadId: threadOf(1043),
          eventId: "ev_s",
          startISO: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        },
      },
    });
    registerFollowUpHandlers();
    const sweep = getJobHandler("FOLLOWUP_SWEEP");
    await sweep?.(
      {
        id: 997n,
        tenantId,
        kind: "FOLLOWUP_SWEEP",
        payload: {},
        attempts: 0,
        claimSeq: 0,
      },
      appDb,
    );
    expect(
      await suDb.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "FOLLOWUP",
          dedupeKey: `followup:${threadOf(1043)}`,
        },
      }),
    ).not.toBeNull();
  });

  test("(t) sweep resumes for a cancelled appointment (tombstoned rows, start still ahead)", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await seedConversation(1044, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    // NOTE: Cancelling marks rows DONE too — the tombstone is what tells them apart from "fired".
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_t:0",
        status: "DONE",
        runAt: new Date(Date.now() - 60 * 60_000),
        payload: {
          threadId: threadOf(1044),
          eventId: "ev_t",
          startISO: new Date(Date.now() + 2 * 3_600_000).toISOString(),
          cancelledAt: new Date().toISOString(),
        },
      },
    });
    registerFollowUpHandlers();
    const sweep = getJobHandler("FOLLOWUP_SWEEP");
    await sweep?.(
      {
        id: 996n,
        tenantId,
        kind: "FOLLOWUP_SWEEP",
        payload: {},
        attempts: 0,
        claimSeq: 0,
      },
      appDb,
    );
    expect(
      await suDb.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "FOLLOWUP",
          dedupeKey: `followup:${threadOf(1044)}`,
        },
      }),
    ).not.toBeNull();
  });

  test("(u) a garbage startISO never aborts the sweep for the tenant", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    // NOTE: Conv A carries model-supplied garbage in startISO; conv B is a plain eligible
    // conversation. An unguarded ::timestamptz cast would throw on A and kill follow-ups for the
    // WHOLE tenant.
    await seedConversation(1045, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_u:0",
        status: "DONE",
        runAt: new Date(Date.now() - 60 * 60_000),
        payload: {
          threadId: threadOf(1045),
          eventId: "ev_u",
          startISO: "amanhã de manhã",
        },
      },
    });
    await seedConversation(1046, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    registerFollowUpHandlers();
    const sweep = getJobHandler("FOLLOWUP_SWEEP");
    await sweep?.(
      {
        id: 995n,
        tenantId,
        kind: "FOLLOWUP_SWEEP",
        payload: {},
        attempts: 0,
        claimSeq: 0,
      },
      appDb,
    );
    // NOTE: Garbage = not-future = not suppressed (fail-safe), and the sweep survives for everyone.
    for (const convId of [1045, 1046]) {
      expect(
        await suDb.schedulerJob.findFirst({
          where: {
            tenantId,
            kind: "FOLLOWUP",
            dedupeKey: `followup:${threadOf(convId)}`,
          },
        }),
      ).not.toBeNull();
    }
  });

  test("(w) an offset-less datetime is read as UTC by BOTH sides (sweep and re-check agree)", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await seedConversation(1048, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    // NOTE: The model-input fallback can leave startISO WITHOUT an offset; both runtimes must pin it
    // to UTC (parseStartMs / the SQL normalization) or their decisions diverge across time zones.
    const offsetLessFutureUtc = new Date(Date.now() + 2 * 3_600_000)
      .toISOString()
      .slice(0, 19);
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_w:0",
        status: "DONE",
        runAt: new Date(Date.now() - 60 * 60_000),
        payload: {
          threadId: threadOf(1048),
          eventId: "ev_w",
          startISO: offsetLessFutureUtc,
        },
      },
    });
    registerFollowUpHandlers();
    const sweep = getJobHandler("FOLLOWUP_SWEEP");
    await sweep?.(
      {
        id: 993n,
        tenantId,
        kind: "FOLLOWUP_SWEEP",
        payload: {},
        attempts: 0,
        claimSeq: 0,
      },
      appDb,
    );
    expect(
      await suDb.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "FOLLOWUP",
          dedupeKey: `followup:${threadOf(1048)}`,
        },
      }),
    ).toBeNull();
    expect(await hasLiveAppointment(tenantId, threadOf(1048), appDb)).toBe(
      true,
    );
  });

  test("(v) an all-day (date-only) future start suppresses the sweep", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await seedConversation(1047, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_v:0",
        status: "DONE",
        runAt: new Date(Date.now() - 60 * 60_000),
        payload: {
          threadId: threadOf(1047),
          eventId: "ev_v",
          // NOTE: All-day events carry a bare YYYY-MM-DD (UTC midnight, parseStartMs).
          startISO: new Date(Date.now() + 3 * 86_400_000)
            .toISOString()
            .slice(0, 10),
        },
      },
    });
    registerFollowUpHandlers();
    const sweep = getJobHandler("FOLLOWUP_SWEEP");
    await sweep?.(
      {
        id: 994n,
        tenantId,
        kind: "FOLLOWUP_SWEEP",
        payload: {},
        attempts: 0,
        claimSeq: 0,
      },
      appDb,
    );
    expect(
      await suDb.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "FOLLOWUP",
          dedupeKey: `followup:${threadOf(1047)}`,
        },
      }),
    ).toBeNull();
  });

  test("(x) an impossible calendar date never suppresses (no Date.parse roll-over on either side)", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await seedConversation(1049, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    // NOTE: Feb 30 of NEXT year: Date.parse would roll it over to a FUTURE March 2 (suppressing the
    // follow-up), while pg_input_is_valid rejects it. Both sides must treat it as garbage.
    const impossibleFuture = `${new Date().getUTCFullYear() + 1}-02-30T00:00:00Z`;
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_x:0",
        status: "DONE",
        runAt: new Date(Date.now() - 60 * 60_000),
        payload: {
          threadId: threadOf(1049),
          eventId: "ev_x",
          startISO: impossibleFuture,
        },
      },
    });
    registerFollowUpHandlers();
    const sweep = getJobHandler("FOLLOWUP_SWEEP");
    await sweep?.(
      {
        id: 992n,
        tenantId,
        kind: "FOLLOWUP_SWEEP",
        payload: {},
        attempts: 0,
        claimSeq: 0,
      },
      appDb,
    );
    expect(
      await suDb.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "FOLLOWUP",
          dedupeKey: `followup:${threadOf(1049)}`,
        },
      }),
    ).not.toBeNull();
    expect(await hasLiveAppointment(tenantId, threadOf(1049), appDb)).toBe(
      false,
    );
  });
});
