import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// The webhook's own ownership gate, and the line it leaves behind.
//
// Every message that arrives on a conversation the bot no longer owns takes this exit, and until
// issue #271 it produced one process log line that named no reason and nothing the operator's console
// could show. The customer keeps writing, the bot stays silent, and the trail an investigation reads
// is empty — which is how the ack escalation was first read as a human takeover.
//
// The effect asserted here is the row in `execution_logs`, because that is what the console reads.

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

const INBOX_ID = 71;
let tenantId = 0n;
let instanceId = 0n;
let agentDbId = 0n;
let deliverySeq = 0;
let messageSeq = 9000;
let stamp = Math.floor(Date.now() / 1000);

const realFetch = globalThis.fetch;

describe.skipIf(!dbUp)("the webhook gate leaves a trail", () => {
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
      data: { name: "GT", slug: `gt-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 21,
      baseUrl: "https://chat.gate.example",
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
        webhookRouteTokenHash: `gt-route-${process.pid}`,
        name: "Atendente",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_ID,
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

  function conversation(
    convId: number,
    held: {
      assigneeType?: string | null;
      status: string;
      // The two clocks a payload carries, overridable so a fixture can place this event BEHIND a
      // state the mirror already holds. Left alone they read "now", which is what every other case
      // here wants.
      lastActivityAt?: number;
      updatedAt?: number;
    },
  ) {
    stamp += 1;
    return {
      id: convId,
      inbox_id: INBOX_ID,
      status: held.status,
      contact_inbox: { id: 71_000 + convId },
      meta: {
        // Capitalised because that is what the wire carries: Chatwoot puts the Rails class name in
        // `meta.assignee_type` ("User" / "AgentBot"), confirmed on 4.17.0 (docs/chatwoot.md). A
        // lowercase fixture reads as "nobody holds it" and would prove the wrong branch.
        ...(held.assigneeType === "User"
          ? { assignee_type: "User", assignee: { id: 5, name: "Ana" } }
          : held.assigneeType === "AgentBot"
            ? { assignee_type: "AgentBot", assignee: { id: 77, name: "Outro" } }
            : { assignee: null }),
        sender: { id: 77, name: "Cliente" },
      },
      channel: "Channel::Api",
      last_activity_at: held.lastActivityAt ?? Math.floor(Date.now() / 1000),
      updated_at: held.updatedAt ?? stamp,
    };
  }

  async function deliver(
    convId: number,
    held: {
      assigneeType?: string | null;
      status: string;
      lastActivityAt?: number;
      updatedAt?: number;
    },
    over: { event?: string; message?: Record<string, unknown> } = {},
  ): Promise<void> {
    deliverySeq += 1;
    messageSeq += 1;
    const event = over.event ?? "message_created";
    const n = normalizeChatwootEvent({
      event,
      id: messageSeq,
      private: false,
      content: "oi, continua aí?",
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
      ...over.message,
      conversation: conversation(convId, held),
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `gt-${process.pid}-${deliverySeq}`,
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
  async function handoffRows(convId: number, waitMs = 2000) {
    const conv = await suDb.conversation.findFirst({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    if (!conv) return [];
    const deadline = Date.now() + waitMs;
    for (;;) {
      const rows = await flowLogRows(suDb, {
        where: { tenantId, stage: "handoff", conversationId: conv.id },
        orderBy: { id: "asc" },
      });
      if (rows.length > 0 || Date.now() > deadline) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  test("a human holding the conversation is reported as a takeover", async () => {
    await deliver(9101, { assigneeType: "User", status: "open" });
    const rows = await handoffRows(9101);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toEqual({ outcome: "taken_over" });
    expect(rows[0]?.agentId).toBe(agentDbId);
  });

  // The ack escalation as every message after it meets it: Chatwoot moved the conversation out of
  // `pending` with nobody on the other side, and no turn is ever armed, so this gate is the only one
  // these messages reach.
  test("an escalated conversation names the status that closed the gate", async () => {
    await deliver(9102, { status: "open" });
    const rows = await handoffRows(9102);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toEqual({
      outcome: "ownership_lost",
      status: "open",
    });
  });

  // The line has to name the reading the GATE decided on, and after #295 that is no longer the one
  // the payload proposed: a payload is a snapshot of an earlier instant and the mirror row is what
  // this event settled on, so the gate reads the mirror's status. `describeClosedGate` states the
  // same rule from its own side — the status rides along instead of being re-read, because a second
  // query would answer about a different moment — and a proposal is a different moment just as
  // surely. Reported from the payload, a conversation the operator had already resolved was recorded
  // as `ownership_lost` at `pending`, which sends an investigation after a missing assignee.
  test("the status reported is the one the gate closed on, not the one proposed", async () => {
    const T = Math.floor(Date.now() / 1000);
    // One delivery to put the conversation in the mirror, then the resolve written onto the row with
    // its mark ahead of the message. Written rather than delivered because this file's `deliver`
    // builds a MESSAGE payload, and a message may never write status by version — which is the very
    // asymmetry under test.
    await deliver(9107, {
      status: "pending",
      lastActivityAt: T - 120,
      updatedAt: T - 120,
    });
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: 9107 },
      data: { status: "resolved", chatwootStatusAt: T + 3600 },
    });
    // The stranded message, serialized a minute BEFORE that resolve. Behind the status mark on its
    // own clock, so the reopen exception refuses it and the mirror stays `resolved`.
    //
    // The spy is taken HERE, around the one delivery whose line this is about, and restored in a
    // `finally`. `logger` is a module singleton shared by every test in the process, so a spy left
    // standing is seen by the next file's own `spyOn` — measured on CI, where it made a neighbouring
    // suite read this file's line instead of its own. `mockRestore` also clears `mock.calls` in Bun,
    // so the lines are copied out first.
    const info = spyOn(logger, "info");
    let lines: unknown[][] = [];
    try {
      await deliver(9107, {
        status: "pending",
        lastActivityAt: T - 60,
        updatedAt: T - 60,
      });
      lines = info.mock.calls.map((c) => [...c]);
    } finally {
      info.mockRestore();
    }

    // The first delivery answered normally and wrote no handoff line, so the only row here belongs
    // to the message the gate refused.
    const rows = await handoffRows(9107);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toEqual({
      outcome: "ownership_lost",
      status: "resolved",
    });
    // The console line too, and not as a duplicate of the row above: the flow log is what an
    // operator opens AFTER they suspect something, and this line is what they are reading when they
    // do not yet. The two are written from separate arguments, so one can drift from the other —
    // and drifting is the whole defect this test exists for.
    expect(
      lines.find(
        (c) => typeof c[0] === "string" && c[0].includes("bot silent by gate"),
      ),
    ).toEqual([
      expect.stringContaining("bot silent by gate"),
      "9107",
      "message_created",
      true,
      "ownership_lost",
      "resolved",
    ]);
  });

  // The boundary, and it is the design decision: one line per customer message the bot did not
  // answer, never one per webhook event. A message_updated on the same closed gate is our own
  // write-back coming back around, and a row for it would bury the ones above.
  test("an event that is not a new incoming message writes no line", async () => {
    await deliver(
      9103,
      { assigneeType: "User", status: "open" },
      { event: "message_updated" },
    );
    expect(await handoffRows(9103, 300)).toEqual([]);
  });

  // A switched-off agent was never going to answer, so a gate line there would explain the silence
  // with the wrong reason.
  test("a disabled agent writes no line", async () => {
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { enabled: false },
    });
    try {
      await deliver(9104, { assigneeType: "User", status: "open" });
      expect(await handoffRows(9104, 300)).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { enabled: true },
      });
    }
  });
});
