import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { setPublisher } from "@/api/features/realtime/realtime.service";
import { encryptJson } from "@/api/lib/crypto";
import { createChatwootClient } from "@/modules/chatwoot/client";
import {
  claimOpenForHumanQueue,
  OWNERSHIP_PROJECTION,
} from "@/modules/chatwoot/human-takeover";
import {
  normalizeChatwootEvent,
  shouldBotHandle,
} from "@/modules/chatwoot/normalize";
import { STATUS_CLAIM_TTL_MS } from "@/modules/chatwoot/status-claim";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import {
  returnConversationToAgent,
  setConversationStatus,
} from "@/modules/conversations/service";
import { isFollowUpLive } from "@/modules/followups/eligibility";
import { POLL_DEADLINE_MS } from "@/tests/utils/poll";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// A PERSON ANSWERED THE CUSTOMER, and the agent has to step off the conversation.
//
// Asserted end to end: after a human reply, the NEXT customer message does not drive a turn. The
// toggle is only half the mechanism; Chatwoot then serializes the new status onto the next message
// payload and the mirror's reopen exception has to believe it.
//
// The Chatwoot side is a stub that BEHAVES: it holds the conversation status, the toggle moves it,
// and the fixture reads it back, so no payload hardcodes the answer being checked.

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
// Conversations whose REST show answers with a PINNED version, standing for a read that was issued
// before something else committed: the snapshot in hand is the older truth even though it came back
// later, which is the window `reconcileMirrorFromLive` exists to guard.
const pinnedReadVersion = new Map<number, number>();
// Conversations whose toggle_status fails, which is the half of a broken Chatwoot that matters after
// the row has already been claimed locally.
const failingToggles = new Set<number>();
// Who holds each conversation in the stub's Chatwoot, when it is not our own bot.
const liveHolder = new Map<number, number>();
// The newest message id the stub's Chatwoot has for a conversation, which is what the REST show
// renders as `messages` and what a console write ordered by the source's sequence stamps. Driven by
// the fixture the same way `liveStatus` is: the deliveries below move it, so the mark the console
// reads is one the test never writes by hand.
const liveLatestMessageId = new Map<number, number>();
// Work that runs while the client is being built, which is where the real round trip is: building a
// client resolves the base URL's host. It is the window a person can claim, resolve or reassign the
// conversation in, and the only place a test can stand in it.
let whileBuildingClient: (() => Promise<void>) | null = null;
// Work that runs while the toggle is in flight, which is the OTHER window: the fence has already
// answered, the write to Chatwoot is on the wire, and a conversation event can commit here.
let whileToggling: (() => Promise<void>) | null = null;
// Work that runs while a REST show is being answered, after Chatwoot read the conversation: something
// committing between a live read and what its caller does with it.
const whileReading = new Map<number, () => Promise<void>>();
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
    // The fork's conditional toggle: the change applies only while the conversation still holds the
    // status the caller read, and otherwise answers 409 and changes nothing.
    const current = liveStatus.get(Number(toggle[1])) ?? "pending";
    if ("expected_status" in body && body.expected_status !== current) {
      return Response.json(
        { error: "conversation status changed", current_status: current },
        { status: 409 },
      );
    }
    liveStatus.set(Number(toggle[1]), String(body.status));
  }
  // The live read the takeover reconciles from, answered the way the REST show does: the current
  // status, the bot still holding it, and an `updated_at` — the field the toggle response itself
  // does not render, which is the whole reason that GET exists.
  const show = url.match(/\/conversations\/(\d+)(?:\?|$)/);
  if (show && (init?.method ?? "GET") === "GET") {
    const id = Number(show[1]);
    if (failingReads.has(id)) return new Response("nope", { status: 502 });
    const statusRead = liveStatus.get(id) ?? "pending";
    const hook = whileReading.get(id);
    if (hook) {
      whileReading.delete(id);
      await hook();
    }
    stamp += 1;
    return Response.json({
      id,
      status: statusRead,
      meta: {
        assignee_type: "AgentBot",
        assignee: { id: liveHolder.get(id) ?? OUR_BOT, name: "Atendente" },
      },
      last_activity_at: stamp,
      // A FLOAT of unix seconds, which is what the REST show renders (`updated_at.to_f`) and what
      // the ordering compares raw. An ISO string reads as no version at all and the reconcile is
      // silently skipped.
      ...(unversionedReads.has(id)
        ? {}
        : { updated_at: pinnedReadVersion.get(id) ?? stamp + 0.5 }),
      // The one-element array the show partial renders (`dashboard_seed_message`), which has been
      // there since 2020 and is therefore present on exactly the deployments too old to render
      // `updated_at` above.
      ...(liveLatestMessageId.has(id)
        ? { messages: [{ id: liveLatestMessageId.get(id) }] }
        : {}),
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

// WHAT THE FENCE ASKS THE ROW, as a fact of its own. The probes in chatwoot-reset and
// availability-away identify the fence's read by comparing against `OWNERSHIP_PROJECTION`, which is
// what keeps them injecting when a column is ADDED — and costs them the other half: a column
// REMOVED would move the definition with them and stay green. So that half is asserted here, where
// it is a statement about the fence rather than about a probe.
//
// Each entry names the question it answers, and none of them is decoration:
describe("the ownership fence's projection", () => {
  test("asks for the facts the decision needs, and nothing more", () => {
    expect(Object.keys(OWNERSHIP_PROJECTION).sort()).toEqual(
      [
        // who holds it — the pair, since User and AgentBot are separate id namespaces
        "assigneeId",
        "assigneeType",
        // NOTE: where the last unversioned console write stands in the source's sequence
        "consoleWriteAtMessageId",
        // the status version, which orders this decision against a later one
        "chatwootStatusAt",
        // where the status or holder last moved, which is what "a later decision" means
        "chatwootOwnershipChangedAt",
        // whether it is still open to the bot at all
        "status",
      ].sort(),
    );
  });
});

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
        // NOTE: a RUNNABLE model configuration, which the hand-back asks for: an unconfigured
        // agent cannot answer, so it cannot be handed a conversation. `openai-compatible`
        // authenticates by URL, so it needs no key.
        modelConfig: {
          provider: "openai-compatible",
          model: "local",
          baseURL: "https://llm.example.invalid/v1",
        },
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
  // ONE clock behind both timestamps: `last_activity_at` is whole seconds and `updated_at` runs a
  // fraction ahead, so the reopen ordering compares them TRUNCATED (src/modules/chatwoot/state-order.ts).
  // Two clocks would let `updated_at` outrun it by whole seconds, which no real burst does.
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

  // Whether a DIRECT turn ran for this delivery, the effect under test, and not "was the gate
  // closed", which is one inference away from it. `onDirectTurn` fires on both the outcome
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
    // The stub's Chatwoot now holds this message, which is what a live read after it would see.
    liveLatestMessageId.set(convId, messageSeq);
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

  // A CONVERSATION event, whose payload is the conversation object at top level rather than nested
  // under a `conversation` key — the shape `mirrorChatwootEvent` orders by version, and the one a
  // delayed or companion event arrives in.
  async function deliverConversationEvent(
    convId: number,
    event: string,
    // The conversation object to serialize from. Handed in when two events have to be the COMPANIONS
    // of one write: Chatwoot serializes them from the same row, so they agree on `updated_at` by
    // construction, and building one apiece would make them two different writes.
    snapshot?: ReturnType<typeof conversation>,
  ): Promise<"processed" | "skipped"> {
    deliverySeq += 1;
    const n = normalizeChatwootEvent({
      event,
      ...(snapshot ?? conversation(convId)),
    });
    if (!n) throw new Error("conversation payload did not normalize");
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
      agentBotId: OUR_BOT,
      normalized: n,
      deps,
      base: appDb,
    })) as "processed" | "skipped";
  }

  // The shape the fork stores for a reply typed on the paired phone, as it arrives on the wire:
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
        chatwootOwnershipChangedAt: true,
        statusClaimUntil: true,
        statusClaimFrom: true,
        statusClaimStampedAt: true,
        statusClaimRefusedAt: true,
        consoleWriteAtMessageId: true,
      },
    });
  }

  // The takeover's OWN lines, and only those. The `handoff` stage is shared with the gate's trail,
  // which writes an `ownership_lost` line per customer message the bot did not answer; counting those
  // would tie this assertion to how many messages the fixture sends. `via` is the discriminator: only
  // this path writes it.
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

  // The three shapes Chatwoot itself produces that are outgoing and sender-less, as the fork sends
  // them: an automation rule, a scheduled message whose author is not a User, and a CSAT survey all
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

  // A human reply joins the contact's memory as the attendant, including one sent from the phone.
  // Without it the memory of the attendance is a conversation in which only the customer spoke, and
  // the agent cannot see a price the attendant already stated.
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
        // TRUE on purpose, and it is what this conversation actually is: the device reply above is an
        // `external_echo`, which Chatwoot counts as a first reply. Passing the honest value keeps the
        // takeover axis the only thing that can make this false.
        ourSideHasSpoken: true,
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
    // Refused, and the flow log says so: a silent refusal leaves the operator nothing to read.
    expect((await takeoverRows(conv)).map((r) => r.detail)).toEqual([
      { via: "device", outcome: "refused", reason: "not_ours" },
    ]);
  });

  // An agent with no Agent Bot row on this instance cannot speak here at all: every call it makes
  // goes out with an empty token. Nothing is written, and the delivery still completes.
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
    expect((await takeoverRows(conv)).map((r) => r.detail)).toEqual([
      { via: "device", outcome: "refused", reason: "no_bot" },
    ]);
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
        // stamped ahead of everything this delivery saw, the ownership mark included, because a click
        // is a decision even when it restates the status.
        data: {
          status: "pending",
          chatwootStatusAt: (row?.chatwootStatusAt ?? 0) + 1000,
          chatwootOwnershipChangedAt: (row?.chatwootStatusAt ?? 0) + 1000,
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
    expect((await takeoverRows(conv)).map((r) => r.detail)).toEqual([
      { via: "device", outcome: "refused", reason: "later_decision" },
    ]);
  });

  // A row from before the ownership mark has only the version, and the fence falls back to it: a
  // hand-back stamped ahead of the reply still stops the takeover there.
  test("a row without the ownership mark is judged by its version", async () => {
    const conv = 8955;
    await deliver(conv, { ...customerSays("oi") });
    const row = await convRow(conv);
    whileBuildingClient = async () => {
      await suDb.conversation.update({
        where: { id: row?.id },
        data: {
          status: "pending",
          chatwootStatusAt: (row?.chatwootStatusAt ?? 0) + 1000,
          chatwootOwnershipChangedAt: null,
        },
      });
    };
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
    } finally {
      whileBuildingClient = null;
    }
    expect(toggles(conv).length).toBe(0);
    expect((await takeoverRows(conv)).map((r) => r.detail)).toEqual([
      { via: "device", outcome: "refused", reason: "later_decision" },
    ]);
  });

  // THE COMPENSATION THAT MUST NOT EXIST. The claim is taken locally and then the open fails. A
  // failed call is an UNKNOWN outcome, not a refusal (Chatwoot may commit and lose the response), so
  // handing the claim back could put the agent back to answering over the person. The claim stands
  // and its deadline resolves it: while live it refuses the `pending` the next message carries, and
  // once it runs out a conversation Chatwoot really left `pending` comes back to the agent.
  test("a failed open keeps the claim, and the next message is refused while it stands", async () => {
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
    const before = turnsRan;
    await deliver(conv, { ...customerSays("continua aí?") });
    expect(turnsRan).toBe(before);
    expect((await convRow(conv))?.status).toBe("open");
  });

  // ...and the other half of the same sentence, which is what makes the disagreement non-durable.
  // Same scenario with the deadline already spent, so the only difference between the two tests is
  // the clock — which is what makes the one above about the claim rather than about the write beside
  // it.
  test("...and settled by the next message once the claim runs out", async () => {
    const conv = 8563;
    await deliver(conv, { ...customerSays("oi") });
    failingToggles.add(conv);
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
    } finally {
      failingToggles.delete(conv);
    }
    const row = await convRow(conv);
    expect(row?.status).toBe("open");
    await suDb.conversation.update({
      where: { id: row?.id },
      data: { statusClaimUntil: new Date(Date.now() - 1) },
    });
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
      expect((await takeoverRows(conv)).map((r) => r.detail)).toEqual([
        { via: "device", outcome: "refused", reason: "moved_on" },
      ]);
    } finally {
      liveStatus.delete(conv);
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

  // ── THE CLAIM IS UNORDERABLE UNTIL THE RECONCILE STAMPS IT ──
  // The claim moves the row to `open` with no version (the toggle renders none), and deliveries run
  // detached: a commit between claim and reconcile sees the old `chatwoot_status_at` and wins.

  // WAY IN ONE: a message Chatwoot serialized before the toggle still says `pending`, and the
  // reopen exception lets a message move status. Asserted on the TURN, not the row: the reconcile
  // repairs the row, but by then the agent has spoken into a colleague's conversation.
  test("a customer message delivered while the toggle is on the wire drives no turn", async () => {
    const conv = 8560;
    await deliver(conv, { ...customerSays("oi") });
    const markBefore = (await convRow(conv))?.chatwootStatusAt ?? null;
    const before = turnsRan;
    whileToggling = async () => {
      whileToggling = null;
      await deliver(conv, { ...customerSays("e aí, tem?") });
    };
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
    } finally {
      whileToggling = null;
    }
    expect(turnsRan).toBe(before);
    // AND THE RECONCILE STAMPED THE SOURCE'S VERSION ON IT, which is the other half of the rule: the
    // claim refuses what it cannot place, and this is the number that ends that: everything past it
    // is a write committed after ours. The mark the claim was taken at is where it started.
    const claimed = await convRow(conv);
    expect(claimed?.statusClaimStampedAt ?? 0).toBeGreaterThan(markBefore ?? 0);
    expect(claimed?.statusClaimRefusedAt).toBeNull();
  });

  // ...AND A CLAIM STARTS EMPTY, whatever the row was carrying. Both columns belong to ONE claim: a
  // stamp left by an earlier one would say the source has already decided this transition, and the
  // gap would be un-fenced from its first instant.
  test("a takeover clears what an earlier claim left on the row", async () => {
    const conv = 8565;
    await deliver(conv, { ...customerSays("oi") });
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: conv },
      data: { statusClaimStampedAt: 1, statusClaimRefusedAt: 2 },
    });
    // With the live read failing, nothing stamps afterwards, so what the row holds at the end is
    // exactly what the claim itself wrote.
    failingReads.add(conv);
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
    } finally {
      failingReads.delete(conv);
    }
    const row = await convRow(conv);
    expect(row?.statusClaimFrom).toBe("pending");
    expect(row?.statusClaimStampedAt).toBeNull();
    expect(row?.statusClaimRefusedAt).toBeNull();
  });

  // WAY IN TWO: a delayed or companion `conversation_*` event. It needs no reopen exception — it
  // carries the pre-takeover `pending` and a version, and the claim advanced none, so the ordinary
  // ordered path accepts it.
  //
  // With the live read failing, the claim is the only thing that touched the row, which is what
  // isolates the question — the same pairing the test above this one uses.
  test("a conversation event carrying the pre-takeover state does not walk the claim back", async () => {
    const conv = 8561;
    await deliver(conv, { ...customerSays("oi") });
    failingReads.add(conv);
    whileToggling = async () => {
      whileToggling = null;
      // TWO INDEPENDENT ones, which is the shape a single refusal does not cover: the first is
      // refused and leaves its version on the mark, and the second must not ride that mark in. They
      // are different writes — a label and a priority, say — so they carry different versions, which
      // is exactly what tells them from the companion of one write.
      await deliverConversationEvent(conv, "conversation_updated");
      await deliverConversationEvent(conv, "conversation_updated");
    };
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
    } finally {
      whileToggling = null;
      failingReads.delete(conv);
    }
    expect((await convRow(conv))?.status).toBe("open");
  });

  // The same way in, by the OTHER shape: two companions of ONE write (the customer's reopen,
  // dispatched as `conversation_status_changed` and, since `status` is in `list_of_keys`,
  // `conversation_updated`) delivered inside the window. They agree on `updated_at` by construction,
  // which proves they describe one write, never that the write came after the claim.
  test("two companions of a write made BEFORE the claim cannot walk it back", async () => {
    const conv = 8566;
    await deliver(conv, { ...customerSays("oi") });
    // ONE snapshot, serialized here: before the colleague replied, and therefore before the toggle.
    const beforeTheReply = conversation(conv);
    failingReads.add(conv);
    whileToggling = async () => {
      whileToggling = null;
      await deliverConversationEvent(
        conv,
        "conversation_status_changed",
        beforeTheReply,
      );
      await deliverConversationEvent(
        conv,
        "conversation_updated",
        beforeTheReply,
      );
    };
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
    } finally {
      whileToggling = null;
      failingReads.delete(conv);
    }
    const row = await convRow(conv);
    expect(row?.status).toBe("open");
    // Kept, not applied: the read that would adjudicate it failed, so the claim holds the version and
    // the deadline is what ends the fence.
    expect(row?.statusClaimRefusedAt).toBe(beforeTheReply.updated_at);
  });

  // What the claim must NOT cost: the conversation coming back. Once the source has stamped our
  // transition, a payload ahead of that version is a later write whichever event carries it, and if
  // the hand-back's own event is lost the next carrier is the customer's message. Asserted on the
  // TURN: the harm is the message acknowledged with nobody answering.
  test("a customer message newer than the stamped claim brings the bot back", async () => {
    const conv = 8567;
    await deliver(conv, { ...customerSays("oi") });
    await deliver(conv, { ...deviceReply("já te respondo") });
    expect((await convRow(conv))?.status).toBe("open");
    // The colleague hands the conversation back inside the claim's 45 seconds, and the event saying
    // so never arrives.
    liveStatus.set(conv, "pending");
    const before = turnsRan;
    await deliver(conv, { ...customerSays("consegue me ajudar?") });
    expect((await convRow(conv))?.status).toBe("pending");
    expect(turnsRan).toBe(before + 1);
  });

  // THE MARK IS ONE OF THE TERMS THE CLAIM'S SWAP COMPARES, like the assignee: it is ordered apart
  // from the status version, so a console write (setting a bot-owned `pending` conversation to
  // `pending` again) can move it alone, and without the term the swap would beat a newer decision.
  // Asked of the swap DIRECTLY: nothing is awaited between the fence's read and the statement, so the
  // window cannot be opened from inside this process.
  test("the claim loses to a console write that moved only the mark", async () => {
    const conv = 8569;
    await deliver(conv, { ...customerSays("oi") });
    const seeded = await convRow(conv);
    const seen = {
      statusAt: seeded?.chatwootStatusAt ?? null,
      ownershipChangedAt: seeded?.chatwootOwnershipChangedAt ?? null,
      assigneeType: "AgentBot",
      assigneeId: OUR_BOT,
      consoleWriteAtMessageId: seeded?.consoleWriteAtMessageId ?? null,
    };
    // The console write lands: status, version and assignee all untouched, a new mark stamped.
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: conv },
      data: { consoleWriteAtMessageId: 99_999 },
    });
    expect(
      await claimOpenForHumanQueue({
        tenantId,
        instanceId,
        conversationId: conv,
        seen,
        base: appDb,
      }),
    ).toBeNull();
    expect((await convRow(conv))?.status).toBe("pending");
    // A positive control on the same row, so the null above is the term and not the fixture: read
    // the mark as it now stands and the same swap succeeds.
    expect(
      await claimOpenForHumanQueue({
        tenantId,
        instanceId,
        conversationId: conv,
        seen: { ...seen, consoleWriteAtMessageId: 99_999 },
        base: appDb,
      }),
    ).not.toBeNull();
    expect((await convRow(conv))?.status).toBe("open");
  });

  // THE SWAP PINS THE MARK THE FENCE COMPARED. On a row with a ownership mark, a restatement that moves
  // only the version between the read and the swap is not a later decision, so the claim stands; on
  // a row without one, the version is all there is, and a move of it loses the swap.
  test("the claim pins the ownership mark, and the version only where there is none", async () => {
    for (const [conv, legacy] of [
      [8956, false],
      [8957, true],
    ] as const) {
      await deliver(conv, { ...customerSays("oi") });
      if (legacy) {
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: conv },
          data: { chatwootOwnershipChangedAt: null },
        });
      }
      const seeded = await convRow(conv);
      if (!legacy) expect(seeded?.chatwootOwnershipChangedAt).not.toBeNull();
      // The restatement lands: same status, the version a step ahead, the ownership mark where it was.
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: conv },
        data: { chatwootStatusAt: (seeded?.chatwootStatusAt ?? 0) + 1 },
      });
      const claimed = await claimOpenForHumanQueue({
        tenantId,
        instanceId,
        conversationId: conv,
        seen: {
          statusAt: seeded?.chatwootStatusAt ?? null,
          ownershipChangedAt: seeded?.chatwootOwnershipChangedAt ?? null,
          assigneeType: "AgentBot",
          assigneeId: OUR_BOT,
          consoleWriteAtMessageId: seeded?.consoleWriteAtMessageId ?? null,
        },
        base: appDb,
      });
      if (legacy) expect(claimed).toBeNull();
      else expect(claimed).not.toBeNull();
      expect((await convRow(conv))?.status).toBe(legacy ? "pending" : "open");
    }
  });

  // The compare-and-swap does not order the claim against a mirror transaction that has already
  // READ the row and not yet written, which would commit over the `open`. The lock the mirror and
  // the reconcile share orders them, so the claim queues behind whoever holds it.
  test("the claim waits for whoever holds the conversation", async () => {
    const conv = 8568;
    await deliver(conv, { ...customerSays("oi") });
    const seeded = await convRow(conv);
    const claim = () =>
      claimOpenForHumanQueue({
        tenantId,
        instanceId,
        conversationId: conv,
        seen: {
          statusAt: seeded?.chatwootStatusAt ?? null,
          ownershipChangedAt: seeded?.chatwootOwnershipChangedAt ?? null,
          assigneeType: "AgentBot",
          assigneeId: OUR_BOT,
          consoleWriteAtMessageId: seeded?.consoleWriteAtMessageId ?? null,
        },
        base: appDb,
      });
    // A holder rather than a `let`, so the control-flow analysis does not narrow the answer to the
    // `null` it starts on: the only writer is the callback below.
    const claimed: { until: Date | null } = { until: null };
    let running: Promise<void> | null = null;
    const startedAt = Date.now();
    await suDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${instanceId}:${conv}`})::bigint)`;
      running = claim().then((v) => {
        claimed.until = v;
      });
      // Long enough for an unlocked write to have finished several times over, and to separate the
      // two candidate start points for the deadline below. It cannot go flaky in the direction that
      // matters: a slow machine only delays the claim further.
      await Bun.sleep(400);
      expect(claimed.until).toBeNull();
      expect((await convRow(conv))?.status).toBe("pending");
    });
    await running;
    // The deadline the claim answers with is the one it WROTE, and it is stamped past the wait: the
    // countdown is the fence's, not the queue's.
    const row = await convRow(conv);
    expect(row?.status).toBe("open");
    // The deadline the claim answers with is the one it WROTE...
    expect(claimed.until?.getTime()).toBe(row?.statusClaimUntil?.getTime());
    // ...and the countdown starts past the wait, not at the call: a deadline stamped before the lock
    // would land at `startedAt + TTL` and spend the queueing on the fence it promises.
    expect(claimed.until?.getTime() ?? 0).toBeGreaterThan(
      startedAt + STATUS_CLAIM_TTL_MS + 100,
    );
  });

  // The claim cannot tell an event frozen BEFORE our write from one committed after it (the toggle
  // renders no version), so it refuses both. Dropping a real hand-back would lose it (we ack and
  // Chatwoot never redelivers), so the refusal is DEFERRED with its version, and the reconcile that
  // learns ours adjudicates. The live read is pinned below the hand-back's version, as a GET issued
  // before it committed would be.
  test("a hand-back committed while the toggle is on the wire survives the reconcile", async () => {
    const conv = 8564;
    await deliver(conv, { ...customerSays("oi") });
    const pinned = stamp + 0.5;
    pinnedReadVersion.set(conv, pinned);
    whileToggling = async () => {
      whileToggling = null;
      stamp += 100;
      // Both of them, because that is what a status change dispatches: CONVERSATION_STATUS_CHANGED
      // always, and `conversation_updated` because `status` is in the conversation's `list_of_keys`.
      // ONE snapshot for the two, which is how Chatwoot produces them: same row, same `updated_at`.
      const handback = conversation(conv);
      await deliverConversationEvent(conv, "conversation_updated", handback);
      await deliverConversationEvent(
        conv,
        "conversation_status_changed",
        handback,
      );
    };
    try {
      await deliver(conv, { ...deviceReply("já te respondo") });
    } finally {
      whileToggling = null;
      pinnedReadVersion.delete(conv);
    }
    const row = await convRow(conv);
    expect(row?.status).toBe("pending");
    // The mark is the hand-back's, not the reconcile's: the adjudication wrote the version the
    // refusal had kept, over the older one our own read came back with.
    expect(row?.chatwootStatusAt ?? 0).toBeGreaterThan(pinned);
  });

  // A person sends a closing line and resolves within the same second (a macro does both in one
  // request). Chatwoot's toggle has no compare-and-set, so a toggle that lands after the resolve
  // reopens what the person closed.
  test("a resolve made right after the person's reply stays resolved, and is announced once", async () => {
    const conv = 8572;
    await deliver(conv, { ...customerSays("oi") });
    const sub = await suDb.webhookSubscription.create({
      data: {
        tenantId,
        url: "https://example.com/hook",
        events: ["conversation.status_changed"],
      },
    });
    // The resolve commits while the toggle is on the wire, after the fence read `pending`.
    whileToggling = async () => {
      whileToggling = null;
      liveStatus.set(conv, "resolved");
      const resolved = conversation(conv);
      await deliverConversationEvent(conv, "conversation_updated", resolved);
      await deliverConversationEvent(
        conv,
        "conversation_status_changed",
        resolved,
      );
    };
    try {
      await deliver(conv, composerReply("obrigado, até mais"));
    } finally {
      whileToggling = null;
    }
    try {
      expect(liveStatus.get(conv)).toBe("resolved");
      expect((await convRow(conv))?.status).toBe("resolved");
      const out = await suDb.outboundWebhookDelivery.findMany({
        where: { tenantId, subscriptionId: sub.id },
        orderBy: { id: "asc" },
      });
      const statuses = out.map(
        (o) => (o.payload as { data: { status: string } }).data.status,
      );
      expect(statuses.filter((s) => s === "resolved")).toEqual(["resolved"]);
    } finally {
      await suDb.outboundWebhookDelivery.deleteMany({
        where: { subscriptionId: sub.id },
      });
      await suDb.webhookSubscription.delete({ where: { id: sub.id } });
    }
  });

  // The statuses announced on the outbound bus for one conversation, in order, while `fn` runs.
  async function announcedStatuses(
    conv: number,
    fn: () => Promise<void>,
  ): Promise<string[]> {
    const sub = await suDb.webhookSubscription.create({
      data: {
        tenantId,
        url: "https://example.com/hook",
        events: ["conversation.status_changed"],
      },
    });
    try {
      await fn();
      const row = await convRow(conv);
      const out = await suDb.outboundWebhookDelivery.findMany({
        where: { tenantId, subscriptionId: sub.id },
        orderBy: { id: "asc" },
      });
      return out
        .map(
          (o) =>
            (o.payload as { data: { conversation_id: string; status: string } })
              .data,
        )
        .filter((d) => row && d.conversation_id === String(row.id))
        .map((d) => d.status);
    } finally {
      await suDb.outboundWebhookDelivery.deleteMany({
        where: { subscriptionId: sub.id },
      });
      await suDb.webhookSubscription.delete({ where: { id: sub.id } });
    }
  }

  test("a resolve whose own event never arrives still reaches the mirror, announced", async () => {
    const conv = 8579;
    await deliver(conv, { ...customerSays("oi") });
    whileToggling = async () => {
      whileToggling = null;
      liveStatus.set(conv, "resolved");
    };
    const statuses = await announcedStatuses(conv, async () => {
      try {
        await deliver(conv, composerReply("até mais"));
      } finally {
        whileToggling = null;
      }
    });
    expect(liveStatus.get(conv)).toBe("resolved");
    expect((await convRow(conv))?.status).toBe("resolved");
    expect(statuses).toEqual(["open", "resolved"]);
  });

  test("on a Chatwoot that renders no version, a refused toggle still puts the mirror on the source", async () => {
    const conv = 8583;
    await deliver(conv, { ...customerSays("oi") });
    const rowId = String((await convRow(conv))?.id);
    const published: Record<string, unknown>[] = [];
    setPublisher((_topic, data) => {
      published.push(JSON.parse(String(data)));
    });
    unversionedReads.add(conv);
    whileToggling = async () => {
      whileToggling = null;
      liveStatus.set(conv, "resolved");
    };
    try {
      const statuses = await announcedStatuses(conv, async () => {
        try {
          await deliver(conv, composerReply("até mais"));
        } finally {
          whileToggling = null;
        }
      });
      expect(liveStatus.get(conv)).toBe("resolved");
      expect((await convRow(conv))?.status).toBe("resolved");
      expect(statuses).toEqual(["open", "resolved"]);
      // The delivery's own snapshot, the claim's `open`, and then what the row now holds.
      expect(
        published
          .filter(
            (d) => d.type === "conversation" && d.conversationId === rowId,
          )
          .map((d) => d.status),
      ).toEqual(["pending", "open", "resolved"]);
    } finally {
      unversionedReads.delete(conv);
      setPublisher(() => undefined);
    }
  });

  // A trigger stands in for a writer the advisory lock does not order: it drops the withdrawal's
  // UPDATE of this row, which is what the compare-and-set sees when such a write lands between its
  // read and its write.
  test("on a Chatwoot that renders no version, a withdrawal whose write lost announces nothing", async () => {
    const conv = 8588;
    await deliver(conv, { ...customerSays("oi") });
    const rowId = String((await convRow(conv))?.id);
    const fn = `skip_withdrawal_${process.pid}`;
    await suDb.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
    );
    await suDb.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE UPDATE ON conversations FOR EACH ROW WHEN (OLD.id = ${rowId} AND OLD.status = 'open' AND NEW.status = 'resolved') EXECUTE FUNCTION ${fn}()`,
    );
    const published: Record<string, unknown>[] = [];
    setPublisher((_topic, data) => {
      published.push(JSON.parse(String(data)));
    });
    unversionedReads.add(conv);
    whileToggling = async () => {
      whileToggling = null;
      liveStatus.set(conv, "resolved");
    };
    try {
      const statuses = await announcedStatuses(conv, async () => {
        try {
          await deliver(conv, composerReply("até mais"));
        } finally {
          whileToggling = null;
        }
      });
      expect((await convRow(conv))?.status).toBe("open");
      expect(statuses).toEqual(["open"]);
      expect(
        published
          .filter(
            (d) => d.type === "conversation" && d.conversationId === rowId,
          )
          .map((d) => d.status),
      ).toEqual(["pending", "open"]);
    } finally {
      unversionedReads.delete(conv);
      setPublisher(() => undefined);
      await suDb.$executeRawUnsafe(`DROP TRIGGER ${fn} ON conversations`);
      await suDb.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }
  });

  // A failed statement aborts a Postgres transaction whether or not the error is caught, so a fan-out
  // that fails (a subscription deleted between its read and the delivery insert) would roll back the
  // claim it was announcing. A trigger makes the insert fail.
  test("a takeover whose announcement fails still holds its claim", async () => {
    const conv = 8589;
    await deliver(conv, { ...customerSays("oi") });
    const fn = `fail_delivery_${process.pid}`;
    await suDb.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'delivery insert refused'; END $$`,
    );
    await suDb.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON outbound_webhook_deliveries FOR EACH ROW WHEN (NEW.tenant_id = ${tenantId}) EXECUTE FUNCTION ${fn}()`,
    );
    try {
      await announcedStatuses(conv, async () => {
        await deliver(conv, composerReply("assumo daqui"));
      });
      expect(liveStatus.get(conv)).toBe("open");
      const row = await convRow(conv);
      expect(row?.status).toBe("open");
      expect(row?.statusClaimUntil).not.toBeNull();
    } finally {
      await suDb.$executeRawUnsafe(
        `DROP TRIGGER ${fn} ON outbound_webhook_deliveries`,
      );
      await suDb.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }
  });

  test("on a Chatwoot that renders no version, a refused toggle leaves an assignment made meanwhile alone", async () => {
    const conv = 8586;
    await deliver(conv, { ...customerSays("oi") });
    unversionedReads.add(conv);
    // A person resolves and is assigned while the toggle is on the wire; the live read that follows
    // still names our bot, and carries no version to say it is older than that assignment.
    whileToggling = async () => {
      whileToggling = null;
      liveStatus.set(conv, "resolved");
      const snapshot = conversation(conv);
      await deliverConversationEvent(conv, "conversation_updated", {
        ...snapshot,
        meta: {
          ...snapshot.meta,
          assignee_type: "User",
          assignee: { id: 5, name: "Ana" },
        },
      });
    };
    try {
      await deliver(conv, composerReply("até mais"));
    } finally {
      whileToggling = null;
      unversionedReads.delete(conv);
    }
    const row = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: conv },
      select: { status: true, assigneeType: true, assigneeId: true },
    });
    expect(row).toEqual({
      status: "resolved",
      assigneeType: "User",
      assigneeId: 5,
    });
  });

  test("on a Chatwoot that renders no version, a reopen landing after the corrective read is not undone", async () => {
    const conv = 8587;
    await deliver(conv, { ...customerSays("oi") });
    unversionedReads.add(conv);
    whileToggling = async () => {
      whileToggling = null;
      liveStatus.set(conv, "resolved");
      // The read that follows the refusal sees `resolved`; an operator reopens right after it.
      whileReading.set(conv, async () => {
        liveStatus.set(conv, "open");
        await deliverConversationEvent(conv, "conversation_status_changed");
      });
    };
    try {
      await deliver(conv, composerReply("até mais"));
    } finally {
      whileToggling = null;
      whileReading.delete(conv);
      unversionedReads.delete(conv);
    }
    expect((await convRow(conv))?.status).toBe("open");
  });

  // A message delivered with a snapshot taken EARLIER than the moment it is delivered: what a
  // message_created carries when the write it caused has already reached the mirror.
  async function deliverWithSnapshot(
    convId: number,
    over: Record<string, unknown>,
    snapshot: ReturnType<typeof conversation>,
  ): Promise<void> {
    deliverySeq += 1;
    messageSeq += 1;
    liveLatestMessageId.set(convId, messageSeq);
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageSeq,
      private: false,
      ...over,
      conversation: snapshot,
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `hr-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: "PENDING",
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: OUR_BOT,
      normalized: n,
      deps,
      base: appDb,
    });
  }

  // THE REPLY'S OWN ECHO. A person's reply makes Chatwoot write the conversation again (the first
  // reply time, the waiting clock) and emit a conversation_updated for that write, same status, a few
  // milliseconds newer than the snapshot the reply itself carries. When that event reaches the mirror
  // first, it is a restatement and not a later decision, and the takeover still opens.
  test("the reply's own conversation event does not stop the takeover", async () => {
    const conv = 8951;
    await deliver(conv, { ...customerSays("oi, qual o horário?") });
    const replySnapshot = conversation(conv);
    await deliverConversationEvent(conv, "conversation_updated", {
      ...conversation(conv),
      changed_attributes: [
        {
          first_reply_created_at: {
            previous_value: null,
            current_value: stamp,
          },
        },
        { waiting_since: { previous_value: stamp - 5, current_value: null } },
      ],
    } as ReturnType<typeof conversation>);
    await deliverWithSnapshot(
      conv,
      { ...composerReply("Olá! Aqui é a Ana.") },
      replySnapshot,
    );
    expect(liveStatus.get(conv)).toBe("open");
    const rows = await takeoverRows(conv);
    expect(rows.map((r) => r.detail)).toEqual([
      { via: "composer", outcome: "taken_over" },
    ]);
  });

  // The other half: a decision that DID come after the reply still wins, and now says so where the
  // operator reads.
  test("a hand-back after the reply still stops it, with a line saying why", async () => {
    const conv = 8952;
    await deliver(conv, { ...customerSays("oi") });
    const replySnapshot = conversation(conv);
    await deliverConversationEvent(conv, "conversation_status_changed", {
      ...conversation(conv),
      status: "open",
      changed_attributes: [
        { status: { previous_value: "pending", current_value: "open" } },
      ],
    } as ReturnType<typeof conversation>);
    await deliverConversationEvent(conv, "conversation_status_changed", {
      ...conversation(conv),
      status: "pending",
      changed_attributes: [{ status: ["open", "pending"] }],
    } as ReturnType<typeof conversation>);
    const before = toggles(conv).length;
    await deliverWithSnapshot(
      conv,
      { ...composerReply("Olá! Aqui é a Ana.") },
      replySnapshot,
    );
    expect(toggles(conv).length).toBe(before);
    expect(liveStatus.get(conv) ?? "pending").toBe("pending");
    const rows = await takeoverRows(conv);
    expect(rows.map((r) => r.detail)).toEqual([
      { via: "composer", outcome: "refused", reason: "later_decision" },
    ]);
  });

  // The hand-back reaches the mirror BEHIND a newer restatement of the same `pending`, which moved
  // only the status mark. The late event still says the status moved, after the reply, and wins.
  test("a hand-back delivered behind a newer restatement still stops it", async () => {
    const conv = 8958;
    await deliver(conv, { ...customerSays("oi") });
    const replySnapshot = conversation(conv);
    // The fork's status event, as it leaves: no changed_attributes, the event name is the word.
    const handBack = {
      ...conversation(conv),
      status: "pending",
    } as ReturnType<typeof conversation>;
    await deliverConversationEvent(conv, "conversation_updated");
    await deliverConversationEvent(
      conv,
      "conversation_status_changed",
      handBack,
    );
    const before = toggles(conv).length;
    await deliverWithSnapshot(
      conv,
      { ...composerReply("Olá!") },
      replySnapshot,
    );
    expect(toggles(conv).length).toBe(before);
    expect((await takeoverRows(conv)).map((r) => r.detail)).toEqual([
      { via: "composer", outcome: "refused", reason: "later_decision" },
    ]);
  });

  // A hand-back by assignment alone: the conversation goes to a person and comes back to the bot
  // with the status `pending` throughout. Each move is a decision after the reply.
  test("a hand-back by assignment alone still stops it", async () => {
    const conv = 8960;
    await deliver(conv, { ...customerSays("oi") });
    const replySnapshot = conversation(conv);
    const held = (assignee_type: string, id: number) =>
      ({
        ...conversation(conv),
        status: "pending",
        meta: {
          assignee_type,
          assignee: { id, name: "Atendente" },
          sender: { id: 77, name: "Cliente" },
        },
      }) as ReturnType<typeof conversation>;
    await deliverConversationEvent(
      conv,
      "conversation_updated",
      held("User", 5),
    );
    await deliverConversationEvent(
      conv,
      "conversation_updated",
      held("AgentBot", OUR_BOT),
    );
    const before = toggles(conv).length;
    await deliverWithSnapshot(
      conv,
      { ...composerReply("Olá!") },
      replySnapshot,
    );
    expect(toggles(conv).length).toBe(before);
    expect((await takeoverRows(conv)).map((r) => r.detail)).toEqual([
      { via: "composer", outcome: "refused", reason: "later_decision" },
    ]);
  });

  // The bot assignee coming back is named in changed_attributes, and that event reaches the mirror
  // behind a newer restatement of the same holder: the late event is the only word of the move.
  test("an assignment back to the bot delivered behind a newer restatement still stops it", async () => {
    const conv = 8961;
    await deliver(conv, { ...customerSays("oi") });
    const replySnapshot = conversation(conv);
    const back = {
      ...conversation(conv),
      status: "pending",
      changed_attributes: [
        {
          assignee_agent_bot_id: {
            previous_value: null,
            current_value: OUR_BOT,
          },
        },
      ],
    } as ReturnType<typeof conversation>;
    await deliverConversationEvent(conv, "conversation_updated");
    await deliverConversationEvent(conv, "conversation_updated", back);
    const before = toggles(conv).length;
    await deliverWithSnapshot(
      conv,
      { ...composerReply("Olá!") },
      replySnapshot,
    );
    expect(toggles(conv).length).toBe(before);
    expect((await takeoverRows(conv)).map((r) => r.detail)).toEqual([
      { via: "composer", outcome: "refused", reason: "later_decision" },
    ]);
  });

  // The open in between never reached the mirror; the event that closed it says the status moved.
  // Two words for it on the wire: the status event by its name (it carries no changed_attributes),
  // and the companion conversation_updated by naming `status` among what changed.
  for (const [conv, event] of [
    [8953, "conversation_status_changed"],
    [8959, "conversation_updated"],
  ] as const)
    test(`a hand-back the mirror only learns from the source's own word still stops it (${event})`, async () => {
      await deliver(conv, { ...customerSays("oi") });
      const replySnapshot = conversation(conv);
      await deliverConversationEvent(conv, event, {
        ...conversation(conv),
        status: "pending",
        ...(event === "conversation_updated"
          ? {
              changed_attributes: [
                {
                  status: { previous_value: "open", current_value: "pending" },
                },
              ],
            }
          : {}),
      } as ReturnType<typeof conversation>);
      const before = toggles(conv).length;
      await deliverWithSnapshot(
        conv,
        { ...composerReply("Olá!") },
        replySnapshot,
      );
      expect(toggles(conv).length).toBe(before);
      const rows = await takeoverRows(conv);
      expect(rows.map((r) => r.detail)).toEqual([
        { via: "composer", outcome: "refused", reason: "later_decision" },
      ]);
    });

  // The console half of the ownership mark, through the real console function: a status click that
  // restates `pending` is still the operator's decision, so it moves the mark the takeover compares
  // against. A restatement Chatwoot emits on its own does not (the test above with the reply's echo).
  test("a console click that restates the status still moves the ownership mark", async () => {
    const conv = 8954;
    await deliver(conv, { ...customerSays("oi") });
    const before = await convRow(conv);
    if (!before) throw new Error("no mirrored conversation");
    expect(before.status).toBe("pending");
    await setConversationStatus(
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      before.id,
      "pending",
      deps,
      appDb,
    );
    const after = await convRow(conv);
    expect(after?.chatwootOwnershipChangedAt).not.toBeNull();
    expect(after?.chatwootOwnershipChangedAt).toBe(
      after?.chatwootStatusAt ?? -1,
    );
    expect(after?.chatwootStatusAt ?? 0).toBeGreaterThan(
      before.chatwootOwnershipChangedAt ?? 0,
    );
  });

  test("a takeover with nothing in the way opens, and is announced once", async () => {
    const conv = 8575;
    await deliver(conv, { ...customerSays("oi") });
    const statuses = await announcedStatuses(conv, async () => {
      await deliver(conv, composerReply("assumo daqui"));
      // Chatwoot's own event for our toggle, which must not announce the transition a second time.
      await deliverConversationEvent(conv, "conversation_status_changed");
    });
    expect(liveStatus.get(conv)).toBe("open");
    expect(statuses).toEqual(["open"]);
    expect(
      toggles(conv).map(
        (t) => (t.body as { expected_status?: string }).expected_status,
      ),
    ).toEqual(["pending"]);
  });

  for (const versioned of [true, false]) {
    test(`a console resolve is announced once, ${versioned ? "versioned" : "unversioned"}`, async () => {
      const conv = versioned ? 8577 : 8578;
      await deliver(conv, { ...customerSays("oi") });
      if (!versioned) unversionedReads.add(conv);
      try {
        const statuses = await announcedStatuses(conv, async () => {
          const row = await convRow(conv);
          if (!row) throw new Error("no mirrored conversation");
          await setConversationStatus(
            { tenantId, userId: null, role: "TENANT_ADMIN" },
            row.id,
            "resolved",
            deps,
            appDb,
          );
          // Chatwoot's own event for the click, arriving after the console wrote the row.
          await deliverConversationEvent(conv, "conversation_status_changed");
        });
        expect((await convRow(conv))?.status).toBe("resolved");
        expect(statuses).toEqual(["resolved"]);
      } finally {
        unversionedReads.delete(conv);
      }
    });
  }

  function deliverReplyOff() {
    return deviceReply("já te respondo");
  }

  // AN OPERATOR ASKED FOR THE AGENT BACK, and a reply frozen before that click must not undo it.
  //
  // Driven through the real console function: what matters is what `mirrorConsoleWrite` writes when
  // its live read cannot be versioned, so a fixture stamping the mark itself would test an input the
  // console never produces. `unversionedReads` reaches that branch, which on a Chatwoot older than
  // 4.0.2 (no `updated_at` rendered) is every path.
  describe("an unversioned hand-back outranks a reply frozen before it", () => {
    // The click, with the delivery's payload captured BEFORE it: Chatwoot serialized the
    // reply, then the operator clicked, then the reply arrived.
    async function handBack(convId: number): Promise<string> {
      const row = await convRow(convId);
      if (!row) throw new Error("no mirrored conversation");
      return returnConversationToAgent(
        { tenantId, userId: null, role: "TENANT_ADMIN" },
        row.id,
        deps,
        appDb,
      );
    }

    test("the reply that was already there does not reopen the conversation", async () => {
      const conv = 8600;
      unversionedReads.add(conv);
      try {
        // A first human reply, so the conversation is `open` and the mirror knows it — the state an
        // operator is looking at when they click.
        await deliver(conv, composerReply("eu assumo"));
        expect(liveStatus.get(conv)).toBe("open");
        // The reply Chatwoot froze next, still on the wire. Built here and delivered after the
        // click, which is the whole of the race.
        messageSeq += 1;
        const frozenId = messageSeq;
        const frozen = normalizeChatwootEvent({
          event: "message_created",
          id: frozenId,
          private: false,
          ...composerReply("já respondi por aqui"),
          conversation: conversation(conv),
        });
        if (!frozen) throw new Error("payload did not normalize");
        liveLatestMessageId.set(conv, frozenId);

        expect(await handBack(conv)).toBe("returned");
        expect(liveStatus.get(conv)).toBe("pending");
        const afterClick = await convRow(conv);
        expect(afterClick?.status).toBe("pending");
        // The mark the console left, read off the row rather than assumed: it names the message the
        // source already had, which is the frozen delivery's own.
        const marked = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: conv },
          select: { consoleWriteAtMessageId: true, chatwootStatusAt: true },
        });
        expect(marked.consoleWriteAtMessageId).toBe(frozenId);

        deliverySeq += 1;
        const delivery = await suDb.chatwootWebhookDelivery.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            deliveryId: `hr-${process.pid}-${deliverySeq}`,
            event: "message_created",
            status: "PENDING",
          },
          select: { id: true },
        });
        // From here on, every reopen this delivery could ask for. The count is taken as a WINDOW
        // rather than over the whole run, because the first reply legitimately opened this
        // conversation and a total would be one either way.
        const before = posted.length;
        await processChatwootDelivery({
          tenantId,
          instanceId,
          deliveryRowId: delivery.id,
          agentBotId: OUR_BOT,
          normalized: frozen,
          deps,
          base: appDb,
        });

        // THE EFFECT, read off the stub's Chatwoot and off the row: the operator's click stands.
        expect(liveStatus.get(conv)).toBe("pending");
        const after = await convRow(conv);
        expect(after?.status).toBe("pending");
        // ...and the operator can read why: the first reply's takeover, then this one refused.
        expect((await takeoverRows(conv)).map((r) => r.detail)).toEqual([
          { via: "composer", outcome: "taken_over" },
          { via: "composer", outcome: "refused", reason: "handed_back" },
        ]);
        // And nothing was even ASKED of Chatwoot, which is what says the takeover stood down at the
        // fence rather than being undone by something downstream of it.
        expect(
          posted.slice(before).filter((p) => p.url.includes("/toggle_status")),
        ).toEqual([]);
      } finally {
        unversionedReads.delete(conv);
      }
    });

    // THE OTHER BUTTON THAT HANDS BACK. Pressing `pending` on a bot-owned conversation Chatwoot has
    // as `open` says what "Return to AI" says and goes through the same unversioned fallback, so it
    // takes its own reading too, or a frozen reply would undo it (`open`, `pending`, `open` again).
    test("a status button hands back too, and is ordered the same way", async () => {
      const conv = 8611;
      unversionedReads.add(conv);
      try {
        // The first reply opens the conversation, which is the state the operator is looking at.
        await deliver(conv, composerReply("eu assumo"));
        expect(liveStatus.get(conv)).toBe("open");
        // The reply Chatwoot froze next, still on the wire.
        messageSeq += 1;
        const frozenId = messageSeq;
        const frozen = normalizeChatwootEvent({
          event: "message_created",
          id: frozenId,
          private: false,
          ...composerReply("já respondi por aqui"),
          conversation: conversation(conv),
        });
        if (!frozen) throw new Error("payload did not normalize");
        liveLatestMessageId.set(conv, frozenId);

        const row = await convRow(conv);
        if (!row) throw new Error("no mirrored conversation");
        await setConversationStatus(
          { tenantId, userId: null, role: "TENANT_ADMIN" },
          row.id,
          "pending",
          deps,
          appDb,
        );
        expect(liveStatus.get(conv)).toBe("pending");
        const marked = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: conv },
          select: { consoleWriteAtMessageId: true },
        });
        expect(marked.consoleWriteAtMessageId).toBe(frozenId);

        deliverySeq += 1;
        const delivery = await suDb.chatwootWebhookDelivery.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            deliveryId: `hr-${process.pid}-${deliverySeq}`,
            event: "message_created",
            status: "PENDING",
          },
          select: { id: true },
        });
        const before = posted.length;
        await processChatwootDelivery({
          tenantId,
          instanceId,
          deliveryRowId: delivery.id,
          agentBotId: OUR_BOT,
          normalized: frozen,
          deps,
          base: appDb,
        });

        expect(liveStatus.get(conv)).toBe("pending");
        expect((await convRow(conv))?.status).toBe("pending");
        expect(
          posted.slice(before).filter((p) => p.url.includes("/toggle_status")),
        ).toEqual([]);
      } finally {
        unversionedReads.delete(conv);
      }
    });

    // And the reading is before the press on this path too, asked at the only point a test can
    // stand: the toggle is on the wire and a message written there is strictly after the button.
    test("a reply written during the press is not covered by the mark", async () => {
      const conv = 8613;
      unversionedReads.add(conv);
      try {
        await deliver(conv, composerReply("eu assumo"));
        const beforePress = liveLatestMessageId.get(conv) ?? 0;
        const during = beforePress + 7;
        whileToggling = async () => {
          liveLatestMessageId.set(conv, during);
        };
        const row = await convRow(conv);
        if (!row) throw new Error("no mirrored conversation");
        try {
          await setConversationStatus(
            { tenantId, userId: null, role: "TENANT_ADMIN" },
            row.id,
            "pending",
            deps,
            appDb,
          );
        } finally {
          whileToggling = null;
        }
        const marked = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: conv },
          select: { consoleWriteAtMessageId: true },
        });
        expect(marked.consoleWriteAtMessageId).toBe(beforePress);

        messageSeq = during;
        await deliver(conv, composerReply("voltei, deixa comigo"));
        expect(liveStatus.get(conv)).toBe("open");
      } finally {
        unversionedReads.delete(conv);
      }
    });

    // And the same button does not swallow the other direction either: a colleague who answers AFTER
    // the press is a real handover, exactly as after a hand-back.
    test("a reply typed after a status button still takes over", async () => {
      const conv = 8612;
      unversionedReads.add(conv);
      try {
        await deliver(conv, composerReply("eu assumo"));
        const row = await convRow(conv);
        if (!row) throw new Error("no mirrored conversation");
        await setConversationStatus(
          { tenantId, userId: null, role: "TENANT_ADMIN" },
          row.id,
          "pending",
          deps,
          appDb,
        );
        expect(liveStatus.get(conv)).toBe("pending");

        await deliver(conv, composerReply("voltei, deixa comigo"));

        expect(liveStatus.get(conv)).toBe("open");
        expect((await convRow(conv))?.status).toBe("open");
      } finally {
        unversionedReads.delete(conv);
      }
    });

    // The other direction, and the reason a deadline could not be the instrument: a colleague who
    // answers AFTER the operator hands back is a real handover, and the agent has to step off.
    test("a reply typed after the click still takes the conversation over", async () => {
      const conv = 8601;
      unversionedReads.add(conv);
      try {
        await deliver(conv, composerReply("eu assumo"));
        expect(await handBack(conv)).toBe("returned");
        expect(liveStatus.get(conv)).toBe("pending");

        await deliver(conv, composerReply("voltei, deixa comigo"));

        expect(liveStatus.get(conv)).toBe("open");
        const after = await convRow(conv);
        expect(after?.status).toBe("open");
      } finally {
        unversionedReads.delete(conv);
      }
    });

    // THE HALF THIS DOES NOT REACH, asserted so it cannot be read as covered. A live read that fails
    // outright names no message, so there is no mark and the fence has nothing to order. The id the
    // mark would need is that of a message Chatwoot has and we have not seen, so no watermark of ours
    // can supply it.
    test("a console read that failed outright leaves the gap open", async () => {
      const conv = 8602;
      failingReads.add(conv);
      try {
        await deliver(conv, composerReply("eu assumo"));
        messageSeq += 1;
        const frozenId = messageSeq;
        const frozen = normalizeChatwootEvent({
          event: "message_created",
          id: frozenId,
          private: false,
          ...composerReply("já respondi por aqui"),
          conversation: conversation(conv),
        });
        if (!frozen) throw new Error("payload did not normalize");
        liveLatestMessageId.set(conv, frozenId);

        expect(await handBack(conv)).toBe("returned");
        const marked = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: conv },
          select: { consoleWriteAtMessageId: true },
        });
        expect(marked.consoleWriteAtMessageId).toBeNull();

        deliverySeq += 1;
        const delivery = await suDb.chatwootWebhookDelivery.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            deliveryId: `hr-${process.pid}-${deliverySeq}`,
            event: "message_created",
            status: "PENDING",
          },
          select: { id: true },
        });
        await processChatwootDelivery({
          tenantId,
          instanceId,
          deliveryRowId: delivery.id,
          agentBotId: OUR_BOT,
          normalized: frozen,
          deps,
          base: appDb,
        });
        // NOTE: the known gap, named as such: with no coordinate on either side, the reply wins.
        expect(liveStatus.get(conv)).toBe("open");
      } finally {
        failingReads.delete(conv);
      }
    });

    // NEVER BACKWARDS. Two console writes are separate requests and nothing serializes them, so the
    // older one can commit last; assigned rather than GREATEST it would move the mark back and let
    // every reply between the two clicks through.
    test("an older console write cannot move the mark back", async () => {
      const conv = 8603;
      unversionedReads.add(conv);
      try {
        await deliver(conv, composerReply("eu assumo"));
        const newest = messageSeq;
        liveLatestMessageId.set(conv, newest);
        await handBack(conv);
        expect(
          (
            await suDb.conversation.findFirstOrThrow({
              where: { tenantId, chatwootConversationId: conv },
              select: { consoleWriteAtMessageId: true },
            })
          ).consoleWriteAtMessageId,
        ).toBe(newest);

        // The straggler: a read that came back naming an OLDER message.
        liveLatestMessageId.set(conv, newest - 5);
        await handBack(conv);
        expect(
          (
            await suDb.conversation.findFirstOrThrow({
              where: { tenantId, chatwootConversationId: conv },
              select: { consoleWriteAtMessageId: true },
            })
          ).consoleWriteAtMessageId,
        ).toBe(newest);
      } finally {
        unversionedReads.delete(conv);
      }
    });

    // THE READING IS TAKEN BEFORE THE ACTION. `mirrorConsoleWrite` runs after its caller's Chatwoot
    // calls, so a reading it took itself would include a colleague who replied during the round
    // trip, and the mark would cover that reply and have the takeover skip a real handover.
    //
    // Driven through the toggle's own in-flight window, which is the only place a test can stand:
    // the request is on the wire, Chatwoot has not committed it, and a message written there is
    // strictly after the click.
    test("a reply written during the click is not covered by the mark", async () => {
      const conv = 8605;
      unversionedReads.add(conv);
      try {
        await deliver(conv, composerReply("eu assumo"));
        const beforeClick = liveLatestMessageId.get(conv) ?? 0;
        // The colleague comes back while the hand-back's toggle is in flight.
        const during = beforeClick + 7;
        whileToggling = async () => {
          liveLatestMessageId.set(conv, during);
        };
        try {
          expect(await handBack(conv)).toBe("returned");
        } finally {
          whileToggling = null;
        }
        const marked = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: conv },
          select: { consoleWriteAtMessageId: true },
        });
        expect(marked.consoleWriteAtMessageId).toBe(beforeClick);

        // And the effect: that reply still takes the conversation over.
        messageSeq = during;
        await deliver(conv, composerReply("voltei, deixa comigo"));
        expect(liveStatus.get(conv)).toBe("open");
      } finally {
        unversionedReads.delete(conv);
      }
    });

    // A VERSIONED Chatwoot reconciles instead of falling back, and stamps the mark ANYWAY: the
    // takeover recovery carries no version, so without the mark it could undo a hand-back inside its
    // window (asserted in tests/modules/chatwoot-recover-takeover.test.ts; the stamp is asserted here).
    //
    // On the live path the mark matters in one shape: a payload whose version EQUALS the row's (a
    // console write that did not move `updated_at`). The version check is strict
    // (`decidedAtVersion < now.statusAt`), so a tie passes it, and the mark is what refuses the reply.
    test("a versioned delivery whose version ties is still ordered by the mark", async () => {
      const conv = 8614;
      await deliver(conv, composerReply("eu assumo"));
      messageSeq += 1;
      const frozenId = messageSeq;
      liveLatestMessageId.set(conv, frozenId);
      expect(await handBack(conv)).toBe("returned");
      const afterClick = await convRow(conv);
      expect(afterClick?.consoleWriteAtMessageId).toBe(frozenId);
      const tie = afterClick?.chatwootStatusAt;
      if (tie === null || tie === undefined) throw new Error("no version");

      // The frozen reply, carrying EXACTLY the version the row now holds.
      const build = () => {
        const n = normalizeChatwootEvent({
          event: "message_created",
          id: frozenId,
          private: false,
          ...composerReply("já respondi por aqui"),
          conversation: { ...conversation(conv), updated_at: tie },
        });
        if (!n) throw new Error("payload did not normalize");
        return n;
      };
      const send = async (n: ReturnType<typeof build>) => {
        deliverySeq += 1;
        const delivery = await suDb.chatwootWebhookDelivery.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            deliveryId: `hr-${process.pid}-${deliverySeq}`,
            event: "message_created",
            status: "PENDING",
          },
          select: { id: true },
        });
        await processChatwootDelivery({
          tenantId,
          instanceId,
          deliveryRowId: delivery.id,
          agentBotId: OUR_BOT,
          normalized: n,
          deps,
          base: appDb,
        });
      };

      await send(build());
      expect(liveStatus.get(conv)).toBe("pending");
      expect((await convRow(conv))?.status).toBe("pending");

      // The control that says it was the MARK and not the tie: clear the mark, send the same
      // payload, and the same delivery takes the conversation over.
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: conv },
        data: { consoleWriteAtMessageId: null },
      });
      await send(build());
      expect(liveStatus.get(conv)).toBe("open");
    });
  });
});
