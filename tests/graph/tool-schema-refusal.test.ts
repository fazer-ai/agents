import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// A TOOL CALL THE SCHEMA REFUSED USED TO LEAVE NOTHING BEHIND (issue #667).
//
// LangChain validates the arguments inside `StructuredTool.call`, before the callback manager is
// configured, so `ToolFlowLogger` gets no `handleToolStart` and no `handleToolError` for a refused
// call: not a missing handler, a missing callback. The model sees the refusal and tries again, and
// a turn where the agent tried three times to hand a conversation to a human and never managed to
// was byte for byte identical, in `execution_logs`, to a turn where it tried nothing at all.
//
// Everything here is measured through `runAgentTurn` against a real Postgres, because the subject is
// the ROW: which stage, which level, which correlation columns, and what `detail` is allowed to
// carry. A unit test of the wrapper could not answer any of those.
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

const BOT = 9;
const INBOX = 7;
let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;

type Call = { name: string; args: Record<string, unknown> };
type Detail = Record<string, unknown>;

interface Row {
  stage: string;
  status: string | null;
  level: string;
  turnId: string | null;
  source: string;
  agentId: bigint | null;
  conversationId: bigint | null;
  inboxId: bigint | null;
  threadId: string | null;
  detail: unknown;
  errorMessage: string | null;
}

const det = (r: Row): Detail => (r.detail ?? {}) as Detail;
const tools = (rows: Row[]): Row[] => rows.filter((r) => r.stage === "tool");
// The marker under test, asked the way an operator would: one structural field, no error text.
const refused = (rows: Row[]): Row[] =>
  tools(rows).filter((r) => det(r).phase === "schema_refusal");
const ran = (rows: Row[]): Row[] =>
  tools(rows).filter((r) => det(r).phase === undefined);
const refusalOf = (r: Row) =>
  det(r).refused as { params: string[]; issues: string[] };

function recorder(opts: { toggleFailsTimes?: number } = {}) {
  let toggleFails = opts.toggleFailsTimes ?? 0;
  const msgs: string[] = [];
  const notes: string[] = [];
  const client = {
    get muted() {
      return false;
    },
    sendMessage: async (_c: number, t: string) => {
      msgs.push(t);
      return {};
    },
    sendPrivateNote: async (_c: number, t: string) => {
      notes.push(t);
      return {};
    },
    toggleStatus: async () => {
      if (toggleFails > 0) {
        toggleFails -= 1;
        throw new Error("chatwoot 502");
      }
      return {};
    },
    assignToAgent: async () => ({}),
    assignTeam: async () => ({}),
    getConversation: async (c: number) => ({
      id: c,
      status: "pending",
      meta: {},
    }),
    getConversationLabels: async () => [],
    setConversationLabels: async () => ({}),
    toggleTyping: async () => ({}),
    sendFileAttachment: async () => ({}),
  } as unknown as ChatwootClient;
  return { makeClient: async () => client, msgs, notes };
}

// The model is SCRIPTED: which tool it calls with which arguments is its decision, and what is under
// test is what the product records about that decision.
class Scripted {
  // What came back for each tool call, so the refusal the MODEL reads can be asserted alongside the
  // row the operator reads: the line is added, and the conversation with the model is untouched.
  readonly answers: string[] = [];
  constructor(private readonly calls: Call[]) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage("");
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(messages: BaseMessage[]): Promise<AIMessage> {
        for (const m of messages) {
          if (m.getType() === "tool") {
            const text = String(m.content);
            if (!self.answers.includes(text)) self.answers.push(text);
          }
        }
        const step = self.calls[n];
        n += 1;
        return step
          ? new AIMessage({
              content: "",
              tool_calls: [
                {
                  name: step.name,
                  args: step.args,
                  id: `call_${n}`,
                  type: "tool_call" as const,
                },
              ],
            })
          : new AIMessage("");
      },
    };
  }
}

const incoming = (conversationId: number): NormalizedChatwootEvent => ({
  event: "message_created",
  conversationId,
  inboxId: INBOX,
  status: "pending",
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
  contactInboxId: null,
  message: { id: 1, content: "oi", messageType: "incoming", private: false },
});

async function seedConv(convId: number): Promise<bigint> {
  const c = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: null,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
      lastInboundAt: new Date(),
    },
    select: { id: true },
  });
  return c.id;
}

