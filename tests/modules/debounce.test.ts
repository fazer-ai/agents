import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId, contactInboxThreadId } from "@/graph/checkpointer";
import { stampedBurstStart, stampedSentAt } from "@/graph/markers";
import type { ResolvedModelConfig } from "@/graph/models";
import { buildThreadStateGraph } from "@/graph/thread-state";
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
  FailingModel,
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
  // NOTE: Built from the config it is handed: `toggle_status` is a bot-token endpoint
  // (docs/chatwoot.md), and the real client refuses an empty token before anything leaves the
  // process. A stub that ignored the config would let a caller that forgot the persona token record
  // a handoff that never happened.
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
    // Chatwoot's own `sender.type` ("contact" | "user" | "agent_bot"), which separates our outgoing
    // message from a human agent's. Omitted ⇒ the page names no sender, a shape the serializer
    // really emits.
    sender?: string;
    senderId?: number;
    reaction?: boolean;
    // `content_attributes.external_sender_name`: the fork's mark on a message that came back FROM
    // the WhatsApp session (an attendant typing on the paired phone), with nobody in the `sender`
    // field.
    fromDevice?: boolean;
    // `content_attributes.imported`: a row the history importer backfilled, which carries today's
    // id and last year's conversation.
    imported?: boolean;
    // `created_at`, in seconds. Omitted ⇒ the row has no instant.
    createdAt?: number;
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
        ...(m.createdAt != null ? { created_at: m.createdAt } : {}),
        ...(m.attachments ? { attachments: m.attachments } : {}),
        ...(m.sender
          ? { sender: { id: m.senderId ?? 9, type: m.sender } }
          : {}),
        ...(Object.keys(ca).length > 0 ? { content_attributes: ca } : {}),
      };
    }),
  };
}

