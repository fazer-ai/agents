import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import type { Semaphore } from "@/lib/semaphore";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { summarizeTranscript } from "@/modules/memory/summarize";
import { SUMMARY_MIN_INTERVAL_MS } from "@/modules/other-inboxes/context";
import { runOtherInboxSummary } from "@/modules/other-inboxes/summary-job";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";
import { UsageReportingModel } from "../utils/scripted-models";

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;

const INBOX_B = 202;
const CONV = 40;
const NOW = Date.UTC(2026, 9, 10, 15, 0, 0);

let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let jobId = 0n;

type RawMessage = Record<string, unknown>;
const incoming = (id: number, content: string): RawMessage => ({
  id,
  content,
  message_type: 0,
  private: false,
  sender: { type: "contact", id: 1 },
});
const note = (id: number, content: string): RawMessage => ({
  id,
  content,
  message_type: 1,
  private: true,
  sender: { type: "user", id: 3 },
});

function chatwoot(messages: RawMessage[], liveInboxId = INBOX_B) {
  return {
    async getConversation(id: number) {
      return { id, inbox_id: liveInboxId };
    },
    async getMessages(_id: number, q?: { before?: number }) {
      const before = q?.before;
      const older =
        before === undefined
          ? messages
          : messages.filter((m) => (m.id as number) < before);
      return { payload: older.slice(-20) };
    },
  } as unknown as ChatwootClient;
}

function job(): ClaimedJob {
  return {
    id: jobId,
    tenantId,
    kind: "OTHER_INBOX_SUMMARY",
    payload: {
      instanceId: String(instanceId),
      conversationId: CONV,
      chatwootInboxId: INBOX_B,
      agentId: String(agentId),
    },
    attempts: 0,
    claimSeq: 1,
  };
}

async function setAgent(settings: object) {
  await suDb.agent.update({
    where: { id: agentId },
    data: { settings: settings as never },
  });
}

function on(inboxId = INBOX_B) {
  return {
    otherInboxes: {
      enabled: true,
      inboxes: [{ instanceId: Number(instanceId), inboxId }],
    },
  };
}

function override(compaction: object = {}) {
  return {
    ...on(),
    memory: {
      compaction: {
        enabled: true,
        provider: "openai",
        model: "resumo-teste",
        credentialRef: null,
        ...compaction,
      },
    },
  };
}

