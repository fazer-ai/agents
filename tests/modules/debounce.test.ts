import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId, contactInboxThreadId } from "@/graph/checkpointer";
import type { ResolvedModelConfig } from "@/graph/models";
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
  retireJobsByDedupeKey,
} from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import {
  EmptyThenReplyModel,
  guardrailModel,
  PromptCapturingModel,
  ResolveThenReplyModel,
  SendImageThenReplyModel,
  SideEffectModel,
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
let agentDbId = 0n;
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
    // A split reply toggles the typing indicator around each balloon; without it here the stub is a
    // Chatwoot that cannot be told the agent is typing, and the call throws before its own catch.
    toggleTyping: async () => ({}),
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
    assigneeId?: number | null;
    lastHandledMessageId?: number | null;
    contactInboxId?: number | null;
    status?: string;
  } = {},
) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: over.status ?? "pending",
      assigneeType: over.assigneeType ?? null,
      assigneeId: over.assigneeId ?? null,
      inboxId: inboxDbId,
      threadId: threadOf(convId),
      lastEventAt: new Date(),
      lastHandledMessageId: over.lastHandledMessageId ?? null,
      contactInboxId: over.contactInboxId ?? null,
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

// The single line a correction leaves for the conversation Chatwoot calls `convId`.
//
// Polled and scoped, the two obligations tests/modules/flowlog-reader-scope.test.ts states:
// emitFlowEvent is fire-and-forget, so an unpolled read races the write it asserts and an unscoped
// one answers with a neighbour's row. The count is asserted before the line is read, because a
// second line would mean two corrections raced and `[0]` of that answers with whichever landed
// first instead of failing.
async function convRowId(convId: number) {
  const conv = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { id: true },
  });
  return conv.id;
}

