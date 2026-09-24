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
import {
  type ChatwootClient,
  ChatwootMissingTokenError,
} from "@/modules/chatwoot/client";
import { reengageConversation } from "@/modules/conversations/reengage";
import {
  flushDebounceJob,
  selectAnswerableBurst,
} from "@/modules/debounce/handler";
import {
  armDebounce,
  debounceDedupeKey,
  readReactionArmed,
  readReactionFrom,
  resolveDebounceConfig,
} from "@/modules/debounce/service";
import {
  advanceHandledWatermark,
  claimReplyBurst,
  dispenseMessagesFromReply,
} from "@/modules/debounce/watermark";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";
import type { ClaimedJob } from "@/modules/scheduler/service";
import {
  claimDueDebounceJobs,
  claimDueJobs,
  enqueueJob,
  retireJobsByDedupeKey,
} from "@/modules/scheduler/service";
import {
  clearFlowLog,
  flowLogCount,
  flowLogRow,
  flowLogRows,
} from "@/tests/utils/flowlog";
import { POLL_DEADLINE_MS } from "@/tests/utils/poll";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";
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

// Burned from `scheduler_jobs_id_seq`, never a literal: tests/utils/scheduler.ts says why.
let phantomJobId = 0n;

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
  notes?: Array<[number, string]>;
  // Every write in the order it left, for the callers that assert a SEQUENCE. Three arrays cannot
  // say which came first, and the order is the part of the spend-ceiling contract that a fence
  // makes load-bearing.
  order?: string[];
}) {
  let i = 0;
  // Built from the CONFIG it is handed, so the token profile is part of what this stub personifies.
  // `toggle_status` is a bot-token endpoint (docs/chatwoot.md), and the real client refuses an empty
  // one before anything leaves the process (issue #79) instead of reporting Chatwoot's 401 for a
  // credential nobody sent. A stub that ignored the config would let a caller that forgot the
  // persona token record a handoff that never happened.
  return async (cfg: { botToken?: string }) =>
    ({
      getMessages: async () => {
        const page = opts.pages[Math.min(i, opts.pages.length - 1)] ?? {
          payload: [],
        };
        i += 1;
        opts.calls.getMessages += 1;
        return page;
      },
      sendMessage: async (conversationId: number, content: string) => {
        if (!cfg.botToken) {
          throw new ChatwootMissingTokenError("conversations/messages");
        }
        opts.sent.push([conversationId, content]);
        opts.order?.push("message");
        return {};
      },
      sendPrivateNote: async (conversationId: number, content: string) => {
        if (!cfg.botToken) {
          throw new ChatwootMissingTokenError("conversations/messages");
        }
        opts.notes?.push([conversationId, content]);
        opts.order?.push("note");
        return {};
      },
      toggleStatus: async (conversationId: number, status: string) => {
        if (!cfg.botToken) {
          throw new ChatwootMissingTokenError("conversations/toggle_status");
        }
        opts.toggles.push([conversationId, status]);
        opts.order?.push("toggle");
        return {};
      },
    }) as unknown as ChatwootClient;
}

