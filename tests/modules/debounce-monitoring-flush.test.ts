import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { followUpDedupeKey } from "@/modules/channel-redirect/followup";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { flushDebounceJob } from "@/modules/debounce/handler";
import { debounceDedupeKey } from "@/modules/debounce/service";
import { monthStart } from "@/modules/spend-ceiling/decide";
import { seedChatwootInstance } from "../utils/chatwoot";

// A DEBOUNCE job armed for a PRODUCTION agent, flushed after the operator flipped the agent to
// monitoring (issue #209 review, round 5). The receiver expected the turn to cover the burst, so it
// neither ingested the messages nor advanced the watermark; the config load then refuses a
// monitoring agent. The flush has to do what the observer would have done for those messages —
// hand each to ingestion and move the handled watermark past them — and post nothing. A disabled
// agent's burst, the exit this used to share, is the control: it waits for the switch, untouched.

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

const CHATWOOT_INBOX_ID = 91;
const OUR_BOT = 29;
const CONV_OBSERVED = 9410;
const CONV_DISABLED = 9411;
const CONV_FLIPPED_MID_TURN = 9412;
const CONV_CEILING = 9413;
const CONV_PAGED = 9414;
const CONV_OUT_OF_REACH = 9415;
const CONV_NO_THREAD = 9416;
const CONV_DENIED = 9417;
const CONV_FETCH_FAILS = 9418;
const CONV_TAKEN_DURING_AUTH = 9419;
const CONV_DENIED_UNREAD = 9420;
const CONV_THROWS = 9421;
const CONV_GATE_TAKEN = 9422;
const CONV_LEDGER = 9423;
const CONV_OTHER_BOT = 9424;
const CONV_OBS_FAILS = 9425;
const CONV_HANDLED_FLOOR = 9426;
const CONV_WATERMARK_PAST = 9427;
const CONV_REPLY_AHEAD = 9428;
const CONV_GATE_UNREADABLE = 9429;
const CONV_TURN_UNREADABLE = 9430;
const CONV_LADDER_FLIP = 9431;
const CONV_CEILING_CLIENT = 9432;
const CONV_PAST_BOUND = 9433;
let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let agentDbId = 0n;

function threadOf(convId: number) {
  return `${tenantId}:${instanceId}:${convId}`;
}

function page(msgs: Array<{ id: number; content: string }>) {
  return {
    payload: msgs.map((m) => ({
      id: m.id,
      content: m.content,
      message_type: 0,
      private: false,
    })),
  };
}

function stub(
  pages: unknown[],
  opts: {
    // The page Chatwoot answers for `before=<id>`, keyed by that id.
    before?: Record<number, unknown>;
    // Runs inside the FIRST message fetch, which is the wait an operator's flip lands in.
    onFirstFetch?: () => Promise<void>;
    // Every fetch after the first fails: the observer's own re-read of the burst, in particular.
    laterFetchesFail?: boolean;
  } = {},
) {
  const sent: string[] = [];
  const notes: string[] = [];
  const toggles: string[] = [];
  const calls = { getMessages: 0, before: [] as number[] };
  const client = {
    getMessages: async (_id: number, o?: { before?: number }) => {
      calls.getMessages += 1;
      if (calls.getMessages === 1 && opts.onFirstFetch)
        await opts.onFirstFetch();
      if (calls.getMessages > 1 && opts.laterFetchesFail) {
        throw new Error("chatwoot down");
      }
      if (o?.before != null) {
        calls.before.push(o.before);
        return opts.before?.[o.before] ?? { payload: [] };
      }
      return pages[Math.min(calls.getMessages - 1, pages.length - 1)];
    },
    sendMessage: async (_id: number, text: string) => {
      sent.push(text);
      return {};
    },
    sendPrivateNote: async (_id: number, text: string) => {
      notes.push(text);
      return {};
    },
    toggleStatus: async (_id: number, status: string) => {
      toggles.push(status);
      return {};
    },
    toggleTyping: async () => ({}),
    getConversationLabels: async () => [],
    listLabels: async () => [],
    listCustomAttributeDefinitions: async () => [],
  } as unknown as ChatwootClient;
  return { sent, notes, toggles, calls, makeClient: async () => client };
}

function ingestedIds(keys: string[], contactInboxId: number): number[] {
  return keys
    .map((k) => k.split(":"))
    .filter((p) => p.at(-2) === String(contactInboxId))
    .map((p) => Number(p.at(-1)))
    .sort((a, b) => a - b);
}

async function seedConversation(convId: number, contactInboxId: number | null) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: null,
      inboxId: inboxDbId,
      contactInboxId,
      threadId: threadOf(convId),
      lastEventAt: new Date(),
    },
  });
}

