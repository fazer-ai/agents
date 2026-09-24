import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  memoryToForm,
  memoryToStored,
} from "@/client/pages/agents/memoryFormState";
import { buildAgentGraph } from "@/graph/graph";
import { datedHistory, historyDate } from "@/graph/history-dates";
import { ingestedMessages } from "@/graph/ingest";
import {
  conversationDividerMessage,
  humanAgentMessage,
  sentAtStamp,
  stampedSentAt,
} from "@/graph/markers";
import { runAgentTurn } from "@/graph/runtime";
import { buildThreadStateGraph } from "@/graph/thread-state";
import { countMessageTokens } from "@/graph/token-count";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { readMemoryConfig } from "@/modules/memory/settings";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #755: the history the model reads carries, in front of each message a person sent, the date
// it was sent. Without it the customer who vanished for a week and came back with "segue" was
// answered as if everything above were happening now.

const WEEK_AGO = new Date("2026-09-16T13:05:00.000Z"); // 10:05 in São Paulo
const NOW = new Date("2026-09-23T17:40:00.000Z"); // 14:40 in São Paulo
const SP = "America/Sao_Paulo";

const text = (m: BaseMessage | undefined) =>
  typeof m?.content === "string" ? m.content : JSON.stringify(m?.content);

class RecordingModel {
  seen: BaseMessage[][] = [];
  constructor(private reply = "ok") {}
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.seen.push(messages);
    return new AIMessage(this.reply);
  }
  bindTools() {
    return { invoke: (m: BaseMessage[]) => this.invoke(m) };
  }
}

describe("the date in front of a message", () => {
  test("is absolute, in the agent's timezone, in one fixed format", () => {
    expect(historyDate(WEEK_AGO, SP)).toBe("[16/09/2026 10:05]");
    expect(historyDate(WEEK_AGO, "UTC")).toBe("[16/09/2026 13:05]");
  });

  test("goes on what a person sent, and only when the instant is known", () => {
    const history = [
      new HumanMessage({
        content: "me manda o orçamento",
        additional_kwargs: sentAtStamp(WEEK_AGO),
      }),
      new AIMessage("claro, me envia o documento"),
      new HumanMessage("mensagem de antes desta mudança"),
      new HumanMessage({
        content: "segue",
        additional_kwargs: sentAtStamp(NOW),
      }),
    ];
    const shown = datedHistory(history, SP);
    expect(shown.map(text)).toEqual([
      "[16/09/2026 10:05] me manda o orçamento",
      "claro, me envia o documento",
      "mensagem de antes desta mudança",
      "[23/09/2026 14:40] segue",
    ]);
    // A copy travels to the provider; the message in state is left as it was stored.
    expect(history.map(text)).toEqual([
      "me manda o orçamento",
      "claro, me envia o documento",
      "mensagem de antes desta mudança",
      "segue",
    ]);
    // The same history renders the same bytes on the next turn, which is what the cache needs.
    expect(datedHistory(history, SP).map(text)).toEqual(shown.map(text));
  });

  test("an assistant reply is never dated, even carrying an instant", () => {
    const reply = new AIMessage({
      content: "claro",
      additional_kwargs: sentAtStamp(WEEK_AGO),
    });
    const [shown] = datedHistory([reply], SP);
    expect(shown).toBe(reply);
    expect(shown?.getType()).toBe("ai");
  });

  test("a message with parts gets the date as its own first part", () => {
    const m = new HumanMessage({
      content: [{ type: "text", text: "olha a foto" }],
      additional_kwargs: sentAtStamp(WEEK_AGO),
    });
    const [shown] = datedHistory([m], SP);
    expect(shown?.content).toEqual([
      { type: "text", text: "[16/09/2026 10:05]" },
      { type: "text", text: "olha a foto" },
    ]);
    expect(shown?.id).toBe(m.id);
    expect(shown?.additional_kwargs).toEqual(m.additional_kwargs);
  });

  test("an instant that is not one is no date at all", () => {
    expect(sentAtStamp(null)).toEqual({});
    expect(sentAtStamp(undefined)).toEqual({});
    expect(sentAtStamp(new Date(Number.NaN))).toEqual({});
    const garbled = new HumanMessage({
      content: "x",
      additional_kwargs: { fazerSentAt: "not a date" },
    });
    expect(stampedSentAt(garbled)).toBeNull();
    expect(text(datedHistory([garbled], SP)[0])).toBe("x");
  });
});

