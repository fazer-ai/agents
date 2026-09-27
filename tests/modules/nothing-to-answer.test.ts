import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import {
  armNothingToAnswer,
  NOTHING_TO_ANSWER_DELAY_MS,
  nothingToAnswerDedupeKey,
  nothingToAnswerHandler,
} from "@/modules/conversations/nothing-to-answer";
import { closedByTheAgentSide } from "@/modules/conversations/resolution-origin";
import { flushDebounceJob } from "@/modules/debounce/handler";
import { debounceDedupeKey } from "@/modules/debounce/service";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// Issue #895: a NEW conversation whose only customer message has nothing to answer (no text, no
// attachment, no subject, no image in the body) used to stay `pending` and bot-owned forever. No turn
// ran, so our side never spoke, so the follow-up never armed, and nothing was logged. Now the flush
// and the direct path arm a delayed NOTHING_TO_ANSWER job, and the job closes it, with an `info` line
// saying why, when everything it reads fresh still says there is nothing to answer.

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

// Chatwoot as the flush, the turn and the job see it: the thread page, the live conversation (status
// and who holds it), and a status toggle that CHANGES that live status, so a second run reads the
// close the first one made.
function chatwoot(
  msgs: Msg[],
  live: {
    status?: string;
    assigneeType?: string;
    assigneeId?: number;
    toggleFails?: boolean;
    // The newest message id the live conversation names (`last_non_activity_message`).
    latest?: number;
    // Runs inside the live conversation read, the job's last network read before it writes.
    onLive?: () => Promise<void> | void;
    // History older than the default page: only the full catch-up read (`after`) returns it.
    older?: Msg[];
    // Runs on every full-history read (`after: 0`), counted from 1; a value it returns replaces the
    // body, so a test can degrade one read or land an event inside it.
    onFullRead?: (nth: number) => unknown | Promise<unknown>;
  } = {},
) {
  const state = {
    status: live.status ?? "pending",
    assigneeType: live.assigneeType ?? "AgentBot",
    assigneeId: live.assigneeId ?? OUR_BOT,
  };
  const toggles: string[] = [];
  const admin: boolean[] = [];
  const sent: string[] = [];
  let fullReads = 0;
  let clients = 0;
  const client = {
    getMessages: async (_id: number, o?: { after?: number }) => {
      const after = o?.after;
      if (after === 0 && live.onFullRead) {
        const r = await live.onFullRead(++fullReads);
        if (r !== undefined) return r;
      }
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
        ...(live.latest !== undefined
          ? { last_non_activity_message: { id: live.latest } }
          : {}),
        meta: {
          assignee_type: state.assigneeType,
          assignee: { id: state.assigneeId, name: "x" },
        },
      };
    },
    toggleStatus: async (
      _id: number,
      status: string,
      opts: { asAdmin?: boolean } = {},
    ) => {
      if (live.toggleFails) throw new Error("chatwoot 500");
      toggles.push(status);
      admin.push(opts.asAdmin === true);
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
  return {
    toggles,
    admin,
    sent,
    state,
    clients: () => clients,
    makeClient: async () => {
      clients++;
      return client;
    },
  };
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
  opts: { spoken?: boolean; resetAt?: number } = {},
) {
  return suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: "AgentBot",
      assigneeId: OUR_BOT,
      inboxId: inboxDbId,
      threadId: threadOf(convId),
      lastEventAt: new Date(),
      ...(opts.spoken ? { lastRepliedMessageId: 1 } : {}),
      ...(opts.resetAt ? { resetAtMessageId: opts.resetAt } : {}),
    },
    select: { id: true },
  });
}