function page(
  msgs: Array<{
    id: number;
    content: string;
    type?: number;
    priv?: boolean;
    attachments?: unknown[];
    // Chatwoot's own `sender.type` ("contact" | "user" | "agent_bot"), which is what separates our
    // outgoing message from a human agent's (issue #698). Omitted ⇒ the page names no sender, which
    // is a shape the serializer really emits.
    sender?: string;
    senderId?: number;
    reaction?: boolean;
    // `content_attributes.external_sender_name`, which is how the fork marks a message that came
    // back FROM the WhatsApp session instead of out of Chatwoot — an attendant typing on the paired
    // phone, and nobody in the `sender` field (PR #701, review round 8).
    fromDevice?: boolean;
    // `content_attributes.imported`: a row the history importer backfilled, which carries today's id
    // and last year's conversation (PR #701, review round 9).
    imported?: boolean;
  }>,
) {
  return {
    payload: msgs.map((m) => {
      const ca = {
        ...(m.reaction ? { is_reaction: true } : {}),
        ...(m.fromDevice ? { external_sender_name: "WhatsApp" } : {}),
        ...(m.imported ? { imported: true } : {}),
      };
      return {
        id: m.id,
        content: m.content,
        message_type: m.type ?? 0,
        private: m.priv ?? false,
        ...(m.attachments ? { attachments: m.attachments } : {}),
        ...(m.sender
          ? { sender: { id: m.senderId ?? 9, type: m.sender } }
          : {}),
        ...(Object.keys(ca).length > 0 ? { content_attributes: ca } : {}),
      };
    }),
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
  extra: {
    lastMessageId?: number;
    reactionArmed?: boolean;
    reactionFrom?: number;
  } = {},
): ClaimedJob {
  return {
    id: phantomJobId,
    tenantId,
    kind: "DEBOUNCE",
    payload: {
      threadId: threadOf(convId),
      agentBotId: 9,
      burstStartedAt: 1,
      ...(extra.lastMessageId != null
        ? { lastMessageId: extra.lastMessageId }
        : {}),
      ...(extra.reactionArmed ? { reactionArmed: true } : {}),
      ...(extra.reactionFrom != null
        ? { reactionFrom: extra.reactionFrom }
        : {}),
    },
    attempts: 0,
    claimSeq: 0,
  };
}

async function replyClaimOf(convId: number): Promise<number | null> {
  const row = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { lastRepliedMessageId: true },
  });
  return row.lastRepliedMessageId;
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
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let lines: Array<{ level: string; detail: unknown }> = [];
  while (Date.now() < deadline) {
    lines = await flowLogRows(suDb, {
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
    phantomJobId = await burnSchedulerJobId(suDb);
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

  // ISSUE #746: the burst remembers it holds a customer's reaction, across a text typed after it,
  // and a new burst starts without the mark.
  test("armDebounce keeps a burst's reaction mark until the burst ends", async () => {
    const thread = threadOf(7465);
    const cfg = {
      enabled: true,
      windowSeconds: 15,
      maxMessagesPerBurst: 20,
      maxWindowSeconds: 60,
    };
    const key = debounceDedupeKey(thread);
    const payloadOf = async () =>
      (
        await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, kind: "DEBOUNCE", dedupeKey: key },
          select: { payload: true },
        })
      ).payload as Record<string, unknown>;
    const arm = (reaction: boolean, id: number) =>
      armDebounce({
        tenantId,
        threadId: thread,
        agentBotId: 9,
        cfg,
        lastMessageId: id,
        reaction,
        base: appDb,
      });
    await arm(true, 20);
    expect(readReactionArmed(await payloadOf())).toBe(true);
    await arm(false, 21);
    expect(readReactionArmed(await payloadOf())).toBe(true);
    // The earliest reaction of the burst, not the latest arm (PR #821, review round 2).
    await arm(true, 23);
    expect(readReactionFrom(await payloadOf())).toBe(20);
    await suDb.schedulerJob.updateMany({
      where: { tenantId, kind: "DEBOUNCE", dedupeKey: key },
      data: { status: "DONE" },
    });
    await arm(false, 22);
    expect(readReactionArmed(await payloadOf())).toBe(false);
    expect(readReactionFrom(await payloadOf())).toBeNull();
    // A text that arrives while the reaction's flush RUNS supersedes that turn; the flush it arms
    // still owes the reaction (PR #821, review round 3).
    await arm(true, 30);
    await suDb.schedulerJob.updateMany({
      where: { tenantId, kind: "DEBOUNCE", dedupeKey: key },
      data: { status: "CLAIMED" },
    });
    await arm(false, 31);
    expect(readReactionArmed(await payloadOf())).toBe(true);
    expect(readReactionFrom(await payloadOf())).toBe(30);
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

  // O PORTÃO DE POSSE DA #688 É DO CAMINHO QUE ESPERA, E O FLUSH NÃO É ELE. A leitura extra existe
  // porque o caminho direto pode ficar até `TURN_LEASE_SECONDS + 5` parado esperando outro invoke, e
  // o portão do receptor respondeu antes disso. O flush não espera esse thread (`waitForThreadTurn`
  // é ligado só pelo caminho direto) e já tem o seu próprio portão de posse antes do turno, então
  // alargar aquele para cá seria uma segunda leitura por rajada sem janela nova que ela cubra.
  //
  // O teste prende a FRONTEIRA, e ela não se vê no comportamento: trocar a condição do portão por
  // `true` deixa todo o resto verde, porque o flush passaria na leitura e seguiria igual. O que
  // muda é quantas vezes o banco é perguntado, e é isso que este contador mede.
  test("issue #688: the flush does not pay the direct path's ownership read", async () => {
    // COM contact-inbox, e sem ele o teste é vácuo: o portão mora dentro do bloco da fronteira de
    // atendimento, que só roda quando a conversa tem um. A primeira versão deste teste usava o
    // default null, passava, e continuava passando com o portão alargado para todo turno — que é
    // exatamente o mutante que ele existe para matar.
    await seedConversation(858, { contactInboxId: 8580 });
    const thread = threadOf(858);
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
    let leituras = 0;

    const out = await flushDebounceJob({
      job: { ...jobFor(858), id: row.id, claimSeq: row.claimSeq },
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [page([{ id: 1, content: "oi" }])],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
        ownershipRead: async () => {
          leituras += 1;
          return { ours: true };
        },
      },
    });

    // A rajada foi respondida do jeito de sempre...
    expect(out).toEqual({ outcome: "done" });
    expect(sent.length).toBe(1);
    // ...e o portão do caminho direto não foi consultado uma vez sequer.
    expect(leituras).toBe(0);
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

  // ISSUE #746. The fork's default page carries a reaction only when the message it reacts to is
  // among the page's last twenty of the same conversation; `?after=` lists by id with no such window.
  // This stub serves the two reads the way the fork does, so a reaction to an older message (or to
  // one of an earlier conversation) is on the catch-up read and on no default page.
  function makeForkStub(opts: {
    latest: unknown;
    // A function answers each catch-up read by its cursor, for the walk past the fork's cap.
    after: unknown | ((after: number) => unknown);
    sent: Array<[number, string]>;
    reads: Array<{ after?: number }>;
  }) {
    const client = {
      getMessages: async (_conv: number, o?: { after?: number }) => {
        opts.reads.push(o?.after != null ? { after: o.after } : {});
        if (o?.after == null) return opts.latest;
        return typeof opts.after === "function"
          ? opts.after(o.after)
          : opts.after;
      },
      sendMessage: async (conversationId: number, content: string) => {
        opts.sent.push([conversationId, content]);
        return {};
      },
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;
    return async () => client;
  }

  const handledHistory = page([
    { id: 1, content: "quero saber do meu pedido" },
    { id: 2, content: "Já está a caminho!", type: 1, sender: "agent_bot" },
  ]);

  test("issue #746: a lone reaction no default page carries still opens its turn", async () => {
    const convId = 7461;
    await seedConversation(convId, { lastHandledMessageId: 2 });
    const sent: Array<[number, string]> = [];
    const reads: Array<{ after?: number }> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 10, reactionArmed: true }),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeForkStub({
          latest: handledHistory,
          after: page([{ id: 10, content: "❤️", reaction: true }]),
          sent,
          reads,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    // The turn exists and read the reaction; replying is the agent's call, and this model replies.
    expect(model.seen).toHaveLength(1);
    expect(model.seen[0]).toContain('<reação do cliente emoji="❤️"');
    expect(sent).toEqual([[convId, REPLY]]);
    expect(await watermarkOf(convId)).toBe(10);
    // Caught up from the mark, not from the reaction: an earlier orphan of the same burst is above
    // the mark too.
    expect(reads).toContainEqual({ after: 2 });
  });

  test("issue #746: an orphan reaction followed by text in the same burst is not lost behind the text", async () => {
    const convId = 7462;
    await seedConversation(convId, { lastHandledMessageId: 2 });
    const sent: Array<[number, string]> = [];
    const reads: Array<{ after?: number }> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      // The text armed last and IS on the page; only the burst's reaction mark asks for the rest.
      job: jobFor(convId, { lastMessageId: 11, reactionArmed: true }),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeForkStub({
          latest: page([
            { id: 1, content: "quero saber do meu pedido" },
            {
              id: 2,
              content: "Já está a caminho!",
              type: 1,
              sender: "agent_bot",
            },
            { id: 11, content: "chegou hoje, obrigada" },
          ]),
          after: page([
            { id: 10, content: "👍", reaction: true },
            { id: 11, content: "chegou hoje, obrigada" },
          ]),
          sent,
          reads,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(model.seen).toHaveLength(1);
    expect(model.seen[0]).toContain('<reação do cliente emoji="👍"');
    expect(model.seen[0]).toContain("chegou hoje, obrigada");
    expect(await watermarkOf(convId)).toBe(11);
  });

  test("issue #746: a burst with its arming message on the page and no reaction pays no second read", async () => {
    const convId = 7463;
    await seedConversation(convId, { lastHandledMessageId: 2 });
    const reads: Array<{ after?: number }> = [];
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 3 }),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeForkStub({
          latest: page([
            { id: 1, content: "quero saber do meu pedido" },
            {
              id: 2,
              content: "Já está a caminho!",
              type: 1,
              sender: "agent_bot",
            },
            { id: 3, content: "e o prazo?" },
          ]),
          after: page([]),
          sent: [],
          reads,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(reads.some((r) => r.after != null)).toBe(false);
  });

  test("issue #746: an arming message missing from the page is caught up even without the reaction mark", async () => {
    const convId = 7464;
    await seedConversation(convId, { lastHandledMessageId: 2 });
    const sent: Array<[number, string]> = [];
    const reads: Array<{ after?: number }> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      // A burst armed before the mark existed: the payload names the reaction's id and nothing else.
      job: jobFor(convId, { lastMessageId: 12 }),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeForkStub({
          latest: handledHistory,
          after: page([{ id: 12, content: "🙏", reaction: true }]),
          sent,
          reads,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(model.seen[0]).toContain('<reação do cliente emoji="🙏"');
    expect(await watermarkOf(convId)).toBe(12);
  });

  // The catch-up read stops at a hundred rows (the fork's `CATCH_UP_LIMIT`). A burst further behind
  // its page than that is walked until the read reaches the page: merging the first hundred alone
  // would hand the selectors a history with a hole where the operator's reply sits, and a request
  // that reply closed would be answered again (PR #821, review round 1).
  const activityRows = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      id: from + i,
      content: "conversa reaberta",
      type: 2,
    }));

  test("issue #746: a catch-up read past the fork's cap is walked until it reaches the page", async () => {
    const convId = 7468;
    await seedConversation(convId, { lastHandledMessageId: 2 });
    const sent: Array<[number, string]> = [];
    const reads: Array<{ after?: number }> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 104, reactionArmed: true }),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeForkStub({
          // The operator's reply is only in the gap: the page starts above it.
          latest: page(activityRows(150, 150)),
          after: (after: number) =>
            after === 2
              ? page([
                  { id: 3, content: "quero cancelar" },
                  ...activityRows(4, 102),
                ])
              : page([
                  {
                    id: 103,
                    content: "Pronto, cancelei.",
                    type: 1,
                    sender: "user",
                  },
                  { id: 104, content: "❤️", reaction: true },
                ]),
          sent,
          reads,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    // The page, then the walk; the post gate re-reads the page after the turn.
    expect(reads.slice(0, 3)).toEqual([{}, { after: 2 }, { after: 102 }]);
    expect(model.seen[0]).toContain('<reação do cliente emoji="❤️"');
    // The operator's reply is in the walked history, so the request it closed is not answered again.
    expect(model.seen.join("\n")).not.toContain("quero cancelar");
  });

  // PR #821, review round 2: meeting the page is not reaching the reaction. The orphan sorts above
  // the page's non-reaction messages, so the read goes on until it runs dry.
  test("issue #746: the catch-up read goes past the page to the reaction above it", async () => {
    const convId = 7471;
    await seedConversation(convId, { lastHandledMessageId: 2 });
    const sent: Array<[number, string]> = [];
    const reads: Array<{ after?: number }> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 120, reactionArmed: true }),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeForkStub({
          latest: page(activityRows(100, 119)),
          after: (after: number) =>
            page(
              after === 2
                ? activityRows(3, 102)
                : [
                    ...activityRows(103, 119),
                    { id: 120, content: "🔥", reaction: true },
                  ],
            ),
          sent,
          reads,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(reads.slice(0, 3)).toEqual([{}, { after: 2 }, { after: 102 }]);
    expect(model.seen[0]).toContain('<reação do cliente emoji="🔥"');
  });

  // PR #821, review round 2: a conversation the agent never answered has no mark, and the flush was
  // armed last by the text typed after the reaction. The read starts at the burst's earliest
  // reaction, not at the arming message.
  test("issue #746: with no mark, the catch-up read starts at the burst's first reaction", async () => {
    const convId = 7472;
    await seedConversation(convId);
    const sent: Array<[number, string]> = [];
    const reads: Array<{ after?: number }> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId, {
        lastMessageId: 11,
        reactionArmed: true,
        reactionFrom: 10,
      }),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeForkStub({
          latest: page([{ id: 11, content: "oi, tudo bem?" }]),
          after: (after: number) =>
            page(
              [
                { id: 10, content: "👋", reaction: true },
                { id: 11, content: "oi, tudo bem?" },
              ].filter((m) => m.id > after),
            ),
          sent,
          reads,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(reads[1]).toEqual({ after: 9 });
    expect(model.seen[0]).toContain('<reação do cliente emoji="👋"');
  });

  // PR #821, review round 6: the post gate asks the catch-up read too. A second orphan reaction that
  // arrives while the first one's turn runs is on no default page, and the turn would post over it
  // instead of yielding to the flush it re-armed.
  test("issue #746: a reaction that arrives mid-turn supersedes a reaction's turn", async () => {
    const convId = 7473;
    await seedConversation(convId, { lastHandledMessageId: 2 });
    const sent: Array<[number, string]> = [];
    const reads: Array<{ after?: number }> = [];
    const model = new CaptureReplyModel(REPLY);
    let catchUps = 0;
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 10, reactionArmed: true }),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeForkStub({
          latest: handledHistory,
          after: () => {
            catchUps++;
            return page([
              { id: 10, content: "❤️", reaction: true },
              ...(catchUps > 1
                ? [{ id: 11, content: "😂", reaction: true }]
                : []),
            ]);
          },
          sent,
          reads,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(model.seen[0]).toContain('<reação do cliente emoji="❤️"');
    expect(catchUps).toBe(2);
    expect(sent).toEqual([]);
  });

  // The other half: a TEXT burst, and a reaction that re-arms the thread while its turn runs. The
  // burst itself carries no mark, so the gate learns of the reaction from the thread's debounce row.
  test("issue #746: a reaction that re-arms the thread mid-turn supersedes a text burst's turn", async () => {
    const convId = 7474;
    await seedConversation(convId, { lastHandledMessageId: 2 });
    const sent: Array<[number, string]> = [];
    const reads: Array<{ after?: number }> = [];
    const model = new CaptureReplyModel(REPLY);
    // What the webhook's arm leaves on the thread's row when the reaction lands.
    await armDebounce({
      tenantId,
      threadId: threadOf(convId),
      agentBotId: 9,
      cfg: {
        enabled: true,
        windowSeconds: 15,
        maxMessagesPerBurst: 20,
        maxWindowSeconds: 60,
      },
      lastMessageId: 11,
      reaction: true,
      base: appDb,
    });
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 10 }),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeForkStub({
          latest: page([
            ...handledHistory.payload.map((m) => ({
              id: m.id,
              content: m.content,
              type: m.message_type,
            })),
            { id: 10, content: "e o prazo?" },
          ]),
          after: page([{ id: 11, content: "🙏", reaction: true }]),
          sent,
          reads,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(model.seen[0]).toContain("e o prazo?");
    expect(reads.some((r) => r.after === 10)).toBe(true);
    expect(sent).toEqual([]);
  });

  test("issue #746: a catch-up walk the read cap cuts short adds nothing", async () => {
    const convId = 7469;
    await seedConversation(convId, { lastHandledMessageId: 2 });
    const sent: Array<[number, string]> = [];
    const reads: Array<{ after?: number }> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 3, reactionArmed: true }),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeForkStub({
          // Nothing on the page closes anything, so a merged hole would open a turn.
          latest: page(activityRows(10_000, 10_000)),
          // Always a full batch, always below the page: the walk never reaches it.
          after: (after: number) =>
            page(
              after === 2
                ? [
                    { id: 3, content: "😡", reaction: true },
                    ...activityRows(4, 102),
                  ]
                : activityRows(after + 1, after + 100),
            ),
          sent,
          reads,
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(reads).toEqual([
      {},
      { after: 2 },
      { after: 102 },
      { after: 202 },
      { after: 302 },
      { after: 402 },
    ]);
    // A history with a hole is not handed on: the page alone answers, and it holds nothing pending.
    expect(model.seen).toHaveLength(0);
    expect(sent).toEqual([]);
  });

  // The claim's own table, decided in one place and asked here directly: the paths above prove the
  // gate consults it, this proves what it answers (issue #452, rewritten for issue #690).
  //
  // WHAT CHANGED AND WHY, because one of these assertions is the inverse of what it used to be. The
  // claim used to be a single number and the test asserted that a claim BEHIND it lost — which is
  // the arithmetic issue #690 is about: claiming 20 closed 15 without anybody having read 15. What
  // the assertion was actually protecting is a flush retry and a second click not answering the same
  // burst twice, and that protection survives in a stronger form: identity. The same ids collide on
  // the unique index however they are ordered, and a set that OVERLAPS a claimed one loses whole
  // rather than in part. Both are asserted below, so the rewrite does not trade a proof for a hole.
  // Issue #750. The claim records WHICH message we answered; the follow-up's activation fence needs
  // WHEN we answered, and the two are not the same column. The id is a watermark and refuses to move
  // backwards; the instant is not — a claim below the mark is still our side speaking, and on "did
  // this conversation become live after the agent was armed" it counts exactly as much.
  test("the claim also records WHEN our side spoke, including below the mark", async () => {
    const convId = 8977;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    const claim = (messageIds: number[]) =>
      claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: Math.max(...messageIds),
        maxHandledAllowed: null,
        messageIds,
        initiatedBy: "automatic",
        base: appDb,
      });
    const row = async () =>
      await suDb.conversation.findUniqueOrThrow({
        where: { id },
        select: { lastRepliedMessageId: true, lastRepliedAt: true },
      });

    expect((await row()).lastRepliedAt).toBeNull();
    const before = new Date();
    expect(await claim([30])).toEqual({ won: true });
    const first = await row();
    expect(first.lastRepliedMessageId).toBe(30);
    expect(first.lastRepliedAt).not.toBeNull();
    expect(first.lastRepliedAt?.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );

    // BELOW THE MARK: the id holds at 30 (monotonic), the instant moves anyway, because the question
    // it answers is "when did we last speak here" and we just did.
    const mid = first.lastRepliedAt as Date;
    await Bun.sleep(5);
    expect(await claim([20])).toEqual({ won: true });
    const second = await row();
    expect(second.lastRepliedMessageId).toBe(30);
    expect(second.lastRepliedAt?.getTime()).toBeGreaterThan(mid.getTime());
  });

  test("the reply claim is per message, all or nothing, and still monotonic", async () => {
    const convId = 892;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    const claim = (
      messageIds: number[],
      maxHandledAllowed: number | null = null,
    ) =>
      claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: Math.max(...messageIds),
        maxHandledAllowed,
        messageIds,
        initiatedBy: "automatic",
        base: appDb,
      });
    const stored = async () =>
      (
        await suDb.conversation.findUniqueOrThrow({
          where: { id },
          select: { lastRepliedMessageId: true },
        })
      ).lastRepliedMessageId;

    expect(await claim([10])).toEqual({ won: true });
    expect(await claim([20])).toEqual({ won: true });
    // THE RETRY, which is what the old arithmetic was really guarding: the same burst claimed twice
    // loses the second time, now by identity rather than by order.
    expect(await claim([20])).toEqual({ won: false, reason: "claimed" });
    // AND THE OVERLAP LOSES WHOLE. A turn that owns part of a tail owns none of it — answering half
    // a burst is how a customer reads a reply to their second message and nothing about their first.
    // The WORD is `partial` and not `claimed`: 19 and 21 are still owed to somebody, and the flush
    // reschedules on exactly that distinction.
    expect(await claim([19, 20, 21])).toEqual({
      won: false,
      reason: "partial",
    });
    // ...and having lost, it left nothing behind: 19 and 21 are still free for the turn that does
    // read them. A partial insert surviving the loss would close them for a reply nobody sent.
    expect(await claim([19, 21])).toEqual({ won: true });
    // THE ONE THAT USED TO LOSE. Nobody ever claimed 15, and the turn that just read it is the only
    // actor that can answer it. This is issue #690 in one line.
    expect(await claim([15])).toEqual({ won: true });
    // AND THE SCALAR DID NOT FOLLOW IT BACKWARDS. Everything still reading that column — the flush's
    // own floor, every conversation below the per-message era — would otherwise treat 16 through 21
    // as unanswered and coalesce them into the next burst.
    expect(await stored()).toBe(21);
  });

  // A DELAYED REDELIVERY AND AN OPERATOR'S CLICK LOOK THE SAME AND ARE OPPOSITE (issue #690).
  //
  // Both answer a tail the watermark already covers, so arithmetic cannot separate them — the first
  // shape of this fix tried, and would have let a redelivery of a message answered long ago overturn
  // the record of its own answer. One is a person deciding a silence was wrong; the other is Chatwoot
  // repeating itself. The caller says which it is, and the word is required so a path added later
  // cannot inherit the forgiving one by omission.
  test("a redelivery cannot overturn a dispensal that an operator's click can", async () => {
    const convId = 899;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    const claim = (initiatedBy: "automatic" | "operator") =>
      claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 1001,
        // The ceiling both of them pass: the mark it read on the way in.
        maxHandledAllowed: 1001,
        messageIds: [1001],
        initiatedBy,
        base: appDb,
      });

    // A turn ran over 1001 and chose silence — an empty reply, a guardrail going quiet — and said so
    // by id on its way out. This is what both callers below will meet.
    await advanceHandledWatermark({
      tenantId,
      conversationDbId: id,
      toMessageId: 1001,
      dispensed: { kind: "messages", messageIds: [1001] },
      base: appDb,
    });

    // Chatwoot repeating a delivery of that same message. It must not answer what was deliberately
    // left unanswered, and the record is the only thing that knows.
    expect(await claim("automatic")).toEqual({
      won: false,
      reason: "claimed",
    });
    // A person looking at the conversation and pressing the button. Overturning that silence is the
    // whole reason the button exists (issue #452).
    expect(await claim("operator")).toEqual({ won: true });
    // AND HAVING BEEN ANSWERED, it is answered: the row says CLAIMED now, so a second click — or a
    // redelivery arriving after it — meets a claim and not a silence.
    expect(await claim("operator")).toEqual({ won: false, reason: "claimed" });
    expect(
      (
        await suDb.messageReplyClaim.findFirstOrThrow({
          where: { conversationId: id, messageId: 1001 },
          select: { reason: true },
        })
      ).reason,
    ).toBe("CLAIMED");
  });

  // A1 VARIANT (i), REPRODUCED AT THE CLAIM (issue #690 holdout). A message answered a while ago,
  // its row still there, the mark well past it, and Chatwoot delivering it a second time. The
  // sequential case, as opposed to the two simultaneous deliveries of `s5`: the first turn is long
  // finished, so nothing is racing and identity is the only thing left that can refuse.
  test("a redelivery of a message already claimed is refused, turns later", async () => {
    const convId = 933;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    const claim = (m: number, ceiling: number) =>
      claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: m,
        maxHandledAllowed: ceiling,
        messageIds: [m],
        initiatedBy: "automatic",
        base: appDb,
      });

    expect(await claim(1001, 1000)).toEqual({ won: true });
    expect(await claim(1002, 1001)).toEqual({ won: true });
    expect(await claim(1003, 1002)).toEqual({ won: true });
    await advanceHandledWatermark({
      tenantId,
      conversationDbId: id,
      toMessageId: 1003,
      dispensed: { kind: "claimed" },
      base: appDb,
    });

    expect(await claim(1001, 1000)).toEqual({ won: false, reason: "claimed" });
  });

  // THE CLICK'S ENTRY-TIME CEILING SURVIVES THE FLOOR (issue #452, PR review round 1). Above the
  // floor the scalars answer nothing for an automatic caller, because every decision up there wrote
  // a row and the rows are read directly. The operator's click is the exception, and only because it
  // IGNORES dispensals on purpose: a skip recorded between the moment it read the mark and the
  // moment it claims is a decision it would otherwise walk straight over. `docs/debounce.md` requires
  // that skip to refuse the reply.
  test("a skip landing while the operator's model ran still refuses the click", async () => {
    const convId = 931;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    // The conversation is already in the per-message era, and well above the floor.
    expect(
      await claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 2000,
        maxHandledAllowed: 1999,
        messageIds: [2000],
        initiatedBy: "automatic",
        base: appDb,
      }),
    ).toEqual({ won: true });

    // The operator reads the mark at 2000 and clicks. While the model runs, a delivery of 2001
    // settles it deliberately and the mark moves.
    await advanceHandledWatermark({
      tenantId,
      conversationDbId: id,
      toMessageId: 2001,
      dispensed: { kind: "messages", messageIds: [2001] },
      base: appDb,
    });
    expect(
      await claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 2001,
        // What it read on the way IN, which is the whole point of the ceiling.
        maxHandledAllowed: 2000,
        messageIds: [2001],
        initiatedBy: "operator",
        base: appDb,
      }),
    ).toEqual({ won: false, reason: "handled" });
  });

  // A DISPENSAL IS ASKED ABOUT THE IDS, NOT ABOUT THE SPAN THEY COVER (issue #690, PR review round
  // 1). A burst is not dense: the selection drops what renders to nothing, so `[1001, 1005]` spans
  // four ids it does not contain. Asked as an overlap of intervals, a dispensal sitting entirely
  // inside that gap suppressed the whole reply for messages the turn was never speaking for.
  test("a dispensal inside a sparse burst's gap does not refuse it", async () => {
    const convId = 932;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    // A gate exit dispensed (1002, 1004] — the middle of the span, and none of the burst.
    await suDb.replyDispensal.create({
      data: {
        tenantId,
        conversationId: id,
        fromMessageId: 1002,
        toMessageId: 1004,
      },
    });

    expect(
      await claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 1005,
        maxHandledAllowed: 1004,
        messageIds: [1001, 1005],
        initiatedBy: "automatic",
        base: appDb,
      }),
    ).toEqual({ won: true });

    // ...and one that really does contain a member still refuses the whole set.
    await suDb.replyDispensal.create({
      data: {
        tenantId,
        conversationId: id,
        fromMessageId: 1005,
        toMessageId: 1007,
      },
    });
    expect(
      await claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 1007,
        maxHandledAllowed: 1006,
        messageIds: [1006, 1007],
        initiatedBy: "automatic",
        base: appDb,
      }),
    ).toEqual({ won: false, reason: "dispensed" });

    // ...and one that covers only PART of the set says so, because the messages it does not cover
    // are still owed to somebody and the flush comes back for them (PR review, round 5).
    expect(
      await claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 1009,
        maxHandledAllowed: 1008,
        messageIds: [1007, 1009],
        initiatedBy: "automatic",
        base: appDb,
      }),
    ).toEqual({ won: false, reason: "partial" });
  });

  // A BURST DOES NOT CARRY WHAT ANOTHER TURN IS ALREADY SPEAKING FOR (issue #690, PR review round
  // 3). The claim is taken before its turn sends and the watermark only moves after that turn
  // returns, so in between a message sits above the mark with a row on it, invisible to a selection
  // that asks the mark alone. Carried into the burst it makes the claim conflict, and the claim is
  // all-or-nothing — so the message BESIDE it, which nobody claimed, would be refused too and have
  // nothing coming for it afterwards. This asserts the claim's half of that: the free message wins
  // on its own.
  test("a burst claims the message beside one another turn already holds", async () => {
    const convId = 934;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    // A direct turn claimed 1001 and has not returned yet, so the watermark is still behind it.
    expect(
      await claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 1001,
        maxHandledAllowed: 1000,
        messageIds: [1001],
        initiatedBy: "automatic",
        base: appDb,
      }),
    ).toEqual({ won: true });

    // The flush's selection drops 1001 and claims what is actually free.
    expect(
      await claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 1002,
        maxHandledAllowed: 1001,
        messageIds: [1002],
        initiatedBy: "automatic",
        base: appDb,
      }),
    ).toEqual({ won: true });

    // ...and carrying 1001 along would have cost 1002 as well, which is the shape the selection
    // exists to avoid.
    expect(
      await claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 1003,
        maxHandledAllowed: 1002,
        messageIds: [1001, 1003],
        initiatedBy: "automatic",
        base: appDb,
      }),
      // `partial`, because 1003 was free: the word is what tells the flush to come back for it.
    ).toEqual({ won: false, reason: "partial" });
    expect(
      await suDb.messageReplyClaim.findFirst({
        where: { conversationId: id, messageId: 1003 },
      }),
    ).toBeNull();
  });

  // THE FLOOR IS THE MAX OF BOTH SCALARS, and a conversation where the CLAIM is ahead of the
  // watermark is what proves it (issue #690, mutation m6). That state is not hypothetical: the claim
  // is written before the send and the watermark after the turn, so a reply whose watermark write was
  // lost leaves exactly this (issue #452). Taking `handled` alone would put every message between the
  // two above the floor, where "no row" reads as open — and the bot answers a stretch it already
  // replied to.
  test("the floor starts at the highest of the two scalars, not at the watermark", async () => {
    const convId = 936;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { lastRepliedMessageId: 50, lastHandledMessageId: 10 },
    });

    expect(
      await claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 60,
        maxHandledAllowed: 59,
        messageIds: [60],
        initiatedBy: "automatic",
        base: appDb,
      }),
    ).toEqual({ won: true });
    expect(
      (
        await suDb.conversation.findUniqueOrThrow({
          where: { id },
          select: { replyClaimFloorMessageId: true },
        })
      ).replyClaimFloorMessageId,
    ).toBe(50);
    // ...and 20, which the lost watermark write left between the two, is still the scalars' to
    // answer for: it is at or below the floor, so the unrelaxed rule refuses it.
    expect(
      await claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 20,
        maxHandledAllowed: 19,
        messageIds: [20],
        initiatedBy: "automatic",
        base: appDb,
      }),
    ).toEqual({ won: false, reason: "claimed" });
  });

  // AND THE FLUSH COMES BACK FOR WHAT IT COULD NOT CLAIM (issue #690, mutation m8). The selection
  // drops what is already spoken for at the moment it reads, so the only way into a partial conflict
  // is a claim landing INSIDE the turn — which is what the model's side effect does here. Every other
  // `superseded` completes the job, because a newer message's own flush is armed; this one has
  // nothing coming for the messages nobody claimed, and rescheduling is the only thing that brings a
  // turn back to them.
  test("a partial claim conflict reschedules the flush instead of completing it", async () => {
    const convId = 937;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    const sent: Array<[number, string]> = [];
    // Another turn claims message 2 while this one is at the model, so the burst `[1, 2]` reaches the
    // claim with one member taken and one free.
    const stealTwo = new SideEffectModel(async () => {
      await claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 2,
        maxHandledAllowed: 1,
        messageIds: [2],
        initiatedBy: "automatic",
        base: appDb,
      });
    });

    const out = await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => stealTwo,
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "oi" },
              { id: 2, content: "tudo bem?" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });

    // Nothing was sent, and the job comes back rather than completing.
    expect(sent).toEqual([]);
    expect(out.outcome).toBe("reschedule");
    // Message 1 is still nobody's: the retry is what will speak for it.
    expect(
      await suDb.messageReplyClaim.findFirst({
        where: { conversationId: id, messageId: 1 },
      }),
    ).toBeNull();
  });

  // AND THE RETRY FINDS THE FLOOR ALREADY PAST IT (issue #698). The test above ends where the damage
  // begins: the job comes back, and the selection it comes back to still asks a single number.
  // `readAnsweredFloor` is the max of the two scalars, the winning claim wrote `1002` into one of
  // them, and message 1 sits below that with no claim row and no dispensal row anywhere. The claim
  // would grant it (1 is above this conversation's per-message floor, so neither scalar gate even
  // looks); the selection never offers it.
  test("the retry after a partial conflict answers the message nobody claimed", async () => {
    const convId = 938;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    const sent: Array<[number, string]> = [];
    const client = makeStub({
      pages: [
        page([
          { id: 1, content: "oi" },
          { id: 2, content: "tudo bem?" },
        ]),
      ],
      sent,
      calls: { getMessages: 0 },
    });
    const checkpointer = new MemorySaver();
    // The competing turn does what a real one does: claims its own message and advances the mark on
    // its way out. Both writes land while this flush is at the model, so the burst `[1, 2]` reaches
    // the claim with 2 taken and 1 free.
    const stealTwo = new SideEffectModel(async () => {
      await claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 2,
        maxHandledAllowed: 1,
        messageIds: [2],
        initiatedBy: "automatic",
        base: appDb,
      });
      await advanceHandledWatermark({
        tenantId,
        conversationDbId: id,
        toMessageId: 2,
        dispensed: { kind: "messages", messageIds: [2] },
        base: appDb,
      });
    });

    const first = await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: { makeModel: () => stealTwo, makeClient: client, checkpointer },
    });
    expect(first.outcome).toBe("reschedule");
    expect(sent).toEqual([]);

    // THE RETRY, which is the only turn left that knows message 1 exists.
    const retry = await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: { makeModel: () => fakeModel(), makeClient: client, checkpointer },
    });

    expect(retry.outcome).toBe("done");
    // The customer gets an answer to what they wrote, and the claim row is what records it.
    expect(sent.map(([, text]) => text)).toEqual([REPLY]);
    expect(
      await suDb.messageReplyClaim.findFirst({
        where: { conversationId: id, messageId: 1 },
      }),
    ).not.toBeNull();
  });

  // A DISPENSA QUE NÃO ANDA COM A MARCA TEM QUE ABRIR A ERA QUE A TORNA VISÍVEL (issue #725, review
  // rodada 8). `dispenseMessagesFromReply` é o único escritor de uma linha `DISPENSED` que
  // deliberadamente NÃO move a marca, e numa conversa que nunca teve reivindicação o piso é nulo:
  // `readSelectionState` devolve conjuntos vazios ali, a seleção decide só pelos escalares, e a
  // linha fica invisível para quem monta a rajada — mas continua visível para o índice único do
  // `claimReplyBurst`, que é tudo ou nada. A rajada `[1, 2]` seria recusada inteira, com a mensagem
  // nova junto, e o `partial` reagenda para ler de novo exatamente o mesmo estado: um laço, e o
  // cliente sem resposta até a varredura reparar a entrega antiga.
  test("a dispensal with no floor does not swallow the message beside it", async () => {
    const convId = 935;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    // O portão recusou a resposta à mensagem 1 e deixou a marca para trás de propósito, porque a
    // memória dela ainda é devida.
    await dispenseMessagesFromReply({
      tenantId,
      conversationDbId: id,
      messageIds: [1],
      base: appDb,
    });
    const sent: Array<[number, string]> = [];
    const out = await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => fakeModel(),
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "oi" },
              { id: 2, content: "tudo bem?" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });

    expect(out.outcome).toBe("done");
    expect(sent.map(([, text]) => text)).toEqual([REPLY]);
    // A palavra de cada uma é o que separa as duas decisões: 1 continua silenciada pelo portão, 2 é
    // desta passada.
    expect(
      (
        await suDb.messageReplyClaim.findFirstOrThrow({
          where: { conversationId: id, messageId: 1 },
        })
      ).reason,
    ).toBe("DISPENSED");
    expect(
      (
        await suDb.messageReplyClaim.findFirstOrThrow({
          where: { conversationId: id, messageId: 2 },
        })
      ).reason,
    ).toBe("CLAIMED");
  });

  // E NADA ABAIXO DO PISO, que é a outra metade do mesmo invariante (issue #725, review rodada 8).
  // Uma redentrega da era velha bate no mesmo portão fechado, e a decisão sobre ela já foi tomada
  // pelos escalares: a linha só recriaria o conflito invisível de cima, e abrir a era para ela
  // contradiz a frase que o `docs/debounce.md` sustenta — no piso e abaixo dele linha nenhuma foi
  // escrita e nenhuma será.
  test("a dispensal at or below the scalars writes nothing and starts no era", async () => {
    const convId = 930;
    await seedConversation(convId, { lastHandledMessageId: 5 });
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });

    await dispenseMessagesFromReply({
      tenantId,
      conversationDbId: id,
      messageIds: [3],
      base: appDb,
    });
    expect(
      await suDb.messageReplyClaim.count({ where: { conversationId: id } }),
    ).toBe(0);
    expect(
      (
        await suDb.conversation.findUniqueOrThrow({
          where: { id },
          select: { replyClaimFloorMessageId: true },
        })
      ).replyClaimFloorMessageId,
    ).toBeNull();

    // E num conjunto misto a era começa, mas só a mensagem que a era nova pode enxergar ganha linha.
    // A do próprio piso fica de fora com as de baixo: ela é a última que a era velha decidiu.
    await dispenseMessagesFromReply({
      tenantId,
      conversationDbId: id,
      messageIds: [3, 5, 7],
      base: appDb,
    });
    expect(
      (
        await suDb.messageReplyClaim.findMany({
          where: { conversationId: id },
          select: { messageId: true },
        })
      ).map((r) => r.messageId),
    ).toEqual([7]);
    expect(
      (
        await suDb.conversation.findUniqueOrThrow({
          where: { id },
          select: { replyClaimFloorMessageId: true },
        })
      ).replyClaimFloorMessageId,
    ).toBe(5);
  });

  // THE REPLY A PERSON WROTE IS THE FENCE NO ROW RECORDS (issue #698). Above the per-message floor
  // the selection reads "no row" as "still owed", and a human agent answering a customer writes no
  // row anywhere: `pendingIncoming` reads incoming messages only, so without this fence the thread a
  // person already handled goes back to the model. The rule is asymmetric, and the control below is
  // what proves the asymmetry rather than a blanket "any outgoing closes everything": OUR own reply
  // must not close the messages its turn did not claim, or the fix above would undo itself.
  test("an outgoing a PERSON wrote closes the burst before it, and ours does not", async () => {
    const withPage = async (convId: number, senderType: string) => {
      await seedConversation(convId);
      const { id } = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: convId },
        select: { id: true },
      });
      // The per-message era, started without a claim: below this floor the scalars decide and the
      // fence is never consulted.
      await suDb.conversation.update({
        where: { id },
        data: { replyClaimFloorMessageId: 0 },
      });
      const sent: Array<[number, string]> = [];
      const out = await flushDebounceJob({
        job: jobFor(convId),
        base: appDb,
        deps: {
          makeModel: () => fakeModel(),
          makeClient: makeStub({
            pages: [
              page([
                { id: 1, content: "oi" },
                { id: 2, content: "tudo bem?" },
                { id: 3, content: "já respondi", type: 1, sender: senderType },
              ]),
            ],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
        },
      });
      return { sent, outcome: out.outcome };
    };

    // A human agent answered 1 and 2. Nothing is owed, and nothing is said.
    const human = await withPage(939, "user");
    expect(human.sent).toEqual([]);
    // Our own reply to message 2 leaves message 1 exactly as owed as it was: the claim rows are what
    // say which messages a reply of ours covered, and there are none.
    const ours = await withPage(940, "agent_bot");
    expect(ours.sent.map(([, text]) => text)).toEqual([REPLY]);
  });

  // THE SAME FENCE, BY THE OTHER ROUTE A PERSON ANSWERS THROUGH (PR #701, review round 8). An
  // attendant who replies on the phone paired to the inbox's number never opens the CRM, and the
  // fork stores that echo SENDER-LESS: `senderType` is null on the row, so the clause above sees
  // nothing and the burst the person just handled goes back to the model. The only mark on it is
  // `external_sender_name`.
  //
  // AND THE MARK ALONE IS NOT ENOUGH, which is what the second half measures. On a provider that
  // does not reserve its send ids, OUR OWN reply comes back wearing exactly this shape whenever the
  // send response was lost: read as somebody else's, it would have the agent fall silent on a
  // customer nobody answered — this issue's own defect, arriving through its fix. So the route is
  // refused off the reserving providers, the same refusal `isDeviceAttendantMessage` makes.
  test("a reply typed on the PAIRED PHONE closes the burst, and only where the provider reserves its ids", async () => {
    const withProvider = async (convId: number, provider: string) => {
      await suDb.inbox.update({
        where: { id: inboxDbId },
        data: { provider },
      });
      await seedConversation(convId);
      const { id } = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: convId },
        select: { id: true },
      });
      await suDb.conversation.update({
        where: { id },
        data: { replyClaimFloorMessageId: 0 },
      });
      const sent: Array<[number, string]> = [];
      await flushDebounceJob({
        job: jobFor(convId),
        base: appDb,
        deps: {
          makeModel: () => fakeModel(),
          makeClient: makeStub({
            pages: [
              page([
                { id: 1, content: "oi" },
                { id: 2, content: "tudo bem?" },
                {
                  id: 3,
                  content: "oi, aqui é a Ana",
                  type: 1,
                  fromDevice: true,
                },
              ]),
            ],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
        },
      });
      return sent;
    };

    try {
      // baileys reserves its ids, so a sender-less marked echo cannot be ours: a person answered.
      expect(await withProvider(958, "baileys")).toEqual([]);
      // zapi does not, so the same row can be our own answer coming back around. The customer is
      // still owed one, and gets it.
      expect((await withProvider(959, "zapi")).map(([, text]) => text)).toEqual(
        [REPLY],
      );
    } finally {
      await suDb.inbox.update({
        where: { id: inboxDbId },
        data: { provider: null },
      });
    }
  });

  // O IMPORTADOR ESCREVE O PASSADO COM OS IDS DE HOJE (PR #701, review round 9). Ao parear um
  // telefone, o histórico entra como mensagens novas do ponto de vista do banco: a resposta que o
  // atendente deu no ano passado recebe um id ACIMA da pergunta que o cliente mandou agora e casa com
  // todas as cláusulas da fronteira. Lida como resposta, ela cala esse cliente — e o backlog inteiro
  // do operador junto, de uma vez, no dia do pareamento. Mesma exclusão que o `hasDeviceAttendantShape`
  // faz no webhook, aqui num ponto em que a marca é de fato alcançável: esta página vem do banco.
  test("a backfilled reply from the phone's history is not a reply to what is live", async () => {
    const convId = 960;
    await suDb.inbox.update({
      where: { id: inboxDbId },
      data: { provider: "baileys" },
    });
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    const sent: Array<[number, string]> = [];
    try {
      await flushDebounceJob({
        job: jobFor(convId),
        base: appDb,
        deps: {
          makeModel: () => fakeModel(),
          makeClient: makeStub({
            pages: [
              page([
                { id: 1, content: "vocês abrem sábado?" },
                {
                  id: 2,
                  content: "bom dia, funcionamos das 9 às 13",
                  type: 1,
                  fromDevice: true,
                  imported: true,
                },
              ]),
            ],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
        },
      });
      expect(sent.map(([, text]) => text)).toEqual([REPLY]);
    } finally {
      await suDb.inbox.update({
        where: { id: inboxDbId },
        data: { provider: null },
      });
    }
  });

  // UMA NOTA PRIVADA NÃO É UMA RESPOSTA AO CLIENTE (bateria de mutação da rodada 10, m7). Ela sai com
  // remetente `user` e `message_type` de saída, casando com todas as outras cláusulas da fronteira, e
  // o cliente nunca a vê: é a equipe falando entre si. Lida como resposta, ela cala uma conversa que
  // ninguém atendeu, que é o custo assimétrico que esta fronteira existe para não pagar.
  test("an operator's private note is not a reply to the customer", async () => {
    const convId = 961;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    const sent: Array<[number, string]> = [];
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => fakeModel(),
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "tem alguém?" },
              {
                id: 2,
                content: "esse é o cliente do contrato antigo",
                type: 1,
                priv: true,
                sender: "user",
                senderId: 41,
              },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(sent.map(([, text]) => text)).toEqual([REPLY]);
  });

  // E UM TEMPLATE QUE UMA PESSOA DISPAROU É UMA RESPOSTA (bateria de mutação da rodada 10, m8). Fora
  // da janela de 24h do WhatsApp é a única forma de a equipe falar, então tratá-lo como outra coisa
  // faria o agente responder por cima justamente nas conversas que ficaram paradas mais tempo.
  test("a template a person sent closes the burst like any other reply", async () => {
    const convId = 962;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    const sent: Array<[number, string]> = [];
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => fakeModel(),
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "tem alguém?" },
              {
                id: 2,
                content: "Olá! Retomando seu atendimento.",
                type: 3,
                sender: "user",
                senderId: 41,
              },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(sent).toEqual([]);
  });

  // A CERCA ACIMA DA MARCA ESCALAR, e não só onde não há marca nenhuma (bateria de mutação da rodada
  // 10, m15). Antes da era por mensagem o piso é `max(escalar, fronteira)`, e o teste que existia
  // cobria só o caso de marca nula: com uma marca, o `Math.max` some sem nada ficar vermelho, e a
  // pergunta que a pessoa já respondeu volta para o modelo.
  test("before the per-message era, the fence applies ABOVE the scalar mark too", async () => {
    const convId = 963;
    await seedConversation(convId, { lastHandledMessageId: 1 });
    const sent: Array<[number, string]> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "boa tarde" },
              { id: 2, content: "tem alguém?" },
              {
                id: 3,
                content: "oi, sou a Ana do suporte",
                type: 1,
                sender: "user",
                senderId: 41,
              },
              { id: 4, content: "e qual o prazo?" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(sent.map(([, text]) => text)).toEqual([REPLY]);
    const seen = model.seen.join("\n");
    expect(seen).toContain("qual o prazo");
    // A que estava ENTRE a marca e a resposta da Ana é a que o `Math.max` tira.
    expect(seen).not.toContain("tem alguém?");
  });

  // QUAL PORTÃO RECUSOU IMPORTA (bateria de mutação da rodada 10, m23 e m29). São dois: a SELEÇÃO,
  // que decide o que entra na rajada, e o portão de POST, que reconfere depois do modelo. Cada um
  // sozinho produz o mesmo silêncio, então um teste que só olha o que foi enviado passa com qualquer
  // um dos dois cego — e cego na seleção o modelo roda, com a conta e a latência disso, sobre
  // mensagens que uma pessoa já respondeu.
  test("the device reply is caught by the SELECTION, before the model runs", async () => {
    const convId = 964;
    await suDb.inbox.update({
      where: { id: inboxDbId },
      data: { provider: "baileys" },
    });
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    const sent: Array<[number, string]> = [];
    try {
      await flushDebounceJob({
        job: jobFor(convId),
        base: appDb,
        deps: {
          makeModel: () => {
            throw new Error(
              "the model must not run over messages a person already answered",
            );
          },
          makeClient: makeStub({
            pages: [
              page([
                { id: 1, content: "oi" },
                { id: 2, content: "tudo bem?" },
                {
                  id: 3,
                  content: "oi, aqui é a Ana",
                  type: 1,
                  fromDevice: true,
                },
              ]),
            ],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
        },
      });
      expect(sent).toEqual([]);
    } finally {
      await suDb.inbox.update({
        where: { id: inboxDbId },
        data: { provider: null },
      });
    }
  });

  // E O PORTÃO DE POST TEM QUE ENXERGAR A MESMA ROTA (bateria de mutação da rodada 10, m23). Aqui a
  // resposta do aparelho chega DEPOIS da seleção, dentro da corrida do modelo, que é o único momento
  // em que a seleção não pode ter visto nada.
  test("a device reply that lands mid-turn stops the flush from posting", async () => {
    const convId = 965;
    await suDb.inbox.update({
      where: { id: inboxDbId },
      data: { provider: "baileys" },
    });
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    const sent: Array<[number, string]> = [];
    try {
      await flushDebounceJob({
        job: jobFor(convId),
        base: appDb,
        deps: {
          makeModel: () => fakeModel(),
          makeClient: makeStub({
            pages: [
              // A seleção, antes de a atendente pegar o telefone.
              page([{ id: 1, content: "tem alguém?" }]),
              // O re-fetch do portão, depois.
              page([
                { id: 1, content: "tem alguém?" },
                {
                  id: 2,
                  content: "oi, aqui é a Ana",
                  type: 1,
                  fromDevice: true,
                },
              ]),
            ],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
        },
      });
      expect(sent).toEqual([]);
    } finally {
      await suDb.inbox.update({
        where: { id: inboxDbId },
        data: { provider: null },
      });
    }
  });

  // THE COMMAND'S FENCE, in the selection this time (issue #698). `/reset` retires the pending burst
  // and writes a dispensal for its own message id alone, so the messages it withdrew carry no row —
  // and above the floor "no row" means "offer it". Read without this fence, the next flush rebuilds
  // the memory the operator cleared and can re-run a request they took back, which is the P1 that
  // sent the first attempt at this selection back (#690, review round 7).
  test("the selection does not offer back what /reset retired", async () => {
    const convId = 941;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0, resetAtMessageId: 2 },
    });
    const sent: Array<[number, string]> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "cancela o pedido" },
              { id: 2, content: "/reset" },
              { id: 3, content: "oi de novo" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    // The customer is answered, and what reached the model is the message after the command and
    // nothing before it.
    expect(sent.map(([, text]) => text)).toEqual([REPLY]);
    const seen = model.seen.join("\n");
    expect(seen).toContain("oi de novo");
    expect(seen).not.toContain("cancela o pedido");
  });

  // AND THE SPEND VERDICT IS ASKED AGAIN ONCE A MESSAGE CAN BE OWED BELOW THE MARK (issue #698).
  //
  // The flush skips the ceiling when the watermark already covers the payload's last id: "this burst
  // was answered by an earlier attempt, so there is nothing to refuse". That reading is a claim about
  // every message below the mark, and it stops being true the moment the selection stops asking a
  // single number — which is exactly the case this issue creates, a message with no row sitting below
  // a mark another turn moved. Taken, the turn runs the model and its tools with no verdict asked,
  // and withholding the reply afterwards does not unspend it.
  test("over the ceiling, an owed message below the mark still gets the verdict", async () => {
    const convId = 942;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    // The mark covers the job's last id, and message 1 is owed below it: the shape of the retry this
    // issue is about, written directly rather than raced into.
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0, lastHandledMessageId: 2 },
    });
    await suDb.tenant.update({
      where: { id: tenantId },
      data: {
        settings: { spendCeiling: { enabled: true, monthlyInboxUsd: 10 } },
      },
    });
    const monthStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    );
    await suDb.spendCostSnapshot.upsert({
      where: {
        tenantId_source_monthStart: { tenantId, source: "inbox", monthStart },
      },
      create: {
        tenantId,
        source: "inbox",
        monthStart,
        costUsd: 99,
        polledAt: new Date(),
      },
      update: { costUsd: 99, polledAt: new Date() },
    });
    try {
      const sent: Array<[number, string]> = [];
      const model = new CaptureReplyModel(REPLY);
      await flushDebounceJob({
        job: jobFor(convId, { lastMessageId: 2 }),
        base: appDb,
        deps: {
          makeModel: () => model as unknown as BaseChatModel,
          makeClient: makeStub({
            pages: [
              page([
                { id: 1, content: "oi" },
                { id: 2, content: "tudo bem?" },
              ]),
            ],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
        },
      });
      // THE ASSERTION. The turn never ran, because the ceiling was asked before it.
      expect(model.seen).toEqual([]);
    } finally {
      await suDb.tenant.update({
        where: { id: tenantId },
        data: { settings: {} },
      });
      await suDb.spendCostSnapshot.deleteMany({
        where: { tenantId, source: "inbox" },
      });
    }
  });

  // THE OTHER SIDE OF THE ASYMMETRY, and it is the side where the fix undoes itself (issue #698,
  // holdout scenario s9). The test above proves a PERSON's reply closes the burst before it. This one
  // proves OURS does not: our reply closes exactly the messages its turn claimed, and a message it
  // never claimed is still owed afterwards. Read as a boundary, our own outgoing would re-lose every
  // orphan this selection exists to find — and it would do it silently, because the flush would go on
  // answering the newest message every time.
  test("our own reply does not close the message its turn never claimed", async () => {
    const convId = 943;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    // Message 1 is the orphan: nobody claimed it, nothing dispensed it. Message 2 is a burst of ours
    // that was answered, so it carries a claim row and our reply sits at 3.
    await claimReplyBurst({
      tenantId,
      conversationDbId: id,
      toMessageId: 2,
      maxHandledAllowed: 1,
      messageIds: [2],
      initiatedBy: "automatic",
      base: appDb,
    });
    const sent: Array<[number, string]> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "quero abrir um chamado" },
              { id: 2, content: "bom dia" },
              {
                id: 3,
                content: "bom dia!",
                type: 1,
                sender: "agent_bot",
              },
              { id: 4, content: "ainda preciso de ajuda" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(sent.map(([, text]) => text)).toEqual([REPLY]);
    const seen = model.seen.join("\n");
    // The orphan is in the turn, and so is the new message; the one our reply DID claim is not.
    expect(seen).toContain("quero abrir um chamado");
    expect(seen).toContain("ainda preciso de ajuda");
    expect(seen).not.toContain("bom dia");
  });

  // AND BELOW THE PER-MESSAGE FLOOR THE SCALAR STILL DECIDES, WHOLE (issue #698, mutation m7). This
  // is the half of the rule that must NOT change, and it is invisible in every other test here: down
  // there no row was ever written and none ever will be, so "no row" means nothing and the two
  // scalars are the only thing that knows anything. Read by the rule that governs above the floor, a
  // conversation that predates the per-message era would have its whole history offered back to the
  // model on the next message — issue #452 and issue #8, reopened by the fix for #690.
  //
  // Measured as a gap: the mutant that answers `true` here survived the entire suite, 11890 tests,
  // before this test existed.
  test("below the per-message floor the scalars still close the history", async () => {
    const convId = 944;
    await seedConversation(convId, { lastHandledMessageId: 5 });
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    // The era starts at 5: everything at or below it belongs to the scalars, whatever rows say.
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 5 },
    });
    const sent: Array<[number, string]> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeStub({
          pages: [
            page([
              { id: 3, content: "pergunta antiga" },
              { id: 4, content: "outra antiga" },
              { id: 5, content: "a última antiga" },
              { id: 6, content: "pergunta de hoje" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(sent.map(([, text]) => text)).toEqual([REPLY]);
    const seen = model.seen.join("\n");
    expect(seen).toContain("pergunta de hoje");
    expect(seen).not.toContain("pergunta antiga");
    expect(seen).not.toContain("outra antiga");
    expect(seen).not.toContain("a última antiga");
  });

  // AND "AGENT BOT" IS NOT THE SAME AS "OURS" (PR #701, review round 1). The exemption exists because
  // our own reply is already recorded, message by message, in the claim rows. Another AgentBot on the
  // same conversation writes nothing here: its reply closes what it answered and this runtime has no
  // record of it at all. Exempting every bot reads that reply as ours, so the messages it answered
  // come back as owed the moment the conversation returns to us.
  test("another AgentBot's reply closes the burst before it, like a person's", async () => {
    const convId = 945;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    const sent: Array<[number, string]> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      // `jobFor` carries agentBotId 9, which is this tenant's bot; 77 below is somebody else's.
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "quero abrir um chamado" },
              { id: 2, content: "é urgente" },
              {
                id: 3,
                content: "abri o chamado 42 pra você",
                type: 1,
                sender: "agent_bot",
                senderId: 77,
              },
              { id: 4, content: "obrigado, e qual o prazo?" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(sent.map(([, text]) => text)).toEqual([REPLY]);
    const seen = model.seen.join("\n");
    expect(seen).toContain("qual o prazo");
    expect(seen).not.toContain("quero abrir um chamado");
    expect(seen).not.toContain("é urgente");
  });

  // AND UMA SAÍDA SEM DONO NÃO É FRONTEIRA (PR #701, review round 1, segunda forma). A regra anda
  // sobre evidência, nunca sobre silêncio: uma página que não atribuiu a saída pode estar descrevendo
  // uma resposta NOSSA, e lê-la como de terceiro silencia um cliente que ninguém respondeu, que é o
  // defeito desta issue chegando pelo conserto dela. O caminho de recuperação de entrega torna esse
  // custo permanente, e é lá que a assimetria foi medida.
  test("an outgoing the page did not attribute is not a boundary", async () => {
    const convId = 946;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    const sent: Array<[number, string]> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "tem alguém?" },
              // Sem `sender`: a resposta automática de fora de horário, que a página não atribui.
              {
                id: 2,
                content: "estamos fora do horário de atendimento",
                type: 1,
              },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(sent.map(([, text]) => text)).toEqual([REPLY]);
    expect(model.seen.join("\n")).toContain("tem alguém?");
  });

  // E O PORTÃO DO FLUSH PERGUNTA O MESMO (PR #701, review round 1, mutante m13). A pessoa responde
  // ENQUANTO o turno roda: a seleção que montou a rajada é de antes, e o re-fetch do portão é de
  // depois. Perguntando só "chegou algo mais novo?", o portão vê a cerca ter tirado a rajada inteira
  // da seleção e lê esse vazio como "ninguém veio depois de mim", postando por cima de quem
  // respondeu.
  test("a person who answers mid-turn stops the flush from posting", async () => {
    const convId = 947;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    const sent: Array<[number, string]> = [];
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => fakeModel(),
        makeClient: makeStub({
          pages: [
            // A seleção, antes da resposta humana.
            page([{ id: 1, content: "tem alguém?" }]),
            // O re-fetch do portão, depois dela.
            page([
              { id: 1, content: "tem alguém?" },
              {
                id: 2,
                content: "oi, sou a Ana do suporte",
                type: 1,
                sender: "user",
                senderId: 41,
              },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(sent).toEqual([]);
  });

  // ...E QUEM RESPONDEU FECHA A RAJADA, em vez de deixá-la pendurada (issue #703). O teste acima
  // afirma o silêncio, que é a metade fácil: os dois portões produzem silêncio. A metade que faltava
  // é a CONTABILIDADE, e ela depende de qual recusa foi.
  //
  // `superseded` significa "chegou mensagem nova, e o flush dela está armado", e por isso não avança
  // a marca, não grava dispensa e não liquida o ledger: a rajada inteira vai ser respondida de novo.
  // Quando quem fechou foi uma PESSOA, nada disso é verdade — ninguém vem atrás. A rajada ficava sem
  // marca e sem linha, e a entrega presa que ela estava resgatando continuava `DEAD`, reportada como
  // cliente que ninguém atendeu e elegível para recuperação, que replaya o turno inteiro numa
  // conversa já atendida.
  test("a burst a PERSON answered is closed, not left pending", async () => {
    const convId = 969;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    // A entrega da mensagem 1, morta por uma queda de processo: é exatamente o que reler a thread
    // resgata, e o que esta recusa tem que fechar.
    const presa = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `answered-elsewhere-${process.pid}`,
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
      job: jobFor(convId, { lastMessageId: 1 }),
      base: appDb,
      deps: {
        makeModel: () => fakeModel(),
        makeClient: makeStub({
          pages: [
            // A seleção, antes de a atendente responder.
            page([{ id: 1, content: "tem alguém?" }]),
            // O re-fetch do portão, depois dela. A atribuição NÃO muda: sem isso o recheck de posse
            // fecharia antes, com `taken-over`, que é outro caminho e já faz a coisa certa.
            page([
              { id: 1, content: "tem alguém?" },
              {
                id: 2,
                content: "oi, sou a Ana do suporte",
                type: 1,
                sender: "user",
                senderId: 41,
              },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    // O bot não fala por cima da pessoa: isto é o que já valia.
    expect(sent).toEqual([]);
    // E a rajada fica FECHADA. A marca passa por ela.
    const conv = await suDb.conversation.findUniqueOrThrow({
      where: { id },
      select: { lastHandledMessageId: true },
    });
    expect(conv.lastHandledMessageId).toBe(1);
    // A mensagem carrega a palavra que diz o que houve: ninguém a respondeu por nós.
    expect(
      await suDb.messageReplyClaim.findFirst({
        where: { conversationId: id, messageId: 1 },
        select: { reason: true },
      }),
    ).toEqual({ reason: "DISPENSED" });
    // E a entrega presa sai da lista de perdas, em vez de ser replayada numa conversa atendida.
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: presa.id },
          select: { status: true },
        })
      ).status,
    ).toBe("PROCESSED");
    // E A LINHA QUE FECHA A PERDA DIZ QUAL DAS DUAS COISAS ACONTECEU (issue #703, bateria de mutação,
    // m13). O alerta da perda já foi disparado e não se recolhe, então esta linha é a única coisa que
    // o operador tem para saber como aquilo terminou. Nós não respondemos nada aqui: dizer
    // `answered_late` entregaria a ele uma resolução que ninguém escreveu, que é exatamente a mentira
    // por causa da qual o vocabulário de liquidação foi partido em `answered` e `consumed`.
    const linha = await correctionLine(convId);
    expect((linha.detail as Record<string, unknown>).outcome).toBe(
      "consumed_late",
    );

    await clearFlowLog(suDb, { conversationId: id });
    await suDb.chatwootWebhookDelivery.delete({ where: { id: presa.id } });
  });

  // O CONTROLE QUE MANTÉM AS DUAS PALAVRAS SEPARADAS (issue #703). O conserto acima é uma palavra
  // nova, e o jeito de ele se desfazer é alguém colapsar as duas de volta num `superseded` só. Aqui
  // quem fecha é uma mensagem NOVA do cliente, e aí a marca tem que ficar exatamente onde estava: o
  // flush rearmado responde a rajada inteira, e avançar aqui declararia atendida uma mensagem que
  // ninguém leu.
  test("a burst superseded by a NEWER message is left where it was", async () => {
    const convId = 970;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    const sent: Array<[number, string]> = [];
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 1 }),
      base: appDb,
      deps: {
        makeModel: () => fakeModel(),
        makeClient: makeStub({
          pages: [
            page([{ id: 1, content: "tem alguém?" }]),
            // O cliente escreveu de novo no meio do turno.
            page([
              { id: 1, content: "tem alguém?" },
              { id: 2, content: "é urgente" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(sent).toEqual([]);
    const conv = await suDb.conversation.findUniqueOrThrow({
      where: { id },
      select: { lastHandledMessageId: true },
    });
    expect(conv.lastHandledMessageId).toBeNull();
    // E nenhuma linha: a mensagem 1 continua devida, e o flush rearmado a responde com a 2.
    expect(
      await suDb.messageReplyClaim.findFirst({
        where: { conversationId: id, messageId: 1 },
      }),
    ).toBeNull();
  });

  // A CERCA VALE ANTES DA ERA POR MENSAGEM TAMBÉM (PR #701, review round 2, P1). Com o piso da era
  // ainda nulo a seleção era a escalar pura, que não enxerga saída nenhuma, então a rajada saía
  // carregando uma mensagem que a pessoa já tinha respondido — e o portão novo, vendo essa mensagem
  // em ou abaixo da fronteira, recusava a rajada INTEIRA. A mensagem de depois da resposta humana,
  // que ninguém respondeu, morria junto, sem reivindicação e sem reagendamento, e o flush seguinte
  // repetia tudo enquanto aquele histórico estivesse visível.
  test("the foreign-reply fence applies before the per-message era starts", async () => {
    const convId = 948;
    await seedConversation(convId);
    const sent: Array<[number, string]> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "tem alguém?" },
              {
                id: 2,
                content: "oi, sou a Ana do suporte",
                type: 1,
                sender: "user",
                senderId: 41,
              },
              { id: 3, content: "e qual o prazo?" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    // A pergunta de depois da resposta humana é respondida, e a de antes dela não.
    expect(sent.map(([, text]) => text)).toEqual([REPLY]);
    const seen = model.seen.join("\n");
    expect(seen).toContain("qual o prazo");
    expect(seen).not.toContain("tem alguém?");
  });

  // UMA REAÇÃO NÃO É UMA RESPOSTA (PR #701, review round 2). O fork guarda o emoji do operador como
  // mensagem de saída de verdade, pública, com remetente `user` e `content_attributes.is_reaction` —
  // e `isHumanAgentMessage` em ../../src/modules/chatwoot/normalize.ts já exclui exatamente essa
  // forma, pelo mesmo motivo: é um aceno, não algo que a equipe disse. Lida como fronteira, ela
  // fecharia toda pergunta anterior a ela.
  test("an operator's emoji reaction is not a reply", async () => {
    const convId = 949;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    const sent: Array<[number, string]> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "consigo remarcar pra sexta?" },
              {
                id: 2,
                content: "👍",
                type: 1,
                sender: "user",
                senderId: 41,
                reaction: true,
              },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(sent.map(([, text]) => text)).toEqual([REPLY]);
    expect(model.seen.join("\n")).toContain("remarcar pra sexta");
  });

  // E O QUE O TETO RECUSOU TEM QUE FICAR RECUSADO (PR #701, review round 2). O acerto anterior fez o
  // teto voltar a ser perguntado quando existe órfã abaixo da marca; a liquidação da recusa, porém,
  // grava a faixa `(marca, último id do job]`, que não cobre nada abaixo da marca. A órfã recusada
  // ficava sem linha, e o primeiro flush com orçamento de novo executava o pedido que a recusa tinha
  // acabado de retirar.
  test("what the ceiling refused stays refused, including below the mark", async () => {
    const convId = 950;
    await seedConversation(convId, { lastHandledMessageId: 2 });
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    const monthStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    );
    await suDb.tenant.update({
      where: { id: tenantId },
      data: {
        settings: { spendCeiling: { enabled: true, monthlyInboxUsd: 10 } },
      },
    });
    await suDb.spendCostSnapshot.upsert({
      where: {
        tenantId_source_monthStart: { tenantId, source: "inbox", monthStart },
      },
      create: {
        tenantId,
        source: "inbox",
        monthStart,
        costUsd: 99,
        polledAt: new Date(),
      },
      update: { costUsd: 99, polledAt: new Date() },
    });
    const sent: Array<[number, string]> = [];
    const client = () =>
      makeStub({
        pages: [
          page([
            { id: 1, content: "me manda a segunda via do boleto" },
            { id: 2, content: "obrigado" },
          ]),
        ],
        sent,
        calls: { getMessages: 0 },
      });
    try {
      await flushDebounceJob({
        job: jobFor(convId, { lastMessageId: 2 }),
        base: appDb,
        deps: {
          makeModel: () => fakeModel(),
          makeClient: client(),
          checkpointer: new MemorySaver(),
        },
      });
    } finally {
      await suDb.tenant.update({
        where: { id: tenantId },
        data: { settings: {} },
      });
      await suDb.spendCostSnapshot.deleteMany({
        where: { tenantId, source: "inbox" },
      });
    }
    // Com orçamento de novo, o pedido retirado não é executado.
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 2 }),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: client(),
        checkpointer: new MemorySaver(),
      },
    });
    expect(model.seen.join("\n")).not.toContain("segunda via do boleto");
  });

  // E O LEDGER FECHA O MESMO CONJUNTO QUE A RECUSA CONSUMIU (PR #701, review round 3). A recusa do
  // teto passou a poder decidir sobre uma órfã ABAIXO da marca; o ledger continuava fechando por
  // faixa a partir da marca, então a entrega daquela órfã ficava DEAD, reportada como perda que
  // ninguém atendeu e elegível para recuperação, apesar de a recusa já ter decidido sobre ela.
  test("the ceiling's refusal closes the ledger row of the orphan it consumed", async () => {
    const convId = 952;
    await seedConversation(convId, { lastHandledMessageId: 2 });
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    // A entrega da órfã, parada e reportada como perda.
    const reported = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `ceiling-orphan-${process.pid}`,
        event: "message_created",
        status: "DEAD",
        processedAt: new Date(Date.now() - 60_000),
        receivedAt: new Date(Date.now() - 120_000),
        conversationId: convId,
        inboundMessageId: 1,
      },
      select: { id: true },
    });
    const monthStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    );
    await suDb.tenant.update({
      where: { id: tenantId },
      data: {
        settings: { spendCeiling: { enabled: true, monthlyInboxUsd: 10 } },
      },
    });
    await suDb.spendCostSnapshot.upsert({
      where: {
        tenantId_source_monthStart: { tenantId, source: "inbox", monthStart },
      },
      create: {
        tenantId,
        source: "inbox",
        monthStart,
        costUsd: 99,
        polledAt: new Date(),
      },
      update: { costUsd: 99, polledAt: new Date() },
    });
    try {
      await flushDebounceJob({
        job: jobFor(convId, { lastMessageId: 2 }),
        base: appDb,
        deps: {
          makeModel: () => fakeModel(),
          makeClient: makeStub({
            pages: [
              page([
                { id: 1, content: "me manda a segunda via" },
                { id: 2, content: "obrigado" },
              ]),
            ],
            sent: [],
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
        },
      });
    } finally {
      await suDb.tenant.update({
        where: { id: tenantId },
        data: { settings: {} },
      });
      await suDb.spendCostSnapshot.deleteMany({
        where: { tenantId, source: "inbox" },
      });
    }
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: reported.id },
          select: { status: true },
        })
      ).status,
    ).toBe("PROCESSED");
  });

  // ...E NÃO FECHA A DE QUEM ELA NÃO CONSUMIU (PR #701, review round 12). Alcançar a órfã abaixo da
  // marca exigiu esticar a faixa do ledger para baixo, e faixa pega tudo o que está NO MEIO: a
  // entrega que outro turno reivindicou e morreu segurando fica entre a órfã e o topo da rajada, a
  // seleção a deixou de fora de propósito, e a recusa não decidiu nada sobre ela. Fechada por faixa,
  // ela vira PROCESSED, que é o único estado que a varredura nunca mais olha — uma perda real
  // apagada do relatório. Este exit é o único dos quatro que leu a página antes de decidir, então é
  // o único que pode nomear os membros, e nomear é o que separa os dois casos.
  test("the ceiling's refusal does not close a delivery it never consumed", async () => {
    const convId = 966;
    await seedConversation(convId, { lastHandledMessageId: 3 });
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    // A 2 é de OUTRO turno: reivindicada, e o processo morreu antes de enviar. A seleção a exclui
    // pela linha de claim, e a entrega dela é perda de verdade, que a varredura ainda tem que
    // reportar.
    await suDb.messageReplyClaim.create({
      data: {
        tenantId,
        conversationId: id,
        messageId: 2,
        reason: "CLAIMED",
      },
    });
    const daOutraTurma = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `ceiling-notmine-${process.pid}`,
        event: "message_created",
        status: "DEAD",
        processedAt: new Date(Date.now() - 60_000),
        receivedAt: new Date(Date.now() - 120_000),
        conversationId: convId,
        inboundMessageId: 2,
      },
      select: { id: true },
    });
    // A órfã que a recusa CONSOME de fato, abaixo da marca e sem linha nenhuma.
    const daOrfa = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `ceiling-orphan2-${process.pid}`,
        event: "message_created",
        status: "DEAD",
        processedAt: new Date(Date.now() - 60_000),
        receivedAt: new Date(Date.now() - 120_000),
        conversationId: convId,
        inboundMessageId: 1,
      },
      select: { id: true },
    });
    const monthStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    );
    await suDb.tenant.update({
      where: { id: tenantId },
      data: {
        settings: { spendCeiling: { enabled: true, monthlyInboxUsd: 10 } },
      },
    });
    await suDb.spendCostSnapshot.upsert({
      where: {
        tenantId_source_monthStart: { tenantId, source: "inbox", monthStart },
      },
      create: {
        tenantId,
        source: "inbox",
        monthStart,
        costUsd: 99,
        polledAt: new Date(),
      },
      update: { costUsd: 99, polledAt: new Date() },
    });
    try {
      await flushDebounceJob({
        job: jobFor(convId, { lastMessageId: 4 }),
        base: appDb,
        deps: {
          makeModel: () => fakeModel(),
          makeClient: makeStub({
            pages: [
              page([
                { id: 1, content: "me manda a segunda via" },
                { id: 2, content: "e o boleto de março" },
                { id: 3, content: "obrigado" },
                { id: 4, content: "ainda preciso disso" },
              ]),
            ],
            sent: [],
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
        },
      });
    } finally {
      await suDb.tenant.update({
        where: { id: tenantId },
        data: { settings: {} },
      });
      await suDb.spendCostSnapshot.deleteMany({
        where: { tenantId, source: "inbox" },
      });
    }
    const estado = async (rowId: bigint) =>
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: rowId },
          select: { status: true },
        })
      ).status;
    // A órfã que a recusa consumiu fecha.
    expect(await estado(daOrfa.id)).toBe("PROCESSED");
    // A do turno que morreu segurando a 2 continua sendo perda, e continua no relatório.
    expect(await estado(daOutraTurma.id)).toBe("DEAD");
  });

  // O LADO DE DENTRO DA MESMA CERCA (PR #701, review round 13). A rodada 9 tirou a linha importada da
  // FRONTEIRA, que é a metade de saída; esta é a de entrada. O importador não dispara webhook, então
  // a pergunta que ele traz de volta não tem reivindicação nem dispensa — e acima do piso "sem linha"
  // é exatamente o que esta seleção lê como "ainda devida". A escalar cobria isso por acidente, e
  // esta PR é que ensinou a seleção a passar por baixo dela: reaberta, a pergunta do ano passado
  // volta para o modelo e as ferramentas dela rodam de novo.
  test("an imported question from the history is not an unanswered one", async () => {
    const convId = 967;
    await seedConversation(convId, { lastHandledMessageId: 2 });
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    const sent: Array<[number, string]> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 3 }),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeStub({
          pages: [
            page([
              // Retaguarda que o importador trouxe: id de hoje, conversa do ano passado, sem linha
              // nenhuma e abaixo da marca que a mensagem real empurrou.
              { id: 1, content: "cancela meu plano", imported: true },
              { id: 2, content: "obrigado", imported: true },
              // A mensagem de verdade, que é a que o cliente está esperando.
              { id: 3, content: "bom dia, queria remarcar" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(sent.map(([, text]) => text)).toEqual([REPLY]);
    const seen = model.seen.join("\n");
    expect(seen).toContain("queria remarcar");
    expect(seen).not.toContain("cancela meu plano");
  });

  // E DOS DOIS LADOS DO PISO, como toda cerca desta seleção. Antes da era por mensagem quem decide é
  // a escalar, que cobre a retaguarda por acidente quando o importador escreve abaixo da marca — e
  // não cobre quando ele escreve acima dela, que é o caso de uma conversa que ainda não tinha marca
  // nenhuma. A pergunta do ano passado é a mesma pergunta nos dois casos.
  test("the import fence applies before the per-message era too", async () => {
    const convId = 968;
    await seedConversation(convId);
    const sent: Array<[number, string]> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 2 }),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "cancela meu plano", imported: true },
              { id: 2, content: "bom dia, queria remarcar" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(sent.map(([, text]) => text)).toEqual([REPLY]);
    const seen = model.seen.join("\n");
    expect(seen).toContain("queria remarcar");
    expect(seen).not.toContain("cancela meu plano");
  });

  // E O PORTÃO DE POSSE FECHA A ÓRFÃ TAMBÉM (PR #701, review round 4). A rodada 3 fez a faixa começar
  // no piso da era, mas o RAMO do contexto que este portão devolve não carregava o campo do piso, e
  // a expressão caía de volta na marca exatamente aqui. O defeito sobrevivia num ramo, calado: a
  // órfã ficava sem linha e voltava como devida assim que a conversa voltasse para o bot.
  test("a closed ownership gate closes the orphan below the mark too", async () => {
    const convId = 953;
    await seedConversation(convId, {
      assigneeType: "User",
      assigneeId: 5,
      lastHandledMessageId: 2,
    });
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 2 }),
      base: appDb,
      deps: {
        makeModel: () => {
          throw new Error("o portão fecha antes de qualquer modelo");
        },
        makeClient: async () => {
          throw new Error("o portão fecha antes de qualquer busca");
        },
        checkpointer: new MemorySaver(),
      },
    });
    // A conversa volta para o bot e uma mensagem nova chega.
    await suDb.conversation.update({
      where: { id },
      data: { assigneeType: null, assigneeId: null, status: "pending" },
    });
    const sent: Array<[number, string]> = [];
    const model = new CaptureReplyModel(REPLY);
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 3 }),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "cancela meu plano" },
              { id: 2, content: "obrigado" },
              { id: 3, content: "voltei" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    const seen = model.seen.join("\n");
    expect(seen).toContain("voltei");
    expect(seen).not.toContain("cancela meu plano");
  });

  // O PORTÃO NÃO PODE HERDAR A ESTRATÉGIA DE CAUDA DE QUEM O CHAMOU (PR #701, review round 5). O
  // clique do operador seleciona a cauda DEPOIS da última saída, e uma saída nossa no meio do turno
  // (o aviso de ferramenta lenta do prepare.ts) esvazia essa cauda: perguntando com o seletor do
  // chamador, o portão vê zero e conclui "ninguém veio depois de mim", postando uma resposta que o
  // cliente já superou. A fronteira também não pega, porque o aviso é NOSSO. A pergunta do portão é
  // sempre a mesma, seja quem for o chamador: existe mensagem ABERTA acima do que eu ia responder?
  test("an ack of ours mid-turn does not hide a newer customer message from the click", async () => {
    const convId = 955;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    const sent: Array<[number, string]> = [];
    // A 2 e o nosso aviso chegam DURANTE a chamada do modelo, que é a janela real: tudo que o portão
    // relê depois é o estado de depois deles.
    let midTurn = false;
    const model = new SideEffectModel(async () => {
      midTurn = true;
    });
    const client = {
      getMessages: async () => {
        return !midTurn
          ? page([{ id: 1, content: "consigo remarcar?" }])
          : page([
              { id: 1, content: "consigo remarcar?" },
              { id: 2, content: "na verdade, deixa pra lá" },
              {
                id: 3,
                content: "só um instante, estou verificando",
                type: 1,
                sender: "agent_bot",
                senderId: 9,
              },
            ]);
      },
      sendMessage: async (conversationId: number, content: string) => {
        sent.push([conversationId, content]);
        return {};
      },
      sendPrivateNote: async () => ({}),
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;

    const clicked = await reengageConversation(
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      id,
      {
        makeModel: () => model,
        makeClient: async () => client,
        checkpointer: new MemorySaver(),
      },
      appDb,
    );

    expect(sent).toEqual([]);
    expect(clicked.outcome).toBe("superseded");
  });

  // QUEM CLASSIFICA A SAÍDA TEM QUE SER QUEM A PRODUZ (PR #701, review round 6). O payload do job é
  // de quando a rajada foi armada; quem envia é `ctx.loaded.agentBotToken`, da persona que o inbox
  // serve AGORA. Religado o inbox nesse meio-tempo, os dois divergem — e classificando pelo payload,
  // o aviso que a persona nova acabou de postar vira saída de terceiro, a fronteira fecha a rajada
  // dela mesma e o portão engole a resposta.
  test("the persona that sends is the one that classifies its own outgoing", async () => {
    const convId = 956;
    const OTHER_BOT = 77;
    const OTHER_INBOX = 78;
    const key2 = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key-2", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent2 = await suDb.agent.create({
      data: {
        tenantId,
        name: "Persona nova",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${key2.id}`,
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
        agentId: agent2.id,
        chatwootAgentBotId: OTHER_BOT,
        accessToken: encryptJson("BOT2"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `db-route2-${process.pid}`,
        name: "Persona nova",
      },
    });
    const inbox2 = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OTHER_INBOX,
        name: "Outro",
        agentId: agent2.id,
      },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "pending",
        inboxId: inbox2.id,
        threadId: threadOf(convId),
        lastEventAt: new Date(),
        replyClaimFloorMessageId: 0,
      },
    });
    const sent: Array<[number, string]> = [];
    let midTurn = false;
    const model = new SideEffectModel(async () => {
      midTurn = true;
    });
    await flushDebounceJob({
      // O payload nomeia o bot ANTIGO, que é o que o job carregava.
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => model,
        makeClient: makeStub({
          pages: [
            page([{ id: 1, content: "consigo remarcar?" }]),
            page([
              { id: 1, content: "consigo remarcar?" },
              {
                id: 2,
                content: "só um instante",
                type: 1,
                sender: "agent_bot",
                senderId: OTHER_BOT,
              },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    void midTurn;
    // O aviso é da própria persona: ele não fecha a rajada dela.
    expect(sent.length).toBe(1);
  });

  // E O TOPO DO LEDGER É O DA RAJADA, não o do payload (PR #701, review round 7). A recusa relê a
  // página, então a rajada recusada pode conter mensagem MAIS NOVA que o `lastMessageId` do job. A
  // dispensa já nomeia todas elas; o ledger, fechando só até o `last` antigo, deixava a entrega da
  // mais nova parada e reportada como perda, enquanto a seleção já a excluía.
  test("the ceiling's refusal closes the ledger row of a message newer than the payload", async () => {
    const convId = 957;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 0 },
    });
    const reported = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `ceiling-newer-${process.pid}`,
        event: "message_created",
        status: "DEAD",
        processedAt: new Date(Date.now() - 60_000),
        receivedAt: new Date(Date.now() - 120_000),
        conversationId: convId,
        // MAIS NOVA que o `lastMessageId` do job abaixo.
        inboundMessageId: 3,
      },
      select: { id: true },
    });
    const monthStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    );
    await suDb.tenant.update({
      where: { id: tenantId },
      data: {
        settings: { spendCeiling: { enabled: true, monthlyInboxUsd: 10 } },
      },
    });
    await suDb.spendCostSnapshot.upsert({
      where: {
        tenantId_source_monthStart: { tenantId, source: "inbox", monthStart },
      },
      create: {
        tenantId,
        source: "inbox",
        monthStart,
        costUsd: 99,
        polledAt: new Date(),
      },
      update: { costUsd: 99, polledAt: new Date() },
    });
    try {
      await flushDebounceJob({
        job: jobFor(convId, { lastMessageId: 2 }),
        base: appDb,
        deps: {
          makeModel: () => fakeModel(),
          makeClient: makeStub({
            pages: [
              page([
                { id: 1, content: "oi" },
                { id: 2, content: "tudo bem?" },
                { id: 3, content: "me manda a segunda via" },
              ]),
            ],
            sent: [],
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
        },
      });
    } finally {
      await suDb.tenant.update({
        where: { id: tenantId },
        data: { settings: {} },
      });
      await suDb.spendCostSnapshot.deleteMany({
        where: { tenantId, source: "inbox" },
      });
    }
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: reported.id },
          select: { status: true },
        })
      ).status,
    ).toBe("PROCESSED");
  });

  // THE CEILING STILL ANSWERS BELOW THE FLOOR, which is where issue #452 keeps living: a deliberate
  // skip writes no row anywhere, so on the messages that predate this conversation's per-message era
  // the watermark is the only thing that knows anything, and it answers unrelaxed.
  //
  // The floor is written here rather than earned, because earning it takes a claim and a claim is
  // what this test needs to be refused.
  test("the handled ceiling answers in full below the per-message floor", async () => {
    const convId = 898;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    await suDb.conversation.update({
      where: { id },
      data: { replyClaimFloorMessageId: 60 },
    });
    const claim = (toMessageId: number, maxHandledAllowed: number | null) =>
      claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId,
        maxHandledAllowed,
        messageIds: [toMessageId],
        initiatedBy: "automatic",
        base: appDb,
      });

    await advanceHandledWatermark({
      tenantId,
      conversationDbId: id,
      toMessageId: 40,
      // Positioning the mark, not reporting a decision: this call closes nothing, and
      // says so explicitly rather than letting a default speak for it (issue #690).
      dispensed: { kind: "messages", messageIds: [] },
      base: appDb,
    });
    // A flush answering above the mark passes `target - 1` and loses to a skip that landed first.
    expect(await claim(30, 29)).toEqual({ won: false, reason: "handled" });
    // A re-engage passes the mark it read on the way IN, so what was already settled when the
    // operator clicked does not refuse it.
    expect(await claim(30, 40)).toEqual({ won: true });
    // A click that read the mark at 30 and found it at 40 by claim time: somebody settled this tail
    // while the model was running.
    expect(await claim(50, 30)).toEqual({ won: false, reason: "handled" });
    // A caller that read NO mark on the way in. Null is that reading, not "no ceiling": a mark
    // stands here now, so it was written after that read and this claim is not entitled to it.
    expect(await claim(50, null)).toEqual({ won: false, reason: "handled" });
  });

  // THE SCALAR CLOSES WHAT NOBODY ANSWERED (issue #690). Two deliveries of one conversation with
  // debounce OFF, serialized since issue #658: the turn that takes the thread first is the NEWER
  // message's, and it loaded the channel before the older one existed — measured 12/12 on that
  // round's holdout, the model's history was `[system, MSG-B]`. The direct path claims ONE message,
  // its own trigger (`claimReply` in ../../src/graph/runtime.ts), so that turn claims 1002 and the
  // column, being a single number, closes 1001 with it. The older message's turn is the only actor
  // in the system that loaded BOTH, and it is exactly the one refused.
  //
  // BOTH GATES REFUSE IT, which is why this asserts on the two in order. `claimed` is asked first
  // (1002 >= 1001), and behind it stands the ceiling: the newer turn advanced the watermark to 1002
  // on its way out, so `handled > maxHandledAllowed` refuses the same claim a second time. A fix
  // that moves only the first leaves the message unanswered for the same reason with a different
  // word in the log.
  //
  // Nothing reopens 1001 afterwards: the watermark moved, the channel keeps it as context only, and
  // no schedule exists for it. If the customer does not write again, that message is never answered
  // and the operator sees nothing, because from the system's side the burst was served.
  test("a newer burst's claim does not close a message no turn answered", async () => {
    const convId = 896;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    const claim = (toMessageId: number, maxHandledAllowed: number | null) =>
      claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId,
        maxHandledAllowed,
        // The direct path's shape: one turn, one message, its own trigger.
        messageIds: [toMessageId],
        initiatedBy: "automatic",
        base: appDb,
      });

    // MSG-B (1002) arrives second and is answered first, by a turn that never had MSG-A. The
    // ceiling is the direct path's own: nothing at or past my message may have been handled.
    expect(await claim(1002, 1001)).toEqual({ won: true });
    await advanceHandledWatermark({
      tenantId,
      conversationDbId: id,
      toMessageId: 1002,
      // Positioning the mark, not reporting a decision: this call closes nothing, and
      // says so explicitly rather than letting a default speak for it (issue #690).
      dispensed: { kind: "messages", messageIds: [] },
      base: appDb,
    });

    // MSG-A (1001), whose turn read `[system, MSG-B, RESP-B, MSG-A]` and is the one that can answer
    // it. No turn has spoken for 1001; a reply that never saw it must not close it.
    expect(await claim(1001, 1000)).toEqual({ won: true });
  });

  // THE SECOND GATE, ISOLATED (issue #690). The test above is refused by `claimed`, which is asked
  // first and hides a ceiling standing right behind it: the newer turn advances the watermark to
  // 1002 on its way out — every outcome but `superseded` does (../../src/graph/runtime.ts) — so
  // `handled > maxHandledAllowed` refuses the same claim a second time, for a different reason.
  // Measured rather than reasoned: before the fix this returned `handled`, so a fix that moved only
  // `claimed` would land exactly here, with the message still unanswered and the word changed in
  // the log.
  //
  // No row is written for 1001 anywhere in here, so the ceiling is the only thing that could refuse.
  test("the handled ceiling no longer refuses a message above the floor", async () => {
    const convId = 897;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    // The conversation as it stands before the two deliveries: everything up to 1000 was decided by
    // the scalar era, and that is where this conversation's floor has to land.
    await advanceHandledWatermark({
      tenantId,
      conversationDbId: id,
      toMessageId: 1000,
      // Positioning the mark, not reporting a decision: this call closes nothing, and
      // says so explicitly rather than letting a default speak for it (issue #690).
      dispensed: { kind: "messages", messageIds: [] },
      base: appDb,
    });
    // MSG-B's turn: claims its own trigger, then moves the mark past BOTH messages.
    expect(
      await claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 1002,
        maxHandledAllowed: 1001,
        messageIds: [1002],
        initiatedBy: "automatic",
        base: appDb,
      }),
    ).toEqual({ won: true });
    await advanceHandledWatermark({
      tenantId,
      conversationDbId: id,
      toMessageId: 1002,
      // Positioning the mark, not reporting a decision: this call closes nothing, and
      // says so explicitly rather than letting a default speak for it (issue #690).
      dispensed: { kind: "messages", messageIds: [] },
      base: appDb,
    });

    // MSG-A's turn. `handled` is 1002 against a ceiling of 1000, which is what used to refuse it.
    expect(
      await claimReplyBurst({
        tenantId,
        conversationDbId: id,
        toMessageId: 1001,
        maxHandledAllowed: 1000,
        messageIds: [1001],
        initiatedBy: "automatic",
        base: appDb,
      }),
    ).toEqual({ won: true });
    // AND THE FLOOR SAT WHERE THE OLD ERA STOPPED, not at zero: 1000 was decided before any row
    // existed, so it stays the scalars' to answer for.
    expect(
      (
        await suDb.conversation.findUniqueOrThrow({
          where: { id },
          select: { replyClaimFloorMessageId: true },
        })
      ).replyClaimFloorMessageId,
    ).toBe(1000);
  });

  // A LOST WATERMARK WRITE MUST NOT COST A SECOND REPLY (issue #452). The claim is written
  // immediately before the send and the watermark only after the turn returns, so a reply that
  // lands and then loses its watermark write leaves the message answered with the mark behind it —
  // the direct path catches that failure and logs it, and a process exit does the same. Selecting
  // from the mark alone, this flush would coalesce the answered message with the newer one and, the
  // target being higher, win the claim and answer it again. The floor is the max of the two.
  test("a message the claim records is not re-answered when the watermark lags", async () => {
    const convId = 895;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    // The state a lost watermark write leaves: message 1 answered (the claim says so), mark behind.
    await suDb.conversation.update({
      where: { id },
      data: { lastRepliedMessageId: 1, lastHandledMessageId: null },
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
              { id: 1, content: "já respondida" },
              { id: 2, content: "a nova" },
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
    // THE BURST'S SIZE IS THE ASSERTION, read off the line the coalescing writes: one message, not
    // two. Selecting from the watermark alone this is 2, and the answered message goes to the model
    // a second time.
    await settleFlowEvents();
    const row = await flowLogRow(suDb, {
      where: { tenantId, threadId: threadOf(convId), stage: "debounce" },
      select: { detail: true },
    });
    expect((row?.detail as { coalesced?: number } | null)?.coalesced).toBe(1);
  });

  // THE SECOND QUESTION THE CLAIM ANSWERS, and the flush needs it too: a burst is selected from
  // ABOVE the watermark, but the mark can move between that selection and the post — a deliberate
  // skip by another delivery (a handoff, an out-of-hours silence) settles those messages without
  // ever writing a reply of ours to claim against. The losing CAS used to say so for free; now it
  // is `requireUnhandled`, asked under the claim's own row lock (issue #452).
  test("a burst handled while the turn ran is not answered", async () => {
    const convId = 893;
    await seedConversation(convId);
    const sent: Array<[number, string]> = [];
    let fetches = 0;
    const client = {
      getMessages: async () => {
        fetches += 1;
        // The supersede re-fetch: the burst is chosen and the claim has not been taken yet.
        if (fetches === 2) {
          const { id } = await suDb.conversation.findFirstOrThrow({
            where: { tenantId, chatwootConversationId: convId },
            select: { id: true },
          });
          await advanceHandledWatermark({
            tenantId,
            conversationDbId: id,
            toMessageId: 1,
            // Positioning the mark, not reporting a decision: this call closes nothing, and
            // says so explicitly rather than letting a default speak for it (issue #690).
            dispensed: { kind: "messages", messageIds: [] },
            base: appDb,
          });
        }
        return page([{ id: 1, content: "oi" }]);
      },
      sendMessage: async (conversationId: number, content: string) => {
        sent.push([conversationId, content]);
        return {};
      },
      sendPrivateNote: async () => ({}),
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;

    const out = await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: async () => client,
        checkpointer: new MemorySaver(),
      },
    });

    expect(out).toEqual({ outcome: "done" });
    expect(fetches).toBe(2);
    expect(sent).toEqual([]);
    // Nothing claimed it either: the burst was settled by whoever moved the mark.
    expect(await replyClaimOf(convId)).toBeNull();
  });

  // ONE CLAIM FOR EVERY POSTING PATH (issue #452). The re-engage button and a flush answer the same
  // burst through different entry points, and the only thing that stops them both sending is that
  // they claim the SAME column. Split the claim per caller — the flush on the watermark, the button
  // on a column of its own — and the two stop contending: an operator clicking while a retry of the
  // same failed burst is in flight gets the customer two replies.
  //
  // Ordered deterministically instead of raced, and stopped at the ONE instant where the claim is
  // the only thing that can answer: the flush runs to completion inside the click's burst selection,
  // and then its watermark write is undone. That is a real state, not a contrivance — the claim is
  // written before the send and the watermark only after the turn returns, so every reply passes
  // through it, and a lost watermark write leaves the conversation there for good. Letting the
  // flush's watermark stand instead makes the test pass with the claim GONE: the click's handled
  // ceiling refuses it on the mark alone, and the mutation that drops the claim's CAS survives.
  test("a flush completing inside an operator's click leaves one reply", async () => {
    const convId = 891;
    await seedConversation(convId);
    const convRow = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    const sent: Array<[number, string]> = [];
    const thread = page([{ id: 1, content: "alguém aí?" }]);
    let flushed: unknown = null;
    let fetches = 0;
    const client = {
      getMessages: async () => {
        fetches += 1;
        // The click's burst selection (its pre-fetch was #1): the tail is about to be chosen, and
        // the flush answers it and claims it before the click's own post gate is reached.
        if (fetches === 2) {
          const before = (
            await suDb.conversation.findUniqueOrThrow({
              where: { id: convRow.id },
              select: { lastHandledMessageId: true },
            })
          ).lastHandledMessageId;
          flushed = await flushDebounceJob({
            job: jobFor(convId),
            base: appDb,
            deps: {
              makeModel: fakeModel,
              makeClient: async () => client,
              checkpointer: new MemorySaver(),
            },
          });
          // Back to the instant between the flush's claim and its watermark write.
          await suDb.conversation.update({
            where: { id: convRow.id },
            data: { lastHandledMessageId: before },
          });
        }
        return thread;
      },
      sendMessage: async (conversationId: number, content: string) => {
        sent.push([conversationId, content]);
        return {};
      },
      sendPrivateNote: async () => ({}),
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;

    const clicked = await reengageConversation(
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      convRow.id,
      {
        makeModel: fakeModel,
        makeClient: async () => client,
        checkpointer: new MemorySaver(),
      },
      appDb,
    );

    expect(flushed).toEqual({ outcome: "done" });
    // The flush took the claim; the click found the burst already claimed and stood down, with no
    // watermark standing to refuse it on the flush's behalf.
    expect(clicked.outcome).toBe("superseded");
    expect(sent).toEqual([[convId, REPLY]]);
    expect(await watermarkOf(convId)).toBeNull();
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
        routeObserved: false,
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
      await flowLogCount(suDb, {
        where: { tenantId, conversationId: conv.id, stage: "delivery" },
      }),
    ).toBe(0);

    await suDb.chatwootWebhookDelivery.delete({ where: { id: stranded.id } });
  });

  // THE LEDGER READS THE LIST THE TURN'S INPUT CAME FROM, not the one the selector produced (issue
  // #576, PR review round 10). The two are identical today — `pendingIncoming` admits a message on
  // `content OR an attachment`, the exact complement of the one branch `renderInboundMessage`
  // returns "" on — so this asks the seam directly, with a `selectPending` that hands the burst a
  // message the real one would have dropped. That is what a drift between those two predicates
  // would look like from in here, and the cost of reading `pending` instead is a message recorded
  // as covered by a turn that never saw it, whose own write-back then finds the record and stays
  // quiet.
  test("the burst separates what rendered from what was selected", async () => {
    const convId = 8942;
    await seedConversation(convId);
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    const burst = await selectAnswerableBurst(
      {
        tenantId,
        instanceId,
        conversationId: convId,
        convDbId: conv.id,
        // Every incoming message, renderable or not — the drift, made explicit.
        selectPending: async (messages) =>
          messages.filter((m) => m.messageType === "incoming" && !m.private),
        settings: {},
        label: "test",
      },
      appDb,
      {
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "tem horário?" },
              // Nothing to render: no content, no attachment. This is the shape the real selector
              // drops, and the shape a voice note takes before its attachment lands (issue #478).
              { id: 2, content: "" },
            ]),
          ],
          sent: [],
          calls: { getMessages: 0 },
        }),
      },
    );

    expect(burst).not.toBeNull();
    // The selector's word: both messages are in the burst, so the watermark advances past both.
    expect(burst?.pending.map((m) => m.id)).toEqual([1, 2]);
    expect(burst?.targetWatermark).toBe(2);
    // The turn's word: only the one that rendered is in what the model reads, and so only that one
    // can be claimed as folded in.
    expect(burst?.inTurn.map((m) => m.id)).toEqual([1]);
    expect(burst?.text).toBe("tem horário?");
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
      await clearFlowLog(suDb, { tenantId });
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
        routeObserved: false,
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
        routeObserved: false,
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
        routeObserved: false,
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
        routeObserved: false,
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
        routeObserved: false,
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
        routeObserved: false,
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

    await clearFlowLog(suDb, { conversationId: await convRowId(convId) });
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

    await clearFlowLog(suDb, { conversationId: await convRowId(convId) });
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
        routeObserved: false,
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
      // Positioning the mark, not reporting a decision: this call closes nothing, and
      // says so explicitly rather than letting a default speak for it (issue #690).
      dispensed: { kind: "messages", messageIds: [] },
      base: appDb,
    });
    const stranded = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `flush-excluded-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        routeObserved: false,
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

    await clearFlowLog(suDb, { conversationId: await convRowId(convId) });
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
        routeObserved: false,
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

  // A PARTIAL REPLY MUST NOT CLOSE THE CONVERSATION (issue #429). The old code kept this rule by
  // accident — a send that failed mid-reply threw, and a throw discards the deferred intent — so
  // reporting instead of throwing is what woke the path up. The cost of getting it wrong: the model
  // called `resolve_conversation` believing it had answered, the customer holds the first balloon
  // and not the rest, and `resolved` is what tells the operator there is nothing left to do.
  //
  // The turn still reports `posted`: the customer HAS part of it, and re-running would send that
  // part twice. The two questions differ and cannot share one answer.
  test("a reply that failed halfway does not resolve the conversation", async () => {
    await withSplitEnabled(async () => {
      await seedConversation(924);
      const sent: Array<[number, string]> = [];
      const toggles: Array<[number, string]> = [];
      let n = 0;
      const client = {
        getMessages: async () =>
          page([{ id: 7, content: "pode encerrar depois de responder" }]),
        sendMessage: async (conversationId: number, content: string) => {
          n += 1;
          // Balloon 1 lands; balloon 2 and the consolidated retry do not.
          if (n >= 2) throw new Error("chatwoot 502");
          sent.push([conversationId, content]);
          return { id: 500 + n };
        },
        toggleStatus: async (conversationId: number, status: string) => {
          toggles.push([conversationId, status]);
          return {};
        },
        toggleTyping: async () => ({}),
      } as unknown as ChatwootClient;

      const out = await flushDebounceJob({
        job: jobFor(924, { lastMessageId: 7 }),
        base: appDb,
        deps: {
          makeModel: () =>
            new ResolveThenReplyModel(
              "Certo!\n\nJá encerro por aqui.",
            ) as unknown as BaseChatModel,
          makeClient: async () => client,
          checkpointer: new MemorySaver(),
          sleep: async () => {},
        },
      });

      expect(out).toEqual({ outcome: "done" });
      // The customer got the first balloon and nothing else...
      expect(sent).toEqual([[924, "Certo!"]]);
      // ...so the conversation stays open. This is the assertion the throw used to make for us.
      expect(toggles).toEqual([]);
    });
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
    // the only write still ahead. Built with the persona token the real loader would hand it (the
    // fixture's `BOT`), because this one instance is handed straight to the flush.
    const client = await makeClient({ botToken: "BOT" });
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

  // ── A balloon that fails mid-reply (issue #429) ────────────────────────────
  //
  // The flush is where the duplication the split can cause is actually reachable, and it is not the
  // path the issue named: there IS no Chatwoot webhook retry (the receiver acks <5s and processes
  // detached, so Chatwoot is handed a 200 and never re-sends). What retries is the WORKER — a throw
  // here bubbles out of `flushDebounceJob` with the watermark unadvanced, so the next attempt
  // coalesces the same burst and answers it again. A reply that threw on its second balloon would
  // therefore put the first balloon in the conversation twice, and run every side-effecting tool the
  // turn chose a second time.
  //
  // Which is why what already landed decides: the turn reports, the watermark moves, and no retry is
  // armed. Written against the flush rather than as a unit test because the unit cannot see the
  // watermark, and the watermark is the whole mechanism.
  // Personifies the fork on the three properties the reconciliation depends on (issue #499): it
  // ASSIGNS an id to what it accepts, it STORES the `content_attributes` the create carried, and it
  // honours `before` when paging. A stub missing any of them sends every reply here down the
  // "cannot prove delivery" road, which is green for the wrong reason.
  function makeFailingStub(opts: {
    // The conversation as it stands before the reply: the customer's own messages, INCOMING like
    // the `page` helper writes them, because this same read is what the flush coalesces from.
    history: Array<{ id: number; content: string }>;
    sent: Array<[number, string]>;
    calls: { getMessages: number };
    failOn: (n: number) => boolean;
  }) {
    let n = 0;
    let nextId = 900;
    const stored: Array<{
      id: number;
      content: string;
      type: number;
      sendId: string | null;
    }> = opts.history.map((m) => ({ ...m, type: 0, sendId: null }));
    const client = {
      getMessages: async (_c: number, q?: { before?: number }) => {
        opts.calls.getMessages += 1;
        const upTo =
          q?.before === undefined
            ? stored
            : stored.filter((m) => m.id < (q.before as number));
        return {
          payload: upTo.map((m) => ({
            id: m.id,
            content: m.content,
            message_type: m.type,
            private: false,
            content_attributes:
              m.sendId === null ? {} : { fazer_ai_send_id: m.sendId },
          })),
        };
      },
      sendMessage: async (
        conversationId: number,
        content: string,
        o?: { sendId?: string },
      ) => {
        n += 1;
        const id = nextId++;
        if (opts.failOn(n)) throw new Error("chatwoot 502");
        opts.sent.push([conversationId, content]);
        stored.push({ id, content, type: 1, sendId: o?.sendId ?? null });
        return { id };
      },
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;
    return async () => client;
  }

  async function withSplitEnabled<T>(fn: () => Promise<T>): Promise<T> {
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
      return await fn();
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { settings: before.settings as object },
      });
    }
  }

  test("a balloon that fails mid-reply does not re-answer the burst", async () => {
    await withSplitEnabled(async () => {
      await seedConversation(920);
      const sent: Array<[number, string]> = [];
      const out = await flushDebounceJob({
        job: jobFor(920, { lastMessageId: 7 }),
        base: appDb,
        deps: {
          makeModel: () =>
            new FakeListChatModel({
              responses: ["Olá!\n\nComo vai?\n\nPosso ajudar?"],
            }) as unknown as BaseChatModel,
          makeClient: makeFailingStub({
            history: [{ id: 7, content: "oi" }],
            sent,
            calls: { getMessages: 0 },
            // The SECOND balloon, with the first already in the conversation.
            failOn: (n) => n === 2,
          }),
          checkpointer: new MemorySaver(),
          sleep: async () => {},
        },
      });

      // Did not throw: the worker arms no retry, so nothing re-sends what landed.
      expect(out).toEqual({ outcome: "done" });
      // And the customer has the whole answer, the remainder consolidated into one send. The first
      // balloon appears exactly once — the assertion the duplication would break.
      expect(sent).toEqual([
        [920, "Olá!"],
        [920, "Como vai?\n\nPosso ajudar?"],
      ]);
      // The watermark moved, which is the mechanical half of "no retry re-answers this burst": left
      // where it was, the next attempt would coalesce the same message again.
      expect(await watermarkOf(920)).toBe(7);
    });
  });

  // THE CASE THE WHOLE DECISION TURNS ON, and the one a passing consolidated retry hides: a balloon
  // landed AND the remainder's retry failed too, so the customer holds a truncated answer that
  // nothing is going to complete.
  //
  // "Nothing is going to complete it" is MEASURED, and it is the opposite of what this file claimed
  // first. A throw here buys no re-answer to fear: `shouldPost` claims the burst with a monotonic
  // CAS (`lastHandledMessageId < toMessageId`) immediately before the first balloon, so the
  // watermark is already 7 when the second send fails, and a worker retry coalesces nothing and
  // posts nothing. Measured against a real Chatwoot on BOTH retry paths — the flush here, and the
  // delivery recovery, whose second pass ran the whole turn and came back "superseded".
  //
  // What the throw did buy was the OPERATOR: `lastError` is written on a throw and on nothing else,
  // and the flush clears it on "posted". So reporting this as plain "posted" erases the only
  // conversation-level sign that a customer is sitting on one of three balloons — measured live,
  // where the fixed code came back `lastError: (none)` on exactly this input while the unfixed code
  // showed the 502. Hence the separate word and the badge the turn writes itself.
  test("a balloon landed and the remainder failed: reported, and the operator is told", async () => {
    await withSplitEnabled(async () => {
      await seedConversation(922);
      // The burst's own delivery died mid-processing and the sweep already reported it, which is
      // what makes the settlement WORD observable (same device as the capped-message test above).
      // Half an answer IS an answer for this question: the customer heard back on this message, so
      // calling it merely `consumed` would tell the loss list nothing ever replied here.
      const strand = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `flush-partial-${process.pid}`,
          event: "message_created",
          status: "DEAD",
          receivedAt: new Date(Date.now() - 60_000),
          claimedAt: new Date(Date.now() - 60_000),
          conversationId: 922,
          inboundMessageId: 7,
        },
        select: { id: true },
      });
      const sent: Array<[number, string]> = [];
      const out = await flushDebounceJob({
        job: jobFor(922, { lastMessageId: 7 }),
        base: appDb,
        deps: {
          makeModel: () =>
            new FakeListChatModel({
              responses: ["Olá!\n\nComo vai?\n\nPosso ajudar?"],
            }) as unknown as BaseChatModel,
          makeClient: makeFailingStub({
            history: [{ id: 7, content: "oi" }],
            sent,
            calls: { getMessages: 0 },
            // The second balloon AND the consolidated retry of the remainder.
            failOn: (n) => n >= 2,
          }),
          checkpointer: new MemorySaver(),
          sleep: async () => {},
        },
      });

      expect(out).toEqual({ outcome: "done" });
      // Half an answer, delivered once — the consolidated retry does not re-send what landed.
      expect(sent).toEqual([[922, "Olá!"]]);
      // Already claimed before the first balloon, which is why no throw could have re-answered it.
      expect(await watermarkOf(922)).toBe(7);
      // THE ASSERTION THE DECISION RESTS ON. The flush clears `lastError` on "posted"; a partial
      // delivery must leave the conversation carrying one instead, or the customer's missing half is
      // invisible everywhere an operator looks.
      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 922 },
        select: { lastError: true, lastErrorAt: true },
      });
      expect(conv.lastError).not.toBeNull();
      expect(conv.lastError).toContain("incompleta");
      expect(conv.lastErrorAt).not.toBeNull();
      expect((await correctionLine(922)).detail).toMatchObject({
        outcome: "answered_late",
      });
      await suDb.chatwootWebhookDelivery.delete({ where: { id: strand.id } });
      await clearFlowLog(suDb, { tenantId });
    });
  });

  // The other side of the asymmetry, and the reason the first test is not simply "never throw".
  // Nothing reached the customer, so there is nothing a retry could duplicate — and the throw is the
  // only way the operator hears about it at all: `lastError` is written on a throw and on nothing
  // else. Swallowed, this would be a customer waiting on an agent that reported success.
  test("a reply where NO balloon landed is a failed turn, and says so", async () => {
    await withSplitEnabled(async () => {
      await seedConversation(921);
      const sent: Array<[number, string]> = [];
      const run = flushDebounceJob({
        job: jobFor(921, { lastMessageId: 7 }),
        base: appDb,
        deps: {
          makeModel: () =>
            new FakeListChatModel({
              responses: ["Olá!\n\nComo vai?"],
            }) as unknown as BaseChatModel,
          makeClient: makeFailingStub({
            history: [{ id: 7, content: "oi" }],
            sent,
            calls: { getMessages: 0 },
            failOn: () => true,
          }),
          checkpointer: new MemorySaver(),
          sleep: async () => {},
        },
      });
      // Awaited: `expect(...).rejects` returns a promise, and an un-awaited one passes whatever the
      // call actually did — the exact shape of green that proves nothing.
      await expect(run).rejects.toThrow();

      expect(sent).toEqual([]);
      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 921 },
        select: { lastError: true },
      });
      expect(conv.lastError).not.toBeNull();
    });
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
      const row = await flowLogRow(suDb, {
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
      const row = await flowLogRow(suDb, {
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

    test("a refused contact closes the orphan below the mark too", async () => {
      // PR #701, review round 3 (P1). O portão decide ANTES de qualquer busca no Chatwoot, então ele
      // não sabe nomear os membros e grava a faixa. A faixa começa na marca, e a órfã que esta PR
      // ensinou a seleção a enxergar mora ABAIXO dela: sem linha, ela volta como devida assim que a
      // autorização voltar, e o turno seguinte executa um pedido que este portão já tinha descartado.
      // A faixa passa a começar no piso da era, que é onde a ausência de linha começa a significar
      // alguma coisa.
      const convId = 951;
      await seedConversation(convId, { lastHandledMessageId: 2 });
      await seedContactOn(convId, 71);
      const { id } = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: convId },
        select: { id: true },
      });
      await suDb.conversation.update({
        where: { id },
        data: { replyClaimFloorMessageId: 0 },
      });
      const sent: Array<[number, string]> = [];
      await flushDebounceJob({
        job: jobFor(convId, { lastMessageId: 2 }),
        base: appDb,
        deps: {
          makeModel: fakeModel,
          makeClient: makeStub({
            pages: [
              page([
                { id: 1, content: "cancela meu plano" },
                { id: 2, content: "obrigado" },
              ]),
            ],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: answering(false, { n: 0 }),
        },
      });
      expect(sent).toEqual([]);
      // Autorização de volta: o pedido descartado não é executado.
      const model = new CaptureReplyModel(REPLY);
      await flushDebounceJob({
        job: jobFor(convId, { lastMessageId: 2 }),
        base: appDb,
        deps: {
          makeModel: () => model as unknown as BaseChatModel,
          makeClient: makeStub({
            pages: [
              page([
                { id: 1, content: "cancela meu plano" },
                { id: 2, content: "obrigado" },
              ]),
            ],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: answering(true, { n: 0 }),
        },
      });
      expect(model.seen.join("\n")).not.toContain("cancela meu plano");
    });

    test("a refused contact closes the ledger row of the orphan too", async () => {
      // PR #701, review round 4 (P2). A dispensa desceu até o piso da era na rodada 3, e o ledger
      // continuou começando na marca: dois limites para uma decisão só. A entrega da órfã ficava
      // parada, reportada como perda que ninguém atendeu e elegível para recuperação, depois de a
      // recusa já ter decidido sobre ela.
      const convId = 954;
      await seedConversation(convId, { lastHandledMessageId: 2 });
      await seedContactOn(convId, 73);
      const { id } = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: convId },
        select: { id: true },
      });
      await suDb.conversation.update({
        where: { id },
        data: { replyClaimFloorMessageId: 0 },
      });
      const reported = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `auth-orphan-${process.pid}`,
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
        job: jobFor(convId, { lastMessageId: 2 }),
        base: appDb,
        deps: {
          makeModel: fakeModel,
          makeClient: makeStub({
            pages: [page([{ id: 2, content: "obrigado" }])],
            sent: [],
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: answering(false, { n: 0 }),
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
          routeObserved: false,
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
          // The concurrent delivery closed message 9 without answering it, which is what
          // this advance reports (issue #690).
          dispensed: { kind: "messages", messageIds: [9] },
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
          routeObserved: false,
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
          routeObserved: false,
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
        // Positioning the mark, not reporting a decision: this call closes nothing, and
        // says so explicitly rather than letting a default speak for it (issue #690).
        dispensed: { kind: "messages", messageIds: [] },
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

  // AND IT CLAIMS NOTHING, which is the other half and the one the issue is about (#452). The
  // watermark advances because the burst was CONSUMED — nothing will answer it again on its own —
  // but no reply left this turn, so the tail is still unanswered and the operator's re-engage is
  // exactly the thing that should be able to answer it. A claim taken before the turn knows whether
  // it will send would mark the burst answered and refuse that click forever, which is the reported
  // bug wearing a different cause.
  test("an empty reply claims nothing, so the tail stays answerable", async () => {
    await seedConversation(808);
    const sent: Array<[number, string]> = [];
    const out = await flushDebounceJob({
      job: jobFor(808),
      base: appDb,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: [""] }),
        makeClient: makeStub({
          pages: [
            page([
              { id: 1, content: "oi" },
              { id: 2, content: "?" },
            ]),
          ],
          sent,
          calls: { getMessages: 0 },
        }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(out).toEqual({ outcome: "done" });
    expect(sent).toEqual([]);
    expect(await watermarkOf(808)).toBe(2);
    expect(await replyClaimOf(808)).toBeNull();
  });

  // THE REPORTED SEQUENCE, END TO END (#452): the flush runs, the turn ends without a reply, and the
  // operator clicks re-engage on a tail nobody answered. Both halves of the fix have to hold at once
  // — the watermark must not refuse the click (it covers the tail), and neither must the claim (the
  // empty turn sent nothing, so it holds no claim).
  test("the tail an empty flush left is answered by the operator's click", async () => {
    const convId = 809;
    await seedConversation(convId);
    const convRow = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    const sent: Array<[number, string]> = [];
    const thread = page([
      { id: 1, content: "oi" },
      { id: 2, content: "alguém aí?" },
    ]);
    const client = {
      getMessages: async () => thread,
      sendMessage: async (conversationId: number, content: string) => {
        sent.push([conversationId, content]);
        return {};
      },
      sendPrivateNote: async () => ({}),
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;

    const flushed = await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: [""] }),
        makeClient: async () => client,
        checkpointer: new MemorySaver(),
      },
    });
    expect(flushed).toEqual({ outcome: "done" });
    expect(sent).toEqual([]);
    // The mark covers the whole tail, which is what made the button report `superseded` forever.
    expect(await watermarkOf(convId)).toBe(2);

    const clicked = await reengageConversation(
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      convRow.id,
      {
        makeModel: fakeModel,
        makeClient: async () => client,
        checkpointer: new MemorySaver(),
      },
      appDb,
    );
    expect(clicked.outcome).toBe("posted");
    expect(sent).toEqual([[convId, REPLY]]);
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

    // A FAILED SEND KEEPS THE CLAIM (issue #452). The template goes out through a raw `sendMessage`
    // with no reconciliation, so a rejection here does not even say whether Chatwoot accepted it
    // first — and the claim is taken before the send precisely so that the scheduler's retry cannot
    // send it a second time to a customer who may already have it. The claim is never given back.
    test("a send that fails keeps the claim, so the retry cannot duplicate it", async () => {
      const convId = 894;
      await seedConversation(convId);
      const verdict = JSON.stringify({
        violated: true,
        categories: ["toxicity"],
        rationale: "abuse",
      });
      const client = {
        getMessages: async () =>
          page([{ id: 1, content: "vocês são uns inúteis" }]),
        sendMessage: async () => {
          throw new Error("chatwoot: 504 gateway timeout");
        },
        sendPrivateNote: async () => ({}),
        toggleTyping: async () => ({}),
      } as unknown as ChatwootClient;

      await expect(
        flushDebounceJob({
          job: jobFor(convId),
          base: appDb,
          deps: {
            makeModel: (cfg: ResolvedModelConfig) =>
              cfg.model === GUARD_MODEL
                ? guardrailModel(async () => ({ content: verdict }))
                : fakeModel(),
            makeClient: async () => client,
            checkpointer: new MemorySaver(),
          },
        }),
      ).rejects.toThrow();

      // Held: nothing here can say the customer did not get the template.
      expect(await replyClaimOf(convId)).toBe(1);
      // And the watermark stays put, so the retry would have had a burst to re-answer had the claim
      // been released — which is what makes this assertion about the claim and not about the burst
      // being gone.
      expect(await watermarkOf(convId)).toBeNull();
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
      // The residual this used to assert is GONE, and the change is what closed it (issue #452). The
      // post gate no longer claims by advancing the watermark — it claims in `lastRepliedMessageId`
      // — so a retirement caught by the ask after the claim leaves the watermark exactly where
      // "stale" says it should be: on a burst nothing answered, which the next flush re-coalesces.
      // That is the rule the outcome was written for; the old value was the CAS leaking through it.
      expect(await watermarkOf(862)).toBeNull();
      // And NOTHING WAS CLAIMED either, because the claim is asked one statement before the send and
      // this turn never got there. The trade the claim makes — a lost reply rather than a risked
      // duplicate — is about a send that FAILED, which is a burst the customer may already hold. A
      // run retired before any send is the opposite case: nothing left, so nothing is owed, and the
      // burst stays answerable by the re-armed flush and by the operator's click.
      expect(await replyClaimOf(862)).toBeNull();
    });
  });
  // A turn that answers with BOTH an attachment and text, retired between the two. The image is with
  // the customer and the words never arrive, so the burst is half answered — and "stale" would hand
  // it to the next flush, which sends that attachment a second time. Same rule as the two branches
  // that already read `images.sent`, and the third place it has to hold.
  describe("with a turn that sends an image before its reply", () => {
    const IMG_URL = "https://cdn.loja.com.br/produtos/camiseta.png";
    const IMG_URL2 = "https://cdn.loja.com.br/produtos/calca.png";
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

    // The image is delivered BEFORE the text (a reply must not swallow the attachment), so a text
    // send that fails after it leaves the customer holding part of the answer even though no balloon
    // landed — which is what makes `delivered: 0` alone the wrong thing to throw on (issue #429).
    // A throw here re-runs the turn and posts that picture a second time. Same rule the attachment-
    // only branch above already keeps, and this is the third site it has to be written at.
    // THE THIRD LEG, and the one the table exists for: the text lands but a promised file does not.
    // Asking only about the reply here is how a conversation closed with the customer holding the
    // words and not the photo they were about. The decision is `mayCloseConversation`, which this
    // proves the call site actually consults (the table proves the rule; adoption is a second test).
    test("an attachment that failed keeps the conversation open even when the text lands", async () => {
      await seedConversation(926);
      const sent: Array<[number, string]> = [];
      const toggles: Array<[number, string]> = [];
      const client = {
        getMessages: async () =>
          page([{ id: 7, content: "manda a foto e encerra" }]),
        sendFileAttachment: async () => {
          throw new Error("chatwoot 502");
        },
        sendMessage: async (conversationId: number, content: string) => {
          sent.push([conversationId, content]);
          return { id: 900 };
        },
        toggleStatus: async (conversationId: number, status: string) => {
          toggles.push([conversationId, status]);
          return {};
        },
        toggleTyping: async () => ({}),
      } as unknown as ChatwootClient;

      const model = {
        invoke: async () => new AIMessage("Aqui está!"),
        bindTools: (_t: unknown) => {
          let n = 0;
          return {
            invoke: async () => {
              n += 1;
              return n === 1
                ? new AIMessage({
                    content: "",
                    tool_calls: [
                      {
                        name: "send_image",
                        args: { url: IMG_URL },
                        id: "call_img",
                      },
                      {
                        name: "resolve_conversation",
                        args: {},
                        id: "call_resolve",
                      },
                    ],
                  })
                : new AIMessage("Aqui está!");
            },
          };
        },
      };

      const out = await flushDebounceJob({
        job: jobFor(926, { lastMessageId: 7 }),
        base: appDb,
        deps: {
          makeModel: () => model as unknown as BaseChatModel,
          makeClient: async () => client,
          checkpointer: new MemorySaver(),
          imageDeps,
        },
      });

      expect(out).toEqual({ outcome: "done" });
      // The words arrived...
      expect(sent).toEqual([[926, "Aqui está!"]]);
      // ...the picture they are about did not, so the attendance is not finished.
      expect(toggles).toEqual([]);
    });

    // THE SAME RULE ON THE ATTACHMENT-ONLY BRANCH, and this half predates #429: a batch where one
    // file lands and another fails already reached `applyDeferredResolve`, because `failed` was read
    // for the throw and not for the close. The customer holds one of the two pictures the agent
    // promised, and `resolved` says the attendance is finished.
    test("a batch where one attachment failed does not resolve the conversation", async () => {
      await seedConversation(925);
      const attachments: string[] = [];
      const toggles: Array<[number, string]> = [];
      const client = {
        getMessages: async () => page([{ id: 7, content: "manda as fotos" }]),
        sendFileAttachment: async (
          _c: number,
          _b: ArrayBuffer,
          name: string,
        ) => {
          // The first picture lands, the second does not.
          if (attachments.length >= 1) throw new Error("chatwoot 502");
          attachments.push(name);
          return {};
        },
        sendMessage: async () => ({}),
        toggleStatus: async (conversationId: number, status: string) => {
          toggles.push([conversationId, status]);
          return {};
        },
        toggleTyping: async () => ({}),
      } as unknown as ChatwootClient;

      // Two pictures and a close, in one response, with no final text: the attachment-only branch.
      const model = {
        invoke: async () => new AIMessage(""),
        bindTools: (_t: unknown) => {
          let n = 0;
          return {
            invoke: async () => {
              n += 1;
              return n === 1
                ? new AIMessage({
                    content: "",
                    tool_calls: [
                      {
                        name: "send_image",
                        args: { url: IMG_URL },
                        id: "call_img_1",
                      },
                      {
                        name: "send_image",
                        args: { url: IMG_URL2 },
                        id: "call_img_2",
                      },
                      {
                        name: "resolve_conversation",
                        args: {},
                        id: "call_resolve",
                      },
                    ],
                  })
                : new AIMessage("");
            },
          };
        },
      };

      const out = await flushDebounceJob({
        job: jobFor(925, { lastMessageId: 7 }),
        base: appDb,
        deps: {
          makeModel: () => model as unknown as BaseChatModel,
          makeClient: async () => client,
          checkpointer: new MemorySaver(),
          imageDeps,
        },
      });

      expect(out).toEqual({ outcome: "done" });
      // One picture reached the customer, so the turn is not a failure...
      expect(attachments).toHaveLength(1);
      // ...and the conversation stays open, because the other one did not.
      expect(toggles).toEqual([]);
    });

    test("a text send that fails after an image is not a failed turn", async () => {
      await seedConversation(923);
      const sent: Array<[number, string]> = [];
      const attachments: string[] = [];
      const client = {
        getMessages: async () => page([{ id: 7, content: "manda a foto" }]),
        sendFileAttachment: async (
          _c: number,
          _b: ArrayBuffer,
          name: string,
        ) => {
          attachments.push(name);
          return {};
        },
        sendMessage: async () => {
          throw new Error("chatwoot 502");
        },
        toggleTyping: async () => ({}),
      } as unknown as ChatwootClient;

      const out = await flushDebounceJob({
        job: jobFor(923, { lastMessageId: 7 }),
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
      expect(attachments).toHaveLength(1);
      expect(sent).toEqual([]);
      // The retry that a throw would arm is what would send that picture again.
      expect(await watermarkOf(923)).toBe(7);
      // AND THE THIRD SHAPE OF A PARTIAL DELIVERY (issue #429), which this branch used to report as
      // plain `posted`: the customer holds the picture and none of the words. "Not a failed turn"
      // and "nothing to tell the operator" are different facts, and reporting it as a clean post
      // makes the flush CLEAR whatever badge the conversation was carrying.
      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 923 },
        select: { lastError: true },
      });
      expect(conv.lastError).toContain("incompleta");
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

  // THE SECOND ASK (issue #146). The webhook's spend gate covers the MESSAGE; the flush runs minutes
  // later and is where the turn actually spends. A tenant that crosses its ceiling inside that
  // window — from its own other conversations, or from this one's earlier burst — would otherwise
  // have an already-armed flush spend past it, and many armed conversations would do it together.
  describe("with the spend ceiling reached between arming and the flush", () => {
    let previousTenantSettings: unknown = null;
    // The OPERATOR'S sentence, deliberately not the shipped default: an expectation written against
    // the defaults object would also pass on a flush that ignored the configuration entirely and
    // hard-coded the same string.
    const CEILING_COPY = "Orçamento do mês esgotado, já chamei alguém.";

    beforeAll(async () => {
      const before = await suDb.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { settings: true },
      });
      previousTenantSettings = before.settings;
      await suDb.tenant.update({
        where: { id: tenantId },
        data: {
          settings: {
            ...(before.settings as object),
            spendCeiling: {
              enabled: true,
              monthlyInboxUsd: 1000,
              overCeilingMessage: CEILING_COPY,
            },
          },
        },
      });
      // The month's figure as the poll would have written it: over the ceiling below (#426).
      await suDb.spendCostSnapshot.create({
        data: {
          tenantId,
          source: "inbox",
          monthStart: new Date(
            Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
          ),
          costUsd: 1200,
          polledAt: new Date(),
        },
      });
    });

    afterAll(async () => {
      await suDb.spendCostSnapshot.deleteMany({ where: { tenantId } });
      await suDb.tenant.update({
        where: { id: tenantId },
        data: { settings: previousTenantSettings as object },
      });
    });

    test("the flush spends nothing, says why, hands off, and counts the burst as handled", async () => {
      await seedConversation(910);
      const sent: Array<[number, string]> = [];
      const toggles: Array<[number, string]> = [];
      const notes: Array<[number, string]> = [];
      const order: string[] = [];
      const out = await flushDebounceJob({
        job: jobFor(910, { lastMessageId: 7 }),
        base: appDb,
        deps: {
          // The assertion is the factory: a flush that reaches the model at all fails here.
          makeModel: () => {
            throw new Error("the model must not be invoked over the ceiling");
          },
          makeClient: makeResolveStub({
            pages: [page([{ id: 7, content: "oi" }])],
            sent,
            calls: { getMessages: 0 },
            toggles,
            notes,
            order,
          }),
          checkpointer: new MemorySaver(),
        },
      });

      expect(out).toEqual({ outcome: "done" });
      // THE WHOLE CONTRACT, not a piece of it. This refusal is the first one the conversation gets,
      // so the customer hears the operator's sentence here or never: the handoff below takes the
      // conversation out of `pending`, and from then on no message of theirs reaches a gate again.
      expect(sent).toEqual([[910, CEILING_COPY]]);
      // ...the conversation goes to the human queue, because unlike a refused contact nobody
      // upstream refused anything, so it would otherwise sit with a bot that will never answer...
      expect(toggles).toEqual([[910, "open"]]);
      // ...and the operator gets the reason, which has to say the handoff HAPPENED. The note is
      // asserted on the clause the handoff decides rather than on the whole rendered string: the
      // digits go through `toLocaleString`, and pinning them here would pin the runner's ICU too.
      expect(notes.length).toBe(1);
      expect(notes[0]?.[0]).toBe(910);
      expect(notes[0]?.[1]).toContain("limite de gasto do mês foi atingido");
      expect(notes[0]?.[1]).toContain("aberta para atendimento humano");
      // The ORDER, which is load-bearing in both directions: the copy leaves before the open,
      // because after it the conversation is no longer the bot's and the fence would rightly
      // withhold it; the note comes last, because it is the only one that can report whether the
      // handoff happened.
      expect(order).toEqual(["message", "toggle", "note"]);
      // The burst counts as handled, so it is not re-flushed into the same wall forever.
      expect(await watermarkOf(910)).toBe(7);
      await clearFlowLog(suDb, { tenantId });
    });

    // A HUMAN CLAIMING THE CONVERSATION WHILE THE GATE DECIDES. The gate at the top of the flush
    // judged the instant before two database reads, and `open` is not a neutral write: it ends the
    // bot's attribution and puts the conversation back in the routing queue, so applying it to a
    // conversation an agent just took pulls it out of their hands.
    //
    // The window is opened where it really is — inside the snapshot read — by an extended client
    // that flips the assignee the first time the ceiling's own query runs. That is the same seam the
    // fail-open test uses, and it is the only one that reproduces the ordering without a sleep.
    test("a human who claims the conversation during the read keeps it", async () => {
      await seedConversation(912);
      let flipped = 0;
      const raced = appDb.$extends({
        query: {
          async $allOperations({ model, operation, args, query }) {
            if (
              model === "SpendCostSnapshot" &&
              operation === "findUnique" &&
              flipped === 0
            ) {
              flipped += 1;
              await suDb.conversation.updateMany({
                where: {
                  tenantId,
                  chatwootInstanceId: instanceId,
                  chatwootConversationId: 912,
                },
                data: { assigneeType: "User", assigneeId: 4242 },
              });
            }
            return query(args);
          },
        },
      }) as unknown as typeof appDb;
      const sent: Array<[number, string]> = [];
      const toggles: Array<[number, string]> = [];
      const notes: Array<[number, string]> = [];
      const out = await flushDebounceJob({
        job: jobFor(912, { lastMessageId: 11 }),
        base: raced,
        deps: {
          makeModel: () => {
            throw new Error("the model must not be invoked over the ceiling");
          },
          makeClient: makeResolveStub({
            pages: [page([{ id: 11, content: "oi" }])],
            sent,
            calls: { getMessages: 0 },
            toggles,
            notes,
          }),
          checkpointer: new MemorySaver(),
        },
      });

      expect(out).toEqual({ outcome: "done" });
      // The window this test is about actually opened; without this the assertion below would pass
      // on a run where the ledger read never happened.
      expect(flipped).toBe(1);
      // The conversation is the human's now, so the gate leaves the status alone and says nothing
      // over their shoulder...
      expect(toggles).toEqual([]);
      expect(sent).toEqual([]);
      // ...but the operator still gets the note, which is the one of the three that a takeover does
      // not withhold: it is invisible to the customer, and a conversation a human just inherited is
      // exactly where the reason for the silence still needs saying. It reports NO handoff, because
      // none happened.
      expect(notes.length).toBe(1);
      expect(notes[0]?.[1]).toContain("limite de gasto do mês foi atingido");
      expect(notes[0]?.[1]).not.toContain("aberta para atendimento humano");
      // ...and the burst still counts as handled, exactly as it does when the gate was already
      // closed on the way in: the ceiling decided about the TENANT, and that holds either way.
      expect(await watermarkOf(912)).toBe(11);
      await clearFlowLog(suDb, { tenantId });
    });

    // A BURST THAT WAS ALREADY ANSWERED IS NOT A BURST TO REFUSE. A claimed job can be retried after
    // an earlier attempt advanced the watermark past this payload's own last id: that attempt
    // answered the burst and died before the scheduler could mark the job done. Over the ceiling,
    // the retry would tell the customer the agent cannot answer, hand the conversation off, and
    // write a refusal, all about a burst the customer already has an answer to.
    test("a burst an earlier attempt already answered is not refused again", async () => {
      await seedConversation(914);
      // What that earlier attempt left behind, and the only trace of it this retry can read.
      await advanceHandledWatermark({
        tenantId,
        conversationDbId: (
          await suDb.conversation.findFirstOrThrow({
            where: { tenantId, chatwootConversationId: 914 },
            select: { id: true },
          })
        ).id,
        toMessageId: 15,
        // Positioning the mark, not reporting a decision: this call closes nothing, and
        // says so explicitly rather than letting a default speak for it (issue #690).
        dispensed: { kind: "messages", messageIds: [] },
        base: appDb,
      });
      const sent: Array<[number, string]> = [];
      const toggles: Array<[number, string]> = [];
      const notes: Array<[number, string]> = [];
      const out = await flushDebounceJob({
        job: jobFor(914, { lastMessageId: 15 }),
        base: appDb,
        deps: {
          makeModel: () => {
            throw new Error("the model must not be invoked over the ceiling");
          },
          makeClient: makeResolveStub({
            // The re-fetch finds the same message, and the watermark is what makes it not pending.
            pages: [page([{ id: 15, content: "oi" }])],
            sent,
            calls: { getMessages: 0 },
            toggles,
            notes,
          }),
          checkpointer: new MemorySaver(),
        },
      });

      expect(out).toEqual({ outcome: "done" });
      expect(sent).toEqual([]);
      expect(toggles).toEqual([]);
      expect(notes).toEqual([]);
      // ...and no refusal line, because nothing was refused.
      await settleFlowEvents();
      const rows = await flowLogRows(suDb, {
        // Scoped to this flush's own thread, not to the tenant: the fixture is shared with the
        // refusals above, and a tenant-wide read would be asserting about their rows too.
        where: { tenantId, threadId: threadOf(914), stage: "spend_ceiling" },
        select: { level: true },
      });
      expect(rows).toEqual([]);
      await clearFlowLog(suDb, { tenantId });
    });

    // THE COMMAND, LANDING ON THE REFUSAL. `/reset` retires the burst, and a flush already claimed is
    // past every cancel — the same window the turn path fences with `stillWanted`. Ownership cannot
    // stand in for it here: the reset hands the conversation BACK to the bot, so the gate says yes
    // at exactly the moment the command has said no. Nothing may be said, nothing reopened, and the
    // burst must not be declared handled: it was withdrawn, not answered.
    test("a burst retired while claimed is not told about the ceiling", async () => {
      await seedConversation(913);
      const thread = threadOf(913);
      const row = await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "DEBOUNCE",
          dedupeKey: debounceDedupeKey(thread),
          status: "CLAIMED",
          runAt: new Date(),
          payload: {
            threadId: thread,
            agentBotId: 9,
            burstStartedAt: 1,
            lastMessageId: 13,
          },
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
      const toggles: Array<[number, string]> = [];
      const notes: Array<[number, string]> = [];
      const out = await flushDebounceJob({
        job: {
          ...jobFor(913, { lastMessageId: 13 }),
          id: row.id,
          claimSeq: row.claimSeq,
        },
        base: appDb,
        deps: {
          makeModel: () => {
            throw new Error("the model must not be invoked over the ceiling");
          },
          makeClient: makeResolveStub({
            pages: [page([{ id: 13, content: "oi" }])],
            sent,
            calls: { getMessages: 0 },
            toggles,
            notes,
          }),
          checkpointer: new MemorySaver(),
        },
      });

      expect(out).toEqual({ outcome: "done" });
      expect(sent).toEqual([]);
      expect(toggles).toEqual([]);
      expect(notes).toEqual([]);
      // ...AND NO LINE, which is the half the acts above do not cover. The refusal is a write like
      // the other three: `over` is `error` severity, so the line pages the alert channels, and the
      // announcement CLAIMS the notice window as it decides — a line about a withdrawn burst would
      // also swallow the window a real refusal needs later. The shape of the row this asserts the
      // absence of is proved by the refusals in the sibling tests above.
      await settleFlowEvents();
      const rows = await flowLogRows(suDb, {
        // This flush's own thread, not the tenant: the fixture is shared with those refusals.
        where: { tenantId, threadId: threadOf(913), stage: "spend_ceiling" },
        select: { level: true },
      });
      expect(rows).toEqual([]);
      // The one that outlives the command: the burst is still the customer's.
      expect(await watermarkOf(913)).toBeNull();
      await clearFlowLog(suDb, { tenantId });
    });

    // ONE LINE PER REFUSED BURST, not one per attempt at it. Advancing the watermark is the LAST
    // thing the refusing branch does and it is a database write, so a flush that says its piece and
    // then dies is re-pended by the scheduler and runs again on the same burst — a second `error`
    // line and a second page to the alert channels about one refusal.
    //
    // The retry is modelled by putting the conversation back in the state a crashed settlement
    // leaves it in: the copy went out, the watermark did not move. Running the same job again from
    // there is exactly what the worker does.
    test("a burst refused twice by a retried job is one line, not two", async () => {
      await seedConversation(916);
      const sent: Array<[number, string]> = [];
      const toggles: Array<[number, string]> = [];
      const notes: Array<[number, string]> = [];
      const run = () =>
        flushDebounceJob({
          job: jobFor(916, { lastMessageId: 19 }),
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error("the model must not be invoked over the ceiling");
            },
            makeClient: makeResolveStub({
              pages: [page([{ id: 19, content: "oi" }])],
              sent,
              calls: { getMessages: 0 },
              toggles,
              notes,
            }),
            checkpointer: new MemorySaver(),
          },
        });

      expect(await run()).toEqual({ outcome: "done" });
      // What the crash left behind: settled nothing.
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: 916 },
        data: { lastHandledMessageId: null },
      });
      expect(await run()).toEqual({ outcome: "done" });

      await settleFlowEvents();
      const rows = await flowLogRows(suDb, {
        where: { tenantId, threadId: threadOf(916), stage: "spend_ceiling" },
        select: { level: true },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.level).toBe("error");
      // The customer hears it once too, which is the notice cooldown rather than this key: two
      // fences over one retry, and both are asserted because either one alone would pass while the
      // other was broken.
      expect(sent).toHaveLength(1);
      await clearFlowLog(suDb, { tenantId });
    });

    // NOTHING TO ANSWER ⇒ NOTHING TO REFUSE, and the watermark cannot see this one. The burst was
    // never answered — an earlier attempt did not run — but the message it armed on is gone from the
    // thread, or renders to no answerable text. Without the ceiling that burst reaches
    // `coalesceAndRunTurn`, which returns "empty" and says nothing to anybody; over it, the refusal
    // would send the operator's sentence to a customer who is not waiting for one and put the
    // conversation in a human's queue over a burst with nothing in it.
    test("a burst with nothing answerable in it is not refused", async () => {
      await seedConversation(915);
      const sent: Array<[number, string]> = [];
      const toggles: Array<[number, string]> = [];
      const notes: Array<[number, string]> = [];
      const out = await flushDebounceJob({
        job: jobFor(915, { lastMessageId: 17 }),
        base: appDb,
        deps: {
          makeModel: () => {
            throw new Error("the model must not be invoked over the ceiling");
          },
          makeClient: makeResolveStub({
            // The message the job armed on is gone from the thread — deleted between the arming and
            // this flush. The other shape of "nothing answerable" (a message with no text and no
            // attachment) reaches the same answer through the same selector, which drops it before
            // it can be rendered.
            pages: [page([])],
            sent,
            calls: { getMessages: 0 },
            toggles,
            notes,
          }),
          checkpointer: new MemorySaver(),
        },
      });

      expect(out).toEqual({ outcome: "done" });
      expect(sent).toEqual([]);
      expect(toggles).toEqual([]);
      expect(notes).toEqual([]);
      // ...and no refusal line, because nothing was refused.
      await settleFlowEvents();
      const rows = await flowLogRows(suDb, {
        where: { tenantId, threadId: threadOf(915), stage: "spend_ceiling" },
        select: { level: true },
      });
      expect(rows).toEqual([]);
      // And the watermark is exactly where an empty burst leaves it outside the ceiling: untouched,
      // because nothing was answered and nothing was withdrawn. The branch that DOES settle it is
      // the one where a real message renders to nothing and never will.
      expect(await watermarkOf(915)).toBeNull();
      await clearFlowLog(suDb, { tenantId });
    });

    test("with handoff off, the burst is still dropped and no status is touched", async () => {
      await suDb.tenant.update({
        where: { id: tenantId },
        data: {
          settings: {
            ...(previousTenantSettings as object),
            spendCeiling: {
              enabled: true,
              monthlyInboxUsd: 1000,
              overCeilingMessage: CEILING_COPY,
              handoffEnabled: false,
            },
          },
        },
      });
      await seedConversation(911);
      const sent: Array<[number, string]> = [];
      const toggles: Array<[number, string]> = [];
      const notes: Array<[number, string]> = [];
      const out = await flushDebounceJob({
        job: jobFor(911, { lastMessageId: 9 }),
        base: appDb,
        deps: {
          makeModel: () => {
            throw new Error("the model must not be invoked over the ceiling");
          },
          makeClient: makeResolveStub({
            pages: [page([{ id: 9, content: "oi" }])],
            sent,
            calls: { getMessages: 0 },
            toggles,
            notes,
          }),
          checkpointer: new MemorySaver(),
        },
      });

      expect(out).toEqual({ outcome: "done" });
      // The copy and the note do NOT depend on the handoff: with the open switched off the customer
      // is the only one who can tell the agent went quiet, and this burst is the last chance to say
      // it — the conversation stays `pending`, but nothing re-delivers the burst already dropped.
      expect(sent).toEqual([[911, CEILING_COPY]]);
      expect(toggles).toEqual([]);
      expect(notes.length).toBe(1);
      expect(notes[0]?.[1]).not.toContain("aberta para atendimento humano");
      expect(await watermarkOf(911)).toBe(9);
      await clearFlowLog(suDb, { tenantId });
    });
  });
});
