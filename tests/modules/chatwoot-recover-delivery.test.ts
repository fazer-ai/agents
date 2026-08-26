import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId } from "@/graph/checkpointer";
import { clearTurnInFlight, markTurnInFlight } from "@/graph/inflight";
import type { RuntimeDeps } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  deliveryRecoveryDedupeKey,
  MAX_RECOVERY_AGE_MS,
  MAX_RECOVERY_ATTEMPTS,
  recoverStrandedDelivery,
  registerDeliveryRecoveryHandler,
} from "@/modules/chatwoot/recover-delivery";
import { JOB_DEATH_LEVEL } from "@/modules/scheduler/lanes";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { getJobHandler } from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";

// Answering the customer whose delivery a process death stranded (issue #295).
//
// The sweep (issue #228) reports the strand and stops there; the ledger row is terminal on DEAD and
// the customer's message is unanswered. What this file pins is the recovery going all the way to
// the effect the issue is about: a reply reaching Chatwoot for a message nothing was ever going to
// answer.
//
// The stub Chatwoot is the seam every other caller uses (`deps.makeClient`), so the REST read the
// recovery depends on is exercised for real up to the socket: the recovery asks for the page that
// ENDS at the stranded message id, finds the message in it, and rebuilds the body from there. A
// mocked module would have proven the call happened; this proves the page is read the way a real
// one arrives.

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

const CHATWOOT_INBOX_ID = 71;
const AGENT_BOT_ID = 11;
const REPLY = "Desculpe a demora, estou aqui!";
// When the customer wrote, in epoch seconds. Deliberately a fixed instant well in the past of any
// test run, so a `lastInboundAt` stamped from the recovery's own clock cannot pass for it.
const SENT_AT = 1_780_000_000;

let tenantId = 0n;
let agentDbId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let deliverySeq = 0;

const threadOf = (convId: number) =>
  chatwootThreadId(tenantId, instanceId, convId);

interface Stub {
  makeClient: RuntimeDeps["makeClient"];
  sent: Array<[number, string]>;
  asked: Array<[number, number | undefined]>;
}

// A Chatwoot that holds one page of history and records what was posted back to it.
function stubChatwoot(opts: { page?: unknown; throwOnRead?: boolean }): Stub {
  const sent: Array<[number, string]> = [];
  const asked: Array<[number, number | undefined]> = [];
  const client = {
    getMessages: async (conversationId: number, o?: { before?: number }) => {
      asked.push([conversationId, o?.before]);
      if (opts.throwOnRead) throw new Error("connect ECONNREFUSED");
      return opts.page ?? { payload: [] };
    },
    sendMessage: async (conversationId: number, content: string) => {
      sent.push([conversationId, content]);
      return {};
    },
    toggleTyping: async () => ({}),
    // Best-effort context reads a turn makes. Present so the stub is a Chatwoot that ANSWERS them
    // rather than one that is missing them: their absence is swallowed by the turn's own catch, and
    // a failure there would look like a passing test.
    listLabels: async () => [],
    listCustomAttributeDefinitions: async () => [],
    kanbanTaskForConversation: async () => null,
  } as unknown as ChatwootClient;
  return { makeClient: async () => client, sent, asked };
}

// `turns` counts how many times a model was built, which is how many turns actually ran. The gate
// decides BEFORE the turn, so a recovery that lets a conversation through on a gate it should have
// closed is visible here even when the turn's own late re-check catches it afterwards and nothing
// reaches the customer.
function depsWith(
  stub: Stub,
  turns: { built: number } = { built: 0 },
): RuntimeDeps {
  return {
    makeClient: stub.makeClient,
    makeModel: () => {
      turns.built += 1;
      return new FakeListChatModel({ responses: [REPLY] });
    },
    checkpointer: new MemorySaver(),
    sleep: async () => {},
  };
}

// One incoming message, in the shape the REST read returns it: `message_type` as an INTEGER, which
// is the divergence from the webhook wire that `messageTypeOf` exists for.
function pageWith(
  msgs: Array<{ id: number; content: string; createdAt?: number }>,
) {
  return {
    payload: msgs.map((m) => ({
      id: m.id,
      content: m.content,
      message_type: 0,
      private: false,
      // Epoch SECONDS, as the REST read gives it.
      created_at: m.createdAt ?? SENT_AT,
      sender: { id: 77, name: "Cliente", type: "contact" },
      attachments: [],
    })),
  };
}