async function flush(
  convId: number,
  cw: ReturnType<typeof chatwoot>,
  model: unknown,
) {
  const thread = threadOf(convId);
  await suDb.schedulerJob.deleteMany({
    where: { tenantId, dedupeKey: debounceDedupeKey(thread) },
  });
  const payload = {
    threadId: thread,
    agentBotId: OUR_BOT,
    burstStartedAt: 1,
    lastMessageId: 2,
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
  return flushDebounceJob({
    job: {
      id: row.id,
      tenantId,
      kind: "DEBOUNCE" as const,
      payload,
      attempts: 0,
      claimSeq: row.claimSeq,
    },
    base: appDb,
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

// The armed row of a conversation, as the scheduler holds it.
async function armedRow(convId: number) {
  return suDb.schedulerJob.findFirst({
    where: {
      tenantId,
      kind: "NOTHING_TO_ANSWER",
      dedupeKey: nothingToAnswerDedupeKey(threadOf(convId)),
    },
  });
}

// Arms the job the way the flush does, then claims it the way the worker does, and hands back what
// the worker gives the handler.
async function armAndClaim(
  convId: number,
  convDbId: bigint,
  triggerMessageId: number | null = 2,
): Promise<ClaimedJob> {
  await armNothingToAnswer({
    tenantId,
    instanceId,
    threadId: threadOf(convId),
    conversationId: convId,
    conversationDbId: convDbId,
    agentId: agentDbId,
    agentBotId: OUR_BOT,
    triggerMessageId,
    base: appDb,
  });
  const row = await armedRow(convId);
  if (!row) throw new Error("the job was not armed");
  const claimed = await suDb.schedulerJob.update({
    where: { id: row.id },
    data: {
      status: "CLAIMED",
      claimedAt: new Date(),
      claimSeq: { increment: 1 },
    },
  });
  return {
    id: claimed.id,
    tenantId,
    kind: "NOTHING_TO_ANSWER",
    payload: claimed.payload as Record<string, unknown>,
    dedupeKey: claimed.dedupeKey,
    attempts: 0,
    claimSeq: claimed.claimSeq,
  };
}

// One conversation, armed, claimed and run against the given Chatwoot.
async function judge(
  convId: number,
  cw: ReturnType<typeof chatwoot>,
  opts: { spoken?: boolean; resetAt?: number; trigger?: number } = {},
) {
  const conv = await seedConversation(convId, opts);
  const job = await armAndClaim(convId, conv.id, opts.trigger ?? 2);
  const out = await nothingToAnswerHandler(job, appDb, cw.makeClient as never);
  return { conv, job, out };
}

async function resolvedBy(convId: number) {
  const row = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { resolvedBy: true },
  });
  return row.resolvedBy;
}

// The emit is fire-and-forget: poll for the line.
async function closeLines(convDbId: bigint, expectSome = true) {
  for (let i = 0; i < (expectSome ? 100 : 1); i++) {
    const rows = await flowLogRows(suDb, {
      where: { conversationId: convDbId },
    });
    const mine = rows
      .filter(
        (r) =>
          (r.detail as Record<string, unknown> | null)?.reason ===
          "nothingAnswerable",
      )
      .map((r) => ({ stage: r.stage, level: r.level, detail: r.detail }));
    if (mine.length > 0 || !expectSome) return mine;
    await new Promise((r) => setTimeout(r, 20));
  }
  return [];
}

// A customer message through the real receiver, so the retirement is measured at its call site.
async function customerWrites(convId: number, content: string, id: number) {
  const n = normalizeChatwootEvent({
    event: "message_created",
    id,
    content,
    message_type: "incoming",
    private: false,
    sender: { type: "contact", id: 31 },
    conversation: {
      id: convId,
      inbox_id: INBOX,
      status: "pending",
      contact_inbox: { id: 70_000 + convId },
      meta: {
        assignee_type: "AgentBot",
        assignee: { id: OUR_BOT, name: "x" },
        sender: { id: 31, name: "Cliente" },
      },
      channel: "Channel::Api",
      last_activity_at: Math.floor(Date.now() / 1000),
    },
  });
  if (!n) throw new Error("unreachable: the fixture is a valid event");
  const delivery = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `nothing-${process.pid}-${crypto.randomUUID()}`,
      event: "message_created",
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: delivery.id,
    agentBotId: OUR_BOT,
    normalized: n,
    base: appDb,
    deps: {
      sleep: async () => {},
      makeClient: (async () =>
        ({
          sendMessage: async () => ({}),
          sendPrivateNote: async () => ({}),
          toggleTyping: async () => ({}),
          getMessages: async () => ({ payload: [] }),
        }) as unknown as ChatwootClient) as never,
      makeModel: () => {
        throw new Error("the retirement is what this measures, not a turn");
      },
    },
  }).catch(() => {
    // The receiver may stand down on any gate of its own; the retirement comes before those.
  });
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
        "chatwoot_webhook_deliveries",
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

    // ---- the arm -------------------------------------------------------------------------------

    test("the flush arms the delayed close, closes nothing now, and never reaches the model", async () => {
      const conv = await seedConversation(89_501);
      const cw = chatwoot([{ id: 2, content: "" }]);
      const before = Date.now();
      const out = await flush(89_501, cw, new NeverCalled());
      expect(out.outcome).toBe("done");
      expect(cw.toggles).toEqual([]);
      expect(cw.sent).toEqual([]);
      const row = await armedRow(89_501);
      expect(row?.status).toBe("PENDING");
      const due = row?.runAt.getTime() ?? 0;
      expect(due).toBeGreaterThanOrEqual(before + NOTHING_TO_ANSWER_DELAY_MS);
      expect(due).toBeLessThanOrEqual(Date.now() + NOTHING_TO_ANSWER_DELAY_MS);
      expect(row?.payload).toEqual({
        instanceId: String(instanceId),
        conversationId: 89_501,
        conversationDbId: String(conv.id),
        agentId: String(agentDbId),
        agentBotId: OUR_BOT,
        triggerMessageId: 2,
      });
    });

    test("the delay is half an hour: past the worst measured lateness of content", () => {
      expect(NOTHING_TO_ANSWER_DELAY_MS).toBe(30 * 60_000);
    });

    test("a null body is the same as an empty one", async () => {
      await seedConversation(89_502);
      const cw = chatwoot([
        { id: 2, content: null },
        { id: 3, content: "   " },
      ]);
      await flush(89_502, cw, new NeverCalled());
      expect((await armedRow(89_502))?.status).toBe("PENDING");
    });

    test("the direct path arms it too, and its word stays `skipped`", async () => {
      const conv = await seedConversation(89_503);
      const cw = chatwoot([{ id: 2, content: "" }]);
      const outcome = await direct(89_503, cw);
      expect(outcome).toBe("skipped");
      expect(cw.toggles).toEqual([]);
      const row = await armedRow(89_503);
      expect(row?.status).toBe("PENDING");
      expect(row?.payload).toMatchObject({
        conversationDbId: String(conv.id),
        agentBotId: OUR_BOT,
        triggerMessageId: 2,
      });
    });

    test("an unmirrored conversation arms nothing on the direct path", async () => {
      const cw = chatwoot([{ id: 2, content: "" }]);
      await direct(89_504, cw);
      expect(await armedRow(89_504)).toBeNull();
    });

    test("a burst with a real message runs the turn and arms nothing", async () => {
      await seedConversation(89_505);
      const cw = chatwoot([
        { id: 2, content: "" },
        { id: 3, content: "quero cancelar" },
      ]);
      const model = new Answers();
      await flush(89_505, cw, model);
      expect(model.calls).toBeGreaterThan(0);
      expect(await armedRow(89_505)).toBeNull();
    });

    // ---- the job -------------------------------------------------------------------------------

    test("the job closes it as the admin, records why, and logs an info line", async () => {
      const cw = chatwoot([{ id: 2, content: "" }]);
      const { conv, out } = await judge(89_510, cw);
      expect(out).toEqual({ outcome: "done" });
      expect(cw.toggles).toEqual(["resolved"]);
      expect(cw.admin).toEqual([true]);
      expect(cw.sent).toEqual([]);
      expect(await resolvedBy(89_510)).toBe("nothing_to_answer");
      expect(await closeLines(conv.id)).toEqual([
        {
          stage: "route",
          level: "info",
          detail: { outcome: "resolved", reason: "nothingAnswerable" },
        },
      ]);
    });

    test("a second run of the same job does not close it twice", async () => {
      const cw = chatwoot([{ id: 2, content: "" }]);
      const { job } = await judge(89_511, cw);
      await nothingToAnswerHandler(job, appDb, cw.makeClient as never);
      expect(cw.toggles).toEqual(["resolved"]);
    });

    test("where the mirror says our side spoke, it is left for the follow-up", async () => {
      const cw = chatwoot([{ id: 2, content: "" }]);
      const { conv } = await judge(89_512, cw, { spoken: true });
      expect(cw.toggles).toEqual([]);
      expect(cw.clients()).toBe(0);
      expect(await closeLines(conv.id, false)).toEqual([]);
    });

    test("a reply of ours in the history keeps it open, a private note of ours does not", async () => {
      const replied = chatwoot([
        { id: 1, content: "Olá, como posso ajudar?", type: 1 },
        { id: 2, content: "" },
      ]);
      await judge(89_513, replied);
      expect(replied.toggles).toEqual([]);
      const template = chatwoot([
        { id: 1, content: "Olá", type: 3 },
        { id: 2, content: "" },
      ]);
      await judge(89_514, template);
      expect(template.toggles).toEqual([]);
      const note = chatwoot([
        { id: 1, content: "nota do operador", type: 1, private: true },
        { id: 2, content: "" },
      ]);
      await judge(89_515, note);
      expect(note.toggles).toEqual(["resolved"]);
    });

    test("a request older than the default page keeps the conversation open", async () => {
      const blanks = Array.from({ length: 20 }, (_, i) => ({
        id: 31 + i,
        content: "",
      }));
      const cw = chatwoot(blanks, {
        older: [{ id: 1, content: "meu ingresso não chegou" }],
      });
      await judge(89_516, cw, { trigger: 50 });
      expect(cw.toggles).toEqual([]);
    });

    test("a history too long to read in one batch is not proven blank", async () => {
      const cw = chatwoot([{ id: 200, content: "" }], {
        older: Array.from({ length: 99 }, (_, i) => ({
          id: 1 + i,
          content: "",
        })),
      });
      await judge(89_517, cw, { trigger: 200 });
      expect(cw.toggles).toEqual([]);
      // One row fewer is one batch, and the same blank history closes.
      const short = chatwoot([{ id: 200, content: "" }], {
        older: Array.from({ length: 98 }, (_, i) => ({
          id: 1 + i,
          content: "",
        })),
      });
      await judge(89_518, short, { trigger: 200 });
      expect(short.toggles).toEqual(["resolved"]);
    });

    test("a history read that could not tell closes nothing", async () => {
      // A body that is not a list, or a row the parser cannot read: "could not tell", never "the
      // customer said nothing".
      const bodies: Array<[number, unknown]> = [
        [89_519, {}],
        [89_520, { payload: [{}, { id: 2, content: "", message_type: 0 }] }],
      ];
      for (const [convId, body] of bodies) {
        const cw = chatwoot([{ id: 2, content: "" }], {
          onFullRead: () => body,
        });
        await judge(convId, cw);
        expect(cw.toggles).toEqual([]);
      }
    });

    test("answerable shapes with no text keep it open: attachment, subject, reaction", async () => {
      const shapes: Array<[number, Msg]> = [
        [89_521, { id: 2, content: "", attachments: [{ file_type: "audio" }] }],
        [89_522, { id: 2, content: "", subject: "Reembolso" }],
        [89_523, { id: 2, content: "", reaction: true }],
      ];
      for (const [convId, msg] of shapes) {
        const cw = chatwoot([msg]);
        await judge(convId, cw);
        expect(cw.toggles).toEqual([]);
      }
    });

    test("a newer blank message the receiver has not retired it for yet is left to its own job", async () => {
      // Armed for message 2; message 3 is already in Chatwoot, blank for now, its webhook not yet
      // processed. Its own delay covers the attachment that may still be on the way.
      const cw = chatwoot([
        { id: 2, content: "" },
        { id: 3, content: "" },
      ]);
      await judge(89_550, cw);
      expect(cw.toggles).toEqual([]);
      // Our own private rows past the trigger are not the customer.
      const note = chatwoot([
        { id: 2, content: "" },
        { id: 3, content: "nota", private: true },
      ]);
      await judge(89_551, note);
      expect(note.toggles).toEqual(["resolved"]);
    });

    test("a message the live read names past the history read keeps it open", async () => {
      // Landed between the history read and the live one, its webhook not yet processed.
      const late = chatwoot([{ id: 2, content: "" }], { latest: 3 });
      await judge(89_552, late);
      expect(late.toggles).toEqual([]);
      const same = chatwoot([{ id: 2, content: "" }], { latest: 2 });
      await judge(89_553, same);
      expect(same.toggles).toEqual(["resolved"]);
    });

    test("a job whose row was deleted under it closes nothing", async () => {
      // A re-arm puts a claimed row back to PENDING in place, and the retirement deletes a waiting
      // row: the run still in flight has only the absence to go by.
      const cw = chatwoot([{ id: 2, content: "" }], {
        onLive: async () => {
          await suDb.schedulerJob.deleteMany({
            where: {
              tenantId,
              kind: "NOTHING_TO_ANSWER",
              dedupeKey: nothingToAnswerDedupeKey(threadOf(89_554)),
            },
          });
        },
      });
      await judge(89_554, cw);
      expect(cw.toggles).toEqual([]);
    });

    test("an older message's arm finishing late does not replace a newer one's", async () => {
      const conv = await seedConversation(89_555);
      const arm = (triggerMessageId: number) =>
        armNothingToAnswer({
          tenantId,
          instanceId,
          threadId: threadOf(89_555),
          conversationId: 89_555,
          conversationDbId: conv.id,
          agentId: agentDbId,
          agentBotId: OUR_BOT,
          triggerMessageId,
          base: appDb,
        });
      await arm(3);
      await arm(2);
      expect((await armedRow(89_555))?.payload).toMatchObject({
        triggerMessageId: 3,
      });
      await arm(4);
      expect((await armedRow(89_555))?.payload).toMatchObject({
        triggerMessageId: 4,
      });
    });

    test("a private incoming row is not the customer speaking", async () => {
      const cw = chatwoot([
        { id: 1, content: "nota interna", private: true },
        { id: 2, content: "" },
      ]);
      await judge(89_525, cw);
      expect(cw.toggles).toEqual(["resolved"]);
    });

    test("a thread with no incoming message at all is not closed", async () => {
      const cw = chatwoot([{ id: 2, content: "nota do operador", type: 2 }]);
      await judge(89_526, cw);
      expect(cw.toggles).toEqual([]);
    });

    test("a conversation a person, another bot or an escalation holds is not closed", async () => {
      const held: Array<[number, Parameters<typeof chatwoot>[1]]> = [
        [89_527, { assigneeType: "User", assigneeId: 7 }],
        [89_528, { assigneeType: "AgentBot", assigneeId: 99 }],
        [89_529, { status: "open" }],
        [89_530, { status: "resolved" }],
      ];
      for (const [convId, live] of held) {
        const cw = chatwoot([{ id: 2, content: "" }], live);
        await judge(convId, cw);
        expect(cw.toggles).toEqual([]);
      }
    });

    test("a switched-off or monitoring agent closes nothing, and reads nothing", async () => {
      for (const [convId, data] of [
        [89_531, { enabled: false }],
        [89_532, { mode: "monitoring" as const }],
      ] as const) {
        await suDb.agent.update({ where: { id: agentDbId }, data });
        try {
          const cw = chatwoot([{ id: 2, content: "" }]);
          await judge(convId, cw);
          expect(cw.toggles).toEqual([]);
          expect(cw.clients()).toBe(0);
        } finally {
          await suDb.agent.update({
            where: { id: agentDbId },
            data: { enabled: true, mode: "production" },
          });
        }
      }
    });

    test("a test agent closes only a conversation that activated it", async () => {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "test" },
      });
      try {
        const silent = chatwoot([{ id: 2, content: "" }]);
        await judge(89_546, silent);
        expect(silent.toggles).toEqual([]);
        expect(silent.clients()).toBe(0);
        const conv = await seedConversation(89_547);
        await suDb.conversation.update({
          where: { id: conv.id },
          data: { testActivatedAt: new Date() },
        });
        const job = await armAndClaim(89_547, conv.id);
        const active = chatwoot([{ id: 2, content: "" }]);
        await nothingToAnswerHandler(job, appDb, active.makeClient as never);
        expect(active.toggles).toEqual(["resolved"]);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
    });

    test("an inbox handed to another agent while the job waited closes nothing", async () => {
      const other = await suDb.agent.create({
        data: { tenantId, name: "Outro", systemPrompt: "x", enabled: true },
        select: { id: true },
      });
      try {
        const cw = chatwoot([{ id: 2, content: "" }], {
          onLive: async () => {
            await suDb.inbox.update({
              where: { id: inboxDbId },
              data: { agentId: other.id },
            });
          },
        });
        await judge(89_548, cw);
        expect(cw.toggles).toEqual([]);
      } finally {
        await suDb.inbox.update({
          where: { id: inboxDbId },
          data: { agentId: agentDbId },
        });
      }
    });

    test("an agent switched off while the job reads closes nothing", async () => {
      try {
        const cw = chatwoot([{ id: 2, content: "" }], {
          onLive: async () => {
            await suDb.agent.update({
              where: { id: agentDbId },
              data: { enabled: false },
            });
          },
        });
        await judge(89_533, cw);
        expect(cw.toggles).toEqual([]);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { enabled: true },
        });
      }
    });

    test("a /reset that landed at or after the judged message closes nothing", async () => {
      const at = chatwoot([{ id: 2, content: "" }]);
      await judge(89_534, at, { resetAt: 2 });
      expect(at.toggles).toEqual([]);
      // A /reset BEFORE the judged message is an older episode: the blank message is this one's.
      const before = chatwoot([{ id: 2, content: "" }]);
      await judge(89_535, before, { resetAt: 1 });
      expect(before.toggles).toEqual(["resolved"]);
    });

    test("a job retired while it reads closes nothing", async () => {
      const cw = chatwoot([{ id: 2, content: "" }], {
        onLive: async () => {
          await suDb.schedulerJob.updateMany({
            where: {
              tenantId,
              kind: "NOTHING_TO_ANSWER",
              dedupeKey: nothingToAnswerDedupeKey(threadOf(89_536)),
            },
            data: { claimSeq: { increment: 1 } },
          });
        },
      });
      const { conv } = await judge(89_536, cw);
      expect(cw.toggles).toEqual([]);
      expect(await resolvedBy(89_536)).toBeNull();
      expect(await closeLines(conv.id, false)).toEqual([]);
    });

    test("a close that fails throws, so the scheduler retries it and dead-letters at the end", async () => {
      const cw = chatwoot([{ id: 2, content: "" }], { toggleFails: true });
      const conv = await seedConversation(89_537);
      const job = await armAndClaim(89_537, conv.id);
      await expect(
        nothingToAnswerHandler(job, appDb, cw.makeClient as never),
      ).rejects.toThrow("chatwoot 500");
      expect(await resolvedBy(89_537)).toBeNull();
    });

    test("a payload it cannot read is dropped, not retried", async () => {
      const conv = await seedConversation(89_538);
      const job = await armAndClaim(89_538, conv.id);
      const cw = chatwoot([{ id: 2, content: "" }]);
      const out = await nothingToAnswerHandler(
        { ...job, payload: { conversationId: "89538" } },
        appDb,
        cw.makeClient as never,
      );
      expect(out).toEqual({ outcome: "done" });
      expect(cw.clients()).toBe(0);
    });

    // ---- the retirement ------------------------------------------------------------------------

    test("a new customer message retires the armed job, pending or already claimed", async () => {
      const pendingConv = await seedConversation(89_540);
      await armNothingToAnswer({
        tenantId,
        instanceId,
        threadId: threadOf(89_540),
        conversationId: 89_540,
        conversationDbId: pendingConv.id,
        agentId: agentDbId,
        agentBotId: OUR_BOT,
        triggerMessageId: 2,
        base: appDb,
      });
      await customerWrites(89_540, "esqueci de escrever: quero cancelar", 3);
      // Waiting, it is gone: nothing would ever read it.
      expect(await armedRow(89_540)).toBeNull();

      const claimedConv = await seedConversation(89_541);
      const job = await armAndClaim(89_541, claimedConv.id);
      await customerWrites(89_541, "alô?", 3);
      const cw = chatwoot([{ id: 2, content: "" }]);
      await nothingToAnswerHandler(job, appDb, cw.makeClient as never);
      expect(cw.toggles).toEqual([]);
      // Running, it is tombstoned rather than deleted, so the handler in flight can see it.
      const claimedRow = await armedRow(89_541);
      expect(claimedRow?.status).toBe("DONE");
      expect(claimedRow?.payload).toHaveProperty("cancelledAt");
    });

    test("another delivery of the message it judged does not retire it", async () => {
      // An observer route receives the same event on its own delivery, and a redelivery repeats it:
      // the message is the one the job was armed for, not a newer one.
      const conv = await seedConversation(89_549);
      await armNothingToAnswer({
        tenantId,
        instanceId,
        threadId: threadOf(89_549),
        conversationId: 89_549,
        conversationDbId: conv.id,
        agentId: agentDbId,
        agentBotId: OUR_BOT,
        triggerMessageId: 5,
        base: appDb,
      });
      await customerWrites(89_549, "", 5);
      await customerWrites(89_549, "", 4);
      expect((await armedRow(89_549))?.status).toBe("PENDING");
      await customerWrites(89_549, "oi", 6);
      expect(await armedRow(89_549)).toBeNull();
    });

    test("a message in another conversation leaves this one's job alone", async () => {
      const conv = await seedConversation(89_542);
      await armNothingToAnswer({
        tenantId,
        instanceId,
        threadId: threadOf(89_542),
        conversationId: 89_542,
        conversationDbId: conv.id,
        agentId: agentDbId,
        agentBotId: OUR_BOT,
        triggerMessageId: 2,
        base: appDb,
      });
      await seedConversation(89_543);
      await customerWrites(89_543, "outro assunto", 3);
      expect((await armedRow(89_542))?.status).toBe("PENDING");
    });

    test("a later blank message re-arms a retired job as new work", async () => {
      const conv = await seedConversation(89_544);
      await armAndClaim(89_544, conv.id);
      await customerWrites(89_544, "oi", 3);
      expect((await armedRow(89_544))?.status).toBe("DONE");
      // As if the retired run had failed on its way: the next blank message is new work, and starts
      // with the whole retry budget.
      await suDb.schedulerJob.updateMany({
        where: {
          tenantId,
          kind: "NOTHING_TO_ANSWER",
          dedupeKey: nothingToAnswerDedupeKey(threadOf(89_544)),
        },
        data: { attempts: 4 },
      });
      const cw = chatwoot([
        { id: 2, content: "" },
        { id: 4, content: "" },
      ]);
      await direct(89_544, cw);
      const row = await armedRow(89_544);
      expect(row?.status).toBe("PENDING");
      expect(row?.payload).not.toHaveProperty("cancelledAt");
      expect(row?.attempts).toBe(0);
    });

    // The same retirement as any incoming message: the receiver only reads a command off one.
    test("a /reset retires the armed job", async () => {
      const conv = await seedConversation(89_545);
      await armNothingToAnswer({
        tenantId,
        instanceId,
        threadId: threadOf(89_545),
        conversationId: 89_545,
        conversationDbId: conv.id,
        agentId: agentDbId,
        agentBotId: OUR_BOT,
        triggerMessageId: 2,
        base: appDb,
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "test" },
      });
      await suDb.conversation.update({
        where: { id: conv.id },
        data: { testActivatedAt: new Date() },
      });
      try {
        await customerWrites(89_545, "/reset", 3);
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "production" },
        });
      }
      expect(await armedRow(89_545)).toBeNull();
    });

    test("a close of ours counts as the agent side's, like the follow-up's", () => {
      expect(closedByTheAgentSide("nothing_to_answer")).toBe(true);
    });
  },
);
