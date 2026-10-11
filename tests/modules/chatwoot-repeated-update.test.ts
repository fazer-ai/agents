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
// `message_updated`, and the payload says nothing about what moved. One whose payload repeats exactly
// (the conversation's version and activity included) the last payload of the same message processed on
// the same route is acked with no ledger row and no transaction; anything else is processed as before.

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

const SECRET = "repeated-update-secret";
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
  deleted?: boolean;
  externalError?: string;
  sourceId?: string;
  messageStatus?: string;
  changedAttributes?: unknown;
  status?: string;
  assignee?: { id: number; name: string } | null;
  labels?: string[];
  customAttributes?: Record<string, unknown>;
  kanban?: Record<string, unknown>;
  updatedAt?: number | null;
  lastActivityAt?: number;
  firstReplyAt?: string | null;
  inboxName?: string;
  contactName?: string;
  contactPhone?: string | null;
  contactEmail?: string | null;
  redirectOrigin?: number | null;
  inboxClock?: number;
  contactClock?: number;
  contactAttrs?: Record<string, unknown>;
}

const body = (event: string, s: Shape) =>
  JSON.stringify({
    event,
    id: s.msg,
    content: s.content ?? "resposta",
    message_type: s.type ?? "outgoing",
    private: false,
    created_at: "2026-10-10T12:00:00Z",
    source_id: s.sourceId ?? null,
    status: s.messageStatus ?? "sent",
    ...(s.changedAttributes !== undefined
      ? { changed_attributes: s.changedAttributes }
      : {}),
    sender:
      s.sender === undefined
        ? { id: BOT, name: "Atendente", type: "agent_bot" }
        : s.sender,
    content_attributes: {
      ...(s.externalError ? { external_error: s.externalError } : {}),
      ...(s.deleted ? { deleted: true } : {}),
    },
    inbox: {
      id: 7,
      name: s.inboxName ?? "WhatsApp",
      ...(s.inboxClock !== undefined ? { updated_at: s.inboxClock } : {}),
    },
    conversation: conversation(s),
  });

