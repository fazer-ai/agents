import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import {
  claimAwayMessage,
  processChatwootDelivery,
  releaseAwayMessage,
} from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #153, wiring end. The availability gate silenced the agent and told only the OPERATOR, so the
// customer's side of a closed schedule was indistinguishable from the business ignoring them. What the
// decision table in availability-away.test.ts pins is the RULE (what text, and when it is withheld);
// what these cover is that the text actually leaves the process as a CUSTOMER-facing message on the
// conversation — the half a pure function cannot prove, because "the double received a public message
// with the persona's token" is the whole point.
//
// The schedule is open 00:00–23:59 every day and an exception closes today and tomorrow, so every
// assertion here is on the CLOSED direction and holds at any minute of the run (same construction as
// the #129 suite).

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
const BASE_URL = "https://203.0.113.22:9";
const BOT_TOKEN = "AWAY-BOT-TOKEN";
const INBOX_WITH_COPY = 881;
const INBOX_SILENT = 882;
const INBOX_DISABLED = 883;
const INBOX_PAUSED = 884;
const INBOX_NO_BOT = 885;
const AWAY_COPY = "Estamos fechados. Voltamos {proximo_atendimento}.";

let tenantId = 0n;
let instanceId = 0n;
let inboxWithCopyId = 0n;
let inboxSilentId = 0n;
let inboxDisabledId = 0n;
let inboxPausedId = 0n;
let inboxNoBotId = 0n;

function localDate(days: number): string {
  const at = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

interface Posted {
  conversationId: number;
  content: string;
  private: boolean;
  token: string;
}
const posted: Posted[] = [];
// Conversations whose PUBLIC posts the double rejects, and the attempts it saw.
const failPublicFor = new Set<number>();
const publicAttempts: number[] = [];
// Same, for the operator's PRIVATE note: it carries its own one-shot watermark, so a note that never
// arrived must not stamp one either.
const failPrivateFor = new Set<number>();
// Every POST to a messages endpoint the double saw, before any authentication verdict.
const sendAttempts: number[] = [];
let realFetch: typeof globalThis.fetch;

// The double AUTHENTICATES like Chatwoot: a client built without the persona's bot token gets the same
// 401 the real server answers, so a message the gate "sent" without an identity cannot pass as sent.
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
    const messages = url.match(/\/conversations\/(\d+)\/messages$/);
    if (messages && init?.method === "POST") {
      // Every attempt, including the ones rejected below for a missing token: a fence that stops a
      // post is only distinguishable from a post that fails by whether the attempt happened at all.
      sendAttempts.push(Number(messages[1]));
    }
    if (token === "") return json({ error: "Invalid Access Token" }, 401);
    if (messages && (init?.method ?? "GET") === "GET")
      return json({ payload: [] });
    if (messages && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      const convId = Number(messages[1]);
      if (body.private !== true && failPublicFor.has(convId)) {
        publicAttempts.push(convId);
        return json({ error: "boom" }, 500);
      }
      if (body.private === true && failPrivateFor.has(convId)) {
        return json({ error: "boom" }, 500);
      }
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
  convId: number,
  inbox: bigint,
  awaySentAt: Date | null = null,
  noticeSentAt: Date | null = null,
): Promise<bigint> {
  const row = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inbox,
      chatwootConversationId: convId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(Date.now() - 2 * 60_000),
      lastInboundAt: new Date(Date.now() - 3 * 60_000),
      awayMessageSentAt: awaySentAt,
      outOfHoursNoticeSentAt: noticeSentAt,
    },
    select: { id: true },
  });
  return row.id;
}

