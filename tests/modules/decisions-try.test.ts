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
  action: { tool: "private_note", args: { content: "Pedido de reembolso" } },
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

// The labels the stub client reads for the conversation's contact.
let contactLabels: string[] = [];

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
    getContactLabels: async () => [...contactLabels],
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
    // A custom tool the agent is granted, with the argument schema a dry run must hold rules to.
    const td = await suDb.toolDefinition.create({
      data: {
        tenantId,
        name: "registrar_caso",
        label: "Registrar caso",
        method: "POST",
        urlTemplate: "https://casos.example.com/casos",
        allowedHosts: ["casos.example.com"],
        inputSchema: {
          type: "object",
          properties: {
            conversa: { type: "number" },
            chance: { type: "number" },
            email: { type: "string" },
          },
        },
      },
    });
    const td2 = await suDb.toolDefinition.create({
      data: {
        tenantId,
        name: "avisar_cliente",
        label: "Avisar cliente",
        method: "POST",
        urlTemplate: "https://casos.example.com/avisos",
        allowedHosts: ["casos.example.com"],
        inputSchema: {
          type: "object",
          properties: { email: { type: "string" } },
          required: ["email"],
        },
      },
    });
    for (const t of [td, td2]) {
      await suDb.agentToolSelection.create({
        data: {
          tenantId,
          agentId,
          source: "HTTP",
          toolDefinitionId: t.id,
          enabledTools: [],
          knowledgeBaseIds: [],
        },
      });
    }
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
      "agent_tool_selections",
      "mcp_server_connections",
      "tool_definitions",
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

  // The bug: a dry run without the tool's schema reports a rule as about to act when the real tick
  // would find its required argument empty and call nothing (here the conversation has no contact,
  // so its e-mail cannot fill the argument).
  test("a required argument left empty is a missing value, not an action", async () => {
    await setSettings(
      monitoring([
        {
          when: [{ question: "pede_reembolso", minProbability: 0.7 }],
          action: {
            tool: "avisar_cliente",
            args: {},
            fill: { email: "contact.email" },
          },
        },
      ]),
    );
    const { tick } = await runTest(classifier(yes).fetchImpl);
    expect(tick.actions).toMatchObject([
      { rule: 0, tool: "avisar_cliente", outcome: "failed" },
    ]);
  });

  // The bug: an MCP server that opens its stream and never answers holds the test forever (the
  // modal stays busy), or holds it after the classification was already paid for.
  test("an MCP server that never answers ends the test before the paid call", async () => {
    const conn = await suDb.mcpServerConnection.create({
      data: {
        tenantId,
        name: `mudo-${process.pid}`,
        transport: "streamableHttp",
        url: "https://mudo.example.com/mcp",
      },
    });
    const sel = await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId,
        source: "MCP",
        mcpServerConnectionId: conn.id,
        knowledgeBaseIds: [],
        enabledTools: ["qualquer_uma"],
      },
    });
    const c = classifier(yes);
    const started = Date.now();
    try {
      const tick = await tryDecisionsAgent(
        ctxOf(tenantId),
        agentId,
        convRowId,
        {
          decisionFetch: c.fetchImpl,
          makeClient: async () => stubClient([CUSTOMER], { count: 0 }),
          mcp: { connect: (() => new Promise(() => {})) as never },
          timeoutMs: 300,
        },
        appDb,
      );
      expect(tick.outcome).toBe("failed");
      expect(tick.failed).toBe("toolset_build");
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(c.calls.n).toBe(0);
    } finally {
      await suDb.agentToolSelection.delete({ where: { id: sel.id } });
      await suDb.mcpServerConnection.delete({ where: { id: conn.id } });
    }
  });

  // The bug: a tool's precondition is asked inside the tool, which a dry run never invokes, so the
  // test reported "would run" where the tick refuses. And the other way: on a tick the condition reads
  // what an earlier rule wrote, so an attribute rule ahead of it satisfies it.
  test("a tool precondition refuses as on a tick, and reads what earlier rules would write", async () => {
    const when = [{ question: "pede_reembolso", minProbability: 0.7 }];
    const note = {
      when,
      action: { tool: "private_note", args: { content: "Reembolso" } },
    };
    const guarded = (rules: unknown[]) => ({
      ...monitoring(rules),
      toolPreconditions: {
        private_note: {
          kind: "attribute",
          scope: "conversation",
          key: "pedido",
        },
      },
    });
    await setSettings(guarded([note]));
    let { tick } = await runTest(classifier(yes).fetchImpl);
    expect(tick.actions).toMatchObject([
      {
        rule: 0,
        tool: "private_note",
        outcome: "refused",
        fence: "precondition",
      },
    ]);
    await setSettings(
      guarded([
        {
          when,
          action: {
            tool: "set_custom_attribute",
            args: { key: "pedido", value: "4471" },
          },
        },
        note,
      ]),
    );
    ({ tick } = await runTest(classifier(yes).fetchImpl));
    expect(tick.actions).toMatchObject([
      { rule: 0, tool: "set_custom_attribute", outcome: "decided" },
      { rule: 1, tool: "private_note", outcome: "decided" },
    ]);
  });

  // The bug: the label fences are asked inside `set_labels`, which a dry run never invokes, so a rule
  // adding a protected label, or one outside the allowed list, read as "would run". A call refused
  // only in part stays an action, marked partial.
  test("label fences refuse a label write as on a tick, whole or in part", async () => {
    const when = [{ question: "pede_reembolso", minProbability: 0.7 }];
    const labels = (add: string[]) => ({
      when,
      action: { tool: "set_labels", args: { add } },
    });
    await setSettings({
      ...monitoring([labels(["vip"]), labels(["reembolso", "vip"])]),
      setLabels: { protected: ["vip"] },
    });
    let { tick } = await runTest(classifier(yes).fetchImpl);
    expect(tick.actions).toMatchObject([
      { rule: 0, outcome: "refused", fence: "protected_label" },
      { rule: 1, outcome: "decided", fence: "protected_label", partial: true },
    ]);
    // A label rule that names nothing writes nothing.
    await setSettings(monitoring([labels([])]));
    ({ tick } = await runTest(classifier(yes).fetchImpl));
    expect(tick.actions).toMatchObject([{ rule: 0, outcome: "no_effect" }]);
    await setSettings({
      ...monitoring([labels(["inventada"])]),
      setLabels: { allowed: ["reembolso"] },
    });
    ({ tick } = await runTest(classifier(yes).fetchImpl));
    expect(tick.actions).toMatchObject([
      { rule: 0, outcome: "refused", fence: "allowed_labels" },
    ]);
  });

  // The bugs: the label fences asked of the conversation scope only, so a card's protected label read
  // as "would run"; and a contact write simulated on a conversation with no contact, where the tick
  // writes nothing (`no_effect`), satisfying a later precondition that the tick finds unmet.
  test("label fences hold on every scope, and a contact write needs a contact", async () => {
    const when = [{ question: "pede_reembolso", minProbability: 0.7 }];
    await setSettings({
      ...monitoring([
        {
          when,
          action: {
            tool: "set_labels",
            args: { add: ["vip"], remove: ["lead"], scope: "contact" },
          },
        },
        {
          when,
          action: {
            tool: "set_custom_attribute",
            args: { key: "pedido", value: "4471", scope: "contact" },
          },
        },
        {
          when,
          action: { tool: "private_note", args: { content: "Pedido" } },
        },
      ]),
      setLabels: { protected: ["vip"] },
      toolPreconditions: {
        private_note: { kind: "attribute", scope: "contact", key: "pedido" },
      },
    });
    // No contact: the contact writes have no effect, so the attribute the note asks for is not there.
    let { tick } = await runTest(classifier(yes).fetchImpl);
    expect(tick.actions).toMatchObject([
      { rule: 0, outcome: "no_effect" },
      { rule: 1, outcome: "no_effect" },
      { rule: 2, outcome: "refused", fence: "precondition" },
    ]);
    const contact = await suDb.contact.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        name: "Marina",
        chatwootContactId: 9,
      },
    });
    await suDb.conversation.update({
      where: { id: convRowId },
      data: { contactId: contact.id },
    });
    try {
      // With one: the protected label is refused on the contact scope too. `vip` already stands, so
      // the removal of `lead` is not held and the write goes through in part (read off the
      // contact's real labels, not assumed); and the attribute the earlier rule writes lets the
      // note through.
      contactLabels = ["vip", "lead"];
      ({ tick } = await runTest(classifier(yes).fetchImpl));
      expect(tick.actions).toMatchObject([
        {
          rule: 0,
          outcome: "decided",
          fence: "protected_label",
          partial: true,
        },
        { rule: 1, outcome: "decided" },
        { rule: 2, outcome: "decided" },
      ]);
      // And with `vip` not standing, the refused addition holds the removal: nothing is written.
      contactLabels = ["lead"];
      ({ tick } = await runTest(classifier(yes).fetchImpl));
      expect(tick.actions[0]).toMatchObject({
        rule: 0,
        outcome: "refused",
        fence: "protected_label",
      });
    } finally {
      await suDb.conversation.update({
        where: { id: convRowId },
        data: { contactId: null },
      });
      await suDb.contact.delete({ where: { id: contact.id } });
      contactLabels = [];
    }
  });

  // The bug: the contact gate leaves this conversation out, so a tick never classifies it, and the
  // test paid for a classification and reported rules about to act.
  test("a conversation the contact gate leaves out is skipped before the paid call", async () => {
    await setSettings({
      ...monitoring(),
      contactAuth: {
        enabled: true,
        rule: {
          kind: "attribute",
          scope: "conversation",
          key: "active",
          equals: "yes",
        },
      },
    });
    const c = classifier(yes);
    const { tick } = await runTest(c.fetchImpl);
    expect(tick.outcome).toBe("skipped");
    expect(tick.skipped).toBe("contact_gate");
    expect(c.calls.n).toBe(0);
  });

  // The bug: a simulated write of the key `__proto__` went through the inherited setter, so a later
  // precondition on that attribute read as unmet where the mirror's jsonb would hold it.
  test("an attribute named __proto__ is written as its own key", async () => {
    const when = [{ question: "pede_reembolso", minProbability: 0.7 }];
    await setSettings({
      ...monitoring([
        {
          when,
          action: {
            tool: "set_custom_attribute",
            args: { key: "__proto__", value: "x" },
          },
        },
        { when, action: { tool: "private_note", args: { content: "Nota" } } },
      ]),
      toolPreconditions: {
        private_note: {
          kind: "attribute",
          scope: "conversation",
          key: "__proto__",
        },
      },
    });
    const { tick } = await runTest(classifier(yes).fetchImpl);
    expect(tick.actions).toMatchObject([
      { rule: 0, outcome: "decided" },
      { rule: 1, outcome: "decided" },
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
    // The cause survives, so a wrong key (401) reads apart from an outage.
    expect(tick.failure).toBe("HTTP 500");
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
