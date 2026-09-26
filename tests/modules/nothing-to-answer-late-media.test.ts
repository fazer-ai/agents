import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// THE NOTHING-TO-ANSWER CLOSE, UNDONE BY A LATE ATTACHMENT (issue #895 review, round 7). Some
// transports create the message empty and attach the audio on `message_updated`; on the direct path
// the close can run before that update lands, and a late attachment never arms a turn. Driven through
// the real receiver, so the call site is what is measured. Offline: the agent's STT has no credential,
// so eager media skips before any download, and a late-media update never reaches the model.
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

const INBOX = 4511;
const BOT = 78;

let tenantId: bigint;
let instanceId: bigint;
let agentId: bigint;
let inboxDbId: bigint;

async function seedConversation(
  convId: number,
  resolvedBy: string | null,
): Promise<bigint> {
  const row = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbId,
      chatwootConversationId: convId,
      status: "resolved",
      resolvedBy,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(Date.now() - 60_000),
    },
    select: { id: true },
  });
  return row.id;
}

function client(live: { status: string; toggleFails?: boolean }) {
  const toggles: Array<{ status: string; asAdmin: boolean }> = [];
  const c = {
    getConversation: async (id: number) => ({
      id,
      status: live.status,
      updated_at: 1_700_000_000.5,
      inbox_id: INBOX,
      meta: { assignee_type: "AgentBot", assignee: { id: BOT, name: "x" } },
    }),
    toggleStatus: async (
      _id: number,
      status: string,
      opts: { asAdmin?: boolean } = {},
    ) => {
      if (live.toggleFails) throw new Error("chatwoot 500");
      toggles.push({ status, asAdmin: opts.asAdmin === true });
      return {};
    },
    downloadAttachment: async () => {
      throw new Error("the audio must not be downloaded: no credential");
    },
    sendMessage: async () => ({}),
    sendPrivateNote: async () => ({}),
  } as unknown as ChatwootClient;
  return { toggles, makeClient: async () => c };
}

async function deliverLateAudio(
  convId: number,
  cw: ReturnType<typeof client>,
  opts: { transcribed?: string; makeClient?: () => Promise<unknown> } = {},
): Promise<void> {
  const n = normalizeChatwootEvent({
    event: "message_updated",
    id: 7000 + convId,
    content: "",
    message_type: "incoming",
    private: false,
    attachments: [
      {
        id: 90 + convId,
        file_type: "audio",
        data_url: `https://chat.late.example/audio/${convId}.ogg`,
        ...(opts.transcribed ? { transcribed_text: opts.transcribed } : {}),
      },
    ],
    conversation: {
      id: convId,
      inbox_id: INBOX,
      status: "resolved",
      contact_inbox: { id: 70_000 + convId },
      meta: {
        assignee_type: "AgentBot",
        assignee: { id: BOT, name: "x" },
        sender: { id: 31, name: "Cliente" },
      },
      channel: "Channel::Api",
      last_activity_at: Math.floor(Date.now() / 1000),
    },
  });
  if (!n) throw new Error("unreachable: the fixture is a valid event");
  const delivery = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `late-media-${process.pid}-${convId}`,
      event: "message_updated",
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: delivery.id,
    agentBotId: BOT,
    normalized: n,
    base: appDb,
    deps: {
      makeClient: (opts.makeClient ?? cw.makeClient) as never,
      makeModel: () => {
        throw new Error("a late-media update must not run a turn");
      },
    },
  });
}

// The emit is fire-and-forget: poll for the line.
async function reopenLines(conversationId: bigint) {
  for (let i = 0; i < 100; i++) {
    const rows = await flowLogRows(suDb, {
      where: { tenantId, conversationId, stage: "route" },
      select: { level: true, detail: true },
    });
    const mine = rows.filter(
      (r) => (r.detail as { reason?: string } | null)?.reason === "lateMedia",
    );
    if (mine.length > 0) return mine;
    await new Promise((r) => setTimeout(r, 20));
  }
  return [];
}

describe.skipIf(!dbUp)(
  "a late attachment on a conversation closed for having nothing to answer",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "Late", slug: `late-media-895-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 5,
        baseUrl: "https://chat.late.example",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "x",
          enabled: true,
          mode: "production",
          settings: { stt: { enabled: true, provider: "openai" } },
        },
        select: { id: true },
      });
      agentId = agent.id;
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: INBOX,
          name: "WhatsApp",
          agentId,
        },
        select: { id: true },
      });
      inboxDbId = inbox.id;
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of [
          "execution_logs",
          "scheduler_jobs",
          "chatwoot_webhook_deliveries",
          "conversations",
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

    test("puts it back to pending, as admin, and says so", async () => {
      const conv = await seedConversation(9801, "nothing_to_answer");
      const cw = client({ status: "resolved" });
      await deliverLateAudio(9801, cw);
      expect(cw.toggles).toEqual([{ status: "pending", asAdmin: true }]);
      const lines = await reopenLines(conv);
      expect(lines.map((l) => [l.level, l.detail])).toEqual([
        ["info", { outcome: "reopened", reason: "lateMedia" }],
      ]);
    });

    test("leaves a close of another kind alone", async () => {
      await seedConversation(9802, "agent");
      const cw = client({ status: "resolved" });
      await deliverLateAudio(9802, cw);
      expect(cw.toggles).toEqual([]);
    });

    test("leaves it alone once a person already reopened it", async () => {
      await seedConversation(9803, "nothing_to_answer");
      const cw = client({ status: "open" });
      await deliverLateAudio(9803, cw);
      expect(cw.toggles).toEqual([]);
    });

    test("an audio that arrives already transcribed reopens it too", async () => {
      const conv = await seedConversation(9805, "nothing_to_answer");
      const cw = client({ status: "resolved" });
      await deliverLateAudio(9805, cw, {
        transcribed: "quero cancelar meu pedido",
      });
      expect(cw.toggles).toEqual([{ status: "pending", asAdmin: true }]);
      expect((await reopenLines(conv)).map((l) => l.level)).toEqual(["info"]);
    });

    test("a client that cannot be built is the recovery's warn, not the delivery's failure", async () => {
      const conv = await seedConversation(9806, "nothing_to_answer");
      const cw = client({ status: "resolved" });
      await deliverLateAudio(9806, cw, {
        makeClient: async () => {
          throw new Error("instance unreadable");
        },
      });
      expect((await reopenLines(conv)).map((l) => l.level)).toEqual(["warn"]);
    });

    test("a responder switched off or flipped to monitoring since the close gets nothing back", async () => {
      for (const [convId, data] of [
        [9807, { enabled: false }],
        [9808, { mode: "monitoring" }],
      ] as const) {
        await seedConversation(convId, "nothing_to_answer");
        await suDb.agent.update({ where: { id: agentId }, data });
        try {
          const cw = client({ status: "resolved" });
          await deliverLateAudio(convId, cw);
          expect(cw.toggles).toEqual([]);
        } finally {
          await suDb.agent.update({
            where: { id: agentId },
            data: { enabled: true, mode: "production" },
          });
        }
      }
    });

    test("a reopen that fails is a warn, so the buried voice note pages", async () => {
      const conv = await seedConversation(9804, "nothing_to_answer");
      const cw = client({ status: "resolved", toggleFails: true });
      await deliverLateAudio(9804, cw);
      const lines = await reopenLines(conv);
      expect(lines.map((l) => l.level)).toEqual(["warn"]);
    });
  },
);
