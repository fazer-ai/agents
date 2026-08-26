import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId } from "@/graph/checkpointer";
import { followUpDedupeKey } from "@/modules/channel-redirect/followup";
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
const THIRD_ORIGIN = 6203;

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

async function deliver(
  payload: Record<string, unknown>,
  event: string,
  db?: PrismaClient,
) {
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
    base: db ?? appDb,
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

    // Review round 5 of #355. Clearing the row's watermarks frees the NEXT episode's one-shots and
    // does nothing about the work already armed for the previous one. The REDIRECT_FOLLOWUP ladder
    // messages the paired WhatsApp thread and RESOLVES it, and a worker that already read its sibling
    // passes every fence it has left — so the episode change has to retire it, which is the one
    // signal that reaches a run already claimed.
    // `origin` omitted ⇒ a payload with no episode on it, which is every ladder armed before this
    // field existed and every one armed from a Chatwoot that does not speak about pairings.
    async function armLadder(origin?: number | null) {
      const key = followUpDedupeKey(
        chatwootThreadId(tenantId, instanceId, WIDGET_CONV),
      );
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, kind: "REDIRECT_FOLLOWUP", dedupeKey: key },
      });
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "REDIRECT_FOLLOWUP",
          dedupeKey: key,
          payload: {
            stage: "whatsapp",
            ...(origin !== undefined ? { originDisplayId: origin } : {}),
          },
          status: "PENDING",
          runAt: new Date(Date.now() + 600_000),
        },
      });
      return key;
    }

    async function ladderState(key: string) {
      const row = await suDb.schedulerJob.findFirstOrThrow({
        where: { tenantId, kind: "REDIRECT_FOLLOWUP", dedupeKey: key },
        select: { status: true, payload: true },
      });
      return {
        status: row.status,
        cancelled:
          (row.payload as { cancelledAt?: unknown } | null)?.cancelledAt !=
          null,
      };
    }

    test("a pairing that moves retires the previous episode's ladder", async () => {
      const key = await armLadder();
      await deliver(widgetConversation(THIRD_ORIGIN), "conversation_updated");
      expect((await widgetRow()).redirectOriginDisplayId).toBe(THIRD_ORIGIN);
      expect(await ladderState(key)).toEqual({
        status: "DONE",
        cancelled: true,
      });
    });

    // And the other side of it: a retried delivery of the SAME pairing describes the episode that is
    // running, so the ladder it armed is the one that should still run.
    test("a repeat of the same pairing leaves the ladder armed", async () => {
      const key = await armLadder();
      await deliver(widgetConversation(THIRD_ORIGIN), "conversation_updated");
      expect(await ladderState(key)).toEqual({
        status: "PENDING",
        cancelled: false,
      });
    });

    // Rounds 9 and 10 of #355, and they settle two halves of one question.
    //
    // The savepoint is round 9: the retirement runs inside the mirror's transaction, and a statement
    // Postgres REJECTS there aborts the whole transaction at the server. Every statement after it
    // fails with `current transaction is aborted`, whatever JavaScript did with the rejection, so a
    // plain catch read as a degradation and delivered a rollback. Reproduced with a genuinely failing
    // statement rather than a thrown Error, because a thrown Error does not abort a Postgres
    // transaction and would prove nothing.
    //
    // What round 10 adds is WHAT survives that rollback. Committing the new pairing over a ladder
    // that could not be retired is the one combination that must not happen: the ladder carries no
    // episode of its own, so it would re-read the pairing and run the PREVIOUS episode's schedule
    // against the NEW one — a nudge and a resolve on a conversation that just started. So the pairing
    // stands still with it. Nothing is lost by that: every later payload for this conversation
    // restates the pairing, and the mark it is ordered by has not moved either, so the next delivery
    // applies both together.
    test("a scheduler statement Postgres rejects holds the pairing back", async () => {
      const FOURTH = 6204;
      const breaking = appDb.$extends({
        query: {
          async $executeRaw({ args, query }) {
            const sql = Array.isArray(args)
              ? String((args as unknown[])[0])
              : String(
                  (args as { strings?: string[] }).strings?.join("") ?? "",
                );
            if (sql.includes("scheduler_jobs")) {
              // A real error on this connection, which is what aborts the transaction.
              return query(["SELECT 1 / 0"] as never);
            }
            return query(args);
          },
        },
      }) as unknown as PrismaClient;

      const key = await armLadder();
      const stamped = new Date();
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        data: { redirectLinkedAt: stamped, redirectClosedAt: stamped },
      });
      const before = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        select: {
          redirectOriginDisplayId: true,
          chatwootRedirectOriginAt: true,
        },
      });
      await deliver(
        widgetConversation(FOURTH),
        "conversation_updated",
        breaking,
      );

      // Nothing about the episode moved: not the pairing, not the mark it is ordered by, not the
      // one-shots. The mark matters as much as the value — advanced on its own it would describe a
      // pairing the row never took, and refuse the payload that comes to deliver it. And releasing
      // the watermarks here would re-run the cross-link on an episode that is still the current one.
      const after = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        select: {
          redirectOriginDisplayId: true,
          chatwootRedirectOriginAt: true,
          redirectLinkedAt: true,
          redirectClosedAt: true,
        },
      });
      expect(after.redirectOriginDisplayId).toBe(
        before.redirectOriginDisplayId,
      );
      expect(after.chatwootRedirectOriginAt).toBe(
        before.chatwootRedirectOriginAt,
      );
      expect(after.redirectLinkedAt).not.toBeNull();
      expect(after.redirectClosedAt).not.toBeNull();
      expect(await ladderState(key)).toEqual({
        status: "PENDING",
        cancelled: false,
      });

      // And the next ordinary delivery applies both. The event never had to come back from
      // Chatwoot for this: every payload for the conversation restates the pairing.
      await deliver(widgetConversation(FOURTH), "conversation_updated");
      const applied = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        select: {
          redirectOriginDisplayId: true,
          redirectLinkedAt: true,
          redirectClosedAt: true,
        },
      });
      expect(applied.redirectOriginDisplayId).toBe(FOURTH);
      expect(applied.redirectLinkedAt).toBeNull();
      expect(applied.redirectClosedAt).toBeNull();
      expect(await ladderState(key)).toEqual({
        status: "DONE",
        cancelled: true,
      });
    });

    // Review round 12 of #355. The dedupe key names the CONVERSATION, and until now the retirement
    // took every job under it — so a retirement running AFTER the new episode's ladder was armed
    // killed the ladder it exists to protect. That ordering is reachable, and by the failure path
    // right above: a delivery whose retirement was rejected holds the pairing back and then goes on
    // to arm anyway, because the arm keys off the widget INBOX and never reads the pairing. The next
    // payload restates the pairing, retires successfully, and takes the new episode's ladder with
    // it. Nothing re-arms it either: `redirectLinkedAt` is cleared by the release, but the cross-link
    // that reads it only runs on an INBOUND event, and the lead that was just redirected has stopped
    // talking — which is the silence the ladder was armed to chase.
    //
    // So the job carries the episode it was armed for, and a retirement keeps its own. A payload
    // with no episode on it is the previous episode's by construction: it predates the field.
    test("a ladder armed for the episode being written survives the retirement", async () => {
      const FIFTH = 6205;
      const key = await armLadder(FIFTH);
      await deliver(widgetConversation(FIFTH), "conversation_updated");
      expect((await widgetRow()).redirectOriginDisplayId).toBe(FIFTH);
      expect(await ladderState(key)).toEqual({
        status: "PENDING",
        cancelled: false,
      });
    });

    // And the whole chain, in the order it actually happens: the retirement is rejected, the delivery
    // arms the new episode's ladder anyway, and the payload that finally applies the pairing must
    // leave that ladder standing.
    test("a retirement that was rejected does not cost the new episode its ladder", async () => {
      const SIXTH = 6206;
      const breaking = appDb.$extends({
        query: {
          async $executeRaw({ args, query }) {
            const sql = Array.isArray(args)
              ? String((args as unknown[])[0])
              : String(
                  (args as { strings?: string[] }).strings?.join("") ?? "",
                );
            if (sql.includes("scheduler_jobs")) {
              return query(["SELECT 1 / 0"] as never);
            }
            return query(args);
          },
        },
      }) as unknown as PrismaClient;

      await armLadder(null);
      await deliver(
        widgetConversation(SIXTH),
        "conversation_updated",
        breaking,
      );
      // Held back, so the row still names the previous episode.
      expect((await widgetRow()).redirectOriginDisplayId).not.toBe(SIXTH);
      // What the same delivery arms next, from the cloned message: the NEW episode's ladder.
      const key = await armLadder(SIXTH);

      await deliver(widgetConversation(SIXTH), "conversation_updated");
      expect((await widgetRow()).redirectOriginDisplayId).toBe(SIXTH);
      expect(await ladderState(key)).toEqual({
        status: "PENDING",
        cancelled: false,
      });
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