// A duck-typed model that records every prompt it sees (same shape as ResolveThenReplyModel).
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
        // NOTE: Split off so the flush asserts a single coalesced send; split has its own test.
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

  // Across a text typed after the reaction too; a new burst starts without the mark.
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
    // NOTE: The earliest reaction of the burst, not the latest arm.
    await arm(true, 23);
    expect(readReactionFrom(await payloadOf())).toBe(20);
    await suDb.schedulerJob.updateMany({
      where: { tenantId, kind: "DEBOUNCE", dedupeKey: key },
      data: { status: "DONE" },
    });
    await arm(false, 22);
    expect(readReactionArmed(await payloadOf())).toBe(false);
    expect(readReactionFrom(await payloadOf())).toBeNull();
    // NOTE: A text that arrives while the reaction's flush RUNS supersedes that turn; the flush it
    // arms still owes the reaction.
    await arm(true, 30);
    await suDb.schedulerJob.updateMany({
      where: { tenantId, kind: "DEBOUNCE", dedupeKey: key },
      data: { status: "CLAIMED" },
    });
    await arm(false, 31);
    expect(readReactionArmed(await payloadOf())).toBe(true);
    expect(readReactionFrom(await payloadOf())).toBe(30);
  });

  // /reset retires the burst, but a flush already CLAIMED is past every cancel, and this one is a
  // queued TURN: coalescing and invoking rewrites the thread the command just cleared, after the
  // operator was told the conversation was started over. The reply is the smaller half.
  //
  // The assertions are the WRITES that outlive the command (the thread claim, the invoke that
  // persists the channel, the watermark that declares the burst handled), not the reads: a read
  // shows only where the fence happens to sit.
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

  // The direct path's ownership gate is not the flush's. That extra read exists because the direct
  // path can wait up to `TURN_LEASE_SECONDS + 5` on another invoke; the flush never waits on the
  // thread (`waitForThreadTurn` is wired only on the direct path) and has its own ownership gate
  // before the turn, so widening that read to it would add a second read per burst with no new
  // window to cover.
  //
  // The boundary is invisible in behaviour: turning the gate's condition into `true` leaves
  // everything else green, so this counts the reads.
  test("issue #688: the flush does not pay the direct path's ownership read", async () => {
    // NOTE: WITH a contact-inbox, or the test is vacuous: the gate lives inside the
    // attendance-boundary block, which runs only when the conversation has one, and the default
    // null passes even with the gate widened to every turn.
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

    // NOTE: The burst was answered as usual...
    expect(out).toEqual({ outcome: "done" });
    expect(sent.length).toBe(1);
    // NOTE: ...and the direct path's gate was not consulted once.
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

  test("the coalesced turn keeps where its burst started next to its newest instant", async () => {
    await seedConversation(8011);
    const checkpointer = new MemorySaver();
    await flushDebounceJob({
      job: jobFor(8011),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStub({
          pages: [
            page([
              {
                id: 1,
                content: "segue o comprovante",
                createdAt: 1_790_000_000,
              },
              { id: 2, content: "conseguem ver?", createdAt: 1_790_000_040 },
            ]),
          ],
          sent: [],
          calls: { getMessages: 0 },
        }),
        checkpointer,
      },
    });
    const state = await buildThreadStateGraph(checkpointer).getState({
      configurable: { thread_id: threadOf(8011) },
    });
    const human = (
      (state.values as { messages?: BaseMessage[] }).messages ?? []
    ).find((m) => m.getType() === "human");
    expect(stampedBurstStart(human as BaseMessage)?.getTime()).toBe(
      1_790_000_000_000,
    );
    expect(stampedSentAt(human as BaseMessage)?.getTime()).toBe(
      1_790_000_040_000,
    );
  });

  // The fork's default page carries a reaction only when the message it reacts to is among the
  // page's last twenty of the same conversation; `?after=` lists by id with no such window. This
  // stub serves the two reads the way the fork does, so a reaction to an older message (or to one
  // of an earlier conversation) is on the catch-up read and on no default page.
  function makeForkStub(opts: {
    // A function answers each default read in turn, for a page that changes while the model runs.
    latest: unknown | (() => unknown);
    // A function answers each catch-up read by its cursor, for the walk past the fork's cap.
    after: unknown | ((after: number) => unknown);
    sent: Array<[number, string]>;
    reads: Array<{ after?: number }>;
  }) {
    const client = {
      getMessages: async (_conv: number, o?: { after?: number }) => {
        opts.reads.push(o?.after != null ? { after: o.after } : {});
        if (o?.after == null) {
          return typeof opts.latest === "function"
            ? opts.latest()
            : opts.latest;
        }
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
  // that reply closed would be answered again.
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

  // A conversation the agent never answered has no mark, and the flush was armed last by the text
  // typed after the reaction.
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

  // The post gate asks the catch-up read too. A second orphan reaction that arrives while the first
  // one's turn runs is on no default page, and the turn would post over it instead of yielding to
  // the flush it re-armed.
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

  // A failure of the gate's extra read keeps the page it already read. The customer wrote again
  // while the model ran, and the page says so; a failed catch-up must not turn that into a post.
  test("issue #746: a failed catch-up read at the post gate still judges the page", async () => {
    const convId = 7475;
    await seedConversation(convId, { lastHandledMessageId: 2 });
    const sent: Array<[number, string]> = [];
    const reads: Array<{ after?: number }> = [];
    const model = new CaptureReplyModel(REPLY);
    let pages = 0;
    let catchUps = 0;
    await flushDebounceJob({
      job: jobFor(convId, { lastMessageId: 10, reactionArmed: true }),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: makeForkStub({
          latest: () => {
            pages++;
            return pages > 1
              ? page([
                  ...handledHistory.payload.map((m) => ({
                    id: m.id,
                    content: m.content,
                    type: m.message_type,
                  })),
                  { id: 12, content: "esquece, já resolvi" },
                ])
              : handledHistory;
          },
          after: () => {
            catchUps++;
            if (catchUps > 1) throw new Error("chatwoot: 502 bad gateway");
            return page([{ id: 10, content: "❤️", reaction: true }]);
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

  // The claim's own table, asked directly: the paths above prove the gate consults it, this proves
  // what it answers. The claim records WHICH messages we answered, by identity: the same ids
  // collide on the unique index however they are ordered, and a set that OVERLAPS a claimed one
  // loses whole. The follow-up's activation fence needs WHEN we answered, a separate column: the id
  // is a watermark and refuses to move backwards, the instant is not, since a claim below the mark
  // is still our side speaking.
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
    // NOTE: THE RETRY: the same burst claimed twice loses the second time, by identity rather than
    // by order.
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
    // NOTE: Nobody ever claimed 15, and the turn that just read it is the only actor that can
    // answer it: a claim above it does not close it.
    expect(await claim([15])).toEqual({ won: true });
    // AND THE SCALAR DID NOT FOLLOW IT BACKWARDS. Everything still reading that column — the flush's
    // own floor, every conversation below the per-message era — would otherwise treat 16 through 21
    // as unanswered and coalesce them into the next burst.
    expect(await stored()).toBe(21);
  });

  // A DELAYED REDELIVERY AND AN OPERATOR'S CLICK LOOK THE SAME AND ARE OPPOSITE. Both answer a tail
  // the watermark already covers, so arithmetic cannot separate them, and letting it decide would
  // let a redelivery of a message answered long ago overturn the record of its own answer. The
  // caller says which it is, and the word is required so a path added later cannot inherit the
  // forgiving one by omission.
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
    // NOTE: A person looking at the conversation and pressing the button. Overturning that silence
    // is the whole reason the button exists.
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

  // A message answered a while ago, its row still there, the mark well past it, and Chatwoot
  // delivering it a second time. The sequential case, as opposed to two simultaneous deliveries:
  // the first turn is long finished, so nothing is racing and identity is the only thing left that
  // can refuse.
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

  // THE CLICK'S ENTRY-TIME CEILING SURVIVES THE FLOOR. Above the floor the scalars answer nothing
  // for an automatic caller, because every decision up there wrote a row and the rows are read
  // directly. The operator's click is the exception because it IGNORES dispensals on purpose: a
  // skip recorded between reading the mark and claiming is a decision it would otherwise walk
  // straight over, and `docs/debounce.md` requires that skip to refuse the reply.
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

  // A DISPENSAL IS ASKED ABOUT THE IDS, NOT ABOUT THE SPAN THEY COVER. A burst is not dense: the
  // selection drops what renders to nothing, so `[1001, 1005]` spans four ids it does not contain.
  // Asked as an overlap of intervals, a dispensal inside that gap would suppress the whole reply
  // for messages the turn never spoke for.
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

    // NOTE: ...and one that covers only PART of the set says so, because the messages it does not
    // cover are still owed to somebody and the flush comes back for them.
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

  // THE FLOOR IS THE MAX OF BOTH SCALARS, and a conversation where the CLAIM is ahead of the
  // watermark proves it. The claim is written before the send and the watermark after the turn, so
  // a reply whose watermark write was lost leaves exactly this state. Taking `handled` alone would
  // put every message between the two above the floor, where "no row" reads as open, and the bot
  // would answer a stretch it already replied to.
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

  // AND THE FLUSH COMES BACK FOR WHAT IT COULD NOT CLAIM. The selection drops what is already
  // spoken for when it reads, so the only way into a partial conflict is a claim landing INSIDE the
  // turn, which is what the model's side effect does here. Every other `superseded` completes the
  // job because a newer message's own flush is armed; this one has nothing coming for the unclaimed
  // messages, and rescheduling is the only thing that brings a turn back to them.
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

  // AND THE RETRY ANSWERS WHAT NOBODY CLAIMED. The job comes back from a partial conflict, the
  // winning claim wrote `1002` into one of the scalars, and `readAnsweredFloor` is their max, so
  // message 1 sits below it with no claim row and no dispensal row anywhere. The claim would grant
  // it (1 is above this conversation's per-message floor, so neither scalar gate looks), and the
  // selection has to offer it too.
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

  // A DISPENSAL THAT DOES NOT MOVE THE MARK OPENS THE ERA THAT MAKES IT VISIBLE.
  // `dispenseMessagesFromReply` is the only writer of a `DISPENSED` row that deliberately leaves
  // the mark, and on a conversation that never had a claim the floor is null: `readSelectionState`
  // returns empty sets, the selection decides by the scalars alone, and the row is invisible to it
  // while still visible to the all-or-nothing unique index of `claimReplyBurst`. The burst `[1, 2]`
  // would be refused whole, new message included, and `partial` would reschedule into the same
  // state: a loop, with the customer unanswered until the sweep repairs the old delivery.
  test("a dispensal with no floor does not swallow the message beside it", async () => {
    const convId = 935;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    // NOTE: The gate refused the reply to message 1 and left the mark behind on purpose, because
    // its memory is still owed.
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
    // NOTE: Each message's word separates the two decisions: 1 stays silenced by the gate, 2
    // belongs to this pass.
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

  // AND NOTHING AT OR BELOW THE FLOOR, the other half of the same invariant. A redelivery from the
  // old era hits the same closed gate, and the scalars already decided it: a row would only
  // recreate the invisible conflict above, and opening the era for it contradicts
  // `docs/debounce.md`, where at and below the floor no row was written and none will be.
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

    // NOTE: In a mixed set the era starts, but only the message the new era can see gets a row. The
    // one AT the floor stays out with those below: it is the last one the old era decided.
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

  // THE REPLY A PERSON WROTE IS THE FENCE NO ROW RECORDS. Above the per-message floor the selection
  // reads "no row" as "still owed", and a human agent answering a customer writes no row anywhere
  // (`pendingIncoming` reads incoming messages only), so without this fence the thread a person
  // already handled goes back to the model. The rule is asymmetric, and the control below proves
  // the asymmetry rather than a blanket "any outgoing closes everything": OUR own reply must not
  // close the messages its turn did not claim.
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

  // THE SAME FENCE, BY THE PAIRED PHONE. An attendant who replies on the phone paired to the
  // inbox's number never opens the CRM, and the fork stores that echo SENDER-LESS: `senderType` is
  // null, so the clause above sees nothing. The only mark on it is `external_sender_name`.
  //
  // The mark alone is not enough: on a provider that does not reserve its send ids, OUR OWN reply
  // comes back in exactly this shape whenever the send response was lost, and read as somebody
  // else's it would silence a customer nobody answered. So the route is refused off the reserving
  // providers, the same refusal `isDeviceAttendantMessage` makes.
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

  // THE IMPORTER WRITES THE PAST WITH TODAY'S IDS. When a phone is paired, its history enters as
  // new messages: last year's attendant reply gets an id ABOVE the question the customer just sent
  // and matches every clause of the boundary. Read as a reply, it silences that customer, and the
  // operator's whole backlog with it on pairing day. Same exclusion `hasDeviceAttendantShape` makes
  // in the webhook, here where the mark is reachable because this page comes from the database.
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

  // A PRIVATE NOTE IS NOT A REPLY TO THE CUSTOMER. It goes out with sender `user` and an outgoing
  // `message_type`, matching every other boundary clause, and the customer never sees it. Read as a
  // reply, it silences a conversation nobody answered, the asymmetric cost this boundary exists to
  // avoid.
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

  // AND A TEMPLATE A PERSON SENT IS A REPLY. Outside WhatsApp's 24h window it is the only way the
  // team can speak, so treating it as anything else would have the agent answer over them in
  // exactly the conversations that sat idle longest.
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

  // THE FENCE ABOVE THE SCALAR MARK, not only where there is no mark. Before the per-message era
  // the floor is `max(scalar, boundary)`; with only the null-mark case covered, the `Math.max`
  // could go with nothing turning red, and the question the person already answered would go back
  // to the model.
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
    // NOTE: The message BETWEEN the mark and Ana's reply is the one the `Math.max` takes out.
    expect(seen).not.toContain("tem alguém?");
  });

  // WHICH GATE REFUSED MATTERS. There are two: the SELECTION, which decides what enters the burst,
  // and the POST gate, which rechecks after the model. Either alone produces the same silence, so a
  // test that only looks at what was sent passes with either one blind, and blind at the selection
  // the model runs, with its cost and latency, over messages a person already answered.
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

  // AND THE POST GATE HAS TO SEE THE SAME ROUTE. Here the device reply arrives AFTER the selection,
  // during the model run, the only moment the selection cannot have seen anything.
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
              // NOTE: The selection, before the attendant picks up the phone.
              page([{ id: 1, content: "tem alguém?" }]),
              // NOTE: The gate's re-fetch, after.
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

  // THE COMMAND'S FENCE, in the selection. `/reset` retires the pending burst and writes a
  // dispensal for its own message id alone, so the messages it withdrew carry no row, and above the
  // floor "no row" means "offer it". Without this fence the next flush rebuilds the memory the
  // operator cleared and can re-run a request they took back.
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

  // AND THE SPEND VERDICT IS ASKED AGAIN ONCE A MESSAGE CAN BE OWED BELOW THE MARK. The flush skips
  // the ceiling when the watermark already covers the payload's last id ("answered by an earlier
  // attempt, nothing to refuse"). That reading is a claim about every message below the mark, and
  // it is false for a message with no row sitting below a mark another turn moved. Skipped, the
  // turn runs the model and its tools with no verdict asked, and withholding the reply afterwards
  // does not unspend it.
  test("over the ceiling, an owed message below the mark still gets the verdict", async () => {
    const convId = 942;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    // NOTE: The mark covers the job's last id, and message 1 is owed below it: the retry shape,
    // written directly rather than raced into.
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

  // THE OTHER SIDE OF THE ASYMMETRY, where the fence would undo itself. The test above proves a
  // PERSON's reply closes the burst before it; this one proves OURS does not: our reply closes
  // exactly the messages its turn claimed. Read as a boundary, our own outgoing would silently
  // re-lose every orphan this selection exists to find, since the flush would go on answering the
  // newest message every time.
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

  // AND BELOW THE PER-MESSAGE FLOOR THE SCALAR STILL DECIDES, WHOLE. Down there no row was ever
  // written and none ever will be, so "no row" means nothing and the two scalars are the only thing
  // that knows anything. Read by the rule that governs above the floor, a conversation that
  // predates the per-message era would have its whole history offered back to the model on the next
  // message. No other test here sees this half.
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

  // AND "AGENT BOT" IS NOT THE SAME AS "OURS". The exemption exists because our own reply is
  // already recorded, message by message, in the claim rows. Another AgentBot on the same
  // conversation writes nothing here: its reply closes what it answered and this runtime has no
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

  // AND AN OUTGOING WITH NO OWNER IS NOT A BOUNDARY. The rule runs on evidence, never on silence: a
  // page that did not attribute the outgoing may be describing a reply of OURS, and reading it as a
  // third party's silences a customer nobody answered. Delivery recovery makes that cost permanent.
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
              // NOTE: No `sender`: the out-of-hours auto-reply, which the page does not attribute.
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

  // ...AND WHOEVER REPLIED CLOSES THE BURST, instead of leaving it hanging. The test above asserts
  // the silence, which both gates produce; this asserts the BOOKKEEPING. `superseded` means "a new
  // message arrived and its flush is armed", so it moves no mark, writes no dispensal and settles no
  // ledger row. When a PERSON closed it nobody comes after, and a burst left open keeps its stranded
  // delivery `DEAD`, reported as an unanswered customer and eligible for a recovery that replays
  // the whole turn on an attended conversation.
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
    // Message 1's delivery, killed by a process crash: exactly what re-reading the thread
    // rescues, and what this refusal has to close.
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
            // NOTE: The selection, before the attendant replies.
            page([{ id: 1, content: "tem alguém?" }]),
            // NOTE: The gate's re-fetch, after it. The assignment does NOT change: otherwise the
            // ownership recheck closes first with `taken-over`, another path that already does the
            // right thing.
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
    // NOTE: The bot does not talk over the person.
    expect(sent).toEqual([]);
    // And the burst is CLOSED: the mark passes it.
    const conv = await suDb.conversation.findUniqueOrThrow({
      where: { id },
      select: { lastHandledMessageId: true },
    });
    expect(conv.lastHandledMessageId).toBe(1);
    // NOTE: The message carries the word that says what happened: nobody answered it on our behalf.
    expect(
      await suDb.messageReplyClaim.findFirst({
        where: { conversationId: id, messageId: 1 },
        select: { reason: true },
      }),
    ).toEqual({ reason: "DISPENSED" });
    // NOTE: And the stranded delivery leaves the loss list instead of being replayed on an attended
    // conversation.
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: presa.id },
          select: { status: true },
        })
      ).status,
    ).toBe("PROCESSED");
    // AND THE LINE THAT CLOSES THE LOSS SAYS WHICH OF THE TWO HAPPENED. The loss alert
    // already fired and cannot be recalled, so this line is all the operator has to learn how it
    // ended. We answered nothing here: `answered_late` would hand them a resolution nobody wrote,
    // which is why settlement tells `answered` from `consumed`.
    const linha = await correctionLine(convId);
    expect((linha.detail as Record<string, unknown>).outcome).toBe(
      "consumed_late",
    );

    await clearFlowLog(suDb, { conversationId: id });
    await suDb.chatwootWebhookDelivery.delete({ where: { id: presa.id } });
  });

  // THE CONTROL THAT KEEPS THE TWO WORDS APART. Collapsing them back into one `superseded` undoes
  // the test above. Here a NEW customer message closes the turn, so the mark stays exactly where it
  // was: the re-armed flush answers the whole burst, and advancing here would declare handled a
  // message nobody read.
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
            // NOTE: The customer wrote again mid-turn.
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
    // NOTE: And no line: message 1 is still owed, and the re-armed flush answers it with 2.
    expect(
      await suDb.messageReplyClaim.findFirst({
        where: { conversationId: id, messageId: 1 },
      }),
    ).toBeNull();
  });

  // THE FENCE HOLDS BEFORE THE PER-MESSAGE ERA TOO. With the era floor still null the selection is
  // purely scalar and sees no outgoing, so the burst would carry a message the person already
  // answered, and the gate, seeing it at or below the boundary, would refuse the WHOLE burst. The
  // message after the human reply, which nobody answered, would die with it, unclaimed and
  // unrescheduled, and every later flush would repeat that while the history stayed visible.
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
    // NOTE: The question after the human reply is answered, the one before it is not.
    expect(sent.map(([, text]) => text)).toEqual([REPLY]);
    const seen = model.seen.join("\n");
    expect(seen).toContain("qual o prazo");
    expect(seen).not.toContain("tem alguém?");
  });

  // A REACTION IS NOT A REPLY. The fork stores the operator's emoji as a real public outgoing
  // message, with sender `user` and `content_attributes.is_reaction`, and `isHumanAgentMessage` in
  // src/modules/chatwoot/normalize.ts excludes exactly that shape for the same reason: it is a nod,
  // not something the team said. Read as a boundary, it would close every earlier question.
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

  // AND WHAT THE CEILING REFUSED STAYS REFUSED. The ceiling is asked again when an orphan sits
  // below the mark, but settling the refusal by the range `(mark, job's last id]` covers nothing
  // below the mark: the refused orphan would stay rowless, and the first flush with budget again
  // would run the request the refusal withdrew.
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
    // With budget again, the withdrawn request is not run.
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

  // ...AND IT DOES NOT CLOSE THE ONE IT DID NOT CONSUME. Reaching the orphan below the mark
  // stretches the ledger range down, and a range catches everything IN BETWEEN: a delivery another
  // turn claimed and died holding sits between the orphan and the burst's top, the selection left
  // it out on purpose, and the refusal decided nothing about it. Closed by range it becomes
  // PROCESSED, the one state the sweep never looks at again: a real loss erased from the report.
  // This exit is the only one of the four that read the page before deciding, so it can name the
  // members, and naming is what separates the two cases.
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
    // NOTE: 2 belongs to ANOTHER turn: claimed, and the process died before sending. The selection
    // excludes it by its claim row, and its delivery is a real loss the sweep still has to report.
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
    // The orphan the refusal really CONSUMES, below the mark and with no row at all.
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
    // NOTE: The orphan the refusal consumed closes.
    expect(await estado(daOrfa.id)).toBe("PROCESSED");
    // NOTE: The delivery of the turn that died holding 2 is still a loss, and stays in the report.
    expect(await estado(daOutraTurma.id)).toBe("DEAD");
  });

  // THE INBOUND SIDE OF THE SAME FENCE. The imported row is already out of the BOUNDARY, the
  // outgoing half; this is the incoming half. The importer fires no webhook, so the question it
  // brings back has no claim and no dispensal, and above the floor "no row" is exactly what this
  // selection reads as "still owed". Reopened, last year's question goes back to the model and its
  // tools run again.
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
              // NOTE: Backfill the importer brought: today's id, last year's conversation, no row
              // at all, and below the mark the real message pushed.
              { id: 1, content: "cancela meu plano", imported: true },
              { id: 2, content: "obrigado", imported: true },
              // NOTE: The real message, the one the customer is waiting on.
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

  // AND ON BOTH SIDES OF THE FLOOR, like every fence of this selection. Before the per-message era
  // the scalar decides, which covers the backfill by accident when the importer writes below the
  // mark and does not when it writes above it, as on a conversation that had no mark yet. Last
  // year's question is the same question in both cases.
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

  // AND THE OWNERSHIP GATE CLOSES THE ORPHAN TOO. The range starts at the era floor, and the
  // context branch this gate returns has to carry the floor field, or the expression falls back to
  // the mark right here: the orphan stays rowless and comes back as owed once the conversation
  // returns to the bot.
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
    // NOTE: The conversation returns to the bot and a new message arrives.
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

  // THE GATE DOES NOT INHERIT ITS CALLER'S TAIL STRATEGY. The operator's click selects the tail
  // AFTER the last outgoing, and an outgoing of ours mid-turn (the slow-tool notice from
  // src/graph/prepare.ts) empties that tail: asked with the caller's selector, the gate sees zero
  // and concludes "nobody came after me", posting a reply the customer already moved past. The
  // boundary does not catch it either, because the notice is OURS. The gate always asks one
  // question: is there an OPEN message above what I was about to answer?
  test("an ack of ours mid-turn does not hide a newer customer message from the click", async () => {
    const convId = 955;
    await seedConversation(convId);
    const { id } = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    const sent: Array<[number, string]> = [];
    // 2 and our notice arrive DURING the model call, the real window: everything the gate
    // re-reads afterwards is the state after them.
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

  // THE PERSONA THAT PRODUCES THE OUTGOING CLASSIFIES IT. The job payload is from when the burst
  // was armed; the sender is `ctx.loaded.agentBotToken`, the persona the inbox serves NOW. With the
  // inbox rebound in between the two diverge, and classified by the payload, the notice the new
  // persona just posted becomes a third party's outgoing: the boundary closes its own burst and the
  // gate swallows the reply.
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
      // NOTE: The payload names the OLD bot, which is what the job carried.
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
    // NOTE: The notice is the persona's own: it does not close its burst.
    expect(sent.length).toBe(1);
  });

  // AND THE LEDGER'S TOP IS THE BURST'S, not the payload's. The refusal re-reads the page, so the
  // refused burst can hold a message NEWER than the job's `lastMessageId`. The dispensal names them
  // all; a ledger closed only up to the payload's last id would leave the newest one's delivery
  // stuck and reported as a loss while the selection already excludes it.
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
        // NOTE: NEWER than the job's `lastMessageId` below.
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

  // THE CEILING STILL ANSWERS BELOW THE FLOOR: a deliberate skip writes no row anywhere, so on the
  // messages that predate this conversation's per-message era the watermark is the only thing that
  // knows anything, and it answers unrelaxed.
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
      // NOTE: Positioning the mark, not reporting a decision: this call closes nothing, and says so
      // explicitly rather than letting a default speak for it.
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

  // THE SECOND GATE, ISOLATED. The test above is refused by `claimed` first, which hides the
  // ceiling standing right behind it: the newer turn advances the watermark to 1002 on its way out
  // (every outcome but `superseded` does, src/graph/runtime.ts), so `handled > maxHandledAllowed`
  // would refuse the same claim for a different reason. No row is written for 1001 anywhere in
  // here, so the ceiling is the only thing that could refuse.
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
      // NOTE: Positioning the mark, not reporting a decision: this call closes nothing, and says so
      // explicitly rather than letting a default speak for it.
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
      // NOTE: Positioning the mark, not reporting a decision: this call closes nothing, and says so
      // explicitly rather than letting a default speak for it.
      dispensed: { kind: "messages", messageIds: [] },
      base: appDb,
    });

    // NOTE: MSG-A's turn: `handled` is 1002 against a ceiling of 1000, and above the floor that
    // does not refuse it.
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

  // A LOST WATERMARK WRITE MUST NOT COST A SECOND REPLY. The claim is written immediately before
  // the send and the watermark only after the turn returns, so a reply that lands and then loses
  // its watermark write leaves the message answered with the mark behind it (the direct path
  // catches that failure and logs it, and a process exit does the same). Selecting from the mark
  // alone, this flush would coalesce the answered message with the newer one and, the target being
  // higher, win the claim and answer it again. The floor is the max of the two.
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
  // ABOVE the watermark, but the mark can move between that selection and the post. A deliberate
  // skip by another delivery (a handoff, an out-of-hours silence) settles those messages without
  // ever writing a reply of ours to claim against, and `requireUnhandled` asks about it under the
  // claim's own row lock.
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
            // NOTE: Positioning the mark, not reporting a decision: this call closes nothing, and
            // says so explicitly rather than letting a default speak for it.
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

  // ONE CLAIM FOR EVERY POSTING PATH. The re-engage button and a flush answer the same burst
  // through different entry points, and only claiming the SAME column stops both sending: with the
  // claim split per caller, an operator clicking while a retry of the same failed burst is in
  // flight gets the customer two replies. Ordered, not raced: the flush completes inside the click's
  // burst selection and its watermark write is then undone, the real state a lost watermark write
  // leaves. With the flush's watermark left standing the click's handled ceiling refuses on the mark
  // alone, and a mutation that drops the claim's CAS survives.
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
        // NOTE: The click's burst selection (its pre-fetch was the first): the tail is about to be
        // chosen, and the flush answers it and claims it before the click's own post gate is
        // reached.
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
    // Message 1's delivery died mid-processing, so its ledger row sits non-terminal with
    // nothing working it. Message 2 arms a flush that re-reads the WHOLE thread from Chatwoot, so
    // message 1 is in the burst and gets answered. No watermark can express that afterwards, so the
    // turn says so on the row, and the sweep's classifier needs no watermark arithmetic.
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

  // THE LEDGER READS THE LIST THE TURN'S INPUT CAME FROM, not the one the selector produced. The
  // two agree today (`pendingIncoming` admits a message on `content OR an attachment`, the exact
  // complement of the branch where `renderInboundMessage` returns ""), so this asks the seam
  // directly, with a `selectPending` that hands the burst a message the real one would drop.
  // Reading `pending` instead would record a message as covered by a turn that never saw it, whose
  // own write-back then finds the record and stays quiet.
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
              // NOTE: Nothing to render: no content, no attachment. The shape the real selector
              // drops, and the shape a voice note takes before its attachment lands.
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
    // The gate exits decide before any Chatwoot fetch: they advance the watermark from the
    // payload's own lastMessageId and return. A delivery that armed this flush and then died is
    // sitting PROCESSING, and left there it becomes a reported loss for a message the product
    // deliberately declined to answer (a human holds the conversation).
    //
    // The exit knows the burst only as "everything up to this id", which is what its watermark
    // says, so the retirement takes the same range, written at the moment of the decision.
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
    // The same exit, closed by the one state whose settlement may not widen. Chatwoot fans a
    // message to up to two routes (`agent_bots_for`: the assignee bot and the inbox's bot, each
    // with its own delivery id), so a message in this burst can have a SECOND ledger row,
    // `PROCESSING` for the bot that now owns the conversation. A range write turns it `PROCESSED`,
    // which the sweep never revisits; if that route then dies, the customer is unanswered with
    // nothing saying so. The flush has no row of its own to scope to, so it retires nothing: a
    // strand of OURS stays in the loss list, wrong but visible. The watermark still advances, which
    // keeps a later flush from re-coalescing this burst over the bot that took the conversation.
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
    // Message 1's delivery died. Message 2 arrived while the conversation was human-owned, so
    // the webhook advanced the handled watermark past BOTH without answering either. Message 3 then
    // arms a flush whose burst floor is the watermark, so the burst is {3}: nothing covered message
    // 1, and its row stays non-terminal to say so. Any rule that reads a watermark closes this row,
    // whether the mark counts skips or only posts, because the burst that posted started ABOVE it.
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
      // NOTE: Positioning the mark, not reporting a decision: this call closes nothing, and says so
      // explicitly rather than letting a default speak for it.
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
    // The RECORD is the flow line, written once and never rewritten; `WHERE status = 'DEAD'`
    // is the WORKLIST, and it answers "who is still unanswered". A turn that ran over the message
    // is direct evidence against a verdict the sweep reached by inference, so the row leaves the
    // worklist. That happens when the sweep fires between a turn posting and the retirement, or
    // when a burst reaches back past a long-reported message. Nothing is erased: the loss line
    // stays and a second line says how it ended, or the alert an operator already received would
    // stand with nothing to close it.
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

  // A PARTIAL REPLY MUST NOT CLOSE THE CONVERSATION. The model called `resolve_conversation`
  // believing it had answered, the customer holds the first balloon and not the rest, and
  // `resolved` would tell the operator there is nothing left to do.
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
      // NOTE: ...so the conversation stays open.
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

  // ── A balloon that fails mid-reply ────────────────────────────────────────────
  // A throw out of `flushDebounceJob` leaves the watermark unadvanced and the WORKER retries: the first
  // balloon twice, every side-effecting tool re-run. So what already landed decides: the turn reports,
  // the watermark moves, no retry is armed. Tested at the flush, not as a unit: the unit cannot see the
  // watermark, and the watermark is the whole mechanism.

  // Personifies the fork on what the reconciliation depends on: it ASSIGNS an id to what it accepts,
  // STORES the create's `content_attributes` and honours `before` when paging. A stub missing any of
  // them sends every reply down the "cannot prove delivery" road, green for the wrong reason.
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
  // nothing will complete. A throw buys no re-answer here: `shouldPost` claims the burst with a
  // monotonic CAS immediately before the first balloon, so a worker retry, or the delivery
  // recovery, coalesces and posts nothing. What a throw does buy is the OPERATOR: `lastError` is
  // written on a throw and on nothing else, and the flush clears it on "posted", so a plain
  // "posted" erases the only conversation-level sign that a customer holds one of three balloons.
  // Hence the separate word and the badge the turn writes itself.
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

  // Our bot is 9 (the job payload's agentBotId, and the ChatwootAgentBot row); 77 is another bot on
  // the same account. The burst was armed while the conversation was still free and an automation
  // handed it away before the window closed, so the flush is the last place that can notice.
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

  // A gate that closes has to SAY why it closed, or the operator investigating an unanswered
  // conversation finds no line anywhere. The two cases below are the two events that wear this one
  // exit; the second is the ack escalation's, which never reaches the recheck that could already
  // name it, because no turn ever starts.
  //
  // Scoped to the conversation by its INTERNAL id, and polled: the emit is fire-and-forget, so an
  // unscoped read answers with a neighbour's row and an unpolled one races the write it asserts.
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

  // The OTHER unbound-inbox exit: the gate is OPEN, so this burst is the bot's to answer and there
  // is simply no agent to answer it. A silent `done` here is indistinguishable, from the operator's
  // side, from an agent that is quiet.
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

  // The same seat held by OUR bot: assignment to ourselves is the normal steady state once the
  // agent has taken a conversation, so closing the gate on it would silence every burst.
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

    // The escalation lands INSIDE the authorization round-trip, which is what that fence exists
    // for: ten seconds in somebody else's endpoint. Nobody is on the conversation at all, so this
    // is not a human takeover.
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

    // THE RULE STAGE COMES FIRST (docs/contact-auth.md, Two stages): ahead of the spend ceiling, so a
    // burst this agent does not serve draws no ceiling sentence and no handoff, and the endpoint the
    // operator put after the rule is never asked about it.
    test("over the ceiling, a burst the rule refuses is dropped before the ceiling speaks", async () => {
      const convId = 847;
      await seedConversation(convId);
      await seedContactOn(convId, 68);
      const before = await suDb.agent.findUniqueOrThrow({
        where: { id: agentDbId },
        select: { settings: true },
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          settings: {
            ...(before.settings as object),
            contactAuth: {
              enabled: true,
              rule: { kind: "label", label: "nenhuma-conversa-tem" },
              askEndpointAfterRule: true,
              url: "https://203.0.113.9:9443/check",
            },
          },
        },
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
        const toggles: Array<[number, string]> = [];
        const notes: Array<[number, string]> = [];
        const auth = { n: 0 };
        const out = await flushDebounceJob({
          job: jobFor(convId, { lastMessageId: 8 }),
          base: appDb,
          deps: {
            makeModel: fakeModel,
            makeClient: makeResolveStub({
              pages: [page([{ id: 8, content: "oi" }])],
              sent,
              calls: { getMessages: 0 },
              toggles,
              notes,
            }) as never,
            checkpointer: new MemorySaver(),
            contactAuthFetch: answering(true, auth),
          },
        });
        expect(out).toEqual({ outcome: "done" });
        expect(auth.n).toBe(0);
        expect(sent).toEqual([]);
        expect(toggles).toEqual([]);
        expect(notes).toEqual([]);
        expect(await watermarkOf(convId)).toBe(8);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { settings: before.settings as object },
        });
        await suDb.tenant.update({
          where: { id: tenantId },
          data: { settings: {} },
        });
        await suDb.spendCostSnapshot.deleteMany({
          where: { tenantId, source: "inbox" },
        });
      }
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

    // A verdict the authorization endpoint returns after the job's deadline is the retry's: the run
    // was already failed, and dispensing the burst here would leave that retry nothing to
    // reconsider. The control is the test above, where the same refusal advances the mark.
    test("a refusal that returns after the job's deadline leaves the burst to the retry", async () => {
      await seedConversation(8110);
      await seedContactOn(8110, 81);
      const sent: Array<[number, string]> = [];
      const controller = new AbortController();
      const out = await flushDebounceJob({
        job: jobFor(8110, { lastMessageId: 7 }),
        base: appDb,
        signal: controller.signal,
        deps: {
          makeModel: fakeModel,
          makeClient: makeStub({
            pages: [page([{ id: 7, content: "oi" }])],
            sent,
            calls: { getMessages: 0 },
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: (async () => {
            controller.abort(new Error("deadline exceeded"));
            return new Response(JSON.stringify({ authorized: false }), {
              status: 200,
            });
          }) as unknown as typeof fetch,
        },
      });
      expect(out).toEqual({ outcome: "done" });
      expect(sent).toEqual([]);
      expect(await watermarkOf(8110)).toBeNull();
    });

    test("a refused contact closes the orphan below the mark too", async () => {
      // The gate decides BEFORE any Chatwoot fetch, so it cannot name the members and writes
      // the range. The orphan sits BELOW the mark, so a range starting at the mark leaves it
      // rowless: it comes back as owed once authorization returns, and the next turn runs a request
      // this gate already discarded. The range starts at the era floor, where a missing row starts
      // to mean something.
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
      // Authorization is back: the discarded request is not run.
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
      // The dispensal and the ledger share one lower bound, the era floor: a ledger starting
      // at the mark would leave the orphan's delivery stuck, reported as an unattended loss and
      // eligible for recovery after the refusal already decided it.
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
      // NOTE: The third gate exit, and the one that keeps the wide scope. The other two close
      // because somebody else owns the conversation; this one closes on a decision about the
      // CONTACT, taken while this route still owns it, so no sibling delivery races it and a strand
      // inside the burst is this exit's to close. Scoped down to nothing, every refused burst would
      // leave a reported loss for a message the product deliberately declined to answer.
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
      // The point is the MODEL running, not the reply going out: the post gate's CAS already
      // withholds a reply whose watermark moved, so asserting on `sent` alone passes without this
      // fence. Counting the model separates "did not answer" from "never ran", and a turn that ran
      // spent tokens and may have called side-effecting tools.
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
          // NOTE: The concurrent delivery closed message 9 without answering it, which is what this
          // advance reports.
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
    // seconds, and a human arriving inside it must not get the burst answered over their shoulder.
    // The post gate would withhold the reply, but by then the turn's tools have run.
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
      // NOTE: The same window, closed by the other kind of owner. A human answers the message
      // whichever route carried it; another BOT has a delivery of its own that may be running now,
      // since Chatwoot fans a message to up to two routes (`agent_bots_for`), and a range
      // retirement turns that live row `PROCESSED`, the one state the sweep never revisits. This
      // exit is the second place the rule holds: the gate on the way in passed, and the
      // conversation moved during the round-trip.
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

  // ── The watermark must advance on every deliberate skip, not only on a post ──

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
        // NOTE: Positioning the mark, not reporting a decision: this call closes nothing, and says
        // so explicitly rather than letting a default speak for it.
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

  // AND IT CLAIMS NOTHING. The watermark advances because the burst was CONSUMED (nothing will
  // answer it again on its own), but no reply left this turn, so the tail is still unanswered and
  // the operator's re-engage is exactly what should answer it. A claim taken before the turn knows
  // whether it will send would mark the burst answered and refuse that click forever.
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

  // THE SEQUENCE, END TO END: the flush runs, the turn ends without a reply, and the operator
  // clicks re-engage on a tail nobody answered. Neither the watermark (it covers the tail) nor the
  // claim (the empty turn holds none) may refuse the click.
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
    // NOTE: The mark covers the whole tail, so the mark alone must not decide the click.
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

  // The DEBOUNCE dedupeKey is the THREAD, so one physical row serves every burst this contact ever
  // sends. A flush that dead-lettered (five consecutive failures) leaves the row carrying five
  // attempts, and a re-arm that kept them would give the NEXT burst, days later, one attempt before
  // retiring it again, forever.
  //
  // A fresh burst is the same thing `burstStartedAt` already keys off, a row that is not PENDING,
  // and both are asserted so the two cannot drift apart.
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

  // When both attempts come back empty the turn is lost for good and the operator becomes the
  // fallback, so the conversation badge has to name the fault, not a JS error (`undefined is not an
  // object (evaluating ...)`) that tells whoever picks up the conversation nothing about what
  // happened or what to do.
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

  // A run that throws is not the outcome while the job has attempts left: the scheduler runs the
  // burst again, and the next run usually answers. So the run's `generate` line is `info`, flagged
  // whether another run follows, and the alarm is the death's to raise (announceDeadDebounceFlush).
  for (const [attempts, willRetry] of [
    [0, true],
    [4, false],
  ] as const) {
    test(`a run that throws on attempt ${attempts + 1} logs generate at info, willRetry ${willRetry}`, async () => {
      const conv = 10900 + attempts;
      await seedConversation(conv);
      const sent: Array<[number, string]> = [];
      await expect(
        flushDebounceJob({
          job: { ...jobFor(conv), attempts },
          base: appDb,
          deps: {
            makeModel: () => new FailingModel(new Error("upstream 503")),
            makeClient: makeStub({
              pages: [page([{ id: 1, content: "oi" }])],
              sent,
              calls: { getMessages: 0 },
            }),
            checkpointer: new MemorySaver(),
          },
        }),
      ).rejects.toThrow();
      expect(sent).toEqual([]);
      const rows = await flowLogRows(suDb, {
        where: {
          tenantId,
          threadId: threadOf(conv),
          stage: "generate",
          status: "error",
        },
        select: { level: true, detail: true },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.level).toBe("info");
      expect(
        (rows[0]?.detail as Record<string, unknown> | undefined)?.willRetry,
      ).toBe(willRetry);
      await clearFlowLog(suDb, { tenantId, threadId: threadOf(conv) });
    });
  }

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
  // before it, and the input-guardrail reply is the send closest to the gate, with nothing in
  // between to ask again. The supersede half cannot stand in for the ask: a /reset typed on the
  // ENTRY conversation of a redirect pair retires the WIDGET's flush
  // (src/modules/chatwoot/webhook.ts sweeps both sides), while the re-fetch reads the widget's own
  // messages, where nothing new arrived.
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

    // A FAILED SEND KEEPS THE CLAIM. The template goes out through a raw `sendMessage` with no
    // reconciliation, so a rejection here does not even say whether Chatwoot accepted it first, and
    // the claim is taken before the send precisely so that the scheduler's retry cannot send it a
    // second time to a customer who may already have it. The claim is never given back.
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
      // NOTE: The post gate claims in `lastRepliedMessageId`, not by advancing the watermark, so a
      // retirement caught by the ask after the claim leaves the watermark where "stale" says it
      // should be: on a burst nothing answered, which the next flush re-coalesces.
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

    // The image is delivered BEFORE the text, so a text send that fails after it leaves the
    // customer holding part of the answer with no balloon landed: `delivered: 0` alone is the wrong
    // thing to throw on, since a throw re-runs the turn and posts the picture again. And when the
    // text lands but a promised file does not, the conversation stays open: the decision is
    // `mayCloseConversation`, and this proves the call site consults it (the table proves the
    // rule).
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

    // THE SAME RULE ON THE ATTACHMENT-ONLY BRANCH: a batch where one file lands and another fails
    // reaches `applyDeferredResolve`, so `failed` is read for the close and not only for the throw.
    // The customer holds one of the two pictures the agent promised, and `resolved` would say the
    // attendance is finished.
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
      // AND THE THIRD SHAPE OF A PARTIAL DELIVERY: the customer holds the picture and none of
      // the words. "Not a failed turn" and "nothing to tell the operator" are different facts, and
      // a clean post would make the flush CLEAR whatever badge the conversation carries.
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
    // Retires the claim from inside the model call and then rejects: /reset lands while the invoke
    // (or a TTS call, or a send) is in flight, and that call then fails.
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

  // THE SECOND ASK. The webhook's spend gate covers the MESSAGE; the flush runs minutes later and
  // is where the turn actually spends. A tenant that crosses its ceiling inside that window (from
  // its own other conversations, or from this one's earlier burst) would otherwise have an
  // already-armed flush spend past it, and many armed conversations would do it together.
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
      // NOTE: The month's figure as the poll would have written it: over the ceiling below.
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

    // The same refusal with the job's deadline firing during the ceiling's own read: the run was
    // failed and its retry answers the burst, so the notice, the hand-over and the settlement are
    // the retry's. The test above is its control.
    test("a ceiling verdict read after the job's deadline leaves the burst to the retry", async () => {
      await seedConversation(8111);
      const sent: Array<[number, string]> = [];
      const toggles: Array<[number, string]> = [];
      const controller = new AbortController();
      const slow = appDb.$extends({
        query: {
          async $allOperations({ model, operation, args, query }) {
            if (model === "SpendCostSnapshot" && operation === "findUnique") {
              controller.abort(new Error("deadline exceeded"));
            }
            return query(args);
          },
        },
      }) as unknown as PrismaClient;
      const out = await flushDebounceJob({
        job: jobFor(8111, { lastMessageId: 7 }),
        base: slow,
        signal: controller.signal,
        deps: {
          makeModel: () => {
            throw new Error("the model must not be invoked over the ceiling");
          },
          makeClient: makeResolveStub({
            pages: [page([{ id: 7, content: "oi" }])],
            sent,
            calls: { getMessages: 0 },
            toggles,
            notes: [],
            order: [],
          }),
          checkpointer: new MemorySaver(),
        },
      });
      expect(out).toEqual({ outcome: "done" });
      expect(controller.signal.aborted).toBe(true);
      expect(sent).toEqual([]);
      expect(toggles).toEqual([]);
      expect(await watermarkOf(8111)).toBeNull();
      await clearFlowLog(suDb, { tenantId });
    });

    // The other side: once the announcement reached the conversation, its remaining acts are this
    // run's. A deadline that fires inside the hand-over does not withhold the note that explains
    // it, because a retry finds the conversation a person's and never reaches the note.
    test("a ceiling announcement the deadline reaches at the hand-over still leaves its note", async () => {
      await seedConversation(8112);
      const sent: Array<[number, string]> = [];
      const toggles: Array<[number, string]> = [];
      const notes: Array<[number, string]> = [];
      const controller = new AbortController();
      const stub = makeResolveStub({
        pages: [page([{ id: 7, content: "oi" }])],
        sent,
        calls: { getMessages: 0 },
        toggles,
        notes,
        order: [],
      });
      const makeClient = (async (...args: Parameters<typeof stub>) => {
        const client = await stub(...args);
        return new Proxy(client, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop !== "toggleStatus" || typeof value !== "function") {
              return typeof value === "function" ? value.bind(target) : value;
            }
            return async (...a: unknown[]) => {
              const out = await value.apply(target, a);
              controller.abort(new Error("deadline exceeded"));
              return out;
            };
          },
        });
      }) as typeof stub;
      await flushDebounceJob({
        job: jobFor(8112, { lastMessageId: 7 }),
        base: appDb,
        signal: controller.signal,
        deps: {
          makeModel: () => {
            throw new Error("the model must not be invoked over the ceiling");
          },
          makeClient,
          checkpointer: new MemorySaver(),
        },
      });
      expect(controller.signal.aborted).toBe(true);
      expect(sent).toEqual([[8112, CEILING_COPY]]);
      expect(toggles).toEqual([[8112, "open"]]);
      expect(notes.length).toBe(1);
      expect(await watermarkOf(8112)).toBe(7);
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
        // NOTE: Positioning the mark, not reporting a decision: this call closes nothing, and says
        // so explicitly rather than letting a default speak for it.
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
