import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { setPublisher } from "@/api/features/realtime/realtime.service";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId } from "@/graph/checkpointer";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import {
  reconcileUnconfirmedCloses,
  sweepStrandedDeliveries,
} from "@/modules/chatwoot/delivery-sweep";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// A conversation event (a status or an assignee change) that strands in the delivery ledger is the
// only word the mirror would have had about that change. The sweep reads the conversation back from
// Chatwoot and applies it under the mirror's version ordering, instead of closing the row as having
// owed nothing; and a close this side made whose own event never landed converges the same way.

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const CHATWOOT_INBOX_ID = 71;
const AGENT_BOT_ID = 19;
const STALE_MS = 30 * 60 * 1000;
// Epoch seconds, the axis Chatwoot versions a conversation on.
const V1 = 1_791_388_618.97;
const V2 = 1_791_388_620.08;
const V3 = 1_791_388_700.5;

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let seq = 0;

interface LiveConv {
  status: string;
  updatedAt: number;
  assignee?: { type: "AgentBot" | "User"; id: number; name: string } | null;
}
// What the fake account answers per conversation; a number is an HTTP error status.
// "garbled" is a 200 whose body does not decode.
let live = new Map<number, LiveConv | number | "garbled">();
let reads: number[] = [];
// Runs inside a read, to put the database where a concurrent writer would have left it.
let onRead: (id: number) => Promise<void> = async () => {};
let published: Array<{ conversationId: string; status: string }> = [];

const client = {
  getConversation: async (id: number) => {
    reads.push(id);
    await onRead(id);
    const c = live.get(id);
    if (c === "garbled") throw new SyntaxError("Unexpected token < in JSON");
    if (c === undefined || typeof c === "number") {
      throw new ChatwootApiError(
        typeof c === "number" ? c : 404,
        `/conversations/${id}`,
      );
    }
    return {
      id,
      inbox_id: CHATWOOT_INBOX_ID,
      status: c.status,
      updated_at: c.updatedAt,
      last_activity_at: Math.floor(c.updatedAt) - 60,
      meta: c.assignee
        ? {
            assignee_type: c.assignee.type,
            assignee: { id: c.assignee.id, name: c.assignee.name },
          }
        : {},
    };
  },
} as unknown as ChatwootClient;
const deps = { makeClient: async () => client };

async function seedConversation(
  convId: number,
  over: {
    status?: string;
    statusAt?: number | null;
    resolvedBy?: string | null;
    resolvedByAt?: number | null;
    assigneeAt?: number | null;
    updatedAgoMs?: number;
  } = {},
) {
  const row = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: over.status ?? "pending",
      assigneeType: "AgentBot",
      assigneeId: AGENT_BOT_ID,
      inboxId: inboxDbId,
      threadId: chatwootThreadId(tenantId, instanceId, convId),
      lastEventAt: new Date((V1 - 120) * 1000),
      chatwootStatusAt: over.statusAt === undefined ? V1 : over.statusAt,
      resolvedBy: over.resolvedBy ?? null,
      resolvedByAt: over.resolvedByAt ?? null,
      chatwootAssigneeAt: over.assigneeAt ?? null,
      contactInboxId: 71_000 + convId,
    },
    select: { id: true },
  });
  if (over.updatedAgoMs !== undefined) {
    await suDb.$executeRaw`UPDATE conversations SET updated_at = now() - make_interval(secs => ${over.updatedAgoMs / 1000}) WHERE id = ${row.id}`;
  }
  return row.id;
}

async function strand(
  convId: number,
  event: string,
  over: {
    claimedAgoMs?: number;
    status?: "PENDING" | "PROCESSING";
    attempts?: number;
  } = {},
) {
  seq += 1;
  const claimedAgoMs = over.claimedAgoMs ?? STALE_MS + 60_000;
  const row = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `strand-conv-${process.pid}-${seq}`,
      event,
      status: over.status ?? "PROCESSING",
      receivedAt: new Date(Date.now() - claimedAgoMs - 1_000),
      claimedAt: new Date(Date.now() - claimedAgoMs),
      conversationId: convId,
      attempts: over.attempts ?? 0,
    },
    select: { id: true },
  });
  return row.id;
}

const mirror = (convId: number) =>
  suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: {
      status: true,
      chatwootStatusAt: true,
      assigneeType: true,
      assigneeId: true,
      resolvedBy: true,
      updatedAt: true,
    },
  });
