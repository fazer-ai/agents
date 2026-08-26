import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

// AN INBOX NOBODY BOUND, AND THE MESSAGES IT SWALLOWS.
//
// The mirror creates an `Inbox` row for any inbox that sends us traffic, deliberately — mirroring has
// to work before an operator binds anything. So the row for a channel just connected in Chatwoot
// exists, has no agent, consumes every delivery and answers nothing. The conversation shows the
// customer waiting, and until issue #318 the console showed nothing at all: the only trace was one
// process log line on the server, which is not what an operator reads.
//
// The effect asserted here is the row in `execution_logs`, because that is what the Logs page reads —
// the same choice issue #271 made for the ownership gate.

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

// Never seeded: the mirror is what creates it, which is the mechanism this file is about.
const UNBOUND_INBOX = 81;
const BOUND_INBOX = 82;
let tenantId = 0n;
let instanceId = 0n;
let agentDbId = 0n;
let deliverySeq = 0;
let messageSeq = 8000;
let stamp = Math.floor(Date.now() / 1000);

const realFetch = globalThis.fetch;

describe.skipIf(!dbUp)("an unbound inbox says so", () => {
  beforeAll(async () => {
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const t = await suDb.tenant.create({
      data: { name: "UB", slug: `ub-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 22,
      baseUrl: "https://chat.unbound.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        settings: { debounce: { enabled: false } },
      },
    });
    agentDbId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `ub-route-${process.pid}`,
        name: "Atendente",
      },
    });
    // The control: an inbox with the same traffic and an agent behind it.
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: BOUND_INBOX,
        name: "Vendas",
        agentId: agent.id,
      },
    });
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!dbUp) return;
    for (const table of [
      "execution_logs",
      "scheduler_jobs",
      "chatwoot_webhook_deliveries",
      "conversations",
      "contacts",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
      "chatwoot_instances",
      "chatwoot_deployments",
    ]) {
      await suDb
        .$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = ${tenantId}`)
        .catch(() => {});
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // Open gate throughout: `pending` with nobody assigned is the state a customer message arrives in,
  // and it is what separates this silence from the ownership one.
  function conversation(convId: number, inboxId: number) {
    stamp += 1;
    return {
      id: convId,
      inbox_id: inboxId,
      status: "pending",
      contact_inbox: { id: 81_000 + convId },
      meta: { assignee: null, sender: { id: 77, name: "Cliente" } },
      channel: "Channel::Api",
      last_activity_at: Math.floor(Date.now() / 1000),
      updated_at: stamp,
    };
  }

  async function deliver(
    convId: number,
    inboxId: number,
    over: { event?: string; message?: Record<string, unknown> } = {},
  ): Promise<void> {
    deliverySeq += 1;
    messageSeq += 1;
    const event = over.event ?? "message_created";
    const n = normalizeChatwootEvent({
      event,
      id: messageSeq,
      private: false,
      content: "oi, tem alguém aí?",
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
      ...over.message,
      conversation: conversation(convId, inboxId),
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `ub-${process.pid}-${deliverySeq}`,
        event,
        status: "PENDING",
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: 9,
      normalized: n,
      base: appDb,
    });
  }

  // Scoped to the conversation asked for, by its INTERNAL id, and polled: the emit is
  // fire-and-forget, so an unscoped read answers with a neighbour's row and an unpolled one races
  // the write it is asserting.
  async function routeRows(convId: number, waitMs = 2000) {
    const conv = await suDb.conversation.findFirst({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    if (!conv) return [];
    const deadline = Date.now() + waitMs;
    for (;;) {
      const rows = await suDb.executionLog.findMany({
        where: { tenantId, stage: "route", conversationId: conv.id },
        orderBy: { id: "asc" },
      });
      if (rows.length > 0 || Date.now() > deadline) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  test("a message on an inbox nobody bound writes the line, naming the inbox", async () => {
    await deliver(8101, UNBOUND_INBOX);
    // The row the mirror created on the way past, which is how these inboxes come to exist at all.
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: UNBOUND_INBOX },
      select: { id: true, agentId: true },
    });
    expect(inbox.agentId).toBeNull();
    const rows = await routeRows(8101);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe("warn");
    expect(rows[0]?.status).toBe("skipped");
    // Null BY CONSTRUCTION: there is no agent, which is the fact. The inbox is what names it.
    expect(rows[0]?.agentId).toBeNull();
    expect(rows[0]?.inboxId).toBe(inbox.id);
    expect(rows[0]?.detail).toEqual({
      outcome: "no_agent",
      chatwootInboxId: UNBOUND_INBOX,
    });
  });

  // One line per customer message, never one per webhook event — the same boundary the ownership
  // gate's line draws, and for the same reason: a `message_updated` is usually our own media
  // write-back coming back around.
  test("an event that is not a new incoming message writes no line", async () => {
    await deliver(8102, UNBOUND_INBOX, { event: "message_updated" });
    expect(await routeRows(8102, 300)).toEqual([]);
  });

  // The control that proves the line is about the binding and not about the traffic.
  test("the same message on a bound inbox writes no line", async () => {
    await deliver(8103, BOUND_INBOX);
    expect(await routeRows(8103, 300)).toEqual([]);
    expect(agentDbId).toBeGreaterThan(0n);
  });

  // The state this line must NOT claim, found by review. `runAgentTurn` answers `no-agent` for a
  // disabled agent too — `loadAgentConfig` returns null on the `enabled` flag, one step past the
  // binding — so keying on the outcome alone tells an operator who switched their agent off, at
  // `warn` and through their alert channel, that the inbox has no agent. It has one; they turned it
  // off, which is a deliberate state and the same exclusion the ownership gate's line makes.
  test("a bound agent that is switched off writes no line", async () => {
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { enabled: false },
    });
    try {
      await deliver(8104, BOUND_INBOX);
      expect(await routeRows(8104, 300)).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { enabled: true },
      });
    }
  });
});