describe("who writes the instant", () => {
  test("a human agent's reply and a divider carrying the customer's words are dated", () => {
    expect(
      stampedSentAt(humanAgentMessage(900, "já enviei", "h1", WEEK_AGO)),
    ).toEqual(WEEK_AGO);
    expect(
      stampedSentAt(conversationDividerMessage(900, "oi de novo", "d1", NOW)),
    ).toEqual(NOW);
    // A bare divider is ours and was never sent by anyone.
    expect(
      stampedSentAt(conversationDividerMessage(900, undefined, "d2", NOW)),
    ).toBeNull();
  });

  test("ingestion dates what it folds in, including a late message that claims no attendance", () => {
    for (const [role, conv, divider] of [
      ["customer", 900, false],
      ["customer", 900, true],
      ["customer", null, false],
      ["human_agent", 900, false],
      ["human_agent", 900, true],
    ] as const) {
      const out = ingestedMessages(role, "oi", conv, divider, 77, WEEK_AGO);
      const dated = out.filter((m) => stampedSentAt(m) !== null);
      expect(dated.length).toBe(1);
      expect(stampedSentAt(dated[0] as BaseMessage)).toEqual(WEEK_AGO);
    }
    expect(
      ingestedMessages("customer", "oi", 900, false, 77).some(
        (m) => stampedSentAt(m) !== null,
      ),
    ).toBe(false);
  });
});

describe("the agent node", () => {
  const history = () => [
    new HumanMessage({
      content: "me manda o orçamento",
      additional_kwargs: sentAtStamp(WEEK_AGO),
    }),
    new AIMessage("claro"),
    new HumanMessage({
      content: "segue",
      additional_kwargs: sentAtStamp(NOW),
    }),
  ];

  async function sent(historyDates: { timezone: string } | null) {
    const model = new RecordingModel();
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      historyDates,
    });
    const out = await graph.invoke(
      { messages: history() },
      { configurable: { thread_id: "t" } },
    );
    return { seen: (model.seen[0] ?? []).slice(1).map(text), out };
  }

  test("sends the history dated in the agent's timezone", async () => {
    expect((await sent({ timezone: SP })).seen).toEqual([
      "[16/09/2026 10:05] me manda o orçamento",
      "claro",
      "[23/09/2026 14:40] segue",
    ]);
    expect((await sent({ timezone: "UTC" })).seen[0]).toBe(
      "[16/09/2026 13:05] me manda o orçamento",
    );
  });

  // Review r1: the date is part of what the provider receives, so the history ceiling counts it. A
  // ceiling that fits the stored text but not the dated one has to trim.
  test("the history ceiling counts each message with its date", async () => {
    const long: BaseMessage[] = [];
    for (let i = 0; i < 40; i++) {
      long.push(
        new HumanMessage({
          content: "ok",
          additional_kwargs: sentAtStamp(WEEK_AGO),
        }),
        new AIMessage("ok"),
      );
    }
    const stored = long.reduce((n, m) => n + countMessageTokens(m), 0);
    const dated = datedHistory(long, SP).reduce(
      (n, m) => n + countMessageTokens(m),
      0,
    );
    expect(dated).toBeGreaterThan(stored);
    const ceiling = Math.floor((stored + dated) / 2);
    const seen = async (historyDates: { timezone: string } | null) => {
      const model = new RecordingModel();
      const graph = buildAgentGraph({
        primary: { provider: "openai", model: "test-model" },
        model: model as unknown as BaseChatModel,
        systemPrompt: "PROMPT",
        checkpointer: new MemorySaver(),
        maxHistoryTokens: ceiling,
        historyDates,
      });
      await graph.invoke(
        { messages: long },
        { configurable: { thread_id: "ceiling" } },
      );
      const sent = (model.seen[0] ?? []).slice(1);
      return {
        n: sent.length,
        tokens: sent.reduce((n, m) => n + countMessageTokens(m), 0),
      };
    };
    expect((await seen(null)).n).toBe(long.length);
    const withDates = await seen({ timezone: SP });
    expect(withDates.n).toBeLessThan(long.length);
    expect(withDates.tokens).toBeLessThanOrEqual(ceiling);
  });

  test("switched off, sends it exactly as stored", async () => {
    expect((await sent(null)).seen).toEqual([
      "me manda o orçamento",
      "claro",
      "segue",
    ]);
  });

  test("the thread it saves holds the words, not the dates", async () => {
    const { out } = await sent({ timezone: SP });
    expect(out.messages.map(text)).toEqual([
      "me manda o orçamento",
      "claro",
      "segue",
      "ok",
    ]);
  });
});

