import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId, contactInboxThreadId } from "@/graph/checkpointer";
import {
  clearTurnInFlight,
  isTurnInFlight,
  markTurnInFlight,
} from "@/graph/inflight";
import type { RuntimeDeps } from "@/graph/runtime";
import {
  clearTurnOwning,
  markTurnOwning,
  threadBusyForResetOn,
} from "@/graph/thread-claim";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { followUpDedupeKey } from "@/modules/channel-redirect/followup";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  deliveryRecoveryDedupeKey,
  MAX_RECOVERY_AGE_MS,
  MAX_RECOVERY_ATTEMPTS,
  putRowBack,
  recoverStrandedDelivery,
  registerDeliveryRecoveryHandler,
} from "@/modules/chatwoot/recover-delivery";
import { JOB_DEATH_LEVEL } from "@/modules/scheduler/lanes";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { getJobHandler } from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

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
let secondAgentDbId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let deliverySeq = 0;

const sysCtx = (t: bigint): TenantContext => ({
  tenantId: t,
  userId: null,
  role: "TENANT_ADMIN",
});

const threadOf = (convId: number) =>
  chatwootThreadId(tenantId, instanceId, convId);

interface Stub {
  // NonNullable, because it is optional on `RuntimeDeps` and every stub here supplies it: a test
  // that wraps it needs `Parameters<...>` to resolve.
  makeClient: NonNullable<RuntimeDeps["makeClient"]>;
  sent: Array<[number, string]>;
  // Private notes, which is where a guardrail announces a decision the customer never sees.
  notes: Array<[number, string]>;
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
  // Runs on the ANCHORED read, which is inside the recovery's awaits: the window between the
  // conversation load at the top and the fence before the handoff. A test uses it to move the world
  // the way a webhook arriving right then would.
  onAnchoredRead?: () => Promise<void>;
  // What the unanchored read returns from the SECOND call on. There are exactly two on a recovery
  // that reaches a turn — the recovery's own freshness read, then `shouldPost`'s — so this is how a
  // test puts a message into the window between them.
  recentAfterFirst?: unknown;
  throwOnRead?: boolean;
  conv?: {
    status?: string;
    assigneeType?: string | null;
    assigneeId?: number | null;
    lastActivityAt?: number;
  };
}): Stub {
  const sent: Array<[number, string]> = [];
  const notes: Array<[number, string]> = [];
  const asked: Array<[number, number | undefined]> = [];
  let unanchored = 0;
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
      if (o?.before === undefined) {
        unanchored += 1;
        if (unanchored > 1 && opts.recentAfterFirst !== undefined)
          return opts.recentAfterFirst;
        return opts.recent ?? opts.page ?? { payload: [] };
      }
      await opts.onAnchoredRead?.();
      return opts.page ?? { payload: [] };
    },
    sendMessage: async (conversationId: number, content: string) => {
      sent.push([conversationId, content]);
      return {};
    },
    toggleTyping: async () => ({}),
    // The guardrail announces its own decision as a private note. Absent, a tripped guardrail throws
    // and the turn reads as a provider failure rather than as the policy decision it is.
    sendPrivateNote: async (conversationId: number, content: string) => {
      notes.push([conversationId, content]);
      return {};
    },
    // Best-effort context reads a turn makes. Present so the stub is a Chatwoot that ANSWERS them
    // rather than one that is missing them: their absence is swallowed by the turn's own catch, and
    // a failure there would look like a passing test.
    listLabels: async () => [],
    listCustomAttributeDefinitions: async () => [],
    kanbanTaskForConversation: async () => null,
  } as unknown as ChatwootClient;
  return { makeClient: async () => client, sent, notes, asked };
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