async function claimedJob(convId: number, lastMessageId: number) {
  const thread = threadOf(convId);
  const row = await suDb.schedulerJob.create({
    data: {
      tenantId,
      kind: "DEBOUNCE",
      dedupeKey: debounceDedupeKey(thread),
      status: "CLAIMED",
      runAt: new Date(),
      payload: {
        threadId: thread,
        agentBotId: OUR_BOT,
        burstStartedAt: 1,
        lastMessageId,
      },
    },
    select: { id: true, claimSeq: true },
  });
  return {
    id: row.id,
    tenantId,
    kind: "DEBOUNCE" as const,
    payload: {
      threadId: thread,
      agentBotId: OUR_BOT,
      burstStartedAt: 1,
      lastMessageId,
    },
    attempts: 0,
    claimSeq: row.claimSeq,
  };
}

async function watermarkOf(convId: number) {
  const row = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { lastHandledMessageId: true },
  });
  return row.lastHandledMessageId;
}

async function ingestJobs() {
  return suDb.schedulerJob.findMany({
    where: { tenantId, kind: "INGEST_MESSAGE" },
    select: { dedupeKey: true },
    orderBy: { dedupeKey: "asc" },
  });
}

describe.skipIf(!dbUp)(
  "a debounce flush under an agent flipped to monitoring",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "MONFLUSH", slug: `monflush-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 41,
        baseUrl: "https://chat.monflush.example",
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
          enabled: true,
          mode: "production",
          settings: { debounce: { enabled: true, windowSeconds: 15 } },
        },
      });
      agentDbId = agent.id;
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: OUR_BOT,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `monflush-route-${process.pid}`,
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
      await seedConversation(CONV_OBSERVED, 94_100);
      await seedConversation(CONV_DISABLED, 94_110);
      await seedConversation(CONV_FLIPPED_MID_TURN, 94_120);
      await seedConversation(CONV_CEILING, 94_130);
      await seedConversation(CONV_PAGED, 94_140);
      await seedConversation(CONV_OUT_OF_REACH, 94_150);
      await seedConversation(CONV_NO_THREAD, null);
      await seedConversation(CONV_DENIED, 94_170);
      await seedConversation(CONV_FETCH_FAILS, 94_180);
      await seedConversation(CONV_TAKEN_DURING_AUTH, 94_190);
      await seedConversation(CONV_DENIED_UNREAD, 94_200);
      await seedConversation(CONV_THROWS, 94_210);
      await seedConversation(CONV_GATE_TAKEN, 94_220);
      await seedConversation(CONV_LEDGER, 94_230);
      await seedConversation(CONV_OTHER_BOT, 94_240);
      await seedConversation(CONV_OBS_FAILS, 94_250);
      await seedConversation(CONV_HANDLED_FLOOR, 94_260);
      await seedConversation(CONV_WATERMARK_PAST, 94_270);
      await seedConversation(CONV_REPLY_AHEAD, 94_280);
      await seedConversation(CONV_GATE_UNREADABLE, 94_290);
      await seedConversation(CONV_TURN_UNREADABLE, 94_300);
      await seedConversation(CONV_LADDER_FLIP, 94_310);
      await seedConversation(CONV_CEILING_CLIENT, 94_320);
      await seedConversation(CONV_PAST_BOUND, 94_330);
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of [
          "execution_logs",
          "scheduler_jobs",
          "chatwoot_webhook_deliveries",
          "agent_threads",
          "contact_auth_grants",
          "contacts",
          "llm_usage",
          "conversations",
          "inboxes",
          "chatwoot_agent_bots",
          "agents",
          "vault_entries",
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
      }
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("the armed burst is handed to ingestion and the watermark moves past it; nothing is posted", async () => {
      // Armed while the agent answered; flipped before the flush.
      const job = await claimedJob(CONV_OBSERVED, 2);
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      const s = stub([
        page([
          { id: 1, content: "oi" },
          { id: 2, content: "quero cancelar" },
        ]),
      ]);
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error("a monitoring agent must not reach the model");
            },
            makeClient: s.makeClient as never,
          },
        });
        expect(out).toEqual({ outcome: "done" });
        expect(s.sent).toEqual([]);
        expect(s.calls.getMessages).toBe(1);
        // One job per message of the burst, keyed by the contact-inbox thread and the message id.
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(keys.map((k) => k.split(":").slice(-2).join(":"))).toEqual([
          "94100:1",
          "94100:2",
        ]);
        expect(await watermarkOf(CONV_OBSERVED)).toBe(2);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a flip inside the flush's own model call: the burst is remembered and marked handled, nothing posted", async () => {
      // The turn LOADED as production and stood down at the send fence. It ran over the burst, so
      // the watermark is past it, and the rolled-back turn left it in nobody's memory: the flush
      // reads the agent again and hands the burst to the observer's ingestion (review round 6).
      const job = await claimedJob(CONV_FLIPPED_MID_TURN, 3);
      class FlippingModel extends FakeListChatModel {
        override bindTools(): this {
          return this;
        }
        override async _generate(
          ...args: Parameters<FakeListChatModel["_generate"]>
        ): ReturnType<FakeListChatModel["_generate"]> {
          await suDb.agent.update({
            where: { id: agentDbId },
            data: { mode: "monitoring" },
          });
          return super._generate(...args);
        }
      }
      const s = stub([page([{ id: 3, content: "quero cancelar" }])]);
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () =>
              new FlippingModel({ responses: ["Claro, vou ver."] }),
            makeClient: s.makeClient as never,
            checkpointer: new MemorySaver(),
          },
        });
        expect(out).toEqual({ outcome: "done" });
        expect(s.sent).toEqual([]);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_120)).toEqual([3]);
        expect(await watermarkOf(CONV_FLIPPED_MID_TURN)).toBe(3);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a flip inside the burst fetch of a flush over the spend ceiling posts none of the ceiling's actions", async () => {
      // The ceiling's copy, note and handoff are outputs of this flush like a reply is, decided
      // under a config the burst fetch made old (review round 6).
      const before = await suDb.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { settings: true },
      });
      await suDb.tenant.update({
        where: { id: tenantId },
        data: {
          settings: {
            ...((before.settings as object) ?? {}),
            spendCeiling: {
              enabled: true,
              monthlyInboxUsd: 10,
              overCeilingMessage: "Orçamento do mês esgotado.",
            },
          },
        },
      });
      // The month's cost as the poll would have left it (#426): the gate reads the snapshot, not
      // the ledger.
      await suDb.spendCostSnapshot.create({
        data: {
          tenantId,
          source: "inbox",
          monthStart: monthStart(new Date()),
          costUsd: 12,
          polledAt: new Date(),
        },
      });
      const job = await claimedJob(CONV_CEILING, 7);
      const s = stub([page([{ id: 7, content: "oi" }])], {
        onFirstFetch: async () => {
          await suDb.agent.update({
            where: { id: agentDbId },
            data: { mode: "monitoring" },
          });
        },
      });
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error("the model must not be invoked over the ceiling");
            },
            makeClient: s.makeClient as never,
            checkpointer: new MemorySaver(),
          },
        });
        expect(out).toEqual({ outcome: "done" });
        expect(s.sent).toEqual([]);
        expect(s.toggles).toEqual([]);
        expect(s.notes).toEqual([]);
        // And the burst is the observer's (round 9): the flip landed inside the ceiling's own
        // waits, and the exit hands it over like the turn's does.
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_130)).toEqual([7]);
        expect(await watermarkOf(CONV_CEILING)).toBe(7);
      } finally {
        await suDb.spendCostSnapshot.deleteMany({ where: { tenantId } });
        await suDb.tenant.update({
          where: { id: tenantId },
          data: { settings: (before.settings as object) ?? {} },
        });
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a burst pushed off the newest page by what came after the flip is still found, one page back", async () => {
      // Twenty observed messages arrived after the flip; the armed burst (1, 2) is on the page
      // before them. Read from the newest page alone the burst would be empty and the watermark
      // would move anyway (review round 6).
      const job = await claimedJob(CONV_PAGED, 2);
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      const newest = Array.from({ length: 20 }, (_, i) => ({
        id: 30 + i,
        content: `depois ${i}`,
      }));
      const s = stub([page(newest)], {
        before: {
          30: page([
            { id: 1, content: "oi" },
            { id: 2, content: "quero cancelar" },
          ]),
        },
      });
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error("a monitoring agent must not reach the model");
            },
            makeClient: s.makeClient as never,
          },
        });
        expect(out).toEqual({ outcome: "done" });
        expect(s.calls.before).toEqual([30]);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_140)).toEqual([1, 2]);
        expect(await watermarkOf(CONV_PAGED)).toBe(2);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a burst the bounded walk cannot bring into view is left unmarked, and fails the flush", async () => {
      // Five full pages back and the floor is still not in sight: nothing of the burst was read, so
      // nothing of it is marked handled (review round 7) — and the flush fails rather than
      // completing, since the ordinary flush reads one page and would advance the watermark past
      // what the bound left out (review round 25).
      const job = await claimedJob(CONV_OUT_OF_REACH, 2);
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      const fullPage = (from: number) =>
        page(
          Array.from({ length: 20 }, (_, i) => ({
            id: from + i,
            content: `depois ${from + i}`,
          })),
        );
      const s = stub([fullPage(200)], {
        before: {
          200: fullPage(180),
          180: fullPage(160),
          160: fullPage(140),
          140: fullPage(120),
          120: fullPage(100),
        },
      });
      try {
        await expect(
          flushDebounceJob({
            job,
            base: appDb,
            deps: {
              makeModel: () => {
                throw new Error("a monitoring agent must not reach the model");
              },
              makeClient: s.makeClient as never,
            },
          }),
        ).rejects.toThrow("hand-over failed");
        expect(s.calls.before).toEqual([200, 180, 160, 140]);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_150)).toEqual([]);
        expect(await watermarkOf(CONV_OUT_OF_REACH)).toBeNull();
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a burst on a conversation with no contact-inbox thread is left unmarked", async () => {
      // Nothing of it can be remembered here, so nothing of it is marked (review round 8).
      const job = await claimedJob(CONV_NO_THREAD, 4);
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      const s = stub([page([{ id: 4, content: "oi" }])]);
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error("a monitoring agent must not reach the model");
            },
            makeClient: s.makeClient as never,
          },
        });
        expect(out).toEqual({ outcome: "done" });
        expect(s.calls.getMessages).toBe(0);
        expect(await watermarkOf(CONV_NO_THREAD)).toBeNull();
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a flip inside the contact-authorization call of a flush hands the refused burst to the observer", async () => {
      // The refusal marks the burst handled and drops it; under an observer it is remembered too
      // (round 9).
      const before = await suDb.agent.findUniqueOrThrow({
        where: { id: agentDbId },
        select: { settings: true },
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          settings: {
            ...((before.settings as object) ?? {}),
            contactAuth: {
              enabled: true,
              url: "https://203.0.113.9:9443/check",
              handoffEnabled: false,
            },
          },
        },
      });
      const contact = await suDb.contact.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootContactId: 94_170,
          phone: "+5511999994170",
        },
        select: { id: true },
      });
      await suDb.conversation.update({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: CONV_DENIED,
          },
        },
        data: { contactId: contact.id },
      });
      const job = await claimedJob(CONV_DENIED, 9);
      const s = stub([page([{ id: 9, content: "oi" }])]);
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error("a refused contact must not reach the model");
            },
            makeClient: s.makeClient as never,
            checkpointer: new MemorySaver(),
            contactAuthFetch: (async () => {
              await suDb.agent.update({
                where: { id: agentDbId },
                data: { mode: "monitoring" },
              });
              return new Response(JSON.stringify({ authorized: false }), {
                status: 200,
              });
            }) as unknown as typeof fetch,
          },
        });
        expect(out).toEqual({ outcome: "done" });
        expect(s.sent).toEqual([]);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_170)).toEqual([9]);
        expect(await watermarkOf(CONV_DENIED)).toBe(9);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: {
            mode: "production",
            settings: (before.settings as object) ?? {},
          },
        });
      }
    });

    test("a flip inside the flush's model call whose hand-over cannot read the burst leaves it unmarked, and retries the flush", async () => {
      // The turn ran over the burst and stood down; the observer's re-read fails. Marked, the burst
      // would be below the watermark with nothing remembering it (round 9) — and completed, the job
      // would never try again while the next observed message moves the watermark past it (round
      // 17): the flush fails, for the scheduler to retry.
      const job = await claimedJob(CONV_FETCH_FAILS, 3);
      class FlippingModel extends FakeListChatModel {
        override bindTools(): this {
          return this;
        }
        override async _generate(
          ...args: Parameters<FakeListChatModel["_generate"]>
        ): ReturnType<FakeListChatModel["_generate"]> {
          await suDb.agent.update({
            where: { id: agentDbId },
            data: { mode: "monitoring" },
          });
          return super._generate(...args);
        }
      }
      const s = stub([page([{ id: 3, content: "quero cancelar" }])], {
        laterFetchesFail: true,
      });
      try {
        await expect(
          flushDebounceJob({
            job,
            base: appDb,
            deps: {
              makeModel: () =>
                new FlippingModel({ responses: ["Claro, vou ver."] }),
              makeClient: s.makeClient as never,
              checkpointer: new MemorySaver(),
            },
          }),
        ).rejects.toThrow("hand-over failed");
        expect(s.sent).toEqual([]);
        expect(s.calls.getMessages).toBeGreaterThan(1);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_180)).toEqual([]);
        expect(await watermarkOf(CONV_FETCH_FAILS)).toBeNull();
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a human taking the conversation during the authorization call, under a flip, still hands the burst to the observer", async () => {
      // The authorization allows, the conversation is no longer the bot's, and the flush marks the
      // burst on its way out (round 10): under an observer it is remembered too.
      const before = await suDb.agent.findUniqueOrThrow({
        where: { id: agentDbId },
        select: { settings: true },
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          settings: {
            ...((before.settings as object) ?? {}),
            contactAuth: {
              enabled: true,
              url: "https://203.0.113.9:9443/check",
              handoffEnabled: false,
            },
          },
        },
      });
      const contact = await suDb.contact.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootContactId: 94_190,
          phone: "+5511999994190",
        },
        select: { id: true },
      });
      const where = {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: CONV_TAKEN_DURING_AUTH,
        },
      };
      await suDb.conversation.update({
        where,
        data: { contactId: contact.id },
      });
      const job = await claimedJob(CONV_TAKEN_DURING_AUTH, 11);
      const s = stub([page([{ id: 11, content: "oi" }])]);
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error(
                "a conversation a human holds must not reach the model",
              );
            },
            makeClient: s.makeClient as never,
            checkpointer: new MemorySaver(),
            contactAuthFetch: (async () => {
              await suDb.agent.update({
                where: { id: agentDbId },
                data: { mode: "monitoring" },
              });
              await suDb.conversation.update({
                where,
                data: { assigneeType: "User", assigneeId: 5, status: "open" },
              });
              return new Response(JSON.stringify({ authorized: true }), {
                status: 200,
              });
            }) as unknown as typeof fetch,
          },
        });
        expect(out).toEqual({ outcome: "done" });
        expect(s.sent).toEqual([]);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_190)).toEqual([11]);
        expect(await watermarkOf(CONV_TAKEN_DURING_AUTH)).toBe(11);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: {
            mode: "production",
            settings: (before.settings as object) ?? {},
          },
        });
      }
    });

    test("a refused burst whose hand-over cannot read Chatwoot is left unmarked and unsettled, and retries the flush", async () => {
      // The refusal used to mark and settle the burst before asking the observer (round 11); a
      // read that failed is a flush worth retrying (round 17).
      const before = await suDb.agent.findUniqueOrThrow({
        where: { id: agentDbId },
        select: { settings: true },
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          settings: {
            ...((before.settings as object) ?? {}),
            contactAuth: {
              enabled: true,
              url: "https://203.0.113.9:9443/check",
              handoffEnabled: false,
            },
          },
        },
      });
      const contact = await suDb.contact.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootContactId: 94_200,
          phone: "+5511999994200",
        },
        select: { id: true },
      });
      await suDb.conversation.update({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: CONV_DENIED_UNREAD,
          },
        },
        data: { contactId: contact.id },
      });
      const job = await claimedJob(CONV_DENIED_UNREAD, 13);
      // The flush's own fetch never happens on a refusal; the observer's re-read is the first, and
      // it fails.
      const s = stub([], {
        onFirstFetch: async () => {},
        laterFetchesFail: true,
      });
      const failing = {
        ...s,
        makeClient: async () => {
          const c = await s.makeClient();
          return {
            ...c,
            getMessages: async () => {
              s.calls.getMessages += 1;
              throw new Error("chatwoot down");
            },
          } as unknown as ChatwootClient;
        },
      };
      try {
        await expect(
          flushDebounceJob({
            job,
            base: appDb,
            deps: {
              makeModel: () => {
                throw new Error("a refused contact must not reach the model");
              },
              makeClient: failing.makeClient as never,
              checkpointer: new MemorySaver(),
              contactAuthFetch: (async () => {
                await suDb.agent.update({
                  where: { id: agentDbId },
                  data: { mode: "monitoring" },
                });
                return new Response(JSON.stringify({ authorized: false }), {
                  status: 200,
                });
              }) as unknown as typeof fetch,
            },
          }),
        ).rejects.toThrow("hand-over failed");
        expect(s.calls.getMessages).toBeGreaterThanOrEqual(1);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_200)).toEqual([]);
        expect(await watermarkOf(CONV_DENIED_UNREAD)).toBeNull();
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: {
            mode: "production",
            settings: (before.settings as object) ?? {},
          },
        });
      }
    });

    test("a flush whose turn flips and then throws still hands the burst to the observer before rethrowing", async () => {
      // The retry the scheduler owes a failed flush could land after a flip back to production and
      // answer a burst that was watched (round 13).
      const job = await claimedJob(CONV_THROWS, 5);
      class FlipThenThrowModel extends FakeListChatModel {
        override bindTools(): this {
          return this;
        }
        override async _generate(): ReturnType<FakeListChatModel["_generate"]> {
          await suDb.agent.update({
            where: { id: agentDbId },
            data: { mode: "monitoring" },
          });
          throw new Error("provider down");
        }
      }
      const s = stub([page([{ id: 5, content: "e aí?" }])]);
      try {
        await expect(
          flushDebounceJob({
            job,
            base: appDb,
            deps: {
              makeModel: () => new FlipThenThrowModel({ responses: ["nunca"] }),
              makeClient: s.makeClient as never,
              checkpointer: new MemorySaver(),
            },
          }),
        ).rejects.toThrow();
        expect(s.sent).toEqual([]);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_210)).toEqual([5]);
        expect(await watermarkOf(CONV_THROWS)).toBe(5);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a burst whose conversation a human took, under a flip, is handed to the observer at the gate exit", async () => {
      // The gate closes before the mode is read, so the exits after it never see an observer
      // (round 15).
      const job = await claimedJob(CONV_GATE_TAKEN, 15);
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      await suDb.conversation.update({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: CONV_GATE_TAKEN,
          },
        },
        data: { assigneeType: "User", assigneeId: 5, status: "open" },
      });
      const s = stub([page([{ id: 15, content: "alguém aí?" }])]);
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error(
                "a conversation a human holds must not reach the model",
              );
            },
            makeClient: s.makeClient as never,
          },
        });
        expect(out).toEqual({ outcome: "done" });
        expect(s.sent).toEqual([]);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_220)).toEqual([15]);
        expect(await watermarkOf(CONV_GATE_TAKEN)).toBe(15);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("the observed burst's deliveries are settled on the ledger, so the sweep does not re-run them", async () => {
      // A delivery whose process died between arming the job and writing its final status
      // (round 15).
      const job = await claimedJob(CONV_LEDGER, 17);
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `monflush-ledger-${process.pid}`,
          event: "message_created",
          status: "PROCESSING",
          conversationId: CONV_LEDGER,
          inboundMessageId: 17,
        },
        select: { id: true },
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      const s = stub([page([{ id: 17, content: "oi" }])]);
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error("a monitoring agent must not reach the model");
            },
            makeClient: s.makeClient as never,
          },
        });
        expect(out).toEqual({ outcome: "done" });
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_230)).toEqual([17]);
        const after = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: delivery.id },
          select: { status: true },
        });
        expect(after.status).toBe("PROCESSED");
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a burst on a conversation another bot holds is remembered, but its delivery rows are left to that bot", async () => {
      // Chatwoot fans one message out to both routes; the owner's delivery may be in flight
      // (round 16).
      const job = await claimedJob(CONV_OTHER_BOT, 19);
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `monflush-other-bot-${process.pid}`,
          event: "message_created",
          status: "PROCESSING",
          conversationId: CONV_OTHER_BOT,
          inboundMessageId: 19,
          routeAgentBotId: 99,
        },
        select: { id: true },
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      await suDb.conversation.update({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: CONV_OTHER_BOT,
          },
        },
        data: { assigneeType: "AgentBot", assigneeId: 99 },
      });
      const s = stub([page([{ id: 19, content: "oi" }])]);
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error(
                "another bot's conversation must not reach the model",
              );
            },
            makeClient: s.makeClient as never,
          },
        });
        expect(out).toEqual({ outcome: "done" });
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_240)).toEqual([19]);
        const after = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: delivery.id },
          select: { status: true },
        });
        expect(after.status).toBe("PROCESSING");
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a flush that finds the agent observing but cannot read the burst fails, for the scheduler to retry", async () => {
      // The armed burst is the observer's, and nothing else will arm a flush for it (round 17).
      const job = await claimedJob(CONV_OBS_FAILS, 21);
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      const s = stub([], {});
      const failing = {
        makeClient: async () => {
          const c = await s.makeClient();
          return {
            ...c,
            getMessages: async () => {
              s.calls.getMessages += 1;
              throw new Error("chatwoot down");
            },
          } as unknown as ChatwootClient;
        },
      };
      try {
        await expect(
          flushDebounceJob({
            job,
            base: appDb,
            deps: {
              makeModel: () => {
                throw new Error("a monitoring agent must not reach the model");
              },
              makeClient: failing.makeClient as never,
            },
          }),
        ).rejects.toThrow("hand-over failed");
        expect(s.calls.getMessages).toBeGreaterThanOrEqual(1);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_250)).toEqual([]);
        expect(await watermarkOf(CONV_OBS_FAILS)).toBeNull();
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("the walk reads down to the handled watermark, not to a reply a hundred messages back", async () => {
      // The watermark sits just under the armed burst (201, 202) and the agent never replied: read
      // down to the reply, the walk would page to its bound with the whole burst already in hand,
      // return it unread, and a flush after a flip back to production would answer a burst the
      // observer already remembers (review round 18).
      const job = await claimedJob(CONV_HANDLED_FLOOR, 202);
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_HANDLED_FLOOR },
        data: { lastHandledMessageId: 200, lastRepliedMessageId: null },
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      const fullPage = (from: number) =>
        page(
          Array.from({ length: 20 }, (_, i) => ({
            id: from + i,
            content: `msg ${from + i}`,
          })),
        );
      const s = stub([fullPage(183)], {
        before: {
          183: fullPage(163),
          163: fullPage(143),
          143: fullPage(123),
          123: fullPage(103),
        },
      });
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error("a monitoring agent must not reach the model");
            },
            makeClient: s.makeClient as never,
          },
        });
        expect(out).toEqual({ outcome: "done" });
        expect(s.calls.before).toEqual([]);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_260)).toEqual([201, 202]);
        expect(await watermarkOf(CONV_HANDLED_FLOOR)).toBe(202);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("observed traffic that moved the watermark past the burst: the reply is the floor again", async () => {
      // Twenty observed messages after the flip moved the watermark to 49, past the armed burst
      // (1, 2) nothing ever folded in. Above the watermark there is nothing to read; the reply is
      // the one mark those messages did not move (review rounds 6 and 18).
      const job = await claimedJob(CONV_WATERMARK_PAST, 2);
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_WATERMARK_PAST },
        data: { lastHandledMessageId: 49, lastRepliedMessageId: null },
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      const newest = Array.from({ length: 20 }, (_, i) => ({
        id: 30 + i,
        content: `depois ${i}`,
      }));
      const s = stub([page(newest)], {
        before: {
          30: page([
            { id: 1, content: "oi" },
            { id: 2, content: "quero cancelar" },
          ]),
        },
      });
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error("a monitoring agent must not reach the model");
            },
            makeClient: s.makeClient as never,
          },
        });
        expect(out).toEqual({ outcome: "done" });
        expect(s.calls.before).toEqual([30]);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_270)).toEqual([1, 2]);
        expect(await watermarkOf(CONV_WATERMARK_PAST)).toBe(49);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a reply claimed a moment before the watermark caught up is not folded in again", async () => {
      // The claim writes the reply mark (201) before the turn advances the watermark (200): the
      // floor is the higher of the two, so the answered message is not remembered a second time.
      const job = await claimedJob(CONV_REPLY_AHEAD, 203);
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_REPLY_AHEAD },
        data: { lastHandledMessageId: 200, lastRepliedMessageId: 201 },
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      const s = stub([
        page([
          { id: 199, content: "antes" },
          { id: 200, content: "ainda antes" },
          { id: 201, content: "respondida" },
          { id: 202, content: "oi" },
          { id: 203, content: "quero cancelar" },
        ]),
      ]);
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error("a monitoring agent must not reach the model");
            },
            makeClient: s.makeClient as never,
          },
        });
        expect(out).toEqual({ outcome: "done" });
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_280)).toEqual([202, 203]);
        expect(await watermarkOf(CONV_REPLY_AHEAD)).toBe(203);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a gate exit whose agent cannot be read fails the flush, for the scheduler to retry", async () => {
      // The gate closed (a human took the conversation) and the exit asks the agent itself
      // whether it observes. A read that failed, taken for "not observing", would mark the burst
      // handled and complete the job on an answer nobody got (review round 20).
      const job = await claimedJob(CONV_GATE_UNREADABLE, 23);
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      await suDb.conversation.update({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: CONV_GATE_UNREADABLE,
          },
        },
        data: { assigneeType: "User", assigneeId: 5, status: "open" },
      });
      const failing = appDb.$extends({
        query: {
          agent: {
            findUnique({ args, query }) {
              const sel = (args.select ?? {}) as Record<string, unknown>;
              if (sel.mode && sel.settings) {
                throw new Error("injected: agent unreadable");
              }
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const s = stub([page([{ id: 23, content: "alguém aí?" }])]);
      try {
        await expect(
          flushDebounceJob({
            job,
            base: failing,
            deps: {
              makeModel: () => {
                throw new Error(
                  "a conversation a human holds must not reach the model",
                );
              },
              makeClient: s.makeClient as never,
            },
          }),
        ).rejects.toThrow("hand-over failed");
        expect(s.sent).toEqual([]);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_290)).toEqual([]);
        expect(await watermarkOf(CONV_GATE_UNREADABLE)).toBeNull();
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a stand-down whose observer read fails fails the flush, for the scheduler to retry", async () => {
      // The turn stood down at the send fence (flipped inside the model call); the flush then asks
      // whether the agent observes, and that read fails. Taken for "not observing", the burst —
      // already run over, its watermark left where it was — would be nobody's (review round 20).
      const job = await claimedJob(CONV_TURN_UNREADABLE, 3);
      const armed = { on: false, reads: 0 };
      class FlippingModel extends FakeListChatModel {
        override bindTools(): this {
          return this;
        }
        override async _generate(
          ...args: Parameters<FakeListChatModel["_generate"]>
        ): ReturnType<FakeListChatModel["_generate"]> {
          await suDb.agent.update({
            where: { id: agentDbId },
            data: { mode: "monitoring" },
          });
          armed.on = true;
          return super._generate(...args);
        }
      }
      // The first switch-and-mode read after the flip is the send fence's (which stands the turn
      // down); the second is the observer's, and that is the one made to fail.
      const failing = appDb.$extends({
        query: {
          agent: {
            findUnique({ args, query }) {
              const keys = Object.keys(
                (args.select ?? {}) as Record<string, unknown>,
              )
                .sort()
                .join(",");
              if (armed.on && keys === "enabled,mode") {
                armed.reads += 1;
                if (armed.reads === 2) {
                  throw new Error("injected: agent unreadable");
                }
              }
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const s = stub([page([{ id: 3, content: "quero cancelar" }])]);
      try {
        await expect(
          flushDebounceJob({
            job,
            base: failing,
            deps: {
              makeModel: () =>
                new FlippingModel({ responses: ["Claro, vou ver."] }),
              makeClient: s.makeClient as never,
              checkpointer: new MemorySaver(),
            },
          }),
        ).rejects.toThrow("hand-over failed");
        expect(s.sent).toEqual([]);
        expect(armed.reads).toBe(2);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_300)).toEqual([]);
        expect(await watermarkOf(CONV_TURN_UNREADABLE)).toBeNull();
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("the observed burst's hand-over retires the redirect ladder on the widget conversation", async () => {
      // The receiver re-armed the ladder when it dispatched this burst's turn; the turn never ran.
      // Left armed, it waits out the mode and the first flip back to production sends a template
      // to a lead the observer remembers (review round 22).
      const job = await claimedJob(CONV_LADDER_FLIP, 30);
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          mode: "monitoring",
          settings: {
            debounce: { enabled: true, windowSeconds: 15 },
            channelRedirect: {
              enabled: true,
              widgetInboxId: CHATWOOT_INBOX_ID,
              entryInboxId: 80,
              chatFollowupEnabled: true,
            },
          },
        },
      });
      const widgetThreadId = threadOf(CONV_LADDER_FLIP);
      const ladder = await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "REDIRECT_FOLLOWUP",
          dedupeKey: followUpDedupeKey(widgetThreadId),
          status: "PENDING",
          runAt: new Date(Date.now() + 3_600_000),
          payload: {
            stage: "chat",
            widgetThreadId,
            agentId: String(agentDbId),
            entryInboxId: 80,
          },
        },
        select: { id: true },
      });
      const s = stub([page([{ id: 30, content: "voltei" }])]);
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error("a monitoring agent must not reach the model");
            },
            makeClient: s.makeClient as never,
          },
        });
        expect(out).toEqual({ outcome: "done" });
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_310)).toEqual([30]);
        expect(await watermarkOf(CONV_LADDER_FLIP)).toBe(30);
        const after = await suDb.schedulerJob.findUniqueOrThrow({
          where: { id: ladder.id },
          select: { status: true },
        });
        expect(after.status).toBe("DONE");
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: {
            mode: "production",
            settings: { debounce: { enabled: true, windowSeconds: 15 } },
          },
        });
      }
    });

    test("a flip inside the ceiling's own client build posts none of the ceiling's actions", async () => {
      // The ceiling's mode fence used to be asked before the client was built and ownership was
      // probed, two waits of their own; a flip inside them sent the copy anyway (review round 23).
      const before = await suDb.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { settings: true },
      });
      await suDb.tenant.update({
        where: { id: tenantId },
        data: {
          settings: {
            ...((before.settings as object) ?? {}),
            spendCeiling: {
              enabled: true,
              monthlyInboxUsd: 10,
              overCeilingMessage: "Orçamento do mês esgotado.",
            },
          },
        },
      });
      // The month's cost as the poll would have left it (#426): the gate reads the snapshot, not
      // the ledger.
      await suDb.spendCostSnapshot.create({
        data: {
          tenantId,
          source: "inbox",
          monthStart: monthStart(new Date()),
          costUsd: 12,
          polledAt: new Date(),
        },
      });
      const job = await claimedJob(CONV_CEILING_CLIENT, 8);
      const s = stub([page([{ id: 8, content: "oi" }])]);
      // The first build is the burst fetch's; the second is the ceiling copy's own.
      const builds = { n: 0 };
      const makeClient = async () => {
        builds.n += 1;
        if (builds.n === 2) {
          await suDb.agent.update({
            where: { id: agentDbId },
            data: { mode: "monitoring" },
          });
        }
        return s.makeClient();
      };
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error("the model must not be invoked over the ceiling");
            },
            makeClient: makeClient as never,
            checkpointer: new MemorySaver(),
          },
        });
        expect(out).toEqual({ outcome: "done" });
        expect(builds.n).toBeGreaterThanOrEqual(2);
        expect(s.sent).toEqual([]);
        expect(s.toggles).toEqual([]);
        expect(s.notes).toEqual([]);
        const keys = (await ingestJobs()).map((j) => j.dedupeKey);
        expect(ingestedIds(keys, 94_320)).toEqual([8]);
        expect(await watermarkOf(CONV_CEILING_CLIENT)).toBe(8);
      } finally {
        await suDb.spendCostSnapshot.deleteMany({ where: { tenantId } });
        await suDb.tenant.update({
          where: { id: tenantId },
          data: { settings: (before.settings as object) ?? {} },
        });
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a burst the bound leaves out of view, with the watermark already past it, fails the flush", async () => {
      // Observed traffic moved the watermark past the armed burst, so no later flush reads below
      // it; the reply floor is a hundred messages back and the walk stops at its bound with the
      // burst out of view. Completed as "unread", the burst would be gone quietly (review round 23).
      const job = await claimedJob(CONV_PAST_BOUND, 2);
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_PAST_BOUND },
        data: { lastHandledMessageId: 300, lastRepliedMessageId: null },
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      const fullPage = (from: number) =>
        page(
          Array.from({ length: 20 }, (_, i) => ({
            id: from + i,
            content: `depois ${from + i}`,
          })),
        );
      const s = stub([fullPage(281)], {
        before: {
          281: fullPage(261),
          261: fullPage(241),
          241: fullPage(221),
          221: fullPage(201),
        },
      });
      try {
        await expect(
          flushDebounceJob({
            job,
            base: appDb,
            deps: {
              makeModel: () => {
                throw new Error("a monitoring agent must not reach the model");
              },
              makeClient: s.makeClient as never,
            },
          }),
        ).rejects.toThrow("hand-over failed");
        expect(s.calls.before).toEqual([281, 261, 241, 221]);
        expect(await watermarkOf(CONV_PAST_BOUND)).toBe(300);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("control: a switched-off agent's burst waits for the switch, untouched", async () => {
      const before = (await ingestJobs()).length;
      const job = await claimedJob(CONV_DISABLED, 5);
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { enabled: false },
      });
      const s = stub([page([{ id: 5, content: "oi" }])]);
      try {
        const out = await flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error("a disabled agent must not reach the model");
            },
            makeClient: s.makeClient as never,
          },
        });
        expect(out).toEqual({ outcome: "done" });
        expect(s.sent).toEqual([]);
        expect(s.calls.getMessages).toBe(0);
        expect((await ingestJobs()).length).toBe(before);
        expect(await watermarkOf(CONV_DISABLED)).toBeNull();
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { enabled: true },
        });
      }
    });
  },
);
