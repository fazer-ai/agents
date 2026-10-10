import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  invalidateRouteTokenCache,
  writeRouteTokenCache,
} from "@/modules/chatwoot/route-token-cache";
import {
  processRecordedChatwootDelivery,
  receiveChatwootWebhook,
} from "@/modules/chatwoot/webhook";
import {
  generateRouteToken,
  hashRouteToken,
} from "@/modules/webhooks/inbound/route-token";
import { seedChatwootInstance } from "../utils/chatwoot";

// A delivery-status change (source_id, delivered, read) re-sends the whole message as
// `message_updated`, and the payload says nothing about what moved. One that repeats, for everything
// the receiver normalizes, what this process already processed for the message and mirrored for the
// conversation is acked with no ledger row and no transaction; anything else is recorded as before.

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

const SECRET = "unchanged-update-secret";
const NOW = Math.floor(Date.now() / 1000);
const BOT = 9;
const OTHER_BOT = 10;
const sign = (body: string) =>
  `sha256=${createHmac("sha256", SECRET).update(`${NOW}.${body}`).digest("hex")}`;
const signed = (body: string, delivery: string) => (name: string) =>
  ({
    "x-chatwoot-signature": sign(body),
    "x-chatwoot-timestamp": String(NOW),
    "x-chatwoot-delivery": delivery,
  })[name.toLowerCase()] ?? null;