describe("the switch", () => {
  test("is on by default and off only when said so", () => {
    expect(readMemoryConfig({}).historyDates.enabled).toBe(true);
    expect(readMemoryConfig({ memory: {} }).historyDates.enabled).toBe(true);
    expect(
      readMemoryConfig({ memory: { historyDates: { enabled: "yes" } } })
        .historyDates.enabled,
    ).toBe(true);
    for (const off of [false, "false"]) {
      expect(
        readMemoryConfig({ memory: { historyDates: { enabled: off } } })
          .historyDates.enabled,
      ).toBe(false);
    }
    // Independent of the other switch in the same block, in both directions.
    const both = readMemoryConfig({
      memory: {
        compaction: { enabled: false },
        historyDates: { enabled: false },
      },
    });
    expect(both.compaction.enabled).toBe(false);
    expect(both.historyDates.enabled).toBe(false);
    expect(
      readMemoryConfig({ memory: { compaction: { enabled: false } } })
        .historyDates.enabled,
    ).toBe(true);
  });

  test("survives the editor's round trip, which replaces the whole block", () => {
    const stored = {
      memory: {
        compaction: { enabled: true },
        historyDates: { enabled: false },
      },
    };
    const form = memoryToForm(stored);
    expect(form.historyDatesEnabled).toBe(false);
    expect(memoryToStored(form).historyDates).toEqual({ enabled: false });
    expect(memoryToForm({}).historyDatesEnabled).toBe(true);
  });
});

// The reactive turn, end to end: the instant Chatwoot recorded travels from the webhook event to the
// message in the thread, and from there, dated, to the model on the NEXT turn.
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

describe.skipIf(!dbUp)("a reactive turn", () => {
  let tenantId = 0n;
  let instanceId = 0n;
  let agentId = 0n;
  const REPLY = "Recebi, obrigado!";

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "HD", slug: `hd-${process.pid}` },
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
        systemPrompt: "Você é uma secretária prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: { split: { enabled: false } },
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `hd-route-${process.pid}`,
        name: "Atendente",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "Suporte",
        agentId: agent.id,
      },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "llm_usage",
        "agent_threads",
        "conversations",
        "contacts",
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

  const event = (
    conversationId: number,
    id: number,
    content: string,
    createdAt?: Date,
  ): NormalizedChatwootEvent => ({
    event: "message_created",
    conversationId,
    inboxId: 7,
    status: "pending",
    assigneeType: null,
    assigneeId: null,
    assigneeName: null,
    contactInboxId: null,
    message: {
      id,
      content,
      messageType: "incoming",
      private: false,
      ...(createdAt ? { createdAt } : {}),
    },
  });

  async function seed(convId: number) {
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${convId}`,
        lastEventAt: new Date(),
      },
    });
  }

  async function turn(
    ev: NormalizedChatwootEvent,
    model: RecordingModel,
    checkpointer: MemorySaver,
    sent: string[],
  ) {
    const client = {
      sendMessage: async (_c: number, content: string) => {
        sent.push(content);
        return {};
      },
    } as unknown as ChatwootClient;
    return runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: ev,
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: async () => client,
        checkpointer,
      },
    });
  }

  async function stored(checkpointer: MemorySaver, convId: number) {
    const state = await buildThreadStateGraph(checkpointer).getState({
      configurable: { thread_id: `${tenantId}:${instanceId}:${convId}` },
    });
    return ((state.values as { messages?: BaseMessage[] })?.messages ??
      []) as BaseMessage[];
  }

  test("the customer who comes back a week later is read with both dates", async () => {
    await seed(7551);
    const model = new RecordingModel(REPLY);
    const checkpointer = new MemorySaver();
    const sent: string[] = [];
    await turn(
      event(7551, 1, "me manda o orçamento", WEEK_AGO),
      model,
      checkpointer,
      sent,
    );
    await turn(event(7551, 2, "segue", NOW), model, checkpointer, sent);

    const second = (model.seen[1] ?? []).filter(
      (m) => m.getType() !== "system",
    );
    expect(second.map(text)).toEqual([
      "[16/09/2026 10:05] me manda o orçamento",
      REPLY,
      "[23/09/2026 14:40] segue",
    ]);
    // What the customer got carries no date, and what the thread keeps is the words alone.
    expect(sent).toEqual([REPLY, REPLY]);
    const kept = await stored(checkpointer, 7551);
    expect(kept.map(text)).toEqual([
      "me manda o orçamento",
      REPLY,
      "segue",
      REPLY,
    ]);
    expect(stampedSentAt(kept[0] as BaseMessage)).toEqual(WEEK_AGO);
  });

  test("a message whose instant Chatwoot did not give stays undated, never 'now'", async () => {
    await seed(7552);
    const model = new RecordingModel(REPLY);
    await turn(event(7552, 3, "oi"), model, new MemorySaver(), []);
    const human = (model.seen[0] ?? []).filter((m) => m.getType() === "human");
    expect(human.map(text)).toEqual(["oi"]);
  });

  test("the agent that turned it off gets the history as it always did", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          split: { enabled: false },
          memory: { historyDates: { enabled: false } },
        },
      },
    });
    try {
      await seed(7553);
      const model = new RecordingModel(REPLY);
      await turn(event(7553, 4, "oi", NOW), model, new MemorySaver(), []);
      const human = (model.seen[0] ?? []).filter(
        (m) => m.getType() === "human",
      );
      expect(human.map(text)).toEqual(["oi"]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { split: { enabled: false } } },
      });
    }
  });
});
