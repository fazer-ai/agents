import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { flushDebounceJob } from "@/modules/debounce/handler";
import { armDebounce, debounceDedupeKey } from "@/modules/debounce/service";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";

// Two flushes on ONE conversation, which is the shape issue #588 is about and the one
// debounce-parallelism.test.ts deliberately does not cover: that file proves DIFFERENT conversations
// overlap, which is the feature. Overlapping on the SAME thread is the defect.
//
// The second flush is not contrived. `armDebounce` says so itself: a live PENDING row is the burst a
// message joins, and "anything else (no row, DONE, DEAD, or A CLAIM IN FLIGHT) means the previous
// flush is finished business and this message opens a NEW burst". So a customer who writes while the
// agent is still answering arms a second flush by design, and it fires a debounce window later —
// while the first turn is still in the model, in a tool, or paying out its split balloons.

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

const CONV_DEFER = 4242;
const CONV_CEILING = 4243;
// Duas conversas do mesmo contato: elas compartilham o canal do grafo, não a thread da conversa.
const CONV_IRMA_A = 4244;
const CONV_IRMA_B = 4245;
const CONTACT_INBOX = 777;
const CONV_CORRIDA_A = 4246;
const CONV_CORRIDA_B = 4247;
const CONTACT_INBOX_CORRIDA = 778;
const CHATWOOT_INBOX_ID = 7;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let jobIdA = 0n;
let jobIdB = 0n;
let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;

const threadOf = (convId: number) => `${tenantId}:${instanceId}:${convId}`;

// Records every model call's overlap on the thread. `max` above 1 means two turns were reading and
// writing the same message channel at once, which is what makes the second answer blind to the first.
// Signals when a turn is actually INSIDE the model, so the second flush can be started at a moment
// that is deterministic instead of racing the first one's setup. This is also the honest shape: in
// production the second flush arrives at a later worker tick, not in the same `Promise.allSettled`.
function overlapModel(
  delayMs: number,
  meter: { active: number; max: number },
  seen: string[][],
  entered?: { signal: () => void },
) {
  const model = {
    bindTools() {
      return model;
    },
    async invoke(messages: BaseMessage[]) {
      meter.active += 1;
      meter.max = Math.max(meter.max, meter.active);
      // What THIS turn was given to answer from, so "computed blind" is a measurement rather than a
      // claim: an answer that cannot see the previous one is one whose history lacks it.
      seen.push(messages.map((m) => String(m.content)));
      entered?.signal();
      try {
        await sleep(delayMs);
        return new AIMessage(`resposta ${seen.length}`);
      } finally {
        meter.active -= 1;
      }
    },
  };
  return model as unknown as BaseChatModel;
}