const conversation = (s: Shape) => ({
  id: s.conv,
  inbox_id: 7,
  status: s.status ?? "pending",
  channel: "Channel::Api",
  last_activity_at: s.lastActivityAt ?? 1_791_000_000,
  updated_at: "updatedAt" in s ? s.updatedAt : 1_791_000_100.5,
  created_at: 1_791_000_000,
  first_reply_created_at: s.firstReplyAt ?? null,
  labels: s.labels ?? [],
  custom_attributes: s.customAttributes ?? {},
  ...(s.kanban ? { kanban_task: { id: 1, custom_attributes: s.kanban } } : {}),
  contact_inbox: { id: 77 },
  ...("redirectOrigin" in s
    ? { redirect_origin_display_id: s.redirectOrigin }
    : {}),
  meta: {
    assignee_type: s.assignee ? "User" : null,
    assignee: s.assignee ?? null,
    sender: {
      id: 501,
      name: s.contactName ?? "Cliente",
      phone_number: s.contactPhone ?? null,
      email: s.contactEmail ?? null,
      ...(s.contactClock !== undefined ? { updated_at: s.contactClock } : {}),
      ...(s.contactAttrs !== undefined
        ? { custom_attributes: s.contactAttrs }
        : {}),
    },
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
  opts: { bot?: number; processBase?: PrismaClient; delivery?: string } = {},
) {
  const delivery = opts.delivery ?? `ru-${process.pid}-${++seq}`;
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

describe.skipIf(!dbUp)("repeated message updates", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: {
        name: "Repeated update",
        slug: `repeated-update-${process.pid}`,
      },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://repeated-update.example.com",
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
    for (const messageStatus of ["sent", "delivered", "read"]) {
      const receipt = await deliver(
        body("message_updated", { ...s, messageStatus }),
      );
      expect(receipt.outcome).toBe("ignored");
      expect(receipt.rows).toBe(0);
      expect(receipt.ackTx).toBe(0);
    }
  });

  // What the receiver does not read: the message's delivery status, its source_id, changed_attributes.
  test("the delivery status, the source_id and changed_attributes do not keep a receipt from being dropped", async () => {
    const s = { conv: 1002, msg: 91002 };
    await deliver(body("message_created", s));
    const receipt = await deliver(
      body("message_updated", {
        ...s,
        sourceId: "wamid.LANDED",
        messageStatus: "delivered",
        changedAttributes: [{ status: { previous_value: "sent" } }],
      }),
    );
    expect(receipt.outcome).toBe("ignored");
    expect(receipt.rows).toBe(0);
    expect(receipt.ackTx).toBe(0);
  });

  // The version and the activity are the positions the mirror orders by: a receipt that moves either
  // can fence an older delivery still on its way, so it is processed, and then its own repeat drops.
  for (const [label, moved] of [
    ["version", { updatedAt: 1_791_000_400.75 }],
    ["activity", { lastActivityAt: 1_791_000_390 }],
  ] as const) {
    test(`a receipt that moves the conversation's ${label} is processed, and its repeat is then dropped`, async () => {
      const s = {
        conv: label === "version" ? 1015 : 1016,
        msg: label === "version" ? 91015 : 91016,
      };
      await deliver(body("message_created", s));
      const receipt = { ...s, ...moved, messageStatus: "delivered" };
      expect((await deliver(body("message_updated", receipt))).rows).toBe(1);
      expect((await deliver(body("message_updated", receipt))).rows).toBe(0);
    });
  }

  test("a template's receipt is dropped like a reply's", async () => {
    const s = { conv: 1003, msg: 91003, type: "template" as const };
    await deliver(body("message_created", s));
    expect((await deliver(body("message_updated", s))).rows).toBe(0);
  });

  // An identical update of a customer message can be the retry of an STT or ingestion that failed.
  test("a customer message's identical update is still recorded", async () => {
    const s = {
      conv: 1004,
      msg: 91004,
      type: "incoming" as const,
      sender: { id: 501, name: "Cliente", type: "contact" },
    };
    await deliver(body("message_created", s));
    await deliver(body("message_updated", s));
    expect((await deliver(body("message_updated", s))).rows).toBe(1);
  });

  test("a send failure is recorded, and so is the same failure again", async () => {
    const s = { conv: 1005, msg: 91005 };
    await deliver(body("message_created", s));
    const failed = { ...s, externalError: "131047: Re-engagement message" };
    expect((await deliver(body("message_updated", failed))).rows).toBe(1);
    expect((await deliver(body("message_updated", failed))).rows).toBe(1);
  });

  // Before 4.0.2 Chatwoot sends no version: equal payloads can be two transitions.
  test("a receipt from a Chatwoot that sends no conversation version is recorded", async () => {
    const s = { conv: 1006, msg: 91006, updatedAt: null };
    await deliver(body("message_created", s));
    expect((await deliver(body("message_updated", s))).rows).toBe(1);
  });

  test("a repeat of an event other than message_updated is recorded", async () => {
    const s = { conv: 1007, msg: 91007 };
    await deliver(body("message_created", s));
    expect((await deliver(body("message_created", s))).rows).toBe(1);
    await deliver(conversationUpdated(s));
    expect((await deliver(conversationUpdated(s))).rows).toBe(1);
  });

  // Every meaningful field: the update that carries a change is processed, and becomes the record.
  const variants: [string, Partial<Shape>][] = [
    ["an edit", { content: "resposta editada" }],
    ["a deletion", { content: "This message was deleted", deleted: true }],
    ["a label", { labels: ["vendas"] }],
    ["a conversation attribute", { customAttributes: { pedido: "123" } }],
    ["a kanban card attribute", { kanban: { etapa: "proposta" } }],
    ["the contact's name", { contactName: "Cliente Renomeado" }],
    ["the contact's phone", { contactPhone: "+5511999990000" }],
    ["the contact's email", { contactEmail: "cliente@example.com" }],
    ["the assignee", { assignee: { id: 3, name: "Pessoa" } }],
    ["the status", { status: "open" }],
    ["the inbox name", { inboxName: "Vendas" }],
  ];
  variants.forEach(([label, change], i) => {
    test(`an update carrying ${label} is processed, and its repeat is then dropped`, async () => {
      const s = { conv: 1100 + i, msg: 91100 + i };
      await deliver(body("message_created", s));
      const changed = { ...s, ...change, updatedAt: 1_791_000_200.5 };
      const first = await deliver(body("message_updated", changed));
      expect(first.rows).toBe(1);
      expect(first.processError).toBeNull();
      expect((await deliver(body("message_updated", changed))).rows).toBe(0);
    });
  });

  // A delayed receipt of an older state differs from the record, so it is processed exactly as
  // before this change: what the mirror then does with it is the mirror's own ordering, untouched here.
  test("a receipt carrying an older state than the record is processed", async () => {
    const s = { conv: 1008, msg: 91008, labels: ["x"] };
    await deliver(body("message_created", s));
    const newer = { ...s, labels: ["x", "y"], updatedAt: 1_791_000_200.5 };
    expect((await deliver(body("message_updated", newer))).rows).toBe(1);
    const late = await deliver(body("message_updated", s));
    expect(late.outcome).toBe("queued");
    expect(late.rows).toBe(1);
  });

  // A person's first reply sets first_reply_created_at after its creation, so its first receipt
  // carries it and is processed.
  test("the first receipt of a human agent's first reply carries the first-reply time and is processed", async () => {
    const s = {
      conv: 1009,
      msg: 91009,
      sender: { id: 3, name: "Pessoa", type: "user" },
    };
    await deliver(body("message_created", s));
    const stamped = { ...s, firstReplyAt: "2026-10-10T12:00:01Z" };
    expect((await deliver(body("message_updated", stamped))).rows).toBe(1);
    expect((await deliver(body("message_updated", stamped))).rows).toBe(0);
  });

  // The accepted limit (docs/chatwoot.md, step 3a): without the row's own clock, a shared row whose
  // value goes A, B, A while the conversation's clock stands still is left with B by a dropped repeat,
  // and the next delivery that is not a receipt writes A back.
  test("a value that went back while the clock stood still waits for the next delivery that is not a receipt", async () => {
    // A clock ahead of every other test's, since the inbox row is shared by the whole file.
    const s = { conv: 1017, msg: 91017, updatedAt: 1_791_000_900.5 };
    await deliver(body("message_created", s));
    const other = { ...s, msg: 91117 };
    await deliver(body("message_created", other));
    await deliver(body("message_updated", { ...other, inboxName: "Vendas" }));
    expect((await deliver(body("message_updated", s))).rows).toBe(0);
    const name = async () =>
      (
        await suDb.inbox.findFirst({
          where: { tenantId, chatwootInboxId: 7 },
          select: { name: true },
        })
      )?.name;
    expect(await name()).toBe("Vendas");
    await deliver(body("message_created", { ...s, msg: 91217 }));
    expect(await name()).toBe("WhatsApp");
  });

  // A reply stating no pairing is processed, a delayed conversation_updated from before it names an
  // older origin, and the receipt that would restate the null is dropped. The null's version keeps the
  // older pairing out on its own, so nothing waits on the dropped receipt.
  test("a delayed older pairing between a processed reply and its dropped receipt stays out", async () => {
    const s = {
      conv: 1018,
      msg: 91018,
      updatedAt: 1_791_001_000.5,
      redirectOrigin: null,
    };
    await deliver(body("message_created", s));
    const older = { ...s, updatedAt: 1_791_000_950.5, redirectOrigin: 42 };
    expect((await deliver(conversationUpdated(older))).rows).toBe(1);
    expect((await deliver(body("message_updated", s))).rows).toBe(0);
    const row = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 1018 },
      select: { redirectOriginDisplayId: true },
    });
    expect(row.redirectOriginDisplayId).toBeNull();
  });

  // With the rows' own clocks on the wire, the dropped repeat carries the record's clocks,
  // which never beat the newer inbox name or contact bag another message wrote: processing it on a
  // route with no record leaves the same values the drop left.
  test("with the rows' own clocks the dropped repeat would not have written the old value back", async () => {
    const s = {
      conv: 1019,
      msg: 91019,
      updatedAt: 1_791_001_100.5,
      inboxClock: 1_791_001_100.25,
      contactClock: 1_791_001_100.25,
      contactAttrs: { plano: "ouro" },
    };
    await deliver(body("message_created", s));
    const other = {
      ...s,
      msg: 91119,
      inboxName: "Vendas",
      inboxClock: 1_791_001_100.75,
      contactClock: 1_791_001_100.75,
      contactAttrs: { plano: "prata" },
    };
    await deliver(body("message_created", other));
    const kept = async () => ({
      inbox: (
        await suDb.inbox.findFirst({
          where: { tenantId, chatwootInboxId: 7 },
          select: { name: true },
        })
      )?.name,
      bag: (
        await suDb.contact.findFirst({
          where: { tenantId, chatwootContactId: 501 },
          select: { customAttributes: true },
        })
      )?.customAttributes,
    });
    expect((await deliver(body("message_updated", s))).rows).toBe(0);
    expect(await kept()).toEqual({ inbox: "Vendas", bag: { plano: "prata" } });
    const processed = await deliver(body("message_updated", s), {
      bot: OTHER_BOT,
    });
    expect(processed.rows).toBe(1);
    expect(processed.processError).toBeNull();
    expect(await kept()).toEqual({ inbox: "Vendas", bag: { plano: "prata" } });
  });

  test("each bot route answers for its own deliveries", async () => {
    const s = { conv: 1010, msg: 91010 };
    await deliver(body("message_created", s));
    const other = await deliver(body("message_updated", s), {
      bot: OTHER_BOT,
    });
    expect(other.rows).toBe(1);
    expect(
      (await deliver(body("message_updated", s), { bot: OTHER_BOT })).rows,
    ).toBe(0);
  });

  test("a redelivery of a dropped receipt is dropped too", async () => {
    const s = { conv: 1011, msg: 91011 };
    await deliver(body("message_created", s));
    const delivery = `ru-${process.pid}-redelivered`;
    for (let i = 0; i < 2; i++) {
      const r = await deliver(body("message_updated", s), { delivery });
      expect(r.outcome).toBe("ignored");
      expect(r.rows).toBe(0);
    }
  });

  test("a delivery whose processing failed does not vouch for its repeat", async () => {
    const s = { conv: 1012, msg: 91012 };
    const first = await deliver(body("message_created", s), {
      processBase: refusing(),
    });
    expect(first.processError).not.toBeNull();
    expect((await deliver(body("message_updated", s))).rows).toBe(1);
  });

  // A lost claim ran nothing here: the attempt holding the row may still fail.
  test("a delivery whose claim another attempt holds does not vouch for its repeat", async () => {
    const s = { conv: 1013, msg: 91013 };
    const raw = body("message_created", s);
    const r = await receiveChatwootWebhook({
      routeToken: tokens[BOT] as string,
      rawBody: raw,
      getHeader: signed(raw, `ru-${process.pid}-held`),
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

  // A live status claim refuses the payload's status: the mirror held a write back, so the same
  // payload is owed again and its receipt must reach the mirror.
  test("a delivery whose mirror held a write back does not vouch for its repeat", async () => {
    const s = { conv: 1014, msg: 91014 };
    await deliver(body("message_created", s));
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: s.conv },
      data: {
        statusClaimUntil: new Date(Date.now() + 10 * 60_000),
        statusClaimFrom: "pending",
        statusClaimStampedAt: null,
      },
    });
    const later = { ...s, msg: 91114, updatedAt: 1_791_000_300.5 };
    expect((await deliver(body("message_created", later))).rows).toBe(1);
    expect((await deliver(body("message_updated", later))).rows).toBe(1);
  });
});
