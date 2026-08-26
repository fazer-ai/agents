import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

// Round 3 of fazer-ai/chatwoot#418's review asked whether the standalone `conversation_updated` the
// fork now emits for a new pairing can make a consumer act EARLY: on the message-bearing path it is
// dispatched before `message_created`, measured on a live instance.
//
//   origin changes, cloned message  ->  1. conversation_updated (new origin)
//                                       2. message_created      (new origin)
//
// It cannot, and this is where that is pinned. Everything the episode does — the cross-link, the
// ladder's re-arm, the turn itself — is gated on a brand-new INCOMING customer message, and the
// update is not one. What the update does is state a value, which is the whole reason it exists:
// on the message-LESS path it is the only witness there is.
//
// Asserted on the EFFECT rather than on one gate, because there are two and both are older than this
// change: the call site of `maybeConsumeCommandOrGate` is itself `(act || commandActive) &&
// isNewIncoming`, so deleting the `isNewIncomingMessage(n)` inside the cross-link block leaves these
// tests green. Two fences on something that messages and resolves a customer's conversation is a
// choice, not an accident, and the effect is what has to hold whichever one is load-bearing.

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

const WIDGET_INBOX = 61;
const ENTRY_INBOX = 62;
const WIDGET_CONV = 6100;
const OLD_ORIGIN = 6201;
const NEW_ORIGIN = 6202;

let tenantId = 0n;
let instanceId = 0n;
let deliverySeq = 0;
let stamp = Math.floor(Date.now() / 1000);
const realFetch = globalThis.fetch;

function widgetConversation(origin: number) {
  stamp += 1;
  return {
    id: WIDGET_CONV,
    inbox_id: WIDGET_INBOX,
    status: "pending",
    contact_inbox: { id: 61_000 + WIDGET_CONV },
    meta: {
      assignee_type: "AgentBot",
      assignee: { id: 9, name: "Atendente" },
      sender: { id: 61, name: "Lead" },
    },
    channel: "Channel::WebWidget",
    // Frozen, exactly as the fork sends it: recording the pairing is a column write and Chatwoot's
    // `last_activity_at` does not move on one.
    last_activity_at: Math.floor(Date.now() / 1000) - 4366,
    updated_at: stamp,
    redirect_origin_display_id: origin,
  };
}

async function deliver(payload: Record<string, unknown>, event: string) {
  deliverySeq += 1;
  const n = normalizeChatwootEvent({ event, ...payload });
  if (!n) throw new Error("payload did not normalize");
  const delivery = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `ru-${process.pid}-${deliverySeq}`,
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

async function widgetRow() {
  return suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: WIDGET_CONV },
    select: { redirectOriginDisplayId: true, redirectLinkedAt: true },
  });
}

describe.skipIf(!dbUp)(
  "the pairing's own event states a value, it does not trigger the episode",
  () => {
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
        data: { name: "RU", slug: `redirect-update-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 31,
        baseUrl: "https://chat.ru.example",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "Você é prestativa.",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          settings: {
            // Debounce ON so the inbound message ARMS a turn instead of running one: the cross-link
            // runs before the debounce gate, and a live turn here would reach a model provider.
            debounce: { enabled: true },
            channelRedirect: {
              enabled: true,
              entryInboxId: ENTRY_INBOX,
              widgetInboxId: WIDGET_INBOX,
            },
          },
        },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: 9,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `ru-route-${process.pid}`,
          name: "Atendente",
        },
      });
      for (const chatwootInboxId of [WIDGET_INBOX, ENTRY_INBOX]) {
        await suDb.inbox.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootInboxId,
            name: `inbox-${chatwootInboxId}`,
            agentId: agent.id,
          },
        });
      }
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
          .$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => {});
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
      await su?.$disconnect();
      await app?.$disconnect();
    });

    test("a conversation_updated mirrors the new pairing and links nothing", async () => {
      await deliver(widgetConversation(OLD_ORIGIN), "conversation_updated");
      expect(await widgetRow()).toEqual({
        redirectOriginDisplayId: OLD_ORIGIN,
        redirectLinkedAt: null,
      });

      // The event the review was about: it carries the NEW origin and precedes the cloned message.
      await deliver(widgetConversation(NEW_ORIGIN), "conversation_updated");
      const afterUpdate = await widgetRow();
      // The value is stated...
      expect(afterUpdate.redirectOriginDisplayId).toBe(NEW_ORIGIN);
      // ...and the episode is untouched: no cross-link ran, so nothing acted on either origin.
      expect(afterUpdate.redirectLinkedAt).toBeNull();
    });

    test("the cloned message that follows is what links the episode", async () => {
      await deliver(
        {
          id: 77_001,
          private: false,
          content: "oi, vim do WhatsApp",
          message_type: "incoming",
          sender: { id: 61, name: "Lead", type: null },
          conversation: widgetConversation(NEW_ORIGIN),
        },
        "message_created",
      );
      const row = await widgetRow();
      expect(row.redirectOriginDisplayId).toBe(NEW_ORIGIN);
      expect(row.redirectLinkedAt).not.toBeNull();
    });
  },
);