async function deliverCustomerMessage(
  convId: number,
  chatwootInboxId: number,
  seq: number,
  baseOverride?: PrismaClient,
  // Which bot the delivery believes it is. Null is a value the parameter declares and the HTTP
  // controller defaults to, so the fence has to survive being asked without an identity.
  ourAgentBotId: number | null = 9,
): Promise<void> {
  const n = normalizeChatwootEvent({
    event: "message_created",
    id: 6000 + seq,
    content: "olá, tem alguém aí?",
    message_type: "incoming",
    private: false,
    conversation: {
      id: convId,
      inbox_id: chatwootInboxId,
      status: "pending",
      contact_inbox: { id: 88_000 + convId },
      meta: {
        assignee_type: null,
        assignee: null,
        sender: { id: 701, name: "Cliente", phone_number: "+5511988880000" },
      },
      channel: "Channel::WebWidget",
      last_activity_at: Math.floor(Date.now() / 1000),
    },
  });
  if (!n) throw new Error("unreachable: the fixture is a valid event");
  const delivery = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `away-${process.pid}-${convId}-${seq}`,
      event: "message_created",
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: delivery.id,
    agentBotId: ourAgentBotId,
    normalized: n,
    base: baseOverride ?? appDb,
  });
}

const publicOn = (convId: number) =>
  posted.filter((p) => p.conversationId === convId && !p.private);
const notesOn = (convId: number) =>
  posted.filter((p) => p.conversationId === convId && p.private);

