import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { getConversationDetail } from "@/modules/conversations/service";
import { followUpHandler } from "@/modules/followups/handlers";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #129, wiring end. A BusinessHours profile only modelled the week, so a holiday had no
// representation and every consumer read September 7 as an ordinary Monday. The RULE (which ranges
// govern a date) is pinned as a decision table in business-hours.test.ts against fixed instants; what
// these cover is that the exception actually travels from the row to each decision — the part that
// silently would not, because exceptions cannot ride inside an array of weekly windows.
//
// The schedule here is open 00:00–23:59 on all seven days, and an exception closes TODAY and TOMORROW
// in its own timezone. Everything below therefore asserts the CLOSED direction, which holds at any
// minute of the run; the open direction depends on the wall clock and is pinned in the unit table
// instead, at instants that cannot drift.

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

const TZ = "America/Sao_Paulo";
// TEST-NET-3 on a closed port: passes the SSRF check without a DNS lookup, and nothing can reach it
// even if a call escaped the double.
const BASE_URL = "https://203.0.113.21:9";
const BOT_TOKEN = "BH-EXC-BOT-TOKEN";
const INBOX_ID = 771;

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let agentId = 0n;
let hoursId = 0n;
// A second agent whose schedule never reopens, for the estimate's terminal case.
let neverInboxDbId = 0n;

// The local calendar date `days` from now, in the schedule's timezone — the same key an exception
// matches on. en-CA formats as YYYY-MM-DD.
function localDate(days: number): string {
  const at = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" } as TenantContext;
}

// ── the Chatwoot double: it AUTHENTICATES like Chatwoot, so a client built without the persona's bot
// token gets the same 401 the real server answers. A stub that accepts anything would let the gate
// "post" a note it never actually delivered. ──
interface Posted {
  conversationId: number;
  content: string;
  private: boolean;
  token: string;
}
const posted: Posted[] = [];
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
    if (token === "") return json({ error: "Invalid Access Token" }, 401);
    const messages = url.match(/\/conversations\/(\d+)\/messages$/);
    if (messages && (init?.method ?? "GET") === "GET") {
      return json({ payload: [] });
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

function stubClient() {
  const sent: Array<[number, string]> = [];
  const client = {
    getConversation: async (c: number) => ({
      id: c,
      status: "pending",
      meta: {},
    }),
    sendMessage: async (c: number, t: string) => {
      sent.push([c, t]);
      return {};
    },
    sendPrivateNote: async () => ({}),
    getConversationLabels: async () => [],
    setConversationLabels: async () => ({}),
    toggleStatus: async () => ({}),
  } as unknown as ChatwootClient;
  return { sent, makeClient: async () => client };
}

const threadOf = (convId: number) => `${tenantId}:${instanceId}:${convId}`;

async function seedConversation(
  convId: number,
  inbox: bigint = inboxDbId,
): Promise<bigint> {
  const row = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inbox,
      chatwootConversationId: convId,
      status: "pending",
      threadId: threadOf(convId),
      // Two minutes idle, so the 1-minute follow-up step is due.
      lastEventAt: new Date(Date.now() - 2 * 60_000),
      lastInboundAt: new Date(Date.now() - 3 * 60_000),
    },
    select: { id: true },
  });
  return row.id;
}

