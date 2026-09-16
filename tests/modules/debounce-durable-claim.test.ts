import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { turnOwnsThread } from "@/graph/thread-claim";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { flushDebounceJob } from "@/modules/debounce/handler";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";

// The flush decides whether a turn already owns its thread by reading two `Map`s in its own process
// (`isTurnInFlight`, `isFlushHeld`). On the topology docs/deploy.md §4 sanctions those Maps are
// empty for a thread another replica is running, so the durable half of the same fact has to be the
// one that decides. This file is that fence, and every case here leaves the in-process registry
// untouched: an empty Map plus a busy row IS what another replica's turn looks like from here.

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

const CI_HELD = 881;
const CI_FREE = 882;
const CI_OTHER = 883;
const CONV_HELD = 8810;
const CONV_FREE = 8820;
const CONV_OTHER = 8830;
const CONV_NO_CI = 8840;
const CHATWOOT_INBOX_ID = 7;

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let jobId = 0n;

// Counts what the flush actually did: a model call means the turn ran on a thread somebody else owns.
function countingModel(calls: { n: number }) {
  const model = {
    bindTools() {
      return model;
    },
    async invoke() {
      calls.n += 1;
      return new AIMessage("resposta");
    },
  };
  return model as unknown as BaseChatModel;
}