describe.skipIf(!dbUp)("out-of-hours away message (issue #153)", () => {
  beforeAll(async () => {
    installChatwootDouble();
    const t = await suDb.tenant.create({
      data: { name: "AWAY", slug: `away-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 12,
      baseUrl: BASE_URL,
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const hours = await suDb.businessHours.create({
      data: {
        tenantId,
        name: "Atendimento",
        timezone: TZ,
        // Open every day, all day: a closed reading can only have come from the exception.
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
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const baseAgent = {
      tenantId,
      systemPrompt: "Você é prestativa.",
      businessHoursId: hours.id,
      modelConfig: {
        provider: "openai",
        model: "gpt-4o-mini",
        credentialRef: `vault:${llmKey.id}`,
      },
    };
    const withCopy = await suDb.agent.create({
      data: {
        ...baseAgent,
        name: "Com recado",
        settings: {
          debounce: { enabled: false },
          split: { enabled: false },
          availability: { enabled: true, awayMessage: AWAY_COPY },
        },
      },
      select: { id: true },
    });
    const silent = await suDb.agent.create({
      data: {
        ...baseAgent,
        name: "Sem recado",
        settings: { debounce: { enabled: false }, split: { enabled: false } },
      },
      select: { id: true },
    });
    // Same copy, switched OFF: the operator turned this agent's voice off, schedule or no schedule.
    const disabled = await suDb.agent.create({
      data: {
        ...baseAgent,
        name: "Desligado",
        enabled: false,
        settings: {
          debounce: { enabled: false },
          split: { enabled: false },
          availability: { enabled: true, awayMessage: AWAY_COPY },
        },
      },
      select: { id: true },
    });
    // Copy written and kept, switch off: the operator paused the message without discarding the text.
    const paused = await suDb.agent.create({
      data: {
        ...baseAgent,
        name: "Pausado",
        settings: {
          debounce: { enabled: false },
          split: { enabled: false },
          availability: { enabled: false, awayMessage: AWAY_COPY },
        },
      },
      select: { id: true },
    });
    // One bot per persona, which is what makes the persona token the sender identity.
    for (const agentId of [withCopy.id, silent.id, disabled.id, paused.id]) {
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId,
          chatwootAgentBotId:
            agentId === withCopy.id
              ? 9
              : agentId === silent.id
                ? 10
                : agentId === disabled.id
                  ? 11
                  : 12,
          accessToken: encryptJson(BOT_TOKEN),
          webhookSecret: encryptJson("SECRET"),
          webhookRouteTokenHash: `hash-${process.pid}-${agentId}`,
          name: "bot",
        },
      });
    }
    const a = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_WITH_COPY,
        name: "Com recado",
        agentId: withCopy.id,
      },
      select: { id: true },
    });
    inboxWithCopyId = a.id;
    const b = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_SILENT,
        name: "Sem recado",
        agentId: silent.id,
      },
      select: { id: true },
    });
    inboxSilentId = b.id;
    const c = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_DISABLED,
        name: "Desligado",
        agentId: disabled.id,
      },
      select: { id: true },
    });
    inboxDisabledId = c.id;
    const d = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_PAUSED,
        name: "Pausado",
        agentId: paused.id,
      },
      select: { id: true },
    });
    inboxPausedId = d.id;
    // An agent with copy and schedule but NO Agent Bot row: nothing on this instance can speak as it.
    const botless = await suDb.agent.create({
      data: {
        ...baseAgent,
        name: "Sem bot",
        settings: {
          debounce: { enabled: false },
          split: { enabled: false },
          availability: { enabled: true, awayMessage: AWAY_COPY },
        },
      },
      select: { id: true },
    });
    const e = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_NO_BOT,
        name: "Sem bot",
        agentId: botless.id,
      },
      select: { id: true },
    });
    inboxNoBotId = e.id;
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

  test("the customer receives the away message, as the persona, and the operator still gets the note", async () => {
    const convId = 9101;
    await seedConversation(convId, inboxWithCopyId);
    await deliverCustomerMessage(convId, INBOX_WITH_COPY, 1);

    const reply = publicOn(convId);
    expect(reply).toHaveLength(1);
    expect(reply[0]?.token).toBe(BOT_TOKEN);
    // The schedule reached the renderer: the placeholder is gone and what replaced it is not empty.
    expect(reply[0]?.content).toStartWith("Estamos fechados. Voltamos ");
    expect(reply[0]?.content).not.toContain("{proximo_atendimento}");
    expect(reply[0]?.content.length).toBeGreaterThan(AWAY_COPY.length - 22);
    // The operator note is unchanged — the customer message is additive, not a replacement.
    expect(
      notesOn(convId).some((p) => p.content.includes("fora do horário")),
    ).toBe(true);
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { awayMessageSentAt: true, outOfHoursNoticeSentAt: true },
    });
    expect(conv.awayMessageSentAt).not.toBeNull();
    expect(conv.outOfHoursNoticeSentAt).not.toBeNull();
  });

  test("an agent with no away message keeps the pre-#153 silence", async () => {
    const convId = 9102;
    await seedConversation(convId, inboxSilentId);
    await deliverCustomerMessage(convId, INBOX_SILENT, 2);
    // Twice: the note stays one-shot for an agent that sends nothing to the customer, which is the
    // watermark write that the away message must not have taken over.
    await deliverCustomerMessage(convId, INBOX_SILENT, 6);

    expect(publicOn(convId)).toEqual([]);
    expect(notesOn(convId)).toHaveLength(1);
    expect(notesOn(convId)[0]?.content).toContain("fora do horário");
  });

  test("a second message the same day repeats neither the away message nor the note", async () => {
    const convId = 9103;
    await seedConversation(convId, inboxWithCopyId);
    await deliverCustomerMessage(convId, INBOX_WITH_COPY, 3);
    await deliverCustomerMessage(convId, INBOX_WITH_COPY, 4);

    expect(publicOn(convId)).toHaveLength(1);
    expect(notesOn(convId)).toHaveLength(1);
  });

  // The operator writes the copy at 20:10, on a conversation whose note went out at 20:00. Sharing one
  // watermark made the note's stamp swallow the customer's first message of the feature's life, which
  // is the worst possible first impression of a setting someone just turned on.
  test("copy written after today's note still reaches the customer today", async () => {
    const convId = 9108;
    await seedConversation(convId, inboxWithCopyId, null, new Date());
    await deliverCustomerMessage(convId, INBOX_WITH_COPY, 11);

    expect(publicOn(convId)).toHaveLength(1);
    // And the note is not re-posted: its own watermark says it already went out.
    expect(notesOn(convId)).toEqual([]);
  });

  // Disabling an agent switches off everything it says to the CUSTOMER. The operator note is the
  // pre-existing behavior of this branch and stays.
  test("a disabled agent tells the operator but never the customer", async () => {
    const convId = 9107;
    await seedConversation(convId, inboxDisabledId);
    await deliverCustomerMessage(convId, INBOX_DISABLED, 10);

    expect(publicOn(convId)).toEqual([]);
    expect(
      notesOn(convId).some((p) => p.content.includes("fora do horário")),
    ).toBe(true);
  });

  // Two different "off" switches meet here. The one above turns the whole AGENT off; this one leaves
  // the agent running and silences only the customer-facing message, with the copy still on the row.
  test("the switch off keeps the copy and sends nothing, note unaffected", async () => {
    const convId = 9109;
    const rowId = await seedConversation(convId, inboxPausedId);
    await deliverCustomerMessage(convId, INBOX_PAUSED, 14);

    expect(publicOn(convId)).toEqual([]);
    expect(
      notesOn(convId).some((p) => p.content.includes("fora do horário")),
    ).toBe(true);
    // Nothing was claimed either: flipping the switch back on must send TODAY, not skip the day.
    const row = await suDb.conversation.findUnique({
      where: { id: rowId },
      select: { awayMessageSentAt: true },
    });
    expect(row?.awayMessageSentAt).toBeNull();
  });

  // The window the fence closes is invisible to the attribution gate upstream, because that gate
  // believes the PAYLOAD when the payload speaks. A re-delivered event says "unassigned" while a human
  // has since taken the conversation, and the mirror — which knows better — refuses to apply the stale
  // state and leaves its own record standing. Reading it again, right before the customer would see
  // anything, is the only thing between the bot and talking over a human.
  // Both shapes of "not ours any more": a human took it, or an automation handed it to a DIFFERENT
  // bot. The second is why the fence is told which bot we are — without that, another bot's
  // conversation reads as ours and we post into it.
  test.each([
    ["a human took the conversation", 9110, "User", 4242],
    ["another bot took the conversation", 9111, "AgentBot", 77],
  ])("%s: the message is withheld", async (_label, convId, type, assignee) => {
    const ahead = new Date(Date.now() + 5 * 60_000);
    const aheadEpoch = Math.floor(ahead.getTime() / 1000);
    const row = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inboxWithCopyId,
        chatwootConversationId: convId,
        status: "pending",
        assigneeType: type,
        assigneeId: assignee,
        threadId: `${tenantId}:${instanceId}:${convId}`,
        lastEventAt: ahead,
        chatwootStatusAt: aheadEpoch,
        chatwootAssigneeAt: aheadEpoch,
        lastInboundAt: new Date(Date.now() - 3 * 60_000),
      },
      select: { id: true },
    });

    await deliverCustomerMessage(convId, INBOX_WITH_COPY, convId - 9095);

    expect(publicOn(convId)).toEqual([]);
    // The day is given back: the customer is still owed the message once the bot has the floor again.
    const after = await suDb.conversation.findUnique({
      where: { id: row.id },
      select: { awayMessageSentAt: true, assigneeType: true },
    });
    expect(after?.assigneeType).toBe(type);
    expect(after?.awayMessageSentAt).toBeNull();
  });

  // The operator's note carries the same kind of watermark as the customer's message, and the same
  // rule applies to it: a note the API refused was not delivered, so stamping it would spend the one
  // shot this conversation gets and leave the operator permanently unaware that the agent went quiet.
  test("a note the API refused does not spend its one shot", async () => {
    const convId = 9114;
    const rowId = await seedConversation(convId, inboxWithCopyId);
    failPrivateFor.add(convId);
    await deliverCustomerMessage(convId, INBOX_WITH_COPY, 19);
    expect(notesOn(convId)).toEqual([]);
    const after = await suDb.conversation.findUnique({
      where: { id: rowId },
      select: { outOfHoursNoticeSentAt: true },
    });
    expect(after?.outOfHoursNoticeSentAt).toBeNull();

    // Still owed: with the double healthy again the next message delivers it.
    failPrivateFor.delete(convId);
    await deliverCustomerMessage(convId, INBOX_WITH_COPY, 20);
    expect(notesOn(convId)).toHaveLength(1);
  });

  // An inbox whose agent has no Agent Bot has no identity to speak as, so another bot's conversation
  // can never read as its own. Two things hold it shut — the fence refusing to claim ownership without
  // an id, and the token-less client that could not send anyway — and this pins the OUTCOME they
  // share: nothing reaches the customer and no day is spent.
  test("an inbox with no persona does not claim another bot's conversation", async () => {
    const convId = 9113;
    const ahead = new Date(Date.now() + 5 * 60_000);
    const aheadEpoch = Math.floor(ahead.getTime() / 1000);
    const row = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inboxNoBotId,
        chatwootConversationId: convId,
        status: "pending",
        assigneeType: "AgentBot",
        assigneeId: 77,
        threadId: `${tenantId}:${instanceId}:${convId}`,
        lastEventAt: ahead,
        chatwootStatusAt: aheadEpoch,
        chatwootAssigneeAt: aheadEpoch,
        lastInboundAt: new Date(Date.now() - 3 * 60_000),
      },
      select: { id: true },
    });

    await deliverCustomerMessage(convId, INBOX_NO_BOT, 18, undefined, null);

    expect(sendAttempts.filter((c) => c === convId)).toEqual([]);
    expect(publicOn(convId)).toEqual([]);
    const after = await suDb.conversation.findUnique({
      where: { id: row.id },
      select: { awayMessageSentAt: true },
    });
    expect(after?.awayMessageSentAt).toBeNull();
  });

  // The control for the two above: a conversation assigned to the sending persona's OWN bot is still
  // its conversation, and the message goes out. Without this row, a fence that simply refused every
  // AgentBot assignment would read as correct.
  test("a conversation assigned to our own persona still gets the message", async () => {
    const convId = 9116;
    const ahead = new Date(Date.now() + 5 * 60_000);
    const aheadEpoch = Math.floor(ahead.getTime() / 1000);
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inboxWithCopyId,
        chatwootConversationId: convId,
        status: "pending",
        assigneeType: "AgentBot",
        // Bot 9 IS the persona bound to this inbox.
        assigneeId: 9,
        threadId: `${tenantId}:${instanceId}:${convId}`,
        lastEventAt: ahead,
        chatwootStatusAt: aheadEpoch,
        chatwootAssigneeAt: aheadEpoch,
        lastInboundAt: new Date(Date.now() - 3 * 60_000),
      },
    });

    await deliverCustomerMessage(convId, INBOX_WITH_COPY, 22, undefined, 9);

    expect(publicOn(convId)).toHaveLength(1);
  });

  // Chatwoot delivers an event to the conversation's ASSIGNED agent bot as well as to the inbox's, so
  // on a multi-bot instance the bot that RECEIVES a delivery is not always the bot that would SEND the
  // reply — that one is the persona bound to the inbox. The fence has to ask about the sender: asking
  // about the recipient approves an identity that is not the one holding the token.
  test("the fence asks about the persona that sends, not the one that received", async () => {
    const convId = 9115;
    const ahead = new Date(Date.now() + 5 * 60_000);
    const aheadEpoch = Math.floor(ahead.getTime() / 1000);
    const row = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        // Inbox of the persona whose bot id is 9 — the one whose token would send.
        inboxId: inboxWithCopyId,
        chatwootConversationId: convId,
        status: "pending",
        // Owned by bot 10, another persona's bot on the same instance.
        assigneeType: "AgentBot",
        assigneeId: 10,
        threadId: `${tenantId}:${instanceId}:${convId}`,
        lastEventAt: ahead,
        chatwootStatusAt: aheadEpoch,
        chatwootAssigneeAt: aheadEpoch,
        lastInboundAt: new Date(Date.now() - 3 * 60_000),
      },
      select: { id: true },
    });

    // Delivered to bot 10 (it owns the conversation, so Chatwoot dispatches to it too).
    await deliverCustomerMessage(convId, INBOX_WITH_COPY, 21, undefined, 10);

    expect(publicOn(convId)).toEqual([]);
    const after = await suDb.conversation.findUnique({
      where: { id: row.id },
      select: { awayMessageSentAt: true },
    });
    expect(after?.awayMessageSentAt).toBeNull();
  });

  // The fence answers from the database, so it can also fail to answer. Unable to tell whether the
  // conversation is still ours, the only safe reading is "not sent": stay quiet AND give the day back,
  // rather than burning it on a message nobody received.
  test("an ownership read that cannot answer releases the day", async () => {
    const convId = 9112;
    const rowId = await seedConversation(convId, inboxWithCopyId);
    let fenceReads = 0;
    const brokenFence = appDb.$extends({
      query: {
        conversation: {
          async findUnique({ args, query }) {
            // The fence's read is the narrow one: assigneeType + assigneeId + status and nothing
            // else. The mirror also reads assigneeId, but along with the row id and its clocks.
            const sel = args.select as Record<string, unknown> | undefined;
            if (sel?.assigneeId === true && Object.keys(sel).length === 3) {
              fenceReads += 1;
              throw new Error("ownership read exploded");
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    await deliverCustomerMessage(convId, INBOX_WITH_COPY, 17, brokenFence);

    // Guards the guard: if the fence stops selecting assigneeId this test must fail loudly rather
    // than quietly stop injecting anything.
    expect(fenceReads).toBeGreaterThan(0);
    expect(publicOn(convId)).toEqual([]);
    const row = await suDb.conversation.findUnique({
      where: { id: rowId },
      select: { awayMessageSentAt: true },
    });
    expect(row?.awayMessageSentAt).toBeNull();
  });

  // The dispatch is detached: two messages in a row can be processed by two invocations that both
  // read the same watermark. The claim is what stops the customer seeing the message twice.
  test("the day is claimed once, so a concurrent invocation posts nothing", async () => {
    const convId = 9105;
    const rowId = await seedConversation(convId, inboxWithCopyId);
    const now = new Date();
    const first = await claimAwayMessage({
      tenantId,
      conversationId: rowId,
      previous: null,
      now,
      base: appDb,
    });
    const second = await claimAwayMessage({
      tenantId,
      conversationId: rowId,
      previous: null,
      now: new Date(now.getTime() + 1000),
      base: appDb,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);

    // And releasing hands the day back, so the next message retries.
    await releaseAwayMessage({
      tenantId,
      conversationId: rowId,
      previous: null,
      claimed: now,
      base: appDb,
    });
    const conv = await suDb.conversation.findUniqueOrThrow({
      where: { id: rowId },
      select: { awayMessageSentAt: true },
    });
    expect(conv.awayMessageSentAt).toBeNull();
  });

  // Claiming before posting is what makes a failed send dangerous: the day would read as settled and
  // the customer would get nothing until tomorrow.
  test("a rejected away message does not settle the day", async () => {
    const convId = 9106;
    failPublicFor.add(convId);
    const rowId = await seedConversation(convId, inboxWithCopyId);
    await deliverCustomerMessage(convId, INBOX_WITH_COPY, 8);

    expect(publicAttempts.filter((c) => c === convId)).toHaveLength(1);
    expect(publicOn(convId)).toEqual([]);
    const afterFailure = await suDb.conversation.findUniqueOrThrow({
      where: { id: rowId },
      select: { awayMessageSentAt: true },
    });
    expect(afterFailure.awayMessageSentAt).toBeNull();

    // The next message retries, and lands once Chatwoot is answering again.
    failPublicFor.delete(convId);
    await deliverCustomerMessage(convId, INBOX_WITH_COPY, 9);
    expect(publicOn(convId)).toHaveLength(1);
  });

  // A WhatsApp conversation is never closed, so a watermark from a previous day is the ordinary case,
  // not an edge one: the customer asking again tomorrow is asking again, and gets an answer.
  test("a new day re-sends the away message without re-posting the note", async () => {
    const convId = 9104;
    // Both watermarks carry the older day: the away message is due again, the note is not (it is
    // one-shot per conversation, and this conversation already has one).
    await seedConversation(
      convId,
      inboxWithCopyId,
      new Date(Date.now() - 2 * 86_400_000),
      new Date(Date.now() - 2 * 86_400_000),
    );
    await deliverCustomerMessage(convId, INBOX_WITH_COPY, 5);
    // And the new day gets its own one-shot: without re-stamping on the away send, the watermark
    // would stay stuck on the old day and every further message would repeat the message.
    await deliverCustomerMessage(convId, INBOX_WITH_COPY, 7);

    expect(publicOn(convId)).toHaveLength(1);
    expect(notesOn(convId)).toEqual([]);
  });
});