function stub(sent: Array<[number, string]>) {
  const client = {
    getMessages: async () => ({
      payload: [
        { id: 100, content: "quanto custa?", message_type: 0, private: false },
        {
          id: 101,
          content: "e tem desconto?",
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

function jobFor(
  id: bigint,
  convId: number,
  burstStartedAt: number,
): ClaimedJob {
  return {
    id,
    tenantId,
    kind: "DEBOUNCE",
    payload: { threadId: threadOf(convId), agentBotId: 9, burstStartedAt },
    attempts: 0,
    claimSeq: 0,
  };
}

describe.skipIf(!dbUp)("two flushes on one thread", () => {
  beforeAll(async () => {
    jobIdA = await burnSchedulerJobId(suDb);
    jobIdB = await burnSchedulerJobId(suDb);
    const t = await suDb.tenant.create({
      data: { name: "DST", slug: `dst-${process.pid}` },
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
        webhookRouteTokenHash: `dst-route-${process.pid}`,
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

  // One conversation per test: the first test's turn advances the handled watermark, and a second
  // test sharing the row would find nothing to answer and pass on an empty run.
  async function seedConversation(convId: number, contactInboxId?: number) {
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
        ...(contactInboxId !== undefined ? { contactInboxId } : {}),
      },
    });
  }

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

  // Runs flush A, waits until it is actually inside the model, then runs flush B — which is when the
  // second flush arrives in production: `armDebounce` re-arms the same row while A's claim is in
  // flight, and the worker claims it again on a later tick.
  async function twoFlushes(convId: number, burstStartedAt: number) {
    await seedConversation(convId);
    const meter = { active: 0, max: 0 };
    const seen: string[][] = [];
    const sent: Array<[number, string]> = [];
    const checkpointer = new MemorySaver();
    let inModel: () => void = () => {};
    const entered = { signal: () => inModel() };
    const insideModel = new Promise<void>((r) => {
      inModel = r;
    });

    const deps = {
      makeModel: () => overlapModel(400, meter, seen, entered),
      makeClient: stub(sent),
      checkpointer,
    };
    const a = flushDebounceJob({
      job: jobFor(jobIdA, convId, burstStartedAt),
      base: appDb,
      deps,
    });
    // Resolves on the grace clock instead of hanging if A never reaches the model, so a broken run
    // fails on an assertion rather than on the test timeout.
    await Promise.race([insideModel, sleep(5_000)]);
    const b = await flushDebounceJob({
      job: jobFor(jobIdB, convId, burstStartedAt),
      base: appDb,
      deps,
    });
    await a;

    const canal: BaseMessage[] = [];
    for await (const cp of checkpointer.list({
      configurable: { thread_id: threadOf(convId) },
    })) {
      const msgs = (
        cp.checkpoint?.channel_values as
          | { messages?: BaseMessage[] }
          | undefined
      )?.messages;
      if (msgs) {
        canal.length = 0;
        canal.push(...msgs);
        break;
      }
    }
    return { meter, seen, sent, b, canal };
  }

  test("the second flush waits instead of running a turn on top of the first", async () => {
    const { meter, seen, b, canal } = await twoFlushes(CONV_DEFER, Date.now());

    console.log(
      `[same-thread] pico simultâneo: ${meter.max}; invokes: ${seen.length}; desfecho do 2º flush: ${b.outcome}`,
    );
    console.log(
      `  canal (${canal.length}): ${JSON.stringify(canal.map((m) => String(m.content).slice(0, 30)))}`,
    );

    // The issue in one number: two invokes at once on one thread means the second loaded the channel
    // before the first saved it, so neither answer can contain the other and each saves back what it
    // loaded.
    expect(meter.max).toBe(1);
    expect(seen.length).toBe(1);
    // Deferred, not failed — the distinction the scheduler acts on: a `fail` would spend an attempt,
    // stamp last_error on the conversation and eventually dead-letter a burst whose only problem was
    // arriving at a busy moment.
    expect(b.outcome).toBe("reschedule");
    // And the burst is not written twice into the agent's permanent memory, which is what the two
    // concurrent read-modify-writes produced before: measured on 4b35f318 as a channel of
    // [burst, burst, answer].
    const bursts = canal.filter((m) =>
      String(m.content).includes("quanto custa?"),
    );
    expect(bursts.length).toBe(1);
  }, 30_000);

  test("past the ceiling it answers anyway rather than deferring forever", async () => {
    // A burst that opened past the ceiling is one whose thread has been held longer than any
    // legitimate turn. The ceiling is a DEADLINE anchored on burstStartedAt precisely so it can be
    // driven this way: the two counters that would have been easier are both unusable,
    // `rescheduleJob` zeroing `attempts` and `armDebounce` replacing the payload a counter lives in.
    //
    // SIX MINUTES IS A LITERAL ON PURPOSE, not DEFER_CEILING_MS + 1. Importing the constant would
    // move this input with any change to it, so a ceiling widened to an hour would keep the test
    // green while the customer waits an hour. Measured against the mutation: with the constant
    // imported, a 1000x ceiling survived.
    const { meter, seen, b } = await twoFlushes(
      CONV_CEILING,
      Date.now() - 6 * 60_000,
    );

    console.log(
      `[same-thread/ceiling] pico simultâneo: ${meter.max}; invokes: ${seen.length}; desfecho: ${b.outcome}`,
    );

    // It ran: an unanswered customer is worse than a duplicated line in memory, and a thread wedged
    // by a dead process must not swallow the conversation.
    expect(b.outcome).not.toBe("reschedule");
    expect(seen.length).toBe(2);
  }, 30_000);

  test("two conversations of one contact take turns, because they share the channel", async () => {
    // The key is the GRAPH thread, not the conversation's, and this is the case that tells them
    // apart: a contact with two open conversations has ONE message channel (tenant:instance:ci:<id>),
    // so a turn on either one is a read-modify-write of the other's memory. Keying on the
    // conversation would leave this exactly as it was, and the duplicate-burst corruption with it.
    await seedConversation(CONV_IRMA_A, CONTACT_INBOX);
    await seedConversation(CONV_IRMA_B, CONTACT_INBOX);
    const meter = { active: 0, max: 0 };
    const seen: string[][] = [];
    const sent: Array<[number, string]> = [];
    let inModel: () => void = () => {};
    const entered = { signal: () => inModel() };
    const insideModel = new Promise<void>((r) => {
      inModel = r;
    });
    const deps = {
      makeModel: () => overlapModel(400, meter, seen, entered),
      makeClient: stub(sent),
      checkpointer: new MemorySaver(),
    };

    const a = flushDebounceJob({
      job: jobFor(jobIdA, CONV_IRMA_A, Date.now()),
      base: appDb,
      deps,
    });
    await Promise.race([insideModel, sleep(5_000)]);
    const b = await flushDebounceJob({
      job: jobFor(jobIdB, CONV_IRMA_B, Date.now()),
      base: appDb,
      deps,
    });
    await a;

    console.log(
      `[same-contact] pico simultâneo: ${meter.max}; invokes: ${seen.length}; desfecho da irmã: ${b.outcome}`,
    );
    expect(meter.max).toBe(1);
    expect(b.outcome).toBe("reschedule");
  }, 30_000);

  test("two flushes claimed in the same tick cannot both pass the check", async () => {
    // The window the reservation exists for, and the one the sequenced tests above cannot see: a
    // turn marks itself several awaits past the check (message fetch, burst selection, the
    // authorization gate), so two flushes STARTED TOGETHER can both read an unheld thread. Two
    // conversations of one contact are two scheduler rows, claimed in the same tick and started
    // concurrently by the worker, and they share the graph key.
    await seedConversation(CONV_CORRIDA_A, CONTACT_INBOX_CORRIDA);
    await seedConversation(CONV_CORRIDA_B, CONTACT_INBOX_CORRIDA);
    const meter = { active: 0, max: 0 };
    const seen: string[][] = [];
    const sent: Array<[number, string]> = [];
    const deps = {
      makeModel: () => overlapModel(400, meter, seen),
      makeClient: stub(sent),
      checkpointer: new MemorySaver(),
    };
    // No rendezvous on purpose: both are launched in the same turn of the event loop, which is what
    // `runDebounceTick`'s Promise.allSettled does.
    const [ra, rb] = await Promise.all([
      flushDebounceJob({
        job: jobFor(jobIdA, CONV_CORRIDA_A, Date.now()),
        base: appDb,
        deps,
      }),
      flushDebounceJob({
        job: jobFor(jobIdB, CONV_CORRIDA_B, Date.now()),
        base: appDb,
        deps,
      }),
    ]);

    console.log(
      `[mesma-tick] pico simultâneo: ${meter.max}; invokes: ${seen.length}; desfechos: ${ra.outcome}/${rb.outcome}`,
    );
    expect(meter.max).toBe(1);
    // Exactly one ran and exactly one stood down: neither "both deferred" (nobody answers) nor
    // "both ran" (the defect) passes.
    expect(seen.length).toBe(1);
    expect(
      [ra.outcome, rb.outcome].filter((o) => o === "reschedule"),
    ).toHaveLength(1);
  }, 30_000);

  test("the deferral deadline survives a re-arm while the flush is claimed", async () => {
    // Found in review: a message arriving while the flush is CLAIMED opens a new burst by design and
    // takes a fresh `burstStartedAt` with it, so a deadline anchored there was pushed forward by
    // every arrival — a customer who kept typing at a wedged thread was never answered at all.
    const thread = threadOf(4248);
    const cfg = {
      enabled: true,
      windowSeconds: 15,
      maxMessagesPerBurst: 20,
      maxWindowSeconds: 60,
    };
    const stamp = Date.now() - 120_000;
    const key = debounceDedupeKey(thread);
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId} AND dedupe_key = '${key}'`,
    );
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: key,
        status: "CLAIMED",
        runAt: new Date(),
        payload: {
          threadId: thread,
          agentBotId: 9,
          burstStartedAt: stamp,
          deferringSince: stamp,
        },
      },
    });

    await armDebounce({
      tenantId,
      threadId: thread,
      agentBotId: 9,
      cfg,
      base: appDb,
    });
    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, kind: "DEBOUNCE", dedupeKey: key },
      select: { payload: true },
    });
    const p = row.payload as {
      burstStartedAt?: number;
      deferringSince?: number;
    };
    // The new burst legitimately restarts burstStartedAt, which is what a claim in flight means...
    expect(p.burstStartedAt).toBeGreaterThan(stamp);
    // ...and the deadline does NOT restart with it.
    expect(p.deferringSince).toBe(stamp);
  }, 30_000);
});
