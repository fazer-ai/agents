import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { getKpis } from "@/modules/analytics/service";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

// The attendance watermarks, asked where they are WRITTEN FROM — the real receiver
// (`processChatwootDelivery`), not `mirrorChatwootEvent` called by hand: the predicate that says
// "a human answered" lives on the event, and a fixture that built the mirror's input itself would
// pass with the receiver never delivering an outgoing message to it at all.
//
// The agent is `enabled: false` on purpose. It is the case the numbers exist for (an inbox the bot
// never touches still has a service level) and it is the case that proves the watermarks do not
// come from the agent pipeline: nothing here can run a turn, ask a model, or write LlmUsage.
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

const CHATWOOT_INBOX_ID = 5511;
const CONV_ID = 9811;
const AGENT_BOT_ID = 77;

let tenantId: bigint;
let instanceId: bigint;
let conversationDbId: bigint;
function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function convPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: CONV_ID,
    inbox_id: CHATWOOT_INBOX_ID,
    status: "open",
    contact_inbox: { id: 70_000 + CONV_ID },
    meta: {
      assignee_type: "User",
      assignee: { id: 31, name: "Ana (atendente)" },
      sender: { id: 21, name: "Cliente" },
    },
    channel: "Channel::Api",
    last_activity_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

async function deliver(
  raw: Record<string, unknown>,
  tag: string,
  on: { tenantId: bigint; instanceId: bigint } = { tenantId, instanceId },
) {
  const n = normalizeChatwootEvent(raw);
  if (!n) throw new Error(`fixture did not normalize: ${tag}`);
  const d = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId: on.tenantId,
      chatwootInstanceId: on.instanceId,
      deliveryId: `monitor-probe-${process.pid}-${tag}`,
      event: String(raw.event),
      status: "PENDING",
    },
    select: { id: true },
  });
  return processChatwootDelivery({
    tenantId: on.tenantId,
    instanceId: on.instanceId,
    deliveryRowId: d.id,
    agentBotId: AGENT_BOT_ID,
    normalized: n,
    base: appDb,
    deps: {
      makeClient: (async () =>
        ({
          sendMessage: async () => {
            throw new Error("a disabled agent must not speak");
          },
          sendPrivateNote: async () => ({}),
          toggleTyping: async () => ({}),
        }) as unknown as ChatwootClient) as never,
      makeModel: () => {
        throw new Error("a disabled agent must not ask a model");
      },
    },
  });
}

