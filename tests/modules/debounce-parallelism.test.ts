import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { flushDebounceJob } from "@/modules/debounce/handler";
import { runDebounceTick } from "@/modules/debounce/worker";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// End-to-end parallelism harness (no Chatwoot, no LLM): drives N real turns through the actual tick
// (runDebounceTick → flushDebounceJob → graph → runModelCall) with a stub Chatwoot client and a fake
// model that SLEEPS (simulating LLM latency) and records how many calls are in flight at once. Proves
// the fix empirically: turns overlap in time (not serial) and the model semaphore caps them.

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

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;

const REPLY = "Claro, posso ajudar!";
const CHATWOOT_INBOX_ID = 7;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function threadOf(convId: number) {
  return `${tenantId}:${instanceId}:${convId}`;
}

// NOTE: turns reach the model at their own pace, because each one does real DB work first. Measured
// on this suite: 20 turns spread their arrivals over 91-147ms while the fake latency was 100ms, so
// the first turn regularly released its permit before the last one arrived and the observed peak
// landed at 15-19 instead of 20. The test failed ~13% of local runs, isolated, with nothing wrong in
// the code under test.
//
// The gate turns that race into a rendezvous: every call parks until `quorum` are in flight at once,
// so the peak becomes a property of the SEMAPHORE rather than of how loaded the machine is. What it
// deliberately does not do is weaken the assertion — a semaphore that admits more than the cap still
// pushes the peak above it, and one that admits fewer never reaches quorum, waits out the grace
// window and fails on the same `toBe(cap)`. Both directions are covered by mutation.
//
// The grace window is ONE shared clock started by the first arrival, not a per-call timeout: a
// broken semaphore that serializes the calls then costs the test one window in total instead of one
// per call, which keeps a real failure fast and readable instead of a test-timeout.
const QUORUM_GRACE_MS = 1_000;

// NOTE: reaching quorum only settles the LOWER half of `toBe(cap)`. Releasing there would let the
// parked calls drain within `delayMs` while an over-admitted call was still doing its own DB work,
// and the peak would read exactly `cap` on a semaphore that admits more than one. So quorum does not
// release: everyone stays parked through this window, where an extra arrival still counts. Sized
// from the measured tail (the 5 surplus turns arrive within ~25ms of the 20th) at 3x the fake
// latency, so it is not a stopwatch on the same scale as the thing it observes.
//
// It is a window, not a proof: no finite wait can rule out an admission that comes later still. The
// deterministic upper bound lives in tests/lib/semaphore.test.ts and tests/graph/model-limit.test.ts,
// where every caller acquires synchronously in one tick and no timing is involved. What this buys is
// that the INTEGRATION path can see over-admission at all, which it could not before.
const OVERFLOW_PROBE_MS = 300;

function quorumGate(quorum: number, meter: { active: number }) {
  let reached: () => void = () => {};
  const atQuorum = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let quorumMet = false;
  let grace: Promise<unknown> | undefined;
  return async () => {
    if (meter.active >= quorum) {
      quorumMet = true;
      reached();
    }
    grace ??= sleep(QUORUM_GRACE_MS);
    await Promise.race([atQuorum, grace]);
    // Skipped when the gate opened on the grace clock instead: a semaphore that admits FEWER than
    // the cap never reaches quorum, and charging it the probe per serialized call would end the
    // test on the clock rather than on the assertion that names the defect.
    if (quorumMet) await sleep(OVERFLOW_PROBE_MS);
  };
}

// Fake chat model: waits for the rendezvous, then sleeps `delayMs` (LLM latency), tracking concurrent
// in-flight calls via a shared meter. bindTools returns self so it works whether or not the runtime
// binds native tools.
function sleepyModel(
  delayMs: number,
  meter: { active: number; max: number },
  gate: () => Promise<void>,
) {
  const model = {
    bindTools() {
      return model;
    },
    async invoke(_messages: BaseMessage[]) {
      meter.active += 1;
      meter.max = Math.max(meter.max, meter.active);
      try {
        await gate();
        await sleep(delayMs);
        return new AIMessage(REPLY);
      } finally {
        meter.active -= 1;
      }
    },
  };
  return model as unknown as BaseChatModel;
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
    id: 1n,
    tenantId,
    kind: "DEBOUNCE",
    payload: { threadId: threadOf(convId), agentBotId: 9, burstStartedAt: 1 },
    attempts: 0,
    claimSeq: 0,
  };
}

describe.skipIf(!dbUp)("debounce parallelism", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DBP", slug: `dbp-${process.pid}` },
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
        webhookRouteTokenHash: `dbp-route-${process.pid}`,
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

  test("N conversations drain in parallel, capped at the model semaphore", async () => {
    const cap = config.agent.modelConcurrency;
    const M = cap + 5;
    const delayMs = 100;
    const convIds = Array.from({ length: M }, (_, i) => 1000 + i);
    for (const id of convIds) await seedConversation(id);

    const meter = { active: 0, max: 0 };
    const gate = quorumGate(cap, meter);
    const sent: Array<[number, string]> = [];
    const jobs = convIds.map((id) => jobFor(id));

    const started = performance.now();
    const out = await runDebounceTick(appDb, M, {
      claim: async () => jobs,
      run: (job) =>
        flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => sleepyModel(delayMs, meter, gate),
            makeClient: parallelStub(sent),
            checkpointer: new MemorySaver(),
          },
        }).then(() => {}),
    });
    const elapsed = performance.now() - started;

    console.log(
      `[parallelism] ${M} conversas, cap do modelo ${cap}: concorrente ${Math.round(elapsed)}ms vs serial ~${M * delayMs}ms; pico de concorrência ${meter.max}`,
    );

    expect(out.claimed).toBe(M);
    // Every conversation answered exactly once (no turn stuck/dropped under concurrency).
    expect(sent.length).toBe(M);
    // Concurrency reached the model cap: proves parallel (serial would peak at 1) AND that the
    // semaphore holds the line at config.agent.modelConcurrency. Deterministic thanks to the
    // rendezvous above, which is why this is `toBe` and not a range.
    expect(meter.max).toBe(cap);
    // NOTE: the wall-clock anti-serial guard that used to sit here is gone. It bounded `elapsed`
    // below M*delayMs, but the rendezvous adds fixed harness time (grace clock, probe window) that
    // has nothing to do with the code under test, so the bound had drifted into measuring this
    // file's own overhead: 1428ms observed against a 2500ms threshold. It also bought nothing.
    // Serializing the worker's own `Promise.allSettled` over the jobs is caught above with a peak of
    // 1, before the timing assertion is ever reached. `elapsed` stays in the log, where a human
    // reading a failure wants it, and asserts nothing.
  });
});
