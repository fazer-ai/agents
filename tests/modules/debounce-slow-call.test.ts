import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { flushDebounceJob } from "@/modules/debounce/handler";
import { runDebounceTick } from "@/modules/debounce/worker";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";

// Issue #807, at the effect the customer feels: conversation A's model call does not return, and
// conversation B, which comes due after it, still gets its reply. Drives real flushes through the
// actual tick (runDebounceTick → flushDebounceJob → graph → runModelCall) with a stub Chatwoot client
// and a fake model that hangs on A's turn. The harness is debounce-parallelism.test.ts's.

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

// Burned from `scheduler_jobs_id_seq`, never a literal: tests/utils/scheduler.ts says why. One per
// conversation, because the drain tells jobs apart by id.
const phantomJobIds = new Map<number, bigint>();

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;

const REPLY = "Claro, posso ajudar!";
const CHATWOOT_INBOX_ID = 7;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function threadOf(convId: number) {
  return `${tenantId}:${instanceId}:${convId}`;
}

// One new incoming message per conversation; sendMessage records the post. Shared across turns —
// getMessages keys off conversationId, so each turn sees its own message.
function parallelStub(sent: Array<[number, string]>) {
  const client = {
    getMessages: async (conversationId: number) => ({
      payload: [
        {
          id: 100,
          content: `oi da conversa ${conversationId}`,
          message_type: 0,
          private: false,
        },
      ],
    }),
    sendMessage: async (conversationId: number, content: string) => {
      sent.push([conversationId, content]);
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

async function seedConversation(convId: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: null,
      inboxId: inboxDbId,
      threadId: threadOf(convId),
      lastEventAt: new Date(),
      lastHandledMessageId: null,
    },
  });
}

function jobFor(convId: number): ClaimedJob {
  return {
    id: phantomJobIds.get(convId) ?? 0n,
    tenantId,
    kind: "DEBOUNCE",
    payload: { threadId: threadOf(convId), agentBotId: 9, burstStartedAt: 1 },
    attempts: 0,
    claimSeq: 0,
  };
}

const CONV_A = 2001;
const CONV_B = 2002;

// Resolves to "timeout" when `p` has not settled within `ms`, so a drain that waits on a call that
// never returns fails an assertion instead of the runner's own timeout.
function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([p, sleep(ms).then(() => "timeout" as const)]);
}

async function until(cond: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

describe.skipIf(!dbUp)("debounce drain: a hung model call", () => {
  beforeAll(async () => {
    for (const id of [CONV_A, CONV_B]) {
      phantomJobIds.set(id, await burnSchedulerJobId(suDb));
    }
    const t = await suDb.tenant.create({
      data: { name: "DSC", slug: `dsc-${process.pid}` },
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
        webhookRouteTokenHash: `dsc-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "Suporte",
        agentId: agent.id,
      },
    });
    inboxDbId = inbox.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "scheduler_jobs",
        "llm_usage",
        "conversations",
        "inboxes",
        "agents",
        "vault_entries",
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

  test("conversation B is answered while conversation A's model call is still hanging", async () => {
    await seedConversation(CONV_A);
    await seedConversation(CONV_B);

    let releaseA: () => void = () => {};
    const aReleased = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aCalled = false;
    const model = {
      bindTools() {
        return model;
      },
      async invoke(messages: BaseMessage[]) {
        const text = messages.map((m) => String(m.content)).join("\n");
        if (text.includes(`conversa ${CONV_A}`)) {
          aCalled = true;
          await aReleased;
        }
        return new AIMessage(REPLY);
      },
    } as unknown as BaseChatModel;

    const sent: Array<[number, string]> = [];
    const due = [[jobFor(CONV_A)], [jobFor(CONV_B)]];
    const deps = {
      claim: async () => due.shift() ?? [],
      run: (job: ClaimedJob) =>
        flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => model,
            makeClient: parallelStub(sent),
            checkpointer: new MemorySaver(),
          },
        }).then(() => {}),
    };

    const tickA = await within(runDebounceTick(appDb, 5, deps), 2_000);
    expect(tickA).not.toBe("timeout");
    expect(await until(() => aCalled)).toBe(true);

    // B comes due after A's call is already hanging, and the next tick drains it.
    const tickB = await within(runDebounceTick(appDb, 5, deps), 2_000);
    expect(tickB).not.toBe("timeout");
    if (tickB === "timeout") return;
    expect(await within(tickB.settled, 5_000)).not.toBe("timeout");
    expect(sent).toEqual([[CONV_B, REPLY]]);

    // A is answered too, once its call returns: nothing was dropped to get B through.
    releaseA();
    if (tickA !== "timeout") await within(tickA.settled, 5_000);
    expect(sent).toEqual([
      [CONV_B, REPLY],
      [CONV_A, REPLY],
    ]);
  });
});