function stub(sent: Array<[number, string]>) {
  const client = {
    getMessages: async () => ({
      payload: [
        { id: 100, content: "quanto custa?", message_type: 0, private: false },
      ],
    }),
    sendMessage: async (conversationId: number, content: string) => {
      sent.push([conversationId, content]);
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

// A claim exactly as another replica leaves it: holders on the row, lease in the future, and nothing
// in this process's registry. Written as SQL rather than through `markTurnOwning` on purpose, so the
// fence is pinned to the STATE a foreign holder produces and not to the helper that produces it.
async function holdThread(contactInboxId: number, graphThreadId: string) {
  await suDb.$executeRawUnsafe(
    `INSERT INTO agent_threads
       (tenant_id, chatwoot_instance_id, contact_inbox_id, thread_id,
        turn_holders, turn_epoch, turn_held_until, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, 1, now() + interval '5 minutes', now(), now())
     ON CONFLICT (tenant_id, chatwoot_instance_id, contact_inbox_id)
       DO UPDATE SET turn_holders = 1,
                     turn_held_until = now() + interval '5 minutes'`,
    tenantId,
    instanceId,
    contactInboxId,
    graphThreadId,
  );
}

function jobFor(convId: number): ClaimedJob {
  return {
    id: jobId,
    tenantId,
    kind: "DEBOUNCE",
    payload: {
      threadId: `${tenantId}:${instanceId}:${convId}`,
      agentBotId: 9,
      burstStartedAt: Date.now(),
    },
    attempts: 0,
    claimSeq: 0,
  };
}

async function runFlush(convId: number) {
  const calls = { n: 0 };
  const sent: Array<[number, string]> = [];
  const out = await flushDebounceJob({
    job: jobFor(convId),
    base: appDb,
    deps: {
      makeModel: () => countingModel(calls),
      makeClient: stub(sent),
      checkpointer: new MemorySaver(),
    },
  });
  return { out, calls: calls.n, sent };
}

describe.skipIf(!dbUp)(
  "the flush answers to the durable claim, not only to its own process",
  () => {
    beforeAll(async () => {
      jobId = await burnSchedulerJobId(suDb);
      const t = await suDb.tenant.create({
        data: { name: "DDC", slug: `ddc-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 9,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const llmKey = await suDb.vaultEntry.create({
        data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
        select: { id: true },
      });
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "Você é prestativa.",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${llmKey.id}`,
          },
          settings: {
            debounce: { enabled: true, windowSeconds: 15 },
            split: { enabled: false },
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
          webhookRouteTokenHash: `ddc-route-${process.pid}`,
          name: "Atendente",
        },
      });
      // The BINDING is what makes the flush resolve a config at all: an inbox with no agent leaves by
      // the "no conversation / no config" exit, and every case here then reads as zero model calls for
      // a reason that has nothing to do with the claim.
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: CHATWOOT_INBOX_ID,
          name: "Suporte",
          agentId: agent.id,
        },
        select: { id: true },
      });
      inboxDbId = inbox.id;
      for (const [conv, ci] of [
        [CONV_HELD, CI_HELD],
        [CONV_FREE, CI_FREE],
        [CONV_OTHER, CI_OTHER],
        [CONV_NO_CI, null],
      ] as Array<[number, number | null]>)
        await suDb.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: conv,
            status: "pending",
            assigneeType: null,
            inboxId: inboxDbId,
            threadId: `${tenantId}:${instanceId}:${conv}`,
            lastEventAt: new Date(),
            lastHandledMessageId: null,
            ...(ci === null ? {} : { contactInboxId: ci }),
          },
        });
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of [
          "agent_threads",
          "scheduler_jobs",
          "llm_usage",
          "conversations",
          "inboxes",
          "agents",
          "vault_entries",
          "chatwoot_instances",
        ])
          await suDb.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          );
        await suDb.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = ${tenantId}`,
        );
      }
      // NOTE: the shard is one process for every file in it, so a pool left open here is still open
      // 33 files later. Measured on run 35116422422: without these two, `scheduler-lanes` claims
      // fewer jobs than it asks for and fails on the count, with `Timed out fetching a new
      // connection from the connection pool` in the same shard's log.
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    // s1: the core of issue #593. Another replica owns the graph thread; this process knows nothing.
    test("a thread owned by another process is not invoked, and the burst survives", async () => {
      const graphThreadId = contactInboxThreadId(tenantId, instanceId, CI_HELD);
      await holdThread(CI_HELD, graphThreadId);
      // THE PRECONDITION FIRST, on the same key the flush computes. Without it a wrong key would make
      // every assertion below pass for the wrong reason once the fix lands: "nobody owns a thread I am
      // not asking about" is not the same statement as "the flush honours the owner".
      const rowSaysHeld = await turnOwnsThread(
        {
          tenantId,
          instanceId,
          contactInboxId: CI_HELD,
          graphThreadId,
        },
        appDb,
      );
      const { calls, sent } = await runFlush(CONV_HELD);
      // And the burst has to still be OWED, which is the third symptom the issue measured: a flush
      // that answered also advanced the watermark, so the messages are gone AND marked handled.
      const [conv] = await suDb.$queryRawUnsafe<{ handled: number | null }[]>(
        `SELECT last_handled_message_id AS handled FROM conversations
        WHERE tenant_id = ${tenantId} AND chatwoot_conversation_id = ${CONV_HELD}`,
      );
      expect([rowSaysHeld, calls, sent.length, conv?.handled ?? null]).toEqual([
        true,
        0,
        0,
        null,
      ]);
    });

    // s6: no row is not ownership. The first burst of a contact inbox has nothing to hold.
    test("a thread with no row at all is answered", async () => {
      const { calls } = await runFlush(CONV_FREE);
      expect(calls).toBe(1);
    });

    // s7: the claim is per contact inbox. Another contact's live claim says nothing about this one.
    test("another contact's live claim does not hold this flush", async () => {
      await holdThread(
        CI_HELD,
        contactInboxThreadId(tenantId, instanceId, CI_HELD),
      );
      const { calls } = await runFlush(CONV_OTHER);
      expect(calls).toBe(1);
    });

    // s8: the conversation-keyed thread has no row to hold, and must keep being served. The Map is
    // the whole answer there, which is the cost issue #203 measured and accepted.
    test("a conversation with no contact inbox is still answered", async () => {
      const { calls } = await runFlush(CONV_NO_CI);
      expect(calls).toBe(1);
    });
  },
);
