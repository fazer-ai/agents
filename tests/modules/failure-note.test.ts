import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import {
  announceFailedTurn,
  claimFailureNotice,
  isTurnLost,
  readDirectFence,
  type TurnFailure,
} from "@/modules/conversations/failure-note";
import {
  announceDeadDebounceFlush,
  registerDebounceHandler,
} from "@/modules/debounce/handler";
import type { ClaimedJob } from "@/modules/scheduler/service";
import {
  getDeadLetterHandler,
  getJobHandler,
  registerDeadLetterHandler,
  registerJobHandler,
  runClaimed,
  runSchedulerTick,
} from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #71. A turn that dies leaves the customer with no reply and the operator with nothing to see
// inside Chatwoot. The note that says so is easy; knowing the turn is DEFINITIVELY lost is not, and
// getting it wrong is worse than saying nothing — the note tells an operator to take over, and taking
// over closes the gate the pending retry depends on.
//
// These cover the five windows the design named: the announcement hangs off the dead-letter CAS (not
// the attempt count, and not the handler's catch), a job re-armed mid-run is not dead, the direct
// path fences on a newer message, an unreadable fence stays silent, and the coalescing claim is the
// write itself so two concurrent failures cannot both announce.

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

// TEST-NET-3 on a closed port: passes the SSRF check without a DNS lookup, and nothing can reach it
// even if a call escaped the double.
const BASE_URL = "https://203.0.113.20:9";
const BOT_TOKEN = "PERSONA-BOT-TOKEN";
const INBOX_ID = 501;

let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let nextConv = 900;

// The double AUTHENTICATES like Chatwoot: the note is posted with the bot token, and the whole point
// of window 1 is that a client built without one gets a 401 that a best-effort catch swallows. A stub
// that accepts any token is what let that ship in the first place.
interface Posted {
  conversationId: number;
  content: string;
  private: boolean;
  token: string;
}
let posted: Posted[] = [];
let inbound: Array<{ id: number; message_type: number; content: string }> = [];
let messagesFail = false;
let realFetch: typeof globalThis.fetch;

function installChatwootDouble(): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const token = String(
      (init?.headers as Record<string, string> | undefined)?.[
        "api-access-token"
      ] ?? "",
    );
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (token === "") {
      return json({ error: "Invalid Access Token" }, 401);
    }
    const messages = url.match(/\/conversations\/(\d+)\/messages$/);
    if (messages && (init?.method ?? "GET") === "GET") {
      if (messagesFail) return json({ error: "boom" }, 500);
      return json({ payload: inbound });
    }
    if (messages && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      posted.push({
        conversationId: Number(messages[1]),
        content: String(body.content ?? ""),
        private: body.private === true,
        token,
      });
      return json({ id: 1 });
    }
    return json({}, 404);
  }) as typeof globalThis.fetch;
}