async function correctionLine(convId: number) {
  const conversationId = await convRowId(convId);
  const deadline = Date.now() + 2000;
  let lines: Array<{ level: string; detail: unknown }> = [];
  while (Date.now() < deadline) {
    lines = await suDb.executionLog.findMany({
      where: { tenantId, conversationId, stage: "delivery" },
      select: { level: true, detail: true },
    });
    if (lines.length > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(lines).toHaveLength(1);
  const line = lines[0];
  if (line === undefined) throw new Error("no correction line was written");
  return line;
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
    agentDbId = agent.id;
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
      rearm: "same-work",
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

  // /reset retires the burst, but a flush already CLAIMED is past every cancel — and this one is a
  // queued TURN: coalescing and invoking rewrites the thread the command just cleared, with the
  // operator having been told the conversation was started over. The reply is the smaller half.
  //
  // The assertions are the WRITES, not the reads. An early "did it fetch the messages" check proved
  // only where the fence happened to sit, and it went green for a run that stood down before any of
  // the three things that outlive the command: the thread claim, the invoke that persists the
  // channel, and the watermark that would declare the burst handled.
  test("a burst retired while claimed writes nothing", async () => {
    // With a contact-inbox, so the divider/claim block under the `ingest:` lock runs — that is the
    // first of the two boundaries the fence has to hold, and a conversation without one skips it.
    await seedConversation(838, { contactInboxId: 8380 });
    const thread = threadOf(838);
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(thread),
        status: "CLAIMED",
        runAt: new Date(),
        payload: { threadId: thread, agentBotId: 9, burstStartedAt: 1 },
      },
      select: { id: true, claimSeq: true },
    });
    // What /reset does to it, while this run holds the claim.
    await retireJobsByDedupeKey(
      tenantId,
      "DEBOUNCE",
      debounceDedupeKey(thread),
      suDb,
    );
    const sent: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const saver = new MemorySaver();

    const out = await flushDebounceJob({
      // The payload the worker captured at claim time — before the stamp landed.
      job: { ...jobFor(838), id: row.id, claimSeq: row.claimSeq },
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [page([{ id: 1, content: "oi" }])],
          sent,
          calls,
        }),
        checkpointer: saver,
      },
    });

    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([]);
    // The thread was not claimed, so nothing recreated what the command cleared.
    expect(
      await suDb.agentThread.count({
        where: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: 8380,
        },
      }),
    ).toBe(0);
    // And the burst was not declared handled: it was withdrawn with the thread, not answered.
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 838 },
      select: { lastHandledMessageId: true },
    });
    expect(conv.lastHandledMessageId).toBeNull();
    // The one that outlives the command: nothing was written to the channel the reset cleared.
    expect(
      await saver.getTuple({
        configurable: {
          thread_id: contactInboxThreadId(tenantId, instanceId, 8380),
        },
      }),
    ).toBeUndefined();
  });

  // The same command, on the conversation shape that skips the block above entirely. Without a
  // contact-inbox there is no `ingest:` lock and no thread claim, so the fence inside it never runs
  // — and the invoke that persists the channel is still ahead. One ask per write, not one ask per
  // conversation shape.
  test("a burst retired while claimed writes nothing without a contact-inbox", async () => {
    await seedConversation(839);
    const thread = threadOf(839);
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(thread),
        status: "CLAIMED",
        runAt: new Date(),
        payload: { threadId: thread, agentBotId: 9, burstStartedAt: 1 },
      },
      select: { id: true, claimSeq: true },
    });
    await retireJobsByDedupeKey(
      tenantId,
      "DEBOUNCE",
      debounceDedupeKey(thread),
      suDb,
    );
    const sent: Array<[number, string]> = [];
    const saver = new MemorySaver();

    const out = await flushDebounceJob({
      job: { ...jobFor(839), id: row.id, claimSeq: row.claimSeq },
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [page([{ id: 1, content: "oi" }])],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: saver,
      },
    });

    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([]);
    expect(
      await saver.getTuple({
        configurable: {
          thread_id: chatwootThreadId(tenantId, instanceId, 839),
        },
      }),
    ).toBeUndefined();
  });

  // And the widest window of the three: /reset arriving while the MODEL is running. Both asks above
  // have already answered by then, and the reply is a send the customer reads — into a conversation
  // the operator was told had been started over.
  test("a burst retired during the model call is not answered", async () => {
    await seedConversation(848);
    const thread = threadOf(848);
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(thread),
        status: "CLAIMED",
        runAt: new Date(),
        payload: { threadId: thread, agentBotId: 9, burstStartedAt: 1 },
      },
      select: { id: true, claimSeq: true },
    });
    const sent: Array<[number, string]> = [];
    // The command lands INSIDE the generate call, which is the only way to reach the post gate with
    // the two earlier asks having answered truthfully.
    const retiring = new SideEffectModel(async () => {
      await retireJobsByDedupeKey(
        tenantId,
        "DEBOUNCE",
        debounceDedupeKey(thread),
        suDb,
      );
    });

    const out = await flushDebounceJob({
      job: { ...jobFor(848), id: row.id, claimSeq: row.claimSeq },
      base: appDb,
      deps: {
        makeModel: () => retiring as unknown as BaseChatModel,
        makeClient: makeStub({
          pages: [page([{ id: 1, content: "oi" }])],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });

    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([]);
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 848 },
      select: { lastHandledMessageId: true },
    });
    expect(conv.lastHandledMessageId).toBeNull();
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

  test("a flush retires the ledger row of a message it rescued", async () => {
    // The half of issue #228 that makes the sweep's question answerable, and the reason there is no
    // watermark arithmetic left in the classifier.
    //
    // Message 1's delivery died mid-processing, so its ledger row sits non-terminal with nothing
    // working it. Message 2 arrives and arms a flush, and the flush re-reads the WHOLE thread from
    // Chatwoot rather than the message that armed it — so message 1 is in the burst and does get
    // answered. Nothing about the conversation's watermarks can express that afterwards, but the
    // turn knows it, so it says so on the row.
    const convId = 880;
    await seedConversation(convId);
    const stranded = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `flush-rescue-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        inboundMessageId: 1,
      },
      select: { id: true },
    });
    const sent: Array<[number, string]> = [];
    const out = await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "oi" },
              { id: 2, content: "tem horário?" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([[convId, REPLY]]);

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: stranded.id },
      select: { status: true, processedAt: true },
    });
    expect(row.status).toBe("PROCESSED");
    expect(row.processedAt).not.toBeNull();

    // And QUIETLY. The correction line exists to close an alert that already went out, so an
    // ordinary rescue — a row nobody had reported yet — must not write one, or every burst that
    // happens to cover a strand pages somebody about a problem they never heard of.
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(
      await suDb.executionLog.count({
        where: { tenantId, conversationId: conv.id, stage: "delivery" },
      }),
    ).toBe(0);

    await suDb.chatwootWebhookDelivery.delete({ where: { id: stranded.id } });
  });

  test("the burst CAP takes messages out, and the ledger says so too", async () => {
    // The cap is a deliberate omission: the flush re-read the thread, LOOKED at these messages and
    // answered only the newest N. The watermark advances past the whole burst all the same, so the
    // dropped ones are declared handled by the conversation and would be declared lost by the
    // ledger — and the sweep's whole worth is that a row in its list is a customer nothing reached.
    // Reporting a message the product deliberately dropped is the same lie from the other side.
    const convId = 889;
    await seedConversation(convId);
    const before = await suDb.agent.findUniqueOrThrow({
      where: { id: agentDbId },
      select: { settings: true },
    });
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        settings: {
          ...(before.settings as object),
          debounce: {
            enabled: true,
            windowSeconds: 15,
            maxMessagesPerBurst: 1,
            maxWindowSeconds: 60,
          },
        },
      },
    });
    // Message 1's own delivery died mid-processing. The cap then drops it from the burst this
    // flush answers, so nothing will ever reply to it — deliberately.
    const capped = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `flush-capped-${process.pid}`,
        event: "message_created",
        // DEAD: the sweep already reported this one and an operator is holding the alert. That is
        // what makes the settlement WORD observable — and the reply that went out answered the
        // burst it was GIVEN, never this message, so the correction has to say consumed.
        status: "DEAD",
        receivedAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        inboundMessageId: 1,
      },
      select: { id: true },
    });
    const sent: Array<[number, string]> = [];
    try {
      const out = await flushDebounceJob({
        job: jobFor(convId),
        base: appDb,
        deps: {
          makeModel: fakeModel,
          makeClient: makeStub({
            pages: [
              page([
                { id: 1, content: "oi" },
                { id: 2, content: "tem horário?" },
              ]),
            ],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
        },
      });
      expect(out).toEqual({ outcome: "done" });
      expect(sent).toEqual([[convId, REPLY]]);
      expect(
        (
          await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
            where: { id: capped.id },
            select: { status: true },
          })
        ).status,
      ).toBe("PROCESSED");
      expect((await correctionLine(convId)).detail).toMatchObject({
        outcome: "consumed_late",
      });
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { settings: before.settings as object },
      });
      await suDb.chatwootWebhookDelivery.delete({ where: { id: capped.id } });
      await suDb.executionLog.deleteMany({ where: { tenantId } });
    }
  });

  test("a flush stopped by a closed gate settles the ledger too", async () => {
    // The gate exits decide before any Chatwoot fetch: they advance the watermark from the payload's
    // own lastMessageId and return. A delivery that armed this flush and then died is sitting
    // PROCESSING, and left there it becomes a reported loss for a message the product deliberately
    // declined to answer — a human holds the conversation, and reporting "nobody answered" about it
    // is exactly the wrong thing to page someone with.
    //
    // The exit knows the burst only as "everything up to this id", which is what the watermark it
    // writes says, so the retirement takes the same range. Sound as a WRITE at the moment of the
    // decision, in a way reading a watermark afterwards never was.
    const convId = 886;
    // The watermark already sits at 2: messages 1 and 2 had their fate decided before this flush
    // was ever armed.
    await seedConversation(convId, {
      assigneeType: "User",
      lastHandledMessageId: 2,
    });
    const before = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `flush-gate-before-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        // BELOW the watermark: nothing about this gate exit is a decision about it.
        inboundMessageId: 1,
      },
      select: { id: true },
    });
    const level = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `flush-gate-level-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        // Exactly AT the watermark: the last message the previous decision covered.
        inboundMessageId: 2,
      },
      select: { id: true },
    });
    const stranded = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `flush-gate-exit-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        inboundMessageId: 3,
      },
      select: { id: true },
    });
    const top = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `flush-gate-top-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        // Exactly AT the payload's lastMessageId: the message this very flush was armed for, and
        // the one the exit is deciding about right now. The top bound is inclusive for it.
        inboundMessageId: 5,
      },
      select: { id: true },
    });
    const later = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `flush-gate-beyond-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        // ABOVE the payload's lastMessageId: it arrived after the arm, so this gate exit says
        // nothing about it.
        inboundMessageId: 9,
      },
      select: { id: true },
    });
    const out = await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 5 }),
      base: appDb,
      deps: {
        makeModel: () => {
          throw new Error("the gate must close before any model call");
        },
        makeClient: async () => {
          throw new Error("the gate must close before any Chatwoot fetch");
        },
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: stranded.id },
      select: { status: true },
    });
    expect(row.status).toBe("PROCESSED");
    // And ONLY the burst, bounded at BOTH ends.
    //
    // Above: a message that arrived after the arm is not in the payload, so the gate never decided
    // about it.
    const beyond = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: later.id },
      select: { status: true },
    });
    expect(beyond.status).toBe("PROCESSING");
    // Below: a strand from BEFORE the watermark belongs to an earlier decision, or to none. Left
    // open at the bottom, this exit reaches back over it and closes a real loss for good — message 1
    // strands, message 2 arrives on a human-owned conversation and carries the watermark past both,
    // and then a gated flush for message 5 swallows message 1 without anything ever answering it.
    const earlier = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: before.id },
      select: { status: true },
    });
    expect(earlier.status).toBe("PROCESSING");
    // And the boundary is STRICT: the message sitting exactly AT the watermark is the last one
    // something else already decided, so it belongs to that decision and not to this one.
    const atMark = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: level.id },
      select: { status: true },
    });
    expect(atMark.status).toBe("PROCESSING");
    // The other end is INCLUSIVE, and asymmetrically so on purpose: the lower bound is a decision
    // already made, the upper bound is the decision being made. The message that armed this flush is
    // the one most in need of retiring — excluded, every gated flush leaves behind a reported loss
    // for the exact message it just declined to answer.
    const atTop = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: top.id },
      select: { status: true },
    });
    expect(atTop.status).toBe("PROCESSED");

    await suDb.chatwootWebhookDelivery.deleteMany({
      where: {
        id: { in: [stranded.id, later.id, before.id, level.id, top.id] },
      },
    });
  });

  test("a gate closed by ANOTHER BOT leaves the ledger alone", async () => {
    // The same exit, closed by the one state whose settlement may not widen.
    //
    // Chatwoot fans a message to up to two routes — `agent_bots_for` returns the conversation's
    // assignee bot and the inbox's bot, each with its own delivery id — so a message inside this
    // burst can have a SECOND ledger row belonging to the bot that now owns the conversation, and
    // that row can be `PROCESSING` because its turn is running right now. A range write turns it
    // `PROCESSED`, the one state the sweep never revisits; if that route then dies, the customer it
    // was answering is unanswered with nothing anywhere saying so.
    //
    // The direct webhook path already scopes to its own row here. The flush has no row of its own to
    // scope to, so it retires nothing: the price is a strand of OURS staying in the loss list while
    // another bot answers the customer, which is wrong and visible rather than quiet and wrong.
    //
    // The watermark still advances, and that half is not a detail: it is what keeps a later flush
    // from re-coalescing this burst and answering over the bot that took the conversation.
    const convId = 890;
    await seedConversation(convId, {
      assigneeType: "AgentBot",
      // Not 9, which is the bot this job runs as.
      assigneeId: 77,
      lastHandledMessageId: 2,
    });
    const sibling = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `flush-gate-sibling-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        // Squarely inside the range this exit would otherwise take.
        inboundMessageId: 4,
      },
      select: { id: true },
    });
    const out = await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 5 }),
      base: appDb,
      deps: {
        makeModel: () => {
          throw new Error("the gate must close before any model call");
        },
        makeClient: async () => {
          throw new Error("the gate must close before any Chatwoot fetch");
        },
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: sibling.id },
      select: { status: true },
    });
    expect(row.status).toBe("PROCESSING");
    expect(await watermarkOf(convId)).toBe(5);

    await suDb.chatwootWebhookDelivery.delete({ where: { id: sibling.id } });
  });

  test("an EMPTY turn closes a reported loss the same way: consumed, not answered", async () => {
    // The gate exits are silence by construction, but the flush's own success path is not: it fires
    // for every outcome that consumed the burst, and only "posted" reached the customer. An empty
    // model reply consumed the message and sent nothing, so the correction has to say consumed —
    // otherwise the one caller that CAN tell the difference is the one that reports it wrong.
    const convId = 888;
    await seedConversation(convId);
    const reported = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `empty-corrects-${process.pid}`,
        event: "message_created",
        status: "DEAD",
        processedAt: new Date(Date.now() - 60_000),
        receivedAt: new Date(Date.now() - 120_000),
        conversationId: convId,
        inboundMessageId: 1,
      },
      select: { id: true },
    });
    const sent: Array<[number, string]> = [];
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: [""] }),
        makeClient: makeStub({
          pages: [page([{ id: 1, content: "oi" }])],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(sent).toEqual([]);

    const line = await correctionLine(convId);
    expect((line.detail as Record<string, unknown>).outcome).toBe(
      "consumed_late",
    );

    await suDb.executionLog.deleteMany({
      where: { conversationId: await convRowId(convId) },
    });
    await suDb.chatwootWebhookDelivery.delete({ where: { id: reported.id } });
  });

  test("a gate exit closes a reported loss WITHOUT claiming the customer was answered", async () => {
    // The correction line has to say which thing happened. A gate exit is a deliberate silence by
    // definition — it decides before any model call — so closing a reported loss from one and
    // logging "answered late" would hand an operator a resolution nobody delivered, which is the
    // same class of lie as hiding the loss in the first place.
    const convId = 887;
    await seedConversation(convId, { assigneeType: "User" });
    const reported = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `gate-corrects-${process.pid}`,
        event: "message_created",
        status: "DEAD",
        processedAt: new Date(Date.now() - 60_000),
        receivedAt: new Date(Date.now() - 120_000),
        conversationId: convId,
        inboundMessageId: 3,
      },
      select: { id: true },
    });
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 5 }),
      base: appDb,
      deps: {
        makeModel: () => {
          throw new Error("the gate must close before any model call");
        },
        makeClient: async () => {
          throw new Error("the gate must close before any Chatwoot fetch");
        },
        checkpointer: new MemorySaver(),
      },
    });

    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: reported.id },
          select: { status: true },
        })
      ).status,
    ).toBe("PROCESSED");

    const line = await correctionLine(convId);
    expect((line.detail as Record<string, unknown>).outcome).toBe(
      "consumed_late",
    );

    await suDb.executionLog.deleteMany({
      where: { conversationId: await convRowId(convId) },
    });
    await suDb.chatwootWebhookDelivery.delete({ where: { id: reported.id } });
  });

  test("a flush does not consume a PENDING row it has not been claimed from", async () => {
    // The retirement is a blind write into a state machine somebody else owns, and PENDING is the
    // state where that owner has not arrived yet. The ack is spent before the ledger row is even
    // inserted, so a burst re-read from Chatwoot legitimately contains a message whose own delivery
    // is sitting between its insert and its CAS. Retired there, that delivery's CAS matches nothing
    // and it returns "skipped" — the mirror write never runs, and `lastInboundAt`, the contact and
    // the attribute bags stay behind.
    //
    // So the retirement takes PROCESSING only, and this row must survive a burst that contains it.
    const convId = 885;
    await seedConversation(convId);
    const fresh = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `flush-fresh-pending-${process.pid}`,
        event: "message_created",
        // Inserted a moment ago and not claimed: its own delivery is about to CAS it.
        status: "PENDING",
        conversationId: convId,
        inboundMessageId: 1,
      },
      select: { id: true },
    });
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [page([{ id: 1, content: "oi" }])],
          sent: [],
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: fresh.id },
      select: { status: true },
    });
    expect(row.status).toBe("PENDING");

    await suDb.chatwootWebhookDelivery.delete({ where: { id: fresh.id } });
  });

  test("a flush does not retire a strand on another Chatwoot ACCOUNT", async () => {
    // Display ids and message ids are numbered per Chatwoot account, so one tenant with two
    // connected accounts genuinely has two conversation 884s carrying two message 1s — the mirror
    // says so by keying conversations on [tenant, instance, conversation]. The retirement is a
    // blind-write by those ids, so without the instance in its predicate a burst on one account
    // closes a real loss on the other, and closes it permanently: the row goes terminal and no
    // later sweep pass ever looks at it again.
    const convId = 884;
    await seedConversation(convId);
    const other = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 4242,
      baseUrl: "https://chat.other.example",
      adminToken: encryptJson("ADMIN"),
    });
    const strandedElsewhere = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        // Same tenant, same conversation number, same message number. Different ACCOUNT.
        chatwootInstanceId: other.id,
        deliveryId: `flush-other-instance-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        inboundMessageId: 1,
      },
      select: { id: true },
    });
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [page([{ id: 1, content: "oi" }])],
          sent: [],
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: strandedElsewhere.id },
      select: { status: true },
    });
    expect(row.status).toBe("PROCESSING");

    await suDb.chatwootWebhookDelivery.delete({
      where: { id: strandedElsewhere.id },
    });
  });

  test("a flush leaves a strand the burst did NOT contain alone", async () => {
    // The regression test for the finding that killed the watermark design for good. Message 1's
    // delivery died. Message 2 arrived while the conversation was human-owned, so the webhook
    // advanced the handled watermark past BOTH without answering either. Message 3 then arms a
    // flush, and the burst floor is now the watermark — so the burst is {3} and message 1 is NOT in
    // it. Nothing covered message 1, and its row must stay non-terminal to say so.
    //
    // Every version of this that read a watermark closed this row: the mark ends up past message 1
    // whether it counts skips or only posts, because the burst that posted started ABOVE it.
    const convId = 882;
    await seedConversation(convId);
    await advanceHandledWatermark({
      tenantId,
      conversationDbId: (
        await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: convId },
          select: { id: true },
        })
      ).id,
      toMessageId: 2,
      base: appDb,
    });
    const stranded = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `flush-excluded-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        inboundMessageId: 1,
      },
      select: { id: true },
    });
    const sent: Array<[number, string]> = [];
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 3 }),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "oi" },
              { id: 2, content: "alguém aí?" },
              { id: 3, content: "por favor" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    // The reply went out, for message 3 alone.
    expect(sent).toEqual([[convId, REPLY]]);
    // And message 1 is still on the books as unanswered, which is the whole point.
    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: stranded.id },
      select: { status: true },
    });
    expect(row.status).toBe("PROCESSING");

    await suDb.chatwootWebhookDelivery.delete({ where: { id: stranded.id } });
  });

  test("a flush CORRECTS a row already reported as a loss, and says so", async () => {
    // An earlier round of this PR asserted the opposite, and had confused the RECORD with the
    // WORKLIST. The record is the flow line, written once and never rewritten; `WHERE status =
    // 'DEAD'` is the worklist, and it answers "who is still unanswered". A turn that ran over the
    // message is direct evidence against a verdict the sweep reached by INFERENCE — nothing has
    // moved this row — so the evidence wins and the row leaves the worklist.
    //
    // It happens two ways: the sweep firing in the sliver between a turn posting and the retirement,
    // and a long-reported message finally answered by a burst that reached back past it. In both the
    // customer has a reply, and leaving the row in the list sends an operator to a conversation
    // where there is nothing to do.
    //
    // Nothing is erased. The loss line stays, and a second line joins it saying how it ended —
    // without that, the row would simply vanish from the list while the alert an operator already
    // received stands with nothing to close it.
    const convId = 883;
    await seedConversation(convId);
    const reported = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `flush-already-dead-${process.pid}`,
        event: "message_created",
        status: "DEAD",
        processedAt: new Date(Date.now() - 60_000),
        receivedAt: new Date(Date.now() - 120_000),
        conversationId: convId,
        inboundMessageId: 1,
      },
      select: { id: true },
    });
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [page([{ id: 1, content: "oi" }])],
          sent: [],
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: reported.id },
      select: { status: true },
    });
    expect(row.status).toBe("PROCESSED");

    // And the correction is on the record, at warn rather than error: something did go wrong, and
    // it ended with the customer answered.
    const line = await correctionLine(convId);
    expect(line.level).toBe("warn");
    expect((line.detail as Record<string, unknown>).outcome).toBe(
      "answered_late",
    );

    await suDb.executionLog.deleteMany({
      where: { conversationId: await convRowId(convId) },
    });
    await suDb.chatwootWebhookDelivery.delete({ where: { id: reported.id } });
  });

  test("a flush leaves a stranded row on ANOTHER conversation alone", async () => {
    // The retirement is scoped by conversation as well as by message id, and a Chatwoot message id
    // is unique per account rather than per conversation — but the ids in a test fixture are not, and
    // neither are they across instances. Without the conversation in the WHERE, a burst would retire
    // a neighbour's strand and hide a real loss.
    const convId = 881;
    await seedConversation(convId);
    const other = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `flush-neighbour-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        // A DIFFERENT conversation, carrying a message id the burst below also contains.
        conversationId: 9_999,
        inboundMessageId: 1,
      },
      select: { id: true },
    });
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [page([{ id: 1, content: "oi" }])],
          sent: [],
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: other.id },
      select: { status: true },
    });
    expect(row.status).toBe("PROCESSING");

    await suDb.chatwootWebhookDelivery.delete({ where: { id: other.id } });
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

  // The write AFTER the send, and the one the outcome must not follow. /reset landing while the
  // reply is going out cannot un-send it — but the deferred resolve is a separate write, and closing
  // a conversation the operator has just cleared and handed back to the agent is the attendance
  // ended. So the resolve is skipped and the turn still reports what it delivered: a "stale" here
  // would leave the watermark behind and hand the burst to a flush that answers it twice.
  test("a reset landing on the reply keeps the reply and drops the resolve", async () => {
    await seedConversation(849);
    const thread = threadOf(849);
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(thread),
        status: "CLAIMED",
        runAt: new Date(),
        payload: { threadId: thread, agentBotId: 9, burstStartedAt: 1 },
      },
      select: { id: true, claimSeq: true },
    });
    const sent: Array<[number, string]> = [];
    const toggles: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const makeClient = makeResolveStub({
      pages: [page([{ id: 1, content: "oi" }])],
      sent,
      calls,
      toggles,
    });
    // The command lands ON the send: everything before it answered truthfully, and the resolve is
    // the only write still ahead.
    const client = await makeClient();
    const holder = client as unknown as Record<
      string,
      (...a: never[]) => unknown
    >;
    const innerSend = holder.sendMessage?.bind(client);
    holder.sendMessage = (async (...args: never[]) => {
      await retireJobsByDedupeKey(
        tenantId,
        "DEBOUNCE",
        debounceDedupeKey(thread),
        suDb,
      );
      return innerSend?.(...args);
    }) as (...a: never[]) => unknown;

    const out = await flushDebounceJob({
      job: { ...jobFor(849), id: row.id, claimSeq: row.claimSeq },
      base: appDb,
      deps: {
        makeModel: () =>
          new ResolveThenReplyModel("Fechado!") as unknown as BaseChatModel,
        makeClient: async () => client,
        checkpointer: new MemorySaver(),
      },
    });

    expect(out).toEqual({ outcome: "done" });
    // The reply reached the customer — it was already leaving when the command landed.
    expect(sent).toEqual([[849, "Fechado!"]]);
    // The close did not.
    expect(toggles).toEqual([]);
  });

  // The typing pause, which is the wait NO other fence covers: it sits between the per-balloon ask
  // and the send it guards, inside `deliverReply`. A reset landing there leaves the loop with zero
  // balloons delivered, and zero is not a delivery.
  //
  // The watermark is NOT what separates the two readings here — `shouldPost` claims the burst as its
  // CAS well before this, so it has already moved either way. What separates them is the word: a
  // turn reported as "posted" clears the conversation's error, announcing to the operator that the
  // agent answered, when nothing left.
  test("a reset landing in the typing pause leaves the burst unanswered", async () => {
    const before = await suDb.agent.findUniqueOrThrow({
      where: { id: agentDbId },
      select: { settings: true },
    });
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        settings: { ...(before.settings as object), split: { enabled: true } },
      },
    });
    try {
      await seedConversation(863);
      // A failure the operator is looking at. Only a delivered turn is allowed to take it away.
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: 863 },
        data: { lastError: "boom", lastErrorAt: new Date() },
      });
      const thread = threadOf(863);
      const row = await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "DEBOUNCE",
          dedupeKey: debounceDedupeKey(thread),
          status: "CLAIMED",
          runAt: new Date(),
          payload: { threadId: thread, agentBotId: 9, burstStartedAt: 1 },
        },
        select: { id: true, claimSeq: true },
      });
      const sent: Array<[number, string]> = [];

      const out = await flushDebounceJob({
        job: { ...jobFor(863), id: row.id, claimSeq: row.claimSeq },
        base: appDb,
        deps: {
          makeModel: () =>
            new FakeListChatModel({
              responses: ["Olá!\n\nComo vai?"],
            }) as unknown as BaseChatModel,
          makeClient: makeStub({
            pages: [page([{ id: 1, content: "oi" }])],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
          // The command commits during the pause before the FIRST balloon.
          sleep: async () => {
            await retireJobsByDedupeKey(
              tenantId,
              "DEBOUNCE",
              debounceDedupeKey(thread),
              suDb,
            );
          },
        },
      });

      expect(out).toEqual({ outcome: "done" });
      expect(sent).toEqual([]);
      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 863 },
        select: { lastError: true },
      });
      expect(conv.lastError).toBe("boom");
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { settings: before.settings as object },
      });
    }
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

  // NOTE: Our bot is 9 (the job payload's agentBotId, and the ChatwootAgentBot row); 77 is another
  // bot on the same account. The burst was armed while the conversation was still free and an
  // automation handed it away before the window closed, so the flush is the last place that can
  // notice.
  test("another bot took the conversation: the flush gate closes before any Chatwoot fetch", async () => {
    await seedConversation(850, { assigneeType: "AgentBot", assigneeId: 77 });
    const sent: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    const out = await flushDebounceJob({
      job: jobFor(850),
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

  // The bail that must not preempt the gate. Reading the inbox before the gate is what lets a closed
  // gate name its agent, and moving the "no agent bound" exit up with it would silently change what
  // the gate DOES: the burst would stop counting as handled, sit below the watermark, and be
  // re-coalesced and answered after a later rebind. Attribution is worth a nullable id; it is not
  // worth that.
  test("a closed gate on an unbound inbox still consumes the burst", async () => {
    await seedConversation(873, { assigneeType: "User" });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7301,
        name: "Sem agente",
        agentId: null,
      },
      select: { id: true },
    });
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: 873 },
      data: { inboxId: inbox.id },
    });
    const out = await flushDebounceJob({
      job: jobFor(873, { lastMessageId: 21 }),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [page([{ id: 21, content: "oi" }])],
          sent: [],
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(await watermarkOf(873)).toBe(21);
  });

  // A gate that closes has to SAY why it closed, and this one said nothing at all: the burst counted
  // as handled and the flush returned, so the operator investigating an unanswered conversation
  // found no line anywhere (issue #271). The two cases below are the two events that wear this one
  // exit, and the second is the one the ack escalation produces — the case the distinction exists
  // for, and the one that never reaches the recheck that could already name it, because no turn
  // ever starts.
  //
  // Scoped to the conversation asked for, by its INTERNAL id, and polled: the emit is
  // fire-and-forget, so an unscoped read answers with a neighbour's row and an unpolled one races
  // the write it is asserting.
  async function handoffDetailOf(convId: number): Promise<unknown> {
    const conversation = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    for (let i = 0; i < 40; i++) {
      const row = await suDb.executionLog.findFirst({
        where: { tenantId, stage: "handoff", conversationId: conversation.id },
        orderBy: { id: "desc" },
      });
      if (row) return row.detail;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  async function routeRowOf(convId: number) {
    const conversation = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    for (let i = 0; i < 40; i++) {
      const row = await suDb.executionLog.findFirst({
        where: { tenantId, stage: "route", conversationId: conversation.id },
        orderBy: { id: "desc" },
      });
      if (row) return row;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  // The OTHER unbound-inbox exit, and the one nothing recorded: the gate is OPEN, so this burst is
  // the bot's to answer and there is simply no agent to answer it. It ended as a silent `done`
  // (issue #318), which from the operator's side is indistinguishable from an agent that is quiet.
  test("an unbound inbox with the gate open leaves the line that names the inbox", async () => {
    await seedConversation(874);
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7302,
        name: "Recem-conectada",
        agentId: null,
      },
      select: { id: true },
    });
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: 874 },
      data: { inboxId: inbox.id },
    });
    const sent: Array<[number, string]> = [];
    const out = await flushDebounceJob({
      job: jobFor(874, { lastMessageId: 31 }),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [page([{ id: 31, content: "oi" }])],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([]);
    const row = await routeRowOf(874);
    expect(row?.level).toBe("warn");
    expect(row?.status).toBe("skipped");
    expect(row?.agentId).toBeNull();
    expect(row?.inboxId).toBe(inbox.id);
    expect(row?.detail).toEqual({ outcome: "no_agent", chatwootInboxId: 7302 });
    // The burst is NOT consumed: an open gate on an inbox that gets bound later has to answer it,
    // which is exactly what the bail's position below the gate buys. The line does not change that.
    expect(await watermarkOf(874)).toBeNull();
  });

  test("a gate closed by a human writes the handoff line that names the takeover", async () => {
    await seedConversation(870, { assigneeType: "User" });
    const out = await flushDebounceJob({
      job: jobFor(870),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [page([{ id: 1, content: "oi" }])],
          sent: [],
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(await handoffDetailOf(870)).toEqual({ outcome: "taken_over" });
  });

  // The ack escalation, as the flush meets it: Chatwoot moved the conversation out of `pending`
  // with nobody on the other side, seconds after a slow ack, and the flush that fires next is the
  // last place that can report it.
  test("a gate closed by the escalation names the status that closed it", async () => {
    await seedConversation(871, { status: "open" });
    const out = await flushDebounceJob({
      job: jobFor(871),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [page([{ id: 1, content: "oi" }])],
          sent: [],
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(await handoffDetailOf(871)).toEqual({
      outcome: "ownership_lost",
      status: "open",
    });
  });

  // NOTE: The same seat held by OUR bot: assignment to ourselves is the normal steady state once
  // the agent has taken a conversation, so closing the gate on it would silence every burst.
  test("our own bot holding the conversation does not close the flush gate", async () => {
    await seedConversation(851, { assigneeType: "AgentBot", assigneeId: 9 });
    const sent: Array<[number, string]> = [];
    const calls = { getMessages: 0 };
    await flushDebounceJob({
      job: jobFor(851),
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
    expect(calls.getMessages).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
  });

  // The webhook checks every incoming message, but a turn is not a message: one allowed message can
  // arm a flush that a later, refused message rides into, and a verdict revoked inside the window is
  // the same hole from the other side. The check belongs where a turn begins, so it runs here too.
  describe("with the contact-authorization gate on", () => {
    let previousSettings: unknown = null;

    beforeAll(async () => {
      const before = await suDb.agent.findUniqueOrThrow({
        where: { id: agentDbId },
        select: { settings: true },
      });
      previousSettings = before.settings;
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          settings: {
            ...(before.settings as object),
            contactAuth: {
              enabled: true,
              url: "https://203.0.113.9:9443/check",
            },
          },
        },
      });
    });

    afterAll(async () => {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { settings: previousSettings as object },
      });
    });

    async function seedContactOn(convId: number, chatwootContactId: number) {
      const contact = await suDb.contact.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootContactId,
          phone: `+5511955550${chatwootContactId}`,
        },
        select: { id: true },
      });
      await suDb.conversation.update({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: convId,
          },
        },
        data: { contactId: contact.id },
      });
    }

    const answering = (authorized: boolean, calls: { n: number }) =>
      (async () => {
        calls.n += 1;
        return new Response(JSON.stringify({ authorized }), { status: 200 });
      }) as unknown as typeof fetch;

    // The flush asks the endpoint again at the point the turn begins, so the facts it volunteers are
    // as fresh as the verdict that allowed the burst. Asserted on the prompt the model received:
    // the block is built elsewhere and this is the only thing that proves this path wires it.
    test("an allowed contact's facts reach the model of the coalesced turn", async () => {
      await seedConversation(844);
      await seedContactOn(844, 65);
      const sent: Array<[number, string]> = [];
      const calls = { getMessages: 0 };
      const model = new PromptCapturingModel("Claro!");
      const out = await flushDebounceJob({
        job: jobFor(844, { lastMessageId: 9 }),
        base: appDb,
        deps: {
          makeModel: () => model,
          makeClient: makeStub({
            pages: [page([{ id: 9, content: "oi" }])],
            sent,
            calls,
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: (async () =>
            new Response(
              JSON.stringify({
                authorized: true,
                context: { plan: "premium" },
              }),
              { status: 200 },
            )) as unknown as typeof fetch,
        },
      });
      expect(out).toEqual({ outcome: "done" });
      expect(sent).toEqual([[844, "Claro!"]]);
      expect(model.systemPrompts[0] ?? "").toContain(
        '<campo chave="plan" valor="premium"/>',
      );
    });

    // The escalation lands INSIDE the authorization round-trip, which is what that fence exists for:
    // ten seconds in somebody else's endpoint. The old line here asserted a human takeover, which is
    // the reading #225 measured as wrong, and this is the state that proves it — nobody is on the
    // conversation at all.
    test("the conversation leaving mid-authorization is reported as what it was", async () => {
      await seedConversation(872);
      await seedContactOn(872, 72);
      const sent: Array<[number, string]> = [];
      const out = await flushDebounceJob({
        job: jobFor(872, { lastMessageId: 11 }),
        base: appDb,
        deps: {
          makeModel: fakeModel,
          makeClient: makeStub({
            pages: [page([{ id: 11, content: "oi" }])],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: (async () => {
            await suDb.conversation.updateMany({
              where: {
                tenantId,
                chatwootInstanceId: instanceId,
                chatwootConversationId: 872,
              },
              data: { status: "open" },
            });
            return new Response(JSON.stringify({ authorized: true }), {
              status: 200,
            });
          }) as unknown as typeof fetch,
        },
      });
      expect(out).toEqual({ outcome: "done" });
      expect(sent).toEqual([]);
      expect(await handoffDetailOf(872)).toEqual({
        outcome: "ownership_lost",
        status: "open",
      });
    });

    test("a refused contact drops the burst: no fetch, no post, watermark advanced", async () => {
      await seedConversation(840);
      await seedContactOn(840, 61);
      const sent: Array<[number, string]> = [];
      const calls = { getMessages: 0 };
      const auth = { n: 0 };
      const out = await flushDebounceJob({
        job: jobFor(840, { lastMessageId: 7 }),
        base: appDb,
        deps: {
          makeModel: fakeModel,
          makeClient: makeStub({
            pages: [page([{ id: 7, content: "oi" }])],
            sent,
            calls,
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: answering(false, auth),
        },
      });
      expect(out).toEqual({ outcome: "done" });
      expect(auth.n).toBe(1);
      expect(sent).toEqual([]);
      // Asked before any Chatwoot work, and the burst still counts as handled so the job does not
      // come back for the same messages.
      expect(calls.getMessages).toBe(0);
      expect(await watermarkOf(840)).toBe(7);
    });

    test("a refused contact settles the ledger by RANGE: the conversation is still ours", async () => {
      // The third gate exit, and the one that keeps the wide scope. The other two close because
      // somebody else owns the conversation; this one closes because of a decision about the
      // CONTACT, taken while this route still owns it — so there is no sibling delivery racing it,
      // and a strand inside the burst is one this exit is entitled to close.
      //
      // Scoped down to nothing here, every refused burst would leave behind a reported loss for a
      // message the product deliberately declined to answer, which is the silence issue #228 exists
      // to remove.
      await seedConversation(846);
      await seedContactOn(846, 67);
      const stranded = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `auth-refused-strand-${process.pid}`,
          event: "message_created",
          status: "PROCESSING",
          receivedAt: new Date(Date.now() - 60_000),
          claimedAt: new Date(Date.now() - 60_000),
          conversationId: 846,
          inboundMessageId: 4,
        },
        select: { id: true },
      });
      const out = await flushDebounceJob({
        job: jobFor(846, { lastMessageId: 7 }),
        base: appDb,
        deps: {
          makeModel: fakeModel,
          makeClient: makeStub({
            pages: [page([{ id: 7, content: "oi" }])],
            sent: [],
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: answering(false, { n: 0 }),
        },
      });
      expect(out).toEqual({ outcome: "done" });
      expect(
        (
          await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
            where: { id: stranded.id },
            select: { status: true },
          })
        ).status,
      ).toBe("PROCESSED");

      await suDb.chatwootWebhookDelivery.delete({ where: { id: stranded.id } });
    });

    // The authorization call is a round-trip to somebody else's endpoint with a ten-second ceiling.
    // A message arriving and being REFUSED during it has already had the watermark advanced past it
    // by its own delivery, so the burst must be chosen against the watermark as it stands THEN, not
    // as it was when the flush started. Against the stale value the refused message would reach the
    // model, and the post gate would only withhold the reply, after the tools had run.
    test("a refusal landing during the check keeps its message out of the burst", async () => {
      await seedConversation(842);
      await seedContactOn(842, 63);
      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 842 },
        select: { id: true },
      });
      const sent: Array<[number, string]> = [];
      // What the defect is about is the MODEL running, not the reply going out: the post gate's CAS
      // already withholds a reply whose watermark moved, which is why asserting on `sent` alone
      // passes with the fix reverted. Counting the model is what separates "did not answer" from
      // "never ran", and a turn that ran spent tokens and may have called side-effecting tools.
      let modelBuilds = 0;
      const countingModel = () => {
        modelBuilds += 1;
        return fakeModel();
      };
      // The concurrent refusal, played out while this flush is asking the endpoint: message 9 is
      // refused by its own delivery, which advances the watermark over it.
      const fetchImpl = (async () => {
        await advanceHandledWatermark({
          tenantId,
          conversationDbId: conv.id,
          toMessageId: 9,
          base: appDb,
        });
        return new Response('{"authorized":true}', { status: 200 });
      }) as unknown as typeof fetch;
      const out = await flushDebounceJob({
        job: jobFor(842),
        base: appDb,
        deps: {
          makeModel: countingModel,
          makeClient: makeStub({
            pages: [page([{ id: 9, content: "e esse aqui?" }])],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: fetchImpl,
        },
      });
      // Nothing left to answer: the only message in the page is already past the watermark.
      expect(out).toEqual({ outcome: "done" });
      expect(modelBuilds).toBe(0);
      expect(sent).toEqual([]);
    });

    test("an authorized contact flushes as usual", async () => {
      await seedConversation(841);
      await seedContactOn(841, 62);
      const sent: Array<[number, string]> = [];
      const auth = { n: 0 };
      const out = await flushDebounceJob({
        job: jobFor(841),
        base: appDb,
        deps: {
          makeModel: fakeModel,
          makeClient: makeStub({
            pages: [page([{ id: 1, content: "oi" }])],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: answering(true, auth),
        },
      });
      expect(out).toEqual({ outcome: "done" });
      expect(auth.n).toBe(1);
      expect(sent).toEqual([[841, REPLY]]);
    });

    // The window the gate opens: the assignee gate runs before a round-trip that can take ten
    // seconds, so a human arriving inside it used to get the burst answered over their shoulder.
    // The post gate withholds the reply, but by then the turn's tools have run.
    test("a human taking over during the authorization call ends the flush before the model", async () => {
      await seedConversation(843);
      await seedContactOn(843, 64);
      // A strand inside the burst, to pin WHICH settlement a human takeover takes. A human answers
      // the message whichever route carried it, so this exit keeps the wide range — the narrow
      // scoping below is for another BOT and for nothing else.
      const stranded = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `auth-human-strand-${process.pid}`,
          event: "message_created",
          status: "PROCESSING",
          receivedAt: new Date(Date.now() - 60_000),
          claimedAt: new Date(Date.now() - 60_000),
          conversationId: 843,
          inboundMessageId: 4,
        },
        select: { id: true },
      });
      const sent: Array<[number, string]> = [];
      const calls = { getMessages: 0 };
      let modelBuilds = 0;
      const takeOverThenAllow = (async () => {
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: 843 },
          data: { assigneeType: "User", status: "open" },
        });
        return new Response(JSON.stringify({ authorized: true }), {
          status: 200,
        });
      }) as unknown as typeof fetch;
      const out = await flushDebounceJob({
        job: jobFor(843, { lastMessageId: 9 }),
        base: appDb,
        deps: {
          makeModel: () => {
            modelBuilds += 1;
            return fakeModel();
          },
          makeClient: makeStub({
            pages: [page([{ id: 1, content: "oi" }])],
            sent,
            calls,
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: takeOverThenAllow,
        },
      });
      expect(out).toEqual({ outcome: "done" });
      expect(modelBuilds).toBe(0);
      expect(sent).toEqual([]);
      // Handled all the same: the human owns the burst now, so the next flush after they hand the
      // conversation back must not re-answer it. Same rule as a gate that was already closed.
      expect(await watermarkOf(843)).toBe(9);
      expect(
        (
          await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
            where: { id: stranded.id },
            select: { status: true },
          })
        ).status,
      ).toBe("PROCESSED");

      await suDb.chatwootWebhookDelivery.delete({ where: { id: stranded.id } });
    });

    test("ANOTHER BOT taking over during the authorization call leaves the ledger alone", async () => {
      // The same window, closed by the other kind of owner, and the settlement differs because the
      // two owners mean different things. A human answers the message whichever route carried it;
      // another BOT has a delivery of its own that may be running right now, and Chatwoot fans a
      // message to up to two routes (`agent_bots_for`). Retiring by range here turns that live row
      // `PROCESSED`, the one state the sweep never revisits.
      //
      // This exit is the second place the rule has to hold, and it is not reachable from the first:
      // the gate on the way in passed, and the conversation moved during a ten-second round-trip to
      // somebody else's endpoint.
      await seedConversation(845);
      await seedContactOn(845, 66);
      const sibling = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `auth-recheck-sibling-${process.pid}`,
          event: "message_created",
          status: "PROCESSING",
          receivedAt: new Date(Date.now() - 60_000),
          claimedAt: new Date(Date.now() - 60_000),
          conversationId: 845,
          inboundMessageId: 4,
        },
        select: { id: true },
      });
      const sent: Array<[number, string]> = [];
      let modelBuilds = 0;
      const botTakesOverThenAllow = (async () => {
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: 845 },
          // Still `pending`, and assigned to a bot that is not the 9 this job runs as: the state
          // `describeClosedGate` calls `ownership_lost` rather than `taken_over`.
          data: { assigneeType: "AgentBot", assigneeId: 77 },
        });
        return new Response(JSON.stringify({ authorized: true }), {
          status: 200,
        });
      }) as unknown as typeof fetch;
      const out = await flushDebounceJob({
        job: jobFor(845, { lastMessageId: 9 }),
        base: appDb,
        deps: {
          makeModel: () => {
            modelBuilds += 1;
            return fakeModel();
          },
          makeClient: makeStub({
            pages: [page([{ id: 1, content: "oi" }])],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: botTakesOverThenAllow,
        },
      });
      expect(out).toEqual({ outcome: "done" });
      expect(modelBuilds).toBe(0);
      expect(sent).toEqual([]);
      // Untouched, and the watermark still advances so a later flush cannot answer over the bot
      // that took the conversation.
      expect(
        (
          await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
            where: { id: sibling.id },
            select: { status: true },
          })
        ).status,
      ).toBe("PROCESSING");
      expect(await watermarkOf(845)).toBe(9);

      await suDb.chatwootWebhookDelivery.delete({ where: { id: sibling.id } });
    });
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

  // Issue #339. The DEBOUNCE dedupeKey is the THREAD, so one physical row serves every burst this
  // contact ever sends. A flush that dead-lettered (five consecutive failures) left the row carrying
  // five attempts, and the re-arm only ever wrote status/run_at/payload, so the NEXT burst, days
  // later, got exactly one attempt before being retired again, forever.
  //
  // A fresh burst is not a guess here: it is the same thing `burstStartedAt` already keys off, a row
  // that is not PENDING, and both are asserted so the two cannot drift apart.
  test("a burst after a dead-lettered flush starts with the whole budget", async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
    );
    const thread = threadOf(702);
    const cfg = {
      enabled: true,
      windowSeconds: 15,
      maxMessagesPerBurst: 20,
      maxWindowSeconds: 60,
    };
    const t0 = new Date(Date.now() - 600_000);
    await armDebounce({
      tenantId,
      threadId: thread,
      agentBotId: 9,
      cfg,
      base: appDb,
      now: t0,
    });
    const armed = await suDb.schedulerJob.findFirstOrThrow({
      where: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(thread),
      },
      select: { id: true },
    });
    await suDb.schedulerJob.update({
      where: { id: armed.id },
      data: { attempts: 5, status: "DEAD" },
    });

    const t1 = new Date(t0.getTime() + 300_000);
    await armDebounce({
      tenantId,
      threadId: thread,
      agentBotId: 9,
      cfg,
      base: appDb,
      now: t1,
    });
    const row = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: armed.id },
      select: { status: true, attempts: true, payload: true },
    });
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect((row.payload as { burstStartedAt: number }).burstStartedAt).toBe(
      t1.getTime(),
    );
  });

  // The control for the test above, and the reason the answer is not just "always clear it": while a
  // burst is still open, a re-arm is the SAME flush being pushed out by another message. A flush that
  // failed and is waiting on its backoff must not be handed five more attempts by every message the
  // contact types.
  test("re-arming inside a burst keeps the attempts that burst has spent", async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
    );
    const thread = threadOf(703);
    const cfg = {
      enabled: true,
      windowSeconds: 15,
      maxMessagesPerBurst: 20,
      maxWindowSeconds: 60,
    };
    const t0 = new Date(Date.now() - 10_000);
    await armDebounce({
      tenantId,
      threadId: thread,
      agentBotId: 9,
      cfg,
      base: appDb,
      now: t0,
    });
    const armed = await suDb.schedulerJob.findFirstOrThrow({
      where: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(thread),
      },
      select: { id: true },
    });
    // The flush failed twice: failJob re-pends with a backoff, so the row is PENDING and the burst
    // is still the same one.
    await suDb.schedulerJob.update({
      where: { id: armed.id },
      data: { attempts: 2 },
    });
    await armDebounce({
      tenantId,
      threadId: thread,
      agentBotId: 9,
      cfg,
      base: appDb,
      now: new Date(t0.getTime() + 5_000),
    });
    const row = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: armed.id },
      select: { attempts: true, payload: true },
    });
    expect(row.attempts).toBe(2);
    expect((row.payload as { burstStartedAt: number }).burstStartedAt).toBe(
      t0.getTime(),
    );
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
  // The post gate is not one question. `shouldPost` re-fetches the conversation from Chatwoot and
  // THEN runs the watermark CAS, so a /reset landing inside that round trip arrives after the ask
  // that precedes it — and the input-guardrail reply is the send that sits closest to the gate, with
  // nothing in between to ask again.
  //
  // The supersede half cannot stand in for the ask, and the redirect pair is why: a /reset typed on
  // the ENTRY conversation retires the WIDGET's flush (webhook.ts sweeps both sides), while the
  // re-fetch reads the widget's own messages, where nothing new arrived. The gate sees a quiet
  // conversation and claims the burst.
  describe("with an input guardrail that answers", () => {
    const GUARD_MODEL = "guard-sentinel";
    let previousSettings: unknown = null;

    beforeAll(async () => {
      const before = await suDb.agent.findUniqueOrThrow({
        where: { id: agentDbId },
        select: { settings: true },
      });
      previousSettings = before.settings;
      const key = await suDb.vaultEntry.findFirstOrThrow({
        where: { tenantId, name: "llm-key" },
        select: { id: true },
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          settings: {
            ...(before.settings as object),
            guardrails: {
              enabled: true,
              provider: "openai",
              model: GUARD_MODEL,
              credentialRef: `vault:${key.id}`,
              input: {
                enabled: true,
                action: "template",
                checks: {
                  toxicity: true,
                  unsafeContent: false,
                  competitorMentions: false,
                  promptAdherence: false,
                },
                templateMessage: "TEMPLATE-IN",
              },
              output: { enabled: false },
            },
          },
        },
      });
    });

    afterAll(async () => {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { settings: previousSettings as object },
      });
    });

    test("a burst retired inside the post gate is not answered", async () => {
      await seedConversation(862);
      const thread = threadOf(862);
      const row = await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "DEBOUNCE",
          dedupeKey: debounceDedupeKey(thread),
          status: "CLAIMED",
          runAt: new Date(),
          payload: { threadId: thread, agentBotId: 9, burstStartedAt: 1 },
        },
        select: { id: true, claimSeq: true },
      });
      const sent: Array<[number, string]> = [];
      // `getMessages` runs twice on this path: the burst fetch, then the supersede re-fetch inside
      // the gate. The command lands in the SECOND, which is the window the asks around it leave.
      let fetches = 0;
      const client = {
        getMessages: async () => {
          fetches += 1;
          if (fetches === 2) {
            await retireJobsByDedupeKey(
              tenantId,
              "DEBOUNCE",
              debounceDedupeKey(thread),
              suDb,
            );
          }
          return page([{ id: 1, content: "vocês são uns inúteis" }]);
        },
        sendMessage: async (conversationId: number, content: string) => {
          sent.push([conversationId, content]);
          return {};
        },
        sendPrivateNote: async () => ({}),
        toggleTyping: async () => ({}),
      } as unknown as ChatwootClient;
      const verdict = JSON.stringify({
        violated: true,
        categories: ["toxicity"],
        rationale: "abuse",
      });

      const out = await flushDebounceJob({
        job: { ...jobFor(862), id: row.id, claimSeq: row.claimSeq },
        base: appDb,
        deps: {
          makeModel: (cfg: ResolvedModelConfig) =>
            cfg.model === GUARD_MODEL
              ? guardrailModel(async () => ({ content: verdict }))
              : fakeModel(),
          makeClient: async () => client,
          checkpointer: new MemorySaver(),
        },
      });

      expect(out).toEqual({ outcome: "done" });
      // The gate was actually reached — otherwise this test would pass on a turn that stood down
      // somewhere harmless upstream.
      expect(fetches).toBe(2);
      // And the customer got nothing after their reset, template included.
      expect(sent).toEqual([]);
      // The residual, asserted rather than left to be discovered: the only ask that can catch this
      // window answers after the CAS, so the burst is marked handled without having been answered.
      // The alternative is the send above.
      expect(await watermarkOf(862)).toBe(1);
    });
  });
  // A turn that answers with BOTH an attachment and text, retired between the two. The image is with
  // the customer and the words never arrive, so the burst is half answered — and "stale" would hand
  // it to the next flush, which sends that attachment a second time. Same rule as the two branches
  // that already read `images.sent`, and the third place it has to hold.
  describe("with a turn that sends an image before its reply", () => {
    const IMG_URL = "https://cdn.loja.com.br/produtos/camiseta.png";
    const imageDeps = {
      fetchImpl: (async () =>
        new Response(
          // A real PNG signature: the tool sniffs the bytes before it uploads.
          new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00,
            0x0d,
          ]),
          {
            status: 200,
            headers: { "content-type": "image/png" },
          },
        )) as unknown as typeof fetch,
      assertSafe: async (u: string) => new URL(u),
    };
    let previousSettings: unknown = null;

    beforeAll(async () => {
      const before = await suDb.agent.findUniqueOrThrow({
        where: { id: agentDbId },
        select: { settings: true },
      });
      previousSettings = before.settings;
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          settings: {
            ...(before.settings as object),
            sendImage: { allowedHosts: ["cdn.loja.com.br"] },
          },
        },
      });
    });

    afterAll(async () => {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { settings: previousSettings as object },
      });
    });

    test("a burst retired after the image still counts as answered", async () => {
      await seedConversation(864);
      // A failure the operator is looking at. Only a turn that DELIVERED takes it away, so this is
      // what tells "posted" from "stale" here — the watermark cannot, because the post gate's CAS
      // advanced it before either word was chosen.
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: 864 },
        data: { lastError: "boom", lastErrorAt: new Date() },
      });
      const thread = threadOf(864);
      const row = await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "DEBOUNCE",
          dedupeKey: debounceDedupeKey(thread),
          status: "CLAIMED",
          runAt: new Date(),
          payload: { threadId: thread, agentBotId: 9, burstStartedAt: 1 },
        },
        select: { id: true, claimSeq: true },
      });
      const sent: Array<[number, string]> = [];
      const attachments: string[] = [];
      const client = {
        getMessages: async () => page([{ id: 1, content: "manda a foto" }]),
        sendFileAttachment: async (
          _c: number,
          _b: ArrayBuffer,
          name: string,
        ) => {
          attachments.push(name);
          // The command lands with the picture already delivered and the words still owed.
          await retireJobsByDedupeKey(
            tenantId,
            "DEBOUNCE",
            debounceDedupeKey(thread),
            suDb,
          );
          return {};
        },
        sendMessage: async (conversationId: number, content: string) => {
          sent.push([conversationId, content]);
          return {};
        },
        toggleTyping: async () => ({}),
      } as unknown as ChatwootClient;

      const out = await flushDebounceJob({
        job: { ...jobFor(864), id: row.id, claimSeq: row.claimSeq },
        base: appDb,
        deps: {
          makeModel: () =>
            new SendImageThenReplyModel(
              "É essa aqui!",
              IMG_URL,
            ) as unknown as BaseChatModel,
          makeClient: async () => client,
          checkpointer: new MemorySaver(),
          imageDeps,
        },
      });

      expect(out).toEqual({ outcome: "done" });
      // The picture went out and the words did not.
      expect(attachments).toHaveLength(1);
      expect(sent).toEqual([]);
      // And the turn counts as answered: the error cleared, which only a delivered turn does.
      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 864 },
        select: { lastError: true },
      });
      expect(conv.lastError).toBeNull();
    });
  });

  // The clean stale returns are fenced at every wait. This is the branch that reaches a write WITHOUT
  // passing any of them: a throw unwinds straight past them into the handler's catch.
  describe("with a turn that throws after the command retired it", () => {
    // Retires the claim from inside the model call and then rejects, which is the shape the reviewer
    // named: /reset lands while the invoke (or a TTS call, or a send) is in flight, and that call
    // then fails.
    const retireThenThrow = (thread: string) =>
      new SideEffectModel(async () => {
        await retireJobsByDedupeKey(
          tenantId,
          "DEBOUNCE",
          debounceDedupeKey(thread),
          suDb,
        );
        throw new Error("boom");
      }) as unknown as BaseChatModel;

    async function runThrowingFlush(convId: number, retire: boolean) {
      await seedConversation(convId);
      const thread = threadOf(convId);
      const row = await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "DEBOUNCE",
          dedupeKey: debounceDedupeKey(thread),
          status: "CLAIMED",
          runAt: new Date(),
          payload: { threadId: thread, agentBotId: 9, burstStartedAt: 1 },
        },
        select: { id: true, claimSeq: true },
      });
      const model = retire
        ? retireThenThrow(thread)
        : (new SideEffectModel(async () => {
            throw new Error("boom");
          }) as unknown as BaseChatModel);
      const sent: Array<[number, string]> = [];
      const calls = { getMessages: 0 };
      const err = await flushDebounceJob({
        job: { ...jobFor(convId), id: row.id, claimSeq: row.claimSeq },
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
      }).then(
        () => null,
        (e: unknown) => e,
      );
      // Rethrown either way: the scheduler still has to see the attempt fail. Only the bookkeeping
      // changes, and asserting this keeps the fence from quietly swallowing the failure instead.
      expect(err).toBeInstanceOf(Error);
      return suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: convId },
        select: { lastError: true, lastErrorAt: true },
      });
    }

    test("a throw from a retired run does not put the failure back", async () => {
      const conv = await runThrowingFlush(865, true);
      // `lastError`/`lastErrorAt` are what /reset clears. Recording them here would raise the banner
      // the operator was just told had been taken down, over a turn no retry is coming for.
      expect(conv.lastError).toBeNull();
      expect(conv.lastErrorAt).toBeNull();
    });

    test("a throw from a run nobody retired still records the failure", async () => {
      const conv = await runThrowingFlush(866, false);
      expect(conv.lastError).not.toBeNull();
      expect(conv.lastErrorAt).not.toBeNull();
    });
  });
});
