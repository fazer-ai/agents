import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { closedByTheAgentSide } from "@/modules/conversations/resolution-origin";
import { flushDebounceJob } from "@/modules/debounce/handler";
import { debounceDedupeKey } from "@/modules/debounce/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// Issue #895: a NEW conversation whose only customer message has nothing to answer (no text, no
// attachment, no subject, no image in the body) used to stay `pending` and bot-owned forever. No turn
// ran, so our side never spoke, so the follow-up never armed, and nothing was logged. It is closed
// now, on both the debounce flush and the direct path, with an `info` line saying why.

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

const INBOX = 95;
const OUR_BOT = 38;
let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let agentDbId = 0n;

const threadOf = (convId: number) => `${tenantId}:${instanceId}:${convId}`;

interface Msg {
  id: number;
  private?: boolean;
  content?: string | null;
  type?: number;
  reaction?: boolean;
  subject?: string;
  attachments?: Array<{ file_type: string }>;
}

function page(msgs: Msg[]) {
  return {
    payload: msgs.map((m) => ({
      id: m.id,
      content: m.content ?? null,
      message_type: m.type ?? 0,
      private: m.private === true,
      ...(m.reaction ? { content_attributes: { is_reaction: true } } : {}),
      ...(m.subject
        ? { content_attributes: { email: { subject: m.subject } } }
        : {}),
      ...(m.attachments
        ? {
            attachments: m.attachments.map((a, i) => ({
              id: m.id * 10 + i,
              file_type: a.file_type,
              data_url: "https://cw.example/f",
            })),
          }
        : {}),
    })),
  };
}

// Chatwoot as the flush and the turn see it: the thread page, the live conversation (status and who
// holds it), and a status toggle that CHANGES that live status, so a second delivery reads the close
// the first one made.
function chatwoot(
  msgs: Msg[],
  live: {
    status?: string;
    assigneeType?: string;
    assigneeId?: number;
    toggleFails?: boolean;
    // Runs inside every thread read: the wait a job deadline can land in.
    onRead?: () => void;
    // Runs inside the live conversation read, the helper's last wait before it writes.
    onLive?: () => Promise<void> | void;
    // History older than the default page: only the full catch-up read (`after`) returns it.
    older?: Msg[];
  } = {},
) {
  const state = {
    status: live.status ?? "pending",
    assigneeType: live.assigneeType ?? "AgentBot",
    assigneeId: live.assigneeId ?? OUR_BOT,
  };
  const toggles: string[] = [];
  const sent: string[] = [];
  const client = {
    getMessages: async (_id: number, o?: { after?: number }) => {
      live.onRead?.();
      const after = o?.after;
      return after != null
        ? page([...(live.older ?? []), ...msgs].filter((m) => m.id > after))
        : page(msgs);
    },
    getConversation: async (id: number) => {
      await live.onLive?.();
      return {
        id,
        status: state.status,
        updated_at: 1_700_000_000.5,
        inbox_id: INBOX,
        meta: {
          assignee_type: state.assigneeType,
          assignee: { id: state.assigneeId, name: "x" },
        },
      };
    },
    toggleStatus: async (_id: number, status: string) => {
      if (live.toggleFails) throw new Error("chatwoot 500");
      toggles.push(status);
      state.status = status;
      return {};
    },
    sendMessage: async (_id: number, text: string) => {
      sent.push(text);
      return {};
    },
    sendPrivateNote: async () => ({}),
    toggleTyping: async () => ({}),
    getConversationLabels: async () => [],
    listLabels: async () => [],
    listCustomAttributeDefinitions: async () => [],
  } as unknown as ChatwootClient;
  return { toggles, sent, state, makeClient: async () => client };
}

class Answers {
  calls = 0;
  async invoke(): Promise<AIMessage> {
    this.calls++;
    return new AIMessage("Olá! Como posso ajudar?");
  }
  bindTools(_t: unknown) {
    return { invoke: () => this.invoke() };
  }
}

class NeverCalled {
  async invoke(): Promise<AIMessage> {
    throw new Error("nothing to answer must not reach the model");
  }
  bindTools(_t: unknown) {
    return this;
  }
}

