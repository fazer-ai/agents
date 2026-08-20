import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId, contactInboxThreadId } from "@/graph/checkpointer";
import { CONVERSATION_DIVIDER } from "@/graph/markers";
import { runAgentTurn } from "@/graph/runtime";
import { followUpDedupeKey } from "@/modules/channel-redirect/followup";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

// The other half of the compaction tests, and the half that would otherwise be missing entirely:
// `tests/modules/memory-compaction.test.ts` drives `runCompaction` directly, so every one of its
// cases passes with the ARMING dead. Nothing there notices if the webhook condition never fires, and
// a feature that is never armed is a feature that does nothing while its suite stays green.
//
// So this drives the real receiver (`processChatwootDelivery`, no seam for the arm) with the payload
// Chatwoot actually sends on a resolve, and looks for the job row.

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

const INBOX_ID = 61;
const CONTACT_INBOX_ID = 61_000;
let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let deliverySeq = 0;

// Everything outbound lands on a double: this suite is about a DB row appearing, and a real fetch
// would only add flakiness.
const realFetch = globalThis.fetch;

describe.skipIf(!dbUp)("memory compaction: arming from the webhook", () => {
  beforeAll(async () => {
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const t = await suDb.tenant.create({
      data: { name: "MCA", slug: `mca-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 12,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        settings: { debounce: { enabled: false } },
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `mca-route-${process.pid}`,
        name: "Atendente",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_ID,
        name: "Suporte",
        agentId,
      },
    });
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!dbUp) return;
    for (const table of [
      "scheduler_jobs",
      "chatwoot_webhook_deliveries",
      "conversations",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
      "chatwoot_instances",
    ]) {
      await suDb
        .$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = ${tenantId}`)
        .catch(() => {});
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  function convPayload(convId: number, status: string, updatedAt: number) {
    return {
      id: convId,
      inbox_id: INBOX_ID,
      status,
      contact_inbox: { id: CONTACT_INBOX_ID + convId },
      meta: { assignee_type: null, assignee: null },
      channel: "Channel::Api",
      last_activity_at: Math.floor(Date.now() / 1000),
      updated_at: updatedAt,
    };
  }

  // NOTE: A conversation_* event carries the conversation's fields at the ROOT of the payload, not
  // nested under `conversation` the way a message event does (see normalize.ts).
  async function deliver(event: string, conversation: Record<string, unknown>) {
    deliverySeq += 1;
    const n = normalizeChatwootEvent({ event, ...conversation });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `mca-${process.pid}-${deliverySeq}`,
        event,
        status: "PENDING",
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: 9,
      normalized: n,
      base: appDb,
    });
  }

  // Same driver, with the caller's own client — so a test can inject a failing query.
  async function deliverWith(
    client: PrismaClient,
    event: string,
    conversation: Record<string, unknown>,
  ) {
    deliverySeq += 1;
    const n = normalizeChatwootEvent({ event, ...conversation });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `mca-${process.pid}-${deliverySeq}`,
        event,
        status: "PENDING",
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: 9,
      normalized: n,
      base: client,
    });
  }

  function jobFor(convId: number) {
    return suDb.schedulerJob.findFirst({
      where: {
        tenantId,
        kind: "MEMORY_COMPACT",
        dedupeKey: contactInboxThreadId(
          tenantId,
          instanceId,
          CONTACT_INBOX_ID + convId,
        ),
      },
    });
  }

  // NOTE: A strictly increasing stamp, NOT the wall clock. The mirror orders writes by the
  // conversation's own `updated_at`, and two rounds landing inside the same second would make the
  // second one look stale — the mirror would drop it, no transition would be seen, and the test
  // would fail for a reason that has nothing to do with what it is testing.
  let stamp = Math.floor(Date.now() / 1000);
  async function resolve(convId: number) {
    stamp += 1;
    await deliver(
      "conversation_updated",
      convPayload(convId, "pending", stamp),
    );
    stamp += 1;
    await deliver(
      "conversation_status_changed",
      convPayload(convId, "resolved", stamp),
    );
  }

  test("a conversation transitioning to resolved arms the compaction job", async () => {
    const convId = 401;
    await resolve(convId);

    const job = await jobFor(convId);
    expect(job).not.toBeNull();
    expect(job?.status).toBe("PENDING");
    const payload = job?.payload as Record<string, unknown>;
    expect(payload.reason).toBe("resolved");
    expect(payload.conversationId).toBe(convId);
    expect(payload.contactInboxId).toBe(CONTACT_INBOX_ID + convId);
    expect(payload.agentId).toBe(String(agentId));
    // The grace window: a resolve can be undone, so the job must not be due immediately.
    expect(job?.runAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  // A conversation_* payload can arrive WITHOUT contact_inbox — the mirror handles that shape on
  // purpose, keeping the stored id rather than nulling it. Reading only the event would skip the arm,
  // and nothing comes back for it: a customer returning on the same conversation crosses no new
  // attendance boundary, so that history stays raw indefinitely.
  test("a resolve whose payload omits contact_inbox still arms, from the mirror", async () => {
    const convId = 412;
    // First a complete event, so the mirror knows the contact-inbox for this conversation.
    stamp += 1;
    await deliver(
      "conversation_updated",
      convPayload(convId, "pending", stamp),
    );
    expect(await jobFor(convId)).toBeNull();

    // Then the resolve, sparse: same conversation, no contact_inbox.
    stamp += 1;
    const { contact_inbox: _omitted, ...sparse } = convPayload(
      convId,
      "resolved",
      stamp,
    );
    await deliver("conversation_status_changed", sparse);

    const job = await jobFor(convId);
    expect(job).not.toBeNull();
    const jobPayload = (job?.payload ?? {}) as Record<string, unknown>;
    expect(jobPayload.reason).toBe("resolved");
    expect(jobPayload.contactInboxId).toBe(CONTACT_INBOX_ID + convId);
  });

  // Same shape one level up. The gate used to require `inbox_id` ON THE EVENT before it would even
  // consult the mirror, so a resolve payload missing BOTH ids was dropped whole — including the
  // fallback written for the contact-inbox right below it. Nothing re-arms it: the customer
  // returning on the same conversation crosses no attendance boundary, so that history stays raw on
  // exactly the trigger that exists to make the return turn cheap.
  test("a resolve whose payload omits inbox_id still arms, from the mirror", async () => {
    const convId = 418;
    stamp += 1;
    await deliver(
      "conversation_updated",
      convPayload(convId, "pending", stamp),
    );
    expect(await jobFor(convId)).toBeNull();

    stamp += 1;
    const {
      inbox_id: _noInbox,
      contact_inbox: _noContactInbox,
      ...sparse
    } = convPayload(convId, "resolved", stamp);
    await deliver("conversation_status_changed", sparse);

    const job = await jobFor(convId);
    expect(job).not.toBeNull();
    const payload = (job?.payload ?? {}) as Record<string, unknown>;
    expect(payload.reason).toBe("resolved");
    expect(payload.contactInboxId).toBe(CONTACT_INBOX_ID + convId);
  });

  // Consulting the mirror WIDENED this block's domain: it now runs for payloads that carry no inbox
  // at all, and `redirectCfg.widgetInboxId === n.inboxId` would read null === null as a match. That
  // branch was unreachable while the block required the event's inbox, so an agent with the redirect
  // switched on but no widget inbox picked yet would have started calling off follow-ups and posting
  // closing messages on a conversation that has nothing to do with the redirect.
  test("a sparse resolve never wakes the redirect on a half-configured agent", async () => {
    const convId = 419;
    const dedupe = followUpDedupeKey(
      chatwootThreadId(tenantId, instanceId, convId),
    );
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          debounce: { enabled: false },
          // Switched on, widget inbox not picked yet — the reader keeps the two independent.
          channelRedirect: { enabled: true, widgetInboxId: null },
        },
      },
    });
    try {
      stamp += 1;
      await deliver(
        "conversation_updated",
        convPayload(convId, "pending", stamp),
      );
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "REDIRECT_FOLLOWUP",
          dedupeKey: dedupe,
          status: "PENDING",
          runAt: new Date(Date.now() + 60_000),
        },
      });

      stamp += 1;
      const { inbox_id: _noInbox, ...sparse } = convPayload(
        convId,
        "resolved",
        stamp,
      );
      await deliver("conversation_status_changed", sparse);

      // Compaction armed, which is the whole point of consulting the mirror.
      expect(await jobFor(convId)).not.toBeNull();
      // The redirect did NOT run: its follow-up is untouched.
      const followUp = await suDb.schedulerJob.findFirst({
        where: { tenantId, kind: "REDIRECT_FOLLOWUP", dedupeKey: dedupe },
        select: { status: true },
      });
      expect(followUp?.status).toBe("PENDING");
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { debounce: { enabled: false } } },
      });
    }
  });

  // The resolve transition drives TWO independent features: arming compaction, and the channel
  // redirect's closing sequence. Sharing one try/catch let a transient failure in the first skip the
  // second — and the delivery is still marked processed, so the closing never comes back.
  test("a failure arming compaction does not swallow the redirect closing", async () => {
    const convId = 415;
    const dedupe = followUpDedupeKey(
      chatwootThreadId(tenantId, instanceId, convId),
    );
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          debounce: { enabled: false },
          channelRedirect: { enabled: true, widgetInboxId: INBOX_ID },
        },
      },
    });
    try {
      stamp += 1;
      await deliver(
        "conversation_updated",
        convPayload(convId, "pending", stamp),
      );
      // The redirect follow-up the resolve is supposed to call off.
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "REDIRECT_FOLLOWUP",
          dedupeKey: dedupe,
          status: "PENDING",
          runAt: new Date(Date.now() + 60_000),
        },
      });

      // The mirror lookup the sparse payload forces compaction through, made to fail.
      const failing = appDb.$extends({
        query: {
          conversation: {
            findUnique({ args, query }) {
              if (
                (args.select as { contactInboxId?: boolean } | undefined)
                  ?.contactInboxId
              ) {
                throw new Error("injected: mirror lookup unavailable");
              }
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;

      stamp += 1;
      const { contact_inbox: _omitted, ...sparse } = convPayload(
        convId,
        "resolved",
        stamp,
      );
      await deliverWith(failing, "conversation_status_changed", sparse);

      // Compaction did not arm — that is the failure being injected.
      expect(await jobFor(convId)).toBeNull();
      // The redirect follow-up was called off anyway.
      const followUp = await suDb.schedulerJob.findFirst({
        where: { tenantId, kind: "REDIRECT_FOLLOWUP", dedupeKey: dedupe },
        select: { status: true },
      });
      expect(followUp?.status).toBe("DONE");
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { debounce: { enabled: false } } },
      });
    }
  });

  test("a re-delivered resolve does not stack a second job", async () => {
    const convId = 402;
    await resolve(convId);
    await resolve(convId);

    const jobs = await suDb.schedulerJob.count({
      where: {
        tenantId,
        kind: "MEMORY_COMPACT",
        dedupeKey: contactInboxThreadId(
          tenantId,
          instanceId,
          CONTACT_INBOX_ID + convId,
        ),
      },
    });
    expect(jobs).toBe(1);
  });

  // The OTHER arm: a new attendance opening on the thread. What matters is not WHEN it is armed but
  // that the boundary the job looks for is already durable when the job exists — otherwise the
  // scheduler can claim a due-now job, find nothing, and retire it as a no-op, and that attendance
  // is never compacted. The divider is written as its own message inside the claim, so the property
  // holds from the moment the job is enqueued.
  test("the boundary is already in the thread by the time the job exists", async () => {
    const contactInboxId = 62_500;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    const checkpointer = new MemorySaver();
    const sent: number[] = [];
    const client = {
      sendMessage: async (conversationId: number) => {
        sent.push(conversationId);
        return {};
      },
      toggleTyping: async () => ({}),
      getMessages: async () => [],
    } as unknown as ChatwootClient;

    // Sampled from INSIDE the model call, which is the earliest point a job could be claimed by the
    // scheduler running in this same process: whatever it finds there, the boundary must already be
    // findable. `throwOnce` forces the exit where the turn never produces a reply at all.
    let jobsAtModelTime = -1;
    let dividerAtModelTime = false;
    let throwOnce = false;
    const sample = async () => {
      jobsAtModelTime = await suDb.schedulerJob.count({
        where: { tenantId, kind: "MEMORY_COMPACT", dedupeKey: threadId },
      });
      const cp = await checkpointer.get({
        configurable: { thread_id: threadId },
      });
      const msgs = ((
        cp?.channel_values as { messages?: { content: unknown }[] } | undefined
      )?.messages ?? []) as { content: unknown }[];
      dividerAtModelTime = msgs.some((m) =>
        String(m.content).startsWith(CONVERSATION_DIVIDER),
      );
      if (throwOnce) throw new Error("provider exploded");
      return new AIMessage("Claro!");
    };
    const model = {
      invoke: sample,
      bindTools: (_t: unknown) => ({ invoke: sample }),
    };

    const turn = (convId: number, messageId: number) =>
      runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: 9,
        event: {
          event: "message_created",
          conversationId: convId,
          inboxId: INBOX_ID,
          status: "pending",
          assigneeType: null,
          assigneeId: null,
          assigneeName: null,
          contactInboxId,
          message: {
            id: messageId,
            content: "oi",
            messageType: "incoming",
            private: false,
          },
        } as NormalizedChatwootEvent,
        base: appDb,
        deps: {
          makeModel: () => model as unknown as BaseChatModel,
          makeClient: async () => client,
          checkpointer,
        },
      });

    for (const convId of [501, 502]) {
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: convId,
          contactInboxId,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:${convId}`,
          lastEventAt: new Date(),
        },
      });
    }
    // First attendance: no previous conversation on this thread, so no boundary and no arm.
    expect(await turn(501, 9001)).toBe("posted");
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, kind: "MEMORY_COMPACT", dedupeKey: threadId },
      }),
    ).toBe(0);

    // Second attendance on the same thread: the boundary is claimed, and by the time anything could
    // observe the job, the divider it looks for is already in the thread.
    expect(await turn(502, 9002)).toBe("posted");
    expect(jobsAtModelTime).toBe(1);
    expect(dividerAtModelTime).toBe(true);
    const job = await suDb.schedulerJob.findFirst({
      where: { tenantId, kind: "MEMORY_COMPACT", dedupeKey: threadId },
    });
    expect(job).not.toBeNull();
    const boundaryPayload = (job?.payload ?? {}) as Record<string, unknown>;
    expect(boundaryPayload.reason).toBe("new_attendance");
    expect(boundaryPayload.conversationId).toBe(501);

    // A third attendance whose turn never produces a reply: the boundary must survive anyway. It
    // used to advance the marker and depend on the invoke to write the divider, so a guardrail that
    // answered before the model — or a throw, as here — left an attendance nothing could ever find
    // the boundary of again.
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: 503,
        contactInboxId,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:503`,
        lastEventAt: new Date(),
      },
    });
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "MEMORY_COMPACT", dedupeKey: threadId },
    });
    throwOnce = true;
    await expect(turn(503, 9003)).rejects.toThrow();

    const cp = await checkpointer.get({
      configurable: { thread_id: threadId },
    });
    const messages = ((
      cp?.channel_values as { messages?: { content: unknown }[] } | undefined
    )?.messages ?? []) as { content: unknown }[];
    expect(
      messages.filter((m) => String(m.content).startsWith(CONVERSATION_DIVIDER))
        .length,
    ).toBe(2);
    const afterThrow = await suDb.schedulerJob.findFirst({
      where: { tenantId, kind: "MEMORY_COMPACT", dedupeKey: threadId },
    });
    expect(afterThrow).not.toBeNull();
    const afterThrowPayload = (afterThrow?.payload ?? {}) as Record<
      string,
      unknown
    >;
    expect(afterThrowPayload.conversationId).toBe(502);
  });

  // Two deliveries for the same new conversation can run at once — debounce off is the common setup,
  // and a burst is what a customer on WhatsApp actually sends. Both transactions read the marker
  // before either advances it, so without a lock both claim the boundary and both write a divider.
  // Compaction cuts at the LAST one, which would summarize away the first exchange of the attendance
  // that is still open: the agent forgets what the customer just said.
  test("two turns racing on the same new conversation write ONE divider", async () => {
    const contactInboxId = 63_500;
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    const checkpointer = new MemorySaver();
    const client = {
      sendMessage: async () => ({}),
      toggleTyping: async () => ({}),
      getMessages: async () => [],
    } as unknown as ChatwootClient;
    const model = {
      invoke: async () => new AIMessage("Claro!"),
      bindTools: (_t: unknown) => ({
        invoke: async () => new AIMessage("Claro!"),
      }),
    };
    const turn = (convId: number, messageId: number) =>
      runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: 9,
        event: {
          event: "message_created",
          conversationId: convId,
          inboxId: INBOX_ID,
          status: "pending",
          assigneeType: null,
          assigneeId: null,
          assigneeName: null,
          contactInboxId,
          message: {
            id: messageId,
            content: "oi",
            messageType: "incoming",
            private: false,
          },
        } as NormalizedChatwootEvent,
        base: appDb,
        deps: {
          makeModel: () => model as unknown as BaseChatModel,
          makeClient: async () => client,
          checkpointer,
        },
      });

    for (const convId of [601, 602]) {
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: convId,
          contactInboxId,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:${convId}`,
          lastEventAt: new Date(),
        },
      });
    }
    await turn(601, 9101);
    // Two deliveries of the NEW conversation, in flight together.
    await Promise.all([turn(602, 9102), turn(602, 9103)]);

    const cp = await checkpointer.get({
      configurable: { thread_id: threadId },
    });
    const messages = ((
      cp?.channel_values as { messages?: { content: unknown }[] } | undefined
    )?.messages ?? []) as { content: unknown }[];
    expect(
      messages.filter((m) => String(m.content).startsWith(CONVERSATION_DIVIDER))
        .length,
    ).toBe(1);
  });

  // The dedupeKey is the THREAD, so one row serves every attendance this contact will ever have.
  // `attempts` is what the scheduler retires a job on, and it does not reset on re-arm — so without
  // this, four transient failures spread over months make the NEXT attendance dead-letter on its
  // first failure, and that contact never compacts again.
  test("each attendance gets its own retry budget", async () => {
    const convId = 404;
    await resolve(convId);
    const key = contactInboxThreadId(
      tenantId,
      instanceId,
      CONTACT_INBOX_ID + convId,
    );
    await suDb.schedulerJob.updateMany({
      where: { tenantId, kind: "MEMORY_COMPACT", dedupeKey: key },
      data: { attempts: 4, status: "DEAD" },
    });

    await resolve(convId);

    const job = await suDb.schedulerJob.findFirst({
      where: { tenantId, kind: "MEMORY_COMPACT", dedupeKey: key },
    });
    expect(job?.attempts).toBe(0);
    expect(job?.status).toBe("PENDING");
  });

  test("an agent with compaction off arms nothing at all", async () => {
    const convId = 403;
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          debounce: { enabled: false },
          memory: { compaction: { enabled: false } },
        },
      },
    });
    try {
      await resolve(convId);
      expect(await jobFor(convId)).toBeNull();
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { debounce: { enabled: false } } },
      });
    }
  });
});