async function runTurn(
  convId: number,
  calls: Call[],
  opts: { toggleFailsTimes?: number } = {},
) {
  const convDbId = await seedConv(convId);
  const r = recorder(opts);
  const model = new Scripted(calls);
  const outcome = await runAgentTurn({
    tenantId,
    instanceId,
    agentBotId: BOT,
    event: incoming(convId),
    base: appDb,
    deps: {
      makeModel: () => model as unknown as BaseChatModel,
      makeClient: r.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    },
  });
  // The ONE reader in this file, scoped to the conversation each case owns.
  const rows = (await flowLogRows(suDb, {
    where: { tenantId, conversationId: convDbId },
    orderBy: { id: "asc" },
    select: {
      stage: true,
      status: true,
      level: true,
      turnId: true,
      source: true,
      agentId: true,
      conversationId: true,
      inboxId: true,
      threadId: true,
      detail: true,
      errorMessage: true,
    },
  })) as Row[];
  const conv = await suDb.conversation.findFirstOrThrow({
    where: { id: convDbId },
    select: { status: true },
  });
  return {
    outcome,
    rows,
    msgs: r.msgs,
    notes: r.notes,
    status: conv.status,
    answers: model.answers,
  };
}

describe.skipIf(!dbUp)("a tool call refused by its own schema", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "T667", slug: `t667-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const key = await suDb.vaultEntry.create({
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
          credentialRef: `vault:${key.id}`,
        },
        // `observability.logToolValues` stays at its default (off), which is the condition every
        // assertion about shapes below is made under.
        settings: { split: { enabled: false } },
      },
      select: { id: true },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: BOT,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `t667-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX,
        name: "Suporte",
        agentId: agent.id,
      },
    });
    inboxDbId = inbox.id;
  });

  afterAll(async () => {
    await settleFlowEvents();
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      for (const table of [
        "alert_deliveries",
        "alert_channels",
        "llm_usage",
        "agent_threads",
        "scheduler_jobs",
        "conversations",
        "contacts",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "vault_entries",
        "chatwoot_instances",
      ]) {
        await suDb
          .$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => 0);
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
  });

  test("leaves a tool line naming the tool and the parameter that did not come", async () => {
    const t = await runTurn(6701, [
      { name: "handoff_to_human", args: { reason: "cliente quer humano" } },
    ]);
    // The fix is instrumentation: the turn does exactly what it did before.
    expect(t.outcome).toBe("empty");
    expect(t.msgs).toEqual([]);
    // Where there were zero.
    expect(tools(t.rows).length).toBeGreaterThanOrEqual(1);
    const line = refused(t.rows)[0];
    expect(line).toBeDefined();
    expect(det(line as Row).tool).toBe("handoff_to_human");
    // A STRUCTURAL field, not a sentence to be read: the call was refused validating arguments.
    expect(det(line as Row).phase).toBe("schema_refusal");
    expect(refusalOf(line as Row).params).toEqual(["customerMessage"]);
    expect(refusalOf(line as Row).issues).toEqual(["customerMessage: missing"]);
    // Additional, never a replacement: the line that already existed is untouched.
    const gen = t.rows.filter((r) => r.stage === "generate");
    expect(gen.map((r) => r.status)).toEqual(["ok"]);
    // And the refusal still reaches the model, unchanged: the wrapper observes, it does not answer.
    expect(t.answers.length).toBe(1);
    expect(t.answers[0]).toContain("did not match expected schema");
  });

  test("tried and failed stops being identical to did not try", async () => {
    const a = await runTurn(6702, [
      { name: "handoff_to_human", args: { reason: "cliente quer humano" } },
    ]);
    const b = await runTurn(6703, []);
    expect(tools(a.rows).length).toBe(1);
    // THE CONTROL AGAINST A FALSE POSITIVE: no attempt, no line. Counting `stage='tool'` rows of one
    // turn is what answers "did the model try to use a tool here", with no error text opened.
    expect(tools(b.rows).length).toBe(0);
    expect(b.rows.map((r) => `${r.stage}/${r.status}/${r.level}`)).toEqual([
      "generate/ok/info",
    ]);
    expect(Object.keys(det(b.rows[0] as Row))).toEqual(["systemPrompt"]);
  });

  test("a refusal and a hit in the same turn are two countable lines", async () => {
    const t = await runTurn(6704, [
      { name: "handoff_to_human", args: { reason: "quero humano" } },
      {
        name: "handoff_to_human",
        args: {
          reason: "quero humano",
          customerMessage: "um humano já vai te atender",
        },
      },
    ]);
    expect(tools(t.rows).length).toBe(2);
    expect(tools(t.rows).map((r) => det(r).tool)).toEqual([
      "handoff_to_human",
      "handoff_to_human",
    ]);
    // Exactly one of each, which is what makes "how many attempts did it spend" a count.
    expect(refused(t.rows).length).toBe(1);
    expect(ran(t.rows).length).toBe(1);
    const done = ran(t.rows)[0] as Row;
    expect(det(done).args).toEqual({
      reason: "string(12)",
      customerMessage: "string(27)",
    });
    expect(det(done).output).toBeDefined();
    // The instrumentation neither duplicates nor reorders the effect.
    expect(t.outcome).toBe("posted");
    expect(t.msgs).toEqual(["um humano já vai te atender"]);
    expect(t.notes.length).toBe(1);
  });

  test("a validation refusal is told from an execution error by field, not by text", async () => {
    const c = await runTurn(6705, [
      { name: "handoff_to_human", args: { reason: "quero humano" } },
    ]);
    const d = await runTurn(
      6706,
      [
        {
          name: "handoff_to_human",
          args: { reason: "quero humano", customerMessage: "já vai" },
        },
      ],
      { toggleFailsTimes: 1 },
    );
    const cl = tools(c.rows)[0] as Row;
    const dl = tools(d.rows)[0] as Row;
    expect(det(cl).tool).toBe("handoff_to_human");
    expect(det(dl).tool).toBe("handoff_to_human");
    // The discriminator is the field.
    expect(det(cl).phase).toBe("schema_refusal");
    expect(det(dl).phase).toBeUndefined();
    // The failure line is exactly what it was.
    expect([dl.status, dl.level, dl.errorMessage]).toEqual([
      "error",
      "warn",
      "chatwoot 502",
    ]);
    expect(det(dl).args).toEqual({
      reason: "string(12)",
      customerMessage: "string(6)",
    });
    expect(det(dl).output).toBeUndefined();
    // No result to record: the tool never ran.
    expect(det(cl).output).toBeUndefined();
    expect([cl.status, cl.level]).toEqual(["skipped", "info"]);
  });

  test("the refusal line publishes no argument value", async () => {
    const MARKER_VALUE = "MARCADOR667CPF52998224725";
    const MARKER_KEY = "MARCADORINVENTADO52998224725";
    const e = await runTurn(6707, [
      {
        name: "handoff_to_human",
        args: { reason: `${MARKER_VALUE} quer humano` },
      },
    ]);
    const f = await runTurn(6708, [
      {
        name: "handoff_to_human",
        args: {
          reason: "x",
          customerMessage: 52998224725,
          message: MARKER_KEY,
        },
      },
    ]);
    expect(refused(e.rows).length).toBe(1);
    expect(refused(f.rows).length).toBe(1);
    // Every field of every line of both turns, `errorMessage` included.
    const everything = JSON.stringify([...e.rows, ...f.rows], (_k, v) =>
      typeof v === "bigint" ? String(v) : v,
    );
    expect(everything).not.toContain(MARKER_VALUE);
    expect(everything).not.toContain(MARKER_KEY);
    // What ARRIVED, by the rule the executed call's line already follows: shapes, declared keys named
    // and an invented one counted.
    expect(det(refused(e.rows)[0] as Row).args).toEqual({
      reason: "string(37)",
    });
    expect(det(refused(f.rows)[0] as Row).args).toEqual({
      reason: "string(1)",
      "[unnamed keys]": 1,
      customerMessage: "number",
    });
    // The declared PARAMETER name is not a value, and it is the whole point of the line.
    expect(refusalOf(refused(e.rows)[0] as Row).params).toEqual([
      "customerMessage",
    ]);
    // Missing and wrong-typed are different reasons, and neither writes the value received.
    expect(refusalOf(refused(e.rows)[0] as Row).issues).toEqual([
      "customerMessage: missing",
    ]);
    expect(refusalOf(refused(f.rows)[0] as Row).issues).toEqual([
      "customerMessage: expected string, received number",
    ]);
  });

  test("it is the refusal path that is recorded, not one tool", async () => {
    const t = await runTurn(6709, [
      { name: "set_custom_attribute", args: { scope: "conversation" } },
    ]);
    const line = refused(t.rows)[0] as Row;
    expect(line).toBeDefined();
    expect(det(line).tool).toBe("set_custom_attribute");
    // BOTH parameters that did not come, not just the first.
    expect(refusalOf(line).params).toEqual(["key", "value"]);
    expect(refusalOf(line).issues).toEqual(["key: missing", "value: missing"]);
    // Same field, same vocabulary as the handoff case: only the tool's name differs.
    expect(det(line).phase).toBe("schema_refusal");
    expect(det(line).args).toEqual({ scope: "string(12)" });
  });

  test("a burst of refusals pays no alert, and the failure alert still fires", async () => {
    const channel = await suDb.alertChannel.create({
      data: {
        tenantId,
        type: "webhook",
        name: "canal",
        url: encryptJson("https://example.com/hook"),
        minLevel: "warn",
        enabled: true,
      },
      select: { id: true, stages: true },
    });
    // Every stage, so nothing below is explained by a stage allowlist.
    expect(channel.stages).toEqual([]);
    const g = await runTurn(6710, [
      { name: "handoff_to_human", args: { reason: "a" } },
      { name: "handoff_to_human", args: { reason: "b" } },
      { name: "handoff_to_human", args: { reason: "c" } },
      {
        name: "handoff_to_human",
        args: { reason: "d", customerMessage: "já vai" },
      },
    ]);
    await settleFlowEvents();
    await Bun.sleep(300);
    const afterG = await suDb.alertDelivery.findMany({
      where: { tenantId },
      select: { stage: true, level: true, summary: true },
    });
    expect(refused(g.rows).length).toBe(3);
    // The mechanism is the LEVEL, and `AlertChannel.minLevel` cannot go below warn.
    expect(refused(g.rows).map((r) => r.level)).toEqual([
      "info",
      "info",
      "info",
    ]);
    expect(afterG).toEqual([]);
    const h = await runTurn(
      6711,
      [
        {
          name: "handoff_to_human",
          args: { reason: "x", customerMessage: "já vai" },
        },
      ],
      { toggleFailsTimes: 1 },
    );
    await settleFlowEvents();
    await Bun.sleep(300);
    const afterH = await suDb.alertDelivery.findMany({
      where: { tenantId },
      select: { stage: true, level: true },
    });
    expect(tools(h.rows).map((r) => r.level)).toEqual(["warn"]);
    expect(afterH).toEqual([{ stage: "tool", level: "warn" }]);
    await suDb.alertDelivery.deleteMany({ where: { tenantId } });
    await suDb.alertChannel.delete({ where: { id: channel.id } });
  });

  test("the refusal line lands on the same turn card the Logs page draws", async () => {
    const t = await runTurn(6712, [
      { name: "handoff_to_human", args: { reason: "cliente quer humano" } },
    ]);
    const gen = t.rows.find((r) => r.stage === "generate") as Row;
    const line = refused(t.rows)[0] as Row;
    expect([gen, line].every(Boolean)).toBe(true);
    // Without the same turn id it shows on its own card, or on none.
    expect(line.turnId).toBe(gen.turnId);
    // The page filters `source='inbox'` by default: another value is invisible without the operator
    // knowing they have to change the filter.
    expect(line.source).toBe("inbox");
    expect([
      line.agentId,
      line.conversationId,
      line.inboxId,
      line.threadId,
    ]).toEqual([gen.agentId, gen.conversationId, gen.inboxId, gen.threadId]);
    expect(line.agentId).not.toBeNull();
    expect(line.threadId).not.toBeNull();
    // A stage the filter already accepts: no screen has to change for the line to show up.
    expect(line.stage).toBe("tool");
    // Ids, counts and enums, of the kind `GET /v1/logs/export` can dump to CSV.
    expect(Object.keys(det(line)).sort()).toEqual([
      "args",
      "phase",
      "refused",
      "tool",
    ]);
    expect(Object.values(det(line).args as Detail)).toEqual(["string(19)"]);
  });

  test("the turn that gave up says so, by count", async () => {
    const t = await runTurn(6713, [
      { name: "handoff_to_human", args: { reason: "a" } },
      { name: "handoff_to_human", args: { reason: "b" } },
      { name: "handoff_to_human", args: { reason: "c" } },
    ]);
    expect(refused(t.rows).length).toBe(3);
    // It never managed to use the tool once.
    expect(ran(t.rows)).toEqual([]);
    expect(t.outcome).toBe("empty");
    expect(t.msgs).toEqual([]);
    expect(t.status).toBe("pending");
    expect(refused(t.rows).map((r) => (det(r).args as Detail).reason)).toEqual([
      "string(1)",
      "string(1)",
      "string(1)",
    ]);
  });
});