async function seedConversation(
  convId: number,
  opts: { spoken?: boolean; status?: string; handled?: number } = {},
) {
  return suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: opts.status ?? "pending",
      assigneeType: "AgentBot",
      assigneeId: OUR_BOT,
      inboxId: inboxDbId,
      threadId: threadOf(convId),
      lastEventAt: new Date(),
      ...(opts.spoken ? { lastRepliedMessageId: 1 } : {}),
      ...(opts.handled ? { lastHandledMessageId: opts.handled } : {}),
    },
    select: { id: true },
  });
}

async function claimedJob(
  convId: number,
  lastMessageId: number,
  reactionArmed = false,
) {
  const thread = threadOf(convId);
  const payload = {
    threadId: thread,
    agentBotId: OUR_BOT,
    burstStartedAt: 1,
    lastMessageId,
    ...(reactionArmed ? { reactionArmed: true } : {}),
  };
  const row = await suDb.schedulerJob.create({
    data: {
      tenantId,
      kind: "DEBOUNCE",
      dedupeKey: debounceDedupeKey(thread),
      status: "CLAIMED",
      runAt: new Date(),
      payload,
    },
    select: { id: true, claimSeq: true },
  });
  return {
    id: row.id,
    tenantId,
    kind: "DEBOUNCE" as const,
    payload,
    attempts: 0,
    claimSeq: row.claimSeq,
  };
}

async function flush(
  convId: number,
  cw: ReturnType<typeof chatwoot>,
  model: unknown,
  reactionArmed = false,
  signal?: AbortSignal,
) {
  await suDb.schedulerJob.deleteMany({
    where: { tenantId, dedupeKey: debounceDedupeKey(threadOf(convId)) },
  });
  const job = await claimedJob(convId, 2, reactionArmed);
  return flushDebounceJob({
    job,
    base: appDb,
    signal,
    deps: {
      makeModel: () => model as never,
      makeClient: cw.makeClient as never,
      checkpointer: new MemorySaver(),
    },
  });
}

function event(convId: number, content: string): NormalizedChatwootEvent {
  return {
    event: "message_created",
    conversationId: convId,
    inboxId: INBOX,
    status: "pending",
    assigneeType: "AgentBot",
    assigneeId: OUR_BOT,
    assigneeName: null,
    contactInboxId: null,
    message: { id: 2, content, messageType: "incoming", private: false },
  };
}

async function direct(
  convId: number,
  cw: ReturnType<typeof chatwoot>,
  content = "",
) {
  return runAgentTurn({
    tenantId,
    instanceId,
    agentBotId: OUR_BOT,
    event: event(convId, content),
    base: appDb,
    deps: {
      makeModel: () => new NeverCalled() as never,
      makeClient: cw.makeClient as never,
      checkpointer: new MemorySaver(),
    },
  });
}

async function resolvedBy(convId: number) {
  const row = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { resolvedBy: true },
  });
  return row.resolvedBy;
}

async function closeLines(convDbId: bigint) {
  const rows = await flowLogRows(suDb, {
    where: { conversationId: convDbId },
  });
  return rows
    .filter(
      (r) =>
        (r.detail as Record<string, unknown> | null)?.reason ===
        "nothingAnswerable",
    )
    .map((r) => ({ stage: r.stage, level: r.level, detail: r.detail }));
}