describe.skipIf(!dbUp)("the attendance watermarks", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Monitor", slug: `monitor-probe-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 5,
      baseUrl: "https://chat.monitor.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    // The monitoring premise: the platform is on, the AI is off.
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "x",
        enabled: false,
        mode: "production",
        settings: {},
      },
      select: { id: true },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "WhatsApp",
        agentId: agent.id,
      },
      select: { id: true },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "llm_usage",
        "chatwoot_webhook_deliveries",
        "conversations",
        "contacts",
        "inboxes",
        "agents",
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

  test("dates the customer's first message and the team's first and last answer", async () => {
    await deliver(
      {
        event: "message_created",
        id: 6001,
        content: "bom dia, vocês entregam em Salvador?",
        message_type: "incoming",
        private: false,
        conversation: convPayload(),
      },
      "inbound",
    );
    const afterInbound = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: CONV_ID },
    });
    conversationDbId = afterInbound.id;
    expect(afterInbound.firstInboundAt).not.toBeNull();
    expect(afterInbound.firstInboundAt?.getTime()).toBe(
      afterInbound.lastInboundAt?.getTime(),
    );
    // Nobody has answered yet, and the row must say so rather than default to the event's clock.
    expect(afterInbound.firstHumanReplyAt).toBeNull();
    expect(afterInbound.lastHumanReplyAt).toBeNull();

    // A private note is the operator talking to their own team. It is not an answer to the
    // customer, and dating one as the first response would flatter every service level in the
    // panel. Delivered BEFORE the real reply so a wrong predicate is caught by the value, not
    // only by a null check.
    await new Promise((r) => setTimeout(r, 1100));
    await deliver(
      {
        event: "message_created",
        id: 6002,
        content: "cliente antigo, cuidado com o desconto",
        message_type: "outgoing",
        private: true,
        sender: { id: 31, name: "Ana", type: "user" },
        conversation: convPayload(),
      },
      "private-note",
    );
    expect(
      (
        await suDb.conversation.findFirstOrThrow({
          where: { id: conversationDbId },
        })
      ).firstHumanReplyAt,
    ).toBeNull();

    await new Promise((r) => setTimeout(r, 1100));
    await deliver(
      {
        event: "message_created",
        id: 6003,
        content: "bom dia! entregamos sim, em 3 dias úteis",
        message_type: "outgoing",
        private: false,
        sender: { id: 31, name: "Ana", type: "user" },
        conversation: convPayload(),
      },
      "human-reply",
    );
    const afterReply = await suDb.conversation.findFirstOrThrow({
      where: { id: conversationDbId },
    });
    expect(afterReply.firstHumanReplyAt).not.toBeNull();
    expect(afterReply.lastHumanReplyAt?.getTime()).toBe(
      afterReply.firstHumanReplyAt?.getTime(),
    );
    // The customer's clock must not move on an outgoing message — the 24h window and the follow-up
    // episode gate both read it.
    expect(afterReply.lastInboundAt?.getTime()).toBe(
      afterInbound.lastInboundAt?.getTime(),
    );
    expect(afterReply.firstInboundAt?.getTime()).toBe(
      afterInbound.firstInboundAt?.getTime(),
    );
    const firstResponse =
      (afterReply.firstHumanReplyAt as Date).getTime() -
      (afterReply.firstInboundAt as Date).getTime();
    expect(firstResponse).toBeGreaterThan(0);

    // A second answer advances the last watermark and leaves the first alone: the first-response
    // time is a property of the attendance and does not change because the dialogue continued.
    await new Promise((r) => setTimeout(r, 1100));
    await deliver(
      {
        event: "message_created",
        id: 6004,
        content: "posso emitir o pedido?",
        message_type: "outgoing",
        private: false,
        sender: { id: 31, name: "Ana", type: "user" },
        conversation: convPayload(),
      },
      "second-reply",
    );
    const afterSecond = await suDb.conversation.findFirstOrThrow({
      where: { id: conversationDbId },
    });
    expect(afterSecond.firstHumanReplyAt?.getTime()).toBe(
      afterReply.firstHumanReplyAt?.getTime(),
    );
    expect(afterSecond.lastHumanReplyAt?.getTime()).toBeGreaterThan(
      afterReply.lastHumanReplyAt?.getTime() as number,
    );

    // And the KPI the columns exist for answers on an inbox with no LLM usage at all — the case
    // where every other number on the panel is zero by construction.
    const kpis = await getKpis(ctx(), {}, appDb);
    expect(kpis.involved).toBe(0);
    expect(kpis.firstResponseSampled).toBe(1);
    expect(kpis.firstResponseSeconds).toBeGreaterThan(0);
    expect(kpis.firstResponseSeconds).toBeCloseTo(firstResponse / 1000, 0);
  });

  // An operator editing what they already said is not a second answer. The predicate is
  // `isNewHumanAgentMessage`, message_created only — the same reason the inbound watermark refuses a
  // message_updated: our own attachment write-backs make the fork re-dispatch one for a message
  // already handled.
  test("an edit to a reply already sent does not re-date the answer", async () => {
    const before = await suDb.conversation.findFirstOrThrow({
      where: { id: conversationDbId },
    });
    await deliver(
      {
        event: "message_updated",
        id: 6004,
        content: "posso emitir o pedido? (corrigido)",
        message_type: "outgoing",
        private: false,
        sender: { id: 31, name: "Ana", type: "user" },
        conversation: convPayload({
          last_activity_at: Math.floor(Date.now() / 1000) + 30,
        }),
      },
      "reply-edited",
    );
    const after = await suDb.conversation.findFirstOrThrow({
      where: { id: conversationDbId },
    });
    expect(after.lastHumanReplyAt?.getTime()).toBe(
      before.lastHumanReplyAt?.getTime(),
    );
    expect(after.firstHumanReplyAt?.getTime()).toBe(
      before.firstHumanReplyAt?.getTime(),
    );
  });

  // The row the migration leaves behind: it existed, customer messages were mirrored onto it, and
  // there was nowhere to date the first one. Its next message is not its first, so it never gets an
  // anchor — the alternative is a mid-conversation interval entering the service level as if it
  // were a first response.
  test("a conversation older than the columns is never anchored", async () => {
    const legacyConvId = CONV_ID + 1;
    const legacy = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: legacyConvId,
        status: "open",
        threadId: `${tenantId}:${instanceId}:${legacyConvId}`,
        lastEventAt: new Date(Date.now() - 7 * 86_400_000),
        // Mirrored before the columns existed: the watermark of the LAST customer message, and
        // nothing saying when the first one was.
        lastInboundAt: new Date(Date.now() - 7 * 86_400_000),
      },
      select: { id: true },
    });
    await deliver(
      {
        event: "message_created",
        id: 6101,
        content: "e sobre o pedido de ontem?",
        message_type: "incoming",
        private: false,
        conversation: convPayload({
          id: legacyConvId,
          contact_inbox: { id: 70_000 + legacyConvId },
        }),
      },
      "legacy-inbound",
    );
    await deliver(
      {
        event: "message_created",
        id: 6102,
        content: "já está separado",
        message_type: "outgoing",
        private: false,
        sender: { id: 31, name: "Ana", type: "user" },
        conversation: convPayload({
          id: legacyConvId,
          contact_inbox: { id: 70_000 + legacyConvId },
          last_activity_at: Math.floor(Date.now() / 1000) + 5,
        }),
      },
      "legacy-reply",
    );
    const row = await suDb.conversation.findFirstOrThrow({
      where: { id: legacy.id },
    });
    expect(row.lastInboundAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(row.firstInboundAt).toBeNull();
    // The reply is still dated — there is no stored fact that would say it is not the first — and
    // the conversation stays out of the sample for want of the other end.
    expect(row.firstHumanReplyAt).not.toBeNull();
  });

  // Chatwoot retries out of order, and the state ordering refuses an event carrying an older clock
  // than what is stored. The message it mentions still happened, and for the anchor of an
  // attendance the earliest reading has to win even when it is the last to arrive.
  test("a first message that arrives after a newer event still anchors the attendance", async () => {
    const lateConvId = CONV_ID + 2;
    const conversationOpenedAt = Math.floor(Date.now() / 1000) - 600;
    // A conversation event got through first and moved the row's clock forward.
    await deliver(
      {
        event: "conversation_updated",
        ...convPayload({
          id: lateConvId,
          contact_inbox: { id: 70_000 + lateConvId },
          last_activity_at: conversationOpenedAt + 300,
        }),
      },
      "late-conv-event",
    );
    const beforeRow = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: lateConvId },
    });
    expect(beforeRow.firstInboundAt).toBeNull();

    // The customer's first message, delivered late, with the clock it actually had.
    await deliver(
      {
        event: "message_created",
        id: 6201,
        content: "bom dia",
        message_type: "incoming",
        private: false,
        conversation: convPayload({
          id: lateConvId,
          contact_inbox: { id: 70_000 + lateConvId },
          last_activity_at: conversationOpenedAt,
        }),
      },
      "late-first-inbound",
    );
    const afterRow = await suDb.conversation.findFirstOrThrow({
      where: { id: beforeRow.id },
    });
    expect(afterRow.firstInboundAt?.getTime()).toBe(
      conversationOpenedAt * 1000,
    );
    // The refused event still says nothing about the conversation's state.
    expect(afterRow.lastEventAt?.getTime()).toBe(
      (conversationOpenedAt + 300) * 1000,
    );
  });
});

