import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import * as prepare from "@/graph/prepare";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import {
  announceUnanswered,
  deliveryRecoveryDedupeKey,
  RECOVERY_GAVE_UP,
} from "@/modules/chatwoot/recover-delivery";
import {
  processChatwootDelivery,
  recordAndProcessChatwootDelivery,
} from "@/modules/chatwoot/webhook";
import {
  announceFailedTurn,
  claimFailureNotice,
  isTurnLost,
  noteText,
  readDirectFence,
  type TurnFailure,
} from "@/modules/conversations/failure-note";
import {
  announceDeadDebounceFlush,
  registerDebounceHandler,
} from "@/modules/debounce/handler";
import * as debounceService from "@/modules/debounce/service";
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
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { FailingModel } from "../utils/scripted-models";

// A turn that dies leaves the customer with no reply and the operator with nothing to see inside
// Chatwoot. Knowing the turn is DEFINITIVELY lost is the hard part, and getting it wrong is worse than
// silence: the note tells an operator to take over, which closes the gate the pending retry needs.
// Five windows: the announcement hangs off the dead-letter CAS (not the attempt count, not the
// handler's catch), a job re-armed mid-run is not dead, the direct path fences on a newer message, an
// unreadable fence stays silent, and the coalescing claim is the write itself so two concurrent
// failures cannot both announce.

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