// Polled and scoped: emitFlowEvent is fire-and-forget, so an unpolled read races the write it is
// asserting and an unscoped one answers with a neighbour's row.
async function deliveryLines(convDbId: bigint, waitMs = 2000) {
  const started = Date.now();
  while (true) {
    const rows = await suDb.executionLog.findMany({
      where: { tenantId, stage: "delivery", conversationId: convDbId },
      select: { level: true, source: true, detail: true },
    });
    if (rows.length > 0 || Date.now() - started > waitMs) return rows;
    await Bun.sleep(25);
  }
}

async function seedConversation(
  convId: number,
  over: {
    assigneeType?: string | null;
    assigneeId?: number | null;
    lastEventAt?: Date;
  } = {},
) {
  return suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: over.assigneeType ?? null,
      assigneeId: over.assigneeId ?? null,
      inboxId: inboxDbId,
      threadId: threadOf(convId),
      lastEventAt: over.lastEventAt ?? new Date(),
      contactInboxId: 71_000 + convId,
    },
    select: { id: true },
  });
}

// The ledger row exactly as the sweep leaves it: terminal on DEAD, naming a conversation and a
// message and holding no payload.
async function seedDeadDelivery(over: {
  conversationId: number | null;
  inboundMessageId?: number | null;
  attempts?: number;
  status?: "DEAD" | "PROCESSING" | "PROCESSED";
}): Promise<bigint> {
  deliverySeq += 1;
  const row = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `rec-${process.pid}-${deliverySeq}`,
      event: "message_created",
      status: over.status ?? "DEAD",
      receivedAt: new Date(Date.now() - 60 * 60 * 1000),
      claimedAt: new Date(Date.now() - 60 * 60 * 1000),
      attempts: over.attempts ?? 0,
      conversationId: over.conversationId,
      inboundMessageId:
        over.inboundMessageId === undefined ? 9301 : over.inboundMessageId,
    },
    select: { id: true },
  });
  return row.id;
}

async function ledger(rowId: bigint) {
  return suDb.chatwootWebhookDelivery.findUniqueOrThrow({
    where: { id: rowId },
    select: { status: true, attempts: true },
  });
}