const ledger = (id: bigint) =>
  suDb.chatwootWebhookDelivery.findUniqueOrThrow({
    where: { id },
    select: { status: true, attempts: true },
  });
const recoveries = () =>
  suDb.schedulerJob.count({
    where: { tenantId, kind: "DELIVERY_RECOVERY" },
  });

beforeAll(async () => {
  if (!dbUp) return;
  const t = await suDb.tenant.create({
    data: { name: "SCE", slug: `sce-${process.pid}-${Date.now()}` },
  });
  tenantId = t.id;
  const inst = await seedChatwootInstance(suDb, {
    tenantId,
    accountId: 71,
    baseUrl: "https://chat.sce.example",
    adminToken: encryptJson("ADMIN"),
  });
  instanceId = inst.id;
  const agent = await suDb.agent.create({
    data: {
      tenantId,
      name: "Atendente",
      systemPrompt: "x",
      modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      settings: {},
    },
  });
  await suDb.chatwootAgentBot.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      agentId: agent.id,
      chatwootAgentBotId: AGENT_BOT_ID,
      accessToken: encryptJson("BOT"),
      webhookSecret: encryptJson("S"),
      webhookRouteTokenHash: `sce-route-${process.pid}`,
      name: "Atendente",
    },
  });
  inboxDbId = (
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "Suporte",
        agentId: agent.id,
      },
    })
  ).id;
  await suDb.webhookSubscription.create({
    data: {
      tenantId,
      url: "https://example.com/hook",
      events: ["conversation.handoff"],
    },
  });
});

beforeEach(async () => {
  if (!dbUp) return;
  live = new Map();
  reads = [];
  onRead = async () => {};
  published = [];
  setPublisher((_topic, data) => {
    const e = JSON.parse(data);
    if (e.type === "conversation" && e.tenantId === tenantId.toString())
      published.push({ conversationId: e.conversationId, status: e.status });
  });
  await suDb.schedulerJob.deleteMany({ where: { tenantId } });
  await suDb.chatwootWebhookDelivery.deleteMany({ where: { tenantId } });
  await suDb.outboundWebhookDelivery.deleteMany({ where: { tenantId } });
  await clearFlowLog(suDb, { tenantId });
  await suDb.conversation.deleteMany({ where: { tenantId } });
});

afterAll(async () => {
  setPublisher(() => undefined);
  if (!tenantId) return;
  await suDb.schedulerJob.deleteMany({ where: { tenantId } });
  await suDb.chatwootWebhookDelivery.deleteMany({ where: { tenantId } });
  await suDb.conversation.deleteMany({ where: { tenantId } });
  await suDb.tenant.delete({ where: { id: tenantId } });
});

