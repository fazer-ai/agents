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
import { chatwootThreadId } from "@/graph/checkpointer";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { __resetChatwootVocabCache } from "@/modules/chatwoot/vocab";
import { ruleStateKey } from "@/modules/decisions/config";
import { tryDecisionsAgent } from "@/modules/decisions/try";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogCount } from "../utils/flowlog";

// Testing a "Questions and rules" observer on one conversation from the conversation page
// (docs/decisions.md, "Testing an agent on a conversation"): the saved block runs once on the
// conversation's evidence and NOTHING acts. The classifier is a double in TypeSafe's documented
// shape, and the Chatwoot client a stub that records every write, so each test can say what a test
// must never do (write to Chatwoot, latch a rule, log a tick) next to what it reports.

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

const CONV = 9411;
let tenantId = 0n;
let otherTenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let convRowId = 0n;
let keyRef = "";

const RULE = {
  when: [{ question: "pede_reembolso", minProbability: 0.7 }],
  action: { tool: "set_labels", args: { add: ["reembolso"] } },
};

// A private note acts once per conversation (its default trigger), unlike a label write, which
// converges and so never latches.
const NOTE_RULE = {
  when: [{ question: "pede_reembolso", minProbability: 0.7 }],
  action: { tool: "private_note", args: { text: "Pedido de reembolso" } },
};

function monitoring(rules: unknown[] = [RULE]) {
  return {
    monitoring: {
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
        rules,
      },
    },
  };
}

interface Writes {
  count: number;
}

function stubClient(
  messages: Record<string, unknown>[],
  writes: Writes,
): ChatwootClient {
  const write = async () => {
    writes.count++;
    return {};
  };
  return {
    muted: true,
    getMessages: async () => ({ payload: messages }),
    getConversationLabels: async () => [],
    setConversationLabels: write,
    sendPrivateNote: write,
    updateConversationCustomAttributes: write,
    sendMessage: write,
    toggleTyping: write,
  } as unknown as ChatwootClient;
}

const CUSTOMER = {
  id: 11,
  content: "Quero meu dinheiro de volta",
  message_type: 0,
  private: false,
  attachments: [],
};