// The double AUTHENTICATES like Chatwoot: the note is posted with the bot token, and a client built
// without one gets a 401 that a best-effort catch swallows. A stub that accepts any token cannot see
// that.
interface Posted {
  conversationId: number;
  content: string;
  private: boolean;
  token: string;
}
let posted: Posted[] = [];
// Every write in the order Chatwoot received it, so a test can read the hand-over's ORDER (status,
// target, note) and not only that each call happened.
interface Write {
  conversationId: number;
  kind: "toggle" | "assign" | "note";
  body: Record<string, unknown>;
}
let writes: Write[] = [];
// What Chatwoot itself says about a conversation, where a test needs it to differ from the mirror.
// A conversation absent here answers 404, which the hand-over reads as "unreadable".
const liveConversations = new Map<number, Record<string, unknown>>();
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
    const one = url.match(/\/conversations\/(\d+)$/);
    if (one && (init?.method ?? "GET") === "GET") {
      const live = liveConversations.get(Number(one[1]));
      if (!live) return json({ error: "not found" }, 404);
      return json({ id: Number(one[1]), ...live });
    }
    const toggle = url.match(/\/conversations\/(\d+)\/toggle_status$/);
    if (toggle && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      writes.push({ conversationId: Number(toggle[1]), kind: "toggle", body });
      return json({ payload: { success: true, current_status: body.status } });
    }
    const assign = url.match(/\/conversations\/(\d+)\/assignments$/);
    if (assign && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      writes.push({ conversationId: Number(assign[1]), kind: "assign", body });
      return json({});
    }
    if (messages && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      writes.push({ conversationId: Number(messages[1]), kind: "note", body });
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

async function seedConversation(
  over: { failureNoticeSentAt?: Date; status?: string } = {},
) {
  const chatwootConversationId = nextConv++;
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId,
      inboxId: inboxDbId,
      status: over.status ?? "pending",
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
    // A REAL vault entry, so the turn gets as far as the model call: the double answers that
    // call 401 (it authenticates like Chatwoot and knows no OpenAI route), and THAT is the death
    // this suite is about. A dangling ref would not die, it would be the orderly "no-agent" silence.
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Voce e prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
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
    writes = [];
    liveConversations.clear();
    inbound = [];
    messagesFail = false;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!dbUp) return;
    for (const table of [
      "scheduler_jobs",
      "execution_logs",
      "chatwoot_webhook_deliveries",
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
    // A turn still coming is not handed over either: opening the conversation is what would stop it.
    expect(writes).toHaveLength(0);
    expect(await noticeAt(conv)).toBeNull();
  });

  // ── The hand-over ────────────────────────────────────────────────────────────────────────────
  // A note alone, on a conversation still `pending` with the bot, is in nobody's queue: the customer
  // waits until they write again.

  async function withHandoff<T>(
    handoff: { mode: string; targetTeamId?: number } | null,
    run: () => Promise<T>,
  ): Promise<T> {
    const settings = {
      debounce: { enabled: false },
      split: { enabled: false },
      ...(handoff ? { handoff } : {}),
    };
    await suDb.agent.update({ where: { id: agentId }, data: { settings } });
    try {
      return await run();
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          settings: { debounce: { enabled: false }, split: { enabled: false } },
        },
      });
    }
  }

  test("a lost turn opens the conversation, assigns the pinned team, and only then posts the note", async () => {
    const conv = await seedConversation();
    const outcome = await withHandoff(
      { mode: "pinned", targetTeamId: 77 },
      () =>
        announceFailedTurn({
          tenantId,
          instanceId,
          chatwootConversationId: conv,
          assess: async () => ({ path: "job", deadLettered: true }),
          error: new Error("model provider returned 503"),
          base: appDb,
        }),
    );
    expect(outcome).toBe("posted");
    const mine = writes.filter((w) => w.conversationId === conv);
    expect(mine.map((w) => w.kind)).toEqual(["toggle", "assign", "note"]);
    // Conditional on the status the bot holds, so a person who took it meanwhile is not overridden.
    expect(mine[0]?.body).toEqual({
      status: "open",
      expected_status: "pending",
    });
    expect(mine[1]?.body).toEqual({ team_id: 77 });
    expect(posted[0]?.content).toContain(
      "Ela foi aberta para a equipe assumir.",
    );
  });

  test("a newer message that lands before the hand-over cancels it, note included", async () => {
    const conv = await seedConversation();
    // Clear on the first ask, superseded by the time of the last fence.
    let asks = 0;
    const outcome = await announceFailedTurn({
      tenantId,
      instanceId,
      chatwootConversationId: conv,
      assess: async () =>
        asks++ === 0
          ? { path: "direct", fence: "clear" }
          : { path: "direct", fence: "superseded" },
      error: new Error("boom"),
      base: appDb,
    });
    expect(outcome).toBe("not-lost");
    expect(writes.filter((w) => w.conversationId === conv)).toHaveLength(0);
    expect(await noticeAt(conv)).toBeNull();
  });

  test("with no pinned target the conversation is still opened, for Chatwoot's own routing", async () => {
    const conv = await seedConversation();
    await withHandoff(null, () =>
      announceFailedTurn({
        tenantId,
        instanceId,
        chatwootConversationId: conv,
        assess: async () => ({ path: "job", deadLettered: true }),
        error: new Error("boom"),
        base: appDb,
      }),
    );
    expect(
      writes.filter((w) => w.conversationId === conv).map((w) => w.kind),
    ).toEqual(["toggle", "note"]);
  });

  test("a conversation that is no longer the bot's is not reopened, and the note asks for someone", async () => {
    const conv = await seedConversation({ status: "open" });
    const outcome = await announceFailedTurn({
      tenantId,
      instanceId,
      chatwootConversationId: conv,
      assess: async () => ({ path: "job", deadLettered: true }),
      error: new Error("boom"),
      base: appDb,
    });
    expect(outcome).toBe("posted");
    expect(
      writes.filter((w) => w.conversationId === conv).map((w) => w.kind),
    ).toEqual(["note"]);
    expect(posted[0]?.content).toContain("Alguém da equipe precisa assumir.");
  });

  test("the turn's loss is re-asked after the ownership reads, right before the toggle", async () => {
    const conv = await seedConversation();
    // Superseded only once Chatwoot has been read: a message that lands during the ownership reads.
    let liveRead = false;
    liveConversations.set(conv, { status: "pending", meta: {} });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (String(input).endsWith(`/conversations/${conv}`)) liveRead = true;
      return realFetch(input, init);
    }) as typeof globalThis.fetch;
    let outcome: string;
    try {
      outcome = await announceFailedTurn({
        tenantId,
        instanceId,
        chatwootConversationId: conv,
        assess: async () =>
          liveRead
            ? { path: "direct", fence: "superseded" }
            : { path: "direct", fence: "clear" },
        error: new Error("boom"),
        base: appDb,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(outcome).toBe("not-lost");
    expect(writes.filter((w) => w.conversationId === conv)).toHaveLength(0);
  });

  test("a last ask that cannot be read announces nothing, rather than trusting the first", async () => {
    const conv = await seedConversation();
    let asks = 0;
    const outcome = await announceFailedTurn({
      tenantId,
      instanceId,
      chatwootConversationId: conv,
      assess: async () => {
        if (asks++ === 0) return { path: "job", deadLettered: true };
        throw new Error("the scheduler row could not be read");
      },
      error: new Error("boom"),
      base: appDb,
    });
    expect(outcome).toBe("failed");
    expect(writes.filter((w) => w.conversationId === conv)).toHaveLength(0);
    expect(await noticeAt(conv)).toBeNull();
  });

  test("a person who claimed the conversation in Chatwoot keeps it, even with the mirror behind", async () => {
    const conv = await seedConversation();
    // The mirror still says pending and unassigned; Chatwoot already has an attendant on it.
    liveConversations.set(conv, {
      status: "pending",
      meta: { assignee_type: "User", assignee: { id: 41 } },
    });
    await withHandoff({ mode: "pinned", targetTeamId: 77 }, () =>
      announceFailedTurn({
        tenantId,
        instanceId,
        chatwootConversationId: conv,
        assess: async () => ({ path: "job", deadLettered: true }),
        error: new Error("boom"),
        base: appDb,
      }),
    );
    expect(
      writes.filter((w) => w.conversationId === conv).map((w) => w.kind),
    ).toEqual(["note"]);
  });

  test("the note's window coalesces the note, never the hand-over", async () => {
    const conv = await seedConversation({
      failureNoticeSentAt: new Date(Date.now() - 60_000),
    });
    const outcome = await announceFailedTurn({
      tenantId,
      instanceId,
      chatwootConversationId: conv,
      assess: async () => ({ path: "job", deadLettered: true }),
      error: new Error("boom"),
      base: appDb,
    });
    expect(outcome).toBe("coalesced");
    expect(
      writes.filter((w) => w.conversationId === conv).map((w) => w.kind),
    ).toEqual(["toggle"]);
  });

  test("the note is markdown, with the reason in a code span that a backtick cannot break", () => {
    const text = noteText("Transaction `API` error:\n  pool", true);
    expect(text.split("\n\n")).toEqual([
      "**⚠️ O agente não conseguiu responder esta conversa.**",
      "Ela foi aberta para a equipe assumir.",
      "**Motivo:** `Transaction 'API' error: pool`",
    ]);
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

  // The runs' own `generate` lines are `info` (a run with another behind it had not lost the customer
  // yet), so the death writes the one line that alerts: on `generate`, at `error`, linked to the
  // conversation, saying how many runs failed. A row re-armed by a new message is a turn that is
  // coming, and gets no line.
  for (const status of ["DEAD", "PENDING"] as const) {
    test(`a ${status} row ${status === "DEAD" ? "writes" : "does not write"} the unanswered line`, async () => {
      const conv = await seedConversation();
      const threadId = `${tenantId}:${instanceId}:${conv}`;
      const row = await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: KIND,
          dedupeKey: `failnote-unanswered-${status}-${process.pid}`,
          payload: { threadId },
          runAt: new Date(),
          status,
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
          payload: { threadId },
          attempts: 4,
          claimSeq: 0,
        },
        "upstream 503",
        appDb,
      );
      const lines = await flowLogRows(suDb, {
        where: { tenantId, threadId, stage: "generate" },
        select: {
          level: true,
          status: true,
          detail: true,
          errorMessage: true,
          conversationId: true,
        },
      });
      if (status === "PENDING") {
        expect(lines).toEqual([]);
        return;
      }
      const mirror = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: conv },
        select: { id: true },
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.level).toBe("error");
      expect(lines[0]?.status).toBe("error");
      expect(lines[0]?.conversationId).toBe(mirror.id);
      expect(lines[0]?.detail).toEqual({ outcome: "unanswered", runs: 5 });
      expect(lines[0]?.errorMessage).toContain("unanswered");
      expect(lines[0]?.errorMessage).not.toContain("503");
      await clearFlowLog(suDb, { tenantId, threadId });
    });
  }

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
    // NOTE: `tenantId` IS THE FENCE, not decoration: the tick is cross-tenant by design (one leader in
    // production), so without it this drain claims rows of whatever else uses this database, under
    // `bun test --parallel` another worker's file (a WEBHOOK_RETRY tests/modules/debounce.test.ts
    // enqueued), and the failure surfaces there. See the note on TickOptions.tenantId.
    await runSchedulerTick(appDb, {
      staleMs: 5 * 60_000,
      batchSize: 20,
      tenantId,
    });
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
  // operator finds out INSIDE Chatwoot. Nothing runtime-shaped is injected — no fake model, no stub
  // client — so the turn runs for real and the note is posted by the real client against the double,
  // which authenticates like Chatwoot. The turn cannot succeed by accident: every outbound call it
  // could make lands on the double, and the double answers the model call 401, which is the death.
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

  // ── A pool that never served the turn ────────────────────────────────────────────────────────
  // The one database error that ran nothing, so the same work a little later succeeds. Settled like
  // any failure it would be a note on a conversation still with the bot, and the row PROCESSED, the
  // state nothing revisits.

  function neverStarted(): Error {
    return Object.assign(
      new Error(
        "Transaction API error: Unable to start a transaction in the given time.",
      ),
      { code: "P2028" },
    );
  }

  function incoming(conv: number, messageId: number) {
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageId,
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
    });
    if (!n) throw new Error("unreachable");
    inbound = [
      { id: messageId, message_type: 0, content: "oi, preciso de ajuda" },
    ];
    return n;
  }

  test("a live turn the pool never served goes to recovery now: DEAD, recovery armed, nothing posted", async () => {
    const conv = await seedConversation();
    const deliveryId = `failnote-pool-${process.pid}-${conv}`;
    const model = new FailingModel(new Error("the model was reached"));
    // The agent's load is where a saturated pool refuses a turn before anything can act.
    const load = spyOn(prepare, "loadAgentConfig").mockImplementationOnce(
      async () => {
        throw neverStarted();
      },
    );
    let out: string;
    try {
      out = await recordAndProcessChatwootDelivery({
        tenantId,
        instanceId,
        deliveryId,
        agentBotId: 9,
        normalized: incoming(conv, 5_000 + conv),
        base: appDb,
        deps: { makeModel: () => model, sleep: async () => {} },
      });
    } finally {
      load.mockRestore();
    }
    expect(out).toBe("processed");
    expect(model.calls).toBe(0);
    const row = await suDb.chatwootWebhookDelivery.findFirstOrThrow({
      where: { tenantId, deliveryId },
      select: { id: true, status: true },
    });
    expect(row.status).toBe("DEAD");
    const recovery = await suDb.schedulerJob.findMany({
      where: {
        tenantId,
        kind: "DELIVERY_RECOVERY",
        dedupeKey: deliveryRecoveryDedupeKey(row.id),
      },
    });
    expect(recovery).toHaveLength(1);
    // Said like the sweep says it, at `info` because a recovery is coming.
    const convRow = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: conv },
      select: { id: true },
    });
    const line = (
      await flowLogRows(suDb, {
        where: { tenantId, conversationId: convRow.id, stage: "delivery" },
      })
    ).find(
      (r) => (r.detail as { outcome?: string } | null)?.outcome === "stranded",
    );
    expect(line?.level).toBe("info");
    // The recovery is going to answer: a note or a hand-over now would close the gate it needs.
    expect(writes.filter((w) => w.conversationId === conv)).toHaveLength(0);
    expect(await noticeAt(conv)).toBeNull();
  });

  test("inside a recovery's own pass, a turn the pool never served announces nothing either", async () => {
    const conv = await seedConversation();
    const row = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `failnote-pool-replay-${process.pid}-${conv}`,
        event: "message_created",
        status: "DEAD",
        conversationId: conv,
        inboundMessageId: 5_500 + conv,
      },
      select: { id: true },
    });
    let threw = false;
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: row.id,
      agentBotId: 9,
      normalized: incoming(conv, 5_500 + conv),
      claimFrom: "DEAD",
      onDirectTurn: (r) => {
        if (r.kind === "error") threw = true;
      },
      base: appDb,
      deps: {
        makeModel: () => new FailingModel(neverStarted()),
        sleep: async () => {},
      },
    });
    // The recovery reads the throw and puts the row back for its next attempt; a note or a
    // hand-over here would close the gate that attempt needs.
    expect(threw).toBe(true);
    expect(writes.filter((w) => w.conversationId === conv)).toHaveLength(0);
  });

  test("a pool refusal after the model was reached is not replayed: a tool may already have acted", async () => {
    const conv = await seedConversation();
    const deliveryId = `failnote-pool-late-${process.pid}-${conv}`;
    await recordAndProcessChatwootDelivery({
      tenantId,
      instanceId,
      deliveryId,
      agentBotId: 9,
      normalized: incoming(conv, 5_200 + conv),
      base: appDb,
      deps: {
        makeModel: () => new FailingModel(neverStarted()),
        sleep: async () => {},
      },
    });
    const row = await suDb.chatwootWebhookDelivery.findFirstOrThrow({
      where: { tenantId, deliveryId },
      select: { id: true, status: true },
    });
    expect(row.status).toBe("PROCESSED");
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, dedupeKey: deliveryRecoveryDedupeKey(row.id) },
      }),
    ).toBe(0);
    expect(
      writes.filter((w) => w.conversationId === conv).map((w) => w.kind),
    ).toEqual(["toggle", "note"]);
  });

  test("a live turn that failed for any other reason is handed over and its row closes", async () => {
    const conv = await seedConversation();
    const deliveryId = `failnote-other-${process.pid}-${conv}`;
    await recordAndProcessChatwootDelivery({
      tenantId,
      instanceId,
      deliveryId,
      agentBotId: 9,
      normalized: incoming(conv, 6_000 + conv),
      base: appDb,
      deps: {
        makeModel: () =>
          new FailingModel(new Error("model provider returned 400")),
        sleep: async () => {},
      },
    });
    const row = await suDb.chatwootWebhookDelivery.findFirstOrThrow({
      where: { tenantId, deliveryId },
      select: { status: true },
    });
    expect(row.status).toBe("PROCESSED");
    expect(
      writes.filter((w) => w.conversationId === conv).map((w) => w.kind),
    ).toEqual(["toggle", "note"]);
  });

  test("a debounce arm the pool refused once is armed on the next try, and no direct turn runs", async () => {
    const conv = await seedConversation();
    const real = debounceService.armDebounce;
    let arms = 0;
    const spy = spyOn(debounceService, "armDebounce").mockImplementation(
      async (p) => {
        arms++;
        if (arms === 1) throw neverStarted();
        return real(p);
      },
    );
    const model = new FailingModel(new Error("the direct turn ran"));
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          debounce: { enabled: true, windowSeconds: 30 },
          split: { enabled: false },
        },
      },
    });
    try {
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: (
          await suDb.chatwootWebhookDelivery.create({
            data: {
              tenantId,
              chatwootInstanceId: instanceId,
              deliveryId: `failnote-arm-${process.pid}-${conv}`,
              event: "message_created",
              status: "PENDING",
            },
            select: { id: true },
          })
        ).id,
        agentBotId: 9,
        normalized: incoming(conv, 7_000 + conv),
        base: appDb,
        deps: { makeModel: () => model, sleep: async () => {} },
      });
    } finally {
      spy.mockRestore();
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          settings: { debounce: { enabled: false }, split: { enabled: false } },
        },
      });
    }
    expect(arms).toBe(2);
    expect(model.calls).toBe(0);
    expect(
      await suDb.schedulerJob.count({
        where: {
          tenantId,
          kind: "DEBOUNCE",
          dedupeKey: debounceService.debounceDedupeKey(
            `${tenantId}:${instanceId}:${conv}`,
          ),
        },
      }),
    ).toBe(1);
  });

  test("a recovery that gives up on an unanswered message hands the conversation over", async () => {
    const conv = await seedConversation();
    const row = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `failnote-gaveup-${process.pid}-${conv}`,
        event: "message_created",
        status: "DEAD",
        conversationId: conv,
        inboundMessageId: 8_000 + conv,
      },
      select: { id: true },
    });
    await announceUnanswered(tenantId, row.id, appDb);
    expect(
      writes.filter((w) => w.conversationId === conv).map((w) => w.kind),
    ).toEqual(["toggle", "note"]);
    expect(posted.find((p) => p.conversationId === conv)?.content).toContain(
      RECOVERY_GAVE_UP,
    );
    // Once, like its line: a second announcer finds the row decided and hands nothing over again.
    writes = [];
    await announceUnanswered(tenantId, row.id, appDb);
    expect(writes.filter((w) => w.conversationId === conv)).toHaveLength(0);
  });

  test("a given-up row that is not the conversation's newest message hands nothing over", async () => {
    const conv = await seedConversation();
    const row = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `failnote-gaveup-older-${process.pid}-${conv}`,
        event: "message_created",
        status: "DEAD",
        conversationId: conv,
        inboundMessageId: 8_200 + conv,
      },
      select: { id: true },
    });
    // A newer customer message: its own delivery, live or in recovery, owns the conversation now.
    inbound = [
      { id: 8_200 + conv, message_type: 0, content: "oi" },
      { id: 8_201 + conv, message_type: 0, content: "alguém?" },
    ];
    await announceUnanswered(tenantId, row.id, appDb);
    expect(writes.filter((w) => w.conversationId === conv)).toHaveLength(0);
  });

  test("a recovery's own pass that fails for any reason announces nothing: its next attempt needs the conversation", async () => {
    const conv = await seedConversation();
    const row = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `failnote-replay-other-${process.pid}-${conv}`,
        event: "message_created",
        status: "DEAD",
        conversationId: conv,
        inboundMessageId: 5_800 + conv,
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: row.id,
      agentBotId: 9,
      normalized: incoming(conv, 5_800 + conv),
      claimFrom: "DEAD",
      base: appDb,
      deps: {
        makeModel: () => new FailingModel(new Error("provider returned 503")),
        sleep: async () => {},
      },
    });
    expect(writes.filter((w) => w.conversationId === conv)).toHaveLength(0);
  });

  test("two announcers racing on one given-up row hand the conversation over once", async () => {
    const conv = await seedConversation();
    const row = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `failnote-gaveup-race-${process.pid}-${conv}`,
        event: "message_created",
        status: "DEAD",
        conversationId: conv,
        inboundMessageId: 8_500 + conv,
      },
      select: { id: true },
    });
    incoming(conv, 8_500 + conv);
    await Promise.all([
      announceUnanswered(tenantId, row.id, appDb),
      announceUnanswered(tenantId, row.id, appDb),
    ]);
    expect(
      writes
        .filter((w) => w.conversationId === conv && w.kind === "toggle")
        .map((w) => w.kind),
    ).toEqual(["toggle"]);
  });
});
