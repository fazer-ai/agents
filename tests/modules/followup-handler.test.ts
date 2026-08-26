import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { clearTurnInFlight, markTurnInFlight } from "@/graph/inflight";
import { NUDGE_RETRY_LIMIT } from "@/graph/nudge-retry";
import { recordAppointment } from "@/modules/appointments/record";
import {
  cancelAppointment,
  hasLiveAppointment,
} from "@/modules/appointments/reminders";
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
  ignoreAppointmentPause?: boolean;
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

// Points the agent's model at a vault entry that does not exist, which is the state issue #281 is
// about: the agent is live and expected to answer, and nothing it needs to author with resolves.
// Restored on the way out, because every other test in this file reads the same agent row.
async function withUnresolvableCredential<T>(fn: () => Promise<T>): Promise<T> {
  const before = await suDb.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { modelConfig: true },
  });
  await suDb.agent.update({
    where: { id: agentId },
    data: {
      modelConfig: {
        provider: "openai",
        model: "gpt-4o-mini",
        credentialRef: "vault:999999999",
      },
    },
  });
  try {
    return await fn();
  } finally {
    await suDb.agent.update({
      where: { id: agentId },
      data: { modelConfig: before.modelConfig ?? {} },
    });
  }
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

  // (#376) An appointment is a RECORD now, not a projection of the reminder jobs, so a test that
  // wants a conversation to be holding one writes the record. Where a job row also matters (a
  // reminder that already fired, one still claimed, one dead-lettered) the test keeps writing that
  // too — it just no longer decides whether the appointment exists.
  async function seedAppointment(
    convId: number,
    externalId: string,
    startISO: string = new Date(Date.now() + 2 * 3_600_000).toISOString(),
  ) {
    return recordAppointment({
      tenantId,
      threadId: threadOf(convId),
      externalId,
      startISO,
      base: appDb,
    });
  }

  test("(m) follow-up is paused while the conversation holds an appointment", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await seedConversation(1012, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    // A future appointment for THIS conversation.
    await seedAppointment(1012, "ev_m");
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
    await seedAppointment(1013, "ev_n");
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

  // ISSUE #103. `pauseWhileAppointment` is one boolean for the whole agent, and it conflates two
  // opposite things: a re-engagement nudge wants to be suppressed while a booking stands, and a
  // payment-deadline step wants exactly the reverse — it only means anything WHILE the booking is
  // unconfirmed, and it is the step that later frees the slot. An operator who needs both in one
  // sequence has no way to say so today.
  //
  // A live appointment in every one of these, so the only thing under test is which step is next.
  async function withReminder(convId: number, tag: string) {
    await seedAppointment(convId, tag);
  }

  test("(#103) a step that opts out of the pause fires despite a live appointment", async () => {
    await setAgentSteps([
      {
        delayValue: 1,
        delayUnit: "minutes",
        instructions: "cobrança de prazo",
        ignoreAppointmentPause: true,
      },
    ]);
    await seedConversation(1103, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await withReminder(1103, "ev_103a");
    const s = stubClient();
    const result = await followUpHandler(jobFor(1103), appDb, {
      makeModel: fakeModel,
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(result).toEqual({ outcome: "done" });
    expect(s.sent.length).toBeGreaterThan(0);
  });

  // The counter-assertion that makes the one above mean something: the opt-out is PER STEP, not a
  // second way to spell `pauseWhileAppointment: false`. Step 0 opts out and step 1 does not, so the
  // same agent, same conversation and same reminder must answer differently depending on which step
  // the job is for.
  test("(#103) the step WITHOUT the opt-out still pauses, on the same agent", async () => {
    await setAgentSteps([
      {
        delayValue: 1,
        delayUnit: "minutes",
        instructions: "cobrança de prazo",
        ignoreAppointmentPause: true,
      },
      { delayValue: 1, delayUnit: "days", instructions: "re-engajamento" },
    ]);
    await seedConversation(1104, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: new Date(Date.now() - 2 * 60_000),
    });
    await withReminder(1104, "ev_103b");
    const s = stubClient();
    const result = await followUpHandler(jobFor(1104, 1), appDb, {
      makeModel: fakeModel,
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(result.outcome).toBe("reschedule");
    expect(s.sent).toEqual([]);
  });

  // The one behaviour the gate's move DOES change, measured rather than asserted away. The gate used
  // to run above the step resolution, so a job whose stepIndex is past the end of a shrunk sequence
  // met the appointment first and was rescheduled, again and again, until the appointment passed —
  // only to end the sequence the moment it finally got through. Below the resolution it ends the
  // sequence straight away. Nothing is lost, because there was no step left to send.
  test("(#103) a job past the end of a shrunk sequence ends it, instead of waiting out the appointment", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "única etapa" },
    ]);
    await seedConversation(1107, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: new Date(Date.now() - 2 * 60_000),
    });
    await withReminder(1107, "ev_103e");
    const s = stubClient();
    const result = await followUpHandler(jobFor(1107, 3), appDb, {
      makeModel: fakeModel,
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(result).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
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

  // The SWEEP is the other half of the same question, and it answers it in SQL rather than in
  // TypeScript (issue #103). Without it the opt-out is unreachable: a conversation with a live
  // appointment never gets enqueued, so the handler gate that now honours the flag never runs.
  // The sweep only ever enqueues STEP 0, so step 0 is the step whose flag it has to read.
  test("(#103) the sweep enqueues when step 0 opts out of the pause", async () => {
    await setAgentSteps([
      {
        delayValue: 1,
        delayUnit: "minutes",
        instructions: "cobrança",
        ignoreAppointmentPause: true,
      },
    ]);
    await seedConversation(1105, {
      assigneeType: "AgentBot",
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await withReminder(1105, "ev_103c");
    registerFollowUpHandlers();
    await getJobHandler("FOLLOWUP_SWEEP")?.(
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
    expect(
      await suDb.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "FOLLOWUP",
          dedupeKey: `followup:${threadOf(1105)}`,
        },
      }),
    ).not.toBeNull();
  });

  // The counter-assertion, and it is the one that proves the SQL reads the flag rather than
  // dropping the whole appointment fence: same sweep, same reminder, step 0 without the opt-out.
  test("(#103) the sweep still skips when step 0 does NOT opt out", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "re-engajamento" },
    ]);
    await seedConversation(1106, {
      assigneeType: "AgentBot",
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await withReminder(1106, "ev_103d");
    registerFollowUpHandlers();
    await getJobHandler("FOLLOWUP_SWEEP")?.(
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
          dedupeKey: `followup:${threadOf(1106)}`,
        },
      }),
    ).toBeNull();
  });

  // Review round 2. The predicate above used to read the step at RAW index 0, which is not the step
  // the runtime reads: `readFollowUpConfig` drops every non-object entry BEFORE numbering, so its
  // step 0 is the first OBJECT in the array. Measured live against the dev server, because the
  // reachability was the whole question: `PATCH /api/v1/agents/:id` types `settings` as an opaque
  // record (`z.record(z.string(), z.unknown())`), NOT as the MCP behaviour schema, so this bag is
  // stored exactly as written and answers HTTP 200.
  //
  // The predicate is existential now, so there is no index left to disagree about — and this test
  // is the one that would have caught the positional version.
  test("(#103) the sweep enqueues when a non-object entry shifts the opted-out step off index 0", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          followUp: {
            enabled: true,
            steps: [
              7,
              {
                delayValue: 1,
                delayUnit: "minutes",
                instructions: "cobrança",
                ignoreAppointmentPause: true,
              },
            ],
          },
        },
      },
    });
    await seedConversation(1108, {
      assigneeType: "AgentBot",
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await withReminder(1108, "ev_103f");
    registerFollowUpHandlers();
    await getJobHandler("FOLLOWUP_SWEEP")?.(
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
          dedupeKey: `followup:${threadOf(1108)}`,
        },
      }),
    ).not.toBeNull();
  });

  // And the same shape with the flag NOWHERE: a malformed entry does not by itself lift the fence.
  // Without this the test above would pass on a predicate that simply gave up on any array holding
  // something it did not understand.
  test("(#103) a non-object entry alone does not lift the appointment fence", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          followUp: {
            enabled: true,
            steps: [
              7,
              {
                delayValue: 1,
                delayUnit: "minutes",
                instructions: "re-engajamento",
              },
            ],
          },
        },
      },
    });
    await seedConversation(1109, {
      assigneeType: "AgentBot",
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await withReminder(1109, "ev_103g");
    registerFollowUpHandlers();
    await getJobHandler("FOLLOWUP_SWEEP")?.(
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
    expect(
      await suDb.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "FOLLOWUP",
          dedupeKey: `followup:${threadOf(1109)}`,
        },
      }),
    ).toBeNull();
  });

  // Review round 3, and the boundary of the feature, pinned so it cannot drift into a surprise.
  // The sweep gates the START of a sequence, and the only step it can start is step 0, so a LATER
  // step's opt-out does NOT lift the fence. It could not usefully: round 2 let it, and the cost was
  // that an appointment-blocked conversation was re-armed every minute for as long as the booking
  // stood, eating a slot of the sweep's LIMIT 500 and delaying conversations that would actually
  // send. Once the sequence IS running the handler carries it, and each step's own gate honours its
  // own opt-out — which is the reported case, where the payment chase is what fires while the
  // booking stands and is therefore step 0.
  test("(#103) a LATER step opting out does NOT lift the sweep's fence for step 0", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "re-engajamento" },
      {
        delayValue: 1,
        delayUnit: "days",
        instructions: "cobrança",
        ignoreAppointmentPause: true,
      },
    ]);
    await seedConversation(1110, {
      assigneeType: "AgentBot",
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await withReminder(1110, "ev_103h");
    registerFollowUpHandlers();
    await getJobHandler("FOLLOWUP_SWEEP")?.(
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
          dedupeKey: `followup:${threadOf(1110)}`,
        },
      }),
    ).toBeNull();
    // And the step that DID opt out still fires once the sequence reaches it, which is what makes
    // the fence above a cost decision rather than the opt-out failing to work. Its own conversation
    // because the two states are mutually exclusive by construction: the sweep only looks at a
    // conversation whose last inbound is NEWER than its last follow-up, and a sequence that reached
    // step 1 is exactly the opposite.
    // Step 1's own cadence is 1 day, so the last follow-up has to be far enough back for it to be
    // due at all — otherwise the reschedule under test would be the delay, not the fence.
    await seedConversation(1111, {
      assigneeType: "AgentBot",
      lastEventAt: new Date(Date.now() - 3 * 86_400_000),
      lastInboundAt: new Date(Date.now() - 3 * 86_400_000),
      lastFollowUpAt: new Date(Date.now() - 2 * 86_400_000),
    });
    await withReminder(1111, "ev_103i");
    const s = stubClient();
    const result = await followUpHandler(jobFor(1111, 1), appDb, {
      makeModel: fakeModel,
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    // `done` and not `reschedule` is the whole assertion: `reschedule` is what the appointment
    // gate returns, and it is what the counter-test above gets on the step WITHOUT the opt-out.
    // The nudge lands as a private note here rather than a message, because this conversation is
    // days past its last inbound and the WhatsApp 24h window governs a proactive send. That is
    // unrelated to the pause, and asserting on `sent` would have measured the window, not this gate.
    expect(result).toEqual({ outcome: "done" });
    expect(s.notes.length).toBeGreaterThan(0);
    expect(s.sent).toEqual([]);
  });

  // Review round 3, from a mutation that SURVIVED: narrowing the SQL to jsonb_typeof = 'object'
  // broke nothing, which meant the array half of the rule was untested. It is not decoration —
  // `readStep` rejects on `!raw || typeof raw !== "object"`, and `typeof [] === "object"`, so the
  // reader turns a bare array into a DEFAULT step that carries no opt-out and occupies position 0.
  // Measured, not assumed: readFollowUpConfig on `[[], {opted out}]` answers two steps, the first
  // being the default. So the fence must stay UP here, and an SQL that skipped the array would pick
  // the opted-out object as step 0 and lift it.
  test("(#103) a bare ARRAY entry counts as step 0, exactly as the reader counts it", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          followUp: {
            enabled: true,
            steps: [
              [],
              {
                delayValue: 1,
                delayUnit: "minutes",
                instructions: "cobrança",
                ignoreAppointmentPause: true,
              },
            ],
          },
        },
      },
    });
    // NOTE: 90 minutes, not the usual 5. The sweep's cutoff is the minimum FIRST-step delay across
    // enabled agents, and here the reader's step 0 is the DEFAULT step the bare array becomes,
    // whose delay is 60 minutes. Seeded any fresher, the conversation is filtered out before the
    // predicate under test is ever reached, and the assertion below would pass on nothing.
    await seedConversation(1113, {
      assigneeType: "AgentBot",
      lastEventAt: new Date(Date.now() - 90 * 60_000),
      lastInboundAt: new Date(Date.now() - 90 * 60_000),
      lastFollowUpAt: null,
    });
    await withReminder(1113, "ev_103k");
    registerFollowUpHandlers();
    await getJobHandler("FOLLOWUP_SWEEP")?.(
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
          dedupeKey: `followup:${threadOf(1113)}`,
        },
      }),
    ).toBeNull();
  });

  // Review round 4, from a mutation that SURVIVED: dropping `!cfg.pauseWhileAppointment` from the
  // exempt set broke no test. The agent-wide opt-out is the OLDER half of this predicate and it had
  // no sweep coverage at all — every existing test exercised the fence staying up. Its positive
  // case is what the boolean is for, and it is now the pair of the string test below.
  test("(#103) pauseWhileAppointment false lets the sweep enqueue despite a live appointment", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          followUp: {
            enabled: true,
            pauseWhileAppointment: false,
            steps: [
              {
                delayValue: 1,
                delayUnit: "minutes",
                instructions: "re-engajamento",
              },
            ],
          },
        },
      },
    });
    await seedConversation(1114, {
      assigneeType: "AgentBot",
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await withReminder(1114, "ev_103l");
    registerFollowUpHandlers();
    await getJobHandler("FOLLOWUP_SWEEP")?.(
      {
        id: 991n,
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
          dedupeKey: `followup:${threadOf(1114)}`,
        },
      }),
    ).not.toBeNull();
  });

  // Review round 5. `unfencedAgentIds` answered for an agent whose follow-up is OFF, because
  // `appointmentPauseApplies` is only asked about the pause and a retained step-0 exemption is
  // still an exemption. Nothing downstream caught it: the sweep's SQL tests `follow_up_armed_at`,
  // which is stamped on the OFF→ON transition and never cleared on the way back, so a disabled
  // agent keeps passing that gate.
  //
  // The cost is the one the LIMIT 500 imposes. The handler discards these jobs on its first look,
  // but the sweep re-enqueues them every minute, and each one occupies a slot that belongs to an
  // agent that would actually send. Asking about a config whose follow-up is off is a question with
  // no answer, so the filter is at the call site — NOT inside `appointmentPauseApplies`, which
  // decides one thing and must keep deciding only that.
  //
  // The second agent is what makes this reachable: the sweep returns early when NO enabled agent
  // has follow-up on, so a tenant with only the disabled one never runs the query at all.
  test("(#103) an agent with follow-up OFF is not exempted from the fence by a retained opt-out", async () => {
    const other = await suDb.agent.create({
      data: {
        tenantId,
        name: "Outra",
        systemPrompt: "x",
        followUpArmedAt: new Date(Date.now() - 30 * 86_400_000),
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {
          followUp: {
            enabled: true,
            steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
          },
        },
      },
    });
    try {
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          settings: {
            followUp: {
              enabled: false,
              pauseWhileAppointment: true,
              steps: [
                {
                  delayValue: 1,
                  delayUnit: "minutes",
                  instructions: "cobranca",
                  ignoreAppointmentPause: true,
                },
              ],
            },
          },
        },
      });
      await seedConversation(1115, {
        assigneeType: "AgentBot",
        lastInboundAt: new Date(Date.now() - 5 * 60_000),
        lastFollowUpAt: null,
      });
      await withReminder(1115, "ev_103m");
      registerFollowUpHandlers();
      await getJobHandler("FOLLOWUP_SWEEP")?.(
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
            dedupeKey: `followup:${threadOf(1115)}`,
          },
        }),
      ).toBeNull();
    } finally {
      await suDb.agent.delete({ where: { id: other.id } });
    }
  });

  // Review round 3. The SIBLING half of the same predicate, found by asking where else the sweep
  // states something the reader also states. `->>` renders a JSON string and a JSON boolean to the
  // same characters, and the reader does not: `bag.pauseWhileAppointment !== false` keeps the pause
  // ON for a stored "false", while the text comparison read it as OFF and lifted the fence. All
  // seven spellings were measured against the reader; the string was the only disagreement, and it
  // is reachable through the same REST hole as the malformed step above. Predates #103 — the
  // comparison is jsonb on both halves now.
  test("(#103) a pauseWhileAppointment stored as the STRING false still pauses, like the reader", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          followUp: {
            enabled: true,
            pauseWhileAppointment: "false",
            steps: [
              {
                delayValue: 1,
                delayUnit: "minutes",
                instructions: "re-engajamento",
              },
            ],
          },
        },
      },
    });
    await seedConversation(1112, {
      assigneeType: "AgentBot",
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await withReminder(1112, "ev_103j");
    registerFollowUpHandlers();
    await getJobHandler("FOLLOWUP_SWEEP")?.(
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
          dedupeKey: `followup:${threadOf(1112)}`,
        },
      }),
    ).toBeNull();
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
    // NOTE: The last reminder already fired (DONE, runAt in the past) but the appointment is 2h
    // ahead. The record is what still knows that; the spent job is kept so the scenario is the real
    // one rather than an appointment nothing ever announced.
    await seedAppointment(1040, "ev_q");
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_q:0",
        status: "DONE",
        runAt: new Date(Date.now() - 60 * 60_000),
        payload: { threadId: threadOf(1040), eventId: "ev_q" },
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

  test("(r) sweep skips every conversation holding an appointment, whatever became of its reminder", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await seedConversation(1041, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    // Its reminder already fired.
    await seedAppointment(1041, "ev_r");
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_r:0",
        status: "DONE",
        runAt: new Date(Date.now() - 60 * 60_000),
        payload: { threadId: threadOf(1041), eventId: "ev_r" },
      },
    });
    // NOTE: And this one's reminder is mid-flight (CLAIMED — the reminder's own turn runs on it).
    // Neither status is what the sweep asks about any more: the record is.
    await seedConversation(1042, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await seedAppointment(1042, "ev_r2");
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
    await seedAppointment(
      1043,
      "ev_s",
      new Date(Date.now() - 2 * 3_600_000).toISOString(),
    );
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

  test("(t) sweep resumes for a cancelled appointment (start still ahead)", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await seedConversation(1044, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    // NOTE: The start is still ahead, so only the cancellation can tell the sweep to resume.
    await seedAppointment(1044, "ev_t");
    await cancelAppointment(tenantId, "ev_t", appDb);
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

  test("(u) a garbage start yields no appointment, and never aborts the sweep for the tenant", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    // NOTE: Conv A books with model-supplied garbage for a start; conv B is a plain eligible
    // conversation. The garbage is refused at the WRITE, so nothing unparseable ever reaches the
    // sweep's query — where an unguarded cast used to be one bad payload away from killing
    // follow-ups for the whole tenant.
    await seedConversation(1045, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    expect(await seedAppointment(1045, "ev_u", "amanhã de manhã")).toBe(
      "unreadable-start",
    );
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
    // NOTE: The model-input fallback can leave startISO WITHOUT an offset. parseStartMs pins it to
    // UTC once, at the write, and every reader compares the column it produced — so the sweep and
    // the handler's re-check cannot answer differently whatever the host and session zones are.
    const offsetLessFutureUtc = new Date(Date.now() + 2 * 3_600_000)
      .toISOString()
      .slice(0, 19);
    await seedAppointment(1048, "ev_w", offsetLessFutureUtc);
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
    // NOTE: All-day events carry a bare YYYY-MM-DD (UTC midnight, parseStartMs).
    await seedAppointment(
      1047,
      "ev_v",
      new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
    );
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

  // Issue #281. An agent whose model credentialRef does not resolve cannot author anything, and the
  // step used to be spent anyway: the watermark was stamped and the sequence advanced, so a broken
  // credential silently consumed the whole episode and the customer got nothing once it was fixed.
  test("(y) a step whose agent cannot author is retried, not stamped", async () => {
    await setAgentSteps(TWO_STEPS);
    await seedConversation(1090, { lastFollowUpAt: null });
    const s = stubClient();
    const result = await withUnresolvableCredential(() =>
      followUpHandler(jobFor(1090, 0), appDb, {
        makeModel: fakeModel,
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      }),
    );
    expect(result.outcome).toBe("reschedule");
    if (result.outcome === "reschedule") {
      // The SAME step, with the attempt counter, not stepIndex 1, which is what advancing looks like.
      expect(result.payload).toEqual({
        threadId: threadOf(1090),
        stepIndex: 0,
        nudgeRetries: 1,
      });
    }
    expect(s.sent).toEqual([]);
    expect(await lastFollowUpOf(1090)).toBeNull();
  });

  test("(z) the retry is bounded: the episode is abandoned with a stamp once the attempts run out", async () => {
    await setAgentSteps(TWO_STEPS);
    await seedConversation(1091, { lastFollowUpAt: null });
    const s = stubClient();
    const job: ClaimedJob = {
      ...jobFor(1091, 0),
      payload: {
        threadId: threadOf(1091),
        stepIndex: 0,
        nudgeRetries: NUDGE_RETRY_LIMIT - 1,
      },
    };
    const result = await withUnresolvableCredential(() =>
      followUpHandler(job, appDb, {
        makeModel: fakeModel,
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      }),
    );
    expect(result).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
    // Stamped WITHOUT posting: the sweep re-enqueues any conversation with no stamp, so giving up
    // without one would loop instead of ending.
    expect(await lastFollowUpOf(1091)).not.toBeNull();
  });

  test("(x) an impossible calendar date never suppresses (no Date.parse roll-over on either side)", async () => {
    await setAgentSteps([
      { delayValue: 1, delayUnit: "minutes", instructions: "" },
    ]);
    await seedConversation(1049, {
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    // NOTE: Feb 30 of NEXT year. Date.parse would roll it over to a FUTURE March 2 and suppress the
    // follow-up; parseStartMs refuses it, so no appointment is recorded at all.
    const impossibleFuture = `${new Date().getUTCFullYear() + 1}-02-30T00:00:00Z`;
    expect(await seedAppointment(1049, "ev_x", impossibleFuture)).toBe(
      "unreadable-start",
    );
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
