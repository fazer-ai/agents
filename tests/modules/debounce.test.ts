import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  clearMediaAnnotations,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { flushDebounceJob } from "@/modules/debounce/handler";
import {
  armDebounce,
  debounceDedupeKey,
  resolveDebounceConfig,
} from "@/modules/debounce/service";
import { advanceHandledWatermark } from "@/modules/debounce/watermark";
import type { ClaimedJob } from "@/modules/scheduler/service";
import {
  claimDueDebounceJobs,
  claimDueJobs,
  enqueueJob,
} from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import {
  EmptyThenReplyModel,
  ResolveThenReplyModel,
} from "../utils/scripted-models";

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

function fakeModel() {
  return new FakeListChatModel({ responses: [REPLY] });
}

// Stub client whose getMessages returns a queued sequence (last value repeats) and records posts.
function makeStub(opts: {
  pages: unknown[];
  sent: Array<[number, string]>;
  calls: { getMessages: number };
}) {
  let i = 0;
  const client = {
    getMessages: async () => {
      const page = opts.pages[Math.min(i, opts.pages.length - 1)] ?? {
        payload: [],
      };
      i += 1;
      opts.calls.getMessages += 1;
      return page;
    },
    sendMessage: async (conversationId: number, content: string) => {
      opts.sent.push([conversationId, content]);
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

// makeStub + a toggleStatus recorder, for the resolve-intent tests.
function makeResolveStub(opts: {
  pages: unknown[];
  sent: Array<[number, string]>;
  calls: { getMessages: number };
  toggles: Array<[number, string]>;
}) {
  let i = 0;
  const client = {
    getMessages: async () => {
      const page = opts.pages[Math.min(i, opts.pages.length - 1)] ?? {
        payload: [],
      };
      i += 1;
      opts.calls.getMessages += 1;
      return page;
    },
    sendMessage: async (conversationId: number, content: string) => {
      opts.sent.push([conversationId, content]);
      return {};
    },
    toggleStatus: async (conversationId: number, status: string) => {
      opts.toggles.push([conversationId, status]);
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

function page(
  msgs: Array<{
    id: number;
    content: string;
    type?: number;
    priv?: boolean;
    attachments?: unknown[];
  }>,
) {
  return {
    payload: msgs.map((m) => ({
      id: m.id,
      content: m.content,
      message_type: m.type ?? 0,
      private: m.priv ?? false,
      ...(m.attachments ? { attachments: m.attachments } : {}),
    })),
  };
}

// NOTE: A duck-typed model that records every prompt it sees (same shape as ResolveThenReplyModel).
class CaptureReplyModel {
  seen: string[] = [];
  constructor(private reply: string) {}
  async invoke(messages: Array<{ content: unknown }>) {
    this.seen.push(messages.map((m) => String(m.content)).join("\n"));
    return new AIMessage(this.reply);
  }
  bindTools(_tools: unknown) {
    return {
      invoke: (messages: Array<{ content: unknown }>) => this.invoke(messages),
    };
  }
}

function threadOf(convId: number) {
  return `${tenantId}:${instanceId}:${convId}`;
}

async function seedConversation(
  convId: number,
  over: {
    assigneeType?: string | null;
    lastHandledMessageId?: number | null;
  } = {},
) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: over.assigneeType ?? null,
      inboxId: inboxDbId,
      threadId: threadOf(convId),
      lastEventAt: new Date(),
      lastHandledMessageId: over.lastHandledMessageId ?? null,
    },
  });
}

function jobFor(
  convId: number,
  extra: { lastMessageId?: number } = {},
): ClaimedJob {
  return {
    id: 1n,
    tenantId,
    kind: "DEBOUNCE",
    payload: {
      threadId: threadOf(convId),
      agentBotId: 9,
      burstStartedAt: 1,
      ...(extra.lastMessageId != null
        ? { lastMessageId: extra.lastMessageId }
        : {}),
    },
    attempts: 0,
    claimSeq: 0,
  };
}

async function watermarkOf(convId: number): Promise<number | null> {
  const row = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { lastHandledMessageId: true },
  });
  return row.lastHandledMessageId;
}