describe.skipIf(!dbUp)(
  "a conversation whose only message has nothing to answer",
  () => {
    beforeAll(async () => {
      tenantId = (
        await suDb.tenant.create({
          data: { name: "Vazio", slug: `nothing-to-answer-${process.pid}` },
        })
      ).id;
      instanceId = (
        await seedChatwootInstance(suDb, {
          tenantId,
          accountId: 95,
          baseUrl: "https://chat.vazio.example",
          adminToken: encryptJson("ADMIN"),
        })
      ).id;
      const key = await suDb.vaultEntry.create({
        data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
        select: { id: true },
      });
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${key.id}`,
          },
          enabled: true,
          mode: "production",
          settings: {
            split: { enabled: false },
            debounce: { enabled: true, windowSeconds: 15 },
          },
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
          webhookRouteTokenHash: `vazio-route-${process.pid}`,
          name: "Atendente",
        },
      });
      inboxDbId = (
        await suDb.inbox.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootInboxId: INBOX,
            name: "Suporte",
            agentId: agent.id,
          },
        })
      ).id;
    });

    afterAll(async () => {
      if (!tenantId) return;
      await clearFlowLog(suDb, { tenantId });
      for (const table of [
        "scheduler_jobs",
        "agent_threads",
        "llm_usage",
        "conversations",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "vault_entries",
      ]) {
        await suDb
          .$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => {});
      }
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("the flush closes it, records why, and never reaches the model", async () => {
      const conv = await seedConversation(89_501);
      const cw = chatwoot([{ id: 2, content: "" }]);
      const out = await flush(89_501, cw, new NeverCalled());
      expect(out.outcome).toBe("done");
      expect(cw.toggles).toEqual(["resolved"]);
      expect(cw.sent).toEqual([]);
      expect(await resolvedBy(89_501)).toBe("nothing_to_answer");
      expect(await closeLines(conv.id)).toEqual([
        {
          stage: "debounce",
          level: "info",
          detail: { outcome: "resolved", reason: "nothingAnswerable" },
        },
      ]);
    });

    test("a null body is the same as an empty one", async () => {
      await seedConversation(89_502);
      const cw = chatwoot([
        { id: 2, content: null },
        { id: 3, content: "   " },
      ]);
      await flush(89_502, cw, new NeverCalled());
      expect(cw.toggles).toEqual(["resolved"]);
    });

    test("a second delivery of the same flush does not close it twice", async () => {
      await seedConversation(89_503);
      const cw = chatwoot([{ id: 2, content: "" }]);
      await flush(89_503, cw, new NeverCalled());
      await flush(89_503, cw, new NeverCalled());
      expect(cw.toggles).toEqual(["resolved"]);
    });

    test("where our side already spoke, it is left for the follow-up", async () => {
      const conv = await seedConversation(89_504, { spoken: true });
      const cw = chatwoot([
        { id: 1, content: "Olá", type: 1 },
        { id: 2, content: "" },
      ]);
      await flush(89_504, cw, new NeverCalled());
      expect(cw.toggles).toEqual([]);
      expect(await closeLines(conv.id)).toEqual([]);
    });

    test("a conversation a person holds live is not closed", async () => {
      await seedConversation(89_505);
      const cw = chatwoot([{ id: 2, content: "" }], {
        assigneeType: "User",
        assigneeId: 7,
      });
      await flush(89_505, cw, new NeverCalled());
      expect(cw.toggles).toEqual([]);
    });

    test("a conversation that is live open (escalated) is not closed", async () => {
      await seedConversation(89_506);
      const cw = chatwoot([{ id: 2, content: "" }], { status: "open" });
      await flush(89_506, cw, new NeverCalled());
      expect(cw.toggles).toEqual([]);
    });

    test("a reaction is not an empty message: it does not close", async () => {
      await seedConversation(89_507);
      const cw = chatwoot([{ id: 2, content: "", reaction: true }]);
      await flush(89_507, cw, new NeverCalled());
      expect(cw.toggles).toEqual([]);
    });

    test("an empty message beside a real one runs the turn and does not close", async () => {
      await seedConversation(89_508);
      const cw = chatwoot([
        { id: 2, content: "" },
        { id: 3, content: "quero cancelar" },
      ]);
      const model = new Answers();
      await flush(89_508, cw, model);
      expect(model.calls).toBeGreaterThan(0);
      expect(cw.sent.length).toBeGreaterThan(0);
      expect(cw.toggles).not.toContain("resolved");
    });

    test("answerable shapes with no text are not closed: attachment, subject", async () => {
      await seedConversation(89_509);
      await seedConversation(89_510);
      const a = chatwoot([
        { id: 2, content: "", attachments: [{ file_type: "file" }] },
      ]);
      const s = chatwoot([{ id: 2, content: "", subject: "Reembolso" }]);
      await flush(89_509, a, new Answers());
      await flush(89_510, s, new Answers());
      expect(a.toggles).not.toContain("resolved");
      expect(s.toggles).not.toContain("resolved");
    });

    test("the direct path closes it too, with its own line", async () => {
      const conv = await seedConversation(89_511);
      const cw = chatwoot([{ id: 2, content: "" }]);
      const outcome = await direct(89_511, cw);
      expect(outcome).toBe("skipped");
      expect(cw.toggles).toEqual(["resolved"]);
      expect(await resolvedBy(89_511)).toBe("nothing_to_answer");
      expect(await closeLines(conv.id)).toEqual([
        {
          stage: "route",
          level: "info",
          detail: { outcome: "resolved", reason: "nothingAnswerable" },
        },
      ]);
    });

    test("the direct path leaves a conversation our side spoke in", async () => {
      await seedConversation(89_512, { spoken: true });
      const cw = chatwoot([
        { id: 1, content: "Olá", type: 1 },
        { id: 2, content: "" },
      ]);
      await direct(89_512, cw);
      expect(cw.toggles).toEqual([]);
    });

    test("a switched-off agent closes nothing, on either path", async () => {
      await seedConversation(89_513);
      await seedConversation(89_514);
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { enabled: false },
      });
      try {
        const f = chatwoot([{ id: 2, content: "" }]);
        const d = chatwoot([{ id: 2, content: "" }]);
        await flush(89_513, f, new NeverCalled());
        const outcome = await direct(89_514, d);
        expect(f.toggles).toEqual([]);
        expect(d.toggles).toEqual([]);
        // Unchanged word: an empty message on the direct path was always `skipped`, and the webhook's
        // settlement reads it. Only whether the conversation closes is new.
        expect(outcome).toBe("skipped");
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { enabled: true },
        });
      }
    });

    test("a monitoring agent closes nothing", async () => {
      await seedConversation(89_515);
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      try {
        const cw = chatwoot([{ id: 2, content: "" }]);
        await flush(89_515, cw, new NeverCalled());
        expect(cw.toggles).toEqual([]);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("a burst a reaction armed is left alone: the page may not carry that reaction", async () => {
      await seedConversation(89_516);
      const cw = chatwoot([{ id: 2, content: "" }]);
      await flush(89_516, cw, new NeverCalled(), true);
      expect(cw.toggles).toEqual([]);
    });

    test("a thread with no incoming message at all is not closed", async () => {
      await seedConversation(89_517);
      const cw = chatwoot([{ id: 2, content: "nota do operador", type: 2 }]);
      await flush(89_517, cw, new NeverCalled());
      expect(cw.toggles).toEqual([]);
    });

    test("a close that fails is a warn, so it reaches the alert channel", async () => {
      const conv = await seedConversation(89_518);
      const cw = chatwoot([{ id: 2, content: "" }], { toggleFails: true });
      await flush(89_518, cw, new NeverCalled());
      expect(await resolvedBy(89_518)).toBeNull();
      expect(await closeLines(conv.id)).toEqual([
        {
          stage: "debounce",
          level: "warn",
          detail: { outcome: "resolved", reason: "nothingAnswerable" },
        },
      ]);
    });

    test("a message a previous turn left unanswered keeps the conversation open", async () => {
      // The burst above the watermark is only the blank message, so the flush finds nothing; the
      // text below the mark was never answered (our side never spoke), and closing would bury it.
      await seedConversation(89_519, { handled: 1 });
      const cw = chatwoot([
        { id: 1, content: "preciso de ajuda com meu pedido" },
        { id: 2, content: "" },
      ]);
      await flush(89_519, cw, new NeverCalled());
      expect(cw.toggles).toEqual([]);
    });

    test("a private incoming row is not the customer speaking", async () => {
      await seedConversation(89_520);
      const cw = chatwoot([
        { id: 1, content: "nota interna", private: true },
        { id: 2, content: "" },
      ]);
      await flush(89_520, cw, new NeverCalled());
      expect(cw.toggles).toEqual(["resolved"]);
    });

    test("past the job's deadline the flush leaves the close to its retry", async () => {
      await seedConversation(89_521);
      const deadline = new AbortController();
      const cw = chatwoot([{ id: 2, content: "" }], {
        onRead: () => deadline.abort(),
      });
      await flush(89_521, cw, new NeverCalled(), false, deadline.signal);
      expect(cw.toggles).toEqual([]);
    });

    test("an unmirrored conversation closes nothing and logs nothing", async () => {
      const cw = chatwoot([{ id: 2, content: "" }]);
      await direct(89_522, cw);
      expect(cw.toggles).toEqual([]);
      // flowlog-scope: tenant-wide — an unmirrored conversation has no row to scope by, and the
      // subject is that no route warn was written for it anywhere.
      const rows = await flowLogRows(suDb, {
        where: { tenantId, stage: "route", level: "warn" },
      });
      expect(rows).toEqual([]);
    });

    test("a request older than the default page keeps the conversation open", async () => {
      // The default page is the last twenty; the unanswered request sits behind it, and the blank
      // messages on top say nothing about it.
      await seedConversation(89_523, { handled: 30 });
      const blanks = Array.from({ length: 20 }, (_, i) => ({
        id: 31 + i,
        content: "",
      }));
      const cw = chatwoot(blanks, {
        older: [{ id: 1, content: "meu ingresso não chegou" }],
      });
      await flush(89_523, cw, new NeverCalled());
      expect(cw.toggles).toEqual([]);
    });

    test("a history too long to read in one batch is not proven blank", async () => {
      await seedConversation(89_524);
      const cw = chatwoot([{ id: 200, content: "" }], {
        older: Array.from({ length: 100 }, (_, i) => ({
          id: 1 + i,
          content: "",
        })),
      });
      await flush(89_524, cw, new NeverCalled());
      expect(cw.toggles).toEqual([]);
    });

    test("a /reset that lands while the helper reads closes nothing", async () => {
      const conv = await seedConversation(89_525);
      const cw = chatwoot([{ id: 2, content: "" }], {
        onLive: async () => {
          await suDb.schedulerJob.updateMany({
            where: { tenantId, dedupeKey: debounceDedupeKey(threadOf(89_525)) },
            data: { payload: { threadId: threadOf(89_525), cancelledAt: 1 } },
          });
        },
      });
      await flush(89_525, cw, new NeverCalled());
      expect(cw.toggles).toEqual([]);
      expect(await closeLines(conv.id)).toEqual([]);
    });

    test("an agent switched off while the helper reads closes nothing, on either path", async () => {
      await seedConversation(89_526);
      await seedConversation(89_527);
      const off = async () => {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { enabled: false },
        });
      };
      try {
        const f = chatwoot([{ id: 2, content: "" }], { onLive: off });
        await flush(89_526, f, new NeverCalled());
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { enabled: true },
        });
        const d = chatwoot([{ id: 2, content: "" }], { onLive: off });
        await direct(89_527, d);
        expect(f.toggles).toEqual([]);
        expect(d.toggles).toEqual([]);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { enabled: true },
        });
      }
    });

    test("a deadline that passes while the helper reads closes nothing", async () => {
      await seedConversation(89_528);
      const deadline = new AbortController();
      const cw = chatwoot([{ id: 2, content: "" }], {
        onLive: () => deadline.abort(),
      });
      await flush(89_528, cw, new NeverCalled(), false, deadline.signal);
      expect(cw.toggles).toEqual([]);
    });

    test("a message that lands after the history read puts the conversation back", async () => {
      const conv = await seedConversation(89_529);
      const msgs: Msg[] = [{ id: 2, content: "" }];
      const cw = chatwoot(msgs, {
        onLive: () => {
          msgs.push({ id: 3, content: "esqueci de escrever: quero cancelar" });
        },
      });
      await flush(89_529, cw, new NeverCalled());
      expect(cw.toggles).toEqual(["resolved", "pending"]);
      expect(cw.state.status).toBe("pending");
      expect(await resolvedBy(89_529)).toBeNull();
      expect(await closeLines(conv.id)).toEqual([]);
    });

    test("a close of ours counts as the agent side's, like the follow-up's", () => {
      expect(closedByTheAgentSide("nothing_to_answer")).toBe(true);
    });
  },
);