describe.skipIf(!dbUp)(
  "a stranded conversation event reaches the mirror",
  () => {
    test("a resolve stranded behind an older pending is applied from Chatwoot, and the row closes without a recovery (catches a mirror left pending forever)", async () => {
      await seedConversation(9001, {
        resolvedBy: "followup_abandonment",
        resolvedByAt: V1 - 1_000,
      });
      const rows = [
        await strand(9001, "conversation_resolved"),
        await strand(9001, "conversation_status_changed"),
      ];
      live.set(9001, { status: "resolved", updatedAt: V2 });
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      const m = await mirror(9001);
      expect([m.status, m.chatwootStatusAt, m.resolvedBy]).toEqual([
        "resolved",
        V2,
        "followup_abandonment",
      ]);
      for (const id of rows)
        expect((await ledger(id)).status).toBe("PROCESSED");
      expect(await recoveries()).toBe(0);
      // One read per conversation per pass, however many of its rows stranded.
      expect(reads).toEqual([9001]);
    });

    test("the repaired state is announced to open consoles (catches a list left showing pending after the repair)", async () => {
      const id = await seedConversation(9010);
      await strand(9010, "conversation_resolved");
      live.set(9010, { status: "resolved", updatedAt: V2 });
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      expect(published).toContainEqual({
        conversationId: String(id),
        status: "resolved",
      });
    });

    test("a status that lands while the holder loses to a newer mark is still announced (catches a partial repair left off open consoles)", async () => {
      const id = await seedConversation(9016, { assigneeAt: V3 });
      await strand(9016, "conversation_resolved");
      live.set(9016, {
        status: "resolved",
        updatedAt: V2,
        assignee: { type: "User", id: 4, name: "Ana" },
      });
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      const m = await mirror(9016);
      expect([m.status, m.assigneeType]).toEqual(["resolved", "AgentBot"]);
      expect(published).toContainEqual({
        conversationId: String(id),
        status: "resolved",
      });
    });

    test("the ordinary verdicts are given before any conversation is read (catches a slow Chatwoot delaying a customer's recovery)", async () => {
      await seedConversation(9011);
      await strand(9011, "conversation_resolved");
      const other = await strand(9012, "webwidget_triggered");
      let otherAtRead = "";
      onRead = async () => {
        otherAtRead = (await ledger(other)).status;
      };
      live.set(9011, { status: "resolved", updatedAt: V2 });
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      expect(otherAtRead).toBe("PROCESSED");
    });

    test("each row spends its own budget of failed reads (catches a newer row closed on an older row's failures)", async () => {
      await seedConversation(9013);
      const old = await strand(9013, "conversation_status_changed", {
        attempts: 2,
      });
      const fresh = await strand(9013, "conversation_resolved");
      live.set(9013, 503);
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      expect(await ledger(old)).toEqual({ status: "PROCESSED", attempts: 2 });
      expect(await ledger(fresh)).toEqual({
        status: "PROCESSING",
        attempts: 1,
      });
    });

    test("a failure about one conversation does not stand for its siblings (catches a healthy event closed unread behind one bad conversation)", async () => {
      await seedConversation(9019);
      await seedConversation(9020);
      const bad = await strand(9019, "conversation_resolved");
      await strand(9020, "conversation_resolved");
      live.set(9019, 500);
      live.set(9020, { status: "resolved", updatedAt: V2 });
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      expect(reads).toEqual([9019, 9020]);
      expect((await mirror(9020)).status).toBe("resolved");
      expect((await ledger(bad)).attempts).toBe(1);

      // And a 200 whose body does not decode.
      await seedConversation(9021);
      await seedConversation(9022);
      await strand(9021, "conversation_resolved");
      await strand(9022, "conversation_resolved");
      live.set(9021, "garbled");
      live.set(9022, { status: "resolved", updatedAt: V2 });
      reads = [];
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      expect(reads).toContain(9022);
      expect((await mirror(9022)).status).toBe("resolved");
    });

    test("a backlog of conversation events does not fill the batch ahead of a customer's message (catches recovery waiting behind read-backs)", async () => {
      await seedConversation(9023);
      await strand(9023, "conversation_resolved", {
        claimedAgoMs: STALE_MS + 120_000,
      });
      const msg = await strand(9024, "webwidget_triggered");
      live.set(9023, { status: "resolved", updatedAt: V2 });
      // Nothing read back this pass: the conversation event stays, and still the other row settles.
      await sweepStrandedDeliveries({
        tenantId,
        base: appDb,
        deps,
        batch: 1,
        readBudgetMs: 0,
      });
      expect((await ledger(msg)).status).toBe("PROCESSED");
    });

    test("a failure that outran the read budget still advances the instance's other rows (catches a timeout leaving them where they were)", async () => {
      await seedConversation(9017);
      await seedConversation(9018);
      const a = await strand(9017, "conversation_resolved");
      const b = await strand(9018, "conversation_resolved");
      live.set(9017, 503);
      live.set(9018, 503);
      // The read itself takes longer than the whole budget, as a request timeout would.
      let t = 0;
      onRead = async () => {
        t += 15_000;
      };
      await sweepStrandedDeliveries({
        tenantId,
        base: appDb,
        deps: { ...deps, clock: () => t },
        readBudgetMs: 10_000,
      });
      expect(reads).toHaveLength(1);
      expect((await ledger(a)).attempts).toBe(1);
      expect((await ledger(b)).attempts).toBe(1);
    });

    test("an instance that failed a read is not asked again in the same pass, and its other rows count the failure (catches a down instance costing a timeout per conversation)", async () => {
      await seedConversation(9014);
      await seedConversation(9015);
      const a = await strand(9014, "conversation_resolved");
      const b = await strand(9015, "conversation_resolved");
      live.set(9014, 503);
      live.set(9015, 503);
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      expect(reads).toHaveLength(1);
      expect((await ledger(a)).attempts).toBe(1);
      expect((await ledger(b)).attempts).toBe(1);
    });

    test("a status change stranded on its own is applied too (catches the sweep reading only the resolve)", async () => {
      await seedConversation(9009);
      await strand(9009, "conversation_status_changed");
      live.set(9009, { status: "open", updatedAt: V2 });
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      expect((await mirror(9009)).status).toBe("open");
    });

    test("a newer state already in the mirror wins over the stranded event (catches the sweep walking a reopen back)", async () => {
      await seedConversation(9002, { status: "open", statusAt: V3 });
      const row = await strand(9002, "conversation_resolved");
      live.set(9002, { status: "resolved", updatedAt: V2 });
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      const m = await mirror(9002);
      expect([m.status, m.chatwootStatusAt]).toEqual(["open", V3]);
      expect((await ledger(row)).status).toBe("PROCESSED");
    });

    test("a stranded assignee change hands the conversation to the person (catches the bot answering over a human)", async () => {
      await seedConversation(9003);
      await strand(9003, "conversation_updated");
      live.set(9003, {
        status: "open",
        updatedAt: V2,
        assignee: { type: "User", id: 4, name: "Ana" },
      });
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      const m = await mirror(9003);
      expect([m.status, m.assigneeType, m.assigneeId]).toEqual([
        "open",
        "User",
        4,
      ]);
      // The handoff a live event would have announced: the event that would have is the one lost.
      const handoffs = await suDb.outboundWebhookDelivery.findMany({
        where: { tenantId, event: "conversation.handoff" },
        select: { payload: true },
      });
      expect(
        handoffs.map((h) => (h.payload as { data?: unknown }).data),
      ).toEqual([
        {
          conversation_id: String(
            (
              await suDb.conversation.findFirstOrThrow({
                where: { tenantId, chatwootConversationId: 9003 },
              })
            ).id,
          ),
          inbox_id: String(inboxDbId),
        },
      ]);
    });

    test("a conversation Chatwoot no longer has closes its row and invents nothing (catches a 404 looping or a state made up)", async () => {
      const cid = await seedConversation(9004);
      const row = await strand(9004, "conversation_resolved");
      live.set(9004, 404);
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      expect((await ledger(row)).status).toBe("PROCESSED");
      const m = await mirror(9004);
      expect([m.status, m.chatwootStatusAt]).toEqual(["pending", V1]);
      const lines = await flowLogRows(suDb, {
        where: { tenantId, conversationId: cid, stage: "delivery" },
        select: { detail: true },
      });
      expect(lines.map((l) => l.detail)).toEqual([
        {
          outcome: "conversation_gone",
          conversationId: 9004,
          closed: "1 stranded conversation event(s) closed",
        },
      ]);
    });

    test("a read that fails for another reason is retried on the next pass, and closed after the last attempt (catches one outage losing the event, or a row read forever)", async () => {
      await seedConversation(9005);
      const row = await strand(9005, "conversation_resolved");
      live.set(9005, 503);
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      expect((await ledger(row)).status).toBe("PROCESSING");
      live.set(9005, { status: "resolved", updatedAt: V2 });
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      expect((await mirror(9005)).status).toBe("resolved");
      expect((await ledger(row)).status).toBe("PROCESSED");

      await seedConversation(9006);
      const dead = await strand(9006, "conversation_resolved");
      live.set(9006, 503);
      for (let i = 0; i < 6; i++) {
        await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      }
      expect((await ledger(dead)).status).toBe("PROCESSED");
      expect((await mirror(9006)).status).toBe("pending");
    });

    test("a row still inside the stale window is left alone (catches the sweep racing a delivery on its way)", async () => {
      await seedConversation(9007);
      const row = await strand(9007, "conversation_resolved", {
        claimedAgoMs: 60_000,
      });
      live.set(9007, { status: "resolved", updatedAt: V2 });
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      expect(reads).toEqual([]);
      expect((await ledger(row)).status).toBe("PROCESSING");
    });

    test("a widget trigger and a message update still close as owing nothing, unread (catches the new branch reading every event)", async () => {
      const a = await strand(9008, "webwidget_triggered");
      const b = await strand(9008, "message_updated");
      await sweepStrandedDeliveries({ tenantId, base: appDb, deps });
      expect((await ledger(a)).status).toBe("PROCESSED");
      expect((await ledger(b)).status).toBe("PROCESSED");
      expect(reads).toEqual([]);
    });
  },
);