async function seedConversation(over: { failureNoticeSentAt?: Date } = {}) {
  const chatwootConversationId = nextConv++;
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId,
      inboxId: inboxDbId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${chatwootConversationId}`,
      ...(over.failureNoticeSentAt
        ? { failureNoticeSentAt: over.failureNoticeSentAt }
        : {}),
    },
  });
  return chatwootConversationId;
}

let inboxDbId: bigint | null = null;

async function noticeAt(conversationId: number): Promise<Date | null> {
  const row = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: conversationId },
    select: { failureNoticeSentAt: true },
  });
  return row.failureNoticeSentAt;
}

describe("isTurnLost", () => {
  // The whole decision, as a table. Everything else in this file is plumbing around these five rows.
  const rows: Array<[string, TurnFailure, boolean]> = [
    [
      "a job that dead-lettered is lost",
      { path: "job", deadLettered: true },
      true,
    ],
    [
      "a job that will be retried is not",
      { path: "job", deadLettered: false },
      false,
    ],
    [
      "a direct turn with a clear fence is lost",
      { path: "direct", fence: "clear" },
      true,
    ],
    [
      "a direct turn superseded by a newer message is not",
      { path: "direct", fence: "superseded" },
      false,
    ],
    [
      "a fence that could not be read does NOT announce",
      { path: "direct", fence: "unknown" },
      false,
    ],
  ];
  for (const [name, failure, expected] of rows) {
    test(name, () => {
      expect(isTurnLost(failure)).toBe(expected);
    });
  }
});

// `SchedulerJob.kind` is a DB enum, so a test-only kind cannot be inserted: the two seam tests borrow
// DEBOUNCE and put the real handlers back, or every later suite in this worker inherits a flush that
// throws (the registries are process-global).
const KIND = "DEBOUNCE" as const;

async function withBorrowedKind(
  handler: () => Promise<never>,
  onDead: (job: ClaimedJob) => Promise<void>,
  run: () => Promise<void>,
): Promise<void> {
  const realHandler = getJobHandler(KIND);
  const realHook = getDeadLetterHandler(KIND);
  registerJobHandler(KIND, handler);
  registerDeadLetterHandler(KIND, onDead);
  try {
    await run();
  } finally {
    if (realHandler) registerJobHandler(KIND, realHandler);
    if (realHook) registerDeadLetterHandler(KIND, realHook);
  }
}

describe.skipIf(!dbUp)("failed-turn note", () => {
  beforeAll(async () => {
    installChatwootDouble();
    // The real DEBOUNCE handlers, so the two scheduler-seam tests below can borrow the kind and put
    // them back afterwards (the kind is a DB enum — a test-only one cannot be inserted).
    registerDebounceHandler();
    const t = await suDb.tenant.create({
      data: { name: "FAILNOTE", slug: `failnote-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 4,
      baseUrl: BASE_URL,
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Voce e prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: "vault:999999999",
        },
        // Debounce off: the direct path is the one with no retry, and the one this suite fences.
        settings: { debounce: { enabled: false }, split: { enabled: false } },
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId,
        chatwootAgentBotId: 9,
        accessToken: encryptJson(BOT_TOKEN),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `failnote-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_ID,
        name: "Suporte",
        agentId,
      },
    });
    inboxDbId = inbox.id;
  });

  afterEach(() => {
    posted = [];
    inbound = [];
    messagesFail = false;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!dbUp) return;
    for (const table of [
      "scheduler_jobs",
      "conversations",
      "vault_entries",
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

  // ── The claim ────────────────────────────────────────────────────────────────────────────────
  test("two concurrent failures on one conversation elect exactly one announcer", async () => {
    const conv = await seedConversation();
    const both = await Promise.all([
      claimFailureNotice({
        tenantId,
        instanceId,
        chatwootConversationId: conv,
        base: appDb,
      }),
      claimFailureNotice({
        tenantId,
        instanceId,
        chatwootConversationId: conv,
        base: appDb,
      }),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });

  test("a second failure inside the window does not announce again", async () => {
    const now = new Date();
    const conv = await seedConversation({
      failureNoticeSentAt: new Date(now.getTime() - 60_000),
    });
    expect(
      await claimFailureNotice({
        tenantId,
        instanceId,
        chatwootConversationId: conv,
        now,
        base: appDb,
      }),
    ).toBe(false);
  });

  test("a failure past the window announces again", async () => {
    const now = new Date();
    const conv = await seedConversation({
      failureNoticeSentAt: new Date(now.getTime() - 31 * 60_000),
    });
    expect(
      await claimFailureNotice({
        tenantId,
        instanceId,
        chatwootConversationId: conv,
        now,
        base: appDb,
      }),
    ).toBe(true);
    expect((await noticeAt(conv))?.getTime()).toBe(now.getTime());
  });

  // ── The note itself ──────────────────────────────────────────────────────────────────────────
  test("posts a private note AS the persona bot, with the sanitized reason", async () => {
    const conv = await seedConversation();
    const outcome = await announceFailedTurn({
      tenantId,
      instanceId,
      chatwootConversationId: conv,
      assess: async () => ({ path: "job", deadLettered: true }),
      error: new Error("model provider returned 503"),
      base: appDb,
    });
    expect(outcome).toBe("posted");
    expect(posted).toHaveLength(1);
    // Window 1: a client built without the persona bot token 401s and the note never appears.
    expect(posted[0]?.token).toBe(BOT_TOKEN);
    expect(posted[0]?.private).toBe(true);
    expect(posted[0]?.conversationId).toBe(conv);
    expect(posted[0]?.content).toContain("model provider returned 503");
  });

  test("a turn that is not lost posts nothing and does not burn the window", async () => {
    const conv = await seedConversation();
    const outcome = await announceFailedTurn({
      tenantId,
      instanceId,
      chatwootConversationId: conv,
      assess: async () => ({ path: "job", deadLettered: false }),
      error: new Error("transient"),
      base: appDb,
    });
    expect(outcome).toBe("not-lost");
    expect(posted).toHaveLength(0);
    expect(await noticeAt(conv)).toBeNull();
  });

  // ── The direct path's fence ──────────────────────────────────────────────────────────────────
  test("a newer incoming message means someone else may still answer", async () => {
    const conv = await seedConversation();
    inbound = [
      { id: 10, message_type: 0, content: "oi" },
      { id: 11, message_type: 0, content: "ainda ai?" },
    ];
    const fence = await readDirectFence({
      tenantId,
      instanceId,
      chatwootConversationId: conv,
      triggerId: 10,
      base: appDb,
    });
    expect(fence).toBe("superseded");
  });

  test("no newer incoming message means nothing else is coming", async () => {
    const conv = await seedConversation();
    inbound = [
      { id: 10, message_type: 0, content: "oi" },
      // An outgoing message is not another turn's trigger.
      { id: 12, message_type: 1, content: "ja respondo" },
    ];
    expect(
      await readDirectFence({
        tenantId,
        instanceId,
        chatwootConversationId: conv,
        triggerId: 10,
        base: appDb,
      }),
    ).toBe("clear");
  });

  test("a fence that cannot be read is unknown, and unknown stays silent", async () => {
    const conv = await seedConversation();
    messagesFail = true;
    const fence = await readDirectFence({
      tenantId,
      instanceId,
      chatwootConversationId: conv,
      triggerId: 10,
      base: appDb,
    });
    expect(fence).toBe("unknown");
    await announceFailedTurn({
      tenantId,
      instanceId,
      chatwootConversationId: conv,
      assess: async () => ({ path: "direct", fence }),
      error: new Error("boom"),
      base: appDb,
    });
    expect(posted).toHaveLength(0);
    expect(await noticeAt(conv)).toBeNull();
  });

  // ── The scheduler seam ───────────────────────────────────────────────────────────────────────
  test("the hook fires on the dead-letter, not on the failures before it", async () => {
    const calls: bigint[] = [];
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: KIND,
        dedupeKey: `failnote-dead-${process.pid}`,
        payload: {},
        runAt: new Date(),
        status: "CLAIMED",
        attempts: 0,
        claimSeq: 0,
      },
      select: { id: true },
    });
    await withBorrowedKind(
      async () => {
        throw new Error("always fails");
      },
      async (job) => {
        calls.push(job.id);
      },
      async () => {
        // MAX_ATTEMPTS is 5: the first four runs requeue, the fifth is the one that dead-letters.
        for (let attempts = 0; attempts < 5; attempts++) {
          await suDb.schedulerJob.update({
            where: { id: row.id },
            data: { status: "CLAIMED", attempts },
          });
          await runClaimed(
            {
              id: row.id,
              tenantId,
              kind: KIND,
              payload: {},
              attempts,
              claimSeq: 0,
            },
            appDb,
          );
          expect(calls).toHaveLength(attempts === 4 ? 1 : 0);
        }
      },
    );
    const after = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: row.id },
      select: { status: true },
    });
    expect(after.status).toBe("DEAD");
  });

  test("a job re-armed mid-run is not dead, so nothing is announced", async () => {
    const calls: bigint[] = [];
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: KIND,
        dedupeKey: `failnote-rearm-${process.pid}`,
        payload: {},
        runAt: new Date(),
        status: "CLAIMED",
        attempts: 4,
        claimSeq: 0,
      },
      select: { id: true },
    });
    await withBorrowedKind(
      async () => {
        // What armDebounce does when a new message lands while the flush is running: the CLAIMED row
        // goes back to PENDING with another run queued. The CAS in failJob then matches nothing, so
        // the attempt count says "dead" while the job is very much alive.
        await suDb.schedulerJob.update({
          where: { id: row.id },
          data: { status: "PENDING" },
        });
        throw new Error("failed after being re-armed");
      },
      async (job) => {
        calls.push(job.id);
      },
      () =>
        runClaimed(
          {
            id: row.id,
            tenantId,
            kind: KIND,
            payload: {},
            attempts: 4,
            claimSeq: 0,
          },
          appDb,
        ),
    );
    expect(calls).toHaveLength(0);
    const after = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: row.id },
      select: { status: true },
    });
    expect(after.status).toBe("PENDING");
  });

  test("a DEAD row re-armed before the note is posted is a live turn again", async () => {
    const conv = await seedConversation();
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: KIND,
        dedupeKey: `failnote-rearmed-after-${process.pid}`,
        payload: { threadId: `${tenantId}:${instanceId}:${conv}` },
        runAt: new Date(),
        // Dead when the hook fired, PENDING by the time the note would be posted: armDebounce upserts
        // this very row on the next inbound message, and that queued flush will answer.
        status: "PENDING",
        attempts: 5,
        claimSeq: 0,
      },
      select: { id: true },
    });
    await announceDeadDebounceFlush(
      {
        id: row.id,
        tenantId,
        kind: KIND,
        payload: { threadId: `${tenantId}:${instanceId}:${conv}` },
        attempts: 4,
        claimSeq: 0,
      },
      "model provider returned 503",
      appDb,
    );
    expect(posted).toHaveLength(0);
    expect(await noticeAt(conv)).toBeNull();
  });

  test("a job the reaper kills is announced too", async () => {
    const conv = await seedConversation();
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: KIND,
        dedupeKey: `failnote-reaped-${process.pid}`,
        payload: { threadId: `${tenantId}:${instanceId}:${conv}` },
        runAt: new Date(),
        // A claim that hung: the reaper, not failJob, is what ends it, and this is its last attempt.
        status: "CLAIMED",
        claimedAt: new Date(Date.now() - 600_000),
        attempts: 4,
        claimSeq: 0,
      },
      select: { id: true },
    });
    registerDebounceHandler();
    await runSchedulerTick(appDb, { staleMs: 5 * 60_000, batchSize: 20 });
    const after = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: row.id },
      select: { status: true },
    });
    expect(after.status).toBe("DEAD");
    const note = posted.find((p) => p.conversationId === conv);
    expect(note).toBeDefined();
    expect(note?.token).toBe(BOT_TOKEN);
  });

  test("the debounce flush registers its dead-letter hook", () => {
    registerDebounceHandler();
    expect(getDeadLetterHandler("DEBOUNCE")).toBe(announceDeadDebounceFlush);
  });

  // The direct webhook path, end to end: a delivery arrives, the turn dies inside the runtime, and the
  // operator finds out INSIDE Chatwoot. Nothing here is injected — `processChatwootDelivery` has no
  // seam for the runtime, so the turn runs for real and the note is posted by the real client against
  // the double, which authenticates like Chatwoot. The turn cannot succeed by accident: its model
  // credential does not resolve and every outbound call it could make lands on the double.
  test("a turn that dies on the direct path leaves a note on the conversation", async () => {
    const conv = await seedConversation();
    const payload = {
      event: "message_created",
      id: 4242,
      content: "oi, preciso de ajuda",
      message_type: "incoming",
      private: false,
      conversation: {
        id: conv,
        inbox_id: INBOX_ID,
        status: "pending",
        contact_inbox: { id: 88_000 + conv },
        meta: {
          assignee_type: null,
          assignee: null,
          sender: { id: 700, name: "Cliente", phone_number: "+5511999990000" },
        },
        channel: "Channel::WebWidget",
        last_activity_at: Math.floor(Date.now() / 1000),
      },
    };
    const n = normalizeChatwootEvent(payload);
    expect(n).not.toBeNull();
    if (!n) throw new Error("unreachable");
    // The fence sees only the message this turn was triggered by, so nothing else is coming.
    inbound = [{ id: 4242, message_type: 0, content: "oi, preciso de ajuda" }];
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `failnote-${process.pid}-${conv}`,
        event: "message_created",
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
    const note = posted.find((p) => p.conversationId === conv);
    expect(note).toBeDefined();
    expect(note?.private).toBe(true);
    expect(note?.token).toBe(BOT_TOKEN);
    expect(await noticeAt(conv)).not.toBeNull();
  });

  // Same window on the direct path: the fence is read by the announcer, so a message that lands while
  // the failure is being recorded is seen, and the turn it will start is left alone.
  test("a message that arrives before the note does cancels the note", async () => {
    const conv = await seedConversation();
    let announced = 0;
    const outcome = await announceFailedTurn({
      tenantId,
      instanceId,
      chatwootConversationId: conv,
      assess: async () => {
        announced += 1;
        // The customer wrote again between the failure and this point.
        inbound = [
          { id: 4242, message_type: 0, content: "oi" },
          { id: 4243, message_type: 0, content: "alo?" },
        ];
        return {
          path: "direct",
          fence: await readDirectFence({
            tenantId,
            instanceId,
            chatwootConversationId: conv,
            triggerId: 4242,
            base: appDb,
          }),
        };
      },
      error: new Error("boom"),
      base: appDb,
    });
    expect(announced).toBe(1);
    expect(outcome).toBe("not-lost");
    expect(posted).toHaveLength(0);
    expect(await noticeAt(conv)).toBeNull();
  });

  test("the dead debounce flush announces on the conversation its thread names", async () => {
    const conv = await seedConversation();
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: KIND,
        dedupeKey: `failnote-flush-${process.pid}`,
        payload: { threadId: `${tenantId}:${instanceId}:${conv}` },
        runAt: new Date(),
        status: "DEAD",
        attempts: 5,
        claimSeq: 0,
      },
      select: { id: true },
    });
    const job: ClaimedJob = {
      id: row.id,
      tenantId,
      kind: KIND,
      payload: { threadId: `${tenantId}:${instanceId}:${conv}` },
      attempts: 4,
      claimSeq: 0,
    };
    await announceDeadDebounceFlush(job, "model provider returned 503", appDb);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.conversationId).toBe(conv);
    expect(posted[0]?.token).toBe(BOT_TOKEN);
    expect(await noticeAt(conv)).not.toBeNull();
  });
});