// The real client, with every transaction it opens counted.
function counted(client: PrismaClient, onTx: () => void): PrismaClient {
  const wrap = (target: object): object =>
    new Proxy(target, {
      get(t, prop, recv) {
        const v = Reflect.get(t, prop, recv);
        if (prop === "$transaction" || prop === "$queryRaw") {
          return (...args: unknown[]) => {
            onTx();
            return (v as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        if (prop === "$extends") {
          return (...args: unknown[]) =>
            wrap((v as (...a: unknown[]) => object).apply(t, args));
        }
        return v;
      },
    });
  return wrap(client as unknown as object) as PrismaClient;
}

// A client that cannot open a transaction.
function refusing(): PrismaClient {
  const c = {
    $transaction: () => {
      throw new Error("the pool refused");
    },
    $extends: () => c,
  };
  return c as unknown as PrismaClient;
}

let tenantId = 0n;
let instanceId = 0n;
const tokens: Record<number, string> = {};
let seq = 0;

interface Shape {
  conv: number;
  msg: number;
  type?: "incoming" | "outgoing" | "template";
  sender?: { id: number; name: string; type: string } | null;
  content?: string;
  externalError?: string;
  labels?: string[];
  updatedAt?: number;
  inboxName?: string;
  contactName?: string;
}

const body = (event: string, s: Shape) =>
  JSON.stringify({
    event,
    id: s.msg,
    content: s.content ?? "resposta",
    message_type: s.type ?? "outgoing",
    private: false,
    created_at: "2026-10-10T12:00:00Z",
    source_id: "wamid.X",
    sender:
      s.sender === undefined
        ? { id: BOT, name: "Atendente", type: "agent_bot" }
        : s.sender,
    content_attributes: s.externalError
      ? { external_error: s.externalError }
      : {},
    inbox: { id: 7, name: s.inboxName ?? "WhatsApp" },
    conversation: conversation(s),
  });

const conversation = (s: Shape) => ({
  id: s.conv,
  inbox_id: 7,
  status: "pending",
  channel: "Channel::Api",
  last_activity_at: 1_791_000_000,
  updated_at: s.updatedAt ?? 1_791_000_100.5,
  labels: s.labels ?? [],
  custom_attributes: {},
  contact_inbox: { id: 77 },
  meta: {
    assignee_type: null,
    assignee: null,
    sender: { id: 501, name: s.contactName ?? "Cliente", phone_number: null },
  },
});

const conversationUpdated = (s: Shape) =>
  JSON.stringify({ event: "conversation_updated", ...conversation(s) });

const rowsOf = (delivery: string) =>
  suDb.chatwootWebhookDelivery.count({
    where: { chatwootInstanceId: instanceId, deliveryId: delivery },
  });

// The live path: the ack, then the processing the controller dispatches, awaited.
async function deliver(
  raw: string,
  opts: { bot?: number; processBase?: PrismaClient } = {},
) {
  const delivery = `uu-${process.pid}-${++seq}`;
  let tx = 0;
  const r = await receiveChatwootWebhook({
    routeToken: tokens[opts.bot ?? BOT] as string,
    rawBody: raw,
    getHeader: signed(raw, delivery),
    nowSeconds: NOW,
    base: counted(appDb, () => tx++),
    ackBase: counted(appDb, () => tx++),
  });
  let processError: unknown = null;
  if (r.outcome === "queued" && r.dispatch && r.normalized) {
    try {
      await processRecordedChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: r.deliveryRowId as bigint,
        agentBotId: r.agentBotId ?? null,
        normalized: r.normalized,
        receiptBindingGeneration: r.receiptBindingGeneration ?? null,
        base: opts.processBase ?? appDb,
      });
    } catch (e) {
      processError = e;
    }
  }
  return {
    outcome: r.outcome,
    ackTx: tx,
    rows: await rowsOf(delivery),
    processError,
  };
}

const warm = (bot: number) =>
  writeRouteTokenCache(hashRouteToken(tokens[bot] as string), {
    tenantId,
    instanceId,
    agentBotId: bot,
    webhookSecret: encryptJson(SECRET),
  });

describe.skipIf(!dbUp)("unchanged message updates", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: {
        name: "Unchanged update",
        slug: `unchanged-update-${process.pid}`,
      },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://unchanged-update.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    for (const bot of [BOT, OTHER_BOT]) {
      const agent = await suDb.agent.create({
        data: { tenantId, name: `Atendente ${bot}`, systemPrompt: "x" },
      });
      const { token, hash } = generateRouteToken();
      tokens[bot] = token;
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: bot,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson(SECRET),
          webhookRouteTokenHash: hash,
          name: `Atendente ${bot}`,
        },
      });
      warm(bot);
    }
  });

  afterAll(async () => {
    invalidateRouteTokenCache();
    if (tenantId !== 0n) {
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
  });

  // The bug it catches: the receipt still paying the ledger row and the whole processing path.
  test("a receipt repeating the bot's processed reply is acked with no ledger row and no transaction", async () => {
    const s = { conv: 1001, msg: 91001 };
    expect((await deliver(body("message_created", s))).rows).toBe(1);
    const receipt = await deliver(body("message_updated", s));
    expect(receipt.outcome).toBe("ignored");
    expect(receipt.rows).toBe(0);
    expect(receipt.ackTx).toBe(0);
  });

  test("a template's receipt is dropped like a reply's", async () => {
    const s = { conv: 1002, msg: 91002, type: "template" as const };
    await deliver(body("message_created", s));
    expect((await deliver(body("message_updated", s))).rows).toBe(0);
  });

  // An identical update of a customer message can be the retry of an STT or ingestion that failed.
  test("a customer message's identical update is still recorded", async () => {
    const s = {
      conv: 1003,
      msg: 91003,
      type: "incoming" as const,
      sender: { id: 501, name: "Cliente", type: "contact" },
    };
    await deliver(body("message_created", s));
    await deliver(body("message_updated", s));
    expect((await deliver(body("message_updated", s))).rows).toBe(1);
  });

  test("a send failure is recorded, and so is the same failure again", async () => {
    const s = { conv: 1004, msg: 91004 };
    await deliver(body("message_created", s));
    const failed = { ...s, externalError: "131047: Re-engagement message" };
    expect((await deliver(body("message_updated", failed))).rows).toBe(1);
    expect((await deliver(body("message_updated", failed))).rows).toBe(1);
  });

  test("an edit is recorded, and a receipt of the edited message is then dropped", async () => {
    const s = { conv: 1005, msg: 91005 };
    await deliver(body("message_created", s));
    const edited = { ...s, content: "resposta editada" };
    expect((await deliver(body("message_updated", edited))).rows).toBe(1);
    expect((await deliver(body("message_updated", edited))).rows).toBe(0);
  });

  test("a receipt carrying a changed conversation is recorded", async () => {
    const s = { conv: 1006, msg: 91006 };
    await deliver(body("message_created", s));
    expect(
      (await deliver(body("message_updated", { ...s, labels: ["vendas"] })))
        .rows,
    ).toBe(1);
    expect(
      (await deliver(body("message_updated", { ...s, contactName: "Outro" })))
        .rows,
    ).toBe(1);
  });

  // The inbox name rides only on message events, so it is compared per message.
  test("a receipt carrying a renamed inbox is recorded", async () => {
    const s = { conv: 1007, msg: 91007 };
    await deliver(body("message_created", s));
    expect(
      (await deliver(body("message_updated", { ...s, inboxName: "Vendas" })))
        .rows,
    ).toBe(1);
  });

  test("the newest mirrored snapshot is the one a receipt is compared against", async () => {
    const s = { conv: 1008, msg: 91008 };
    await deliver(body("message_created", s));
    const newer = { ...s, labels: ["vip"], updatedAt: 1_791_000_200.25 };
    await deliver(conversationUpdated(newer));
    // An event about an older version, processed after the newer one, does not replace it.
    await deliver(body("message_created", { ...s, msg: 91108 }));
    expect((await deliver(body("message_updated", newer))).rows).toBe(0);
    // The snapshot the reply was created with is older than what is mirrored now.
    expect((await deliver(body("message_updated", s))).rows).toBe(1);
  });

  test("each bot route answers for its own deliveries", async () => {
    const s = { conv: 1009, msg: 91009 };
    await deliver(body("message_created", s));
    const other = await deliver(body("message_updated", s), {
      bot: OTHER_BOT,
    });
    expect(other.rows).toBe(1);
    expect(
      (await deliver(body("message_updated", s), { bot: OTHER_BOT })).rows,
    ).toBe(0);
  });

  test("a delivery whose processing failed does not vouch for its repeat", async () => {
    const s = { conv: 1010, msg: 91010 };
    const first = await deliver(body("message_created", s), {
      processBase: refusing(),
    });
    expect(first.processError).not.toBeNull();
    expect((await deliver(body("message_updated", s))).rows).toBe(1);
  });

  // A lost claim ran nothing here: the attempt holding the row may still fail.
  test("a delivery whose claim another attempt holds does not vouch for its repeat", async () => {
    const s = { conv: 1012, msg: 91012 };
    const raw = body("message_created", s);
    const delivery = `uu-${process.pid}-held`;
    const r = await receiveChatwootWebhook({
      routeToken: tokens[BOT] as string,
      rawBody: raw,
      getHeader: signed(raw, delivery),
      nowSeconds: NOW,
      base: appDb,
      ackBase: appDb,
    });
    await suDb.chatwootWebhookDelivery.update({
      where: { id: r.deliveryRowId as bigint },
      data: { status: "PROCESSING", claimedAt: new Date() },
    });
    expect(
      await processRecordedChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: r.deliveryRowId as bigint,
        agentBotId: BOT,
        normalized: r.normalized as NonNullable<typeof r.normalized>,
        receiptBindingGeneration: r.receiptBindingGeneration ?? null,
        base: appDb,
      }),
    ).toBe("skipped");
    expect((await deliver(body("message_updated", s))).rows).toBe(1);
  });

  test("an unchanged update of an event other than message_updated is recorded", async () => {
    const s = { conv: 1011, msg: 91011 };
    await deliver(body("message_created", s));
    expect((await deliver(body("message_created", s))).rows).toBe(1);
    await deliver(conversationUpdated(s));
    expect((await deliver(conversationUpdated(s))).rows).toBe(1);
  });
});
