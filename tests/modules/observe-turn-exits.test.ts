import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId } from "@/graph/checkpointer";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { type ObserveDeps, runObserve } from "@/modules/observe/job";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { expectFallbackLines, graphDepsOf } from "../utils/fallback-lines";
import { UsageReportingModel } from "../utils/scripted-models";
import { settlesDuring, throwingModel } from "../utils/tool-logger-settled";

// Every exit of an observer's tick, on both engines: the turn's fallback lines are held to the rules
// every entrypoint's are (tests/utils/fallback-lines.ts), and each exit settles the tick's tool logger
// (tests/utils/tool-logger-settled.ts), the one that ends in a failure as well as the one that answered.

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

const INBOX_ID = 97;
const OUR_BOT = 37;
const CONV = 9701;
let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let keyRef = "";

const LLM = {
  labelGroups: [
    {
      name: "assunto",
      exclusive: true,
      values: ["cancelamento", "outros"],
    },
  ],
};

function decisions(action: Record<string, unknown>) {
  return {
    engine: "decisions",
    decisions: {
      provider: "typesafe",
      credentialRef: keyRef,
      questions: [
        {
          name: "pede_reembolso",
          type: "yes_no",
          instructions: "O cliente pede o dinheiro de volta?",
        },
      ],
      rules: [
        { when: [{ question: "pede_reembolso", minProbability: 0.5 }], action },
      ],
      apply: "enforce",
    },
  };
}

async function setMonitoring(monitoring: Record<string, unknown>) {
  await suDb.agent.update({
    where: { id: agentId },
    data: { settings: { monitoring } as never },
  });
}

// A Chatwoot double that reads one customer message, accepts every write and records the label sets
// it was handed in `written`. `onNote` replaces the private note's answer, for the test that holds an
// action in flight.
function stubClient(
  onNote?: () => Promise<unknown>,
  written: string[][] = [],
): ChatwootClient {
  const labels: string[] = [];
  return {
    getMessages: async () => ({
      payload: [
        {
          id: 1,
          content: "quero cancelar e ter meu dinheiro de volta",
          message_type: 0,
          private: false,
          attachments: [],
        },
      ],
    }),
    getConversationLabels: async () => [...labels],
    setConversationLabels: async (_id: number, next: string[]) => {
      written.push(next);
      labels.splice(0, labels.length, ...next);
      return {};
    },
    sendPrivateNote: async () => (onNote ? onNote() : {}),
    sendMessage: async () => ({}),
    toggleTyping: async () => ({}),
  } as unknown as ChatwootClient;
}

// The observer's verdict, counted where the model is called, and answered through
// `withStructuredOutput` the way an adapter parses it.
class VerdictModel extends UsageReportingModel {
  invoked = 0;
  override async _generate(
    ...args: Parameters<UsageReportingModel["_generate"]>
  ): ReturnType<UsageReportingModel["_generate"]> {
    this.invoked++;
    return super._generate(...args);
  }
  override withStructuredOutput(): never {
    return {
      invoke: async (...args: Parameters<UsageReportingModel["invoke"]>) => {
        const raw = await this.invoke(...args);
        return { raw, parsed: JSON.parse(String(raw.content)) };
      },
    } as never;
  }
}
const verdict = () =>
  new VerdictModel([JSON.stringify({ assunto: "cancelamento" })]);

// TypeSafe's documented shape (docs.typesafe.ai/api), answering yes to the one question.
const typesafeYes = (async () =>
  new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: { pede_reembolso: { type: "noul", noul: 0.99 } },
      usage: { input_tokens: 1000, output_tokens: 60 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )) as unknown as typeof fetch;

function tick(deps: ObserveDeps) {
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
    deps,
  );
}

describe.skipIf(!dbUp)("the exits of an observer's tick", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "OTX", slug: `otx-${process.pid}` },
      })
    ).id;
    instanceId = (
      await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 67,
        baseUrl: "https://chat.exits.example",
        adminToken: encryptJson("ADMIN"),
      })
    ).id;
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "typesafe-teste", secret: encryptJson("ts-key") },
      select: { id: true },
    });
    keyRef = `vault:${key.id}`;
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Observadora",
          systemPrompt: "Você acompanha o SAC.",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          enabled: true,
          mode: "monitoring",
          settings: { monitoring: LLM },
        },
      })
    ).id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId,
        chatwootAgentBotId: OUR_BOT,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `otx-route-${process.pid}`,
        name: "Observadora",
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
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: CONV,
        inboxId: inbox.id,
        status: "open",
        threadId: chatwootThreadId(tenantId, instanceId, CONV),
      },
    });
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

  test("the observer's fallback lines name their own model and raise one alarm", async () => {
    await setMonitoring(LLM);
    const model = verdict();
    const deps = await graphDepsOf(() =>
      tick({ makeClient: async () => stubClient(), makeModel: () => model }),
    );
    expect(model.invoked).toBeGreaterThan(0);
    expect(deps).toHaveLength(1);
    expectFallbackLines(deps[0] ?? {});
  });

  test("the observer settles its tool logger, also when its model call fails", async () => {
    await setMonitoring(LLM);
    const model = verdict();
    const answered = await settlesDuring(() =>
      tick({ makeClient: async () => stubClient(), makeModel: () => model }),
    );
    expect(model.invoked).toBeGreaterThan(0);
    const failed = await settlesDuring(() =>
      tick({
        makeClient: async () => stubClient(),
        makeModel: () => throwingModel as never,
      }),
    );
    expect({ answered, failed }).toEqual({ answered: 1, failed: 1 });
  });

  test("a decisions tick that ran its actions settles its tool logger", async () => {
    await setMonitoring(
      decisions({ tool: "set_labels", args: { add: ["cancelamento"] } }),
    );
    const written: string[][] = [];
    const settled = await settlesDuring(() =>
      tick({
        makeClient: async () => stubClient(undefined, written),
        decisionFetch: typesafeYes,
      }),
    );
    expect(written).toEqual([["cancelamento"]]);
    expect(settled).toBe(1);
  });

  // NOTE: the tick's deadline is the one `AbortSignal.timeout` it asks for with `timeoutMs`; handing
  // it a signal the note aborts puts the deadline inside the dispatch without waiting it out.
  test("a decisions tick whose deadline cuts its actions settles its tool logger", async () => {
    await setMonitoring(
      decisions({ tool: "private_note", args: { content: "lenta" } }),
    );
    const DEADLINE_MS = 987_654;
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === DEADLINE_MS ? deadline.signal : timeout(ms),
    );
    let release = () => {};
    let noteInFlight = false;
    let settled = 0;
    let answeredWithNoteInFlight = false;
    try {
      settled = await settlesDuring(async () => {
        await tick({
          makeClient: async () =>
            stubClient(() => {
              noteInFlight = true;
              deadline.abort(new DOMException("deadline", "TimeoutError"));
              return new Promise((resolve) => {
                release = () => {
                  noteInFlight = false;
                  resolve({});
                };
              });
            }),
          decisionFetch: typesafeYes,
          timeoutMs: DEADLINE_MS,
        });
        answeredWithNoteInFlight = noteInFlight;
      });
    } finally {
      spy.mockRestore();
      release();
    }
    expect(deadline.signal.aborted).toBe(true);
    // The tick answered while its note was still in flight, so it left through the cut dispatch.
    expect(answeredWithNoteInFlight).toBe(true);
    expect(settled).toBe(1);
  });
});
