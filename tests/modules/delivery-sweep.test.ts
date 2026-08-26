import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId } from "@/graph/checkpointer";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  ensureDeliverySweep,
  finish,
  retireCoveredDeliveries,
  sweepStrandedDeliveries,
} from "@/modules/chatwoot/delivery-sweep";
import { setConnectedAccounts } from "@/modules/chatwoot/management";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import {
  processChatwootDelivery,
  recordAndProcessChatwootDelivery,
} from "@/modules/chatwoot/webhook";
import { clearFlowLog } from "@/tests/utils/flowlog";
import { seedChatwootInstance } from "../utils/chatwoot";

// A Chatwoot delivery stranded by a process death, and the sweep that says so (issue #228).
//
// `processChatwootDelivery` brackets its work between a CAS `PENDING -> PROCESSING` and a final
// `-> PROCESSED`, with the 200 already out before either. A process that dies anywhere in there
// leaves a non-terminal row with nothing working it, and no redelivery is coming.
//
// The strand is produced here by writing the row in the state a dead process leaves behind, because
// that is the only way a live process can be in it: if the process survives to the end of the
// function, the second CAS runs. That the state is REACHABLE was measured separately, by injecting
// an interruption between the two CAS points on this repo's own code — it leaves
// `status = PROCESSING, attempts = 0`, exactly the row below.
//
// The sweep does NOT answer the customer (that is #295), so the effect asserted is the pair a
// stranded row leaves for an operator: the ledger row terminal on DEAD, and an error-level line on
// the conversation, which is what the Logs page reads and the alert channels dispatch.

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

const CHATWOOT_INBOX_ID = 61;
const AGENT_BOT_ID = 9;
const STALE_MS = 30 * 60 * 1000;

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let deliverySeq = 0;
let agentDbId = 0n;

const threadOf = (convId: number) =>
  chatwootThreadId(tenantId, instanceId, convId);

async function seedConversation(
  convId: number,
  over: { lastHandledMessageId?: number | null } = {},
) {
  return suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      inboxId: inboxDbId,
      threadId: threadOf(convId),
      lastEventAt: new Date(),
      lastHandledMessageId: over.lastHandledMessageId ?? null,
      contactInboxId: 61_000 + convId,
    },
    select: { id: true },
  });
}

