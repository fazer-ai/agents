import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  DECISION_TRAIL_CAP,
  getConversationDetail,
} from "@/modules/conversations/service";
import { decisionsFingerprint } from "@/modules/decisions/config";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog } from "../utils/flowlog";

// The conversation page shows each decision tick of a "Questions and rules" observer (agents#1401):
// the `observe` line its engine writes reaches the trail as a `decision` entry carrying what the line
// stored, beside the tool rows and under a cap of its own, and with the agent's option descriptions
// only when the line ran the block the agent has now.

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

const QUESTIONS = [
  { name: "asks_refund", type: "yes_no", instructions: "Asks for a refund?" },
  {
    name: "topic",
    type: "choice",
    instructions: "What is it about?",
    options: [
      { value: "exchange", description: "exchange or return" },
      { value: "damaged", description: "arrived damaged" },
    ],
  },
] as const;
const RULES = [
  {
    when: [{ question: "asks_refund", minProbability: 0.7 }],
    action: { tool: "set_labels", args: { add: ["refund"] } },
  },
  {
    when: [{ question: "topic", equals: "damaged" }],
    action: { tool: "private_note", args: { text: "damaged" } },
  },
];
const BLOCK = {
  provider: "typesafe",
  model: "jev-latest",
  credentialRef: "vault:1",
  questions: QUESTIONS,
  rules: RULES,
};
const MARK = decisionsFingerprint(
  BLOCK as unknown as Parameters<typeof decisionsFingerprint>[0],
);

const ANSWERS = {
  asks_refund: { type: "yes_no", probability: 0.82 },
  topic: {
    type: "choice",
    choice: "exchange",
    confidence: 0.51,
    probabilities: { exchange: 0.59, damaged: 0.41 },
  },
};
const ACTIONS = [
  {
    rule: 0,
    tool: "set_labels",
    outcome: "ran",
    merged: [],
  },
];
const NOT_FIRED = [
  {
    rule: 1,
    miss: {
      question: "topic",
      why: "other_choice",
      got: "exchange",
      expected: "damaged",
    },
  },
];

let tenantId = 0n;
let otherTenantId = 0n;
let convId = 0n;
let otherConvId = 0n;
let agentId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

let clock = Date.parse("2026-10-12T10:00:00Z");
async function line(
  data: Partial<Prisma.ExecutionLogUncheckedCreateInput> & {
    detail: Prisma.InputJsonObject;
  },
) {
  clock += 1000;
  return suDb.executionLog.create({
    data: {
      tenantId,
      conversationId: convId,
      agentId,
      turnId: crypto.randomUUID(),
      source: "inbox",
      stage: "observe",
      level: "info",
      status: "ok",
      provider: "typesafe",
      model: "jev-latest",
      createdAt: new Date(clock),
      ...data,
    },
  });
}

const tick = (detail: Prisma.InputJsonObject = {}) =>
  line({
    durationMs: 700,
    detail: {
      reason: "burst",
      engine: "decisions",
      block: MARK,
      modelVersion: "jev-1.13.0",
      acted: true,
      answers: ANSWERS,
      actions: ACTIONS,
      notFired: NOT_FIRED,
      messagesRead: 4,
      labelsBefore: 0,
      ...detail,
    },
  });

const toolLine = (detail: Prisma.InputJsonObject = {}) =>
  line({
    stage: "tool",
    durationMs: 30,
    provider: null,
    model: null,
    detail: { tool: "set_labels", args: { add: ["refund"] }, ...detail },
  });

async function trail() {
  const d = await getConversationDetail(ctx(), convId, appDb);
  return d.trail;
}

