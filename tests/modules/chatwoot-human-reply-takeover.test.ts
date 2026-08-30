import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { setPublisher } from "@/api/features/realtime/realtime.service";
import { encryptJson } from "@/api/lib/crypto";
import { createChatwootClient } from "@/modules/chatwoot/client";
import {
  normalizeChatwootEvent,
  shouldBotHandle,
} from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { isFollowUpLive } from "@/modules/followups/eligibility";
import { POLL_DEADLINE_MS } from "@/tests/utils/poll";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// A PERSON ANSWERED THE CUSTOMER, and the agent has to step off the conversation (issue #430).
//
// The effect asserted is the one the issue is about: after a human reply, the NEXT customer message
// does not drive a turn. It is asserted end to end rather than by watching the toggle alone, because
// the toggle is only half the mechanism — Chatwoot then serializes the new status onto the next
// message payload and the mirror's reopen exception is what has to believe it. A test that stopped
// at "we called toggle_status" would pass with that half broken.
//
// The Chatwoot side is a stub that BEHAVES: it holds the conversation status, the toggle moves it,
// and the fixture reads it back. Hardcoding "open" into the second payload would be the test writing
// the answer it is checking.

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

const INBOX_ID = 74;
const ORPHAN_INBOX_ID = 75;
const ZAPI_INBOX_ID = 76;
const OUR_BOT = 14;
let tenantId = 0n;
let instanceId = 0n;
let agentDbId = 0n;
let deliverySeq = 0;
let messageSeq = 74_000;
let stamp = Math.floor(Date.now() / 1000);

