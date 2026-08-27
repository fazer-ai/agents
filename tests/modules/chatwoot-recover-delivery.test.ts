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
// An inbox BOUND to an agent that has no `ChatwootAgentBot` row: the persona was never provisioned,
// or its row was deleted out of band. Deliveries still reach it, through another persona's route.
const NO_PERSONA_INBOX = 72;
// An inbox the mirror knows and NOBODY is bound to: #318's `no_agent`, whose operator-facing line
// the delivery path writes.
const UNBOUND_INBOX = 73;
const AGENT_BOT_ID = 11;
const REPLY = "Desculpe a demora, estou aqui!";
// When the customer wrote, in epoch seconds. An hour ago rather than a fixed literal: it has to be
// inside `MAX_RECOVERY_AGE_MS` for the recovery to run at all, and far enough from `now` that a
// `lastInboundAt` stamped from the recovery's own clock cannot pass for it.
const SENT_AT = Math.floor(Date.now() / 1000) - 3600;

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
//
// `conv` is the LIVE conversation the recovery reads before rebuilding anything, in the shape a real
// `GET /conversations/:id` returns (MEASURED against the fork: `id` is the display id, `status` is a
// string, the assignee lives under `meta`, and there is no `contact_inbox`). It defaults to an
// unassigned pending conversation whose last activity is the message's own time, which is what a
// real account reports for a conversation whose newest event IS that message.
function stubChatwoot(opts: {
  page?: unknown;
  // What the UNANCHORED read returns — the newest page, which is what says whether the customer has
  // written again since the strand. Defaults to the anchored page, which is the ordinary case: a
  // conversation whose newest message still IS the stranded one.
  recent?: unknown;
  throwOnRead?: boolean;
  conv?: {
    status?: string;
    assigneeType?: string | null;
    assigneeId?: number | null;
    lastActivityAt?: number;
  };
}): Stub {
  const sent: Array<[number, string]> = [];
  const asked: Array<[number, number | undefined]> = [];
  const c = opts.conv ?? {};
  const client = {
    getConversation: async (conversationId: number) => {
      if (opts.throwOnRead) throw new Error("connect ECONNREFUSED");
      return {
        id: conversationId,
        status: c.status ?? "pending",
        inbox_id: CHATWOOT_INBOX_ID,
        last_activity_at: c.lastActivityAt ?? SENT_AT,
        timestamp: c.lastActivityAt ?? SENT_AT,
        meta: {
          ...(c.assigneeType != null
            ? {
                assignee_type: c.assigneeType,
                assignee: { id: c.assigneeId, name: "outro" },
              }
            : { assignee: null }),
          sender: { id: 77, name: "Cliente" },
        },
      };
    },
    getMessages: async (conversationId: number, o?: { before?: number }) => {
      asked.push([conversationId, o?.before]);
      if (opts.throwOnRead) throw new Error("connect ECONNREFUSED");
      if (o?.before === undefined)
        return opts.recent ?? opts.page ?? { payload: [] };
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
// is the divergence from the webhook wire that `messageTypeOf` exists for, and `inbox_id` as a
// scalar beside it (MEASURED at the fork: `api/v1/models/_message.json.jbuilder` renders
// `json.inbox_id message.inbox_id` on every message the index serializes).
function pageWith(
  msgs: Array<{ id: number; content: string; createdAt?: number }>,
  // `null` drops the key, which is what a Chatwoot that does not render it looks like from here.
  inboxId: number | null = CHATWOOT_INBOX_ID,
) {
  return {
    payload: msgs.map((m) => ({
      id: m.id,
      content: m.content,
      message_type: 0,
      private: false,
      ...(inboxId !== null ? { inbox_id: inboxId } : {}),
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
      select: { level: true, source: true, agentId: true, detail: true },
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
    status?: string;
    redirectOriginDisplayId?: number | null;
    redirectOriginAt?: number;
    // The mirror's inbox FK, nullable in the schema and left null by every event that named no
    // inbox (`upsertInbox` returns null, and the create writes it). Overridable so the recovery can
    // be asked what it rebuilds from a mirror that never learned the route.
    inboxId?: bigint | null;
  } = {},
) {
  return suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: over.status ?? "pending",
      assigneeType: over.assigneeType ?? null,
      assigneeId: over.assigneeId ?? null,
      inboxId: over.inboxId === undefined ? inboxDbId : over.inboxId,
      threadId: threadOf(convId),
      lastEventAt: over.lastEventAt ?? new Date(),
      contactInboxId: 71_000 + convId,
      redirectOriginDisplayId: over.redirectOriginDisplayId ?? null,
      // Stamped with the pairing, as the mirror always does: a pairing reaches the row from a
      // webhook, and every webhook carries the `updated_at` that orders it. A fixture that sets one
      // without the other is a row production cannot produce.
      chatwootRedirectOriginAt:
        over.redirectOriginDisplayId != null
          ? (over.redirectOriginAt ?? SENT_AT)
          : null,
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
  // How long ago THIS application inserted the row, which is not when the customer wrote.
  receivedAgoMs?: number;
}): Promise<bigint> {
  deliverySeq += 1;
  const row = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `rec-${process.pid}-${deliverySeq}`,
      event: "message_created",
      status: over.status ?? "DEAD",
      receivedAt: new Date(Date.now() - (over.receivedAgoMs ?? 60 * 60 * 1000)),
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
    const orphan = await suDb.agent.create({
      data: {
        tenantId,
        name: "Sem persona",
        systemPrompt: "Você é prestativa.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: { debounce: { enabled: false } },
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: NO_PERSONA_INBOX,
        name: "Sem persona",
        agentId: orphan.id,
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: UNBOUND_INBOX,
        name: "Sem agente",
      },
    });
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

  test("a conversation the mirror still calls resolved is answered anyway", async () => {
    // The case that refuted this file's first design. An incoming message on a resolved conversation
    // REOPENS it (MEASURED at the fork: `Message#reopen_resolved_conversation` — `pending` on a bot
    // inbox, `open` otherwise), and the delivery that would have mirrored that is the one that died.
    // Built from the mirror alone, the body says `resolved`, `shouldBotHandle` refuses, the row is
    // marked PROCESSED and this reports a recovery that answered nobody. A customer writing again
    // after a conversation was resolved is the ordinary way a new episode starts.
    const convId = 8926;
    const messageId = 9429;
    const conv = await seedConversation(convId, {
      status: "resolved",
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "voltei" }]),
      // What Chatwoot actually holds: the reopen already happened there.
      conv: { status: "pending" },
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("recovered");
    expect(stub.sent).toEqual([[convId, REPLY]]);

    // And the mirror is REPAIRED, not merely bypassed: every gate downstream reads this row, so
    // leaving it on `resolved` would hand the next delivery the same wrong answer.
    const row = await suDb.conversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { status: true },
    });
    expect(row.status).toBe("pending");
  });

  test("a route whose agent has no persona bot is refused, not answered loosely", async () => {
    // `agentBotChatwootId` answers null for an inbox bound to an agent that was never provisioned a
    // `ChatwootAgentBot` (or whose row was deleted out of band), and handing that null on is worse
    // than refusing: `heldByAnotherParty` compares ids, so with no identity it cannot, the gate goes
    // LOOSE, and a conversation another AgentBot holds reads as ours. A live delivery never reaches
    // that state — its `agentBotId` is the route token's bot, and the route exists because the bot
    // does. MEASURED before the fence existed: the turn ran and this stub accepted the post over the
    // other bot's conversation. Against a real client it would not have sent — the persona's token
    // is what posts, and a client built without one refuses by name (issue #79) — so the true cost
    // of passing the null on is a model call spent to post nothing and a recovery reported anyway.
    const convId = 8950;
    const messageId = 9450;
    await seedConversation(convId, {
      inboxId: null,
      assigneeType: "AgentBot",
      assigneeId: AGENT_BOT_ID + 500,
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }], NO_PERSONA_INBOX),
      conv: { assigneeType: "AgentBot", assigneeId: AGENT_BOT_ID + 500 },
    });
    const turns = { built: 0 };

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub, turns),
      }),
    ).toBe("unrecoverable");
    expect(stub.sent).toEqual([]);
    expect(turns.built).toBe(0);
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
  });

  test("the same refusal holds when nobody else owns the conversation", async () => {
    // Not narrowed to "another bot holds it": what is missing is the identity, not the comparison.
    // The reply is posted with the persona's token, and a client built without one refuses the call
    // by name rather than sending (issue #79) — so an unassigned conversation on this inbox would
    // spend a model call to post nothing and then report a recovery.
    const convId = 8951;
    const messageId = 9451;
    await seedConversation(convId, {
      inboxId: null,
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }], NO_PERSONA_INBOX),
    });
    const turns = { built: 0 };

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub, turns),
      }),
    ).toBe("unrecoverable");
    expect(turns.built).toBe(0);
  });

  test("an inbox bound to NOBODY still runs the path, which is what writes the line", async () => {
    // The neighbouring state, and it must not be swept into the refusal above: an inbox with no
    // agent at all is #318's `no_agent`, and the operator's line for it is written by the delivery
    // path. Refusing here would take that line away from the one customer message it is about.
    const convId = 8952;
    const messageId = 9452;
    await seedConversation(convId, {
      inboxId: null,
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }], UNBOUND_INBOX),
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("recovered");
    expect(stub.sent).toEqual([]);
    expect((await ledger(rowId)).status).toBe("PROCESSED");
  });

  test("a newest page that does not reach the stranded message refuses", async () => {
    // One unanchored page is the newest twenty. Twenty outgoing or activity messages since the
    // strand push a newer CUSTOMER message off it, and `maxIncomingId` would then find nothing and
    // replay a message the customer passed hours ago. The page answers the question only when it
    // holds something at or below the stranded id.
    const convId = 8953;
    const messageId = 9453;
    await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "tem alguém?" }]),
      // A page of OUTGOING messages, every id above the stranded one. `maxIncomingId` finds nothing
      // in it — which is exactly the trap: the page says "no newer customer message" while never
      // reaching back far enough to have seen one.
      recent: {
        payload: Array.from({ length: 20 }, (_, i) => ({
          id: messageId + 10 + i,
          content: `nota ${i}`,
          message_type: 1,
          private: false,
          inbox_id: CHATWOOT_INBOX_ID,
          created_at: SENT_AT,
          sender: { id: 5, name: "Atendente" },
          attachments: [],
        })),
      },
    });
    const turns = { built: 0 };

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub, turns),
      }),
    ).toBe("unrecoverable");
    expect(turns.built).toBe(0);
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
  });

  test("an empty newest page is a degraded read, not a busy conversation", async () => {
    // The account rendered nothing where the anchored read just found this message. That is the
    // account answering with something unusable, which the next attempt may not — so it keeps its
    // budget instead of being written off.
    const convId = 8954;
    const messageId = 9454;
    await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "tem alguém?" }]),
      recent: { payload: [] },
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("unreachable");
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
  });

  test("a customer who wrote again is not answered about the older message", async () => {
    // The delivery path CANNOT answer a message a newer one has passed: `shouldPost` re-fetches,
    // sees the newer incoming id and withholds the reply, and the turn comes back "superseded". The
    // path still settles the row, so without this check the recovery spends a model call, posts
    // nothing, marks the row PROCESSED and writes a closing line saying the loss ended — with the
    // customer never answered about the message that was stranded.
    //
    // And nothing else covers it: the direct turn feeds the graph its OWN trigger text, so the
    // newer message's turn answered the newer message. The stranded one was never ingested, because
    // ingestion is the turn its delivery died before reaching.
    //
    // `unrecoverable`, asked before the claim: a newer message never un-arrives, so no attempt can
    // change the answer, and the row stays DEAD in the worklist where an operator can still read it.
    const convId = 8940;
    const messageId = 9443;
    const conv = await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "tem alguém?" }]),
      // The customer wrote again while the row sat stranded.
      recent: pageWith([
        { id: messageId, content: "tem alguém?" },
        { id: messageId + 4, content: "esqueça, já resolvi" },
      ]),
    });
    const turns = { built: 0 };

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub, turns),
      }),
    ).toBe("unrecoverable");
    expect(stub.sent).toEqual([]);
    // No turn is even built: the refusal is asked before the claim, so it spends neither an attempt
    // nor a model call.
    expect(turns.built).toBe(0);
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
    // And no closing line: the loss is still open, which is the honest state.
    const lines = await deliveryLines(conv.id, 400);
    expect(
      lines.filter(
        (l) => (l.detail as Record<string, unknown>).outcome === "recovered",
      ),
    ).toEqual([]);
  });

  test("a newer OUTGOING message does not block the recovery", async () => {
    // The predicate is the delivery path's own (`maxIncomingId`), so only what the CUSTOMER said
    // counts. An away message, an operator's note or our own reply posted after the strand moves the
    // conversation forward without answering the stranded message, and refusing there would leave a
    // recoverable customer message sitting in the worklist forever.
    const convId = 8941;
    const messageId = 9444;
    await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const page = pageWith([{ id: messageId, content: "tem alguém?" }]);
    const stub = stubChatwoot({
      page,
      recent: {
        payload: [
          ...page.payload,
          {
            id: messageId + 4,
            content: "Estamos fora do horário de atendimento.",
            // OUTGOING, in the integer spelling the REST read uses.
            message_type: 1,
            private: false,
            inbox_id: CHATWOOT_INBOX_ID,
            created_at: SENT_AT,
            sender: { id: 5, name: "Atendente" },
            attachments: [],
          },
        ],
      },
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("recovered");
    expect(stub.sent).toEqual([[convId, REPLY]]);
  });

  test("a mirror that never learned the inbox rebuilds it from the live message", async () => {
    // The route is the one thing the rebuilt body cannot get wrong quietly. `Conversation.inboxId`
    // is nullable and the mirror writes it null for any event that named no inbox (`upsertInbox`
    // returns null and the create stores it), so a conversation whose first mirrored event was
    // sparse holds no route at all — and the delivery that would have taught it is the one that
    // died. Built from that row, the body carries no `inbox_id`, `runAgentTurn` returns "skipped" on
    // its first line, and the row is still marked PROCESSED with a closing line saying the loss
    // ended.
    //
    // Chatwoot knows the answer and we already hold it: every message the index serializes carries
    // `inbox_id` (MEASURED at the fork's `_message.json.jbuilder`).
    const convId = 8936;
    const messageId = 9439;
    const conv = await seedConversation(convId, {
      inboxId: null,
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "tem alguém?" }]),
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("recovered");
    expect(stub.sent).toEqual([[convId, REPLY]]);
    expect(await ledger(rowId)).toEqual({ status: "PROCESSED", attempts: 1 });
    // And the mirror learns the route on the way through, like any other delivery.
    const row = await suDb.conversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { inboxId: true },
    });
    expect(row.inboxId).toBe(inboxDbId);
  });

  test("the route the message names is what decides which bot we are", async () => {
    // The other half of the same read, and the one that costs a wrong ANSWER rather than a missing
    // one. `agentBotChatwootId` is asked about the agent bound to the route, so a route resolved
    // from a mirror that holds none leaves `agentBotId` null — and with no bot identity
    // `heldByAnotherParty` cannot compare ids, so the ownership gate goes LOOSE and the recovery
    // answers over a bot that owns the conversation.
    const convId = 8939;
    const messageId = 9442;
    await seedConversation(convId, {
      inboxId: null,
      assigneeType: "AgentBot",
      assigneeId: AGENT_BOT_ID + 500,
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
      conv: { assigneeType: "AgentBot", assigneeId: AGENT_BOT_ID + 500 },
    });
    const turns = { built: 0 };

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub, turns),
      }),
    ).toBe("recovered");
    expect(stub.sent).toEqual([]);
    expect(turns.built).toBe(0);
  });

  test("the mirror answers the route when the account renders no inbox scalar", async () => {
    // The second reading, and it is the one the code had before: an account whose message JSON
    // carries no `inbox_id` is still recoverable while the mirror knows the conversation's route.
    // Demoted rather than dropped — the live message wins where the two disagree, because it is the
    // field `Message#webhook_data` builds the wire's `inbox` from.
    const convId = 8938;
    const messageId = 9441;
    await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "tem alguém?" }], null),
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("recovered");
    expect(stub.sent).toEqual([[convId, REPLY]]);
  });

  test("a rebuild that can name no inbox at all leaves the loss open", async () => {
    // Both readings silent: the account rendered no `inbox_id` on the message and the mirror never
    // learned one. The body would then be routed nowhere, which is the same degraded rebuild the
    // missing `message_type` produces — so it fails closed rather than marking the row PROCESSED
    // with nobody answered. `unreachable`, not `unrecoverable`: the account answered with something
    // unusable, which the next attempt may not.
    const convId = 8937;
    const messageId = 9440;
    await seedConversation(convId, {
      inboxId: null,
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "tem alguém?" }], null),
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("unreachable");
    expect(stub.sent).toEqual([]);
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
  });

  test("a live snapshot that cannot be trusted defers instead of falling back", async () => {
    // `parseLiveConversation` returns null for a snapshot it cannot trust — no status, or an
    // AgentBot assignee with no readable id, which is unverifiable ownership. Falling back to the
    // mirror would use exactly the value this read exists to distrust.
    const convId = 8927;
    const messageId = 9430;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
      // An AgentBot assignee with no readable id: ownership that cannot be checked, which
      // `shouldBotHandle` would read as OURS.
      conv: { assigneeType: "AgentBot", assigneeId: null },
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("unreachable");
    expect(stub.sent).toEqual([]);
    // It spends no attempt either: the row keeps its budget for a pass that can read the account.
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
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
    // And it names the agent whose route the message arrived on. A line attributed to nobody is the
    // defect #317 was about: the operator filters the Logs page BY agent, so an unattributed row is
    // one they never see.
    expect(closing[0]?.agentId).toBe(agentDbId);
  });

  test("a closing line that could not be written is not swallowed", async () => {
    // The only trace of how the loss ended, written after the row has already left DEAD — so a
    // failed write loses it for good and nothing retries it. The branch cannot be reached
    // behaviourally: making `writeFlowEvent` fail against a real database means faking the client
    // out from under `runScopedOn`, which proves nothing about the shipped code. Asserted where it
    // is written instead, the same way tests/modules/delivery-sweep.test.ts asserts its two.
    const src = await Bun.file(
      new URL(
        "../../src/modules/chatwoot/recover-delivery.ts",
        import.meta.url,
      ),
    ).text();
    const tail = src.slice(src.indexOf("const closed = await writeFlowEvent("));
    expect(tail).toContain("if (!closed.delivered)");
    // Error, not warn: the loss has left the worklist and the page an operator received stays open.
    expect(tail.slice(tail.indexOf("if (!closed.delivered)"))).toContain(
      "logger.error(",
    );
  });

  test("a turn that starts while the recovery is reading is not raced", async () => {
    // The early fence spends no network on a conversation already busy; this is about the several
    // awaits after it — two REST reads and a reconcile — during which a live delivery can start a
    // turn, and a live delivery does not consult the recovery claim.
    const convId = 8928;
    const messageId = 9431;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    // The turn starts exactly where the real one would: after the recovery decided the conversation
    // was free, and before it hands the delivery path anything.
    const racing: RuntimeDeps = {
      ...depsWith(stub),
      makeClient: async (cfg) => {
        markTurnInFlight(threadOf(convId));
        const inner = stub.makeClient;
        if (!inner) throw new Error("stub has no client factory");
        return inner(cfg);
      },
    };

    let outcome: string;
    try {
      outcome = await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: racing,
      });
    } finally {
      clearTurnInFlight(threadOf(convId));
    }

    expect(outcome).toBe("deferred");
    expect(stub.sent).toEqual([]);
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
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
    ).toBe("unreachable");
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
    // Nothing was read either, which is the early check's whole purpose: the late one before the
    // handoff is what makes the fence correct, and this one is what keeps a busy conversation from
    // costing two REST round trips per pass.
    expect(stub.asked).toEqual([]);
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

    expect(outcome).toBe("unreachable");
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
  });

  test("the redirect episode survives the rescue instead of being cleared by it", async () => {
    // `redirect_origin_display_id` is rendered by the fork's EventDataPresenter only — the REST
    // conversation show does not carry it (MEASURED) — so the mirror is the one source for it, and a
    // rebuild that leaves it out does not merely fail to arm the ladder: a body that STATES no
    // pairing is a body that CLEARS one, on a row that already knew it.
    const convId = 8932;
    const messageId = 9435;
    const conv = await seedConversation(convId, {
      redirectOriginDisplayId: 991,
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

    const row = await suDb.conversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { redirectOriginDisplayId: true },
    });
    expect(row.redirectOriginDisplayId).toBe(991);
  });

  test("a re-entry that lands mid-rescue keeps its pairing", async () => {
    // The window the round-5 fix opened and this closes: the pairing is read BEFORE two REST reads
    // and a reconcile, and the mirror write happens after them. A widget re-entered from a second
    // WhatsApp thread in that window writes a NEW pairing with a proper version; replaying the old
    // one restores the previous episode, retires the current ladder, and later messages or resolves
    // the wrong sibling.
    const convId = 8933;
    const messageId = 9436;
    const conv = await seedConversation(convId, {
      redirectOriginDisplayId: 991,
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    // The re-entry lands exactly where a real one would: after the pairing was read, before the
    // rebuilt body reaches the mirror. Stamped with a version, as the webhook that carries it is.
    // ONCE, on the first client build: the delivery path builds a client of its own later, and a
    // hook that fired again would re-apply the re-entry AFTER the mirror write and hide the very
    // regression this is looking for.
    let reentered = false;
    const racing: RuntimeDeps = {
      ...depsWith(stub),
      makeClient: async (cfg) => {
        if (!reentered) {
          reentered = true;
          await suDb.conversation.update({
            where: { id: conv.id },
            data: {
              redirectOriginDisplayId: 992,
              chatwootRedirectOriginAt: Date.now() / 1000,
            },
          });
        }
        const inner = stub.makeClient;
        if (!inner) throw new Error("stub has no client factory");
        return inner(cfg);
      },
    };

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: racing,
      }),
    ).toBe("recovered");

    const row = await suDb.conversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { redirectOriginDisplayId: true },
    });
    expect(row.redirectOriginDisplayId).toBe(992);
  });

  test("a message older than the ceiling is refused on ITS clock, not on the row's", async () => {
    // `receivedAt` is when THIS application inserted the ledger row, not when the customer wrote. A
    // webhook delayed by a Chatwoot retry or an outage inserts late, so a message hours past the
    // ceiling can pass a check made on the row alone — and then the free-form reply crosses the
    // WhatsApp window, is rejected, is caught by the delivery path, and the row is still closed as
    // recovered.
    const convId = 8934;
    const messageId = 9437;
    await seedConversation(convId);
    // Inserted a minute ago: the row's own clock says this is fresh.
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      receivedAgoMs: 60_000,
    });
    const stub = stubChatwoot({
      page: pageWith([
        {
          id: messageId,
          content: "oi",
          // The customer wrote it a day ago.
          createdAt: Math.floor(Date.now() / 1000) - 24 * 3600,
        },
      ]),
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    expect(outcome).toBe("unrecoverable");
    expect(stub.sent).toEqual([]);
    // Refused BEFORE the claim, so the row keeps its budget and stays in the worklist.
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
  });

  test("a rebuilt event that is no longer an inbound message fails closed", async () => {
    // The ledger row is the proof it ever was one: `inboundMessageId` is written for nothing else.
    // So a rebuild that comes out as anything else describes a degraded REST read — a missing
    // `message_type` normalizes to "other" — and handing that to the delivery path is the exact
    // quiet failure this issue is about: no turn runs, the row is marked PROCESSED, a closing line
    // says the loss ended, and the customer is still waiting.
    const convId = 8935;
    const messageId = 9438;
    const conv = await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: {
        payload: [
          {
            id: messageId,
            content: "oi",
            // No `message_type` at all, which is what a truncated or older REST response looks like.
            private: false,
            created_at: SENT_AT,
            sender: { id: 77, name: "Cliente", type: "contact" },
            attachments: [],
          },
        ],
      },
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    expect(outcome).toBe("unreachable");
    expect(stub.sent).toEqual([]);
    // Not claimed, so nothing was spent and no closing line says the loss ended.
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
    expect(await deliveryLines(conv.id, 200)).toHaveLength(0);
  });

  test("a delivery path that throws puts the row back where it found it", async () => {
    // The claim has already happened by then: a throw escaping `processChatwootDelivery` leaves the
    // row on PROCESSING with nothing holding it, the next attempt reads that as somebody else's and
    // completes the job over it, and the row waits for the sweep to declare it stranded all over
    // again — thirty minutes it may not have against the age ceiling.
    //
    // NOT reachable behaviourally, and that was MEASURED rather than assumed: the path catches its
    // turn, its media pass, its mirror write and its client build — a stub that throws on each was
    // tried and every one came back `processed`. What escapes is a scoped query that cannot reach
    // the database (a pool timeout, a deadlock), and forcing that means faking the client out from
    // under `runScopedOn`, which proves nothing about the shipped code. Asserted where it is
    // written, the same way tests/modules/delivery-sweep.test.ts asserts its own unreachable branch.
    const src = await Bun.file(
      new URL(
        "../../src/modules/chatwoot/recover-delivery.ts",
        import.meta.url,
      ),
    ).text();
    const tail = src.slice(
      src.indexOf("    outcome = await processChatwootDelivery("),
    );
    const block = tail.slice(0, tail.indexOf("\n  const closed"));
    // Guarded on the state this pass left it in, so a late tx2 that got through is never overwritten.
    expect(block).toContain('where: { id: row.id, status: "PROCESSING" }');
    expect(block).toContain('data: { status: "DEAD" }');
    // `unreachable`, so the scheduler backs off and the retry finds a row it can claim.
    expect(block).toContain('return "unreachable"');
  });

  test("a control command is never replayed", async () => {
    // The premise of re-running the delivery path is that the path did not complete — not that it
    // did nothing. `/reset` performs its deletion BEFORE the tail settles the row, so a process that
    // died in that window leaves a DEAD row whose replay deletes the memory the conversation has
    // accumulated since. Destructive, and unlike a customer's message its author is an operator who
    // is present and can retype it.
    const convId = 8930;
    const messageId = 9433;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "/reset" }]),
    });
    const turns = { built: 0 };

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub, turns),
    });

    expect(outcome).toBe("unrecoverable");
    expect(turns.built).toBe(0);
    expect(stub.sent).toEqual([]);
    // Left DEAD, which is the operator-facing record that lets them retype it.
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
  });

  test("a message that merely mentions a command is still recovered", async () => {
    // The refusal is on the command ITSELF, which `controlCommand` reads as the whole trimmed
    // content. A customer writing about one is a customer waiting for an answer.
    const convId = 8931;
    const messageId = 9434;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([
        { id: messageId, content: "mandei /reset e não voltou" },
      ]),
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("recovered");
    expect(stub.sent).toEqual([[convId, REPLY]]);
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

    test("a BUSY conversation reschedules, so the ladder is not spent waiting on a turn", async () => {
      // `fail` would be the intuitive answer and it is the wrong one here. A turn is deliberately
      // unbounded — the sweep waits thirty minutes before calling one abandoned — while the
      // scheduler's five backoffs are spent in about a minute. Failing, a conversation's SECOND
      // stranded message would burn its whole ladder while the first message's turn was still
      // legitimately running, and lose its recovery for good.
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

      expect(result.outcome).toBe("reschedule");
      // Soon, not on the shared tick's own cadence: the customer's second message is waiting behind
      // the first one's turn, not behind a sweep.
      if (result.outcome !== "reschedule") throw new Error("not rescheduled");
      expect(result.runAt.getTime() - Date.now()).toBeLessThanOrEqual(120_000);
      // Untouched: nothing was attempted, so the budget survives.
      expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
    });

    test("an unreadable account FAILS the job, so it ends somewhere and says so", async () => {
      // The other road, and the reason the two are not one outcome: an account that stays unreadable
      // is a durable condition an operator has to fix. Rescheduling it CLEARS the failure budget, so
      // it would be retried for the life of the install with nothing ever announcing it. `fail`
      // backs off, dies at the scheduler's cap, and reaches the dead-letter line.
      const convId = 8929;
      await seedConversation(convId);
      const rowId = await seedDeadDelivery({
        conversationId: convId,
        inboundMessageId: 9432,
      });

      const handler = getJobHandler("DELIVERY_RECOVERY");
      if (!handler) throw new Error("the recovery handler is not registered");
      // No `deps` reaches the handler, so it builds a real client against the seeded account's base
      // URL — which does not resolve. That is the unreachable case, on the shipped path.
      const result = await handler(
        jobFor({ deliveryRowId: String(rowId) }),
        appDb,
      );

      expect(result.outcome).toBe("fail");
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