// A ledger row in the state a process death leaves behind.
async function seedStrandedDelivery(over: {
  conversationId: number | null;
  ageMs: number;
  // How long ago the CURRENT attempt claimed the row, when something has. Omitted = never claimed.
  claimedAgoMs?: number;
  inboundMessageId?: number | null;
  status?: "PENDING" | "PROCESSING";
  event?: string;
}): Promise<bigint> {
  deliverySeq += 1;
  const row = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `sweep-${process.pid}-${deliverySeq}`,
      event: over.event ?? "message_created",
      status: over.status ?? "PROCESSING",
      receivedAt: new Date(Date.now() - over.ageMs),
      claimedAt:
        over.claimedAgoMs === undefined
          ? null
          : new Date(Date.now() - over.claimedAgoMs),
      conversationId: over.conversationId,
      inboundMessageId: over.inboundMessageId ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

async function statusOf(rowId: bigint) {
  return suDb.chatwootWebhookDelivery.findUniqueOrThrow({
    where: { id: rowId },
    select: { status: true, processedAt: true },
  });
}

// Polled and scoped: emitFlowEvent is fire-and-forget, so an unpolled read races the write it is
// asserting and an unscoped one answers with a neighbour's row.
//
// The conversation is REQUIRED, not optional-with-a-fallback. It used to be nullable, spreading the
// filter in only when a caller had one, and that shape is a scoped read that quietly becomes a
// tenant-wide one on the argument — the exact reader tests/modules/flowlog-reader-scope.test.ts
// exists to catch. The line that names no conversation is a different subject and has its own
// reader below.
async function deliveryLines(convDbId: bigint, waitMs = 2000) {
  const started = Date.now();
  while (true) {
    const rows = await suDb.executionLog.findMany({
      where: { tenantId, stage: "delivery", conversationId: convDbId },
      select: { level: true, status: true, source: true, detail: true },
    });
    if (rows.length > 0 || Date.now() - started > waitMs) return rows;
    await Bun.sleep(25);
  }
}

// The `outcome` on the single line a correction leaves, for the conversation Chatwoot calls
// `convId`. Same two obligations as the readers above, and it asserts the count before reading the
// line: a second line would mean two corrections raced, and reading `[0]` of that would answer with
// whichever landed first instead of failing.
async function correctionOutcome(convId: number) {
  const conv = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { id: true },
  });
  const deadline = Date.now() + 2000;
  let lines: Array<{ detail: unknown }> = [];
  while (Date.now() < deadline) {
    lines = await suDb.executionLog.findMany({
      where: { tenantId, conversationId: conv.id, stage: "delivery" },
      select: { detail: true },
    });
    if (lines.length > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(lines).toHaveLength(1);
  const line = lines[0];
  if (line === undefined) throw new Error("no correction line was written");
  return (line.detail as Record<string, unknown>).outcome;
}

// The line a strand leaves when the mirror does not know the conversation: no conversation id to
// scope by, so it is found by its absence. Polled for the same reason as the scoped read.
async function unscopedDeliveryLines(waitMs = 2000) {
  const started = Date.now();
  while (true) {
    const rows = await suDb.executionLog.findMany({
      where: { tenantId, stage: "delivery", conversationId: null },
      select: { level: true, detail: true },
    });
    if (rows.length > 0 || Date.now() - started > waitMs) return rows;
    await Bun.sleep(25);
  }
}

describe.skipIf(!dbUp)("a delivery stranded by a process death", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SWP", slug: `swp-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 61,
      baseUrl: "https://chat.sweep.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {},
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
        webhookRouteTokenHash: `swp-route-${process.pid}`,
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

  test("cannot be recovered by a redelivery: the CAS matches nothing", async () => {
    const convId = 8801;
    await seedConversation(convId);
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
      inboundMessageId: 9001,
    });
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: 9001,
      private: false,
      content: "oi, continua aí?",
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
      conversation: {
        id: convId,
        inbox_id: CHATWOOT_INBOX_ID,
        status: "pending",
        contact_inbox: { id: 61_000 + convId },
        meta: { assignee: null, sender: { id: 77, name: "Cliente" } },
        channel: "Channel::Api",
        last_activity_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      },
    });
    if (!n) throw new Error("payload did not normalize");

    // This is what every redelivery of that event does, and why the message is lost: Chatwoot's
    // retry ladder is spent, and even a manual replay walks into the same closed door.
    const outcome = await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: rowId,
      agentBotId: AGENT_BOT_ID,
      normalized: n,
      base: appDb,
    });
    expect(outcome).toBe("skipped");
    expect((await statusOf(rowId)).status).toBe("PROCESSING");

    // Dropped here because the sweep is tenant-wide: left behind, this row is a second stranded
    // delivery for every later test's pass, and their counts would be about two rows.
    await suDb.chatwootWebhookDelivery.delete({ where: { id: rowId } });
  });

  test("is recorded as a loss the operator can find", async () => {
    const convId = 8802;
    const messageId = 9101;
    // No posted reply has reached this message: nothing ever answered it.
    const conv = await seedConversation(convId);
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
      inboundMessageId: messageId,
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.lost).toBe(1);

    // Terminal, and DEAD rather than PROCESSED: `WHERE status = 'DEAD'` is the list of customers
    // who wrote and were never answered, and closing it as PROCESSED would hide it from that list.
    const row = await statusOf(rowId);
    expect(row.status).toBe("DEAD");
    expect(row.processedAt).not.toBeNull();

    // The half an operator actually reads: an error line ON the conversation, which is what the
    // Logs page renders and what the alert channels dispatch.
    const lines = await deliveryLines(conv.id);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    if (line === undefined) throw new Error("no delivery line was written");
    expect(line.level).toBe("error");
    // `inbox`, and it is load-bearing: `dispatchAlertsForEvent` fans out warn/error lines to the
    // Discord and webhook channels ONLY for inbox traffic, because a playground error must not
    // page. Filed as playground, the row would still render on the Logs page and reach nobody.
    expect(line.source).toBe("inbox");
    const detail = line.detail as Record<string, unknown>;
    expect(detail.outcome).toBe("stranded");
    expect(detail.messageId).toBe(messageId);
    expect(detail.knownToMirror).toBe(true);
  });

  test("records a PENDING strand too, which the CAS never reached", async () => {
    // The ack is spent before the ledger row is written, so a death between the insert and the CAS
    // leaves PENDING. #226's answer — a redelivery goes on to the CAS instead of being dropped —
    // only helps when a redelivery arrives, and Chatwoot holds a 200, so usually none does.
    const convId = 8803;
    const messageId = 9201;
    const conv = await seedConversation(convId);
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
      inboundMessageId: messageId,
      status: "PENDING",
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.lost).toBe(1);
    expect((await statusOf(rowId)).status).toBe("DEAD");
    expect((await deliveryLines(conv.id))[0]?.level).toBe("error");
  });

  test("leaves a delivery that is still in flight alone", async () => {
    const convId = 8804;
    const conv = await seedConversation(convId);
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: 5_000,
      inboundMessageId: 9301,
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.lost).toBe(0);
    expect(counts.closed).toBe(0);
    expect((await statusOf(rowId)).status).toBe("PROCESSING");
    expect(await deliveryLines(conv.id, 200)).toHaveLength(0);

    await suDb.chatwootWebhookDelivery.delete({ where: { id: rowId } });
  });

  test("leaves a long-received row alone when the CURRENT attempt just claimed it", async () => {
    // A redelivery is deliberately allowed through to the CAS on a row stranded on PENDING (the row
    // existing is not the same as the work having been done), so a live attempt can begin long after
    // the receipt. Judged by the receipt, this attempt looks abandoned the instant it starts, and
    // the sweep would mark it DEAD and page an operator while the process answering it is still
    // running — and then that process's own tx2 would find the row gone from under it.
    const convId = 8822;
    const messageId = 9951;
    const conv = await seedConversation(convId);
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      // Received hours ago...
      ageMs: STALE_MS * 4,
      // ...but claimed a minute ago, by the attempt that is running right now.
      claimedAgoMs: 60_000,
      inboundMessageId: messageId,
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.lost).toBe(0);
    expect(counts.closed).toBe(0);
    // Untouched: still PROCESSING, and no line, because nothing was decided about it.
    expect((await statusOf(rowId)).status).toBe("PROCESSING");
    expect(await deliveryLines(conv.id, 200)).toHaveLength(0);

    await suDb.chatwootWebhookDelivery.delete({ where: { id: rowId } });
  });

  test("still reports a claimed row once the CLAIM itself goes stale", async () => {
    // The other half of the clock above: a claim is not a shield, it is a restart of the same fence.
    // An attempt that claimed the row and then died is exactly what this sweep is for.
    const convId = 8823;
    const messageId = 9961;
    const conv = await seedConversation(convId);
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 4,
      claimedAgoMs: STALE_MS * 2,
      inboundMessageId: messageId,
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.lost).toBe(1);
    expect((await statusOf(rowId)).status).toBe("DEAD");
    expect(await deliveryLines(conv.id)).toHaveLength(1);

    await clearFlowLog(suDb, { conversationId: conv.id });
    await suDb.chatwootWebhookDelivery.delete({ where: { id: rowId } });
  });

  test("a batch full of live attempts does not starve an older strand", async () => {
    // FAIRNESS, and it only shows once the batch is full. The pass is capped and ordered by
    // `received_at`, but a row's staleness is measured from its CURRENT attempt — so rows received
    // long ago and RECLAIMED a moment ago sort first and fill every slot, while a genuinely stranded
    // row with a newer receipt is skipped pass after pass. Batch of two here rather than a fixture
    // of five hundred; the boundary is the same one.
    const convId = 8824;
    const messageId = 9971;
    const conv = await seedConversation(convId);
    // Two rows old enough to sort first, both claimed a minute ago: live attempts.
    const live = [];
    for (const n of [0, 1]) {
      live.push(
        await seedStrandedDelivery({
          conversationId: convId,
          ageMs: STALE_MS * 10 + n,
          claimedAgoMs: 60_000,
          inboundMessageId: 9980 + n,
        }),
      );
    }
    // And the one that matters: received AFTER them, never claimed, long past stale.
    const starved = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
      inboundMessageId: messageId,
    });

    const counts = await sweepStrandedDeliveries({
      tenantId,
      base: appDb,
      batch: 2,
    });
    expect(counts.lost).toBe(1);
    expect((await statusOf(starved)).status).toBe("DEAD");
    // The live ones were never in the batch to begin with, so they are untouched.
    for (const id of live) {
      expect((await statusOf(id)).status).toBe("PROCESSING");
    }

    await clearFlowLog(suDb, { conversationId: conv.id });
    await suDb.chatwootWebhookDelivery.deleteMany({
      where: { id: { in: [...live, starved] } },
    });
  });

  test("closes a strand that carried no inbound message", async () => {
    // A conversation update, or the bot's own reply coming back around as a `message_created`.
    // Neither is a customer waiting.
    //
    // CLAIMED, because that is what a row this build produced looks like: tx1 stamps every one it
    // works. The null inbound id can only be read as "nothing was there" on a row whose build was
    // recording it — see the next test for the row where it cannot.
    const convId = 8806;
    const conv = await seedConversation(convId);
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
      claimedAgoMs: STALE_MS * 2,
      inboundMessageId: null,
      event: "conversation_updated",
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.closed).toBe(1);
    expect(counts.lost).toBe(0);
    expect((await statusOf(rowId)).status).toBe("PROCESSED");
    expect(await deliveryLines(conv.id, 200)).toHaveLength(0);
  });

  test("closes an event that could never carry a message, ids or no ids", async () => {
    // MEASURED against the local fork (4.16.0): an Agent Bot receives seven events, and
    // `webwidget_triggered` is the one whose body is a CONTACT_INBOX — captured with a top-level
    // `id` of 69, the contact_inbox id, and no `conversation` key at all. `normalize.ts` reads a
    // conversation id from nothing but the two shapes that ARE a conversation or a message (issue
    // #257), so it reaches the ledger with both ids null and, if the process dies before the claim,
    // no claim stamp either — byte for byte the signature the next test reads as "a build whose
    // columns we cannot trust", on a row where the nulls mean exactly what they say.
    const rowId = await seedStrandedDelivery({
      conversationId: null,
      ageMs: STALE_MS * 2,
      status: "PENDING",
      inboundMessageId: null,
      event: "webwidget_triggered",
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.closed).toBe(1);
    expect(counts.lost).toBe(0);
    expect((await statusOf(rowId)).status).toBe("PROCESSED");
    expect(await unscopedDeliveryLines(200)).toHaveLength(0);
    await suDb.chatwootWebhookDelivery.delete({ where: { id: rowId } });
  });

  test("reports a row the OLD container stranded during a rolling deploy", async () => {
    // The migration closes what exists when it runs, and then the container still serving keeps
    // acking webhooks until it is stopped. That build writes neither id and does not stamp the
    // claim, so a row it strands carries nothing but its status — and read literally, every message
    // it lost would be closed as "carried none". The missing claim stamp is the tell: tx1 writes one
    // on every row THIS build works, so a PROCESSING row without it was claimed by a build whose
    // nulls mean "unrecorded".
    const rowId = await seedStrandedDelivery({
      conversationId: null,
      ageMs: STALE_MS * 2,
      // No claimedAgoMs: the old tx1 had no column to stamp.
      inboundMessageId: null,
      event: "message_created",
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.lost).toBe(1);
    expect(counts.closed).toBe(0);
    expect((await statusOf(rowId)).status).toBe("DEAD");
    // Filed without a conversation, because that is all the row can say.
    const lines = await unscopedDeliveryLines();
    expect(lines.length).toBeGreaterThan(0);

    await clearFlowLog(suDb, { tenantId });
    await suDb.chatwootWebhookDelivery.delete({ where: { id: rowId } });
  });

  test("reports a loss even when the mirror does not know the conversation", async () => {
    // The process died before the mirror write, so there is no watermark to compare against. The
    // safe reading of a question that cannot be answered is the one that puts the row in front of
    // an operator, and the line is filed without a conversation because it is the only trace there
    // is.
    const rowId = await seedStrandedDelivery({
      conversationId: 8899,
      ageMs: STALE_MS * 2,
      inboundMessageId: 9501,
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.lost).toBe(1);
    expect((await statusOf(rowId)).status).toBe("DEAD");

    const lines = await unscopedDeliveryLines();
    expect(lines).toHaveLength(1);
    const line = lines[0];
    if (line === undefined) throw new Error("no delivery line was written");
    expect((line.detail as Record<string, unknown>).knownToMirror).toBe(false);
  });

  test("writes nothing over a row that moved under it", async () => {
    // The terminal write CASes on the status the scan read. Losing that race means a redelivery
    // claimed the row in between and is processing the event right now — the outcome this sweep
    // exists to report the absence of — so nothing is recorded. Asked directly: a constructed race
    // here goes green for the wrong reason more often than it detects.
    const rowId = await seedStrandedDelivery({
      conversationId: 8807,
      ageMs: STALE_MS * 2,
      inboundMessageId: 9601,
      status: "PENDING",
    });
    const stale = {
      id: rowId,
      status: "PENDING" as const,
      chatwootInstanceId: instanceId,
      deliveryId: "x",
      event: "message_created",
      receivedAt: new Date(),
      claimedAt: null,
      conversationId: 8807,
      inboundMessageId: 9601,
    };
    // Somebody else claimed it.
    await suDb.chatwootWebhookDelivery.update({
      where: { id: rowId },
      data: { status: "PROCESSING" },
    });

    expect(await finish(stale, tenantId, "DEAD", appDb)).toBe(false);
    expect((await statusOf(rowId)).status).toBe("PROCESSING");

    await suDb.chatwootWebhookDelivery.delete({ where: { id: rowId } });
  });

  test("retires the row before writing the line that pages an operator", async () => {
    // ORDERING, and it is the reverse of what an earlier round of this PR did. `writeFlowEvent`
    // DISPATCHES the alert as it writes — Discord, a webhook, somebody's phone — and nothing can
    // retract that. Written before the CAS, the sweep pages an operator that a customer was never
    // answered every time a redelivery claimed the row in between, which is a designed path here,
    // not an infrastructure failure. There is no seam that makes the flow write fail against a real
    // database without faking the client out from under `runScopedOn`, so the order is asserted
    // where it is written.
    const src = await Bun.file(
      new URL("../../src/modules/chatwoot/delivery-sweep.ts", import.meta.url),
    ).text();
    const body = src.slice(src.indexOf("async function record("));
    const write = body.indexOf("await writeFlowEvent(");
    const retire = body.indexOf('finish(row, tenantId, "DEAD", base)');
    expect(write).toBeGreaterThan(-1);
    expect(retire).toBeGreaterThan(-1);
    expect(retire).toBeLessThan(write);
    // And losing the CAS has to stop, not fall through to the line.
    expect(body.slice(retire, write)).toContain("counts.raced += 1");
  });

  test("the receiver settles at the DECISION, not after its tail work", async () => {
    // ORDERING, and it only shows on failure. tx2 is the natural place to record that a delivery
    // finished and much too late to record that its MESSAGE is settled: the error clearing, the
    // follow-up arming, the redirect re-arm, the ingestion pass and the watermark tail all sit in
    // between, each taking its own time, and a process dying in that stretch leaves PROCESSING on a
    // message whose fate was already sealed. Asserted at the source, since a passing run cannot tell
    // an early write from a late one.
    const src = await Bun.file(
      new URL("../../src/modules/chatwoot/webhook.ts", import.meta.url),
    ).text();
    const body = src.slice(
      src.indexOf("export async function processChatwootDelivery("),
    );
    const settle = body.indexOf("await settleDelivery(");
    const ingest = body.indexOf("await ingestUnhandledMessage(");
    const tx2 = body.indexOf("// tx2: mark processed.");
    expect(settle).toBeGreaterThan(-1);
    expect(ingest).toBeGreaterThan(-1);
    expect(tx2).toBeGreaterThan(-1);
    expect(settle).toBeLessThan(ingest);
    expect(settle).toBeLessThan(tx2);
    // And the gate tail settles at its own decision, which is also before the ingestion.
    expect(body.lastIndexOf("await settleDelivery(")).toBeLessThan(ingest);
  });

  test("a flow write that fails is never swallowed, on either line", async () => {
    // Both lines this file writes are the only trace of something an operator has to see, and both
    // are written after the row has already moved — so a failed write loses the trace for good and
    // nothing retries it. Neither branch can be reached behaviourally: making `writeFlowEvent` fail
    // against a real database means faking the client out from under `runScopedOn`, which proves
    // nothing about the shipped code. Asserted where it is written instead.
    const src = await Bun.file(
      new URL("../../src/modules/chatwoot/delivery-sweep.ts", import.meta.url),
    ).text();
    // The loss line: the row is DEAD by then and stays in the list, so this degrades a notification.
    const record = src.slice(src.indexOf("async function record("));
    expect(record).toContain("if (!written.delivered)");
    // The correction line: the row has LEFT the list, so this one is the only thing that could have
    // closed the alert already dispatched. Error, not warn.
    const retire = src.slice(
      src.indexOf("export async function retireCoveredDeliveries("),
      src.indexOf("async function record("),
    );
    expect(retire).toContain("if (!written.delivered)");
    expect(retire.slice(retire.indexOf("if (!written.delivered)"))).toContain(
      "logger.error(",
    );
  });

  test("is armed when a Chatwoot account is connected, not only at boot", async () => {
    // The boot arm alone leaves a first-run install with nothing: `/setup` creates the tenant after
    // boot has already counted zero tenants, and there is no second arming point.
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId} AND kind = 'DELIVERY_SWEEP'`,
    );
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
    // A NEW account: account 61 is already connected by the seed, and reconnecting an active one
    // takes a branch that creates nothing.
    await setConnectedAccounts(
      ctx,
      [61, 62],
      { makeClient: async () => ({ listInboxes: async () => [] }) as never },
      appDb,
    );
    const job = await suDb.schedulerJob.findFirst({
      where: { tenantId, kind: "DELIVERY_SWEEP" },
      select: { status: true },
    });
    expect(job?.status).toBe("PENDING");
  });

  test("a re-arm revives the row and KEEPS the budget the last pass spent", async () => {
    // The sweep is one perpetual row per tenant, and a boot or a newly connected account re-arming
    // it is the SAME unit of work — the answer `enqueueJob` requires and cannot derive (#339). So
    // the row comes back PENDING and its `attempts` survive: a sweep that keeps failing must not get
    // five fresh attempts every time somebody connects an account, which is the cap doing nothing.
    //
    // What clears the budget is a pass that COMPLETED, on its way out through `rescheduleJob`
    // (#287/#337), which is the other half of the same rule and the reason this half is safe: a
    // sweep that works never accumulates, and one that does not keeps its count.
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId} AND kind = 'DELIVERY_SWEEP'`,
    );
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DELIVERY_SWEEP",
        dedupeKey: "delivery-sweep",
        runAt: new Date(),
        status: "DEAD",
        attempts: 4,
        payload: {},
      },
    });

    await ensureDeliverySweep(tenantId, appDb);

    const job = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, kind: "DELIVERY_SWEEP" },
      select: { status: true, attempts: true },
    });
    expect(job.status).toBe("PENDING");
    expect(job.attempts).toBe(4);
  });

  test("records the two ids recovery needs, and only for an INBOUND message", async () => {
    const convId = 8808;
    await seedConversation(convId);
    const incoming = await deliverThrough(convId, 9701, "incoming");
    expect(incoming.conversationId).toBe(convId);
    expect(incoming.inboundMessageId).toBe(9701);

    // The bot's own reply comes back as a `message_created` too. Recorded with no inbound id, which
    // is what stops a stranded outgoing delivery from being reported as a customer left unanswered.
    const outgoing = await deliverThrough(convId, 9702, "outgoing");
    expect(outgoing.conversationId).toBe(convId);
    expect(outgoing.inboundMessageId).toBeNull();

    // And an incoming `message_updated` — usually our own media write-back coming back around. It
    // is incoming, but it drives no turn, so nobody is waiting on it either.
    const updated = await deliverThrough(convId, 9703, "incoming", {
      event: "message_updated",
    });
    expect(updated.conversationId).toBe(convId);
    expect(updated.inboundMessageId).toBeNull();
  });

  test("the DIRECT path retires its own row as soon as the reply is out", async () => {
    // The window this closes: `runAgentTurn` posts inline and tx2 is several steps later — the
    // ingestion pass, the compaction arming, the watermark tail — so a process that dies in that
    // stretch leaves PROCESSING on a message the customer already has an answer to, and the sweep
    // would report it as a loss and page somebody.
    //
    // Observed through a SECOND ledger row for the same message: `retireCoveredDeliveries` is a
    // blind write by conversation and message id, so it takes both, while tx2 only ever touches its
    // own row by primary key. A PROCESSED sibling is therefore proof the retirement ran, and not
    // just proof that tx2 did.
    const convId = 8810;
    const messageId = 9721;
    await seedConversation(convId);
    const sibling = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `direct-sibling-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });

    // Debounce OFF for this one: the direct path is the subject, and with it on the delivery arms a
    // flush and returns without ever running a turn.
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { settings: { debounce: { enabled: false } } },
    });

    // A second sibling the sweep had ALREADY reported, so the correction path runs too.
    const reportedSibling = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `direct-reported-${process.pid}`,
        event: "message_created",
        status: "DEAD",
        processedAt: new Date(Date.now() - 60_000),
        receivedAt: new Date(Date.now() - 120_000),
        conversationId: convId,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });

    const sent: Array<[number, string]> = [];
    const client = {
      getMessages: async () => ({ payload: [] }),
      sendMessage: async (conversationId: number, content: string) => {
        sent.push([conversationId, content]);
        return {};
      },
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;

    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageId,
      private: false,
      content: "oi",
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
      conversation: {
        id: convId,
        inbox_id: CHATWOOT_INBOX_ID,
        // The bot holds it, so the gate opens and the turn runs.
        status: "pending",
        contact_inbox: { id: 61_000 + convId },
        meta: { sender: { id: 77, name: "Cliente" } },
        channel: "Channel::Api",
        last_activity_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      },
    });
    if (!n) throw new Error("payload did not normalize");
    const own = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `direct-own-${process.pid}`,
        event: "message_created",
        status: "PENDING",
        conversationId: convId,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: own.id,
      agentBotId: AGENT_BOT_ID,
      normalized: n,
      base: appDb,
      deps: {
        makeModel: () =>
          new FakeListChatModel({ responses: ["claro!"] }) as BaseChatModel,
        makeClient: async () => client,
        checkpointer: new MemorySaver(),
      },
    });

    expect(sent).toEqual([[convId, "claro!"]]);
    expect((await statusOf(sibling.id)).status).toBe("PROCESSED");
    // The reply DID reach the customer, so a row this turn takes back out of the loss list is closed
    // as answered — the one caller that can tell the difference has to report it.
    expect((await statusOf(reportedSibling.id)).status).toBe("PROCESSED");
    expect(await correctionOutcome(convId)).toBe("answered_late");

    await suDb.agent.update({
      where: { id: agentDbId },
      data: { settings: {} },
    });
    await suDb.chatwootWebhookDelivery.deleteMany({
      where: { id: { in: [own.id, sibling.id, reportedSibling.id] } },
    });
    await clearFlowLog(suDb, { tenantId });
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
  });

  test("a message_updated settles nothing: it is our own write-back coming around", async () => {
    // An incoming `message_updated` is usually the media write-back we just made, and `runAgentTurn`
    // no-ops on it — nobody answered anything. But it carries the SAME message id, and the ledger row
    // that does hold that id as an inbound message is the original `message_created`, which is
    // exactly the row that may be stranded. Without the new-incoming guard this event would retire
    // it and hide a real loss.
    const convId = 8826;
    const messageId = 9751;
    await seedConversation(convId);
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { settings: { debounce: { enabled: false } } },
    });
    const original = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `updated-original-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });

    const client = {
      getMessages: async () => ({ payload: [] }),
      sendMessage: async () => ({}),
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;
    const n = normalizeChatwootEvent({
      event: "message_updated",
      id: messageId,
      private: false,
      content: "oi",
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
      conversation: {
        id: convId,
        inbox_id: CHATWOOT_INBOX_ID,
        // Held by the bot, so this reaches the direct path rather than a gate exit.
        status: "pending",
        contact_inbox: { id: 61_000 + convId },
        meta: { sender: { id: 77, name: "Cliente" } },
        channel: "Channel::Api",
        last_activity_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      },
    });
    if (!n) throw new Error("payload did not normalize");
    const own = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `updated-own-${process.pid}`,
        event: "message_updated",
        status: "PENDING",
        conversationId: convId,
        inboundMessageId: null,
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: own.id,
      agentBotId: AGENT_BOT_ID,
      normalized: n,
      base: appDb,
      deps: {
        makeModel: () =>
          new FakeListChatModel({ responses: ["claro!"] }) as BaseChatModel,
        makeClient: async () => client,
        checkpointer: new MemorySaver(),
      },
    });

    expect((await statusOf(original.id)).status).toBe("PROCESSING");

    await suDb.agent.update({
      where: { id: agentDbId },
      data: { settings: {} },
    });
    await suDb.chatwootWebhookDelivery.deleteMany({
      where: { id: { in: [own.id, original.id] } },
    });
    await clearFlowLog(suDb, { tenantId });
  });

  test("a SUPERSEDED direct turn still settles: the graph ran over the message", async () => {
    // `superseded` on the DIRECT path is not what it is on the flush, and this is the test that
    // holds the two apart. On the flush it hands the burst to a re-armed flush that will answer
    // these same messages, so the rows stay open for that run to retire. Nothing is re-armed here:
    // the graph already invoked and wrote the thread state, the post gate then found a newer
    // incoming id and stood down, and it is the NEWER message's own delivery that carries the reply.
    //
    // Left open, the row is a customer-loss alert every time the process dies in the tail after a
    // supersede — the same tail every other outcome on this path is already closed before, which is
    // why the sibling below (a row nothing will take to PROCESSED) is the probe.
    const convId = 8825;
    const messageId = 9741;
    await seedConversation(convId);
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { settings: { debounce: { enabled: false } } },
    });
    const sibling = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `superseded-sibling-${process.pid}`,
        event: "message_created",
        // DEAD: the sweep already reported this message and an operator is holding the alert. That
        // makes the correction line observable, which is the only place the settlement WORD shows
        // up — and a supersede reached no customer, so the word has to be the deliberate one.
        status: "DEAD",
        receivedAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });

    const sent: Array<[number, string]> = [];
    const client = {
      // A NEWER incoming message, which is what makes the post gate stand down.
      getMessages: async () => ({
        payload: [
          {
            id: messageId + 1,
            content: "e aí?",
            message_type: 0,
            private: false,
          },
        ],
      }),
      sendMessage: async (conversationId: number, content: string) => {
        sent.push([conversationId, content]);
        return {};
      },
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;

    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageId,
      private: false,
      content: "oi",
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
      conversation: {
        id: convId,
        inbox_id: CHATWOOT_INBOX_ID,
        status: "pending",
        contact_inbox: { id: 61_000 + convId },
        meta: { sender: { id: 77, name: "Cliente" } },
        channel: "Channel::Api",
        last_activity_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      },
    });
    if (!n) throw new Error("payload did not normalize");
    const own = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `superseded-own-${process.pid}`,
        event: "message_created",
        status: "PENDING",
        conversationId: convId,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: own.id,
      agentBotId: AGENT_BOT_ID,
      normalized: n,
      base: appDb,
      deps: {
        makeModel: () =>
          new FakeListChatModel({ responses: ["claro!"] }) as BaseChatModel,
        makeClient: async () => client,
        checkpointer: new MemorySaver(),
      },
    });

    // Nothing was posted — and the message is settled anyway, on the row a tail death would have
    // left behind. "consumed", never "answered": this turn reached no customer.
    expect(sent).toEqual([]);
    expect((await statusOf(sibling.id)).status).toBe("PROCESSED");
    expect(await correctionOutcome(convId)).toBe("consumed_late");

    await suDb.agent.update({
      where: { id: agentDbId },
      data: { settings: {} },
    });
    await suDb.chatwootWebhookDelivery.deleteMany({
      where: { id: { in: [own.id, sibling.id] } },
    });
    await clearFlowLog(suDb, { tenantId });
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
  });

  test("naming no messages at all is not a call anyone can write", () => {
    // A COMPILE-time guard, held by `bun check` rather than by this run: the two ways to say what a
    // decision covered are a union, so the third combination — neither the burst nor the range —
    // does not typecheck. It is the dangerous one. Dropping all three fields once left a filter of
    // `{ chatwootInstanceId, conversationId }`, which retires every non-terminal row on the
    // conversation and closes whatever loss was sitting there, and the only thing between that call
    // and the damage was a `not: null` on a filter whose whole job is to be narrow.
    //
    // `@ts-expect-error` is the assertion: it fails the typecheck if the error stops happening.
    // @ts-expect-error — neither shape: no message bound at all, so this does not typecheck.
    const neither: Parameters<typeof retireCoveredDeliveries>[0] = {
      tenantId: 1n,
      instanceId: 1n,
      conversationId: 1,
      conversationRowId: null,
      settlement: "consumed",
      base: appDb,
    };
    expect(neither.settlement).toBe("consumed");
  });

  test("the direct path queues nothing, which is why it settles on every outcome", async () => {
    // The premise under the unconditional settle in webhook.ts, asserted where it can fail loudly.
    //
    // The flush keeps "stale" open because a /reset can retire the job that queued it, and that
    // withdrawal means nothing ever answered the burst. `runAgentTurn` has no job: the delivery IS
    // the trigger, so `stillWanted` is null and no outcome on that path can be a withdrawal. Written
    // as a source read because there is no input that reaches the branch — a run that cannot be
    // called off cannot be asked to prove it stayed uncalled-off — and a rule no test can hold does
    // not belong in the condition. If this ever stops being null, the settle above needs the same
    // exception the flush has, and this is what says so.
    const src = await Bun.file("src/graph/runtime.ts").text();
    const call = src.slice(
      src.indexOf("const outcome = await runLoadedTurn({"),
    );
    expect(call.slice(0, call.indexOf("});"))).toContain("stillWanted: null,");
  });

  test("a gate taken because ANOTHER BOT holds it settles only our own row", async () => {
    // Chatwoot fans one message to up to TWO bot routes — `agent_bots_for` returns the conversation's
    // assignee bot and the inbox's active bot, each with its own `delivery_id` — so a message can
    // hold two ledger rows that differ only by which bot received it.
    //
    // On the route that loses, the gate closes because ANOTHER PARTY holds the conversation. That is
    // a statement about US, not about the message: the other party here is a bot whose own delivery
    // may be running right now. Retiring its row by conversation and message would take a live loss
    // out of the list, and if that process then died nothing would ever report it — the exact
    // silence this whole change exists to end.
    //
    // A human holding the conversation is the opposite and keeps the wider scope: the test above is
    // that case, and it is the common one.
    //
    // The predicate is `heldByAnotherParty`, not `!act`, and the difference is not cosmetic: `act`
    // is also false when the status is not `pending`, so reading it here would call OUR OWN bot
    // another bot on every open or resolved conversation and scope away the sibling settlement on
    // the most ordinary gate exit there is. The case below is that one.
    const convId = 8827;
    const messageId = 9761;
    const other = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `otherbot-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });
    await seedConversation(convId);

    // The winning route belongs to agent bot 4242, which is not ours.
    await deliverThrough(convId, messageId, "incoming", {
      deliveryId: `ourroute-${process.pid}`,
      assignee: { type: "AgentBot", id: 4242 },
    });

    // Ours is settled — tx2 takes it either way, and the gate settled it before that.
    expect(
      (
        await suDb.chatwootWebhookDelivery.findFirstOrThrow({
          where: { tenantId, deliveryId: `ourroute-${process.pid}` },
          select: { status: true },
        })
      ).status,
    ).toBe("PROCESSED");
    // And the other route's row is untouched, still working, still reportable if it dies.
    expect((await statusOf(other.id)).status).toBe("PROCESSING");

    await suDb.chatwootWebhookDelivery.deleteMany({
      where: { conversationId: convId },
    });
    await clearFlowLog(suDb, { tenantId });
  });

  test("OUR bot on a non-pending conversation is not another bot", async () => {
    // The other side of the predicate above. A conversation assigned to our own bot and left `open`
    // takes the gate exit for a reason that has nothing to do with who holds it — the status is not
    // `pending` — and the settlement there speaks for the message as usual. Read from `!act`, the
    // assignee type alone would say "another bot" and leave a sibling row open to be reported as a
    // customer nobody answered.
    const convId = 8829;
    const messageId = 9781;
    const sibling = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `ourbot-open-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });
    await seedConversation(convId);

    await deliverThrough(convId, messageId, "incoming", {
      deliveryId: `ourbot-open-route-${process.pid}`,
      assignee: { type: "AgentBot", id: AGENT_BOT_ID },
    });

    expect((await statusOf(sibling.id)).status).toBe("PROCESSED");

    await suDb.chatwootWebhookDelivery.deleteMany({
      where: { conversationId: convId },
    });
    await clearFlowLog(suDb, { tenantId });
  });

  test("a gate advances the watermark before it settles the row", async () => {
    // The order of two writes that are not a transaction, asserted at the SOURCE because no end
    // state can show which way round they ran.
    //
    // Settle first and a death between them leaves the row terminal while the watermark still sits
    // below the message: the sweep can no longer see it, and a flush after the conversation comes
    // back to the bot re-coalesces from that watermark and ANSWERS a message a gate deliberately
    // suppressed — a reply the product decided not to send, reported by nothing. Watermark first
    // leaves the row in the worklist for a message something handled, which is a false line the next
    // turn over that message corrects.
    const src = await Bun.file("src/modules/chatwoot/webhook.ts").text();
    const tail = src.slice(
      src.indexOf(
        "A new inbound message the bot deliberately leaves unanswered",
      ),
    );
    const mark = tail.indexOf("advanceHandledWatermark");
    const settle = tail.indexOf("await settleDelivery(");
    expect(mark).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(mark);
  });

  test("retires the PROCESSING rows before it looks for DEAD ones", async () => {
    // The order of the two writes, asserted at the SOURCE, because the interleaving it protects
    // against is a write by another process landing between them and no end state can show which
    // way round they ran.
    //
    // The sweep's own write turns a covered row PROCESSING -> DEAD. DEAD first, and that transition
    // lands between the two: the DEAD statement finds nothing (the row was still PROCESSING), the
    // sweep marks it DEAD and dispatches the loss, and the PROCESSING statement finds nothing
    // either. The row stays DEAD for good, reported as a customer nobody answered, with no owner
    // left to run tx2 over it. This way round the same interleaving is harmless in both directions:
    // after, the sweep's terminal CAS is on the status it READ and matches nothing; before, the DEAD
    // statement catches the row and writes the correction.
    const src = await Bun.file("src/modules/chatwoot/delivery-sweep.ts").text();
    const body = src.slice(
      src.indexOf("export async function retireCoveredDeliveries"),
    );
    expect(body.indexOf('status: "PROCESSING"')).toBeGreaterThan(-1);
    expect(body.indexOf('status: "DEAD"')).toBeGreaterThan(
      body.indexOf('status: "PROCESSING"'),
    );
  });

  test("the correction does NOT page, and the reason is written down", async () => {
    // The gap, pinned so it stays a decision. A channel's `minLevel` defaults to "error": the loss
    // pages, and the `warn` that closes it reaches the Logs page and nobody else, so an operator who
    // was paged learns of the answer from the log or from the DEAD worklist.
    //
    // Routing it as an "error" was tried and is worse, which is why this asserts the absence rather
    // than a notification. `dispatchAlertsForEvent` coalesces a pending delivery by (channel, stage,
    // level), so a correction landing inside the loss alert's window INCREMENTS it instead of
    // closing it, and the operator gets a bigger loss alert still carrying the original's summary.
    // The alerting subsystem has no concept of a resolution for any event; half of one here buys a
    // wrong notification instead of a missing one.
    const convId = 8828;
    const conv = await seedConversation(convId);
    const channel = await suDb.alertChannel.create({
      data: {
        tenantId,
        name: `live-loss-${process.pid}`,
        type: "webhook",
        url: "enc",
        // The default, and the whole point: this channel ignores warnings.
        minLevel: "error",
      },
      select: { id: true },
    });
    const reported = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `alert-corr-${process.pid}`,
        event: "message_created",
        status: "DEAD",
        receivedAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        inboundMessageId: 9771,
      },
      select: { id: true },
    });

    await retireCoveredDeliveries({
      tenantId,
      instanceId,
      conversationId: convId,
      conversationRowId: conv.id,
      settlement: "answered",
      messageIds: [9771],
      base: appDb,
    });

    expect((await statusOf(reported.id)).status).toBe("PROCESSED");
    // Polled for the LINE, which is what says the write happened at all — then the alert queue is
    // read once. Polling for an absence only spends the timeout before answering the same thing.
    expect(await correctionOutcome(convId)).toBe("answered_late");
    const queued = await suDb.alertDelivery.findMany({
      where: { tenantId, channelId: channel.id },
      select: { level: true, stage: true },
    });
    expect(queued).toEqual([]);

    await suDb.alertDelivery.deleteMany({ where: { channelId: channel.id } });
    await suDb.alertChannel.delete({ where: { id: channel.id } });
    await suDb.chatwootWebhookDelivery.delete({ where: { id: reported.id } });
    await clearFlowLog(suDb, { tenantId });
  });

  test("a redelivery of a LEGACY row fills in what that row could not record", async () => {
    // The previous release wrote neither id, and the CAS that follows a redelivery stamps
    // `claimed_at` on the row it finds — which is exactly the signature the sweep reads as "this
    // build wrote it, so its nulls mean what they say". Left empty, a redelivery of a legacy row
    // turns a lost customer message into one the sweep closes as carrying none.
    const convId = 8815;
    const messageId = 9761;
    await seedConversation(convId);
    const legacy = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `legacy-reclaim-${process.pid}-${messageId}`,
        event: "message_created",
        status: "PENDING",
        // What the old build left behind: no conversation, no message, no claim.
        conversationId: null,
        inboundMessageId: null,
      },
      select: { id: true },
    });

    // The same delivery id arriving again, through the real receiver.
    await deliverThrough(convId, messageId, "incoming", {
      deliveryId: `legacy-reclaim-${process.pid}-${messageId}`,
    });

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: legacy.id },
      select: { conversationId: true, inboundMessageId: true },
    });
    expect(row.conversationId).toBe(convId);
    expect(row.inboundMessageId).toBe(messageId);

    // And only ever FILLS. A row this build already wrote holds the right values, and a redelivery
    // of it must not be able to move them — the ids are what the sweep and the retirement key on, so
    // a rewrite would point both at the wrong message.
    await deliverThrough(convId, messageId + 500, "incoming", {
      deliveryId: `legacy-reclaim-${process.pid}-${messageId}`,
    });
    const again = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: legacy.id },
      select: { conversationId: true, inboundMessageId: true },
    });
    expect(again.inboundMessageId).toBe(messageId);

    await suDb.chatwootWebhookDelivery.delete({ where: { id: legacy.id } });
    await clearFlowLog(suDb, { tenantId });
  });

  test("a GATE that consumes the message settles the row too", async () => {
    // The gates are the third decider, next to the direct turn and the flush, and the one with no
    // turn behind it: a human holds the conversation, or a command / test-mode / availability /
    // redirect gate consumed the message. Nothing further is coming for it deliberately, so a
    // process dying between that decision and tx2 must not turn into "a customer nobody answered".
    //
    // `deliverThrough` drives the real receiver on a conversation held by a human, which is exactly
    // that exit, and the sibling row makes the retirement observable: it is a blind write by
    // conversation and message, so it takes both, while tx2 only touches its own by primary key.
    const convId = 8811;
    const messageId = 9731;
    await seedConversation(convId);
    const sibling = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `gate-sibling-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        receivedAt: new Date(Date.now() - 60_000),
        claimedAt: new Date(Date.now() - 60_000),
        conversationId: convId,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });

    // And one the sweep had already reported, so the correction path runs from a GATE.
    const reported = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `gate-reported-${process.pid}`,
        event: "message_created",
        status: "DEAD",
        processedAt: new Date(Date.now() - 60_000),
        receivedAt: new Date(Date.now() - 120_000),
        conversationId: convId,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });

    await deliverThrough(convId, messageId, "incoming");
    expect((await statusOf(sibling.id)).status).toBe("PROCESSED");
    expect((await statusOf(reported.id)).status).toBe("PROCESSED");

    // A gate is silence by construction: nobody replied, so the closing line must not say anyone
    // did. Claiming otherwise hands an operator a resolution that never happened.
    expect(await correctionOutcome(convId)).toBe("consumed_late");

    await suDb.chatwootWebhookDelivery.deleteMany({
      where: { id: { in: [sibling.id, reported.id] } },
    });
    await clearFlowLog(suDb, { tenantId });
  });

  test("stamps the claim, so the sweep dates the ATTEMPT and not the receipt", async () => {
    // Written by tx1, through the real path. Without it the sweep has only `received_at` to judge a
    // PROCESSING row by, and a redelivery that claims a long-stranded PENDING row would be reported
    // as a lost message the instant it started working.
    const convId = 8809;
    await seedConversation(convId);
    const row = await deliverThrough(convId, 9711, "incoming");
    expect(row.claimedAt).not.toBeNull();
    // At or after the receipt: it is a later event on the same row, never a copy of the receipt.
    const claimedAt = row.claimedAt;
    if (claimedAt === null) throw new Error("the claim was not stamped");
    expect(claimedAt.getTime()).toBeGreaterThanOrEqual(
      row.receivedAt.getTime(),
    );
  });

  async function deliverThrough(
    convId: number,
    messageId: number,
    direction: "incoming" | "outgoing",
    over: {
      event?: string;
      deliveryId?: string;
      // Who holds the conversation, when it is not our bot. A human by default.
      assignee?: { type: string; id: number };
    } = {},
  ) {
    const n = normalizeChatwootEvent({
      event: over.event ?? "message_created",
      id: messageId,
      private: false,
      content: "oi",
      message_type: direction,
      sender: { id: 77, name: "Cliente", type: null },
      conversation: {
        id: convId,
        inbox_id: CHATWOOT_INBOX_ID,
        // Held by a human, so the delivery takes the gate's exit and spends no model call. What is
        // asserted is the LEDGER INSERT, which happens before any of that.
        status: "open",
        contact_inbox: { id: 61_000 + convId },
        meta: {
          assignee_type: over.assignee?.type ?? "User",
          assignee: { id: over.assignee?.id ?? 5, name: "Ana" },
          sender: { id: 77, name: "Cliente" },
        },
        channel: "Channel::Api",
        last_activity_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      },
    });
    if (!n) throw new Error("payload did not normalize");
    const deliveryId =
      over.deliveryId ?? `sweep-real-${process.pid}-${messageId}`;
    await recordAndProcessChatwootDelivery({
      tenantId,
      instanceId,
      deliveryId,
      agentBotId: AGENT_BOT_ID,
      normalized: n,
      base: appDb,
    });
    return suDb.chatwootWebhookDelivery.findFirstOrThrow({
      where: { tenantId, deliveryId },
      select: {
        conversationId: true,
        inboundMessageId: true,
        claimedAt: true,
        receivedAt: true,
      },
    });
  }
});