// The Chatwoot the stub stands in for: one status per conversation, moved by toggle_status.
const liveStatus = new Map<number, string>();
// Conversations whose REST show comes back without `updated_at`, which is what a Chatwoot too old to
// render one looks like.
const unversionedReads = new Set<number>();
// Conversations whose REST show fails outright, which is a slow or broken Chatwoot.
const failingReads = new Set<number>();
// Conversations whose toggle_status fails, which is the half of a broken Chatwoot that matters after
// the row has already been claimed locally.
const failingToggles = new Set<number>();
// Who holds each conversation in the stub's Chatwoot, when it is not our own bot.
const liveHolder = new Map<number, number>();
// Work that runs while the client is being built, which is where the real round trip is: building a
// client resolves the base URL's host. It is the window a person can claim, resolve or reassign the
// conversation in, and the only place a test can stand in it.
let whileBuildingClient: (() => Promise<void>) | null = null;
// Work that runs while the toggle is in flight, which is the OTHER window: the fence has already
// answered, the write to Chatwoot is on the wire, and a conversation event can commit here.
let whileToggling: (() => Promise<void>) | null = null;
const posted: { url: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;

const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  posted.push({ url, body });
  const toggle = url.match(/\/conversations\/(\d+)\/toggle_status/);
  if (toggle && body && typeof body === "object" && "status" in body) {
    // Refused BEFORE the status moves, which is what a Chatwoot that never applied the change looks
    // like. Failing after would leave the stub agreeing with a call that threw.
    if (failingToggles.has(Number(toggle[1])))
      return new Response("nope", { status: 502 });
    // The hook runs BEFORE the status moves, because that is what "in flight" means: the request is
    // on the wire and Chatwoot has not committed it, so anything Chatwoot serializes in this window
    // still carries the OLD status. Running it after would hand concurrent work a snapshot from the
    // future and hide the very race it is standing in.
    await whileToggling?.();
    liveStatus.set(Number(toggle[1]), String(body.status));
  }
  // The live read the takeover reconciles from, answered the way the REST show does: the current
  // status, the bot still holding it, and an `updated_at` — the field the toggle response itself
  // does not render, which is the whole reason that GET exists.
  const show = url.match(/\/conversations\/(\d+)(?:\?|$)/);
  if (show && (init?.method ?? "GET") === "GET") {
    const id = Number(show[1]);
    if (failingReads.has(id)) return new Response("nope", { status: 502 });
    stamp += 1;
    return Response.json({
      id,
      status: liveStatus.get(id) ?? "pending",
      meta: {
        assignee_type: "AgentBot",
        assignee: { id: liveHolder.get(id) ?? OUR_BOT, name: "Atendente" },
      },
      last_activity_at: stamp,
      // A FLOAT of unix seconds, which is what the REST show renders (`updated_at.to_f`) and what
      // the ordering compares raw. An ISO string reads as no version at all and the reconcile is
      // silently skipped.
      ...(unversionedReads.has(id) ? {} : { updated_at: stamp + 0.5 }),
    });
  }
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

// The REAL client, with only the two things a test cannot have stubbed: the SSRF check (the fixture
// host does not resolve) and the socket. Everything the assertion reads — the path, the verb, the
// body — is built by the code that ships.
const deps = {
  makeClient: async (config: Parameters<typeof createChatwootClient>[0]) => {
    await whileBuildingClient?.();
    return createChatwootClient(config, {
      assertSafe: async (url: string) => new URL(url),
      fetchImpl: stubFetch,
    });
  },
};

describe.skipIf(!dbUp)("a human reply ends the agent's attendance", () => {
  beforeAll(async () => {
    globalThis.fetch = stubFetch as typeof globalThis.fetch;
    const t = await suDb.tenant.create({
      data: { name: "HR", slug: `hr-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 24,
      baseUrl: "https://chat.takeover.example",
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
    agentDbId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: OUR_BOT,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `hr-route-${process.pid}`,
        name: "Atendente",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_ID,
        name: "WhatsApp",
        provider: "baileys",
        agentId: agent.id,
      },
    });
    // Same agent, an inbox on a provider whose send path does not reserve its WhatsApp id.
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: ZAPI_INBOX_ID,
        name: "WhatsApp (zapi)",
        provider: "zapi",
        agentId: agent.id,
      },
    });
    // An inbox whose agent was never bound to an Agent Bot on this instance. It is a real shape (a
    // persona bound to an inbox before its bot row exists) and the one where "we own this" has no
    // "we" to be true about.
    const orphan = await suDb.agent.create({
      data: {
        tenantId,
        name: "Sem bot",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        settings: { debounce: { enabled: false } },
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: ORPHAN_INBOX_ID,
        name: "WhatsApp sem bot",
        provider: "baileys",
        agentId: orphan.id,
      },
    });
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!dbUp) return;
    for (const table of [
      "execution_logs",
      "scheduler_jobs",
      "chatwoot_webhook_deliveries",
      "conversations",
      "contacts",
      "inboxes",
      "chatwoot_agent_bots",
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

  // The conversation as Chatwoot would serialize it right now: bot-owned, and holding whatever
  // status the stub currently has.
  //
  // ONE clock behind both timestamps, and that is not fixture hygiene, it is the thing under test.
  // `last_activity_at` is whole seconds and `updated_at` carries a fraction that runs a little ahead
  // of the message it accompanies; the reopen ordering compares them TRUNCATED for exactly that
  // reason (state-order.ts). Driving them from two independent clocks makes `updated_at` outrun
  // `last_activity_at` by whole seconds, which no real burst does, and the reopen is then refused for
  // a reason the source never produces.
  function conversation(convId: number, inboxId = INBOX_ID, holder = OUR_BOT) {
    stamp += 1;
    return {
      id: convId,
      inbox_id: inboxId,
      status: liveStatus.get(convId) ?? "pending",
      contact_inbox: { id: 74_000 + convId },
      meta: {
        assignee_type: "AgentBot",
        assignee: { id: holder, name: "Atendente" },
        sender: { id: 77, name: "Cliente" },
      },
      channel: "Channel::Whatsapp",
      last_activity_at: stamp,
      updated_at: stamp + 0.5,
    };
  }

  // Whether a DIRECT turn ran for this delivery, which is the effect the issue is about — not "was
  // the gate closed", which is one inference away from it. `onDirectTurn` fires on both the outcome
  // and the throw, so a turn that starts and dies against the fixture's absent model key still
  // counts as having run.
  let turnsRan = 0;

  async function deliver(
    convId: number,
    over: Record<string, unknown>,
    inboxId = INBOX_ID,
    // The route this delivery arrived on, and who holds the conversation. They differ exactly when
    // Chatwoot fans one message to the conversation's assigned bot AND the inbox's.
    route: number | null = OUR_BOT,
    holder = OUR_BOT,
  ): Promise<"processed" | "skipped"> {
    deliverySeq += 1;
    messageSeq += 1;
    const event = (over.event as string) ?? "message_created";
    const n = normalizeChatwootEvent({
      event,
      id: messageSeq,
      private: false,
      ...over,
      conversation: conversation(convId, inboxId, holder),
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `hr-${process.pid}-${deliverySeq}`,
        event,
        status: "PENDING",
      },
      select: { id: true },
    });
    return (await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: route,
      normalized: n,
      deps,
      onDirectTurn: () => {
        turnsRan += 1;
      },
      base: appDb,
    })) as "processed" | "skipped";
  }

  // The shape the fork stores for a reply typed on the paired phone, measured off the wire:
  // outgoing, sender-less, and marked with external_sender_name.
  const deviceReply = (text: string) => ({
    content: text,
    message_type: "outgoing",
    sender: null,
    content_attributes: {
      external_created_at: Math.floor(Date.now() / 1000),
      external_sender_name: "WhatsApp",
    },
  });

  const composerReply = (text: string) => ({
    content: text,
    message_type: "outgoing",
    sender: { id: 5, name: "Ana", type: "user" },
  });

  const customerSays = (text: string) => ({
    content: text,
    message_type: "incoming",
    sender: { id: 77, name: "Cliente", type: null },
  });

  async function convRow(convId: number) {
    return suDb.conversation.findFirst({
      where: { tenantId, chatwootConversationId: convId },
      select: {
        id: true,
        status: true,
        lastHandledMessageId: true,
        chatwootStatusAt: true,
      },
    });
  }

  // The takeover's OWN lines, and only those. The `handoff` stage is shared with the gate's existing
  // trail (issue #271), which writes one line per customer message the bot did not answer — so after
  // a takeover the next customer message legitimately adds a second row saying `ownership_lost`. It
  // is a different statement about a different moment, and counting it here would make this assertion
  // depend on how many messages the fixture happens to send afterwards. `via` is the discriminator:
  // only this path writes it.
  async function takeoverRows(convId: number, waitMs = POLL_DEADLINE_MS) {
    const conv = await convRow(convId);
    if (!conv) return [];
    const deadline = Date.now() + waitMs;
    for (;;) {
      const rows = (
        await flowLogRows(suDb, {
          where: { tenantId, stage: "handoff", conversationId: conv.id },
          orderBy: { id: "asc" },
        })
      ).filter(
        (r) =>
          typeof r.detail === "object" &&
          r.detail !== null &&
          "via" in (r.detail as Record<string, unknown>),
      );
      if (rows.length > 0 || Date.now() > deadline) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const toggles = (convId: number) =>
    posted.filter((p) =>
      p.url.includes(`/conversations/${convId}/toggle_status`),
    );

  // THE REGRESSION. Without the change the second delivery drives a turn, because the conversation
  // is still `pending` and still the bot's.
  test("after a reply from the paired phone, the next customer message drives no turn", async () => {
    const conv = 8401;
    turnsRan = 0;
    await deliver(conv, { ...customerSays("oi, quanto custa?") });
    expect(liveStatus.get(conv) ?? "pending").toBe("pending");

    await deliver(conv, { ...deviceReply("oi! sou a Ana, já te respondo") });
    expect(liveStatus.get(conv)).toBe("open");

    // The mirror has to AGREE, and by the ordinary route: the next payload states the new status and
    // the reopen exception applies it. This is the half a toggle-only assertion would miss.
    //
    // The positive control is the first message: it DID drive a turn on this same conversation, a
    // few lines up, so a second message driving none is the change and not a fixture that never ran
    // turns at all.
    expect(turnsRan).toBe(1);
    await deliver(conv, { ...customerSays("consigo hoje?") });
    expect((await convRow(conv))?.status).toBe("open");
    expect(turnsRan).toBe(1);

    const rows = await takeoverRows(conv);
    expect(rows.length).toBe(1);
    expect(rows[0]?.detail).toMatchObject({
      outcome: "taken_over",
      via: "device",
    });
  });

  test("the same for a reply typed in the Chatwoot composer", async () => {
    const conv = 8402;
    await deliver(conv, { ...customerSays("bom dia") });
    await deliver(conv, { ...composerReply("bom dia, aqui é a Ana") });
    expect(liveStatus.get(conv)).toBe("open");
    const rows = await takeoverRows(conv);
    expect(rows[0]?.detail).toMatchObject({
      outcome: "taken_over",
      via: "composer",
    });
  });

  // Re-delivery is idempotent through the gate, not through bookkeeping: the second pass finds the
  // conversation no longer `pending`, so nothing is written and nothing is logged twice.
  test("re-delivering the same reply emits no second transition", async () => {
    const conv = 8403;
    await deliver(conv, { ...customerSays("oi") });
    const reply = deviceReply("já te respondo");
    await deliver(conv, { ...reply });
    const after = toggles(conv).length;
    await deliver(conv, { ...reply });
    expect(toggles(conv).length).toBe(after);
    expect((await takeoverRows(conv)).length).toBe(1);
  });

  // The three shapes Chatwoot itself produces that are outgoing and sender-less. Measured on a live
  // fork: an automation rule, a scheduled message whose author is not a User, and a CSAT survey all
  // reach the bot exactly like a device reply does, minus the marker. Treating any of them as a
  // person would silence the agent on a conversation nobody is holding.
  test("an automation, a scheduled message and a CSAT survey are not a person", async () => {
    const shapes = [
      { label: "automation", content_attributes: { automation_rule_id: 7 } },
      { label: "scheduled", content_attributes: {} },
      { label: "csat", content_attributes: {}, content_type: "input_csat" },
    ];
    let conv = 8410;
    for (const shape of shapes) {
      conv += 1;
      await deliver(conv, { ...customerSays("oi") });
      await deliver(conv, {
        content: "mensagem do próprio Chatwoot",
        message_type: "outgoing",
        sender: null,
        content_attributes: shape.content_attributes,
        ...(shape.content_type ? { content_type: shape.content_type } : {}),
      });
      expect(toggles(conv).length).toBe(0);
      expect(liveStatus.get(conv) ?? "pending").toBe("pending");
    }
  });

  // A first pairing replays a year of history through the same writers. The fork never delivers one
  // to a bot, so this is a fence and not a live path — but a batch that DID arrive would open and
  // silence every conversation in it at once.
  test("an imported message leaves the conversation untouched", async () => {
    const conv = 8420;
    await deliver(conv, { ...customerSays("oi") });
    await deliver(conv, {
      ...deviceReply("resposta de junho"),
      content_attributes: {
        external_created_at: 1,
        external_sender_name: "WhatsApp",
        imported: true,
      },
    });
    expect(toggles(conv).length).toBe(0);
  });

  // Reactions are stored as real outgoing messages, sender-less and marked, on the session paths.
  // A 👍 is an acknowledgement, not somebody taking the conversation over.
  test("a reaction from the phone is not a takeover", async () => {
    const conv = 8421;
    await deliver(conv, { ...customerSays("oi") });
    await deliver(conv, {
      ...deviceReply("👍"),
      content_attributes: {
        external_created_at: 1,
        external_sender_name: "WhatsApp",
        is_reaction: true,
      },
    });
    expect(toggles(conv).length).toBe(0);
  });

  // Our own reply comes back through this route on a Baileys inbox too, and it must never be read as
  // a person: it is sender-typed agent_bot, and the fork's reservation keeps its echo out of the
  // sender-less branch entirely.
  test("our own outgoing reply is not a takeover", async () => {
    const conv = 8422;
    await deliver(conv, { ...customerSays("oi") });
    await deliver(conv, {
      content: "posso ajudar?",
      message_type: "outgoing",
      sender: { id: OUR_BOT, name: "Atendente", type: "agent_bot" },
    });
    expect(toggles(conv).length).toBe(0);
  });

  // Issue #187's rule, applied to the route it could not see. Without this the memory of the
  // attendance is a conversation in which only the customer spoke — measured in production, where
  // the agent's own private note said "the amount is not in the available context" about a price the
  // attendant had stated on the phone three messages earlier.
  test("the reply from the phone is folded into the contact's memory as the attendant", async () => {
    const conv = 8440;
    await deliver(conv, { ...customerSays("oi") });
    await deliver(conv, { ...deviceReply("o valor é R$ 1.200") });
    const jobs = await suDb.schedulerJob.findMany({
      where: { tenantId, kind: "INGEST_MESSAGE" },
      select: { payload: true },
    });
    const mine = jobs
      .map((j) => j.payload as Record<string, unknown>)
      .filter((p) => p.conversationId === conv);
    expect(mine.map((p) => p.role)).toContain("human_agent");
  });

  // The ladder reads the same predicate the gate does, so the transition silences it with nothing of
  // its own to change. Asserted against the mirrored row this delivery produced rather than against a
  // hand-built object: what has to hold is that THIS conversation, after THIS takeover, is one the
  // ladder refuses.
  test("the follow-up ladder goes quiet on the conversation", async () => {
    const conv = 8441;
    await deliver(conv, { ...customerSays("oi") });
    expect(
      shouldBotHandle(
        {
          status: (await convRow(conv))?.status ?? null,
          assigneeType: "AgentBot",
          assigneeId: OUR_BOT,
        },
        { ourAgentBotId: OUR_BOT },
      ),
    ).toBe(true);
    await deliver(conv, { ...deviceReply("já te respondo") });
    await deliver(conv, { ...customerSays("consigo hoje?") });
    const row = await convRow(conv);
    expect(
      isFollowUpLive({
        agentEnabled: true,
        followUpEnabled: true,
        managedByRedirect: false,
        agentMode: "production",
        testActivatedAt: null,
        status: row?.status ?? null,
        assigneeType: "AgentBot",
        mirrorHolder: "ours",
      }),
    ).toBe(false);
  });

  // A test-mode agent lives in a conversation an operator activated with /teste. Answering from the
  // composer mid-test is how an operator checks what the agent saw, and silencing the agent there
  // would end the test with the way back (/reset) a command they now have to know about.
  test("a test-mode agent does not take the conversation away from itself", async () => {
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { mode: "test" },
    });
    const conv = 8450;
    await deliver(conv, { ...customerSays("oi") });
    await deliver(conv, { ...deviceReply("já te respondo") });
    expect(toggles(conv).length).toBe(0);
    expect(liveStatus.get(conv) ?? "pending").toBe("pending");
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { mode: "production" },
    });
  });

  // The mirror is what decides whether an ALREADY RUNNING turn may post (the runtime rechecks
  // ownership against that row after the model call), so it has to say `open` the moment the toggle
  // returns — not after a GET that can be slow, fail, or come back with nothing to order it by.
  //
  // Both degraded readings are exercised here, because they fail differently: a read with no version
  // cannot be ordered and is discarded, and a read that throws leaves nothing at all. In both the row
  // still has to read `open`.
  test("the mirror says open even when the live read is useless", async () => {
    for (const [conv, degrade] of [
      [8460, () => unversionedReads.add(8460)],
      [8461, () => failingReads.add(8461)],
    ] as const) {
      degrade();
      await deliver(conv, { ...customerSays("oi") });
      await deliver(conv, { ...deviceReply("já te respondo") });
      expect(toggles(conv).length).toBe(1);
      expect(liveStatus.get(conv)).toBe("open");
      expect((await convRow(conv))?.status).toBe("open");
    }
    unversionedReads.delete(8460);
    failingReads.delete(8461);
  });

  // What the VERSION buys, which the unversioned write above cannot: ordering. Only a reconciled read
  // stamps the row with the version Chatwoot produced for the change, so a delayed conversation event
  // carrying an older status loses to it instead of walking the takeover back.
  test("a versioned live read stamps the row so an older event cannot walk it back", async () => {
    const conv = 8462;
    await deliver(conv, { ...customerSays("oi") });
    const before = (
      await suDb.conversation.findFirst({
        where: { tenantId, chatwootConversationId: conv },
        select: { chatwootStatusAt: true },
      })
    )?.chatwootStatusAt;
    await deliver(conv, { ...deviceReply("já te respondo") });
    const after = (
      await suDb.conversation.findFirst({
        where: { tenantId, chatwootConversationId: conv },
        select: { chatwootStatusAt: true },
      })
    )?.chatwootStatusAt;
    expect(after).not.toBe(before ?? null);
    expect(after).not.toBeNull();
  });

  // THE FENCE, and the reason it cannot be `act` alone. `act` says the bot owned the conversation
  // when this event was mirrored; between that answer and the write there is a network round trip,
  // because building the client resolves the base URL's host. A person resolving the conversation in
  // that window must not have it dragged back to `open`.
  //
  // The hook runs exactly where that trip is, which is the only honest place to stand: asserting
  // this by mutating the row before the delivery would test a different gate (`act` itself).
  test("a conversation claimed while the client is built is not dragged back open", async () => {
    const conv = 8470;
    await deliver(conv, { ...customerSays("oi") });
    const row = await convRow(conv);
    whileBuildingClient = async () => {
      await suDb.conversation.update({
        where: { id: row?.id },
        data: { status: "resolved" },
      });
    };
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
    } finally {
      whileBuildingClient = null;
    }
    expect(toggles(conv).length).toBe(0);
    expect(liveStatus.get(conv) ?? "pending").toBe("pending");
    expect((await takeoverRows(conv, 200)).length).toBe(0);
  });

  // An agent with no Agent Bot row on this instance cannot speak here at all: every call it makes
  // goes out with an empty token (issue #79). Nothing is written, and the delivery still completes.
  test("an inbox whose agent has no bot on this instance takes nothing over", async () => {
    const conv = 8480;
    await deliver(conv, { ...customerSays("oi") }, ORPHAN_INBOX_ID);
    await deliver(conv, { ...deviceReply("já te respondo") }, ORPHAN_INBOX_ID);
    expect(toggles(conv).length).toBe(0);
    expect(liveStatus.get(conv) ?? "pending").toBe("pending");
    // THE ROW TOO, and this is the half that stops being free once the claim is written before the
    // toggle. Learning there is no persona from `toggleStatus` throwing would leave the row `open`
    // on a conversation Chatwoot never moved — and a failed open deliberately KEEPS the claim,
    // because a failed call is an unknown outcome. A missing bot is not unknown, so nothing is
    // claimed in the first place.
    expect((await convRow(conv))?.status).toBe("pending");
  });

  // "We own this" is false when there is no "we". A delivery whose own route bot is unknown cannot
  // narrow "an AgentBot owns this" to "we own this", so the fence refuses rather than reading every
  // bot as ours.
  test("a delivery with no route bot takes nothing over", async () => {
    const conv = 8481;
    await deliver(conv, { ...customerSays("oi") }, INBOX_ID, null);
    await deliver(conv, { ...deviceReply("já te respondo") }, INBOX_ID, null);
    expect(toggles(conv).length).toBe(0);
    expect(liveStatus.get(conv) ?? "pending").toBe("pending");
  });

  // CROSS-ROUTE. Chatwoot fans one message to the conversation's assigned bot AND the inbox's, which
  // is two deliveries with two route ids. On a conversation held by ANOTHER persona's bot, only the
  // assigned-bot delivery passes `act` — so the fence has to ask about that same bot, or the
  // re-check becomes a second gate and NEITHER delivery takes over: the conversation a person just
  // answered stays `pending` and bot-owned.
  test("a conversation held by another persona's bot is taken over exactly once", async () => {
    const conv = 8490;
    const OTHER_BOT = 99;
    liveHolder.set(conv, OTHER_BOT);
    try {
      await deliver(
        conv,
        { ...customerSays("oi") },
        INBOX_ID,
        OTHER_BOT,
        OTHER_BOT,
      );
      const reply = deviceReply("já te respondo");
      // The inbox's own route: `act` is false for it, because the conversation is not its bot's.
      await deliver(conv, { ...reply }, INBOX_ID, OUR_BOT, OTHER_BOT);
      expect(toggles(conv).length).toBe(0);
      // The assigned bot's route, which is the one that would have answered.
      await deliver(conv, { ...reply }, INBOX_ID, OTHER_BOT, OTHER_BOT);
      expect(toggles(conv).length).toBe(1);
      expect(liveStatus.get(conv)).toBe("open");
    } finally {
      liveHolder.delete(conv);
    }
  });

  // On a provider that does not reserve its WhatsApp id, our own reply can come back wearing exactly
  // this shape when a send response is lost, so the device leg refuses there. The composer leg still
  // works on the same inbox, which is what makes this a refusal about the ECHO and not about the
  // provider.
  test("the device leg is refused on a provider that does not reserve echo ids", async () => {
    const conv = 8495;
    await deliver(conv, { ...customerSays("oi") }, ZAPI_INBOX_ID);
    await deliver(conv, { ...deviceReply("já te respondo") }, ZAPI_INBOX_ID);
    expect(toggles(conv).length).toBe(0);
    expect(liveStatus.get(conv) ?? "pending").toBe("pending");

    await deliver(conv, { ...composerReply("aqui é a Ana") }, ZAPI_INBOX_ID);
    expect(toggles(conv).length).toBe(1);
    expect(liveStatus.get(conv)).toBe("open");
  });

  // WHEN the row is silenced, which is the whole ordering decision. Every reader that decides
  // whether the agent may speak — the runtime's recheck after the model call, the debounce flush,
  // the follow-up ladder, the nudge — asks `shouldBotHandle` of THIS ROW and never of Chatwoot. A
  // turn that was already running when the person replied reaches its recheck somewhere inside this
  // delivery, so the row has to have moved before anything that waits on a network, not after.
  //
  // Read from inside the toggle because that is the window: with the write after the round trip, a
  // reader standing here still sees `pending` and answers.
  test("the mirrored row is already open while the toggle is in flight", async () => {
    const conv = 8510;
    await deliver(conv, { ...customerSays("oi") });
    let seen: string | null | undefined;
    whileToggling = async () => {
      seen = (await convRow(conv))?.status;
    };
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
    } finally {
      whileToggling = null;
    }
    expect(seen).toBe("open");
  });

  // WHY THE CAS IS ON THE VERSION AND NOT ON `pending`. A hand-back — the console's "Return to AI",
  // the REST endpoint, the MCP tool — writes `pending` too, so a status-only predicate matches the
  // state that just REPLACED the one this delivery decided on, and silently undoes the operator who
  // asked for the agent back. The version is the only thing that tells the two `pending`s apart.
  //
  // Committed while the client is built, which is where a hand-back can actually land: it is the
  // round trip between the payload that decided `act` and the write that acts on it.
  test("a hand-back committed while the client is built is not undone", async () => {
    const conv = 8511;
    await deliver(conv, { ...customerSays("oi") });
    const row = await convRow(conv);
    whileBuildingClient = async () => {
      await suDb.conversation.update({
        where: { id: row?.id },
        // What `mirrorConsoleWrite` leaves behind on a versioned reconcile: still `pending`, and
        // stamped ahead of everything this delivery saw.
        data: {
          status: "pending",
          chatwootStatusAt: (row?.chatwootStatusAt ?? 0) + 1000,
        },
      });
    };
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
    } finally {
      whileBuildingClient = null;
    }
    expect(toggles(conv).length).toBe(0);
    expect((await convRow(conv))?.status).toBe("pending");
    expect(liveStatus.get(conv) ?? "pending").toBe("pending");
    expect((await takeoverRows(conv, 200)).length).toBe(0);
  });

  // THE OTHER SIDE OF WRITING THE ROW FIRST, and the compensation that must NOT exist. The claim is
  // taken locally and then the open fails, so the row says `open` over a conversation Chatwoot may
  // never have moved. Handing the claim back there looks like the fix and is the defect: a failed
  // call is an UNKNOWN outcome, not a refusal — Chatwoot commits the transition and the response is
  // lost — and rolling back on the unknown puts the agent straight back to answering over the person
  // it just handed the conversation to.
  //
  // So the claim stands, and what resolves it is the path that already exists: the next customer
  // message carries the reopen exception, so a conversation Chatwoot really did leave `pending`
  // comes back to the agent on its own.
  test("a failed open keeps the claim, and the next message is what settles it", async () => {
    const conv = 8512;
    await deliver(conv, { ...customerSays("oi") });
    failingToggles.add(conv);
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
    } finally {
      failingToggles.delete(conv);
    }
    // Silent, on a takeover that was never confirmed — the direction a fence has to fail in.
    expect((await convRow(conv))?.status).toBe("open");
    // ...and not reported as one, because nothing established that a person was handed anything.
    expect((await takeoverRows(conv, 200)).length).toBe(0);
    // And it does not stay stuck: Chatwoot never left `pending`, so the next customer message says
    // so and the agent answers again.
    const before = turnsRan;
    await deliver(conv, { ...customerSays("continua aí?") });
    expect(turnsRan).toBe(before + 1);
    expect((await convRow(conv))?.status).toBe("pending");
  });

  // AFTER the claim, nothing here writes status again. The claim is taken before the toggle goes
  // out, so a conversation event that commits while it is on the wire — an operator resolving, a
  // hand-back — is the LAST word on the row, and it has to survive the rest of this delivery.
  //
  // With the live read failing, the claim is the only thing that touched the row, which is what
  // isolates the question: a reconcile that succeeded would settle it either way and prove nothing
  // about the path in between. That pairing is not contrived — a slow or broken Chatwoot is exactly
  // when it is load-bearing.
  test("a state that moved while the toggle was in flight is not overwritten", async () => {
    const conv = 8500;
    await deliver(conv, { ...customerSays("oi") });
    const row = await convRow(conv);
    whileToggling = async () => {
      await suDb.conversation.update({
        where: { id: row?.id },
        data: { status: "resolved" },
      });
    };
    failingReads.add(conv);
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
    } finally {
      whileToggling = null;
      failingReads.delete(conv);
    }
    expect(toggles(conv).length).toBe(1);
    expect((await convRow(conv))?.status).toBe("resolved");
  });

  // THE CONSOLES, which the row alone does not reach. This delivery already broadcast the mirror's
  // post-write snapshot before the takeover ran, and that one still said `pending`, so an open
  // Conversations page would keep naming the bot as the owner. After a successful open Chatwoot's
  // own conversation event would correct it a moment later — after a FAILED one nothing ever does,
  // and the claim is deliberately kept, so this is the case the announcement has to hold for.
  test("a claim taken over a failed open is announced to the consoles", async () => {
    const conv = 8530;
    // The publisher is handed the SERIALIZED event, not the object — Bun's `server.publish` takes a
    // string — so a filter written against the object shape matches nothing and the test passes on
    // an assertion that can never fail.
    const published: Record<string, unknown>[] = [];
    await deliver(conv, { ...customerSays("oi") });
    const row = await convRow(conv);
    setPublisher((_topic, data) => {
      published.push(JSON.parse(String(data)));
    });
    failingToggles.add(conv);
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
    } finally {
      failingToggles.delete(conv);
      setPublisher(() => undefined);
    }
    expect(
      published.filter(
        (d) =>
          d.type === "conversation" &&
          d.conversationId === String(row?.id) &&
          d.status === "open",
      ).length,
    ).toBe(1);
  });

  // A TAKEOVER IS A FACT ABOUT THE CONVERSATION, not about the agent, so the agent's own switch does
  // not decide it. Two things go wrong when it does, and the second is the quiet one: the runtime's
  // post-model recheck asks about OWNERSHIP and not about the switch, so a turn already running when
  // the agent was switched off still answers over the colleague; and the conversation stays
  // `pending`, so switching the agent back on later hands it every conversation a person picked up
  // in the meantime.
  test("a switched-off agent still steps off a conversation a person answered", async () => {
    const conv = 8540;
    await deliver(conv, { ...customerSays("oi") });
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { enabled: false },
    });
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
      expect(toggles(conv).length).toBe(1);
      expect(liveStatus.get(conv)).toBe("open");
      expect((await convRow(conv))?.status).toBe("open");
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { enabled: true },
      });
    }
    // And the switch coming back on does not hand the conversation back: it is the person's now, and
    // only a hand-back returns it.
    const before = turnsRan;
    await deliver(conv, { ...customerSays("continua aí?") });
    expect(turnsRan).toBe(before);
  });

  // THE MIRROR CAN BE BEHIND CHATWOOT, and the act guarded here is a write TO Chatwoot. An attendant
  // who answers and then immediately resolves does both before this detached delivery runs, so the
  // resolve's own webhook is still in flight and the row still says `pending`. Fenced on the mirror
  // alone, the toggle reopens the conversation the operator just closed.
  test("a conversation Chatwoot has already moved on is not reopened", async () => {
    const conv = 8550;
    await deliver(conv, { ...customerSays("oi") });
    // Chatwoot has it resolved; the mirror has not heard yet, which is the whole setup.
    liveStatus.set(conv, "resolved");
    try {
      expect((await convRow(conv))?.status).toBe("pending");
      await deliver(conv, { ...deviceReply("já te respondo") });
      expect(toggles(conv).length).toBe(0);
      expect(liveStatus.get(conv)).toBe("resolved");
      expect((await convRow(conv))?.status).toBe("pending");
      expect((await takeoverRows(conv, 200)).length).toBe(0);
    } finally {
      liveStatus.delete(conv);
    }
  });

  // ...and a read that cannot answer does not block: silence is not evidence that somebody took the
  // conversation, and refusing on it would trade a rare wrong reopen for the original defect on
  // every slow Chatwoot.
  test("an unreadable live read leaves the mirror fence to decide", async () => {
    const conv = 8551;
    await deliver(conv, { ...customerSays("oi") });
    failingReads.add(conv);
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
      expect(toggles(conv).length).toBe(1);
      expect(liveStatus.get(conv)).toBe("open");
      expect((await convRow(conv))?.status).toBe("open");
    } finally {
      failingReads.delete(conv);
    }
  });

  test("the switch turns it off, and nothing else changes", async () => {
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        settings: {
          debounce: { enabled: false },
          takeover: { onHumanReply: false },
        },
      },
    });
    const conv = 8430;
    await deliver(conv, { ...customerSays("oi") });
    await deliver(conv, { ...deliverReplyOff() });
    expect(toggles(conv).length).toBe(0);
    expect(liveStatus.get(conv) ?? "pending").toBe("pending");
    expect((await takeoverRows(conv, 200)).length).toBe(0);
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { settings: { debounce: { enabled: false } } },
    });
  });

  function deliverReplyOff() {
    return deviceReply("já te respondo");
  }
});
