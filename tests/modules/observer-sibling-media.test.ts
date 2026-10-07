import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// Several watchers of one inbox append the same message to the one contact-inbox thread, and the
// first append wins. So every watcher's route renders media with the same config: the first config
// able to run among the inbox's switched-on watchers, in agent order, else the route's own.
// Otherwise the voice note is remembered as a marker or as words depending on whose delivery ran
// first. Offline the same way as eager-media-flow-context.test.ts: the service writes its `stt` line
// on a missing or unresolvable key, before any client or provider, and that line is the witness that
// a config resolved on this route.
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

const CHATWOOT_INBOX_ID = 4431;
const DEAF_BOT = 431;
const LISTENER_BOT = 432;
const UNKEYED_BOT = 433;

let tenantId: bigint;
let instanceId: bigint;
let inboxDbId: bigint;
let deafId: bigint;
let listenerId: bigint;
let unkeyedId: bigint;
let seq = 0;

async function watcher(
  name: string,
  bot: number,
  settings: Record<string, unknown>,
): Promise<bigint> {
  const agent = await suDb.agent.create({
    data: {
      tenantId,
      name,
      systemPrompt: "x",
      enabled: true,
      mode: "monitoring",
      settings: settings as never,
    },
    select: { id: true },
  });
  await suDb.chatwootAgentBot.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      agentId: agent.id,
      chatwootAgentBotId: bot,
      accessToken: encryptJson("BOT"),
      webhookSecret: encryptJson("S"),
      webhookRouteTokenHash: `osm-route-${bot}-${process.pid}`,
      name,
    },
  });
  return agent.id;
}

// A voice note on the deaf watcher's route, and how many `stt` lines its conversation got.
async function voiceNoteOnDeafRoute(convId: number): Promise<number> {
  seq += 1;
  const n = normalizeChatwootEvent({
    event: "message_created",
    id: 7000 + seq,
    content: "",
    message_type: "incoming",
    private: false,
    sender: { id: 31, name: "Cliente", type: null },
    attachments: [
      {
        id: 900 + seq,
        file_type: "audio",
        data_url: `https://chat.sibling.example/audio/${seq}.ogg`,
      },
    ],
    conversation: {
      id: convId,
      inbox_id: CHATWOOT_INBOX_ID,
      status: "pending",
      contact_inbox: { id: 70_000 + convId },
      meta: {
        assignee_type: null,
        assignee: null,
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
      deliveryId: `osm-${process.pid}-${seq}`,
      event: "message_created",
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: delivery.id,
    agentBotId: DEAF_BOT,
    normalized: n,
    base: appDb,
    deps: {
      makeClient: (async () =>
        ({
          downloadAttachment: async () => {
            throw new Error("the audio must not be downloaded: no credential");
          },
          sendMessage: async () => ({}),
          sendPrivateNote: async () => ({}),
        }) as unknown as ChatwootClient) as never,
      makeModel: () => {
        throw new Error("an observer's route runs no turn");
      },
    },
  });
  const rows = await flowLogRows(suDb, {
    where: {
      tenantId,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      stage: "stt",
    },
    select: { agentId: true },
  });
  for (const r of rows) expect(r.agentId).toBe(deafId);
  return rows.length;
}

describe.skipIf(!dbUp)(
  "the media pass on a watcher's route beside other watchers",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: {
          name: "Sibling media",
          slug: `observer-sibling-media-${process.pid}`,
        },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 4,
        baseUrl: "https://chat.sibling.example",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: CHATWOOT_INBOX_ID,
          name: "E-mail",
        },
        select: { id: true },
      });
      inboxDbId = inbox.id;
      deafId = await watcher("Sem transcrição", DEAF_BOT, {
        stt: { enabled: false },
      });
      listenerId = await watcher("Com transcrição", LISTENER_BOT, {
        // A key that names no vault entry: the service writes its line on the failed resolution,
        // before any client or provider, so the run stays offline.
        stt: {
          enabled: true,
          provider: "openai",
          credentialRef: "vault:999999999",
        },
      });
      unkeyedId = await watcher("Sem chave", UNKEYED_BOT, {
        stt: { enabled: true, provider: "openai" },
      });
      await suDb.inboxObserver.create({
        data: {
          tenantId,
          inboxId: inboxDbId,
          agentId: deafId,
          attachedAt: new Date(),
        },
      });
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of [
          "execution_logs",
          "scheduler_jobs",
          "chatwoot_webhook_deliveries",
          "conversations",
          "inbox_observers",
          "inboxes",
          "chatwoot_agent_bots",
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

    test("alone, a watcher with STT off leaves the voice note untranscribed", async () => {
      expect(await voiceNoteOnDeafRoute(9431)).toBe(0);
    });

    test("beside a sibling with STT on, it reads the sibling's settings, so both routes remember the same words", async () => {
      await suDb.inboxObserver.create({
        data: {
          tenantId,
          inboxId: inboxDbId,
          agentId: listenerId,
          attachedAt: new Date(),
        },
      });
      try {
        expect(await voiceNoteOnDeafRoute(9432)).toBe(1);
      } finally {
        await suDb.inboxObserver.deleteMany({
          where: { tenantId, inboxId: inboxDbId, agentId: listenerId },
        });
      }
    });

    test("a sibling switched on without a key does not take the config: it could not run", async () => {
      await suDb.inboxObserver.create({
        data: {
          tenantId,
          inboxId: inboxDbId,
          agentId: unkeyedId,
          attachedAt: new Date(),
        },
      });
      try {
        expect(await voiceNoteOnDeafRoute(9434)).toBe(0);
      } finally {
        await suDb.inboxObserver.deleteMany({
          where: { tenantId, inboxId: inboxDbId, agentId: unkeyedId },
        });
      }
    });

    test("a sibling whose attach Chatwoot has not confirmed does not count", async () => {
      await suDb.inboxObserver.create({
        // Explicit: the column defaults to now(), the stamp a settled row carries.
        data: {
          tenantId,
          inboxId: inboxDbId,
          agentId: listenerId,
          attachedAt: null,
        },
      });
      try {
        expect(await voiceNoteOnDeafRoute(9433)).toBe(0);
      } finally {
        await suDb.inboxObserver.deleteMany({
          where: { tenantId, inboxId: inboxDbId, agentId: listenerId },
        });
      }
    });
  },
);