describe.skipIf(!dbUp)("business-hours date exceptions (issue #129)", () => {
  beforeAll(async () => {
    installChatwootDouble();
    const t = await suDb.tenant.create({
      data: { name: "BHEXC", slug: `bhexc-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 11,
      baseUrl: BASE_URL,
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const hours = await suDb.businessHours.create({
      data: {
        tenantId,
        name: "Atendimento",
        timezone: TZ,
        // Open every day, all day: without the exception nothing here could be closed, so a closed
        // reading can only have come from the exception.
        windows: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
          day,
          start: "00:00",
          end: "23:59",
        })),
        exceptions: [
          {
            date: localDate(0),
            dateEnd: localDate(1),
            label: "Recesso",
            ranges: [],
          },
        ],
      },
      select: { id: true },
    });
    hoursId = hours.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        businessHoursId: hours.id,
        followUpArmedAt: new Date(Date.now() - 30 * 86_400_000),
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: {
          debounce: { enabled: false },
          split: { enabled: false },
          followUp: {
            enabled: true,
            steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
          },
        },
      },
      select: { id: true },
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
        webhookRouteTokenHash: `bhexc-route-${process.pid}`,
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

    // A schedule that never reopens: a recurring span covering every month-day. Only expressible now
    // that dates exist, which is what makes the handler's "end the sequence" branch reachable.
    const neverHours = await suDb.businessHours.create({
      data: {
        tenantId,
        name: "Fechado indefinidamente",
        timezone: TZ,
        windows: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
          day,
          start: "00:00",
          end: "23:59",
        })),
        exceptions: [
          {
            date: "2026-01-01",
            dateEnd: "2026-12-31",
            recurring: true,
            label: "Encerrado",
            ranges: [],
          },
        ],
      },
      select: { id: true },
    });
    const neverAgent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Encerrado",
        systemPrompt: "x",
        businessHoursId: neverHours.id,
        followUpArmedAt: new Date(Date.now() - 30 * 86_400_000),
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {
          followUp: {
            enabled: true,
            steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
          },
        },
      },
      select: { id: true },
    });
    const neverInbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_ID + 1,
        name: "Encerrado",
        agentId: neverAgent.id,
      },
    });
    neverInboxDbId = neverInbox.id;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!dbUp || !tenantId) return;
    for (const table of [
      "scheduler_jobs",
      "llm_usage",
      "execution_logs",
      "conversations",
      "chatwoot_webhook_deliveries",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
      "business_hours",
      "vault_entries",
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

  // ── consumer 2: the follow-up scheduler ──
  test("a nudge due during a closure is deferred past it, not sent", async () => {
    const convId = 8101;
    await seedConversation(convId);
    const s = stubClient();
    const job: ClaimedJob = {
      id: 1n,
      tenantId,
      kind: "FOLLOWUP",
      payload: { threadId: threadOf(convId) },
      attempts: 0,
    };
    const result = await followUpHandler(job, appDb, {
      makeModel: () => new FakeListChatModel({ responses: ["oi"] }),
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    });
    expect(result.outcome).toBe("reschedule");
    const runAt = (result as { runAt: Date }).runAt;
    // The closure covers today and tomorrow, so the first open instant is the day after that.
    expect(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(runAt),
    ).toBe(localDate(2));
    expect(s.sent).toEqual([]);
  });

  // ── consumer 1: the reactive availability gate ──
  test("a customer message during a closure is not answered, and the operator is told", async () => {
    const convId = 8102;
    await seedConversation(convId);
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: 5151,
      content: "vocês estão abertos hoje?",
      message_type: "incoming",
      private: false,
      conversation: {
        id: convId,
        inbox_id: INBOX_ID,
        status: "pending",
        contact_inbox: { id: 99_000 + convId },
        meta: {
          assignee_type: null,
          assignee: null,
          sender: { id: 700, name: "Cliente", phone_number: "+5511999990000" },
        },
        channel: "Channel::WebWidget",
        last_activity_at: Math.floor(Date.now() / 1000),
      },
    });
    expect(n).not.toBeNull();
    if (!n) throw new Error("unreachable");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `bhexc-${process.pid}-${convId}`,
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

    const mine = posted.filter((p) => p.conversationId === convId);
    // The customer gets nothing: every message the double received is a private note.
    expect(mine.every((p) => p.private)).toBe(true);
    const notice = mine.find((p) => p.content.includes("fora do horário"));
    expect(notice).toBeDefined();
    expect(notice?.token).toBe(BOT_TOKEN);
    // And the one-shot watermark is stamped, which is what keeps the note from repeating.
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { outOfHoursNoticeSentAt: true },
    });
    expect(conv.outOfHoursNoticeSentAt).not.toBeNull();
  });

  // ── consumer 3: the console indicators ──
  test("the conversation header reports the closure, and names it", async () => {
    const convId = 8103;
    const rowId = await seedConversation(convId);
    const detail = await getConversationDetail(ctx(), rowId, appDb);
    expect(detail.outOfHours).toBe(true);
    // The panel would otherwise recite the weekly grid — "open every day" — on a day the agent is
    // closed. The exception in force travels with it so the tooltip can say which one.
    expect(detail.followUp?.hours?.exceptionToday?.label).toBe("Recesso");
    expect(detail.followUp?.hours?.exceptionToday?.ranges).toEqual([]);
  });

  test("the follow-up ETA the console shows skips the closure too", async () => {
    const convId = 8104;
    const rowId = await seedConversation(convId);
    // What a fresh sweep leaves behind: a pending job armed for a moment INSIDE the closure. The
    // estimate must show when the nudge can actually fire, not when the job happens to be armed.
    const insideClosure = new Date(Date.now() + 86_400_000);
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: `followup:${threadOf(convId)}`,
        status: "PENDING",
        runAt: insideClosure,
        payload: { threadId: threadOf(convId) },
      },
    });
    const detail = await getConversationDetail(ctx(), rowId, appDb);
    expect(detail.followUp?.nextRunAt).not.toBeNull();
    expect(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(detail.followUp?.nextRunAt as string)),
    ).toBe(localDate(2));
    expect(detail.followUp?.nextRunAtDeferred).toBe(true);
  });

  test("a schedule that never reopens ends the sequence instead of nudging", async () => {
    const convId = 8106;
    await seedConversation(convId, neverInboxDbId);
    const s = stubClient();
    const result = await followUpHandler(
      {
        id: 2n,
        tenantId,
        kind: "FOLLOWUP",
        payload: { threadId: threadOf(convId) },
        attempts: 0,
      },
      appDb,
      {
        makeModel: () => new FakeListChatModel({ responses: ["oi"] }),
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      },
    );
    expect(result).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
    // Abandoned WITH a watermark. A bare "done" leaves the episode untouched, so the sweep matches it
    // again on the very next pass and every eligible conversation re-enters this scan once a minute,
    // forever. The stamp is what ends the episode rather than just this run of it.
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { lastFollowUpAt: true },
    });
    expect(conv.lastFollowUpAt).not.toBeNull();
  });

  test("a schedule that never reopens shows no next step, not a time inside the closure", async () => {
    // The handler ends the sequence here (there is no instant to defer to). An estimate that fell back
    // to the ungated time would promise a follow-up that can never run — and before date exceptions
    // that fallback could not be reached, because a weekly grid always reopens inside the scan.
    const convId = 8105;
    const rowId = await seedConversation(convId, neverInboxDbId);
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: `followup:${threadOf(convId)}`,
        status: "PENDING",
        runAt: new Date(Date.now() - 60_000),
        payload: { threadId: threadOf(convId) },
      },
    });
    const detail = await getConversationDetail(ctx(), rowId, appDb);
    expect(detail.followUp?.nextRunAt).toBeNull();
    expect(detail.followUp?.nextStep).toBeNull();
  });

  // ── the read the bookable-slot filter goes through ──
  test("the schedule the availability tool resolves carries the exceptions", async () => {
    const { readSchedule } = await import("@/modules/business-hours/service");
    const resolved = await readSchedule(ctx(), String(hoursId), appDb);
    expect(resolved?.exceptions).toHaveLength(1);
    expect(resolved?.windows).toHaveLength(7);
    expect(resolved?.timezone).toBe(TZ);
    // "Always on" for anything that cannot resolve, which is what keeps a deleted or hand-edited id
    // from silently blocking every slot.
    expect(await readSchedule(ctx(), "not-an-id", appDb)).toBeNull();
    expect(await readSchedule(ctx(), "999999999", appDb)).toBeNull();
  });

  // ── the schedule row itself round-trips through the API projection ──
  test("the profile reads back with its exceptions", async () => {
    const { getBusinessHours } = await import(
      "@/modules/business-hours/service"
    );
    const dto = await getBusinessHours(ctx(), hoursId, appDb);
    expect(dto.exceptions).toHaveLength(1);
    expect(dto.exceptions[0]?.label).toBe("Recesso");
    expect(dto.windows).toHaveLength(7);
  });
});