describe.skipIf(!dbUp)("recovering a delivery the sweep gave up on", () => {
  beforeAll(async () => {
    // Registration is what src/index.ts does at boot, and it is idempotent. Read back through
    // `getJobHandler` rather than calling the handler function directly: a handler that is never
    // registered is a claimed job with nowhere to go, which is the failure the registry exists to
    // make impossible.
    //
    // NOT undone afterwards, and the registry being process-global (tests/utils/job-registry.ts) is
    // why that needs saying. What poisons another file is a STUB left behind — this installs the
    // PRODUCTION handler, the same one boot installs, so a neighbour that claims a DELIVERY_RECOVERY
    // finds what it would find in production. Unregistering would be the worse trap: the registrar
    // latches on a module flag, like every other one in this repo, so a later caller would get a
    // silent no-op and its claimed job would have nowhere to go.
    registerDeliveryRecoveryHandler();
    const t = await suDb.tenant.create({
      data: { name: "REC", slug: `rec-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 71,
      baseUrl: "https://chat.recover.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        // Debounce OFF, so the delivery path answers inline and the reply is assertable here. It is
        // ON by default in production, and the recovery goes through it exactly like a live
        // delivery — pinned by its own test below rather than assumed.
        settings: { debounce: { enabled: false } },
      },
    });
    agentDbId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: AGENT_BOT_ID,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `rec-route-${process.pid}`,
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
    if (!dbUp) return;
    for (const table of [
      "execution_logs",
      "scheduler_jobs",
      "chatwoot_webhook_deliveries",
      "conversations",
      "contacts",
      "inboxes",
      "chatwoot_agent_bots",
      "agent_tool_selections",
      "agents",
      "chatwoot_instances",
      "chatwoot_deployments",
    ]) {
      await suDb
        .$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = ${tenantId}`)
        .catch(() => {});
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("the customer gets the answer the strand owed them", async () => {
    const convId = 8901;
    const messageId = 9401;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi, alguém aí?" }]),
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    expect(outcome).toBe("recovered");
    // The whole point of the issue, and the only assertion that is about the customer: a reply
    // reached the conversation nothing was going to answer.
    expect(stub.sent).toEqual([[convId, REPLY]]);
    expect(await ledger(rowId)).toEqual({ status: "PROCESSED", attempts: 1 });
  });

  test("the loss the sweep reported is closed by a line of its own", async () => {
    // `retireCoveredDeliveries` writes its correction only for rows it moves out of DEAD itself, and
    // this row left DEAD at the claim — so the turn settling it afterwards sees PROCESSING and takes
    // the branch that writes nothing. Without a line here the row just leaves the worklist while the
    // page an operator already received stays open, pointing at a customer they can no longer find.
    const convId = 8916;
    const messageId = 9416;
    const conv = await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "voltou?" }]),
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("recovered");

    const lines = await deliveryLines(conv.id);
    const closing = lines.filter(
      (l) => (l.detail as Record<string, unknown>).outcome === "recovered",
    );
    expect(closing).toHaveLength(1);
    const detail = closing[0]?.detail as Record<string, unknown>;
    // The ids the sweep's loss line carries, so an operator can read the two as one story.
    expect(detail.messageId).toBe(messageId);
    expect(detail.conversationId).toBe(convId);
    // `warn`, matching the correction it stands in for: it must not page the channel the loss paged.
    expect(closing[0]?.level).toBe("warn");
    expect(closing[0]?.source).toBe("inbox");
  });

  test("a recovery that could not run leaves no closing line", async () => {
    // The line says the loss ENDED. Written on a pass that recovered nothing, it would close a page
    // about a customer who is still waiting, which is worse than not writing it at all.
    const convId = 8917;
    const conv = await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: 9417,
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stubChatwoot({ throwOnRead: true })),
      }),
    ).toBe("deferred");
    expect(await deliveryLines(conv.id, 200)).toHaveLength(0);
  });

  test("the page it reads is the one that ENDS at the stranded message", async () => {
    // `before` is exclusive, so the anchor is id+1. Off by one and the recovery reads the page
    // BEFORE the message, never finds it, and calls a perfectly recoverable delivery unrecoverable
    // — on long conversations only, which is the kind of miss that ships.
    const convId = 8902;
    const messageId = 9402;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "e aí?" }]),
    });

    await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    // The FIRST read is the recovery's; the turn it hands off to reads history of its own.
    expect(stub.asked[0]).toEqual([convId, messageId + 1]);
  });

  test("the gates run: a conversation another bot holds is not answered", async () => {
    // This is the design's whole justification. The recovery does not re-implement the gates, it
    // re-runs the delivery path so they run where they already run — and a recovery that reached
    // the customer here would be one answering on behalf of a bot that no longer owns the
    // conversation. "recovered" says the path ran, never that it spoke.
    const convId = 8903;
    const messageId = 9403;
    await seedConversation(convId, {
      assigneeType: "AgentBot",
      assigneeId: AGENT_BOT_ID + 500,
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    const turns = { built: 0 };

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub, turns),
    });

    expect(outcome).toBe("recovered");
    expect(stub.sent).toEqual([]);
    // No turn was even built. The turn's own re-check would also have caught this one, but only
    // after spending the model and writing a checkpoint it then rolls back — and that fallback is
    // what a recovery that resolved no bot identity silently falls back ON, because the ownership
    // gate goes LOOSE when it does not know which bot it is.
    expect(turns.built).toBe(0);
    expect((await ledger(rowId)).status).toBe("PROCESSED");
  });

  test("the bot that answers is derived from the inbox, not from the ledger", async () => {
    // A conversation assigned to OUR bot is the ordinary production state, and it is the case that
    // separates a derived identity from a missing one: the ledger records no route, so a recovery
    // that failed to resolve which bot it is would read its own conversation as held by a stranger
    // and go silent — a strand that looks handled.
    const convId = 8915;
    const messageId = 9415;
    await seedConversation(convId, {
      assigneeType: "AgentBot",
      assigneeId: AGENT_BOT_ID,
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "ficou de me responder" }]),
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    expect(outcome).toBe("recovered");
    expect(stub.sent).toEqual([[convId, REPLY]]);
  });

  test("a row that is not DEAD is left exactly where it is", async () => {
    // A PROCESSING row is one whose owner has not been declared gone. Recovering it would run a
    // second turn beside a live one, and both turns' tools would fire.
    const convId = 8904;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: 9404,
      status: "PROCESSING",
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: 9404, content: "oi" }]),
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    expect(outcome).toBe("superseded");
    // Nothing was read either: the state is decided before any network is spent.
    expect(stub.asked).toEqual([]);
    expect(await ledger(rowId)).toEqual({ status: "PROCESSING", attempts: 0 });
  });

  test("a turn already running on the conversation defers, it does not queue beside it", async () => {
    const convId = 8905;
    const messageId = 9405;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });

    markTurnInFlight(threadOf(convId));
    let outcome: string;
    try {
      outcome = await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      });
    } finally {
      clearTurnInFlight(threadOf(convId));
    }

    expect(outcome).toBe("deferred");
    expect(stub.sent).toEqual([]);
    // Deferred keeps the budget: nothing was attempted, so nothing was spent.
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
  });

  test("an unreachable account defers and keeps its budget", async () => {
    // A revoked token or an account that is down is repairable by an operator, so it is a deferral
    // rather than a verdict. Spending an attempt here would burn the budget on the operator's
    // outage instead of on the delivery.
    const convId = 8906;
    const messageId = 9406;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stubChatwoot({ throwOnRead: true })),
    });

    expect(outcome).toBe("deferred");
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
  });

  test("a message Chatwoot no longer has is unrecoverable", async () => {
    // Deleted message, or a deleted conversation. There is nothing to answer, and no number of
    // passes changes that — so the row stays DEAD and stays in the operator's worklist.
    const convId = 8907;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: 9407,
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(
        stubChatwoot({ page: pageWith([{ id: 9999, content: "outra" }]) }),
      ),
    });

    expect(outcome).toBe("unrecoverable");
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
  });

  test("a conversation the mirror never knew is unrecoverable", async () => {
    // No mirror row means nothing here can say who should answer or whether they still may, and a
    // row this old is not going to grow one.
    const rowId = await seedDeadDelivery({
      conversationId: 8908,
      inboundMessageId: 9408,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: 9408, content: "oi" }]),
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    expect(outcome).toBe("unrecoverable");
    expect(stub.asked).toEqual([]);
  });

  test("a row naming no message cannot be rebuilt", async () => {
    // What an older build's ledger rows look like: the sweep reports them, and there is no second
    // source to rebuild a body from.
    const convId = 8909;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: null,
    });

    // The page HAS a message, so the verdict cannot come from failing to find one: the row is
    // refused on what it names, before any network is spent.
    const stub = stubChatwoot({
      page: pageWith([{ id: 9409, content: "oi" }]),
    });
    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    expect(outcome).toBe("unrecoverable");
    expect(stub.asked).toEqual([]);
  });

  test("losing the claim race is a deferral, not a recovery", async () => {
    // The window the single-statement CAS exists to close: two passes read the same DEAD row, one
    // claims it, and the loser must not report a recovery it did not perform. Reported as recovered,
    // a worklist would count one answer for every pass that raced.
    const convId = 8914;
    const messageId = 9414;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi?" }]),
    });
    const stolen = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi?" }]),
    });
    // The theft lands exactly where the real race lands: after this pass read the row as DEAD and
    // before it claims.
    const racing: RuntimeDeps = {
      ...depsWith(stub),
      makeClient: async (cfg) => {
        await suDb.chatwootWebhookDelivery.update({
          where: { id: rowId },
          data: { status: "PROCESSING" },
        });
        const inner = stolen.makeClient;
        if (!inner) throw new Error("stub has no client factory");
        return inner(cfg);
      },
    };

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: racing,
    });

    expect(outcome).toBe("superseded");
    expect(stub.sent).toEqual([]);
    expect(stolen.sent).toEqual([]);
    expect(await ledger(rowId)).toEqual({ status: "PROCESSING", attempts: 0 });
  });

  test("the customer's own clock reaches the mirror, not the rescue's", async () => {
    // `lastInboundAt` anchors the WhatsApp 24h window and the follow-up "new episode" gate, and the
    // mirror falls back to `now` when the body names no activity time. A recovery runs at least a
    // staleness window after the message, so the fallback moves the anchor forward by however long
    // the row sat stranded — in the unsafe direction, since a proactive send made later then reads
    // as in-window when it is not.
    const convId = 8924;
    const messageId = 9426;
    // The mirror as the strand left it: its last known event predates the message nobody handled,
    // because the delivery that would have mirrored it is the one that died.
    await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 60) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(
          stubChatwoot({
            page: pageWith([{ id: messageId, content: "oi" }]),
          }),
        ),
      }),
    ).toBe("recovered");

    const row = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { lastInboundAt: true },
    });
    expect(row.lastInboundAt).toEqual(new Date(SENT_AT * 1000));
  });

  test("a second strand on a conversation just recovered is not blocked by the first", async () => {
    // The other half of the per-conversation claim: it has to be RELEASED. Held, the recovery of a
    // conversation's second stranded message would defer for the life of the process, which is the
    // ordinary case — a process death strands every delivery it was working, and one conversation
    // often has more than one.
    const convId = 8925;
    await seedConversation(convId);
    const first = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: 9427,
    });
    const second = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: 9428,
    });
    const stubA = stubChatwoot({
      page: pageWith([{ id: 9427, content: "oi" }]),
    });
    const stubB = stubChatwoot({
      page: pageWith([{ id: 9428, content: "alguém?" }]),
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: first,
        base: appDb,
        deps: depsWith(stubA),
      }),
    ).toBe("recovered");
    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: second,
        base: appDb,
        deps: depsWith(stubB),
      }),
    ).toBe("recovered");
    expect(stubB.sent).toEqual([[convId, REPLY]]);
  });

  test("a strand too old to still be a recovery is not answered", async () => {
    // Past the ceiling the reply stops being a late answer and becomes a stranger reopening a
    // conversation that moved on — and on an official WhatsApp provider a free-form send outside
    // the 24h window is rejected outright, caught by the delivery path, and the row marked PROCESSED
    // with the customer still unanswered. The DEAD worklist is the honest place for it.
    const convId = 8918;
    const messageId = 9418;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
      now: new Date(Date.now() + MAX_RECOVERY_AGE_MS),
    });

    expect(outcome).toBe("unrecoverable");
    // Refused before any network: the row's own receipt answers it.
    expect(stub.asked).toEqual([]);
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
  });

  test("a strand one minute inside the ceiling still runs", async () => {
    // The pair that makes the ceiling a boundary rather than a direction. `seedDeadDelivery` dates
    // its row an hour back, so this clock sits just under the limit.
    const convId = 8919;
    const messageId = 9419;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "ainda aí?" }]),
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
      now: new Date(Date.now() + MAX_RECOVERY_AGE_MS - 61 * 60 * 1000),
    });

    expect(outcome).toBe("recovered");
    expect(stub.sent).toEqual([[convId, REPLY]]);
  });

  test("two strands on one conversation do not run two turns at once", async () => {
    // The scheduler drains its lane concurrently, so a process death that stranded two messages of
    // one conversation has both rows claimed in the same tick. The row CAS says nothing about that —
    // they are different rows — and `isTurnInFlight` cannot either, because a turn marks itself deep
    // inside runAgentTurn, several awaits after the check. Both would read false and both would run.
    const convId = 8923;
    await seedConversation(convId);
    const first = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: 9424,
    });
    const second = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: 9425,
    });
    const stubA = stubChatwoot({
      page: pageWith([{ id: 9424, content: "oi" }]),
    });
    const stubB = stubChatwoot({
      page: pageWith([{ id: 9425, content: "alguém?" }]),
    });

    const [a, b] = await Promise.all([
      recoverStrandedDelivery({
        tenantId,
        deliveryRowId: first,
        base: appDb,
        deps: depsWith(stubA),
      }),
      recoverStrandedDelivery({
        tenantId,
        deliveryRowId: second,
        base: appDb,
        deps: depsWith(stubB),
      }),
    ]);

    // One ran, the other deferred — which one is a race and does not matter, only that they are not
    // the same answer.
    expect([a, b].filter((o) => o === "recovered")).toHaveLength(1);
    expect([a, b].filter((o) => o === "deferred")).toHaveLength(1);
    // And exactly one reply reached the customer.
    expect([...stubA.sent, ...stubB.sent]).toHaveLength(1);
  });

  test("the attempt budget is a ceiling, not a hint", async () => {
    // A row that fails for a reason recovery cannot fix would otherwise be retried for the life of
    // the install, and every pass spends a real turn.
    const convId = 8910;
    const messageId = 9410;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      attempts: MAX_RECOVERY_ATTEMPTS,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    expect(outcome).toBe("unrecoverable");
    expect(stub.sent).toEqual([]);
    expect(await ledger(rowId)).toEqual({
      status: "DEAD",
      attempts: MAX_RECOVERY_ATTEMPTS,
    });
  });

  test("one attempt below the ceiling still runs", async () => {
    // The pair that makes the comparison a boundary rather than a direction: `>=` and `>` disagree
    // on exactly this row, and only one of them spends the third attempt the budget grants.
    const convId = 8911;
    const messageId = 9411;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      attempts: MAX_RECOVERY_ATTEMPTS - 1,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "ainda preciso de ajuda" }]),
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    expect(outcome).toBe("recovered");
    expect(stub.sent).toEqual([[convId, REPLY]]);
    expect(await ledger(rowId)).toEqual({
      status: "PROCESSED",
      attempts: MAX_RECOVERY_ATTEMPTS,
    });
  });

  test("with debounce on, the recovery arms the burst instead of answering twice", async () => {
    // Production's default, and the reason the outcome is named "recovered" rather than "answered":
    // the delivery path decides HOW the answer happens, and with coalescing on it hands the reply to
    // the flush — which then reads past the watermark and covers the stranded message together with
    // anything the customer wrote while the row sat DEAD.
    const convId = 8913;
    const messageId = 9413;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi?" }]),
    });

    await suDb.agent.update({
      where: { id: agentDbId },
      data: { settings: { debounce: { enabled: true, windowSeconds: 15 } } },
    });
    let outcome: string;
    try {
      outcome = await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      });
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { settings: { debounce: { enabled: false } } },
      });
    }

    expect(outcome).toBe("recovered");
    expect(stub.sent).toEqual([]);
    const job = await suDb.schedulerJob.findFirst({
      where: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: `debounce:${threadOf(convId)}`,
      },
      select: { status: true },
    });
    expect(job?.status).toBe("PENDING");
    expect((await ledger(rowId)).status).toBe("PROCESSED");
  });

  describe("the job that runs it", () => {
    function jobFor(payload: Record<string, unknown>, id = 1n): ClaimedJob {
      return {
        id,
        tenantId,
        kind: "DELIVERY_RECOVERY",
        payload,
        attempts: 0,
        claimSeq: 0,
      };
    }

    test("finished work completes the job, whichever way it finished", async () => {
      // Three outcomes, one scheduler answer. A retry here would spend the failure budget on work
      // that is done — and on the `superseded` row, on work somebody else is doing right now.
      const convId = 8920;
      await seedConversation(convId);
      const notDead = await seedDeadDelivery({
        conversationId: convId,
        inboundMessageId: 9420,
        status: "PROCESSED",
      });
      const spent = await seedDeadDelivery({
        conversationId: convId,
        inboundMessageId: 9421,
        attempts: MAX_RECOVERY_ATTEMPTS,
      });

      for (const rowId of [notDead, spent]) {
        const handler = getJobHandler("DELIVERY_RECOVERY");
        if (!handler) throw new Error("the recovery handler is not registered");
        const result = await handler(
          jobFor({ deliveryRowId: String(rowId) }),
          appDb,
        );
        expect(result.outcome).toBe("done");
      }
    });

    test("a deferral FAILS the job, so the ladder is bounded and ends somewhere", async () => {
      // `reschedule` would be the intuitive answer and it is the wrong one: it CLEARS the failure
      // budget, so a conversation whose account stays unreachable would be retried for the life of
      // the install with nothing ever saying so. `fail` backs off, dies at the scheduler's cap, and
      // reaches the dead-letter hook, which is the only place that can state the recovery is not
      // coming.
      const convId = 8921;
      const messageId = 9422;
      await seedConversation(convId);
      const rowId = await seedDeadDelivery({
        conversationId: convId,
        inboundMessageId: messageId,
      });

      const handler = getJobHandler("DELIVERY_RECOVERY");
      if (!handler) throw new Error("the recovery handler is not registered");
      markTurnInFlight(threadOf(convId));
      let result: Awaited<ReturnType<typeof handler>>;
      try {
        result = await handler(jobFor({ deliveryRowId: String(rowId) }), appDb);
      } finally {
        clearTurnInFlight(threadOf(convId));
      }

      expect(result.outcome).toBe("fail");
      // Untouched: a deferral spends no attempt, so the budget survives the failing job.
      expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
    });

    test("a row id that is not plainly decimal names no row at all", async () => {
      // `BigInt` accepts more spellings than `String(bigint)` ever produces — "0x10" is sixteen,
      // " 12 " is twelve, "" is zero — so a lenient parse turns a malformed payload into a
      // RECOVERY OF A DIFFERENT ROW rather than into a refusal. The refusal is what is asserted:
      // the real row keeps its budget and nothing was attempted on it.
      const convId = 8922;
      await seedConversation(convId);
      const rowId = await seedDeadDelivery({
        conversationId: convId,
        inboundMessageId: 9423,
      });

      const handler = getJobHandler("DELIVERY_RECOVERY");
      if (!handler) throw new Error("the recovery handler is not registered");
      const result = await handler(
        jobFor({ deliveryRowId: `0x${rowId.toString(16)}` }),
        appDb,
      );

      expect(result.outcome).toBe("done");
      expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
    });

    test("a job naming no row completes instead of retrying five times", async () => {
      // No attempt can produce a row id the payload does not carry, and failing would spend five
      // attempts and then announce a lost message this job never identified.
      const handler = getJobHandler("DELIVERY_RECOVERY");
      if (!handler) throw new Error("the recovery handler is not registered");
      for (const payload of [
        {},
        { deliveryRowId: 42 },
        { deliveryRowId: "x" },
      ]) {
        expect((await handler(jobFor(payload), appDb)).outcome).toBe("done");
      }
    });

    test("its death is announced by the scheduler, at a level that does not page twice", () => {
      // No hook of its own: `dispatchDeadLetter` announces every kind, and its generic line already
      // carries the delivery row id — the dedupe key IS it. What a hook here would lose is the
      // re-arm suppression that path does, and the level living next to the other twelve answers.
      //
      // `warn` because the operator has their own way back: the sweep paged at `error` when it
      // declared this row DEAD, and the row is still in the `WHERE status = 'DEAD'` worklist.
      expect(deliveryRecoveryDedupeKey(987_654n)).toBe(
        "delivery-recovery:987654",
      );
      expect(JOB_DEATH_LEVEL.DELIVERY_RECOVERY).toBe("warn");
    });
  });

  test("a second recovery of the same row answers once", async () => {
    // Two passes overlapping is the ordinary case for a worklist, and the customer must not be
    // answered twice. The claim is the single statement that decides it.
    const convId = 8912;
    const messageId = 9412;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi?" }]),
    });

    const first = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });
    const second = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    expect(first).toBe("recovered");
    // Not "recovered", and not a retry either: the row is PROCESSED now, and the second pass is
    // looking at a delivery that is no longer stranded.
    expect(second).toBe("superseded");
    expect(stub.sent).toEqual([[convId, REPLY]]);
    expect(await ledger(rowId)).toEqual({ status: "PROCESSED", attempts: 1 });
  });
});