// The aggregate, on its own tenant: a median is a property of a POPULATION, and asserting one over
// rows another test in this file also writes would make the number depend on execution order.
describe.skipIf(!dbUp)("the first-response KPI", () => {
  let aggTenantId: bigint;
  let aggInstanceId: bigint;

  function on() {
    return { tenantId: aggTenantId, instanceId: aggInstanceId };
  }

  async function attendance(
    convId: number,
    inboundAtSec: number,
    replyAtSec: number,
  ) {
    const conv = (over: Record<string, unknown>) => ({
      id: convId,
      inbox_id: CHATWOOT_INBOX_ID,
      status: "open",
      contact_inbox: { id: 80_000 + convId },
      meta: {
        assignee_type: "User",
        assignee: { id: 31, name: "Ana (atendente)" },
        sender: { id: 21, name: "Cliente" },
      },
      channel: "Channel::Api",
      ...over,
    });
    await deliver(
      {
        event: "message_created",
        id: convId * 10,
        content: "oi",
        message_type: "incoming",
        private: false,
        conversation: conv({ last_activity_at: inboundAtSec }),
      },
      `agg-${convId}-in`,
      on(),
    );
    await deliver(
      {
        event: "message_created",
        id: convId * 10 + 1,
        content: "oi, pois não",
        message_type: "outgoing",
        private: false,
        sender: { id: 31, name: "Ana", type: "user" },
        conversation: conv({ last_activity_at: replyAtSec }),
      },
      `agg-${convId}-out`,
      on(),
    );
  }

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Agg", slug: `agg-probe-${process.pid}` },
    });
    aggTenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId: aggTenantId,
      accountId: 6,
      baseUrl: "https://chat.agg.example",
      adminToken: encryptJson("ADMIN"),
    });
    aggInstanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId: aggTenantId,
        name: "Atendente",
        systemPrompt: "x",
        enabled: false,
        mode: "production",
        settings: {},
      },
      select: { id: true },
    });
    await suDb.inbox.create({
      data: {
        tenantId: aggTenantId,
        chatwootInstanceId: aggInstanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "WhatsApp",
        agentId: agent.id,
      },
      select: { id: true },
    });
  });

  afterAll(async () => {
    if (aggTenantId) {
      for (const table of [
        "execution_logs",
        "llm_usage",
        "chatwoot_webhook_deliveries",
        "conversations",
        "contacts",
        "inboxes",
        "agents",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${aggTenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${aggTenantId}`,
      );
    }
  });

  test("reports the median attendance, not the average one", async () => {
    const base = Math.floor(Date.now() / 1000) - 86_400;
    // 10s, 60s and one conversation opened at the end of a Friday: the mean of the three is 20
    // minutes and describes none of them, which is the whole argument for the median.
    await attendance(9901, base, base + 10);
    await attendance(9902, base, base + 60);
    await attendance(9903, base, base + 3_600);

    // And an attendance whose team reply is dated BEFORE the message it answers — a clock the
    // integration cannot vouch for. It is refused rather than contributed as a negative wait.
    const skewed = 9904;
    await deliver(
      {
        event: "message_created",
        id: skewed * 10,
        content: "acompanhando",
        message_type: "outgoing",
        private: false,
        sender: { id: 31, name: "Ana", type: "user" },
        conversation: {
          id: skewed,
          inbox_id: CHATWOOT_INBOX_ID,
          status: "open",
          contact_inbox: { id: 80_000 + skewed },
          meta: {
            assignee_type: "User",
            assignee: { id: 31, name: "Ana" },
            sender: { id: 21, name: "Cliente" },
          },
          channel: "Channel::Api",
          last_activity_at: base,
        },
      },
      `agg-${skewed}-out`,
      on(),
    );
    await deliver(
      {
        event: "message_created",
        id: skewed * 10 + 1,
        content: "oi?",
        message_type: "incoming",
        private: false,
        conversation: {
          id: skewed,
          inbox_id: CHATWOOT_INBOX_ID,
          status: "open",
          contact_inbox: { id: 80_000 + skewed },
          meta: {
            assignee_type: "User",
            assignee: { id: 31, name: "Ana" },
            sender: { id: 21, name: "Cliente" },
          },
          channel: "Channel::Api",
          last_activity_at: base + 30,
        },
      },
      `agg-${skewed}-in`,
      on(),
    );

    const kpis = await getKpis(
      { tenantId: aggTenantId, userId: null, role: "TENANT_ADMIN" },
      {},
      appDb,
    );
    expect(kpis.firstResponseSampled).toBe(3);
    expect(kpis.firstResponseSeconds).toBe(60);
  });
});