describe.skipIf(!dbUp)(
  "decision ticks on the conversation trail (agents#1401)",
  () => {
    beforeAll(async () => {
      const mk = async (slug: string, accountId: number) => {
        const t = await suDb.tenant.create({
          data: { name: slug, slug: `${slug}-${process.pid}` },
        });
        const inst = await seedChatwootInstance(suDb, {
          tenantId: t.id,
          accountId,
          adminToken: "enc",
        });
        const inbox = await suDb.inbox.create({
          data: {
            tenantId: t.id,
            chatwootInstanceId: inst.id,
            chatwootInboxId: 10,
            name: "Support",
          },
        });
        const contact = await suDb.contact.create({
          data: {
            chatwootInstanceId: inst.id,
            tenantId: t.id,
            chatwootContactId: 5,
            name: "Alice",
          },
        });
        const conv = (n: number) =>
          suDb.conversation.create({
            data: {
              tenantId: t.id,
              chatwootInstanceId: inst.id,
              chatwootConversationId: n,
              inboxId: inbox.id,
              contactId: contact.id,
              status: "pending",
              assigneeType: "AgentBot",
              threadId: `${t.id}:${inst.id}:${n}`,
              lastEventAt: new Date("2026-10-12T10:00:00Z"),
            },
          });
        return { t, c1: await conv(100), c2: await conv(101) };
      };
      const a = await mk("DECTRAIL1401", 1);
      tenantId = a.t.id;
      convId = a.c1.id;
      otherConvId = a.c2.id;
      const b = await mk("DECTRAIL1401B", 2);
      otherTenantId = b.t.id;
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "watcher",
          systemPrompt: "",
          mode: "monitoring",
          settings: { monitoring: { engine: "decisions", decisions: BLOCK } },
        },
      });
      agentId = agent.id;
    });

    beforeEach(async () => {
      await clearFlowLog(suDb, { tenantId });
      if (otherTenantId) await clearFlowLog(suDb, { tenantId: otherTenantId });
    });

    afterAll(async () => {
      for (const t of [tenantId, otherTenantId]) {
        if (!t) continue;
        await clearFlowLog(suDb, { tenantId: t });
        await suDb.$executeRaw`DELETE FROM agents WHERE tenant_id = ${t}`;
        await suDb.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${t}`;
        await suDb.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${t}`;
        await suDb.$executeRaw`DELETE FROM inboxes WHERE tenant_id = ${t}`;
        await suDb.$executeRaw`DELETE FROM chatwoot_instances WHERE tenant_id = ${t}`;
        await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${t}`;
      }
      await su?.$disconnect();
      await app?.$disconnect();
    });

    test("a tick reaches the trail with what its line stored, field for field", async () => {
      const row = await tick();
      const entries = await trail();
      const d = entries.filter((e) => e.kind === "decision");
      expect(d).toHaveLength(1);
      const e = d[0];
      expect(e?.id).toBe(String(row.id));
      expect(e?.turnId).toBe(row.turnId);
      expect(e?.at).toBe(row.createdAt.toISOString());
      expect(e?.durationMs).toBe(700);
      expect(e?.decision).toMatchObject({
        outcome: "decided",
        provider: "typesafe",
        model: "jev-latest",
        modelVersion: "jev-1.13.0",
        reason: "burst",
        messagesRead: 4,
        answers: ANSWERS,
        actions: ACTIONS,
        notFired: NOT_FIRED,
        held: [],
      });
    });

    test("an action reaches the screen as its rule, tool and outcome, never a custom tool's arguments", async () => {
      await tick({
        actions: [
          {
            rule: 0,
            tool: "registrar_pedido",
            args: {
              token: "admin-payload",
              telefone: { from: "contact.phone" },
            },
            missing: ["telefone"],
            outcome: "failed",
            failure: "missing_value",
            merged: [1],
          },
        ],
      });
      const [e] = (await trail()).filter((x) => x.kind === "decision");
      expect(e?.decision?.actions).toEqual([
        {
          rule: 0,
          tool: "registrar_pedido",
          outcome: "failed",
          failure: "missing_value",
          merged: [1],
        },
      ]);
    });

    test("an agent that logs tool values shows the action's arguments as stored", async () => {
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          settings: {
            monitoring: { engine: "decisions", decisions: BLOCK },
            observability: { logToolValues: true },
          },
        },
      });
      const action = {
        rule: 0,
        tool: "registrar_pedido",
        args: { telefone: "+5511999990000" },
        missing: [],
        outcome: "ok",
      };
      await tick({ actions: [action] });
      const [e] = (await trail()).filter((x) => x.kind === "decision");
      expect(e?.decision?.actions).toEqual([action]);
    });

    test("the line that ran the current block carries its questions and rules; one that ran another does not", async () => {
      await tick();
      await tick({ block: "an-older-block" });
      const [now, older] = (await trail()).filter((e) => e.kind === "decision");
      expect(now?.decision?.block?.questions.map((q) => q.name)).toEqual([
        "asks_refund",
        "topic",
      ]);
      const topic = now?.decision?.block?.questions[1];
      expect(
        topic?.type === "choice" ? topic.options[0]?.description : null,
      ).toBe("exchange or return");
      expect(
        now?.decision?.block?.rules.map((r) => [r.tool, r.trigger]),
      ).toEqual([
        ["set_labels", "each_time"],
        ["private_note", "on_start"],
      ]);
      // The classifier prompts stay with the agent's configuration, which only an admin reads.
      expect(JSON.stringify(now?.decision?.block)).not.toContain(
        "instructions",
      );
      expect(older?.decision?.block).toBeNull();
      // The stored answers stay as stored either way.
      expect(older?.decision?.answers).toEqual(ANSWERS);
    });

    test("a skipped or failed tick is an entry, a warn skip failed and an info skip skipped", async () => {
      await line({
        status: "skipped",
        level: "warn",
        provider: null,
        model: null,
        detail: {
          reason: "burst",
          engine: "decisions",
          skipped: "decisions_config_invalid",
          problem: "monitoring.decisions.questions",
        },
      });
      await line({
        status: "error",
        level: "warn",
        detail: {
          reason: "burst",
          engine: "decisions",
          block: MARK,
          failed: "decision_call",
          failure: "HTTP 503",
          messagesRead: 4,
        },
      });
      await line({
        status: "skipped",
        level: "info",
        detail: {
          reason: "burst",
          engine: "decisions",
          skipped: "no_customer_message",
        },
      });
      const d = (await trail()).filter((e) => e.kind === "decision");
      expect(
        d.map((e) => [
          e.decision?.outcome,
          e.decision?.skipped ?? e.decision?.failed,
          e.decision?.problem ?? e.decision?.failure,
          e.decision?.answers,
        ]),
      ).toEqual([
        [
          "failed",
          "decisions_config_invalid",
          "monitoring.decisions.questions",
          null,
        ],
        ["failed", "decision_call", "HTTP 503", null],
        ["skipped", "no_customer_message", null, null],
      ]);
    });

    test("an llm observer's line and a decisions line with unreadable answers are not ticks", async () => {
      await line({
        detail: {
          reason: "burst",
          answers: { x: { type: "yes_no", probability: 0.5 } },
        },
      });
      await line({
        detail: { reason: "burst", engine: "decisions", answers: "broken" },
      });
      expect((await trail()).filter((e) => e.kind === "decision")).toEqual([]);
    });

    test("tool entries are the same with and without decision ticks beside them", async () => {
      await toolLine();
      await toolLine({ tool: "skip_reply", turnDelivered: true });
      await line({
        stage: "tool",
        status: "error",
        level: "warn",
        errorMessage: "boom",
        provider: null,
        model: null,
        detail: { tool: "handoff_to_human", args: {} },
      });
      const before = (await trail()).filter((e) => e.kind === "tool");
      await tick();
      await tick();
      const after = await trail();
      expect(after.filter((e) => e.kind === "tool")).toEqual(before);
      expect(after.filter((e) => e.kind === "decision")).toHaveLength(2);
    });

    test("decision ticks have a cap of their own: a chatty observer does not push tool rows out", async () => {
      const tools: string[] = [];
      for (let i = 0; i < 70; i++) tools.push(String((await toolLine()).id));
      const ticks: string[] = [];
      for (let i = 0; i < DECISION_TRAIL_CAP + 10; i++) {
        ticks.push(String((await tick()).id));
      }
      const entries = await trail();
      expect(entries.filter((e) => e.kind === "tool").map((e) => e.id)).toEqual(
        tools.slice(-60),
      );
      expect(
        entries.filter((e) => e.kind === "decision").map((e) => e.id),
      ).toEqual(ticks.slice(-DECISION_TRAIL_CAP));
      // Oldest first, across both reads.
      const ats = entries.map((e) => Date.parse(e.at));
      expect([...ats].sort((x, y) => x - y)).toEqual(ats);
    });

    test("another conversation's tick and another tenant's line are not on this trail", async () => {
      await tick();
      await line({
        conversationId: otherConvId,
        detail: { reason: "burst", engine: "decisions", answers: ANSWERS },
      });
      await line({
        tenantId: otherTenantId,
        agentId: null,
        detail: { reason: "burst", engine: "decisions", answers: ANSWERS },
      });
      expect((await trail()).filter((e) => e.kind === "decision")).toHaveLength(
        1,
      );
    });
  },
);
