import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId, getCheckpointer } from "@/graph/checkpointer";
import { isHumanAgentTurn } from "@/graph/markers";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { renderTranscript } from "@/modules/memory/summarize";
import { claimDueTrafficJobs } from "@/modules/scheduler/service";
import { runClaimed } from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";

// The shape this suite exists for is the most common one in a real deployment: the agent qualifies a
// lead, a human takes the conversation over, and the human closes the sale. Every test here drives
// the REAL receiver (processChatwootDelivery), because the defect was never in the ingestion unit —
// it was that no delivery path reached it with an outgoing message, and a unit test cannot see that.
//
// What it asserts is the OBSERVABLE effect from issue #187: the transcript that compaction hands to
// the summarizer, and from there to the contact's permanent memory. Asserting "the message is in the
// thread" would pass on a message stored as the CUSTOMER's, which is the outcome the issue calls
// worse than the omission it replaces.

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

const INBOX_ID = 63;
const CONTACT_INBOX_BASE = 63_000;
let tenantId = 0n;
let instanceId = 0n;
let deliverySeq = 0;
let messageSeq = 5000;
let stamp = Math.floor(Date.now() / 1000);

const realFetch = globalThis.fetch;

describe.skipIf(!dbUp)(
  "a human agent's reply reaches the contact's memory",
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
        data: { name: "HAI", slug: `hai-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 14,
        baseUrl: "https://chat.example.com",
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
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: 9,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `hai-route-${process.pid}`,
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
        "scheduler_jobs",
        "chatwoot_webhook_deliveries",
        "agent_threads",
        "conversations",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "chatwoot_instances",
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
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    // A conversation a HUMAN owns: `shouldBotHandle` is false, so the bot stays silent and every
    // message on it is continuous-ingestion territory. No model ever runs in this suite.
    function conversation(convId: number) {
      stamp += 1;
      return {
        id: convId,
        inbox_id: INBOX_ID,
        status: "open",
        contact_inbox: { id: CONTACT_INBOX_BASE + convId },
        meta: {
          assignee_type: "user",
          assignee: { id: 5, name: "Ana" },
          sender: { id: 77, name: "Cliente" },
        },
        channel: "Channel::Api",
        last_activity_at: Math.floor(Date.now() / 1000),
        updated_at: stamp,
      };
    }

    // INGEST_MESSAGE rides the shared lane, in the TRAFFIC-PROPORTIONAL half of it: the tick claims
    // that half separately and with a cap, so one kind whose row count follows inbound traffic cannot
    // fill the batch and starve an appointment reminder (src/modules/scheduler/lanes.ts). Looped
    // because one delivery can queue more than a claim's worth over a burst.
    async function drainIngest(): Promise<void> {
      for (let pass = 0; pass < 10; pass++) {
        const claimed = await claimDueTrafficJobs(
          50,
          appDb,
          new Date(),
          tenantId,
        );
        if (claimed.length === 0) return;
        for (const job of claimed) await runClaimed(job, appDb);
      }
    }

    async function deliver(
      convId: number,
      message: Record<string, unknown>,
    ): Promise<void> {
      deliverySeq += 1;
      messageSeq += 1;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageSeq,
        private: false,
        ...message,
        conversation: conversation(convId),
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `hai-${process.pid}-${deliverySeq}`,
          event: "message_created",
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
      // The receiver QUEUES the append now instead of making it (issue #194), so the assertions
      // below run after the same job the fast tick would drain. Draining it here is what keeps this
      // an end-to-end test of the real path rather than of the enqueue.
      await drainIngest();
    }

    const fromCustomer = (content: string) => ({
      content,
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
    });
    const fromHumanAgent = (content: string) => ({
      content,
      message_type: "outgoing",
      sender: { id: 5, name: "Ana", type: "user" },
    });
    const reactionFromHumanAgent = (emoji: string) => ({
      content: emoji,
      message_type: "outgoing",
      sender: { id: 5, name: "Ana", type: "user" },
      content_attributes: { is_reaction: true },
    });
    const fromOurBot = (content: string) => ({
      content,
      message_type: "outgoing",
      sender: { id: 9, name: "Atendente", type: "agent_bot" },
    });

    async function threadMessages(convId: number): Promise<BaseMessage[]> {
      const cp = await getCheckpointer();
      const state = await cp.get({
        configurable: {
          thread_id: contactInboxThreadId(
            tenantId,
            instanceId,
            CONTACT_INBOX_BASE + convId,
          ),
        },
      });
      return ((state?.channel_values as { messages?: BaseMessage[] })
        ?.messages ?? []) as BaseMessage[];
    }

    test("the transcript of a handed-off attendance carries BOTH voices", async () => {
      const convId = 501;
      await deliver(
        convId,
        fromCustomer("bom dia, quanto fica o plano anual?"),
      );
      await deliver(
        convId,
        fromHumanAgent("Bom dia! Consigo fechar o anual por R$ 1.200."),
      );
      await deliver(convId, fromCustomer("fechado, pode emitir"));

      const transcript = renderTranscript(await threadMessages(convId));
      // The half that already worked.
      expect(transcript).toContain(
        "cliente: bom dia, quanto fica o plano anual?",
      );
      expect(transcript).toContain("cliente: fechado, pode emitir");
      // The half issue #187 is about: without it the memory records a customer who asked a price,
      // never got one, and then agreed to it.
      expect(transcript).toContain(
        "atendente: Bom dia! Consigo fechar o anual por R$ 1.200.",
      );
    });

    // The failure mode the issue calls WORSE than the omission: the operator's words stored as the
    // contact's. A test that only counted messages would pass on exactly that.
    test("the attendant's words are never attributed to the customer", async () => {
      const convId = 502;
      await deliver(convId, fromCustomer("oi"));
      await deliver(convId, fromHumanAgent("o desconto vale até sexta"));

      const messages = await threadMessages(convId);
      const attendant = messages.filter(isHumanAgentTurn);
      expect(attendant.length).toBe(1);
      expect(String(attendant[0]?.content)).toContain(
        "o desconto vale até sexta",
      );

      const transcript = renderTranscript(messages);
      expect(transcript).not.toContain("cliente: o desconto vale até sexta");
    });

    // Our own reply is already in the thread, written by the turn that produced it. Ingesting it again
    // would duplicate every answer the agent ever gave.
    test("our own bot's outgoing message is not ingested", async () => {
      const convId = 503;
      await deliver(convId, fromCustomer("tem em azul?"));
      await deliver(convId, fromOurBot("Temos sim!"));

      const transcript = renderTranscript(await threadMessages(convId));
      expect(transcript).toContain("cliente: tem em azul?");
      expect(transcript).not.toContain("Temos sim!");
    });

    // An emoji react is an acknowledgement, not something the team said. It reaches this seam looking
    // exactly like a reply (outgoing, public, sender type "user"), so it is excluded on the one field
    // that tells them apart.
    test("a reaction from a human agent is not stored as something they said", async () => {
      const convId = 505;
      await deliver(convId, fromCustomer("obrigada, era isso"));
      await deliver(convId, reactionFromHumanAgent("👍"));

      const transcript = renderTranscript(await threadMessages(convId));
      expect(transcript).toContain("cliente: obrigada, era isso");
      expect(transcript).not.toContain("👍");
    });

    // Round-2 review finding (P2): outgoing webhook events carry `attachments`, so an attendant who
    // answers with a file and no caption used to render to an empty string and be dropped on the spot.
    test("an attendant's attachment-only reply still reaches the memory", async () => {
      const convId = 506;
      await deliver(convId, fromCustomer("me manda o contrato"));
      await deliver(convId, {
        content: "",
        message_type: "outgoing",
        sender: { id: 5, name: "Ana", type: "user" },
        attachments: [
          { id: 1, file_type: "file", data_url: "https://x/c.pdf" },
        ],
      });

      const transcript = renderTranscript(await threadMessages(convId));
      expect(transcript).toContain("cliente: me manda o contrato");
      expect(transcript).toContain("atendente: <atendente enviou um arquivo");
    });

    // A private note is the operator talking to their own team. It is not part of the dialogue with the
    // customer, and putting it in the contact's permanent memory would leak internal notes into a
    // future prompt.
    test("a private note is not ingested", async () => {
      const convId = 504;
      await deliver(convId, fromCustomer("preciso de ajuda"));
      await deliver(convId, {
        ...fromHumanAgent("cliente reclamou do suporte no mês passado"),
        private: true,
      });

      const transcript = renderTranscript(await threadMessages(convId));
      expect(transcript).toContain("cliente: preciso de ajuda");
      expect(transcript).not.toContain("reclamou do suporte");
    });
  },
);
