import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId } from "@/graph/checkpointer";
import { ChatwootClient } from "@/modules/chatwoot/client";
import { __resetChatwootVocabCache } from "@/modules/chatwoot/vocab";
import { runObserve } from "@/modules/observe/job";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// The `decisions` engine of a monitoring agent (docs/decisions.md): the tick reads the
// conversation as it always has, asks a classification API typed questions instead of running the
// model, and turns answers that cross a rule's threshold into the rule's tool call through the SAME
// tool objects the LLM observer uses. Providers are doubles in the documented shapes; the real APIs
// are exercised in the PR's live validation.

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

const INBOX_ID = 93;
const OUR_BOT = 31;
const CONV = 9301;
const CUSTOMER_TEXT =
  "Quero meu dinheiro de volta do pedido 4471, MARCADOR-1135";
let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let convRowId = 0n;
let keyRef = "";

interface ClientLog {
  labelsWritten: string[][];
  notes: string[];
  attributes: Record<string, unknown>[];
  publicSends: number;
}

// Rows a test appends after the customer's message, read on every fetch until it clears them.
let extraMessages: Record<string, unknown>[] = [];

function stubClient(labels: string[], log: ClientLog): ChatwootClient {
  return {
    getMessages: async () => ({
      payload: [
        {
          id: 11,
          content: CUSTOMER_TEXT,
          message_type: 0,
          private: false,
          attachments: [],
        },
        ...extraMessages,
      ],
    }),
    getConversationLabels: async () => [...labels],
    setConversationLabels: async (_id: number, next: string[]) => {
      log.labelsWritten.push(next);
      labels.splice(0, labels.length, ...next);
      return {};
    },
    sendPrivateNote: async (_id: number, text: string) => {
      log.notes.push(text);
      return {};
    },
    updateConversationCustomAttributes: async (
      _id: number,
      attrs: Record<string, unknown>,
    ) => {
      log.attributes.push(attrs);
      return {};
    },
    sendMessage: async () => {
      log.publicSends++;
      return {};
    },
    toggleTyping: async () => {
      log.publicSends++;
      return {};
    },
  } as unknown as ChatwootClient;
}

// A provider double: records each request it receives and answers what the test scripted.
function providerDouble(answer: (body: Record<string, unknown>) => Response) {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    requests.push({ url: String(input), body });
    return answer(body);
  }) as typeof fetch;
  return { requests, fetchImpl };
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// TypeSafe's documented shape (docs.typesafe.ai/api).
function typesafeAnswer(answers: Record<string, unknown>) {
  return json({
    model: "jev-1.13.0",
    answers,
    usage: { input_tokens: 1000, output_tokens: 60 },
  });
}

const QUESTIONS = [
  {
    name: "pede_reembolso",
    type: "yes_no",
    instructions: "O cliente pede o dinheiro de volta?",
  },
  {
    name: "assunto",
    type: "choice",
    instructions: "Assunto principal",
    options: [
      { value: "reembolso", description: "estorno ou reembolso" },
      { value: "troca", description: "troca de ingresso" },
      { value: "duvida", description: "outra dúvida" },
    ],
  },
  {
    name: "irritacao",
    type: "score",
    instructions: "Quão irritado está o cliente?",
    levels: [
      { value: "calmo", description: "" },
      { value: "frustrado", description: "" },
      { value: "muito_irritado", description: "" },
    ],
  },
];

async function setMonitoring(monitoring: Record<string, unknown>) {
  await suDb.agent.update({
    where: { id: agentId },
    data: { settings: { monitoring } as never },
  });
}

function decisionsBlock(over: Record<string, unknown> = {}) {
  return {
    engine: "decisions",
    decisions: {
      provider: "typesafe",
      credentialRef: keyRef,
      questions: QUESTIONS,
      rules: [
        {
          when: [{ question: "pede_reembolso", minProbability: 0.7 }],
          action: { tool: "set_labels", args: { add: ["reembolso"] } },
        },
      ],
      apply: "enforce",
      ...over,
    },
  };
}

// A chat model that counts calls, so a test can assert the `decisions` engine never runs the graph.
class CountingModel {
  calls = 0;
  async invoke() {
    this.calls++;
    return new AIMessage("");
  }
  bindTools() {
    const self = this;
    return {
      async invoke() {
        self.calls++;
        return new AIMessage("nada.");
      },
    };
  }
}

const observeLines = () =>
  flowLogRows(suDb, {
    where: { conversationId: convRowId, stage: "observe" },
    orderBy: { id: "asc" },
    select: {
      status: true,
      level: true,
      detail: true,
      provider: true,
      model: true,
      errorMessage: true,
    },
  });
const lastLine = async () => {
  const l = (await observeLines()).at(-1);
  if (!l) throw new Error("no observe line");
  return l;
};
const detail = async () => (await lastLine()).detail as Record<string, unknown>;
const usageRows = () =>
  suDb.llmUsage.findMany({
    where: { tenantId, conversationId: convRowId },
    orderBy: { id: "asc" },
    select: {
      node: true,
      model: true,
      promptTokens: true,
      completionTokens: true,
      costUsd: true,
    },
  });

