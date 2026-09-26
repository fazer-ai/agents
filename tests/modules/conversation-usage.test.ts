import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { getConversationDetail } from "@/modules/conversations/service";
import { CONVERSATION_USAGE_TURN_CAP } from "@/modules/conversations/usage";
import { PRICE_TABLE_VERSION } from "@/modules/pricing/version";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #853: the conversation screen shows what the conversation has spent (header) and what each
// agent turn spent (timeline), from the usage ledger. The total is every row billed to the
// conversation whatever its node; a turn is the rows sharing a `turnId`; a row no turn owns counts in
// the total and in no turn; and nothing from the playground, another conversation or another tenant
// gets in.

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

const tenants: bigint[] = [];
let tenantId = 0n;
let otherTenantId = 0n;
let instanceId = 0n;
let otherInstanceId = 0n;
let nextConv = 100;

const ctx = (t = tenantId): TenantContext => ({
  tenantId: t,
  userId: null,
  role: "TENANT_ADMIN",
});

async function newConversation(t = tenantId, inst = instanceId) {
  const n = nextConv++;
  const conv = await suDb.conversation.create({
    data: {
      tenantId: t,
      chatwootInstanceId: inst,
      chatwootConversationId: n,
      status: "pending",
      assigneeType: "AgentBot",
      threadId: `${t}:${inst}:${n}`,
      lastEventAt: new Date(),
    },
  });
  return conv;
}

interface Row {
  conversationId: bigint | null;
  turnId?: string | null;
  node: string;
  source?: "inbox" | "playground";
  input: number;
  cached?: number;
  written?: number;
  output: number;
  at: string;
  tenant?: bigint;
  // The price the capture wrote (issue #863); absent is a row it could not price.
  cost?: string;
  // The table that priced it; absent is the one in the tree now when a cost is given.
  priceTable?: string;
}

async function bill(r: Row) {
  await suDb.llmUsage.create({
    data: {
      tenantId: r.tenant ?? tenantId,
      conversationId: r.conversationId,
      turnId: r.turnId ?? null,
      model: "gpt-test",
      node: r.node,
      source: r.source ?? "inbox",
      promptTokens: r.input,
      cachedReadTokens: r.cached ?? 0,
      cacheCreationTokens: r.written ?? 0,
      completionTokens: r.output,
      costUsd: r.cost,
      priceTable:
        r.priceTable ?? (r.cost === undefined ? null : PRICE_TABLE_VERSION),
      createdAt: new Date(r.at),
    },
  });
}

async function usageOf(convId: bigint, t = tenantId) {
  return (await getConversationDetail(ctx(t), convId, appDb)).usage;
}