describe.skipIf(!dbUp)("a close this side made converges", () => {
  test("a recorded close the mirror never saw is read back and applied, one already in agreement or still recent is not read (catches rows stranded before the fix staying pending)", async () => {
    await seedConversation(9101, {
      resolvedBy: "followup_abandonment",
      resolvedByAt: V1 - 1_000,
      updatedAgoMs: STALE_MS + 60_000,
    });
    await seedConversation(9102, {
      status: "resolved",
      statusAt: V2,
      resolvedBy: "agent",
      resolvedByAt: V1,
      updatedAgoMs: STALE_MS + 60_000,
    });
    // Our toggle a moment ago: its own webhook is still on the way.
    await seedConversation(9103, {
      resolvedBy: "agent",
      resolvedByAt: V1,
      updatedAgoMs: 60_000,
    });
    live.set(9101, { status: "resolved", updatedAt: V2 });
    live.set(9102, { status: "resolved", updatedAt: V2 });
    live.set(9103, { status: "resolved", updatedAt: V2 });
    await reconcileUnconfirmedCloses({ tenantId, base: appDb, deps });
    expect(reads).toEqual([9101]);
    expect((await mirror(9101)).status).toBe("resolved");
    expect((await mirror(9103)).status).toBe("pending");
  });

  test("a close Chatwoot reopened since is left reopened, its stamp cleared once nothing else writes the row, and is then not read again (catches the pass closing a customer's new episode, or reading it forever)", async () => {
    await seedConversation(9104, {
      resolvedBy: "followup_abandonment",
      resolvedByAt: V1 - 1_000,
      updatedAgoMs: STALE_MS + 60_000,
    });
    live.set(9104, { status: "pending", updatedAt: V3 });
    const age = () =>
      suDb.$executeRaw`UPDATE conversations SET updated_at = now() - interval '2 hours' WHERE tenant_id = ${tenantId}`;
    await reconcileUnconfirmedCloses({ tenantId, base: appDb, deps });
    const m = await mirror(9104);
    expect([m.status, m.chatwootStatusAt]).toEqual(["pending", V3]);
    // The reconcile wrote the row, so this pass leaves the stamp; the next stale pass clears it.
    await age();
    await reconcileUnconfirmedCloses({ tenantId, base: appDb, deps });
    expect((await mirror(9104)).resolvedBy).toBeNull();
    reads = [];
    await age();
    await reconcileUnconfirmedCloses({ tenantId, base: appDb, deps });
    expect(reads).toEqual([]);
  });

  test("closes that could not be read go to the back, so a down instance cannot hold the batch (catches healthy closes never reached)", async () => {
    await seedConversation(9109, {
      resolvedBy: "agent",
      resolvedByAt: V1 - 1_000,
      updatedAgoMs: STALE_MS + 120_000,
    });
    await seedConversation(9110, {
      resolvedBy: "agent",
      resolvedByAt: V1 - 1_000,
      updatedAgoMs: STALE_MS + 60_000,
    });
    live.set(9109, 503);
    live.set(9110, { status: "resolved", updatedAt: V2 });
    const now = new Date(Date.now() + STALE_MS + 180_000);
    await reconcileUnconfirmedCloses({
      tenantId,
      base: appDb,
      deps,
      batch: 1,
      now,
    });
    await reconcileUnconfirmedCloses({
      tenantId,
      base: appDb,
      deps,
      batch: 1,
      now,
    });
    expect(reads).toEqual([9109, 9110]);
    expect((await mirror(9110)).status).toBe("resolved");
  });

  test("closes skipped behind a failed read go to the back too (catches a down instance's unread closes holding the batch)", async () => {
    for (const [c, ago] of [
      [9114, 180_000],
      [9115, 120_000],
      [9116, 60_000],
    ] as const) {
      await seedConversation(c, {
        resolvedBy: "agent",
        resolvedByAt: V1 - 1_000,
        updatedAgoMs: STALE_MS + ago,
      });
    }
    live.set(9114, 503);
    live.set(9115, 503);
    live.set(9116, { status: "resolved", updatedAt: V2 });
    const now = new Date(Date.now() + STALE_MS + 240_000);
    await reconcileUnconfirmedCloses({
      tenantId,
      base: appDb,
      deps,
      batch: 2,
      now,
    });
    reads = [];
    await reconcileUnconfirmedCloses({
      tenantId,
      base: appDb,
      deps,
      batch: 2,
      now,
    });
    expect(reads[0]).toBe(9116);
  });

  test("a pass reads nothing past its budget, and leaves what it did not read as it was (catches a backlog running the sweep job past its deadline)", async () => {
    await seedConversation(9111, {
      resolvedBy: "agent",
      resolvedByAt: V1 - 1_000,
      updatedAgoMs: STALE_MS + 60_000,
    });
    await seedConversation(9112);
    const row = await strand(9112, "conversation_resolved");
    live.set(9111, { status: "resolved", updatedAt: V2 });
    live.set(9112, { status: "resolved", updatedAt: V2 });
    await sweepStrandedDeliveries({
      tenantId,
      base: appDb,
      deps,
      readBudgetMs: 0,
    });
    await reconcileUnconfirmedCloses({
      tenantId,
      base: appDb,
      deps,
      readBudgetMs: 0,
    });
    expect(reads).toEqual([]);
    expect(await ledger(row)).toEqual({ status: "PROCESSING", attempts: 0 });
    expect((await mirror(9111)).resolvedBy).toBe("agent");
  });

  test("the repaired close is announced to open consoles (catches a list left showing pending after the repair)", async () => {
    const id = await seedConversation(9105, {
      resolvedBy: "agent",
      resolvedByAt: V1 - 1_000,
      updatedAgoMs: STALE_MS + 60_000,
    });
    live.set(9105, { status: "resolved", updatedAt: V2 });
    await reconcileUnconfirmedCloses({ tenantId, base: appDb, deps });
    expect(published).toContainEqual({
      conversationId: String(id),
      status: "resolved",
    });
  });

  test("an instance that failed a read is not asked again for its other closes in the same pass (catches a down instance running the job past its deadline)", async () => {
    for (const c of [9107, 9108]) {
      await seedConversation(c, {
        resolvedBy: "agent",
        resolvedByAt: V1 - 1_000,
        updatedAgoMs: STALE_MS + 60_000,
      });
      live.set(c, 503);
    }
    await reconcileUnconfirmedCloses({ tenantId, base: appDb, deps });
    expect(reads).toHaveLength(1);
    expect((await mirror(9108)).resolvedBy).toBe("agent");
  });

  test("a close recorded during the read keeps its stamp on a Chatwoot that sends no version either (catches the guard trusting a null version)", async () => {
    const id = await seedConversation(9113, {
      resolvedBy: "followup_abandonment",
      resolvedByAt: null,
      updatedAgoMs: STALE_MS + 60_000,
    });
    live.set(9113, { status: "pending", updatedAt: V1 - 500 });
    onRead = async () => {
      await suDb.conversation.update({
        where: { id },
        data: { resolvedBy: "agent", resolvedByAt: null },
      });
    };
    await reconcileUnconfirmedCloses({ tenantId, base: appDb, deps });
    expect((await mirror(9113)).resolvedBy).toBe("agent");
  });

  test("a close whose own conversation fails does not hold its siblings (catches healthy closes skipped behind one bad conversation)", async () => {
    for (const [c, ago] of [
      [9117, 120_000],
      [9118, 60_000],
    ] as const) {
      await seedConversation(c, {
        resolvedBy: "agent",
        resolvedByAt: V1 - 1_000,
        updatedAgoMs: STALE_MS + ago,
      });
    }
    live.set(9117, 500);
    live.set(9118, { status: "resolved", updatedAt: V2 });
    await reconcileUnconfirmedCloses({ tenantId, base: appDb, deps });
    expect(reads).toEqual([9117, 9118]);
    expect((await mirror(9118)).status).toBe("resolved");
  });

  test("a close recorded while Chatwoot was being asked keeps its stamp (catches the pass erasing who closed a new episode)", async () => {
    const id = await seedConversation(9106, {
      resolvedBy: "followup_abandonment",
      resolvedByAt: V1 - 1_000,
      updatedAgoMs: STALE_MS + 60_000,
    });
    live.set(9106, { status: "pending", updatedAt: V1 - 500 });
    onRead = async () => {
      await suDb.conversation.update({
        where: { id },
        data: { resolvedBy: "agent", resolvedByAt: V3 },
      });
    };
    await reconcileUnconfirmedCloses({ tenantId, base: appDb, deps });
    expect((await mirror(9106)).resolvedBy).toBe("agent");
  });
});