async function tick(
  fetchImpl: typeof fetch,
  labels: string[] = [],
  extra: {
    afterFailure?: "retry" | "dead_letter";
    timeoutMs?: number;
    slowNotes?: number;
  } = {},
) {
  const log: ClientLog = {
    labelsWritten: [],
    notes: [],
    attributes: [],
    publicSends: 0,
  };
  const model = new CountingModel();
  const { slowNotes, ...deps } = extra;
  const client = stubClient(labels, log);
  if (slowNotes !== undefined) {
    // A write that hangs past the tick's deadline (a keyed queue the signal does not cancel).
    (client as unknown as { sendPrivateNote: unknown }).sendPrivateNote = () =>
      new Promise((resolve) => setTimeout(() => resolve({}), slowNotes));
  }
  const res = await runObserve(
    tenantId,
    {
      instanceId,
      conversationId: CONV,
      agentId,
      reason: "burst",
      atMessageId: null,
    },
    appDb,
    {
      makeClient: async () => client,
      makeModel: () => model as never,
      decisionFetch: fetchImpl,
      ...deps,
    },
  );
  return { log, model, res };
}

describe.skipIf(!dbUp)("the decisions engine of a monitoring agent", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DEC", slug: `dec-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 63,
      baseUrl: "https://chat.decisions.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "typesafe-teste", secret: encryptJson("ts-key") },
      select: { id: true },
    });
    keyRef = `vault:${key.id}`;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Classificadora",
        systemPrompt: "Você classifica conversas.",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        enabled: true,
        mode: "monitoring",
        settings: {},
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId,
        chatwootAgentBotId: OUR_BOT,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `dec-route-${process.pid}`,
        name: "Classificadora",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_ID,
        name: "SAC",
      },
    });
    await suDb.inboxObserver.create({
      data: { tenantId, inboxId: inbox.id, agentId },
    });
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: CONV,
        inboxId: inbox.id,
        status: "open",
        threadId: chatwootThreadId(tenantId, instanceId, CONV),
      },
    });
    convRowId = conv.id;
  });

  beforeEach(() => {
    __resetChatwootVocabCache();
  });

  afterAll(async () => {
    if (!dbUp) return;
    for (const table of [
      "execution_logs",
      "llm_usage",
      "scheduler_jobs",
      "conversations",
      "inbox_observers",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
      "vault_entries",
      "chatwoot_instances",
      "chatwoot_deployments",
      "tenants",
    ]) {
      await suDb
        .$executeRawUnsafe(
          table === "tenants"
            ? `DELETE FROM tenants WHERE id = ${tenantId}`
            : `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        )
        .catch(() => {});
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("without the engine key the tick runs the model and never calls a provider", async () => {
    await setMonitoring({ decisions: decisionsBlock().decisions });
    const p = providerDouble(() => typesafeAnswer({}));
    const { model } = await tick(p.fetchImpl);
    expect(p.requests).toHaveLength(0);
    expect(model.calls).toBeGreaterThan(0);
    const d = await detail();
    expect(d.engine).toBeUndefined();
    expect(Object.keys(d).sort()).toEqual(
      ["acted", "labelsBefore", "messagesRead", "reason", "toolCalls"].sort(),
    );
  });

  test("an unknown engine value reads as llm", async () => {
    await setMonitoring({ ...decisionsBlock(), engine: "xyz" });
    const p = providerDouble(() => typesafeAnswer({}));
    const { model } = await tick(p.fetchImpl);
    expect(p.requests).toHaveLength(0);
    expect(model.calls).toBeGreaterThan(0);
  });

  test("the evidence names the instance's AI agent and a person apart", async () => {
    await setMonitoring(decisionsBlock());
    // A bot id of ANOTHER instance of the same tenant: bot ids are per Chatwoot server, so on this
    // one the same number is somebody else's bot.
    const OTHER_BOT = 4242;
    const other = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 64,
      baseUrl: "https://chat.other.example",
      adminToken: encryptJson("ADMIN2"),
    });
    const otherAgent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Outra",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        enabled: true,
        mode: "agent",
        settings: {},
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: other.id,
        agentId: otherAgent.id,
        chatwootAgentBotId: OTHER_BOT,
        accessToken: encryptJson("BOT2"),
        webhookSecret: encryptJson("S2"),
        webhookRouteTokenHash: `dec-route-other-${process.pid}`,
        name: "Outra",
      },
    });
    extraMessages = [
      {
        id: 15,
        content: "Eco do telefone",
        message_type: 1,
        private: false,
        attachments: [],
        content_attributes: { external_sender_name: "WhatsApp" },
      },
      {
        id: 14,
        content: "Bot de outra instância",
        message_type: 1,
        private: false,
        attachments: [],
        sender: { type: "agent_bot", id: OTHER_BOT },
      },
      {
        id: 12,
        content: "Resposta da assistente",
        message_type: 1,
        private: false,
        attachments: [],
        sender: { type: "agent_bot", id: OUR_BOT },
      },
      {
        id: 13,
        content: "Resposta da atendente",
        message_type: 1,
        private: false,
        attachments: [],
        sender: { type: "user", id: 7 },
      },
    ];
    try {
      const p = providerDouble(() =>
        typesafeAnswer({
          pede_reembolso: { type: "noul", noul: 0.1 },
          assunto: {
            type: "choice",
            choice: "duvida",
            confidence: 0.9,
            probabilities: { reembolso: 0.05, troca: 0.05, duvida: 0.9 },
          },
          irritacao: {
            type: "score",
            score: 0.2,
            confidence: 0.6,
            probabilities: { "0": 0.8, "1": 0.1, "2": 0.1 },
          },
        }),
      );
      await tick(p.fetchImpl);
      const state = String(p.requests[0]?.body.state);
      expect(state).toContain("Assistente virtual: Resposta da assistente");
      expect(state).toContain("Atendente (pessoa): Resposta da atendente");
      expect(state).toContain("Atendente: Bot de outra instância");
      // The test inbox names no provider, so the phone marker is not trusted to name a person.
      expect(state).toContain("Atendente: Eco do telefone");
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        data: { provider: "baileys" },
      });
      const p2 = providerDouble(() =>
        typesafeAnswer({
          pede_reembolso: { type: "noul", noul: 0.1 },
          assunto: {
            type: "choice",
            choice: "duvida",
            confidence: 0.9,
            probabilities: { reembolso: 0.05, troca: 0.05, duvida: 0.9 },
          },
          irritacao: {
            type: "score",
            score: 0.2,
            confidence: 0.6,
            probabilities: { "0": 0.8, "1": 0.1, "2": 0.1 },
          },
        }),
      );
      await tick(p2.fetchImpl);
      expect(String(p2.requests[0]?.body.state)).toContain(
        "Atendente (pessoa): Eco do telefone",
      );
    } finally {
      extraMessages = [];
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        data: { provider: null },
      });
    }
  });

  test("enforce: an answer over the threshold runs the rule's tool, and nothing else", async () => {
    await setMonitoring(decisionsBlock());
    const before = (await usageRows()).length;
    const p = providerDouble(() =>
      typesafeAnswer({
        pede_reembolso: { type: "noul", noul: 0.92 },
        assunto: {
          type: "choice",
          choice: "reembolso",
          confidence: 0.9,
          probabilities: { reembolso: 0.95, troca: 0.03, duvida: 0.02 },
        },
        irritacao: {
          type: "score",
          score: 1.1,
          confidence: 0.6,
          probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
        },
      }),
    );
    const { log, model } = await tick(p.fetchImpl);
    expect(model.calls).toBe(0);
    expect(log.labelsWritten).toEqual([["reembolso"]]);
    expect(log.notes).toEqual([]);
    expect(log.publicSends).toBe(0);

    // The request: the official endpoint, the alias, the questions map in TypeSafe's dialect, and
    // the evidence only, not the model-facing frame.
    expect(p.requests).toHaveLength(1);
    const req = p.requests[0];
    expect(req?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(req?.body.model).toBe("jev-latest");
    const qs = req?.body.questions as Record<string, Record<string, unknown>>;
    expect(qs.pede_reembolso?.type).toBe("noul");
    expect(qs.assunto?.criteria).toEqual({
      reembolso: "estorno ou reembolso",
      troca: "troca de ingresso",
      duvida: "outra dúvida",
    });
    expect(Array.isArray(qs.irritacao?.criteria)).toBe(true);
    const state = String(req?.body.state);
    expect(state).toContain("MARCADOR-1135");
    expect(state).not.toContain("Turno de observação");

    const line = await lastLine();
    expect(line.status).toBe("ok");
    expect(line.level).toBe("info");
    expect(line.provider).toBe("typesafe");
    expect(line.model).toBe("jev-latest");
    const d = line.detail as Record<string, unknown>;
    expect(d.engine).toBe("decisions");
    expect(d.apply).toBe("enforce");
    expect(d.acted).toBe(true);
    expect(d.modelVersion).toBe("jev-1.13.0");
    expect(d.actions).toEqual([
      { rule: 0, tool: "set_labels", outcome: "ran" },
    ]);
    expect((d.answers as Record<string, unknown>).pede_reembolso).toEqual({
      type: "yes_no",
      probability: 0.92,
    });
    // A score's probabilities are keyed by the level's value, as a choice's are by the option's.
    expect(
      (d.answers as Record<string, { probabilities: unknown }>).irritacao
        ?.probabilities,
    ).toEqual({ calmo: 0.1, frustrado: 0.7, muito_irritado: 0.2 });
    expect(JSON.stringify(d)).not.toContain("MARCADOR-1135");

    // Billed on input only, at TypeSafe's published price, under its own node.
    const rows = (await usageRows()).slice(before);
    expect(rows.map((r) => r.node)).toEqual(["decision"]);
    expect(rows[0]?.promptTokens).toBe(1000);
    expect(rows[0]?.completionTokens).toBe(0);
    expect(Number(rows[0]?.costUsd)).toBeCloseTo(0.000042, 9);
  });

  test("shadow decides, logs what would run and pays for the call, and writes nothing", async () => {
    await setMonitoring(decisionsBlock({ apply: "shadow" }));
    const before = (await usageRows()).length;
    const p = providerDouble(() =>
      typesafeAnswer({ pede_reembolso: { type: "noul", noul: 0.99 } }),
    );
    const { log } = await tick(p.fetchImpl);
    expect(log.labelsWritten).toEqual([]);
    expect(log.notes).toEqual([]);
    const d = await detail();
    expect(d.apply).toBe("shadow");
    expect(d.acted).toBe(false);
    expect(d.actions).toEqual([
      { rule: 0, tool: "set_labels", outcome: "shadow" },
    ]);
    expect((await usageRows()).slice(before).map((r) => r.node)).toEqual([
      "decision",
    ]);
  });

  test("below the threshold nothing runs, and the line says which question and by how much", async () => {
    await setMonitoring(decisionsBlock());
    const p = providerDouble(() =>
      typesafeAnswer({ pede_reembolso: { type: "noul", noul: 0.69 } }),
    );
    const { log } = await tick(p.fetchImpl);
    expect(log.labelsWritten).toEqual([]);
    const d = await detail();
    expect(d.acted).toBe(false);
    expect(d.actions).toEqual([]);
    expect(d.notFired).toEqual([
      {
        rule: 0,
        miss: {
          question: "pede_reembolso",
          why: "below_threshold",
          got: 0.69,
          threshold: 0.7,
          measure: "probability",
        },
      },
    ]);
  });

  test("a probability exactly at the threshold fires: the threshold is a minimum", async () => {
    await setMonitoring(decisionsBlock());
    const p = providerDouble(() =>
      typesafeAnswer({ pede_reembolso: { type: "noul", noul: 0.7 } }),
    );
    const { log } = await tick(p.fetchImpl);
    expect(log.labelsWritten).toEqual([["reembolso"]]);
  });

  test("a provider that omits confidence does not pass a condition that asks for one", async () => {
    await setMonitoring(
      decisionsBlock({
        rules: [
          {
            when: [
              { question: "assunto", equals: "reembolso", minConfidence: 0.5 },
            ],
            action: { tool: "set_labels", args: { add: ["reembolso"] } },
          },
        ],
      }),
    );
    const p = providerDouble(() =>
      typesafeAnswer({
        assunto: { type: "choice", choice: "reembolso", probabilities: {} },
      }),
    );
    const { log } = await tick(p.fetchImpl);
    expect(log.labelsWritten).toEqual([]);
    expect(((await detail()).notFired as { miss: unknown }[])[0]?.miss).toEqual(
      {
        question: "assunto",
        why: "below_threshold",
        got: null,
        threshold: 0.5,
        measure: "confidence",
      },
    );
  });

  test("a choice with the right option but low confidence does not fire; conditions combine with AND", async () => {
    await setMonitoring(
      decisionsBlock({
        rules: [
          {
            when: [
              { question: "pede_reembolso", minProbability: 0.7 },
              { question: "assunto", equals: "reembolso", minConfidence: 0.8 },
            ],
            action: {
              tool: "set_labels",
              args: { add: ["reembolso-confirmado"] },
            },
          },
        ],
      }),
    );
    const low = providerDouble(() =>
      typesafeAnswer({
        pede_reembolso: { type: "noul", noul: 0.95 },
        assunto: {
          type: "choice",
          choice: "reembolso",
          confidence: 0.5,
          probabilities: {},
        },
      }),
    );
    const a = await tick(low.fetchImpl);
    expect(a.log.labelsWritten).toEqual([]);
    expect(((await detail()).notFired as { miss: unknown }[])[0]?.miss).toEqual(
      {
        question: "assunto",
        why: "below_threshold",
        got: 0.5,
        threshold: 0.8,
        measure: "confidence",
      },
    );
    const high = providerDouble(() =>
      typesafeAnswer({
        pede_reembolso: { type: "noul", noul: 0.95 },
        assunto: {
          type: "choice",
          choice: "reembolso",
          confidence: 0.93,
          probabilities: {},
        },
      }),
    );
    const b = await tick(high.fetchImpl);
    expect(b.log.labelsWritten).toEqual([["reembolso-confirmado"]]);
  });

  test("two rules firing the same action run it once", async () => {
    await setMonitoring(
      decisionsBlock({
        rules: [
          {
            when: [{ question: "pede_reembolso", minProbability: 0.7 }],
            action: {
              tool: "private_note",
              args: { content: "Pedido de reembolso" },
            },
          },
          {
            when: [{ question: "assunto", equals: "reembolso" }],
            action: {
              tool: "private_note",
              args: { content: "Pedido de reembolso" },
            },
          },
        ],
      }),
    );
    const p = providerDouble(() =>
      typesafeAnswer({
        pede_reembolso: { type: "noul", noul: 0.95 },
        assunto: {
          type: "choice",
          choice: "reembolso",
          confidence: 0.95,
          probabilities: {},
        },
      }),
    );
    const { log } = await tick(p.fetchImpl);
    expect(log.notes).toEqual(["Pedido de reembolso"]);
    expect((await detail()).actions).toEqual([
      { rule: 0, tool: "private_note", outcome: "ran" },
    ]);
  });

  test("openai: questions travel as the documented array, a refusal stops only its own rule", async () => {
    await setMonitoring(
      decisionsBlock({
        provider: "openai",
        rules: [
          {
            when: [{ question: "pede_reembolso", minProbability: 0.5 }],
            action: { tool: "set_labels", args: { add: ["reembolso"] } },
          },
          {
            when: [
              { question: "assunto", equals: "reembolso", minConfidence: 0.8 },
            ],
            action: { tool: "private_note", args: { content: "reembolso" } },
          },
        ],
      }),
    );
    const p = providerDouble(() =>
      json({
        model: "gpt-6-luna",
        answers: [
          { type: "refusal", name: "pede_reembolso" },
          {
            type: "choice",
            name: "assunto",
            choice: "reembolso",
            probabilities: [
              { value: "reembolso", probability: 0.95 },
              { value: "troca", probability: 0.05 },
            ],
            confidence: 0.95,
          },
          {
            type: "score",
            name: "irritacao",
            score: 0.2,
            probabilities: [
              { value: 0, label: "calmo", probability: 0.8 },
              { value: 1, label: "frustrado", probability: 0.2 },
            ],
            confidence: 0.7,
          },
        ],
        usage: { input_tokens: 500, output_tokens: 0 },
      }),
    );
    const { log } = await tick(p.fetchImpl);
    const req = p.requests[0];
    expect(req?.url).toBe("https://api.openai.com/v1/decisions");
    expect(req?.body.model).toBe("gpt-6-luna");
    const qs = req?.body.questions as Record<string, unknown>[];
    expect(qs.map((q) => [q.name, q.type])).toEqual([
      ["pede_reembolso", "predicate"],
      ["assunto", "choice"],
      ["irritacao", "score"],
    ]);
    expect(qs[1]?.choices).toBeDefined();
    expect(qs[2]?.levels).toEqual([
      { label: "calmo", description: "" },
      { label: "frustrado", description: "" },
      { label: "muito_irritado", description: "" },
    ]);
    // Text only: no image part anywhere in what the provider received.
    expect(typeof req?.body.input).toBe("string");
    expect(JSON.stringify(req?.body)).not.toContain("data:image");

    expect(log.labelsWritten).toEqual([]);
    expect(log.notes).toEqual(["reembolso"]);
    const d = await detail();
    expect((d.answers as Record<string, unknown>).pede_reembolso).toEqual({
      type: "refusal",
    });
    expect(d.notFired).toEqual([
      { rule: 0, miss: { question: "pede_reembolso", why: "refused" } },
    ]);
    expect(d.modelVersion).toBe("gpt-6-luna");
    expect(
      (d.answers as Record<string, { probabilities: unknown }>).irritacao
        ?.probabilities,
    ).toEqual({ calmo: 0.8, frustrado: 0.2 });
    // gpt-6-luna is priced by the table's input rate, input only.
    const row = (await usageRows()).at(-1);
    expect(row?.node).toBe("decision");
    expect(Number(row?.costUsd)).toBeCloseTo((500 * 0.1) / 1_000_000, 9);
  });

  test("a provider failure runs nothing, logs the status alone, and bills nothing", async () => {
    await setMonitoring(decisionsBlock());
    const before = (await usageRows()).length;
    const p = providerDouble(() =>
      json({ error: "SEGREDO-FORNECEDOR-1135 overloaded" }, 503),
    );
    const retry = await tick(p.fetchImpl, [], { afterFailure: "retry" });
    expect(retry.res.outcome).toBe("fail");
    expect(retry.log.labelsWritten).toEqual([]);
    let line = await lastLine();
    expect(line.status).toBe("error");
    expect(line.level).toBe("info");
    expect((line.detail as Record<string, unknown>).willRetry).toBe(true);
    expect((line.detail as Record<string, unknown>).failure).toBe("HTTP 503");

    await tick(p.fetchImpl, [], { afterFailure: "dead_letter" });
    line = await lastLine();
    expect(line.level).toBe("warn");
    expect(JSON.stringify(await observeLines())).not.toContain(
      "SEGREDO-FORNECEDOR",
    );
    expect((await usageRows()).length).toBe(before);
  });

  test("an invalid block or an unresolved credential stops the tick with the reason, never falling back to the model", async () => {
    await setMonitoring({
      engine: "decisions",
      decisions: {
        provider: "anthropic",
        credentialRef: keyRef,
        questions: QUESTIONS,
      },
    });
    const p = providerDouble(() => typesafeAnswer({}));
    const a = await tick(p.fetchImpl);
    expect(p.requests).toHaveLength(0);
    expect(a.model.calls).toBe(0);
    let line = await lastLine();
    expect(line.status).toBe("skipped");
    expect(line.level).toBe("warn");
    expect((line.detail as Record<string, unknown>).skipped).toBe(
      "decisions_config_invalid",
    );
    expect(String((line.detail as Record<string, unknown>).problem)).toContain(
      "monitoring.decisions.provider",
    );

    await setMonitoring(decisionsBlock({ credentialRef: "vault:999999999" }));
    const b = await tick(p.fetchImpl);
    expect(p.requests).toHaveLength(0);
    expect(b.model.calls).toBe(0);
    line = await lastLine();
    expect((line.detail as Record<string, unknown>).skipped).toBe(
      "decisions_credential_unresolved",
    );
  });

  test("an observation withdrawn while the provider answered runs no action", async () => {
    await setMonitoring(
      decisionsBlock({
        rules: [
          {
            when: [{ question: "pede_reembolso", minProbability: 0.5 }],
            action: {
              tool: "private_note",
              args: { content: "não deveria sair" },
            },
          },
        ],
      }),
    );
    // The agent is switched off between the provider call and the action: `private_note` does not
    // ask the fence itself, so only the engine's own check keeps it from writing.
    const p = providerDouble(() =>
      typesafeAnswer({ pede_reembolso: { type: "noul", noul: 0.99 } }),
    );
    const switchingOff = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const r = await p.fetchImpl(u, init);
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: false },
      });
      return r;
    }) as typeof fetch;
    try {
      const { log } = await tick(switchingOff);
      expect(log.notes).toEqual([]);
      const line = await lastLine();
      expect(line.status).toBe("skipped");
      expect((line.detail as Record<string, unknown>).skipped).toBe(
        "agent_no_longer_observes",
      );
      // The paid call was the classification API's, so the refusal is attributed to it.
      expect([line.provider, line.model]).toEqual(["typesafe", "jev-latest"]);
      expect((line.detail as Record<string, unknown>).engine).toBe("decisions");
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: true },
      });
    }
  });

  test("a provider that outlives the tick's deadline is a timeout, on the line and to the scheduler", async () => {
    await setMonitoring(decisionsBlock());
    const hanging = ((_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as typeof fetch;
    const { res } = await tick(hanging, [], {
      timeoutMs: 500,
      afterFailure: "retry",
    });
    expect(res.outcome).toBe("fail");
    expect(JSON.stringify(res)).toContain("timeout");
    const d = await detail();
    expect(d.failed).toBe("decision_call");
    expect(d.failure).toBe("timeout");
  });

  test("enforce switched to shadow while the provider answered writes nothing", async () => {
    const block = (apply: string) =>
      decisionsBlock({
        apply,
        rules: [
          {
            when: [{ question: "pede_reembolso", minProbability: 0.5 }],
            action: {
              tool: "private_note",
              args: { content: "não deveria sair" },
            },
          },
        ],
      });
    await setMonitoring(block("enforce"));
    const p = providerDouble(() =>
      typesafeAnswer({ pede_reembolso: { type: "noul", noul: 0.99 } }),
    );
    const switching = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const r = await p.fetchImpl(u, init);
      await setMonitoring(block("shadow"));
      return r;
    }) as typeof fetch;
    const { log } = await tick(switching);
    expect(log.notes).toEqual([]);
    const line = await lastLine();
    expect(line.status).toBe("skipped");
    expect((line.detail as Record<string, unknown>).skipped).toBe(
      "engine_changed",
    );
  });

  test("an action that outlives the tick's deadline ends the tick, and a committed one is not retried", async () => {
    await setMonitoring(
      decisionsBlock({
        rules: [
          {
            when: [{ question: "pede_reembolso", minProbability: 0.5 }],
            action: { tool: "private_note", args: { content: "lenta" } },
          },
        ],
      }),
    );
    const p = providerDouble(() =>
      typesafeAnswer({ pede_reembolso: { type: "noul", noul: 0.99 } }),
    );
    const started = Date.now();
    const { res } = await tick(p.fetchImpl, [], {
      timeoutMs: 1_500,
      slowNotes: 10_000,
      afterFailure: "retry",
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(res.outcome).toBe("done");
    const line = await lastLine();
    expect(line.status).toBe("error");
    expect(line.level).toBe("warn");
    const d = line.detail as Record<string, unknown>;
    expect(d.failed).toBe("decision_actions");
    expect(d.retried).toBe(false);
    expect(d.failure).toBe("timeout");
  });

  test("once the deadline passes, no later rule's action starts", async () => {
    await setMonitoring(
      decisionsBlock({
        rules: [
          {
            when: [{ question: "pede_reembolso", minProbability: 0.5 }],
            action: { tool: "private_note", args: { content: "lenta" } },
          },
          {
            when: [{ question: "pede_reembolso", minProbability: 0.5 }],
            action: { tool: "set_labels", args: { add: ["reembolso"] } },
          },
        ],
      }),
    );
    const p = providerDouble(() =>
      typesafeAnswer({ pede_reembolso: { type: "noul", noul: 0.99 } }),
    );
    const { log } = await tick(p.fetchImpl, [], {
      timeoutMs: 1_000,
      slowNotes: 2_000,
      afterFailure: "retry",
    });
    // The slow note settles after the tick returned; the next rule must not run then.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(log.labelsWritten).toEqual([]);
  });

  test("a provider string outside the configured options never reaches the line", async () => {
    await setMonitoring(
      decisionsBlock({
        rules: [
          {
            when: [{ question: "assunto", equals: "reembolso" }],
            action: { tool: "set_labels", args: { add: ["x"] } },
          },
        ],
      }),
    );
    const p = providerDouble(() =>
      json({
        // Id-shaped, so only the provider's model grammar keeps it out (a credential's base URL may
        // point at anything that echoes the conversation).
        model: "MARCADOR-1135_echoed",
        answers: {
          assunto: {
            type: "choice",
            choice: "MARCADOR-1135 texto do cliente",
            confidence: 0.9,
            probabilities: { "MARCADOR-1135": 0.9, reembolso: 0.1 },
          },
          irritacao: {
            type: "score",
            score: 1,
            confidence: 0.9,
            probabilities: { "0": 0.1, "1": 0.8, "MARCADOR-1135": 0.1 },
          },
        },
        usage: { input_tokens: 10 },
      }),
    );
    const { log } = await tick(p.fetchImpl);
    expect(log.labelsWritten).toEqual([]);
    const d = await detail();
    expect(JSON.stringify(d)).not.toContain("MARCADOR-1135");
    expect(d.modelVersion).toBeNull();
    expect((d.answers as Record<string, unknown>).assunto).toBeUndefined();
    expect(
      (d.answers as Record<string, { probabilities: unknown }>).irritacao
        ?.probabilities,
    ).toEqual({ calmo: 0.1, frustrado: 0.8 });
    expect(d.notFired).toEqual([
      { rule: 0, miss: { question: "assunto", why: "unanswered" } },
    ]);
  });

  test("modelVersion is the model asked for or its dated snapshot, never another model-shaped string", async () => {
    await setMonitoring(decisionsBlock({ provider: "openai", rules: [] }));
    for (const [model, kept] of [
      ["gpt-6-luna-MARCADOR-1135", null],
      ["gpt-6-luna-2026-09-01", "gpt-6-luna-2026-09-01"],
    ] as const) {
      const p = providerDouble(() =>
        json({ model, answers: [], usage: { input_tokens: 1 } }),
      );
      await tick(p.fetchImpl);
      expect((await detail()).modelVersion).toBe(kept);
    }
  });

  test("arguments the tool would refuse read the same in shadow as on enforce", async () => {
    const p = providerDouble(() =>
      typesafeAnswer({ pede_reembolso: { type: "noul", noul: 0.99 } }),
    );
    for (const apply of ["shadow", "enforce"] as const) {
      await setMonitoring(
        decisionsBlock({
          apply,
          rules: [
            {
              when: [{ question: "pede_reembolso", minProbability: 0.5 }],
              action: { tool: "private_note", args: {} },
            },
          ],
        }),
      );
      const { log } = await tick(p.fetchImpl);
      expect(log.notes).toEqual([]);
      const line = await lastLine();
      expect(line.level).toBe("warn");
      expect((line.detail as Record<string, unknown>).actions).toEqual([
        {
          rule: 0,
          tool: "private_note",
          outcome: "failed",
          failure: "invalid_arguments",
        },
      ]);
    }
  });

  test("the agent's limits.maxToolCalls caps the actions a tick dispatches", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          limits: { maxToolCalls: 1 },
          monitoring: decisionsBlock({
            rules: [
              {
                when: [{ question: "pede_reembolso", minProbability: 0.5 }],
                action: { tool: "private_note", args: { content: "primeira" } },
              },
              {
                when: [{ question: "pede_reembolso", minProbability: 0.5 }],
                action: { tool: "private_note", args: { content: "segunda" } },
              },
            ],
          }),
        } as never,
      },
    });
    const p = providerDouble(() =>
      typesafeAnswer({ pede_reembolso: { type: "noul", noul: 0.99 } }),
    );
    const { log } = await tick(p.fetchImpl);
    expect(log.notes).toEqual(["primeira"]);
    const line = await lastLine();
    expect(line.level).toBe("warn");
    expect(
      (
        (line.detail as Record<string, unknown>).actions as {
          outcome: string;
        }[]
      ).map((a) => a.outcome),
    ).toEqual(["ran", "over_budget"]);
  });

  test("a rule whose tool the agent was not granted does not act, and the line says so at warn", async () => {
    const grant = await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId,
        source: "NATIVE",
        enabledTools: ["private_note"],
        knowledgeBaseIds: [],
      },
    });
    try {
      await setMonitoring(decisionsBlock());
      const p = providerDouble(() =>
        typesafeAnswer({ pede_reembolso: { type: "noul", noul: 0.99 } }),
      );
      const { log } = await tick(p.fetchImpl);
      expect(log.labelsWritten).toEqual([]);
      const line = await lastLine();
      expect(line.level).toBe("warn");
      expect((line.detail as Record<string, unknown>).actions).toEqual([
        { rule: 0, tool: "set_labels", outcome: "not_granted" },
      ]);
      // Shadow reports the same missing grant enforce would hit, not an action that could run.
      await setMonitoring(decisionsBlock({ apply: "shadow" }));
      await tick(p.fetchImpl);
      const shadow = await lastLine();
      expect(shadow.level).toBe("warn");
      expect((shadow.detail as Record<string, unknown>).actions).toEqual([
        { rule: 0, tool: "set_labels", outcome: "not_granted" },
      ]);
    } finally {
      await suDb.agentToolSelection.delete({ where: { id: grant.id } });
    }
  });
  // What one decision costs Chatwoot, counted at the transport on a real client: the calls a tick
  // makes are sequential round trips the conversation waits through, so their number is latency
  // whatever the machine. The fake answers a turn of the event loop later, as a network does.
  describe("the requests one decision makes", () => {
    function fakeChatwoot(seed: {
      labels: string[];
      attributes: Record<string, unknown>;
    }) {
      const state = {
        labels: [...seed.labels],
        attributes: { ...seed.attributes },
        notes: [] as string[],
      };
      const requests: string[] = [];
      const fetchImpl = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const path = new URL(String(input)).pathname.replace(
          /^.*\/api\/v1\/accounts\/\d+/,
          "",
        );
        const method = init?.method ?? "GET";
        requests.push(`${method} ${path}`);
        await new Promise((r) => setTimeout(r, 2));
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : {};
        const conv = `/conversations/${CONV}`;
        if (method === "GET" && path === `${conv}/messages`) {
          return json({
            payload: [
              {
                id: 11,
                content: CUSTOMER_TEXT,
                message_type: 0,
                private: false,
                attachments: [],
              },
            ],
          });
        }
        if (method === "GET" && path === `${conv}/labels`) {
          return json({ payload: state.labels });
        }
        if (method === "POST" && path === `${conv}/labels`) {
          state.labels = body.labels as string[];
          return json({ payload: state.labels });
        }
        if (method === "GET" && path === conv) {
          return json({ id: CONV, custom_attributes: state.attributes });
        }
        if (method === "POST" && path === `${conv}/custom_attributes`) {
          state.attributes = body.custom_attributes as Record<string, unknown>;
          return json({ custom_attributes: state.attributes });
        }
        if (method === "POST" && path === `${conv}/messages`) {
          state.notes.push(String(body.content));
          return json({ id: 99 });
        }
        if (method === "GET" && path === "/labels") {
          return json({ payload: [] });
        }
        if (method === "GET" && path === "/custom_attribute_definitions") {
          return json([]);
        }
        return json({}, 404);
      }) as typeof fetch;
      return { state, requests, fetchImpl };
    }

    const onConversation = (requests: string[]) =>
      requests.filter((r) => r.includes(`/conversations/${CONV}`));

    async function decide(
      chatwoot: ReturnType<typeof fakeChatwoot>,
      rules: unknown[],
    ) {
      await setMonitoring(decisionsBlock({ rules }));
      const p = providerDouble(() =>
        typesafeAnswer({
          pede_reembolso: { type: "noul", noul: 0.95 },
          assunto: {
            type: "choice",
            choice: "reembolso",
            confidence: 0.95,
            probabilities: {},
          },
        }),
      );
      return runObserve(
        tenantId,
        {
          instanceId,
          conversationId: CONV,
          agentId,
          reason: "burst",
          atMessageId: null,
        },
        appDb,
        {
          makeClient: async (cfg) =>
            new ChatwootClient(cfg, chatwoot.fetchImpl),
          makeModel: () => new CountingModel() as never,
          decisionFetch: p.fetchImpl,
        },
      );
    }

    const yes = [{ question: "pede_reembolso", minProbability: 0.7 }];
    const attribute = (key: string, value: string) => ({
      when: yes,
      action: { tool: "set_custom_attribute", args: { key, value } },
    });

    // The grants a watcher of this shape has. Without them the toolset also offers the funnel tools
    // and asks Chatwoot for the conversation's card on every tick, a read of its own.
    let grantId = 0n;
    beforeAll(async () => {
      const grant = await suDb.agentToolSelection.create({
        data: {
          tenantId,
          agentId,
          source: "NATIVE",
          enabledTools: ["set_labels", "set_custom_attribute", "private_note"],
          knowledgeBaseIds: [],
        },
      });
      grantId = grant.id;
    });
    afterAll(async () => {
      await suDb.agentToolSelection.delete({ where: { id: grantId } });
    });

    test("six actions on a short conversation reach Chatwoot in seven requests", async () => {
      const chatwoot = fakeChatwoot({
        labels: ["sentimento-neutro", "vip"],
        attributes: { origem: "site" },
      });
      const res = await decide(chatwoot, [
        {
          when: yes,
          action: {
            tool: "set_labels",
            args: {
              add: ["sentimento-negativo"],
              remove: ["sentimento-neutro"],
            },
          },
        },
        attribute("sentimento", "negativo"),
        attribute("assunto", "reembolso"),
        attribute("urgencia", "alta"),
        {
          when: yes,
          action: { tool: "set_labels", args: { add: ["urgente"] } },
        },
        {
          when: yes,
          action: { tool: "private_note", args: { content: "Olhar agora" } },
        },
      ]);
      expect(res).toEqual({ outcome: "done" });
      const conv = `/conversations/${CONV}`;
      expect(onConversation(chatwoot.requests)).toEqual([
        // The window: one page, and a page Chatwoot did not fill has nothing older behind it.
        `GET ${conv}/messages`,
        // The labels the evidence shows.
        `GET ${conv}/labels`,
        // Both label rules: one fresh read, one write of the set they add up to.
        `GET ${conv}/labels`,
        `POST ${conv}/labels`,
        // The three attribute rules: one read of the bag, one write.
        `GET ${conv}`,
        `POST ${conv}/custom_attributes`,
        `POST ${conv}/messages`,
      ]);
      // What the conversation holds is what six separate writes would have left.
      expect([...chatwoot.state.labels].sort()).toEqual([
        "sentimento-negativo",
        "urgente",
        "vip",
      ]);
      expect(chatwoot.state.attributes).toEqual({
        origem: "site",
        sentimento: "negativo",
        assunto: "reembolso",
        urgencia: "alta",
      });
      expect(chatwoot.state.notes).toEqual(["Olhar agora"]);
      // And the line records each action on its own, in rule order, with each label write.
      const d = await detail();
      expect(d.actions).toEqual([
        { rule: 0, tool: "set_labels", outcome: "ran" },
        { rule: 1, tool: "set_custom_attribute", outcome: "ran" },
        { rule: 2, tool: "set_custom_attribute", outcome: "ran" },
        { rule: 3, tool: "set_custom_attribute", outcome: "ran" },
        { rule: 4, tool: "set_labels", outcome: "ran" },
        { rule: 5, tool: "private_note", outcome: "ran" },
      ]);
      expect(d.labels).toEqual([
        { scope: "conversation", added: 1, removed: 1, after: 2 },
        { scope: "conversation", added: 1, removed: 0, after: 3 },
      ]);
    });

    test("a label rule that changes nothing writes nothing, and its neighbour still writes", async () => {
      const chatwoot = fakeChatwoot({ labels: ["urgente"], attributes: {} });
      await decide(chatwoot, [
        {
          when: yes,
          action: { tool: "set_labels", args: { add: ["urgente"] } },
        },
        {
          when: yes,
          action: { tool: "set_labels", args: { add: ["reembolso"] } },
        },
      ]);
      const conv = `/conversations/${CONV}`;
      expect(
        onConversation(chatwoot.requests).filter((r) => r.startsWith("POST")),
      ).toEqual([`POST ${conv}/labels`]);
      expect([...chatwoot.state.labels].sort()).toEqual([
        "reembolso",
        "urgente",
      ]);
      const d = await detail();
      expect(d.actions).toEqual([
        { rule: 0, tool: "set_labels", outcome: "ran" },
        { rule: 1, tool: "set_labels", outcome: "ran" },
      ]);
      expect(d.labels).toEqual([
        { scope: "conversation", added: 1, removed: 0, after: 2 },
      ]);
    });

    test("an attribute write Chatwoot refuses fails every rule that rode on it, and nothing else", async () => {
      const chatwoot = fakeChatwoot({ labels: [], attributes: {} });
      const inner = chatwoot.fetchImpl;
      chatwoot.fetchImpl = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        if (
          init?.method === "POST" &&
          String(input).endsWith("/custom_attributes")
        ) {
          chatwoot.requests.push("POST refused");
          return json({ error: "no" }, 500);
        }
        return inner(input, init);
      }) as typeof fetch;
      await decide(chatwoot, [
        attribute("sentimento", "negativo"),
        attribute("assunto", "reembolso"),
        {
          when: yes,
          action: { tool: "set_labels", args: { add: ["reembolso"] } },
        },
      ]);
      expect(chatwoot.state.attributes).toEqual({});
      expect(chatwoot.state.labels).toEqual(["reembolso"]);
      expect((await detail()).actions).toEqual([
        {
          rule: 0,
          tool: "set_custom_attribute",
          outcome: "failed",
          failure: "tool_error",
        },
        {
          rule: 1,
          tool: "set_custom_attribute",
          outcome: "failed",
          failure: "tool_error",
        },
        { rule: 2, tool: "set_labels", outcome: "ran" },
      ]);
    });
  });
});