function classifier(answer: () => Response) {
  const calls = { n: 0 };
  const fetchImpl = (async () => {
    calls.n++;
    return answer();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const yes = () =>
  new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: { pede_reembolso: { type: "noul", noul: 0.92 } },
      usage: { input_tokens: 800, output_tokens: 10 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const ctxOf = (t: bigint) => ({
  tenantId: t,
  userId: null,
  role: "TENANT_ADMIN" as const,
});

async function runTest(
  fetchImpl: typeof fetch,
  messages: Record<string, unknown>[] = [CUSTOMER],
  tenant: bigint = tenantId,
) {
  const writes: Writes = { count: 0 };
  const tick = await tryDecisionsAgent(
    ctxOf(tenant),
    agentId,
    convRowId,
    {
      decisionFetch: fetchImpl,
      makeClient: async () => stubClient(messages, writes),
    },
    appDb,
  );
  return { tick, writes };
}

const setSettings = (settings: unknown) =>
  suDb.agent.update({
    where: { id: agentId },
    data: { settings: settings as never },
  });

describe.skipIf(!dbUp)("testing a decisions agent on a conversation", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "TRY", slug: `try-${process.pid}` },
    });
    tenantId = t.id;
    const other = await suDb.tenant.create({
      data: { name: "TRY2", slug: `try2-${process.pid}` },
    });
    otherTenantId = other.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 64,
      baseUrl: "https://chat.try.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "typesafe-try", secret: encryptJson("ts-key") },
      select: { id: true },
    });
    keyRef = `vault:${key.id}`;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Classificadora",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        enabled: true,
        mode: "monitoring",
        settings: {},
      },
    });
    agentId = agent.id;
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 94,
        name: "SAC",
      },
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

  beforeEach(async () => {
    __resetChatwootVocabCache();
    await setSettings(monitoring());
    await suDb.decisionRuleState.deleteMany({ where: { tenantId } });
    await suDb.llmUsage.deleteMany({ where: { tenantId } });
  });

  afterAll(async () => {
    if (!dbUp) return;
    for (const table of [
      "execution_logs",
      "llm_usage",
      "decision_rule_states",
      "decision_rule_claims",
      "conversations",
      "inboxes",
      "agents",
      "vault_entries",
      "chatwoot_instances",
      "chatwoot_deployments",
    ]) {
      await suDb
        .$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id IN (${tenantId}, ${otherTenantId})`,
        )
        .catch(() => {});
    }
    await suDb
      .$executeRawUnsafe(
        `DELETE FROM tenants WHERE id IN (${tenantId}, ${otherTenantId})`,
      )
      .catch(() => {});
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // The bug this catches: a test that runs the rule's tool for real, or latches it, so trying an
  // agent labels the customer's conversation or keeps the real tick from acting later.
  test("a rule that holds is reported as what WOULD run, and nothing is written", async () => {
    const c = classifier(yes);
    const { tick, writes } = await runTest(c.fetchImpl);
    expect(tick.outcome).toBe("decided");
    expect(tick.actions).toEqual([
      { rule: 0, tool: "set_labels", outcome: "decided" },
    ]);
    expect(writes.count).toBe(0);
    expect(await suDb.decisionRuleState.count({ where: { tenantId } })).toBe(0);
    expect(await suDb.decisionRuleClaim.count({ where: { tenantId } })).toBe(0);
    // A test is not a tick: the conversation's timeline does not gain a line from it.
    expect(
      await flowLogCount(suDb, {
        where: { tenantId, conversationId: convRowId },
      }),
    ).toBe(0);
  });

  // The bug: the test billed against the inbox (or not at all), so trying an agent either spends the
  // ceiling that keeps it answering customers or spends nothing anyone can see.
  test("the classification is billed as the playground", async () => {
    await runTest(classifier(yes).fetchImpl);
    const rows = await suDb.llmUsage.findMany({
      where: { tenantId },
      select: { source: true, node: true, promptTokens: true },
    });
    expect(rows).toEqual([
      { source: "playground", node: "decision", promptTokens: 800 },
    ]);
  });

  // The bug: the test ignores the conversation's trigger state and reports a "once" rule as about to
  // act on a conversation where it already acted, which the real tick would not do.
  test("a rule already latched on this conversation is reported as held", async () => {
    await setSettings(monitoring([NOTE_RULE]));
    await suDb.decisionRuleState.create({
      data: {
        tenantId,
        agentId,
        conversationId: convRowId,
        ruleKey: ruleStateKey(NOTE_RULE as never),
      },
    });
    const { tick } = await runTest(classifier(yes).fetchImpl);
    expect(tick.actions).toEqual([]);
    expect(tick.held).toHaveLength(1);
    // Read, not claimed: the latch the real tick wrote is still there and unchanged.
    expect(await suDb.decisionRuleState.count({ where: { tenantId } })).toBe(1);
  });

  // The bug: the dry run drops what a rule FILLS its tool's arguments from, so two rules that call
  // one custom tool with different filled values read as one action, unlike the real tick.
  test("rules that differ only by what they fill stay two actions", async () => {
    const when = [{ question: "pede_reembolso", minProbability: 0.7 }];
    await setSettings(
      monitoring([
        {
          when,
          action: {
            tool: "registrar_caso",
            args: {},
            fill: { conversa: "conversation.display_id" },
          },
        },
        {
          when,
          action: {
            tool: "registrar_caso",
            args: {},
            fill: { chance: "answer.pede_reembolso.probability" },
          },
        },
      ]),
    );
    const { tick } = await runTest(classifier(yes).fetchImpl);
    expect(tick.actions).toEqual([
      { rule: 0, tool: "registrar_caso", outcome: "decided" },
      { rule: 1, tool: "registrar_caso", outcome: "decided" },
    ]);
  });

  // The bug: paying for a classification of a conversation where the customer has said nothing.
  test("no customer message: skipped before the classifier is called", async () => {
    const c = classifier(yes);
    const { tick } = await runTest(c.fetchImpl, [
      { ...CUSTOMER, message_type: 1 },
    ]);
    expect(tick.outcome).toBe("skipped");
    expect(tick.skipped).toBe("no_customer_message");
    expect(c.calls.n).toBe(0);
    expect(await suDb.llmUsage.count({ where: { tenantId } })).toBe(0);
  });

  test("a classifier that fails reads as a failed test, not a crash", async () => {
    const c = classifier(() => new Response("boom", { status: 500 }));
    const { tick } = await runTest(c.fetchImpl);
    expect(tick.outcome).toBe("failed");
    expect(tick.failed).toBe("decision_call");
  });

  // The bug: an LLM observer (or a responder) reaching the classifier path with no block to run.
  test("an agent that does not observe with questions and rules is refused", async () => {
    await setSettings({ monitoring: { engine: "llm" } });
    await expect(runTest(classifier(yes).fetchImpl)).rejects.toMatchObject({
      statusCode: 400,
      translationKey: "errors.agentNotDecisionsObserver",
    });
  });

  // The bug: the conversation read outside the caller's tenant.
  test("another tenant cannot test on this conversation", async () => {
    // The same agent id is refused first; an agent of the other tenant is what reaches the
    // conversation read.
    const other = await suDb.agent.create({
      data: {
        tenantId: otherTenantId,
        name: "Outra",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        enabled: true,
        mode: "monitoring",
        settings: monitoring() as never,
      },
    });
    const c = classifier(yes);
    await expect(
      tryDecisionsAgent(
        ctxOf(otherTenantId),
        other.id,
        convRowId,
        {
          decisionFetch: c.fetchImpl,
          makeClient: async () => stubClient([CUSTOMER], { count: 0 }),
        },
        appDb,
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      translationKey: "errors.conversationNotFound",
    });
    expect(c.calls.n).toBe(0);
  });
});