describe.skipIf(!dbUp)("debounce", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DBC", slug: `dbc-${process.pid}` },
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
        // Pin split off so the flush asserts a single coalesced send (split is on
        // by default now and has its own test).
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
        webhookRouteTokenHash: `db-route-${process.pid}`,
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

  test("resolveDebounceConfig returns the agent's config (enabled)", async () => {
    const cfg = await resolveDebounceConfig(
      tenantId,
      instanceId,
      CHATWOOT_INBOX_ID,
      appDb,
    );
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.windowSeconds).toBe(15);
  });

  test("resolveDebounceConfig returns null for an unbound inbox", async () => {
    const cfg = await resolveDebounceConfig(tenantId, instanceId, 999, appDb);
    expect(cfg).toBeNull();
  });

  test("the scheduler claim excludes DEBOUNCE; the debounce claim takes only it", async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
    );
    const past = new Date(Date.now() - 60_000);
    await enqueueJob({
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dbc-wr",
      runAt: past,
      base: appDb,
    });
    await armDebounce({
      tenantId,
      threadId: threadOf(700),
      agentBotId: 9,
      cfg: {
        enabled: true,
        windowSeconds: 15,
        maxMessagesPerBurst: 20,
        maxWindowSeconds: 60,
      },
      base: appDb,
      now: past,
    });

    const scheduled = (
      await claimDueJobs(50, appDb, new Date(), tenantId)
    ).filter((j) => j.tenantId === tenantId);
    expect(scheduled.some((j) => j.kind === "WEBHOOK_RETRY")).toBe(true);
    expect(scheduled.some((j) => j.kind === "DEBOUNCE")).toBe(false);

    const debounced = (
      await claimDueDebounceJobs(50, appDb, new Date(), tenantId)
    ).filter((j) => j.tenantId === tenantId);
    expect(debounced.every((j) => j.kind === "DEBOUNCE")).toBe(true);
    expect(debounced.some((j) => j.payload.threadId === threadOf(700))).toBe(
      true,
    );
  });

  test("armDebounce re-arms one row, keeps burst start, and caps at maxWindow", async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
    );
    const thread = threadOf(701);
    const cfg = {
      enabled: true,
      windowSeconds: 15,
      maxMessagesPerBurst: 20,
      maxWindowSeconds: 20,
    };
    const t0 = new Date(Date.now() - 5_000);
    await armDebounce({
      tenantId,
      threadId: thread,
      agentBotId: 9,
      cfg,
      base: appDb,
      now: t0,
    });
    const row1 = await suDb.schedulerJob.findFirstOrThrow({
      where: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(thread),
      },
      select: { id: true, runAt: true, payload: true },
    });
    expect(row1.runAt.getTime()).toBe(t0.getTime() + 15_000);

    // 18s into the burst: window would push to +33s, but maxWindow caps it at +20s; one row, same id.
    const t1 = new Date(t0.getTime() + 18_000);
    await armDebounce({
      tenantId,
      threadId: thread,
      agentBotId: 9,
      cfg,
      base: appDb,
      now: t1,
    });
    const rows = await suDb.schedulerJob.findMany({
      where: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(thread),
      },
      select: { id: true, runAt: true, payload: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(row1.id);
    expect(rows[0]?.runAt.getTime()).toBe(t0.getTime() + 20_000);
    expect(
      (rows[0]?.payload as { burstStartedAt: number } | undefined)
        ?.burstStartedAt,
    ).toBe(t0.getTime());
  });

  test("flush coalesces the burst into one reply and advances the watermark", async () => {
    await seedConversation(800);
    const sent: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const out = await flushDebounceJob({
      job: jobFor(800),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "oi" },
              { id: 2, content: "tudo bem?" },
            ]),
          ],
          sent,
          calls,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([[800, REPLY]]);
    expect(await watermarkOf(800)).toBe(2);
  });

  test("a re-flush with nothing past the watermark posts nothing (idempotent)", async () => {
    // conv 800 watermark is now 2; the same page yields no pending messages.
    const sent: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const out = await flushDebounceJob({
      job: jobFor(800),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "oi" },
              { id: 2, content: "tudo bem?" },
            ]),
          ],
          sent,
          calls,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([]);
    expect(await watermarkOf(800)).toBe(2);
  });

  test("a message arriving mid-turn supersedes the reply (no post, watermark untouched)", async () => {
    await seedConversation(801);
    const sent: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const out = await flushDebounceJob({
      job: jobFor(801),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          // first fetch (burst) → ids 1,2; second fetch (shouldPost) → a newer id 3 arrived.
          pages: [
            page([
              { id: 1, content: "oi" },
              { id: 2, content: "?" },
            ]),
            page([
              { id: 1, content: "oi" },
              { id: 2, content: "?" },
              { id: 3, content: "ainda aí?" },
            ]),
          ],
          sent,
          calls,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([]);
    expect(await watermarkOf(801)).toBeNull();
  });

  test("superseded mid-turn discards the resolve intent (no toggle, watermark untouched)", async () => {
    await seedConversation(810);
    const sent: Array<[number, string]> = [];
    const toggles: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const out = await flushDebounceJob({
      job: jobFor(810),
      base: appDb,
      deps: {
        makeModel: () =>
          new ResolveThenReplyModel("Fechado!") as unknown as BaseChatModel,
        makeClient: makeResolveStub({
          // first fetch (burst) → ids 1,2; second fetch (shouldPost) → a newer id 3 arrived.
          pages: [
            page([
              { id: 1, content: "oi" },
              { id: 2, content: "quero encerrar" },
            ]),
            page([
              { id: 1, content: "oi" },
              { id: 2, content: "quero encerrar" },
              { id: 3, content: "na verdade, mais uma coisa" },
            ]),
          ],
          sent,
          calls,
          toggles,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    // A newer customer message wins: no reply, no resolve, watermark intact so the re-armed
    // flush answers the full burst.
    expect(sent).toEqual([]);
    expect(toggles).toEqual([]);
    expect(await watermarkOf(810)).toBeNull();
  });

  test("empty reply superseded by a mid-turn message leaves the watermark for the re-armed flush", async () => {
    await seedConversation(811);
    const sent: Array<[number, string]> = [];
    const toggles: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const out = await flushDebounceJob({
      job: jobFor(811),
      base: appDb,
      deps: {
        makeModel: () =>
          new ResolveThenReplyModel("") as unknown as BaseChatModel,
        makeClient: makeResolveStub({
          pages: [
            page([
              { id: 1, content: "oi" },
              { id: 2, content: "só isso" },
            ]),
            page([
              { id: 1, content: "oi" },
              { id: 2, content: "só isso" },
              { id: 3, content: "espera, tem mais" },
            ]),
          ],
          sent,
          calls,
          toggles,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([]);
    expect(toggles).toEqual([]);
    // Empty + a newer mid-turn message must NOT advance the watermark: the re-armed flush
    // re-coalesces the whole burst (id 3 included) instead of skipping it.
    expect(await watermarkOf(811)).toBeNull();
  });

  test("a human assignee closes the gate before any Chatwoot fetch", async () => {
    await seedConversation(802, { assigneeType: "User" });
    const sent: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const out = await flushDebounceJob({
      job: jobFor(802),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [page([{ id: 1, content: "oi" }])],
          sent,
          calls,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([]);
    expect(calls.getMessages).toBe(0);
  });

  // ── Issue #8: the watermark must advance on every deliberate skip, not only on a post ──

  test("advanceHandledWatermark is a monotonic CAS (never moves backwards)", async () => {
    await seedConversation(803);
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 803 },
      select: { id: true },
    });
    const advance = (to: number) =>
      advanceHandledWatermark({
        tenantId,
        conversationDbId: conv.id,
        toMessageId: to,
        base: appDb,
      });
    expect(await advance(5)).toBe(true);
    expect(await watermarkOf(803)).toBe(5);
    expect(await advance(3)).toBe(false); // stale writer loses silently
    expect(await watermarkOf(803)).toBe(5);
    expect(await advance(8)).toBe(true);
    expect(await watermarkOf(803)).toBe(8);
  });

  test("an empty reply still advances the watermark (the burst was consumed)", async () => {
    await seedConversation(804);
    const sent: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const out = await flushDebounceJob({
      job: jobFor(804),
      base: appDb,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: [""] }),
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "oi" },
              { id: 2, content: "tem horário amanhã?" },
            ]),
          ],
          sent,
          calls,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([]);
    expect(await watermarkOf(804)).toBe(2);
  });

  test("a human takeover mid-turn advances the watermark (no re-answer after the return)", async () => {
    await seedConversation(805);
    const sent: Array<[number, string]> = [];
    let fetches = 0;
    // The burst fetch runs after the job's own gate (still open) and before the turn; flipping the
    // assignee there lands exactly in the window the post-LLM re-check inspects → "taken-over".
    const client = {
      getMessages: async () => {
        fetches += 1;
        if (fetches === 1) {
          await suDb.conversation.updateMany({
            where: { tenantId, chatwootConversationId: 805 },
            data: { assigneeType: "User", status: "open" },
          });
        }
        return page([{ id: 4, content: "quero falar com um humano AGORA" }]);
      },
      sendMessage: async (conversationId: number, content: string) => {
        sent.push([conversationId, content]);
        return {};
      },
    } as unknown as ChatwootClient;
    const out = await flushDebounceJob({
      job: jobFor(805),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: async () => client,
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([]); // nothing posted — the human owns the reply
    expect(await watermarkOf(805)).toBe(4); // …but the burst counts as handled
  });

  test("a gate-closed flush advances to the payload's lastMessageId without any fetch", async () => {
    await seedConversation(806, { assigneeType: "User" });
    const sent: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const out = await flushDebounceJob({
      job: jobFor(806, { lastMessageId: 12 }),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [page([{ id: 12, content: "oi" }])],
          sent,
          calls,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([]);
    expect(calls.getMessages).toBe(0);
    expect(await watermarkOf(806)).toBe(12);
  });

  test("armDebounce keeps the burst's highest lastMessageId across re-arms", async () => {
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
    const thread = threadOf(702);
    const cfg = {
      enabled: true,
      windowSeconds: 15,
      maxMessagesPerBurst: 20,
      maxWindowSeconds: 60,
    };
    for (const lastMessageId of [3, 5, 4]) {
      await armDebounce({
        tenantId,
        threadId: thread,
        agentBotId: 9,
        cfg,
        lastMessageId,
        base: appDb,
      });
    }
    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(thread),
      },
      select: { payload: true },
    });
    expect((row.payload as { lastMessageId?: number }).lastMessageId).toBe(5);
  });

  test("issue #8 regression: after a handoff-era backlog, the flush answers only the new message", async () => {
    // Watermark at 8 = messages 5-8 arrived while a human owned the conversation (the webhook
    // advance covered them); the human then returned it and the customer sent message 9.
    await seedConversation(807, { lastHandledMessageId: 8 });
    const sent: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const fullHistory = page([
      { id: 4, content: "quero remarcar" },
      { id: 5, content: "isso está um absurdo!" },
      { id: 6, content: "que atendimento péssimo" },
      { id: 7, content: "obrigado pela ajuda" },
      { id: 8, content: "até logo" },
      { id: 9, content: "quero marcar um horário pra sexta" },
    ]);
    const out = await flushDebounceJob({
      job: jobFor(807, { lastMessageId: 9 }),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({ pages: [fullHistory], sent, calls }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([[807, REPLY]]); // one reply, to the new request only
    expect(await watermarkOf(807)).toBe(9);
  });

  // NOTE: Issue #63, the half a retry cannot cover. When both attempts come back empty the turn is
  // lost for good and the operator becomes the fallback, so what lands on the conversation badge has
  // to name the fault. Before this change that row read `undefined is not an object (evaluating
  // '(await this.generatePrompt(…)).generations[0][0].message')` — JS entrails that tell whoever
  // picks up the conversation nothing about what happened or what to do.
  test("issue #63: a provider that never completes leaves the operator a readable reason", async () => {
    await seedConversation(812);
    const sent: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const model = new EmptyThenReplyModel(REPLY, 2);
    await expect(
      flushDebounceJob({
        job: jobFor(812),
        base: appDb,
        deps: {
          makeModel: () => model,
          makeClient: makeStub({
            pages: [page([{ id: 1, content: "oi" }])],
            sent,
            calls,
          }),
          checkpointer: new MemorySaver(),
        },
      }),
    ).rejects.toThrow("no completion");
    expect(model.calls).toBe(2); // the retry ran, and the provider failed it too
    expect(sent).toEqual([]);
    const row = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 812 },
      select: { lastError: true, lastErrorAt: true },
    });
    expect(row.lastError).toContain("no completion");
    expect(row.lastError).not.toContain("generations[0][0]");
    expect(row.lastErrorAt).not.toBeNull();
  });

  test("issue #49: a newer attachment-only message (voice note) supersedes the flush", async () => {
    await seedConversation(832);
    const sent: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const out = await flushDebounceJob({
      job: jobFor(832),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          // NOTE: The mid-turn arrival (id 3) is a voice note: empty content, one attachment.
          pages: [
            page([{ id: 2, content: "oi" }]),
            page([
              { id: 2, content: "oi" },
              {
                id: 3,
                content: "",
                attachments: [
                  {
                    file_type: "audio",
                    data_url: "https://chat.example.com/blobs/voice.oga",
                  },
                ],
              },
            ]),
          ],
          sent,
          calls,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([]);
    expect(await watermarkOf(832)).toBeNull();
  });

  test("issue #49: the flush renders a voice note from the in-process annotation when the meta is empty (upstream Chatwoot)", async () => {
    clearMediaAnnotations();
    await seedConversation(830);
    // NOTE: Upstream Chatwoot: the fork meta route 404s, so the eager pass could only stash in-process.
    stashMediaAnnotation(
      { tenantId, instanceId, messageId: 3 },
      { transcribedText: "olá, quero agendar uma consulta" },
    );
    const sent: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const model = new CaptureReplyModel(REPLY);
    const out = await flushDebounceJob({
      job: jobFor(830),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeStub({
          pages: [
            page([
              {
                id: 3,
                content: "",
                attachments: [
                  {
                    file_type: "audio",
                    data_url: "https://chat.example.com/blobs/voice.oga",
                  },
                ],
              },
            ]),
          ],
          sent,
          calls,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([[830, REPLY]]);
    expect(model.seen[0]).toContain(
      "<mensagem-de-audio>olá, quero agendar uma consulta</mensagem-de-audio>",
    );
    expect(model.seen[0]).not.toContain("não audível");
    expect(await watermarkOf(830)).toBe(3);
  });

  test("issue #49 guard: a transcription already on the attachment meta wins over the stash", async () => {
    clearMediaAnnotations();
    await seedConversation(831);
    stashMediaAnnotation(
      { tenantId, instanceId, messageId: 4 },
      { transcribedText: "cache perdedor" },
    );
    const sent: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const model = new CaptureReplyModel(REPLY);
    const out = await flushDebounceJob({
      job: jobFor(831),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeStub({
          pages: [
            page([
              {
                id: 4,
                content: "",
                attachments: [
                  {
                    file_type: "audio",
                    data_url: "https://chat.example.com/blobs/voice.oga",
                    meta: { transcribed_text: "vim do meta do fork" },
                  },
                ],
              },
            ]),
          ],
          sent,
          calls,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(model.seen[0]).toContain(
      "<mensagem-de-audio>vim do meta do fork</mensagem-de-audio>",
    );
  });
});