// SETTLED and scoped. `emitFlowEvent` is fire-and-forget, so a raw read races the write it is
// asserting — and the direction that matters is the absence: several cases here assert that NO line
// was written, and a raw read passes those for the very reason that would make them wrong. The
// helper waits for the in-flight writes (#419) instead of polling for an arrival, which is the only
// form that answers both questions. Scoped by conversation, or an unscoped read answers with a
// neighbour's row.
async function deliveryLines(convDbId: bigint) {
  return flowLogRows(suDb, {
    where: { tenantId, stage: "delivery", conversationId: convDbId },
    select: { level: true, source: true, agentId: true, detail: true },
  });
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
        //
        // channelRedirect ON, because one case needs the SECOND reader of the redirect pairing: the
        // follow-up ladder arms off the event rather than off the mirror, so it is the only place a
        // rebuilt body carrying a stale pairing becomes observable. The entry inbox is a number no
        // fixture uses, since nothing here posts to it.
        settings: {
          debounce: { enabled: false },
          channelRedirect: {
            enabled: true,
            widgetInboxId: CHATWOOT_INBOX_ID,
            entryInboxId: 74,
            chatFollowupEnabled: true,
          },
        },
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
    // A SECOND persona, complete with its own Chatwoot bot: what an operator rebinds an inbox TO.
    // It has a bot of its own so a rebind is only that — swapping which persona answers — rather
    // than also hitting the persona-less refusal, which is a different case with its own tests.
    const second = await suDb.agent.create({
      data: {
        tenantId,
        name: "Segunda persona",
        systemPrompt: "Você é prestativa.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: { debounce: { enabled: false } },
      },
    });
    secondAgentDbId = second.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: second.id,
        chatwootAgentBotId: AGENT_BOT_ID + 1,
        accessToken: encryptJson("BOT2"),
        webhookSecret: encryptJson("S2"),
        webhookRouteTokenHash: `rec-route2-${process.pid}`,
        name: "Segunda persona",
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

  test("an inbox bound to NOBODY still runs the path, and stays on the worklist", async () => {
    // The neighbouring state, and it must not be swept into the refusal above: an inbox with no
    // agent at all is #318's `no_agent`, and the operator's line for it is written by the delivery
    // path. Refusing here would take that line away from the one customer message it is about.
    //
    // It runs the path AND KEEPS THE ROW. `no-agent` is a turn outcome that answered nobody, so it
    // is not a close (see `TURN_ANSWERED`): the customer is still waiting and stays waiting until an
    // operator binds an agent. The two records are about different things and both are wanted — the
    // `no_agent` line names the inbox that cannot answer, and the `DEAD` row names the one customer
    // message that went unanswered because of it.
    const convId = 8952;
    const messageId = 9452;
    const conv = await seedConversation(convId, {
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
    ).toBe("superseded");
    expect(stub.sent).toEqual([]);
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 1 });
    // The path really did run: #318's line is here, which is the whole reason this state is not
    // refused earlier. And no `recovered` line beside it, because nothing was.
    expect(await deliveryLines(conv.id)).toEqual([]);
    const noAgent = await flowLogRows(suDb, {
      where: { tenantId, stage: "route", conversationId: conv.id },
      select: { detail: true },
    });
    expect(noAgent.map((r) => r.detail)).toEqual([
      { outcome: "no_agent", chatwootInboxId: UNBOUND_INBOX },
    ]);
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
    const lines = await deliveryLines(conv.id);
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

  test("the recovered message advances the inbound watermark, even past the conversation's own state", async () => {
    // The reply is not the whole repair. `lastInboundAt` anchors BOTH the follow-up "new episode"
    // gate and the WhatsApp 24h service window, and the recovered message is the customer's, so it
    // has to move it.
    //
    // The case where it did not: an away message posted after the strand. The live conversation's
    // activity is then AHEAD of the stranded message, the recovery reconciles the mirror to that
    // later time — correctly, since the conversation really did move — and the rebuilt body, stamped
    // with the message's own `created_at`, lands in the mirror's stale branch. MEASURED before the
    // fix: the customer got their reply and `lastInboundAt` came out NULL, so a proactive send made
    // later would read as in-window when it is not.
    const convId = 8956;
    const messageId = 9456;
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
      // Five minutes past the stranded message: the away message's own time, which is what the
      // account reports as the conversation's last activity.
      conv: { lastActivityAt: SENT_AT + 300 },
      recent: {
        payload: [
          ...page.payload,
          {
            id: messageId + 4,
            content: "Estamos fora do horário de atendimento.",
            message_type: 1,
            private: false,
            inbox_id: CHATWOOT_INBOX_ID,
            created_at: SENT_AT + 300,
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

    const after = await suDb.conversation.findFirst({
      where: { tenantId, chatwootConversationId: convId },
      select: { lastInboundAt: true, lastEventAt: true },
    });
    // The customer's message, not the away message and not `now`.
    expect(after?.lastInboundAt).toEqual(new Date(SENT_AT * 1000));
    // And the conversation's own state still holds the LATER time, so the watermark moved without
    // dragging the state backwards with it.
    expect(after?.lastEventAt).toEqual(new Date((SENT_AT + 300) * 1000));
  });

  test("the fence reads the contact inbox the conversation is on NOW, not the one it loaded", async () => {
    // `contactInboxId` is not frozen for the length of a recovery: ./mirror.ts writes it on an
    // unversioned event, so a webhook arriving during the two REST reads can move the conversation
    // to a different graph thread. The fence is asked a second time precisely because of those
    // awaits, and asking it about the OLD thread answers about a thread nobody is on.
    //
    // The move is made from inside the anchored read, which is that window, and the claim is taken
    // on the NEW thread with this process's registry emptied — a live turn on another replica,
    // holding the thread the conversation is on by the time the fence runs.
    const convId = 8957;
    const messageId = 9457;
    const conv = await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const movedContactInboxId = 71_000 + convId + 1;
    const owner = {
      tenantId,
      instanceId,
      contactInboxId: movedContactInboxId,
      graphThreadId: contactInboxThreadId(
        tenantId,
        instanceId,
        movedContactInboxId,
      ),
    };
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
      onAnchoredRead: async () => {
        await suDb.conversation.update({
          where: { id: conv.id },
          data: { contactInboxId: movedContactInboxId },
        });
      },
    });
    const hold = await markTurnOwning(owner, appDb);
    clearTurnInFlight(owner.graphThreadId);

    let outcome: string;
    try {
      outcome = await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      });
    } finally {
      markTurnInFlight(owner.graphThreadId);
      await clearTurnOwning(owner, appDb, hold);
    }

    expect(outcome).toBe("deferred");
    expect(stub.sent).toEqual([]);
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
  });

  test("a turn that THREW does not close the loss, and the row goes back to DEAD", async () => {
    // The failure this whole subsystem is built against, reached from inside the recovery itself.
    // `processChatwootDelivery` catches its own turn failure and still settles the row: for a live
    // delivery that is honest — the failure is recorded on the conversation and announced in
    // Chatwoot, and there is no retry to arm — but a recovery exists to ANSWER. MEASURED before the
    // fix: the model threw, nothing was sent, and the recovery still returned `recovered` with the
    // row on `PROCESSED`, so the customer was dropped from the worklist unanswered.
    //
    // The attempt stays SPENT, because the claim stamped it: the budget is what bounds the retrying,
    // and a failure that cost nothing would retry until the age ceiling instead.
    const convId = 8958;
    const messageId = 9458;
    const conv = await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: {
          ...depsWith(stub),
          makeModel: () => {
            throw new Error("provider 500");
          },
        },
      }),
    ).toBe("unreachable");

    expect(stub.sent).toEqual([]);
    // Back in the worklist, with the attempt counted.
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 1 });
    // And no closing line: the page an operator already received stays open, which is the whole
    // point of putting the row back. Keyed by the mirror's ROW id, which is what the writer files
    // against — the Chatwoot number would match nothing and pass without reading anything.
    expect(await deliveryLines(conv.id)).toEqual([]);
  });

  test("a BURST stranded together is answered once, and the older row stays on the page", async () => {
    // One process death can strand two customer messages on one conversation, which is two DEAD
    // rows. What this pins is the whole outcome, because the reviewer's question was whether the
    // older row is closed on a premise about a delivery that also died.
    //
    // It is not. The newest row's recovery answers the conversation — ONE reply, not two — and the
    // older row stays DEAD with no attempt spent and no closing line, so the page the operator
    // already received about it stays open. What is lost is the older message's TEXT: a direct turn
    // carries its own trigger text and nothing back-fills the channel from Chatwoot, so the model
    // answers the second question and never reads the first. That bound is the delivery path's, not
    // this module's, and gathering a burst is the flush's job — re-implementing it here is what the
    // head of this file refuses to do.
    const convId = 8959;
    const older = 9459;
    const newer = 9460;
    const conv = await seedConversation(convId);
    const rowOlder = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: older,
    });
    const rowNewer = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: newer,
    });
    const stub = stubChatwoot({
      page: pageWith([
        { id: older, content: "quanto custa?" },
        { id: newer, content: "e vocês atendem no sábado?" },
      ]),
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowOlder,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("unrecoverable");
    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowNewer,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("recovered");

    // ONE reply. Two would be the harm the newest-message check exists for.
    expect(stub.sent).toEqual([[convId, REPLY]]);
    expect(await ledger(rowOlder)).toEqual({ status: "DEAD", attempts: 0 });
    expect(await ledger(rowNewer)).toEqual({
      status: "PROCESSED",
      attempts: 1,
    });
    // Exactly one closing line, for the row that actually closed.
    const lines = await deliveryLines(conv.id);
    expect(lines.length).toBe(1);
  });

  test("a reply WITHHELD to a message that landed mid-turn does not close the loss", async () => {
    // The sliver the freshness check before the claim leaves open. That check reads the newest page
    // once; a delivery for a message the customer sends AFTER it can start and finish while this
    // recovery is still building its turn. `shouldPost` then sees the newer message and stands down,
    // which is right for a live delivery — the newer message's own delivery carries the reply — and
    // is not something a recovery can lean on, because that delivery can have finished before this
    // turn ingested the stranded text.
    //
    // MEASURED before the fix: nothing was sent, and the recovery still returned `recovered` with
    // the row on `PROCESSED` and a closing line written.
    //
    // The newer message is made to appear only on the SECOND unanchored read, which is
    // `shouldPost`'s: the first is the recovery's own freshness read, and it has to still see the
    // stranded message as the newest or the refusal would come from the earlier check instead.
    const convId = 8960;
    const messageId = 9461;
    const conv = await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
      recentAfterFirst: pageWith([
        { id: messageId, content: "oi" },
        { id: messageId + 5, content: "ainda estou aqui?" },
      ]),
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("superseded");

    // The turn really did reach `shouldPost` — two unanchored reads, not one — otherwise the refusal
    // would prove nothing about what happened inside the turn.
    expect(stub.asked.filter(([, before]) => before === undefined).length).toBe(
      2,
    );
    expect(stub.sent).toEqual([]);
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 1 });
    expect(await deliveryLines(conv.id)).toEqual([]);
  });

  test("the rebuilt BODY carries the moved contact inbox, not the one loaded", async () => {
    // The fence and the body are built from the same reading on purpose. The fence is the reason the
    // re-read exists, but the body is not inert: the mirror write it drives assigns `contactInboxId`
    // on an unversioned event, so a body still carrying the pairing from before the REST reads can
    // put it BACK — and the turn would then run on a graph thread nothing fenced.
    //
    // Same move as the fence's test, with nobody holding the new thread, so the recovery goes all
    // the way through and the mirror write is what answers.
    const convId = 8961;
    const messageId = 9462;
    // Behind the message, so the rebuilt body wins the ordering and reaches the branch that ASSIGNS
    // the pairing. Landing in the mirror's stale branch instead would prove nothing: that branch
    // writes no `contactInboxId` at all, and the assertion would hold whichever value the body had.
    const conv = await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const moved = 71_000 + convId + 1;
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
      onAnchoredRead: async () => {
        await suDb.conversation.update({
          where: { id: conv.id },
          data: { contactInboxId: moved },
        });
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

    expect(
      (
        await suDb.conversation.findUniqueOrThrow({
          where: { id: conv.id },
          select: { contactInboxId: true },
        })
      ).contactInboxId,
    ).toBe(moved);
  });

  test("an inbox REBOUND mid-recovery answers as the persona it is bound to now", async () => {
    // The route id does not move here — the same inbox, the same number — so a recovery that reused
    // the binding loaded with the conversation would see nothing to re-read. What moved is which
    // AGENT that inbox points at, and with it which persona's bot answers. Handing the delivery path
    // the old persona's bot while it resolves the new one is what makes the ownership gate read the
    // new bot as another party and consume the message without replying.
    //
    // Asserted on the closing line's agent, which is the recovery's own record of who it decided
    // answered, and on the reply actually going out.
    const convId = 8963;
    const messageId = 9464;
    const conv = await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
      onAnchoredRead: async () => {
        await suDb.inbox.update({
          where: { id: inboxDbId },
          data: { agentId: secondAgentDbId },
        });
      },
    });

    try {
      expect(
        await recoverStrandedDelivery({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          deps: depsWith(stub),
        }),
      ).toBe("recovered");
      expect(stub.sent).toEqual([[convId, REPLY]]);
      const closing = await deliveryLines(conv.id);
      expect(closing.length).toBe(1);
      expect(closing[0]?.agentId).toBe(secondAgentDbId);
    } finally {
      await suDb.inbox.update({
        where: { id: inboxDbId },
        data: { agentId: agentDbId },
      });
    }
  });

  test("the conversation key is HELD across the handoff, not just probed before it", async () => {
    // The fence answers about the moment it runs. A follow-up NUDGE needs no new customer message,
    // so nothing earlier in this recovery says anything about one starting in the window between
    // that answer and `runAgentTurn` taking its own claim — and it posts into this very
    // conversation. `followUpHandler` reads the CONVERSATION key before it fires, so holding that
    // key from the fence to the handoff is what makes it reschedule instead of running beside us.
    //
    // Observed at `deps.makeClient`, which the delivery path calls for its own client BEFORE the
    // turn: the recovery's own build happens earlier, outside the hold, so the two readings
    // distinguish the mark from the one `runAgentTurn` takes later on its own.
    const convId = 8966;
    const messageId = 9467;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    const held: boolean[] = [];
    const deps: RuntimeDeps = {
      ...depsWith(stub),
      makeClient: async (...a: Parameters<Stub["makeClient"]>) => {
        held.push(isTurnInFlight(threadOf(convId)));
        return stub.makeClient(...a);
      },
    };

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps,
      }),
    ).toBe("recovered");

    // Three builds, and the middle one is the whole test. [0] is the recovery's own, before the
    // hold. [1] is the delivery path's, inside the hold and BEFORE the turn — this is the reading
    // that flips: measured, it is `false` without the mark. [2] is inside the turn, where
    // `runAgentTurn` has marked the key itself and the answer is `true` either way, which is why
    // asserting "some of them" would have proved nothing.
    expect(held).toEqual([false, true, true]);
    // Balanced: a mark left behind would make every reader defer on this conversation forever.
    expect(isTurnInFlight(threadOf(convId))).toBe(false);
  });

  test("a message with NO created_at is a degraded read, not a message to replay", async () => {
    // The body's `last_activity_at` is the customer's own clock, taken from the REST message's
    // `created_at`, and it is what keeps a recovery from moving `lastInboundAt` forward by however
    // long the row sat stranded. Without it the mirror falls back to the moment the rebuilt event
    // arrives, and that column anchors BOTH the follow-up episode gate and the WhatsApp 24h service
    // window — so a proactive send made later reads as in-window when it is not.
    //
    // MEASURED at the mirror before this: an undated event does not reach the stale branch at all,
    // because there is nothing to order it by, so it APPLIES and refreshes the watermark to now. The
    // guard belongs here, where the undated body comes from.
    const convId = 8967;
    const messageId = 9468;
    const conv = await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const before = await suDb.conversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { lastInboundAt: true },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const page = pageWith([{ id: messageId, content: "oi" }]) as {
      payload: Record<string, unknown>[];
    };
    for (const m of page.payload) delete m.created_at;
    const stub = stubChatwoot({ page });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("unreachable");
    expect(stub.sent).toEqual([]);
    // The attempt is not spent: a degraded read is the account's problem, and the next one may
    // answer properly.
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
    // And the anchor did not move.
    expect(
      (
        await suDb.conversation.findUniqueOrThrow({
          where: { id: conv.id },
          select: { lastInboundAt: true },
        })
      ).lastInboundAt,
    ).toEqual(before.lastInboundAt);
  });

  test("a conversation RESOLVED mid-rescue is seen, though the live snapshot never was", async () => {
    // The live snapshot is read FIRST, before the two message reads and the reconcile, so an
    // operator acting inside that window is invisible to it. What the body states is therefore the
    // MIRROR ROW — the live snapshot where it won the ordering and whatever outranked it where it
    // lost. This pins that choice, because the delivery path gates on what the BODY says:
    // `shouldBotHandle` reads the status straight off it with no fallback at all.
    //
    // WHICH READING of that row is not what this measures, and no test can be: the body takes the
    // later of the two (`mirrorNow`, beside the pairing) rather than `reconciled.state`, and the only
    // difference between them is a write landing while the route queries run — a stretch with no
    // seam to hook. What IS measured is that neither of them is the snapshot.
    //
    // STATUS is the field that isolates the rule, and picking it was measured rather than guessed:
    // the ASSIGNEE has a fallback — a body that says nothing about it sends `shouldBotHandle` to the
    // mirror's own reading — so a takeover closes the gate whichever source the body used, and a
    // test built on one would pass without reading anything.
    //
    // The resolve is stamped with a version AHEAD of the snapshot, exactly as the webhook carrying
    // it would be — otherwise the reconcile rejects it as stale and the test measures the reconcile
    // rather than the body.
    const convId = 8968;
    const messageId = 9469;
    const conv = await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
      onAnchoredRead: async () => {
        await suDb.conversation.update({
          where: { id: conv.id },
          data: {
            status: "resolved",
            chatwootStatusAt: SENT_AT + 3600,
          },
        });
      },
    });
    const turns = { built: 0 };

    // The path ran, which is what "recovered" says; it does not say anybody was spoken to.
    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub, turns),
      }),
    ).toBe("recovered");
    expect(stub.sent).toEqual([]);
    // No turn was even built: the operator closed the conversation, and a reply landing after that
    // reopens it in Chatwoot on top of a customer message they had already dealt with.
    expect(turns.built).toBe(0);
  });

  test("a route the mirror never learned reaches the GATES, not just the turn", async () => {
    // The worst outcome this module could produce, and it was reachable. Rebuilding the body from
    // the live message answers `runAgentTurn`, which resolves the agent from the inbox the EVENT
    // carries. Nothing else in the delivery path reads it from there: `maybeConsumeCommandOrGate`
    // resolves it from `Conversation.inboxId`, and with that column null it finds no agent and
    // returns having run NOTHING — not the test-mode gate, not availability, not contact
    // authorization — while the turn runs anyway on the route this module supplied.
    //
    // MEASURED before the repair: agent in TEST mode, conversation never activated, and the recovery
    // posted "Desculpe a demora, estou aqui!" to a real customer. That is the one thing test mode
    // exists to prevent.
    //
    // The event is made STALE on purpose (the mirror's activity is ahead of the message, as it is
    // whenever the conversation moved on after the strand), because the mirror writes that column
    // only when the event WINS the ordering. Leaving the repair to the handoff's own mirror write is
    // exactly what does not happen here.
    const convId = 8969;
    const messageId = 9470;
    const conv = await seedConversation(convId, {
      inboxId: null,
      lastEventAt: new Date((SENT_AT + 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
      conv: { lastActivityAt: SENT_AT + 600 },
    });
    const turns = { built: 0 };

    await asTestModeAgent(() =>
      recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub, turns),
      }),
    );

    // The customer heard nothing from a test-mode agent they never activated.
    expect(stub.sent).toEqual([]);
    expect(turns.built).toBe(0);
    // And the mirror learned its route, which is what let the gate find the agent at all — repaired
    // rather than bypassed, the same way the conversation's state is.
    expect(
      (
        await suDb.conversation.findUniqueOrThrow({
          where: { id: conv.id },
          select: { inboxId: true },
        })
      ).inboxId,
    ).toBe(inboxDbId);
  });

  test("the contact's identity is left where the mirror holds it, not restated at the message's clock", async () => {
    // A review round asked for the opposite: carry `meta.sender` from the live conversation, since
    // the stranded message may be the very event that would have refreshed the contact, and
    // `authorizeContact` reads the STORED identity on a gate that fails closed. The live read does
    // render it (measured at the fork: `conversations#show` renders the full contact partial).
    //
    // Carrying it was implemented and MEASURED, and it does not merely fail to help. The mirror
    // positions identity per field by the payload's `last_activity_at`, and this body's is the
    // stranded message's own clock. With the contact positioned at that same second — a sibling
    // message of the same burst wrote it — and the live phone now different, the tie rule fires:
    // a disagreement it cannot order by arrival drops BOTH readings and the field is emptied. The
    // contact then reads as `no_identity` at exactly the gate that round wanted to protect, and the
    // stored phone is gone. That is the fixture below, and what it asserts is that the phone is
    // still there.
    //
    // The exposure that remains is real and bounded: the next event on this conversation carries
    // the identity at its own clock and settles it.
    const convId = 8981;
    const messageId = 9481;
    const CONTACT_CW = 77;
    const contact = await suDb.contact.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootContactId: CONTACT_CW,
        phone: "+5511900000000",
        // Positioned at the stranded message's own second, as a sibling of its burst would leave it.
        phoneAt: new Date(SENT_AT * 1000),
      },
      select: { id: true },
    });
    const conv = await seedConversation(convId);
    await suDb.conversation.update({
      where: { id: conv.id },
      data: { contactId: contact.id },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    // The customer changed number AFTER that burst, so the live read disagrees with the stored value
    // at the same position — the one shape that empties the field.
    const inner = stub.makeClient;
    const deps: RuntimeDeps = {
      ...depsWith(stub),
      makeClient: async (...a: Parameters<Stub["makeClient"]>) => {
        const c = (await inner(...a)) as unknown as Record<string, unknown>;
        const orig = c.getConversation as (
          id: number,
        ) => Promise<Record<string, unknown>>;
        c.getConversation = async (id: number) => {
          const r = await orig(id);
          (r.meta as Record<string, unknown>).sender = {
            id: CONTACT_CW,
            name: "Cliente",
            phone_number: "+5511911111111",
          };
          return r;
        };
        return c as never;
      },
    };

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps,
      }),
    ).toBe("recovered");

    const after = await suDb.contact.findUniqueOrThrow({
      where: { id: contact.id },
      select: { phone: true, phoneAt: true },
    });
    // Untouched in BOTH directions: not emptied, and not overwritten with a value read an hour
    // later under a position from an hour before.
    expect(after.phone).toBe("+5511900000000");
    expect(after.phoneAt?.getTime()).toBe(SENT_AT * 1000);
  });

  test("a human who takes over DURING the turn is a legitimate close", async () => {
    // The other half of the positive list, and the one case in it that is not `posted`. The gate let
    // this through — nobody held the conversation when it ran — and the human arrived while the model
    // was working, which is what the runtime's own ownership re-check exists to catch. It withholds
    // the reply and comes back `taken-over`.
    //
    // That is a CLOSE, not a loss: a human holding the conversation will answer this message,
    // whichever route carried it here, which is the `consumed_late` half of the settlement
    // vocabulary. Leaving the row DEAD would page an operator about a message somebody is already
    // typing an answer to.
    //
    // The takeover is written from `makeModel`, which the turn calls after every gate has run and
    // before the re-check reads the row — the one seam inside the turn a test can reach.
    const convId = 8992;
    const messageId = 9492;
    const conv = await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    // AWAITED, from the model's own `invoke`. Two other seams were tried and neither works here:
    // `makeModel` is synchronous, so a write fired there races the re-check it is meant to precede
    // and lands after it about half the time (the trap a previous round of this PR fell into), and
    // the turn's context reads (`listLabels` and its siblings) are CACHED per instance — the seam
    // fires when this file runs alone and never fires in a full-suite run, which is a test that
    // passes while measuring nothing.
    //
    // Proxied through `bindTools` because the graph binds before it invokes, and a patch applied to
    // the bare model would be dropped by the object binding returns.
    let taken = false;
    const takeOver = async () => {
      if (taken) return;
      taken = true;
      await suDb.conversation.update({
        where: { id: conv.id },
        data: { assigneeType: "User", assigneeId: 4242 },
      });
    };
    const patch = (target: Record<string, unknown>): Record<string, unknown> =>
      new Proxy(target, {
        get(t, k, r) {
          const v = Reflect.get(t, k, r);
          if (k === "bindTools" && typeof v === "function")
            return (...a: unknown[]) =>
              patch(
                (v as (...x: unknown[]) => Record<string, unknown>).apply(t, a),
              );
          if (k === "invoke" && typeof v === "function")
            return async (...a: unknown[]) => {
              await takeOver();
              return (v as (...x: unknown[]) => unknown).apply(t, a);
            };
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    const deps: RuntimeDeps = {
      ...depsWith(stub),
      makeModel: () =>
        patch(
          new FakeListChatModel({
            responses: [REPLY],
          }) as unknown as Record<string, unknown>,
        ) as never,
    };

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps,
      }),
    ).toBe("recovered");

    // The takeover really landed inside the turn, or this measures nothing.
    expect(taken).toBe(true);
    // Nothing posted over the human, and the row left the worklist all the same.
    expect(stub.sent).toEqual([]);
    expect((await ledger(rowId)).status).toBe("PROCESSED");
  });

  test("a guardrail that deliberately silences the message DOES close the loss", async () => {
    // `blocked` is the runtime's outcome for a guardrail that tripped with `action: "silent"` — no
    // template, no generated reply, nothing sent. It sits on the other side of the line from `empty`
    // and the difference is WHO decided: `empty` is the model having nothing to say, which a second
    // attempt could legitimately answer differently, while `blocked` is the operator's own policy
    // saying this message must not be answered. Re-running the recovery reproduces the same refusal,
    // and leaving the row on the worklist asks an operator to investigate a decision their own
    // configuration made.
    //
    // The runtime says as much where it returns it: "a word that says the burst was consumed, so the
    // watermark advances".
    //
    // Driven through the real guardrail, not by injecting the outcome: the guardrail model is built
    // from the same `deps.makeModel`, and `deepseek` asks for its verdict in PROSE, so a fake model
    // answering `{"violated": true}` is a real trip.
    const convId = 8994;
    const messageId = 9494;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    const before = await suDb.agent.findUniqueOrThrow({
      where: { id: agentDbId },
      select: { settings: true },
    });
    // A resolvable credential, because a guardrail whose key does not resolve FAILS OPEN by design
    // (gate.ts writes `credential_not_found` and lets the turn through). Without this the test would
    // measure the fail-open path and pass for the wrong reason.
    const cred = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: `guard-${process.pid}`,
        secret: encryptJson("guard-key"),
        kind: "generic",
      },
      select: { id: true },
    });
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        settings: {
          ...(before.settings as Record<string, unknown>),
          guardrails: {
            enabled: true,
            provider: "deepseek",
            model: "guard-1",
            credentialRef: `vault:${cred.id}`,
            input: {
              enabled: true,
              action: "silent",
              checks: { toxicity: true },
            },
          },
        },
      },
    });
    const turns = { built: 0 };
    try {
      const deps: RuntimeDeps = {
        ...depsWith(stub, turns),
        makeModel: () => {
          turns.built += 1;
          return new FakeListChatModel({
            responses: ['{"violated": true, "categories": ["toxicity"]}'],
          });
        },
      };

      expect(
        await recoverStrandedDelivery({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          deps,
        }),
      ).toBe("recovered");

      // The guardrail model ran, it announced its decision to the operator, and the customer got
      // nothing.
      expect(turns.built).toBeGreaterThan(0);
      expect(stub.notes.map((n) => n[1])).toEqual([
        expect.stringContaining("Guardrail (input)"),
      ]);
      expect(stub.sent).toEqual([]);
      // The loss is CLOSED: the row leaves the worklist, because a policy answered for it.
      expect((await ledger(rowId)).status).toBe("PROCESSED");
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { settings: before.settings as never },
      });
      await suDb.vaultEntry.delete({ where: { id: cred.id } });
    }
  });

  test("a /reset landing mid-recovery is told the thread is being written", async () => {
    // `/reset` deletes the memory and the checkpoint, and it REFUSES while anyone is mid-write —
    // "either would restore what this clears". It asks `threadBusyForResetOn`, which reads the GRAPH
    // key and the durable claim; the recovery's own hold is on the CONVERSATION key, which that
    // question never looks at.
    //
    // So between the mark and `runAgentTurn` taking its own claim, a reset saw an idle thread and
    // cleared it, while the recovery went on to run the turn — restoring the memory the operator
    // had just erased and running whatever tools the turn chose. The window is not narrow: the mirror
    // write, the ownership gates, the contact-authorization call and the spend ceiling all sit in it,
    // and the last two reach the network.
    //
    // Asked from the delivery path's own client build, which is inside the hold and before the turn
    // — the same seam the conversation-key test above uses, for the same reason.
    const convId = 8995;
    const messageId = 9495;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    const busy: boolean[] = [];
    const inner = stub.makeClient;
    const deps: RuntimeDeps = {
      ...depsWith(stub),
      makeClient: async (...a: Parameters<Stub["makeClient"]>) => {
        busy.push(
          await runScopedOn(appDb, sysCtx(tenantId), (db) =>
            threadBusyForResetOn(db, {
              tenantId,
              instanceId,
              contactInboxId: 71_000 + convId,
              graphThreadId: contactInboxThreadId(
                tenantId,
                instanceId,
                71_000 + convId,
              ),
            }),
          ),
        );
        return inner(...a);
      },
    };

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps,
      }),
    ).toBe("recovered");

    // Three client builds, as elsewhere in this file. [0] is the recovery's own, BEFORE the hold, so
    // a reset there is legitimately free to run. [1] is the delivery path's, inside the hold and
    // before the turn — the reading that flips, and measured `false` without the graph key held.
    // [2] is inside the turn, where the turn's own claim answers either way.
    expect(busy).toEqual([false, true, true]);
    // Balanced, or every reset on this thread would refuse for the life of the process.
    expect(
      await runScopedOn(appDb, sysCtx(tenantId), (db) =>
        threadBusyForResetOn(db, {
          tenantId,
          instanceId,
          contactInboxId: 71_000 + convId,
          graphThreadId: contactInboxThreadId(
            tenantId,
            instanceId,
            71_000 + convId,
          ),
        }),
      ),
    ).toBe(false);
  });

  test("a turn that said NOTHING has not answered anybody either", async () => {
    // `empty` is the runtime's outcome for a turn that ran every gate, reached the end, and
    // delivered neither text nor an attachment — `sent || handedOff ? "posted" : "empty"`. For a
    // LIVE delivery that is a complete outcome: the agent chose not to speak, and the row is settled
    // because the event was handled.
    //
    // A RECOVERY cannot read it that way. This row exists because the customer was left unanswered,
    // and an empty second attempt leaves them unanswered with nothing else coming — unlike a
    // coalesced burst, where the flush carries the reply minutes later. Closing the loss here marks
    // the row PROCESSED, writes `recovered`, and takes the message off the `WHERE status = 'DEAD'`
    // worklist, which was the operator's only remaining record of it.
    //
    // Same family as the turn that threw and the reply that was withheld, and the reason the three
    // are answered by ONE positive list: an outcome nobody has thought about yet must not close a
    // loss by default.
    const convId = 8991;
    const messageId = 9491;
    const conv = await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    const deps: RuntimeDeps = {
      ...depsWith(stub),
      // Nothing to say, and nothing queued to send: the shape that reaches `empty`.
      makeModel: () => new FakeListChatModel({ responses: [""] }),
    };

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps,
      }),
    ).toBe("superseded");

    expect(stub.sent).toEqual([]);
    // Back on the worklist, with the attempt counted so the ceiling still bounds this.
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 1 });
    // And no line saying the loss ended.
    expect(await deliveryLines(conv.id)).toEqual([]);
  });

  test("a handoff landing during the message reads is not undone by the reconcile", async () => {
    // The live snapshot is read FIRST and applied to the mirror; between those two moments sit the
    // two message reads. A handoff or a resolve committed inside that stretch writes the mirror and
    // is then overwritten by the older snapshot, because the reconcile's fallback ordering compares
    // `last_activity_at` — which a status or assignee change never advances. The rebuilt delivery
    // then passes the gate on a mirror it just walked back, and answers over the human.
    //
    // The other two callers of `reconcileMirrorFromLive` (the proactive nudge, the console's own
    // buttons) apply the snapshot immediately after the GET. This one held it across two network
    // round trips, which is the whole of the difference.
    //
    // `onAnchoredRead` is the hook that runs INSIDE that stretch, which is what makes this the
    // window and not a guess.
    const convId = 8993;
    const messageId = 9493;
    // `lastEventAt` BEHIND the live snapshot, which is the ordinary shape here: the stranded message
    // is the newest thing on the conversation and the mirror never saw it. With the mirror ahead the
    // reconcile refuses on activity alone and the window is invisible.
    const conv = await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
      onAnchoredRead: async () => {
        await suDb.conversation.update({
          where: { id: conv.id },
          data: { assigneeType: "User", assigneeId: 4242 },
        });
      },
    });

    await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    // The human still holds it, and nothing was posted over them.
    expect(
      (
        await suDb.conversation.findUniqueOrThrow({
          where: { id: conv.id },
          select: { assigneeType: true },
        })
      ).assigneeType,
    ).toBe("User");
    expect(stub.sent).toEqual([]);
  });

  test("a human who TAKES the conversation in that same window is not answered over either", async () => {
    // The status half of this pair was closed by reading the outcome instead of the proposal. The
    // assignee half is not the same rule and could not borrow it: a message payload may never write
    // the assignee AT ALL (../../src/modules/chatwoot/state-order.ts — `assigneeOrdered` requires
    // `fromConversationEvent`), so the mirror correctly stays human-owned while the rebuilt payload
    // goes on STATING the pre-handoff trio it read a moment earlier. The gate preferred the
    // statement, so the recovery answered over the human.
    //
    // And the damage is not only the reply. The runtime's own ownership re-check runs AFTER the
    // model call (../../src/graph/runtime.ts), so a turn let through here has already invoked the
    // model and run every tool it chose — a booking, a write-back — before anything withholds the
    // text. `turns.built` is what this asserts for exactly that reason.
    //
    // Same seam and the same reason as the resolve above: fired from inside the fence's own query,
    // which lands after the last mirror read and before the gate. Status left `pending` so the
    // refusal measured here can only be the assignee's.
    const convId = 8971;
    const messageId = 9472;
    const conv = await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    const turns = { built: 0 };
    const FENCE_QUERY = 8;
    let n = 0;
    let fired = false;
    const proxied = new Proxy(appDb, {
      get(t, k, r) {
        if (k !== "$extends") return Reflect.get(t, k, r);
        return (...a: unknown[]) => {
          n += 1;
          const ext = (
            Reflect.get(t, k, r) as (...x: unknown[]) => Record<string, unknown>
          ).apply(t, a);
          if (n !== FENCE_QUERY || fired) return ext;
          fired = true;
          const tx = ext.$transaction as (...x: unknown[]) => Promise<unknown>;
          return new Proxy(ext, {
            get(et, ek, er) {
              if (ek !== "$transaction") return Reflect.get(et, ek, er);
              return async (...x: unknown[]) => {
                await suDb.conversation.update({
                  where: { id: conv.id },
                  data: {
                    assigneeType: "User",
                    assigneeId: 4242,
                    assigneeName: "Ana",
                    // Stamped ahead of the message, as the handoff webhook carrying it would be.
                    chatwootAssigneeAt: SENT_AT + 3600,
                  },
                });
                return tx.apply(et, x);
              };
            },
          });
        };
      },
    });

    await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: proxied,
      deps: depsWith(stub, turns),
    });

    expect(fired).toBe(true);
    expect(stub.sent).toEqual([]);
    // The gate closed BEFORE the model was built. Asserting only `sent` would pass on a turn that
    // ran, called tools, and was silenced on the way out.
    expect(turns.built).toBe(0);
    // And the human still holds it.
    expect(
      (
        await suDb.conversation.findUniqueOrThrow({
          where: { id: conv.id },
          select: { assigneeType: true, assigneeId: true },
        })
      ).assigneeType,
    ).toBe("User");
  });

  test("an operator who RESOLVES between the last read and the gate is not answered over", async () => {
    // Every payload the delivery path gates on is a snapshot of some earlier instant: Chatwoot
    // freezes its own at enqueue, and this module rebuilds one from reads it made a moment before.
    // The window that stays open is between the last of those reads and the gate — five scoped
    // queries, measured — and an operator resolving the conversation inside it used to get a reply
    // posted on top of the conversation they had just closed.
    //
    // The rule is the gate's, not this module's: the status now follows whoever WON the ordering.
    // `mirror.applied` is false exactly when the mirror refused the payload's write, and a status the
    // mirror refused is one the gate must not act on either — the same shape as the assignee's own
    // fallback beside it, stated for the other half of the pair.
    //
    // The resolve is fired from inside the FENCE's own query, which is the one seam in that stretch:
    // it lands after the last mirror read and before the mirror write the handoff performs. Stamped
    // ahead of the message, as the webhook carrying it would be, so the mirror really does refuse.
    const convId = 8970;
    const messageId = 9471;
    const conv = await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    const turns = { built: 0 };
    // The fence's durable read is the eighth scoped transaction of the pass. Counted rather than
    // guessed: a probe printed the call stack of each one.
    const FENCE_QUERY = 8;
    let n = 0;
    let fired = false;
    // The resolve is AWAITED before the fence's transaction opens, not fired beside it: a write left
    // racing the read it is meant to precede lands after it about half the time, and the test would
    // then be measuring nothing while still passing.
    const proxied = new Proxy(appDb, {
      get(t, k, r) {
        if (k !== "$extends") return Reflect.get(t, k, r);
        return (...a: unknown[]) => {
          n += 1;
          const ext = (
            Reflect.get(t, k, r) as (...x: unknown[]) => Record<string, unknown>
          ).apply(t, a);
          if (n !== FENCE_QUERY || fired) return ext;
          fired = true;
          const tx = ext.$transaction as (...x: unknown[]) => Promise<unknown>;
          return new Proxy(ext, {
            get(et, ek, er) {
              if (ek !== "$transaction") return Reflect.get(et, ek, er);
              return async (...x: unknown[]) => {
                await suDb.conversation.update({
                  where: { id: conv.id },
                  data: {
                    status: "resolved",
                    chatwootStatusAt: SENT_AT + 3600,
                  },
                });
                return tx.apply(et, x);
              };
            },
          });
        };
      },
    });

    await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: proxied,
      deps: depsWith(stub, turns),
    });

    // The resolve really did land inside the window, or this measures nothing.
    expect(fired).toBe(true);
    expect(stub.sent).toEqual([]);
    expect(turns.built).toBe(0);
    // And the operator's decision stands.
    expect(
      (
        await suDb.conversation.findUniqueOrThrow({
          where: { id: conv.id },
          select: { status: true },
        })
      ).status,
    ).toBe("resolved");
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
    expect(await deliveryLines(conv.id)).toHaveLength(0);
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

  test("a turn holding the thread on ANOTHER replica defers: the claim is in the row", async () => {
    // The conversation key is a Map lookup and always will be, because it has no row to be in
    // (src/graph/inflight.ts). The GRAPH key has one since issue #203, and it is the key a follow-up
    // NUDGE claims while posting into this very conversation — so asking only the conversation key
    // would build a turn beside a reply already on its way and answer the customer twice.
    //
    // ANOTHER replica, built the only way one process can build it: take the claim with the real
    // writer, then empty THIS process's Map. What is left holding the thread is the row alone, which
    // is exactly what a second replica sees. The Map is put back before the release so the count the
    // release decrements is the one the claim took.
    const convId = 8955;
    const messageId = 9455;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    const contactInboxId = 71_000 + convId;
    const owner = {
      tenantId,
      instanceId,
      contactInboxId,
      graphThreadId: contactInboxThreadId(tenantId, instanceId, contactInboxId),
    };
    const hold = await markTurnOwning(owner, appDb);
    clearTurnInFlight(owner.graphThreadId);

    let outcome: string;
    try {
      outcome = await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      });
    } finally {
      markTurnInFlight(owner.graphThreadId);
      await clearTurnOwning(owner, appDb, hold);
    }

    expect(outcome).toBe("deferred");
    expect(stub.sent).toEqual([]);
    // The REST reads DID happen, unlike the early check's case: this is the LATE fence, the one
    // after the two reads and the reconcile, and the only one that can see a turn that started
    // during them.
    expect(stub.asked.length).toBeGreaterThan(0);
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

    // THE MIRROR IS NOT THE ONLY READER, and on its own the line above proves nothing about the
    // rebuilt body: the body states the pairing WITH its version, so the mirror rejects the old one
    // whichever value the body carried. `armRedirectChatFollowUp` has no version to compare — it
    // takes the pairing straight off the event and UPSERTS the ladder's payload — so this is where a
    // body still carrying 991 shows up, re-arming a follow-up for the episode the customer left.
    // Keyed by THIS conversation's widget thread. Every recovery in this file arms a ladder now that
    // the fixture agent has channelRedirect on, so an unscoped read answers with a neighbour's row.
    const armed = await suDb.schedulerJob.findFirst({
      where: {
        tenantId,
        kind: "REDIRECT_FOLLOWUP",
        dedupeKey: followUpDedupeKey(threadOf(convId)),
      },
      select: { payload: true },
    });
    expect(
      (armed?.payload as { originDisplayId?: number } | null)?.originDisplayId,
    ).toBe(992);
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
    expect(await deliveryLines(conv.id)).toHaveLength(0);
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
    // The write itself is `putRowBack`, which has its own DB-backed tests below; what only the source
    // can say is which state THIS branch names.
    expect(block).toContain('from: "PROCESSING"');
    // `unreachable`, so the scheduler backs off and the retry finds a row it can claim.
    expect(block).toContain('return "unreachable"');
  });

  test("nothing awaits between the fence answering free and the mark that holds it", async () => {
    // The fence answers about the moment it runs, and the mark is what makes that answer keep
    // meaning something. Any await BETWEEN them is a window neither covers: a follow-up nudge
    // starting inside it reads no fence, and the recovery never asks again. MEASURED as a real gap
    // — `agentBotChatwootId` used to be resolved in exactly that spot, one scoped query wide.
    //
    // Structural, because the thing being asserted IS the absence of a suspension point, and a
    // behavioural test would have to inject the very await it is meant to forbid.
    const src = await Bun.file(
      new URL(
        "../../src/modules/chatwoot/recover-delivery.ts",
        import.meta.url,
      ),
    ).text();
    const mark = src.indexOf("markTurnReserved(handoffKey);");
    expect(mark).toBeGreaterThan(-1);
    // The LAST refusal before the mark, not the first: the fence asks in three steps and the middle
    // one awaits, so anchoring on the first would measure the wrong stretch and pass while the gap
    // this forbids sat in the second.
    const fenceEnd = src.lastIndexOf('    return "deferred";\n  }', mark);
    expect(fenceEnd).toBeGreaterThan(-1);
    const between = src.slice(fenceEnd, mark);
    // Comments in that stretch discuss awaits; the code must not contain one.
    const code = between
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("await ");

    // And the local keys are asked AFTER the durable read, not only before it. `turnOwnsThread`
    // reads a row; a turn that starts while that read is in flight marks the Map and the row-read
    // still describes the instant before it did. It answers for the GRAPH key itself (it asks the
    // Map first), so the one that would be missed is the CONVERSATION key — the same key the mark
    // below takes and the one `followUpHandler` reads.
    const durable = src.indexOf("await turnOwnsThread(");
    expect(durable).toBeGreaterThan(-1);
    expect(durable).toBeLessThan(mark);
    expect(src.slice(durable, mark)).toContain("isTurnInFlight(handoffKey)");
  });

  test("the pairing the body carries and the pairing the fence asks about are one reading", async () => {
    // The mirror is re-read once, and TWO things are built from that reading: the body handed to the
    // delivery path, and the graph key the fence asks about. ONE reading is what makes them the same
    // pairing, and it is only one reading while nothing between it and the fence can move it.
    // MEASURED as a real gap: `agentBotChatwootId` used to sit between the two, one scoped query
    // wide, and a webhook landing inside it (./mirror.ts writes `contactInboxId` on an unversioned
    // event) left the body and the fence naming the thread the contact HAD.
    //
    // Structural for the same reason as the test above: what is asserted IS the absence of a
    // suspension point, and reproducing it behaviourally means injecting the await it forbids.
    const src = await Bun.file(
      new URL(
        "../../src/modules/chatwoot/recover-delivery.ts",
        import.meta.url,
      ),
    ).text();
    const read = src.indexOf(
      "const contactInboxId = mirrorNow?.contactInboxId ?? null;",
    );
    expect(read).toBeGreaterThan(-1);
    // The FIRST of the fence's three steps: the middle one awaits `turnOwnsThread` by design, so an
    // anchor past it would measure a stretch that is allowed to suspend.
    const fence = src.indexOf(
      "if (isTurnInFlight(handoffKey) || isTurnInFlight(graphKey)) {",
      read,
    );
    expect(fence).toBeGreaterThan(-1);
    const code = src
      .slice(read, fence)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("await ");
  });

  test("the turn's failure is reported by the turn, never by the block around it", async () => {
    // `onDirectTurn` is how this module learns whether anybody was answered, and `{ kind: "error" }`
    // is the one reading that costs a SECOND TURN: the row goes back to DEAD, the scheduler runs the
    // whole delivery path again, the customer is answered twice and every side-effecting tool the
    // first turn called runs a second time.
    //
    // The delivery path's direct-turn block also wraps the bookkeeping that follows the turn —
    // settling the ledger, the unrouted line, clearing a surfaced error. Reported from the enclosing
    // catch, "the turn failed" and "the turn ANSWERED and a write after it failed" arrive here as
    // the same event. Today none of those three can throw, each swallowing its own failure; the
    // contract must not rest on that staying true at three unrelated call sites.
    //
    // Structural, because what is being asserted is that a PATH does not exist. A behavioural test
    // would have to add the throw it forbids.
    const src = await Bun.file(
      new URL("../../src/modules/chatwoot/webhook.ts", import.meta.url),
    ).text();
    const call = src.indexOf("const outcome = await runAgentTurn({");
    expect(call).toBeGreaterThan(-1);
    // The error report is inside the turn's own rejection handler, which starts at the `.then(`
    // that settles it and ends before the bookkeeping does.
    const settle = src.indexOf(").then(", call);
    expect(settle).toBeGreaterThan(-1);
    const handler = src.slice(settle, src.indexOf("\n          );", settle));
    expect(handler).toContain('onDirectTurn?.({ kind: "error", error: err })');
    expect(handler).toContain('onDirectTurn?.({ kind: "outcome"');
    // And NOWHERE else in the file, which is what rules out the enclosing catch: the bookkeeping
    // between the settlement and the catch may throw without this module hearing about it.
    const reports = src.split('onDirectTurn?.({ kind: "error"').length - 1;
    expect(reports).toBe(1);
    const outcomes = src.split('onDirectTurn?.({ kind: "outcome"').length - 1;
    expect(outcomes).toBe(1);
  });

  describe("putting the row back", () => {
    // The compensating write both failure roads take, tested where it can be: against the real
    // table. Three answers, and the caller acts differently on each — the source assertion above is
    // only for the branch that cannot be reached behaviourally.
    test("a row still in the state it was left in comes back to DEAD", async () => {
      const rowId = await seedDeadDelivery({
        conversationId: 8964,
        inboundMessageId: 9465,
        status: "PROCESSED",
      });
      expect(
        await putRowBack({
          base: appDb,
          tenantId,
          rowId,
          from: "PROCESSED",
          sleep: async () => {},
        }),
      ).toBe("restored");
      expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
    });

    test("a row that MOVED is left alone, and says so", async () => {
      // Not a failure: something else took it, and overwriting would undo that.
      const rowId = await seedDeadDelivery({
        conversationId: 8965,
        inboundMessageId: 9466,
        status: "PROCESSING",
      });
      expect(
        await putRowBack({
          base: appDb,
          tenantId,
          rowId,
          from: "PROCESSED",
          sleep: async () => {},
        }),
      ).toBe("moved");
      expect(await ledger(rowId)).toEqual({
        status: "PROCESSING",
        attempts: 0,
      });
    });

    test("a write that keeps failing is RETRIED and then reported, never swallowed", async () => {
      // The case the caller must not read as success: a swallowed failure leaves the row where the
      // delivery path put it, and from `PROCESSED` nothing revisits it — the customer is out of the
      // worklist with nobody having answered.
      let calls = 0;
      // `runScopedOn` extends the client and then opens a transaction on the extension, so the seam
      // a test can break is `$extends` — the first thing it touches.
      const broken = {
        $extends: () => {
          calls += 1;
          throw new Error("Timed out fetching a new connection from the pool");
        },
      } as unknown as typeof appDb;
      expect(
        await putRowBack({
          base: broken,
          tenantId,
          rowId: 1n,
          from: "PROCESSED",
          sleep: async () => {},
        }),
      ).toBe("failed");
      // Retried rather than given up on at the first blip, which is what the transient case needs.
      expect(calls).toBeGreaterThan(1);
    });
  });

  // Flips the bound agent to test mode for one case, which is the only mode a control command is
  // ACTIVE in. The fixture agent is `production` like a real one, so a test that wants a command has
  // to say so — and the pair below is why: the same text is a command in one mode and ordinary
  // customer text in the other.
  async function asTestModeAgent<T>(run: () => Promise<T>): Promise<T> {
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { mode: "test" },
    });
    try {
      return await run();
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "production" },
      });
    }
  }

  test("a control command is never replayed, where one is ACTIVE", async () => {
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

    const outcome = await asTestModeAgent(() =>
      recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub, turns),
      }),
    );

    expect(outcome).toBe("unrecoverable");
    expect(turns.built).toBe(0);
    expect(stub.sent).toEqual([]);
    // Left DEAD, which is the operator-facing record that lets them retype it.
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
  });

  test("the same text at a PRODUCTION agent is a customer message, and is answered", async () => {
    // Whether a control command exists at all is the agent's MODE, decided in ./webhook.ts with
    // `commandMode === "test"`. At a production agent `/reset` is not a command: the delivery path
    // hands it to the turn like any other text and the customer gets a reply. A recovery that
    // refused it would be answering a question the delivery path does not ask, and the cost would
    // fall on the customer rather than on a destructive effect — the one divergence from "run the
    // delivery path again" that LOSES a reply instead of saving one.
    //
    // The fixture agent is production, so this case needs no setup; its neighbour above is the one
    // that has to arrange for a command to exist.
    const convId = 8962;
    const messageId = 9463;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "/reset" }]),
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
    expect(await ledger(rowId)).toEqual({
      status: "PROCESSED",
      attempts: 1,
    });
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