describe.skipIf(!dbUp)("what a conversation spent (issue #853)", () => {
  beforeAll(async () => {
    for (const slug of ["u853", "u853-other"]) {
      const t = await suDb.tenant.create({
        data: { name: slug, slug: `${slug}-${process.pid}` },
      });
      tenants.push(t.id);
    }
    [tenantId, otherTenantId] = tenants as [bigint, bigint];
    instanceId = (
      await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 1,
        adminToken: "enc",
      })
    ).id;
    otherInstanceId = (
      await seedChatwootInstance(suDb, {
        tenantId: otherTenantId,
        accountId: 2,
        adminToken: "enc",
      })
    ).id;
  });

  afterAll(async () => {
    for (const t of tenants) {
      for (const table of [
        "llm_usage",
        "execution_logs",
        "conversations",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = $1`,
          t,
        );
      }
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${t}`;
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("the total sums every node, a turn sums its own rows, and a row no turn owns is in the total only", async () => {
    const conv = await newConversation();
    const other = await newConversation();
    const foreign = await newConversation(otherTenantId, otherInstanceId);
    const c = conv.id;
    // Turn A: the agent, its guardrail and the image read.
    await bill({
      conversationId: c,
      turnId: "tA",
      node: "agent",
      input: 1000,
      cached: 600,
      output: 50,
      at: "2026-09-25T10:00:01Z",
    });
    await bill({
      conversationId: c,
      turnId: "tA",
      node: "guardrail",
      input: 400,
      output: 20,
      at: "2026-09-25T10:00:03Z",
    });
    await bill({
      conversationId: c,
      turnId: "tA",
      node: "vision",
      input: 200,
      output: 5,
      at: "2026-09-25T10:00:00Z",
    });
    // Turn B: the agent and the speech rewrite, with a cache write.
    await bill({
      conversationId: c,
      turnId: "tB",
      node: "agent",
      input: 3000,
      written: 2500,
      output: 150,
      at: "2026-09-25T10:05:00Z",
    });
    await bill({
      conversationId: c,
      turnId: "tB",
      node: "tts_normalize",
      input: 100,
      output: 50,
      at: "2026-09-25T10:05:02Z",
    });
    // Compaction runs as a job and owns no turn.
    await bill({
      conversationId: c,
      node: "memory_compact",
      input: 500,
      output: 100,
      at: "2026-09-25T11:00:00Z",
    });
    // None of these is this conversation's real traffic.
    await bill({
      conversationId: c,
      turnId: "tP",
      node: "agent",
      source: "playground",
      input: 90000,
      output: 9000,
      at: "2026-09-25T10:01:00Z",
    });
    await bill({
      conversationId: other.id,
      turnId: "tO",
      node: "agent",
      input: 70000,
      output: 7000,
      at: "2026-09-25T10:02:00Z",
    });
    await bill({
      tenant: otherTenantId,
      conversationId: foreign.id,
      turnId: "tF",
      node: "agent",
      input: 50000,
      output: 5000,
      at: "2026-09-25T10:03:00Z",
    });

    const usage = await usageOf(c);
    expect(usage.total).toEqual({
      calls: 6,
      promptTokens: 5200,
      cachedReadTokens: 600,
      cacheCreationTokens: 2500,
      completionTokens: 375,
      byNode: {
        agent: 2,
        guardrail: 1,
        vision: 1,
        tts_normalize: 1,
        memory_compact: 1,
      },
      costUsd: 0,
      unpricedCalls: 6,
      olderTablePricedCalls: 0,
      tenantPricedCalls: 0,
      reportedPricedCalls: 0,
    });
    expect(usage.turns).toEqual([
      {
        turnId: "tA",
        // The LAST billed call of the turn, not its first.
        at: "2026-09-25T10:00:03.000Z",
        usage: {
          calls: 3,
          promptTokens: 1600,
          cachedReadTokens: 600,
          cacheCreationTokens: 0,
          completionTokens: 75,
          byNode: { agent: 1, guardrail: 1, vision: 1 },
          costUsd: 0,
          unpricedCalls: 3,
          olderTablePricedCalls: 0,
          tenantPricedCalls: 0,
          reportedPricedCalls: 0,
        },
        // No closing line was written for these seeded turns, and no call was timed.
        messageIds: [],
        turnMs: null,
        modelMs: null,
      },
      {
        turnId: "tB",
        at: "2026-09-25T10:05:02.000Z",
        usage: {
          calls: 2,
          promptTokens: 3100,
          cachedReadTokens: 0,
          cacheCreationTokens: 2500,
          completionTokens: 200,
          byNode: { agent: 1, tts_normalize: 1 },
          costUsd: 0,
          unpricedCalls: 2,
          olderTablePricedCalls: 0,
          tenantPricedCalls: 0,
          reportedPricedCalls: 0,
        },
        messageIds: [],
        turnMs: null,
        modelMs: null,
      },
    ]);
    // Positive control for the exclusions above: the rows left out are there, and each is read
    // where it belongs.
    expect((await usageOf(other.id)).total.promptTokens).toBe(70000);
    expect((await usageOf(foreign.id, otherTenantId)).total.promptTokens).toBe(
      50000,
    );
  });

  test("a conversation with nothing billed says zero calls and no turns", async () => {
    const conv = await newConversation();
    const usage = await usageOf(conv.id);
    expect(usage.total.calls).toBe(0);
    expect(usage.turns).toEqual([]);
  });

  // Issue #858: a turn is hung on the messages its closing line names (#855), and the line gives
  // its wall time; a line that is not a closing one (no turnMs) names nothing.
  test("a turn carries the message ids and the time its closing line recorded", async () => {
    const conv = await newConversation();
    await bill({
      conversationId: conv.id,
      turnId: "tClosed",
      node: "agent",
      input: 100,
      output: 10,
      at: "2026-09-25T14:00:00Z",
    });
    await bill({
      conversationId: conv.id,
      turnId: "tOpen",
      node: "agent",
      input: 100,
      output: 10,
      at: "2026-09-25T14:01:00Z",
    });
    const line = (turnId: string, detail: Record<string, unknown>) =>
      suDb.executionLog.create({
        data: {
          tenantId,
          turnId,
          conversationId: conv.id,
          stage: "generate",
          source: "inbox",
          detail: detail as never,
        },
      });
    await line("tClosed", { turnMs: 4200, sentMessageIds: [501, 502, "x"] });
    await line("tOpen", { sentMessageIds: [900] });
    const usage = await usageOf(conv.id);
    const byTurn = Object.fromEntries(usage.turns.map((t) => [t.turnId, t]));
    expect(byTurn.tClosed?.messageIds).toEqual([501, 502]);
    expect(byTurn.tClosed?.turnMs).toBe(4200);
    expect(byTurn.tOpen?.messageIds).toEqual([]);
    expect(byTurn.tOpen?.turnMs).toBeNull();
  });

  // Issue #863: the cost is summed from the column, the calls it could not price are counted beside
  // it, and the Decimal sum comes back exact to the cent's ten-thousandth and past it.
  test("a total and a turn carry the priced calls' cost and count the unpriced ones", async () => {
    const conv = await newConversation();
    const base = { conversationId: conv.id, input: 100, output: 10 };
    await bill({
      ...base,
      turnId: "tP",
      node: "agent",
      cost: "0.0001234567",
      at: "2026-09-25T13:00:00Z",
    });
    await bill({
      ...base,
      turnId: "tP",
      node: "guardrail",
      cost: "0.0000000001",
      at: "2026-09-25T13:00:01Z",
    });
    await bill({
      ...base,
      turnId: "tM",
      node: "agent",
      cost: "0.25",
      at: "2026-09-25T13:01:00Z",
    });
    await bill({
      ...base,
      turnId: "tM",
      node: "vision",
      at: "2026-09-25T13:01:01Z",
    });
    await bill({
      ...base,
      turnId: "tU",
      node: "agent",
      at: "2026-09-25T13:02:00Z",
    });
    const usage = await usageOf(conv.id);
    expect(usage.total.costUsd).toBeCloseTo(0.2501234568, 10);
    expect(usage.total.unpricedCalls).toBe(2);
    const byTurn = Object.fromEntries(
      usage.turns.map((t) => [
        t.turnId,
        [t.usage.costUsd, t.usage.unpricedCalls],
      ]),
    );
    expect(byTurn.tP?.[0]).toBeCloseTo(0.0001234568, 10);
    expect(byTurn.tP?.[1]).toBe(0);
    expect(byTurn.tM).toEqual([0.25, 1]);
    // Nothing priced is a zero SUM with every call counted as unpriced, which the screen reads as
    // "no price", never as $0.
    expect(byTurn.tU).toEqual([0, 1]);
  });

  // A reopened turn keeps the figure its own table gave it, so the screen must not put today's
  // table date on it: the readers count the calls an older table priced.
  test("calls an older price table priced are counted apart from the current table's", async () => {
    const conv = await newConversation();
    const base = { conversationId: conv.id, input: 100, output: 10 };
    await bill({
      ...base,
      turnId: "tOld",
      node: "agent",
      cost: "0.01",
      priceTable: "litellm@000000000old",
      at: "2026-09-25T15:00:00Z",
    });
    await bill({
      ...base,
      turnId: "tNew",
      node: "agent",
      cost: "0.02",
      at: "2026-09-25T15:01:00Z",
    });
    const usage = await usageOf(conv.id);
    expect(usage.total.olderTablePricedCalls).toBe(1);
    const byTurn = Object.fromEntries(
      usage.turns.map((t) => [t.turnId, t.usage.olderTablePricedCalls]),
    );
    expect(byTurn).toEqual({ tOld: 1, tNew: 0 });
  });

  test("the observer's calls are billed to the conversation it watched", async () => {
    const conv = await newConversation();
    await bill({
      conversationId: conv.id,
      turnId: "tAgent",
      node: "agent",
      input: 1000,
      cached: 100,
      output: 10,
      at: "2026-09-25T12:00:00Z",
    });
    await bill({
      conversationId: conv.id,
      turnId: "tObs",
      node: "observer",
      input: 300,
      output: 10,
      at: "2026-09-25T12:00:05Z",
    });
    const usage = await usageOf(conv.id);
    expect(usage.total.promptTokens).toBe(1300);
    expect(usage.total.calls).toBe(2);
  });

  test("only the newest turns come back, oldest first", async () => {
    const conv = await newConversation();
    const extra = 3;
    const base = Date.parse("2026-09-26T00:00:00Z");
    for (let i = 0; i < CONVERSATION_USAGE_TURN_CAP + extra; i++) {
      await bill({
        conversationId: conv.id,
        turnId: `t${i}`,
        node: "agent",
        input: 1,
        output: 1,
        at: new Date(base + i * 60_000).toISOString(),
      });
    }
    // The newest row owns no turn, and must not take one of the lines' places.
    await bill({
      conversationId: conv.id,
      node: "memory_compact",
      input: 1,
      output: 1,
      at: new Date(base + 1_000 * 60_000).toISOString(),
    });
    const usage = await usageOf(conv.id);
    expect(usage.turns.length).toBe(CONVERSATION_USAGE_TURN_CAP);
    expect(usage.turns[0]?.turnId).toBe(`t${extra}`);
    expect(usage.turns.at(-1)?.turnId).toBe(
      `t${CONVERSATION_USAGE_TURN_CAP + extra - 1}`,
    );
    // The cap is on the lines, never on the total.
    expect(usage.total.calls).toBe(CONVERSATION_USAGE_TURN_CAP + extra + 1);
  });
});