describe.skipIf(!dbUp)("the summary of a conversation in another inbox", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "OIS", slug: `ois-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 13,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_B,
        name: "Email",
        channelType: "Channel::Email",
      },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Bot",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "modelo-do-agente" },
        settings: {},
      },
    });
    agentId = agent.id;
    jobId = await burnSchedulerJobId(suDb);
  });

  beforeEach(async () => {
    await suDb.otherInboxSummary.deleteMany({ where: { tenantId } });
    await suDb.llmUsage.deleteMany({ where: { tenantId } });
    await setAgent(on());
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "other_inbox_summaries",
        "llm_usage",
        "inboxes",
        "vault_entries",
        "agents",
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
  });

  const messages = [
    incoming(1, "TOKEN-BL1 primeira"),
    incoming(2, "TOKEN-BL9 ultima"),
    note(3, "TOKEN-NOTA"),
  ];

  async function runWith(
    model: UsageReportingModel,
    over: { now?: number; over?: boolean; msgs?: RawMessage[] } = {},
  ) {
    const built: string[] = [];
    const keys: string[] = [];
    const result = await runOtherInboxSummary(job(), suDb, {
      now: () => over.now ?? NOW,
      loadClient: async () => chatwoot(over.msgs ?? messages),
      makeModel: (mc) => {
        built.push(mc.model);
        keys.push(mc.apiKey);
        return model;
      },
      spendCeiling: async () =>
        ({ state: over.over ? "over" : "under" }) as Awaited<
          ReturnType<
            typeof import("@/modules/spend-ceiling/service").spendCeilingVerdict
          >
        >,
    });
    return { result, built, keys };
  }

  test("summarizes the public messages and stores what it covers", async () => {
    const model = new UsageReportingModel(["RESUMO-1"]);
    const { result, built } = await runWith(model);
    expect(result).toEqual({ outcome: "done" });
    expect(built).toEqual(["modelo-do-agente"]);
    expect(model.calls[0]).toContain("TOKEN-BL1");
    expect(model.calls[0]).toContain("TOKEN-BL9");
    expect(model.calls[0]).not.toContain("TOKEN-NOTA");
    const row = await suDb.otherInboxSummary.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: CONV },
    });
    expect(row.summary).toBe("RESUMO-1");
    expect(row.coveredMessageId).toBe(2);
    expect(row.generatedAt.getTime()).toBe(NOW);
    const usage = await suDb.llmUsage.findMany({ where: { tenantId } });
    expect(usage.map((u) => u.node)).toEqual(["other_inbox_summary"]);
    // No conversation mirror here (a conversation only people handle has none): the cost still lands
    // on the inbox, so the dashboard's per-inbox filter counts it.
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: INBOX_B },
    });
    expect(usage[0]?.inboxId).toBe(inbox.id);
  });

  test("runs on the memory compaction override when the agent has one", async () => {
    await setAgent(override());
    const { built } = await runWith(new UsageReportingModel(["R"]));
    expect(built).toEqual(["resumo-teste"]);
    const usage = await suDb.llmUsage.findFirstOrThrow({ where: { tenantId } });
    expect(usage.model).toBe("resumo-teste");
  });

  test("waits out the minimum interval since the last summary", async () => {
    await runWith(new UsageReportingModel(["R1"]));
    const model = new UsageReportingModel(["R2"]);
    const { result } = await runWith(model, {
      now: NOW + 5 * 60_000,
      msgs: [...messages, incoming(4, "TOKEN-NOVA")],
    });
    expect(result).toEqual({
      outcome: "reschedule",
      runAt: new Date(NOW + SUMMARY_MIN_INTERVAL_MS),
    });
    expect(model.calls).toHaveLength(0);
  });

  test("past the interval, only new public messages pay for a new summary", async () => {
    await runWith(new UsageReportingModel(["R1"]));
    const later = NOW + SUMMARY_MIN_INTERVAL_MS + 60_000;
    const idle = new UsageReportingModel(["R2"]);
    await runWith(idle, {
      now: later,
      msgs: [...messages, note(4, "TOKEN-NOTA2")],
    });
    expect(idle.calls).toHaveLength(0);

    const fresh = new UsageReportingModel(["R3"]);
    await runWith(fresh, {
      now: later,
      msgs: [...messages, incoming(5, "TOKEN-NOVA")],
    });
    expect(fresh.calls[0]).toContain("TOKEN-NOVA");
    const row = await suDb.otherInboxSummary.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: CONV },
    });
    expect(row.summary).toBe("R3");
    expect(row.coveredMessageId).toBe(5);
  });

  test("a tenant past its spend ceiling gets no call and no row", async () => {
    const model = new UsageReportingModel(["R"]);
    const { result } = await runWith(model, { over: true });
    expect(result).toEqual({ outcome: "done" });
    expect(model.calls).toHaveLength(0);
    expect(await suDb.otherInboxSummary.count({ where: { tenantId } })).toBe(0);
  });

  test("an agent that no longer reads other inboxes gets nothing", async () => {
    await setAgent({});
    const model = new UsageReportingModel(["R"]);
    const { result } = await runWith(model);
    expect(result).toEqual({ outcome: "done" });
    expect(model.calls).toHaveLength(0);
  });

  test("an override with its own key uses it even with memory compaction off", async () => {
    const entry = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: `resumo-${process.pid}`,
        secret: encryptJson("sk-proprio"),
      },
    });
    await setAgent(
      override({ enabled: false, credentialRef: `vault:${entry.id}` }),
    );
    const model = new UsageReportingModel(["R"]);
    const { result, built, keys } = await runWith(model);
    expect(result).toEqual({ outcome: "done" });
    expect(built).toEqual(["resumo-teste"]);
    expect(keys).toEqual(["sk-proprio"]);
  });

  test("an inbox the operator removed after the arm is not read", async () => {
    await setAgent(on(INBOX_B + 1));
    const model = new UsageReportingModel(["R"]);
    let read = false;
    const result = await runOtherInboxSummary(job(), suDb, {
      now: () => NOW,
      loadClient: async () => {
        read = true;
        return chatwoot(messages);
      },
      makeModel: () => model,
    });
    expect(result).toEqual({ outcome: "done" });
    expect(read).toBe(false);
    expect(model.calls).toHaveLength(0);
  });

  test("the transcript handed to the summarizer fits the agent's history budget", async () => {
    await setAgent({ ...on(), limits: { maxHistoryTokens: 2000 } });
    const model = new UsageReportingModel(["R"]);
    await runWith(model, {
      msgs: [
        incoming(1, `TOKEN-ANTIGA ${"palavra ".repeat(3000)}`),
        incoming(2, "TOKEN-RECENTE"),
      ],
    });
    expect(model.calls[0]).toContain("TOKEN-RECENTE");
    expect(model.calls[0]).not.toContain("TOKEN-ANTIGA");
  });

  test("a message longer than the history budget keeps its sender on the cut line", async () => {
    await setAgent({ ...on(), limits: { maxHistoryTokens: 2000 } });
    const model = new UsageReportingModel(["R"]);
    await runWith(model, {
      msgs: [incoming(1, `TOKEN-INICIO ${"palavra ".repeat(3000)}TOKEN-FIM`)],
    });
    expect(model.calls[0]).toContain("TOKEN-FIM");
    expect(model.calls[0]).toContain("Cliente: […] ");
  });

  test("an edit under the same id is summarized again past the interval", async () => {
    await runWith(new UsageReportingModel(["R1"]));
    const edited = [
      incoming(1, "TOKEN-BL1 primeira"),
      incoming(2, "TOKEN-CORRIGIDA"),
      note(3, "TOKEN-NOTA"),
    ];
    const model = new UsageReportingModel(["R2"]);
    await runWith(model, {
      now: NOW + SUMMARY_MIN_INTERVAL_MS + 60_000,
      msgs: edited,
    });
    expect(model.calls[0]).toContain("TOKEN-CORRIGIDA");
    const row = await suDb.otherInboxSummary.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: CONV },
    });
    expect(row.summary).toBe("R2");
  });

  test("a summary model that cannot run fails as configuration even past the ceiling", async () => {
    await setAgent(override({ credentialRef: "vault:999999999" }));
    const model = new UsageReportingModel(["R"]);
    const { result } = await runWith(model, { over: true });
    expect(result).toEqual({
      outcome: "fail",
      error: "other inbox summary model: credential_not_found",
    });
  });

  test("a slow provider gets the agent's model-call budget, not compaction's sixty seconds", async () => {
    const asked: number[] = [];
    const timeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms: number) => {
      asked.push(ms);
      return timeout.call(AbortSignal, ms);
    };
    try {
      await runWith(new UsageReportingModel(["R"]));
    } finally {
      AbortSignal.timeout = timeout;
    }
    expect(asked.length).toBeGreaterThan(0);
    expect(Math.min(...asked)).toBe(config.agent.modelCallTimeoutMs);
    expect(config.agent.modelCallTimeoutMs).toBeGreaterThan(60_000);
  });

  test("a /reset landing during the model call keeps the summary from being written", async () => {
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: INBOX_B },
    });
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inbox.id,
        chatwootConversationId: CONV,
        status: "open",
        threadId: `${tenantId}:${instanceId}:${CONV}`,
        lastEventAt: new Date(),
      },
    });
    class ResetDuringCall extends UsageReportingModel {
      override async _generate(
        ...args: Parameters<UsageReportingModel["_generate"]>
      ) {
        await suDb.conversation.update({
          where: { id: conv.id },
          data: { resetAtMessageId: 2 },
        });
        return super._generate(...args);
      }
    }
    try {
      const model = new ResetDuringCall(["RESUMO-ANTES-DO-RESET"]);
      const { result } = await runWith(model);
      expect(result).toEqual({ outcome: "done" });
      expect(model.calls).toHaveLength(1);
      expect(await suDb.otherInboxSummary.count({ where: { tenantId } })).toBe(
        0,
      );
    } finally {
      await suDb.conversation.delete({ where: { id: conv.id } });
    }
  });

  test("a /reset landing while the conversation is read spends nothing", async () => {
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: INBOX_B },
    });
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inbox.id,
        chatwootConversationId: CONV,
        status: "open",
        threadId: `${tenantId}:${instanceId}:${CONV}`,
        lastEventAt: new Date(),
      },
    });
    const client = chatwoot(messages);
    const getMessages = (
      client as unknown as {
        getMessages: (...a: unknown[]) => Promise<unknown>;
      }
    ).getMessages.bind(client);
    (client as unknown as Record<string, unknown>).getMessages = async (
      ...a: unknown[]
    ) => {
      await suDb.conversation.update({
        where: { id: conv.id },
        data: { resetAtMessageId: 2 },
      });
      return getMessages(...a);
    };
    let ceilingAsked = 0;
    try {
      const model = new UsageReportingModel(["RESUMO"]);
      const result = await runOtherInboxSummary(job(), suDb, {
        now: () => NOW,
        loadClient: async () => client,
        makeModel: () => model,
        spendCeiling: async () => {
          ceilingAsked += 1;
          return { state: "under" } as unknown as Awaited<
            ReturnType<
              typeof import("@/modules/spend-ceiling/service").spendCeilingVerdict
            >
          >;
        },
      });
      expect(result).toEqual({ outcome: "done" });
      expect(model.calls).toHaveLength(0);
      expect(ceilingAsked).toBe(0);
    } finally {
      await suDb.conversation.delete({ where: { id: conv.id } });
    }
  });

  test("a conversation moved to another picked inbox is not read under the old inbox's provider", async () => {
    await setAgent({
      otherInboxes: {
        enabled: true,
        inboxes: [
          { instanceId: Number(instanceId), inboxId: INBOX_B },
          { instanceId: Number(instanceId), inboxId: INBOX_B + 7 },
        ],
      },
    });
    const model = new UsageReportingModel(["R"]);
    const client = chatwoot(messages, INBOX_B + 7);
    let readMessages = false;
    try {
      const result = await runOtherInboxSummary(job(), suDb, {
        now: () => NOW,
        loadClient: async () =>
          ({
            ...client,
            getConversation: client.getConversation,
            getMessages: async (
              ...a: Parameters<typeof client.getMessages>
            ) => {
              readMessages = true;
              return client.getMessages(...a);
            },
          }) as unknown as ChatwootClient,
        makeModel: () => model,
      });
      expect(result).toEqual({ outcome: "done" });
      expect(readMessages).toBe(false);
      expect(model.calls).toHaveLength(0);
    } finally {
      await setAgent(on());
    }
  });

  test("a run past the scheduler's deadline neither calls the model nor writes", async () => {
    const model = new UsageReportingModel(["RESUMO-TARDIO"]);
    const ac = new AbortController();
    ac.abort();
    const result = await runOtherInboxSummary(job(), suDb, {
      now: () => NOW,
      loadClient: async () => chatwoot(messages),
      makeModel: () => model,
      signal: ac.signal,
    });
    expect(result.outcome).toBe("fail");
    expect(model.calls).toHaveLength(0);
    expect(await suDb.otherInboxSummary.count({ where: { tenantId } })).toBe(0);
  });

  test("a run cancelled while waiting for model capacity leaves the queue without calling", async () => {
    const sem = (globalThis as unknown as Record<symbol, Semaphore>)[
      Symbol.for("fazerai.model.semaphore")
    ] as Semaphore;
    const held: (() => void)[] = [];
    for (let r = sem.tryAcquire(); r; r = sem.tryAcquire()) held.push(r);
    try {
      const model = new UsageReportingModel(["R"]);
      const ac = new AbortController();
      ac.abort();
      const out = await summarizeTranscript(
        model,
        "s",
        "Cliente: oi",
        100,
        undefined,
        1_000,
        ac.signal,
      );
      expect(out.error).toBeDefined();
      expect(model.calls).toHaveLength(0);
    } finally {
      for (const r of held) r();
    }
  });

  test("a deadline that fires during the model call keeps the summary from being written", async () => {
    const ac = new AbortController();
    class AbortDuringCall extends UsageReportingModel {
      override async _generate(
        ...args: Parameters<UsageReportingModel["_generate"]>
      ) {
        const out = await super._generate(...args);
        ac.abort();
        return out;
      }
    }
    const model = new AbortDuringCall(["RESUMO-TARDIO"]);
    const result = await runOtherInboxSummary(job(), suDb, {
      now: () => NOW,
      loadClient: async () => chatwoot(messages),
      makeModel: () => model,
      signal: ac.signal,
    });
    expect(result.outcome).toBe("fail");
    expect(await suDb.otherInboxSummary.count({ where: { tenantId } })).toBe(0);
  });

  // A model whose adapter does not end its call on the signal: the deadline still ends the run.
  test("a deadline during a call the adapter does not stop ends the run", async () => {
    const ac = new AbortController();
    class DeafToSignal extends UsageReportingModel {
      override async _generate(): Promise<never> {
        ac.abort();
        return new Promise<never>(() => {});
      }
    }
    const result = await runOtherInboxSummary(job(), suDb, {
      now: () => NOW,
      loadClient: async () => chatwoot(messages),
      makeModel: () => new DeafToSignal(["R"]),
      signal: ac.signal,
    });
    expect(result).toEqual({ outcome: "fail", error: "deadline" });
    expect(await suDb.otherInboxSummary.count({ where: { tenantId } })).toBe(0);
  });

  test("a conversation now in an inbox the agent does not read is not read", async () => {
    const model = new UsageReportingModel(["R"]);
    let readMessages = false;
    const client = chatwoot(messages, INBOX_B + 7);
    const result = await runOtherInboxSummary(job(), suDb, {
      now: () => NOW,
      loadClient: async () =>
        ({
          ...client,
          getConversation: client.getConversation,
          getMessages: async (...a: Parameters<typeof client.getMessages>) => {
            readMessages = true;
            return client.getMessages(...a);
          },
        }) as unknown as ChatwootClient,
      makeModel: () => model,
    });
    expect(result).toEqual({ outcome: "done" });
    expect(readMessages).toBe(false);
    expect(model.calls).toHaveLength(0);
  });
});
