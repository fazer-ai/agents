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
import { burnSchedulerJobId } from "../utils/scheduler";

// Answering the customer whose delivery a process death stranded: the sweep leaves the ledger row
// DEAD and the message unanswered, and this file pins the recovery all the way to a reply reaching
// Chatwoot.
//
// The stub Chatwoot is the seam every caller uses (`deps.makeClient`), so the recovery's REST read
// (the page that ENDS at the stranded message id) is exercised up to the socket; a mocked module
// would only prove the call happened.

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

const CHATWOOT_INBOX_ID = 71;
// An inbox BOUND to an agent that has no `ChatwootAgentBot` row: the persona was never provisioned,
// or its row was deleted out of band. Deliveries still reach it, through another persona's route.
const NO_PERSONA_INBOX = 72;
// An inbox the mirror knows and NOBODY is bound to: the `no_agent` case, whose operator-facing line
// the delivery path writes.
const UNBOUND_INBOX = 73;
const OBSERVED_INBOX = 75;
const AGENT_BOT_ID = 11;
const OBSERVER_BOT_ID = 13;
const REPLY = "Desculpe a demora, estou aqui!";
// When the customer wrote, in epoch seconds. An hour ago rather than a fixed literal: it has to be
// inside `MAX_RECOVERY_AGE_MS` for the recovery to run at all, and far enough from `now` that a
// `lastInboundAt` stamped from the recovery's own clock cannot pass for it.
const SENT_AT = Math.floor(Date.now() / 1000) - 3600;

let tenantId = 0n;
let agentDbId = 0n;
let secondAgentDbId = 0n;
let watcherAgentDbId = 0n;
let observedInboxDbId = 0n;
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
// `conv` is the LIVE conversation the recovery reads first, in the fork's `GET /conversations/:id`
// shape: `id` is the display id, `status` a string, the assignee under `meta`, no `contact_inbox`.
// It defaults to an unassigned pending conversation whose newest event IS the message.
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
  // What the catch-up read (`?after=`) returns: the fork's listing by id, which carries the
  // reactions its paged reads leave out.
  caughtUp?: unknown;
  throwOnRead?: boolean;
  // The Nth send and every one after it are rejected: a Chatwoot that accepts the first balloon of a
  // split reply and refuses the rest.
  failSendFrom?: number;
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
  let sends = 0;
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
    getMessages: async (
      conversationId: number,
      o?: { before?: number; after?: number },
    ) => {
      if (opts.throwOnRead) throw new Error("connect ECONNREFUSED");
      if (o?.after !== undefined) return opts.caughtUp ?? { payload: [] };
      asked.push([conversationId, o?.before]);
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
      sends += 1;
      if (opts.failSendFrom !== undefined && sends >= opts.failSendFrom) {
        throw new Error("chatwoot 502");
      }
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

// One incoming message, in the shape the REST read returns it: `message_type` as an INTEGER (the
// divergence from the webhook wire that `messageTypeOf` exists for), and `inbox_id` as a scalar
// beside it, which the fork's `api/v1/models/_message.json.jbuilder` renders on every message.
function pageWith(
  msgs: Array<{
    id: number;
    content: string;
    createdAt?: number;
    // A reply a PERSON wrote in the composer: public outgoing with a `user` sender. It is what the
    // third-party boundary sees, and nothing here changes attribution.
    byUser?: boolean;
  }>,
  // `null` drops the key, which is what a Chatwoot that does not render it looks like from here.
  inboxId: number | null = CHATWOOT_INBOX_ID,
) {
  return {
    payload: msgs.map((m) => ({
      id: m.id,
      content: m.content,
      message_type: m.byUser ? 1 : 0,
      private: false,
      ...(inboxId !== null ? { inbox_id: inboxId } : {}),
      // Epoch SECONDS, as the REST read gives it.
      created_at: m.createdAt ?? SENT_AT,
      sender: m.byUser
        ? { id: 41, name: "Ana", type: "user" }
        : { id: 77, name: "Cliente", type: "contact" },
      attachments: [],
    })),
  };
}

// The same page, for a message whose whole content is a voice note the STT has since transcribed.
// `content` is empty, as it is on the wire for an audio: the words live on the attachment, which is
// what makes the write-back update the only readable form the message ever takes.
function audioPageWith(
  msgs: Array<{
    id: number;
    transcript: string;
    createdAt?: number;
    // Text beside the audio. Empty is the ordinary voice note; a command-looking string is the case
    // where the command fence would fire on a message that was never a command.
    content?: string;
  }>,
  inboxId: number = CHATWOOT_INBOX_ID,
) {
  return {
    payload: msgs.map((m) => ({
      id: m.id,
      content: m.content ?? "",
      message_type: 0,
      private: false,
      inbox_id: inboxId,
      created_at: m.createdAt ?? SENT_AT,
      sender: { id: 77, name: "Cliente", type: "contact" },
      attachments: [
        {
          id: 5000 + m.id,
          file_type: "audio",
          data_url: "https://chat.recover.example/audio.ogg",
          // NOTE: UNDER `meta`, where the REST message list carries an eager pass's write-back (the
          // webhook carries it at the top level). The recovery reads REST, so the webhook spelling
          // here would pass a rebuild that cannot work.
          meta: { transcribed_text: m.transcript },
        },
      ],
    })),
  };
}

// SETTLED and scoped. `emitFlowEvent` is fire-and-forget, and several cases assert that NO line was
// written, which a raw read passes for the wrong reason; the helper waits for the in-flight writes
// instead of polling for an arrival. Scoped by conversation, or it answers with a neighbour's row.
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
  // The route the delivery arrived on, as the live path records it. Null (the default) is a row an
  // older build wrote, where the recovery falls back to the inbox's persona.
  routeAgentBotId?: number | null;
  // Whether the receiver recorded that route as an OBSERVER's.
  routeObserved?: boolean | null;
  // The event the delivery carried. `message_created` by default; `message_updated` is the write-back
  // that brought a voice note's transcription.
  event?: string;
  // The inbox's binding generation when the delivery was received. Undefined is a row an older build
  // wrote, which carries none.
  bindingGeneration?: number | null;
}): Promise<bigint> {
  deliverySeq += 1;
  const row = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `rec-${process.pid}-${deliverySeq}`,
      event: over.event ?? "message_created",
      status: over.status ?? "DEAD",
      receivedAt: new Date(Date.now() - (over.receivedAgoMs ?? 60 * 60 * 1000)),
      claimedAt: new Date(Date.now() - 60 * 60 * 1000),
      attempts: over.attempts ?? 0,
      conversationId: over.conversationId,
      inboundMessageId:
        over.inboundMessageId === undefined ? 9301 : over.inboundMessageId,
      routeAgentBotId: over.routeAgentBotId ?? null,
      routeObserved: over.routeObserved ?? null,
      bindingGeneration: over.bindingGeneration ?? null,
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
    phantomJobId = await burnSchedulerJobId(suDb);
    // NOTE: registered as src/index.ts does at boot, and read back through `getJobHandler` so an
    // unregistered handler fails here. Not undone: the registry is process-global
    // (tests/utils/job-registry.ts), but this is the PRODUCTION handler, and unregistering would
    // leave the registrar's module latch set, so a later caller would silently register nothing.
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
        // NOTE: debounce OFF so the reply is inline and assertable; the debounced path has its own
        // test below. channelRedirect ON because the follow-up ladder arms off the event, not the
        // mirror, so it is where a rebuilt body with a stale pairing shows. The entry inbox is a
        // number no fixture uses.
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
    // A WATCHER and the inbox it only observes: no responder, so the recovery has nothing to derive
    // a route from and must take the one the delivery arrived on.
    const watcher = await suDb.agent.create({
      data: {
        tenantId,
        name: "Observadora",
        systemPrompt: "Você observa.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        mode: "monitoring",
        settings: { debounce: { enabled: false } },
      },
    });
    watcherAgentDbId = watcher.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: watcher.id,
        chatwootAgentBotId: OBSERVER_BOT_ID,
        accessToken: encryptJson("BOT3"),
        webhookSecret: encryptJson("S3"),
        webhookRouteTokenHash: `rec-route3-${process.pid}`,
        name: "Observadora",
      },
    });
    const observed = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OBSERVED_INBOX,
        name: "Humanos",
      },
    });
    observedInboxDbId = observed.id;
    await suDb.inboxObserver.create({
      // Older than any delivery these tests seed (an hour back), so the binding predates them.
      data: {
        tenantId,
        inboxId: observed.id,
        agentId: watcher.id,
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      },
    });
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
    // NOTE: the assertion about the customer: a reply reached the conversation nothing was going to
    // answer.
    expect(stub.sent).toEqual([[convId, REPLY]]);
    expect(await ledger(rowId)).toEqual({ status: "PROCESSED", attempts: 1 });
  });

  // A STRANDED REACTION NO PAGED READ CARRIES. The fork keeps a reaction on a
  // `before` page only when the message it reacts to is in that page of the same conversation, so a
  // reaction to an older message reads as deleted there. The catch-up read finds it, and the
  // customer's turn happens instead of the row being settled as unrecoverable.
  test("a stranded reaction the anchored page leaves out is still recovered", async () => {
    const convId = 8746;
    const messageId = 9746;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const earlier = pageWith([{ id: messageId - 5, content: "obrigada!" }]);
    const reaction = {
      payload: [
        {
          ...(pageWith([{ id: messageId, content: "❤️" }]).payload[0] ?? {}),
          content_attributes: { is_reaction: true },
        },
      ],
    };
    const stub = stubChatwoot({
      page: earlier,
      recent: earlier,
      caughtUp: reaction,
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

  // What the catch-up read found is part of the freshness answer. Two
  // stranded reactions the default page leaves out: recovering the older one would answer it after
  // the customer reacted again, so it is refused like any older message.
  test("a newer reaction only the catch-up read carries still counts as the customer writing again", async () => {
    const convId = 8748;
    const messageId = 9748;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const earlier = pageWith([{ id: messageId - 5, content: "obrigada!" }]);
    const reactionRow = (id: number, emoji: string) => ({
      ...(pageWith([{ id, content: emoji }]).payload[0] ?? {}),
      content_attributes: { is_reaction: true },
    });
    const stub = stubChatwoot({
      page: earlier,
      recent: earlier,
      caughtUp: {
        payload: [
          reactionRow(messageId, "❤️"),
          reactionRow(messageId + 2, "😂"),
        ],
      },
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    expect(outcome).toBe("unrecoverable");
    expect(stub.sent).toEqual([]);
  });

  // A FULL catch-up read stops short of the newest page, so it is no
  // coverage. Merged, it would place the stranded reaction inside what was seen while a newer
  // message sat in the gap; left out, the newest page says the reaction is more than a page behind.
  test("a full catch-up read is not coverage for the freshness check", async () => {
    const convId = 8749;
    const messageId = 9749;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    // The newest page holds only our own reply; the customer's newer message sits in the gap.
    const newest = {
      payload: pageWith([{ id: messageId + 500, content: "ok" }]).payload.map(
        (m) => ({ ...m, message_type: 1 }),
      ),
    };
    const caught = pageWith(
      Array.from({ length: 100 }, (_, i) => ({
        id: messageId + i,
        content: i === 0 ? "❤️" : "…",
      })),
    );
    const stub = stubChatwoot({
      page: newest,
      recent: newest,
      caughtUp: {
        payload: caught.payload.map((m, i) =>
          i === 0
            ? { ...m, content_attributes: { is_reaction: true } }
            : { ...m, message_type: 2 },
        ),
      },
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    expect(outcome).toBe("unrecoverable");
    expect(stub.sent).toEqual([]);
  });

  // The other half: a full read of newer REACTIONS the default page leaves
  // out, over a newest page that reaches below the stranded one: the page alone would look covered
  // and fresh, and the reactions the read carried are what says the customer went on.
  test("a full catch-up read of newer reactions refuses the replay", async () => {
    const convId = 8750;
    const messageId = 9850;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const older = pageWith([{ id: messageId - 5, content: "obrigada!" }]);
    const caught = pageWith(
      Array.from({ length: 100 }, (_, i) => ({
        id: messageId + i,
        content: "❤️",
      })),
    );
    const stub = stubChatwoot({
      page: older,
      recent: older,
      caughtUp: {
        payload: caught.payload.map((m) => ({
          ...m,
          content_attributes: { is_reaction: true },
        })),
      },
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    expect(outcome).toBe("unrecoverable");
    expect(stub.sent).toEqual([]);
  });

  // A RECOVERY THAT DELIVERED HALF AN ANSWER IS STILL A SETTLED ROW. A second pass cannot post the
  // rest: the first pass claimed the handled watermark (monotonic CAS) before the first balloon, so
  // `shouldPost` supersedes it, and keeping the row would spend every attempt, one model call each,
  // on that silence. So the missing half is a badge on the conversation, and the row is PROCESSED.
  test("a reply that arrived in half settles the row and leaves a badge", async () => {
    const convId = 8996;
    const messageId = 9496;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi, alguém aí?" }]),
      // NOTE: fails the second balloon AND the consolidated retry of the remainder.
      failSendFrom: 2,
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: {
        makeClient: stub.makeClient,
        makeModel: () =>
          new FakeListChatModel({
            responses: ["Olá!\n\nJá te respondo.\n\nUm instante."],
          }),
        checkpointer: new MemorySaver(),
        sleep: async () => {},
      },
    });

    expect(outcome).toBe("recovered");
    // NOTE: what reached the customer: the first balloon, once.
    expect(stub.sent).toEqual([[convId, "Olá!"]]);
    expect(await ledger(rowId)).toEqual({ status: "PROCESSED", attempts: 1 });
    // And the half that did not, said where an operator sees it.
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { lastError: true },
    });
    expect(conv.lastError).toContain("incompleta");
  });

  // A REPLY A PERSON ALREADY WROTE SETTLES THE ROW. The recovered turn rereads the page, finds the
  // agent's reply above the stranded message, and stops: `answered-elsewhere` is `taken-over` without
  // the attribution change. Outside `TURN_SETTLED`, the row would go back to DEAD and a conversation a
  // person just answered would be listed as lost.
  test("a message a person already answered settles the row", async () => {
    const convId = 8997;
    const messageId = 9497;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([
        { id: messageId, content: "tem alguém?" },
        // NOTE: the human agent answered while the delivery was stranded. The attribution does NOT
        // change: if it did, the ownership recheck would close first with `taken-over`.
        {
          id: messageId + 1,
          content: "oi, sou a Ana do suporte",
          byUser: true,
        },
      ]),
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: {
        makeClient: stub.makeClient,
        makeModel: () => new FakeListChatModel({ responses: ["Olá!"] }),
        checkpointer: new MemorySaver(),
        sleep: async () => {},
      },
    });

    expect(outcome).toBe("recovered");
    // NOTE: nothing is said over the person...
    expect(stub.sent).toEqual([]);
    // NOTE: ...and the row is closed instead of going back to the lost list.
    expect(await ledger(rowId)).toEqual({ status: "PROCESSED", attempts: 1 });
  });

  // A TURN STOPPED BEFORE THE INVOKE SETTLES THE ROW, BECAUSE THE INGESTION HAS THE MESSAGE.
  // `taken-over-unread`: nothing read the message, and the ingestion the receiver arms in the SAME
  // pass stores it (if it cannot arm, the receiver throws, which reaches here as `turnThrew`). Kept
  // out of `TURN_SETTLED`, the row would go back to DEAD with the watermark already advanced, and no
  // later attempt could post.
  test("a takeover that stops the turn before the invoke settles the row, because the ingestion has the message", async () => {
    const convId = 8998;
    const messageId = 9498;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "tem alguém?" }]),
    });
    let leituras = 0;

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: {
        ...depsWith(stub),
        ownershipRead: async () => {
          leituras += 1;
          return { ours: false, closed: { outcome: "taken_over" } };
        },
      },
    });

    // NOTE: the read really happened; without this the test passes with the whole gate removed.
    expect(leituras).toBeGreaterThan(0);
    // NOTE: nothing is said over the person who took over...
    expect(stub.sent).toEqual([]);
    // NOTE: ...and the row CLOSES, because the message is stored. DEAD with the watermark already
    // advanced would list the conversation as lost with no later attempt able to answer.
    expect(await ledger(rowId)).toEqual({ status: "PROCESSED", attempts: 1 });
    expect(outcome).toBe("recovered");
  });

  test("a conversation the mirror still calls resolved is answered anyway", async () => {
    // An incoming message on a resolved conversation REOPENS it in the fork
    // (`Message#reopen_resolved_conversation`: `pending` on a bot inbox, `open` otherwise), and the
    // delivery that would have mirrored that is the one that died. Built from the mirror alone, the
    // body says `resolved`, `shouldBotHandle` refuses, and a recovery is reported that answered nobody.
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
      // NOTE: what Chatwoot holds: the reopen already happened there.
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

    // The mirror is REPAIRED, not merely bypassed: every gate downstream reads this row, so
    // leaving it on `resolved` would hand the next delivery the same wrong answer.
    const row = await suDb.conversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { status: true },
    });
    expect(row.status).toBe("pending");
  });

  test("a route whose agent has no persona bot is refused, not answered loosely", async () => {
    // `agentBotChatwootId` is null for an inbox bound to an agent with no `ChatwootAgentBot`.
    // Passing the null on is worse than refusing: `heldByAnotherParty` cannot compare ids, the gate
    // goes LOOSE, and another AgentBot's conversation reads as ours; a real client without the
    // persona's token refuses by name, so the cost is a model call and a recovery reported anyway.
    // A live delivery never reaches this state: its `agentBotId` is the route token's bot.
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
    // Not narrowed to "another bot holds it": what is missing is the identity. A client built
    // without the persona's token refuses by name, so an unassigned conversation here would spend a
    // model call to post nothing and then report a recovery.
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
    // Not the refusal above: an inbox with no agent at all is `no_agent`, whose operator line
    // the delivery path writes. It runs the path AND KEEPS THE ROW: `no-agent` answered nobody, so it
    // is not a close (see `TURN_ANSWERED`). The line names the inbox, the DEAD row names the message.
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
    // NOTE: the path really ran (the `no_agent` line is here), and no `recovered` line beside it.
    expect(await deliveryLines(conv.id)).toEqual([]);
    const noAgent = await flowLogRows(suDb, {
      where: { tenantId, stage: "route", conversationId: conv.id },
      select: { detail: true },
    });
    expect(noAgent.map((r) => r.detail)).toEqual([
      { outcome: "no_agent", chatwootInboxId: UNBOUND_INBOX },
    ]);
  });

  // The observer's path relies on this recovery for a delivery that died before its watermark. An
  // observed inbox names no responder, so the identity comes from the route on the row, not the inbox.
  // CLOSED, NOT PUT BACK: with no responder the route remembers nothing and says so; read as "no route
  // asked", the replay would go back to DEAD and retry until its attempts ran out.
  test("a delivery stranded on an OBSERVER's route is re-run on that route", async () => {
    const convId = 8974;
    const messageId = 9474;
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "open",
        assigneeType: "User",
        assigneeId: 9,
        inboxId: observedInboxDbId,
        threadId: threadOf(convId),
        lastEventAt: new Date((SENT_AT - 600) * 1000),
        contactInboxId: 71_000 + convId,
      },
      select: { id: true },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      routeAgentBotId: OBSERVER_BOT_ID,
      routeObserved: true,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }], OBSERVED_INBOX),
    });

    await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    // NOTE: nothing is said on an observer's route, nothing is remembered for a responder the inbox
    // does not have, and the row is closed with the watermark past the message.
    expect(stub.sent).toEqual([]);
    const armed = await suDb.schedulerJob.findMany({
      where: { tenantId, kind: "INGEST_MESSAGE" },
      select: { payload: true },
    });
    expect(
      armed.filter((j) =>
        JSON.stringify(j.payload).includes(String(messageId)),
      ),
    ).toEqual([]);
    expect((await ledger(rowId)).status).toBe("PROCESSED");
    expect(
      (
        await suDb.conversation.findUniqueOrThrow({
          where: { id: conv.id },
          select: { lastHandledMessageId: true },
        })
      ).lastHandledMessageId,
    ).toBe(messageId);
  });

  // THE FRESHNESS CHECK IS THE RESPONDER'S, and asking it of an observer loses the message for good.
  // It refuses because the newer message's own delivery carries the
  // REPLY — a premise about answering. An observer's replay answers nobody: what it owes is the
  // watermark and the verdict its delivery died before reaching.
  test("a newer customer message does not refuse an OBSERVER's replay", async () => {
    const convId = 8988;
    const messageId = 9488;
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "open",
        assigneeType: "User",
        assigneeId: 9,
        inboxId: observedInboxDbId,
        threadId: threadOf(convId),
        lastEventAt: new Date((SENT_AT - 600) * 1000),
        contactInboxId: 71_000 + convId,
      },
      select: { id: true },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      routeAgentBotId: OBSERVER_BOT_ID,
      routeObserved: true,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }], OBSERVED_INBOX),
      // The customer wrote again while the row sat stranded. On a responder's route this is the
      // refusal; here it is not even read.
      recent: pageWith(
        [
          { id: messageId, content: "oi" },
          { id: messageId + 4, content: "esqueça, já resolvi" },
        ],
        OBSERVED_INBOX,
      ),
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).not.toBe("unrecoverable");
    // Still nothing said to the customer, and the replay ran to its close.
    expect(stub.sent).toEqual([]);
    expect((await ledger(rowId)).status).toBe("PROCESSED");
  });

  // The transcription replay on the RESPONDER's route: a `message_updated` drives no turn, so every
  // read and refusal that protects a reply stands aside. One premise, three checks: no unanchored
  // read, no refusal on a newer customer message, and none for audio older than the age ceiling (the
  // words arrive on a write-back of an older message). The row's own receipt still bounds it.
  test("a stranded transcription is replayed without the reads a reply would need", async () => {
    const convId = 8899;
    const messageId = 9499;
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "open",
        // NOTE: a colleague owns the conversation: no turn was coming, and the append is the only
        // memory the message gets.
        assigneeType: "User",
        assigneeId: 9,
        inboxId: inboxDbId,
        threadId: threadOf(convId),
        lastEventAt: new Date((SENT_AT - 600) * 1000),
        contactInboxId: 71_000 + convId,
      },
      select: { id: true },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      event: "message_updated",
      routeAgentBotId: AGENT_BOT_ID,
      // Recent: the UPDATE is what this replays, and it is what the ceiling is asked of.
      receivedAgoMs: 20 * 60 * 1000,
    });
    // Older than MAX_RECOVERY_AGE_MS, on the message's own clock.
    const audioCreatedAt = Math.floor(Date.now() / 1000) - 7 * 60 * 60;
    const stub = stubChatwoot({
      // NOTE: the LIVE conversation agrees with the mirror. The rebuild takes ownership from here,
      // so the default (unassigned) would hand the replay a conversation the bot owns, and the ingest
      // gate would refuse it for the wrong reason.
      conv: { status: "open", assigneeType: "User", assigneeId: 9 },
      page: audioPageWith([
        {
          id: messageId,
          transcript: "queria remarcar meu ingresso",
          createdAt: audioCreatedAt,
        },
      ]),
      // Never read on this route. Seeded with a newer customer message so that a build which DID
      // read it would refuse the replay, rather than passing for the wrong reason.
      recent: pageWith([
        { id: messageId + 4, content: "deixa, já resolvi", createdAt: SENT_AT },
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
    // The unanchored read is the one with no `before`. None was made.
    expect(stub.asked.filter(([, before]) => before === undefined)).toEqual([]);
    expect(stub.sent).toEqual([]);
    const armed = await suDb.schedulerJob.findMany({
      where: { tenantId, kind: "INGEST_MESSAGE" },
      select: { payload: true },
    });
    expect(
      armed.filter((j) => JSON.stringify(j.payload).includes(String(messageId)))
        .length,
    ).toBeGreaterThan(0);
    expect((await ledger(rowId)).status).toBe("PROCESSED");
  });

  // The sweep arms this replay for an observer's transcription on an inbox with no responder of
  // ours, because a stranded row cannot tell "owed nothing" from a failed arm. So the replay settles
  // it: the route reports it has no reader, and the row closes instead of retrying.
  test("an observer's transcription replay on an inbox with no responder closes without remembering", async () => {
    const convId = 8990;
    const messageId = 9490;
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "open",
        assigneeType: "User",
        assigneeId: 9,
        inboxId: observedInboxDbId,
        threadId: threadOf(convId),
        lastEventAt: new Date((SENT_AT - 600) * 1000),
        contactInboxId: 71_000 + convId,
      },
      select: { id: true },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      event: "message_updated",
      routeAgentBotId: OBSERVER_BOT_ID,
      routeObserved: true,
      receivedAgoMs: 20 * 60 * 1000,
    });
    const stub = stubChatwoot({
      conv: { status: "open", assigneeType: "User", assigneeId: 9 },
      page: audioPageWith(
        [{ id: messageId, transcript: "queria remarcar meu ingresso" }],
        OBSERVED_INBOX,
      ),
    });

    await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: depsWith(stub),
    });

    expect(stub.sent).toEqual([]);
    const armed = await suDb.schedulerJob.findMany({
      where: { tenantId, kind: "INGEST_MESSAGE" },
      select: { payload: true },
    });
    expect(
      armed.filter((j) =>
        JSON.stringify(j.payload).includes(String(messageId)),
      ),
    ).toEqual([]);
    expect((await ledger(rowId)).status).toBe("PROCESSED");
  });

  // An inbox that still NAMES a responder while its bot is gone from Chatwoot — the state the console
  // shows as "missing". The watcher is then the only memory the inbox has, so its ingestion is what
  // strands the delivery, and the recorded route is the only thing that names it.
  test("an observer's stranded delivery is re-run on its route even where the inbox names a responder", async () => {
    const convId = 8976;
    const messageId = 9476;
    const observerRow = await suDb.inboxObserver.create({
      // Older than the delivery: the binding has to predate the message for the route to be its.
      data: {
        tenantId,
        inboxId: inboxDbId,
        agentId: watcherAgentDbId,
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    const responderBot = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { tenantId, agentId: agentDbId },
    });
    await suDb.chatwootAgentBot.delete({ where: { id: responderBot.id } });
    try {
      await seedConversation(convId, {
        assigneeType: "User",
        assigneeId: 9,
        status: "open",
        lastEventAt: new Date((SENT_AT - 600) * 1000),
      });
      const rowId = await seedDeadDelivery({
        conversationId: convId,
        inboundMessageId: messageId,
        routeAgentBotId: OBSERVER_BOT_ID,
        routeObserved: true,
      });
      const stub = stubChatwoot({
        page: pageWith([{ id: messageId, content: "oi" }]),
      });

      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      });

      expect(stub.sent).toEqual([]);
      const armed = await suDb.schedulerJob.findMany({
        where: { tenantId, kind: "INGEST_MESSAGE" },
        select: { payload: true },
      });
      expect(
        armed.some(
          (j) =>
            JSON.stringify(j.payload).includes(String(messageId)) &&
            JSON.stringify(j.payload).includes(String(watcherAgentDbId)),
        ),
      ).toBe(true);
    } finally {
      await suDb.inboxObserver.delete({ where: { id: observerRow.id } });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: responderBot.chatwootInstanceId,
          agentId: responderBot.agentId,
          chatwootAgentBotId: responderBot.chatwootAgentBotId,
          accessToken: responderBot.accessToken,
          webhookSecret: responderBot.webhookSecret,
          webhookRouteTokenHash: responderBot.webhookRouteTokenHash,
          name: responderBot.name,
        },
      });
    }
  });

  // The observer's replay beside a responder that ALREADY has the message: the receiver stands its
  // ingestion down on purpose, so nothing is enqueued and nothing is lost. Read as "no route looked",
  // the row would go back on the worklist and retry until its attempts ran out, for no loss.
  test("an observer's replay that stood down for the responder is still closed", async () => {
    const convId = 8894;
    const messageId = 9494;
    const observerRow = await suDb.inboxObserver.create({
      // Older than the delivery: the binding has to predate the message for the route to be its.
      data: {
        tenantId,
        inboxId: inboxDbId,
        agentId: watcherAgentDbId,
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    try {
      await seedConversation(convId, {
        assigneeType: "User",
        assigneeId: 9,
        status: "open",
        lastEventAt: new Date((SENT_AT - 600) * 1000),
      });
      const rowId = await seedDeadDelivery({
        conversationId: convId,
        inboundMessageId: messageId,
        routeAgentBotId: OBSERVER_BOT_ID,
        routeObserved: true,
      });
      const stub = stubChatwoot({
        page: pageWith([{ id: messageId, content: "oi" }]),
      });

      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      });

      // Settled, not put back: the responder of this inbox has the message, which is a decision and
      // not a silence.
      expect((await ledger(rowId)).status).toBe("PROCESSED");
      expect(stub.sent).toEqual([]);
    } finally {
      await suDb.inboxObserver.delete({ where: { id: observerRow.id } });
    }
  });

  // The role travels with the replay: unbinding the observer and promoting its agent between the
  // strand and the recovery must not turn a watcher's delivery into an answering one.
  test("a stranded observer delivery stays an observer's, even after its binding is gone", async () => {
    const convId = 8977;
    const messageId = 9477;
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "open",
        assigneeType: "User",
        assigneeId: 9,
        inboxId: observedInboxDbId,
        threadId: threadOf(convId),
        lastEventAt: new Date((SENT_AT - 600) * 1000),
        contactInboxId: 71_000 + convId,
      },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      routeAgentBotId: OBSERVER_BOT_ID,
      routeObserved: true,
    });
    // The binding is gone and the agent answers now: everything a role inference would read
    // has changed.
    const rows = await suDb.inboxObserver.findMany({
      where: { tenantId, agentId: watcherAgentDbId },
      select: { id: true, inboxId: true, agentId: true, createdAt: true },
    });
    await suDb.inboxObserver.deleteMany({
      where: { tenantId, agentId: watcherAgentDbId },
    });
    await suDb.agent.update({
      where: { id: watcherAgentDbId },
      data: { mode: "production" },
    });
    try {
      const stub = stubChatwoot({
        page: pageWith([{ id: messageId, content: "oi" }], OBSERVED_INBOX),
      });

      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      });

      // Nothing said, and the row closed on the watcher's path: taken for the responder's, the
      // agent now in production would have been asked to answer.
      expect(stub.sent).toEqual([]);
      expect((await ledger(rowId)).status).toBe("PROCESSED");
    } finally {
      await suDb.agent.update({
        where: { id: watcherAgentDbId },
        data: { mode: "monitoring" },
      });
      for (const r of rows) {
        await suDb.inboxObserver.create({
          data: {
            tenantId,
            inboxId: r.inboxId,
            agentId: r.agentId,
            createdAt: r.createdAt,
          },
        });
      }
    }
  });

  // A Chatwoot bot id is mutable: re-provisioning after an out-of-band deletion gives the persona a
  // new one, and the row still names the old. Replayed anyway, the route would resolve nothing and
  // the message would be consumed by the recovery that exists to save it.
  test("a stranded observer delivery whose bot id no longer exists is not replayed", async () => {
    const convId = 8975;
    const messageId = 9475;
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "open",
        assigneeType: "User",
        assigneeId: 9,
        inboxId: observedInboxDbId,
        threadId: threadOf(convId),
        lastEventAt: new Date((SENT_AT - 600) * 1000),
        contactInboxId: 71_000 + convId,
      },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      routeAgentBotId: OBSERVER_BOT_ID + 90,
      routeObserved: true,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }], OBSERVED_INBOX),
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("unrecoverable");
    expect(stub.sent).toEqual([]);
    expect((await ledger(rowId)).status).toBe("DEAD");
  });

  // NULL IS "NOBODY DECIDED", and guessing "the responder's" is the outcome the recorded role exists
  // to prevent: on an inbox nobody of ours answers the observation is lost without a trace, and on a
  // shared one the responder answers a message its own route already carried.
  test("a stranded delivery that names its bot and no role is not replayed", async () => {
    const convId = 8978;
    const messageId = 9478;
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "open",
        assigneeType: "User",
        assigneeId: 9,
        inboxId: observedInboxDbId,
        threadId: threadOf(convId),
        lastEventAt: new Date((SENT_AT - 600) * 1000),
        contactInboxId: 71_000 + convId,
      },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      routeAgentBotId: OBSERVER_BOT_ID,
      routeObserved: null,
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }], OBSERVED_INBOX),
    });

    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("unrecoverable");
    expect(stub.sent).toEqual([]);
    expect((await ledger(rowId)).status).toBe("DEAD");
  });

  // ONE BOT SERVES EVERY ROLE ITS AGENT HOLDS, so an observer unobserved and then bound as the
  // responder carries the same Chatwoot id it had as the watcher. Bot equality then reads "the route
  // is the responder's" off a binding that did not exist when the message arrived, and a delivery
  // whose role was never stated would be replayed as an answering one — a late reply to a customer.
  test("a stranded delivery with no role, against a responder binding made after it, is not replayed", async () => {
    const convId = 8979;
    const messageId = 9479;
    await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      // The inbox's OWN responder bot: the equality test above passes, and only the binding's age
      // says the role is unknowable.
      routeAgentBotId: AGENT_BOT_ID,
      routeObserved: null,
      receivedAgoMs: 60 * 60 * 1000,
    });
    await suDb.inbox.update({
      where: { id: inboxDbId },
      data: { responderBoundAt: new Date(Date.now() - 30 * 60 * 1000) },
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    try {
      expect(
        await recoverStrandedDelivery({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          deps: depsWith(stub),
        }),
      ).toBe("unrecoverable");
      expect(stub.sent).toEqual([]);
      expect((await ledger(rowId)).status).toBe("DEAD");
    } finally {
      await suDb.inbox.update({
        where: { id: inboxDbId },
        data: { responderBoundAt: null },
      });
    }
  });

  // ...AND THE SAME ROW, WITH THE GENERATION SAYING NO BINDING MOVED, IS REPLAYED. The stamp alone
  // refuses too much: an inbox bound while its own traffic was in flight produces this pair. The
  // generation moves on every binding write and nothing else, so when it has not moved since
  // receipt, the stamp is an artifact rather than a rebind.
  test("a stranded delivery with no role, against a binding stamp the generation contradicts, is replayed", async () => {
    const convId = 8987;
    const messageId = 9487;
    await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const inboxNow = await suDb.inbox.findUniqueOrThrow({
      where: { id: inboxDbId },
      select: { bindingGeneration: true },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      routeAgentBotId: AGENT_BOT_ID,
      routeObserved: null,
      receivedAgoMs: 60 * 60 * 1000,
      // Received under the world the inbox is still in: nothing about who routes it has moved
      // since, whatever the stamp below says.
      bindingGeneration: inboxNow.bindingGeneration,
    });
    await suDb.inbox.update({
      where: { id: inboxDbId },
      data: { responderBoundAt: new Date(Date.now() - 30 * 60 * 1000) },
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    try {
      expect(
        await recoverStrandedDelivery({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          deps: depsWith(stub),
        }),
      ).not.toBe("unrecoverable");
    } finally {
      await suDb.inbox.update({
        where: { id: inboxDbId },
        data: { responderBoundAt: null },
      });
    }
  });

  // ...and where BOTH facts say so, the refusal stands: the generation moved since receipt AND the
  // responder binding is younger than the delivery.
  test("a stranded delivery with no role, against a binding both facts call younger than it, is not replayed", async () => {
    const convId = 8989;
    const messageId = 9489;
    await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const inboxNow = await suDb.inbox.findUniqueOrThrow({
      where: { id: inboxDbId },
      select: { bindingGeneration: true },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      routeAgentBotId: AGENT_BOT_ID,
      routeObserved: null,
      receivedAgoMs: 60 * 60 * 1000,
      bindingGeneration: inboxNow.bindingGeneration - 1,
    });
    await suDb.inbox.update({
      where: { id: inboxDbId },
      data: { responderBoundAt: new Date(Date.now() - 30 * 60 * 1000) },
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    try {
      expect(
        await recoverStrandedDelivery({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          deps: depsWith(stub),
        }),
      ).toBe("unrecoverable");
      expect(stub.sent).toEqual([]);
      expect((await ledger(rowId)).status).toBe("DEAD");
    } finally {
      await suDb.inbox.update({
        where: { id: inboxDbId },
        data: { responderBoundAt: null },
      });
    }
  });

  // ...and the same row against a binding OLDER than it recovers as it always did: the age is only
  // ever a refusal, never a new reason to replay.
  test("a stranded delivery with no role, against a responder binding older than it, is replayed", async () => {
    const convId = 8980;
    const messageId = 9480;
    await seedConversation(convId, {
      lastEventAt: new Date((SENT_AT - 600) * 1000),
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      routeAgentBotId: AGENT_BOT_ID,
      routeObserved: null,
      receivedAgoMs: 60 * 60 * 1000,
    });
    await suDb.inbox.update({
      where: { id: inboxDbId },
      data: { responderBoundAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    });
    const stub = stubChatwoot({
      page: pageWith([{ id: messageId, content: "oi" }]),
    });
    try {
      expect(
        await recoverStrandedDelivery({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          deps: depsWith(stub),
        }),
      ).not.toBe("unrecoverable");
    } finally {
      await suDb.inbox.update({
        where: { id: inboxDbId },
        data: { responderBoundAt: null },
      });
    }
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
    // `shouldPost` withholds a reply to a message a newer one passed, yet the path settles the
    // row, so without this check the recovery would spend a model call and close the loss unanswered
    // (the newer turn only read its own trigger text). `unrecoverable`, asked before the claim: a
    // newer message never un-arrives, and the row stays DEAD where an operator can read it.
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
    // NOTE: no turn is built: the refusal is asked before the claim, so it spends neither an attempt
    // nor a model call.
    expect(turns.built).toBe(0);
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 0 });
    // And no closing line: the loss is still open.
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
    // `lastInboundAt` anchors the follow-up "new episode" gate and the WhatsApp 24h window, so
    // the recovered customer message must move it. The hard case: an away message after the strand
    // puts live activity AHEAD of the message, and the rebuilt body (stamped with its `created_at`)
    // lands in the mirror's stale branch, where the watermark would otherwise stay NULL.
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
    // src/modules/chatwoot/mirror.ts writes `contactInboxId` on an unversioned event, so a
    // webhook during the REST reads can move the conversation to another graph thread; the fence must
    // ask about the NEW one. The move happens inside the anchored read, and the claim sits on the new
    // thread with this process's registry emptied: a live turn on another replica.
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
    // `processChatwootDelivery` catches its own turn failure and settles the row, which is right
    // for a live delivery but not for a recovery, which exists to ANSWER. The attempt stays SPENT
    // (the claim stamped it): the budget bounds the retrying, or it would run to the age ceiling.
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
    // NOTE: no closing line: the operator's page stays open. Keyed by the mirror's ROW id, which the
    // writer files against; the Chatwoot number would match nothing and pass vacuously.
    expect(await deliveryLines(conv.id)).toEqual([]);
  });

  test("a BURST stranded together is answered once, and the older row stays on the page", async () => {
    // One process death can strand two messages, two DEAD rows. The newest row's recovery sends
    // ONE reply; the older row stays DEAD with no attempt spent and its page open. The older TEXT is
    // not read (a direct turn carries only its own trigger), a bound of the delivery path: gathering a
    // burst is the flush's job, not reimplemented here.
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
    // A message sent after the freshness read can be delivered while this turn builds;
    // `shouldPost` then stands down, which a recovery cannot lean on because that delivery may have
    // finished before the stranded text was ingested. The newer message appears only on the SECOND
    // unanchored read (`shouldPost`'s), or the earlier freshness check would refuse instead.
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

    // NOTE: the turn really reached `shouldPost` (two unanchored reads), or the refusal proves nothing
    // about the turn.
    expect(stub.asked.filter(([, before]) => before === undefined).length).toBe(
      2,
    );
    expect(stub.sent).toEqual([]);
    expect(await ledger(rowId)).toEqual({ status: "DEAD", attempts: 1 });
    expect(await deliveryLines(conv.id)).toEqual([]);
  });

  test("the rebuilt BODY carries the moved contact inbox, not the one loaded", async () => {
    // The fence and the body come from the same reading: the body's mirror write assigns
    // `contactInboxId` on an unversioned event, so a body with the pre-read pairing would put it BACK
    // and the turn would run on an unfenced thread. Nobody holds the new thread, so it runs through.
    const convId = 8961;
    const messageId = 9462;
    // Behind the message, so the rebuilt body reaches the branch that ASSIGNS the pairing; the
    // stale branch writes no `contactInboxId`, and the assertion would hold vacuously.
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
    // The route id stays the same; what moves is the AGENT the inbox points at, and with it the
    // persona's bot. Handing the path the old bot while it resolves the new one makes the ownership
    // gate read the new bot as another party and consume the message. Asserted on the closing line's
    // agent and on the reply going out.
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
    // A follow-up NUDGE needs no customer message and can start between the fence and
    // `runAgentTurn`'s own claim; `followUpHandler` reads the CONVERSATION key, so holding it from the
    // fence to the handoff makes it reschedule. Observed at `deps.makeClient`, which the path calls
    // BEFORE the turn.
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

    // NOTE: [0] is the recovery's own build, before the hold. [1] is the path's, inside the hold and
    // before the turn: the one that is `false` without the mark. [2] is inside the turn, `true` either
    // way, so asserting "some of them" would prove nothing.
    expect(held).toEqual([false, true, true]);
    // Balanced: a mark left behind would make every reader defer on this conversation forever.
    expect(isTurnInFlight(threadOf(convId))).toBe(false);
  });

  test("a message with NO created_at is a degraded read, not a message to replay", async () => {
    // The body's `last_activity_at` is the REST `created_at`, which keeps `lastInboundAt` (the
    // follow-up gate and 24h window anchor) on the customer's clock. The mirror APPLIES an undated
    // event (nothing to order it by) and moves the watermark to now, so the guard sits here.
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
    // NOTE: the attempt is not spent: a degraded read is the account's, and the next may answer.
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
    // The live snapshot is read FIRST, so the body states the MIRROR ROW, not the snapshot;
    // `shouldBotHandle` reads status off the body with no fallback. Status isolates this (the assignee
    // falls back to the mirror, so it would pass either way). The resolve's version is AHEAD of the
    // snapshot, as its webhook's would be, or the reconcile drops it as stale. Which reading of the
    // row (`mirrorNow` or `reconciled.state`) has no seam to test; only "not the snapshot" is pinned.
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
    // NOTE: no turn was built: a reply after the operator's resolve would reopen the conversation in
    // Chatwoot over a message they already dealt with.
    expect(turns.built).toBe(0);
  });

  test("a route the mirror never learned reaches the GATES, not just the turn", async () => {
    // `runAgentTurn` resolves the agent from the EVENT's inbox, but `maybeConsumeCommandOrGate`
    // reads `Conversation.inboxId`; with it null, no gate runs (test mode, availability, contact auth)
    // while the turn does, so an unactivated TEST agent would answer a customer. The event is STALE
    // on purpose: the mirror writes that column only when an event wins the ordering.
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
    // NOTE: and the mirror learned its route, which is what let the gate find the agent: repaired
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
    // Carrying the live `meta.sender` looks right (`authorizeContact` fails closed on the STORED
    // identity), but the body's clock is the stranded message's; with the contact positioned at that
    // same second and the live phone different, the mirror's tie rule drops BOTH readings and the
    // contact reads `no_identity`. Why: src/modules/chatwoot/recover-payload.ts, `RecoveryConversation`.
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
    // The customer changed number AFTER that burst, so the live read disagrees with the stored
    // value at the same position: the one shape that empties the field.
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
    // The gate let this through and the human arrived while the model worked; the runtime's
    // ownership re-check withholds the reply as `taken-over`. That is a CLOSE (`consumed_late`): the
    // human will answer, and a DEAD row would page an operator about it.
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
    // AWAITED from the model's own `invoke`. `makeModel` is synchronous, so a write there races
    // the re-check; the context reads (`listLabels`...) are CACHED per instance and never fire in a
    // full-suite run. Proxied through `bindTools`, whose returned object would drop a bare patch.
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
    // `blocked` (a guardrail with `action: "silent"`) differs from `empty` by WHO decided: the
    // operator's policy, which a rerun reproduces, so it closes the loss. Driven through the real
    // guardrail: its model comes from `deps.makeModel`, and `deepseek` asks for a PROSE verdict, so
    // a fake answering `{"violated": true}` is a real trip.
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
    // A resolvable credential, because a guardrail whose key does not resolve FAILS OPEN by
    // design (`credential_not_found`); without it this measures the fail-open path.
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
    // `/reset` refuses while anyone is mid-write, asking `threadBusyForResetOn` about the GRAPH
    // key and the durable claim, not the CONVERSATION key. The recovery must hold the graph key too,
    // or a reset between the mark and `runAgentTurn`'s claim clears memory the turn then restores; the
    // window spans network calls. Asked from the path's client build, as in the test above.
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

    // NOTE: [0] is the recovery's own build, BEFORE the hold, where a reset may run. [1] is inside
    // the hold and before the turn: `false` without the graph key held. [2] is inside the turn.
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
    // `empty` (every gate ran, nothing delivered) settles a LIVE delivery, but a recovery row
    // exists because the customer went unanswered, and closing it would drop the operator's only
    // record. Like a thrown turn and a withheld reply, this is why closes are ONE positive list: an
    // unknown outcome must not close a loss by default.
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
    // The snapshot is read FIRST and applied after the two message reads; a handoff committed
    // between them must not be overwritten by it, since the reconcile's fallback compares
    // `last_activity_at`, which an assignee change never advances. Other `reconcileMirrorFromLive`
    // callers apply right after the GET. `onAnchoredRead` runs INSIDE that stretch.
    const convId = 8993;
    const messageId = 9493;
    // `lastEventAt` BEHIND the live snapshot, the ordinary shape (the mirror never saw the
    // stranded message); with the mirror ahead the reconcile refuses on activity alone.
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
    // A message payload never writes the assignee (`assigneeOrdered` requires
    // `fromConversationEvent`, src/modules/chatwoot/state-order.ts), so the mirror stays human-owned
    // while the rebuilt payload STATES the pre-handoff trio; the gate must not prefer that statement.
    // The runtime's re-check runs AFTER the model and its tools (src/graph/runtime.ts), hence
    // `turns.built`. Fired inside the fence's query; status stays `pending` so only the assignee refuses.
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
                    // NOTE: stamped ahead of the message, as the handoff webhook would be.
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
    // NOTE: the gate closed BEFORE the model was built; `sent` alone would pass on a turn that ran,
    // called tools, and was silenced on the way out.
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
    // Every payload the path gates on is a snapshot of an earlier instant, so a resolve between
    // the last read and the gate must win. The rule is the gate's: status follows whoever WON the
    // ordering (`mirror.applied` is false when the mirror refused the payload's write). Fired from
    // the FENCE's query, stamped ahead of the message so the mirror really refuses.
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
    // The fence's durable read is the eighth scoped transaction of the pass.
    const FENCE_QUERY = 8;
    let n = 0;
    let fired = false;
    // The resolve is AWAITED before the fence's transaction opens: a write racing the read it
    // must precede lands after it about half the time, and the test would pass measuring nothing.
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
    // The mirror writes `Conversation.inboxId` null for any event that named no inbox, and the
    // delivery that would have taught it is the one that died. Built from that row, the body has no
    // `inbox_id`, `runAgentTurn` skips, and the row would close unanswered. Every REST message carries
    // `inbox_id` (the fork's `_message.json.jbuilder`), so the rebuild takes it from there.
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
    // The other half of the same read, costing a wrong ANSWER. A route resolved from a mirror
    // that holds none leaves `agentBotId` null, `heldByAnotherParty` cannot compare ids, and the
    // ownership gate goes LOOSE over a bot that owns the conversation.
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
    // The fallback reading: a message JSON with no `inbox_id` is still recoverable while the
    // mirror knows the route. The live message wins where they disagree, because it is the field
    // `Message#webhook_data` builds the wire's `inbox` from.
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
    // NOTE: it names the agent whose route the message arrived on: the operator filters the Logs page
    // BY agent, so an unattributed row is one they never see.
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
    // The recovery does not re-implement the gates, it re-runs the delivery path so they run
    // where they already run. "recovered" says the path ran, never that it spoke.
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
    // NOTE: no turn was built. The turn's re-check would catch it only after spending the model, and
    // it is all that is left when the recovery resolves no bot identity (the gate goes LOOSE).
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
    // The conversation key is a Map lookup with no row (src/graph/inflight.ts); the GRAPH key
    // has a durable row, and a follow-up NUDGE claims it while posting here. ANOTHER replica is built
    // by taking the real claim and emptying THIS process's Map; the Map is put back before release so
    // the count it decrements is the one the claim took.
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
    // `redirect_origin_display_id` is rendered by the fork's EventDataPresenter only, not the
    // REST conversation show, so the mirror is its one source; a body that STATES no pairing CLEARS
    // one on a row that already knew it.
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
    // The pairing is read BEFORE two REST reads and a reconcile, and the mirror write happens
    // after. A widget re-entry in that window writes a NEW versioned pairing; replaying the old one
    // restores the previous episode, retires the current ladder, and messages the wrong sibling.
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
    // The re-entry lands after the pairing was read and before the rebuilt body reaches the
    // mirror, versioned as its webhook is. ONCE: the path builds its own client later, and firing
    // again would re-apply it AFTER the mirror write and hide the regression.
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

    // The mirror rejects the old versioned pairing whatever the body carried, so the line above
    // proves nothing alone. `armRedirectChatFollowUp` UPSERTS off the event with no version, so a body
    // still carrying 991 shows here. Keyed by THIS widget thread: every recovery here arms a ladder.
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
    // `receivedAt` is when THIS application inserted the row, not when the customer wrote; a
    // webhook delayed by a retry or outage inserts late, so a check on the row alone would pass a
    // message past the ceiling, whose free-form reply then crosses the WhatsApp window.
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
    // `inboundMessageId` is written for inbound messages only, so a rebuild that is anything
    // else (a missing `message_type` normalizes to "other") is a degraded REST read. Handed to the
    // path, no turn runs and the row would close with the customer still waiting.
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
    // A throw escaping `processChatwootDelivery` after the claim would leave the row on
    // PROCESSING, waiting for the sweep again, time it may not have against the age ceiling. Not
    // reachable behaviourally: the path catches its turn, media pass, mirror write and client build;
    // only a scoped query failing (pool timeout, deadlock) escapes. Asserted on the source, as
    // tests/modules/delivery-sweep.test.ts does for its unreachable branch.
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
    // The mark keeps the fence's answer true; any await BETWEEN them is a window neither covers,
    // where a follow-up nudge can start unseen. Structural, because what is asserted IS the absence
    // of a suspension point, and a behavioural test would have to inject the await it forbids.
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

    // The local keys are asked AFTER the durable read too: a turn starting during
    // `turnOwnsThread`'s row read marks the Map unseen. The GRAPH key is covered by that call itself,
    // so the one at risk is the CONVERSATION key, the one the mark takes and `followUpHandler` reads.
    const durable = src.indexOf("await turnOwnsThread(");
    expect(durable).toBeGreaterThan(-1);
    expect(durable).toBeLessThan(mark);
    expect(src.slice(durable, mark)).toContain("isTurnInFlight(handoffKey)");
  });

  test("the pairing the body carries and the pairing the fence asks about are one reading", async () => {
    // The body and the fence's graph key come from ONE mirror reading, which stays one only
    // while no await sits between it and the fence: src/modules/chatwoot/mirror.ts writes
    // `contactInboxId` on an unversioned event, so a webhook there splits them. Structural, as above.
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
    // `{ kind: "error" }` from `onDirectTurn` costs a SECOND TURN (answered twice, tools rerun).
    // The direct-turn block also wraps the bookkeeping after the turn, so reported from the enclosing
    // catch, "the turn ANSWERED and a later write failed" would read as a failure. Those writes
    // swallow their own errors, which is not a contract. Structural: the PATH must not exist.
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
    // The compensating write both failure roads take, against the real table. Three answers, and
    // the caller acts differently on each.
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

  // The identity fence (no Chatwoot bot for the route's agent) protects a REPLY: the persona's token
  // and the ownership comparison. A transcription replay posts none and owes only an enqueue, so
  // refusing it would keep the words out of a human-owned conversation's only memory.
  test("a transcription replay needs no bot identity", async () => {
    const convId = 8898;
    const messageId = 9498;
    const ORPHAN_INBOX = 76;
    // An inbox that NAMES an agent with no bot row: the console's "missing" state, the one the
    // fence exists for.
    const orphanAgent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Sem persona",
        systemPrompt: "…",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        enabled: true,
        mode: "production",
        settings: {},
      },
      select: { id: true },
    });
    const orphanInbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: ORPHAN_INBOX,
        name: "Sem persona",
        agentId: orphanAgent.id,
      },
      select: { id: true },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "open",
        assigneeType: "User",
        assigneeId: 9,
        inboxId: orphanInbox.id,
        threadId: threadOf(convId),
        lastEventAt: new Date((SENT_AT - 600) * 1000),
        contactInboxId: 71_000 + convId,
      },
      select: { id: true },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      event: "message_updated",
      receivedAgoMs: 20 * 60 * 1000,
    });
    const stub = stubChatwoot({
      conv: { status: "open", assigneeType: "User", assigneeId: 9 },
      page: audioPageWith(
        [{ id: messageId, transcript: "quero trocar a data" }],
        ORPHAN_INBOX,
      ),
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
    const armed = await suDb.schedulerJob.findMany({
      where: { tenantId, kind: "INGEST_MESSAGE" },
      select: { payload: true },
    });
    expect(
      armed.filter((j) => JSON.stringify(j.payload).includes(String(messageId)))
        .length,
    ).toBeGreaterThan(0);
  });

  // A memory-only replay reports no turn, so the settlement checks in `runRecovery` pass it by
  // construction, which is wrong when nothing REMEMBERED it either. An inbox unbound, switched off or
  // put in test mode before the recovery reaches no ingestion branch and still comes back
  // `"processed"`; closed, the words would be in nobody's memory and off the worklist.
  test("a transcription replay that nothing ingested is not closed", async () => {
    const convId = 8895;
    const messageId = 9495;
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "open",
        assigneeType: "User",
        assigneeId: 9,
        inboxId: inboxDbId,
        threadId: threadOf(convId),
        lastEventAt: new Date((SENT_AT - 600) * 1000),
        contactInboxId: 71_000 + convId,
      },
      select: { id: true },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      event: "message_updated",
      routeAgentBotId: AGENT_BOT_ID,
      receivedAgoMs: 20 * 60 * 1000,
    });
    const stub = stubChatwoot({
      conv: { status: "open", assigneeType: "User", assigneeId: 9 },
      page: audioPageWith([{ id: messageId, transcript: "e a minha troca?" }]),
    });
    // Switched off between the strand and the replay: its route ingests nothing, and nothing else
    // on this inbox will.
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { enabled: false },
    });
    try {
      expect(
        await recoverStrandedDelivery({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          deps: depsWith(stub),
        }),
      ).toBe("unreachable");
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { enabled: true },
      });
    }
    // Back on the worklist, so the next attempt can find the inbox switched on again.
    expect((await ledger(rowId)).status).toBe("DEAD");
    expect(stub.sent).toEqual([]);
  });

  // The other half: past the identity fence is right where a PERSON holds the conversation, wrong
  // where an AGENT BOT does. The id is the left side of the ownership comparison; null, another bot's
  // conversation reads as ours and the path skips the ingestion while the row settles. Named from the
  // LEDGER's route where it can be, refused where it cannot.
  test("a transcription replay is refused when a bot it cannot name holds the conversation", async () => {
    const convId = 8896;
    const messageId = 9496;
    const ORPHAN_INBOX_2 = 77;
    const orphanAgent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Sem persona 2",
        systemPrompt: "…",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        enabled: true,
        mode: "production",
        settings: {},
      },
      select: { id: true },
    });
    const orphanInbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: ORPHAN_INBOX_2,
        name: "Sem persona 2",
        agentId: orphanAgent.id,
      },
      select: { id: true },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "pending",
        // Another AgentBot holds it, and no persona of ours names a bot id to compare against.
        assigneeType: "AgentBot",
        assigneeId: 999,
        assigneeName: "outro-bot",
        inboxId: orphanInbox.id,
        threadId: threadOf(convId),
        lastEventAt: new Date((SENT_AT - 600) * 1000),
        contactInboxId: 71_000 + convId,
      },
      select: { id: true },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      event: "message_updated",
      receivedAgoMs: 20 * 60 * 1000,
    });
    const stub = stubChatwoot({
      conv: { status: "pending", assigneeType: "AgentBot", assigneeId: 999 },
      page: audioPageWith(
        [{ id: messageId, transcript: "quero trocar a data" }],
        ORPHAN_INBOX_2,
      ),
    });

    // NOTE: refused, and the row stays DEAD on the worklist rather than closing on a recovery that
    // remembered nothing.
    expect(
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    ).toBe("unrecoverable");
    expect((await ledger(rowId)).status).toBe("DEAD");
    expect(stub.sent).toEqual([]);
  });

  // The command fence is about a command the ORIGINAL delivery already executed, and the live path
  // reads a command off a message's creation alone. Asked of a transcription replay, it would fire on
  // a voice note reading as `/reset` and drop the append it was recovering.
  test("a transcription replay is not refused for looking like a command", async () => {
    const convId = 8897;
    const messageId = 9497;
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "open",
        assigneeType: "User",
        assigneeId: 9,
        inboxId: inboxDbId,
        threadId: threadOf(convId),
        lastEventAt: new Date((SENT_AT - 600) * 1000),
        contactInboxId: 71_000 + convId,
      },
      select: { id: true },
    });
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
      event: "message_updated",
      routeAgentBotId: AGENT_BOT_ID,
      receivedAgoMs: 20 * 60 * 1000,
    });
    const stub = stubChatwoot({
      conv: { status: "open", assigneeType: "User", assigneeId: 9 },
      page: audioPageWith([
        { id: messageId, transcript: "reset", content: "/reset" },
      ]),
    });

    const outcome = await asTestModeAgent(() =>
      recoverStrandedDelivery({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        deps: depsWith(stub),
      }),
    );

    // NOTE: the OUTCOME is the assertion, not an append: a command is ACTIVE only for a test-mode
    // agent, whose route does not ingest continuously. It shows the replay reaching the delivery path,
    // where the gates that decide the append live.
    expect(outcome).not.toBe("unrecoverable");
    expect(stub.sent).toEqual([]);
  });

  test("a control command is never replayed, where one is ACTIVE", async () => {
    // A DEAD row means the path did not complete, not that it did nothing: `/reset` deletes
    // BEFORE the row settles, so a replay would delete memory accumulated since. Its author is an
    // operator who can retype it.
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
    // Whether a command exists is the agent's MODE (`commandMode === "test"` in
    // src/modules/chatwoot/webhook.ts). At a production agent `/reset` is customer text the path
    // answers, so refusing it here would LOSE a reply the delivery path would give.
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

  // The delivery path tells the arm the message is a reaction, so the flush knows to ask the catch-up
  // read for what the page leaves out.
  test("with debounce on, a reaction arms the burst with the reaction mark", async () => {
    const convId = 8747;
    const messageId = 9747;
    await seedConversation(convId);
    const rowId = await seedDeadDelivery({
      conversationId: convId,
      inboundMessageId: messageId,
    });
    const reaction = {
      payload: [
        {
          ...(pageWith([{ id: messageId, content: "👍" }]).payload[0] ?? {}),
          content_attributes: { is_reaction: true },
        },
      ],
    };
    const stub = stubChatwoot({ page: reaction });

    await suDb.agent.update({
      where: { id: agentDbId },
      data: { settings: { debounce: { enabled: true, windowSeconds: 15 } } },
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
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { settings: { debounce: { enabled: false } } },
      });
    }
    const job = await suDb.schedulerJob.findFirst({
      where: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: `debounce:${threadOf(convId)}`,
      },
      select: { payload: true },
    });
    expect(
      (job?.payload as { reactionArmed?: boolean } | undefined)?.reactionArmed,
    ).toBe(true);
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
    function jobFor(payload: Record<string, unknown>): ClaimedJob {
      return {
        id: phantomJobId,
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

    // THE LOSS IS DECIDED WHERE THE RECOVERY ENDS. The sweep's line for an armed row is `info`, so a
    // recovery that ends with the row still DEAD writes the one `error` that says nobody answered,
    // once: the same job run again finds that line and writes nothing.
    test("a recovery that ends with the row still DEAD says the message went unanswered, once", async () => {
      const convId = 18931;
      await seedConversation(convId);
      const rowId = await seedDeadDelivery({
        conversationId: convId,
        inboundMessageId: 19441,
        attempts: MAX_RECOVERY_ATTEMPTS,
      });
      const { deliveryId } =
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: rowId },
          select: { deliveryId: true },
        });
      const handler = getJobHandler("DELIVERY_RECOVERY");
      if (!handler) throw new Error("the recovery handler is not registered");
      for (let run = 0; run < 2; run++) {
        const result = await handler(
          jobFor({ deliveryRowId: String(rowId) }),
          appDb,
        );
        expect(result.outcome).toBe("done");
      }
      // flowlog-scope: tenant-wide. The line has no turn of its own to read by; it names its delivery,
      // whose id is this test's alone, and the subject is how many lines that delivery got.
      const lines = await flowLogRows(suDb, {
        where: {
          tenantId,
          stage: "delivery",
          detail: { path: ["deliveryId"], equals: deliveryId },
        },
        select: {
          level: true,
          detail: true,
          errorMessage: true,
          conversationId: true,
        },
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.level).toBe("error");
      expect(
        (lines[0]?.detail as Record<string, unknown> | undefined)?.outcome,
      ).toBe("unanswered");
      expect(lines[0]?.errorMessage).toContain("unanswered");
      expect(lines[0]?.conversationId).not.toBeNull();
    });

    test("a recovery that is still coming, or a row someone else took, writes no unanswered line", async () => {
      const convId = 18932;
      await seedConversation(convId);
      const rowId = await seedDeadDelivery({
        conversationId: convId,
        inboundMessageId: 9442,
      });
      const { deliveryId } =
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: rowId },
          select: { deliveryId: true },
        });
      const handler = getJobHandler("DELIVERY_RECOVERY");
      if (!handler) throw new Error("the recovery handler is not registered");
      // Busy: rescheduled, the loss is not decided.
      markTurnInFlight(threadOf(convId));
      try {
        await handler(jobFor({ deliveryRowId: String(rowId) }), appDb);
      } finally {
        clearTurnInFlight(threadOf(convId));
      }
      // Taken by something else: no longer DEAD.
      await suDb.chatwootWebhookDelivery.update({
        where: { id: rowId },
        data: { status: "PROCESSED" },
      });
      await handler(jobFor({ deliveryRowId: String(rowId) }), appDb);
      // flowlog-scope: tenant-wide. The line has no turn of its own to read by; it names its delivery,
      // whose id is this test's alone, and the subject is how many lines that delivery got.
      const lines = await flowLogRows(suDb, {
        where: {
          tenantId,
          stage: "delivery",
          detail: { path: ["deliveryId"], equals: deliveryId },
        },
        select: { id: true },
      });
      expect(lines).toEqual([]);
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

    test("its death is announced by the scheduler, at error, since nothing else said the message was lost", () => {
      // No hook of its own: `dispatchDeadLetter` announces every kind, and its generic line already
      // carries the delivery row id — the dedupe key IS it. What a hook here would lose is the
      // re-arm suppression that path does, and the level living next to the other twelve answers.
      //
      // `error` because the sweep's line for a row with a recovery armed is `info`: a job that dies
      // never reached the line its ending would have written, and the customer is still unanswered.
      expect(deliveryRecoveryDedupeKey(987_654n)).toBe(
        "delivery-recovery:987654",
      );
      expect(JOB_DEATH_LEVEL.DELIVERY_RECOVERY).toBe("error");
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
