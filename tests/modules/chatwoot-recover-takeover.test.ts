import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { createChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { recoverStrandedTakeover } from "@/modules/chatwoot/recover-takeover";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { POLL_DEADLINE_MS } from "@/tests/utils/poll";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// A PROCESS DEATH LOST THE TAKEOVER, and the recovery re-runs it (issue #439).
//
// The delivery that carries a colleague's reply is what steps the agent off the conversation (issue
// #430), and that work is detached: the 200 is already out when it runs. A deploy, an OOM or a
// restart in that window leaves a ledger row nothing finished, the conversation still `pending` and
// still the bot's, and — until this — a sweep that closed the row as carrying nothing at stake.
//
// What is asserted here is the effect the issue is about, not the call that produces it: after the
// recovery, the NEXT customer message does not drive a turn. The toggle alone would pass with the
// local half broken, and the local claim alone would pass with Chatwoot never told.
//
// The Chatwoot side is the same behaving stub the live takeover's test uses: it holds a status per
// conversation and the toggle moves it, so the second payload's status is read back rather than
// written by the fixture.

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

const INBOX_ID = 84;
const ZAPI_INBOX_ID = 85;
const OUR_BOT = 21;
// A second persona's bot, which a conversation can be assigned to while the inbox is bound to the
// first. Chatwoot fans the message to both routes and only this one's delivery passes the gate.
const OTHER_BOT = 22;
let tenantId = 0n;
let instanceId = 0n;
let agentDbId = 0n;
let deliverySeq = 0;
let messageSeq = 84_000;
let stamp = Math.floor(Date.now() / 1000);

const liveStatus = new Map<number, string>();
// Who holds each conversation in the stub's Chatwoot, when it is not the inbox persona's bot.
const liveHolder = new Map<number, number>();
// Conversations whose REST show fails outright, which is a slow or broken Chatwoot.
const failingReads = new Set<number>();
// Conversations whose REST show answers 200 with a body that does not parse as a conversation, which
// is what a proxy's error page or a truncated response looks like from here: not an exception, and
// not an answer either.
const unparseableReads = new Set<number>();
const failingToggles = new Set<number>();
const posted: { url: string; method: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;

const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  posted.push({ url, method, body });
  const toggle = url.match(/\/conversations\/(\d+)\/toggle_status/);
  if (toggle && body && typeof body === "object" && "status" in body) {
    if (failingToggles.has(Number(toggle[1])))
      return new Response("nope", { status: 502 });
    liveStatus.set(Number(toggle[1]), String(body.status));
  }
  const show = url.match(/\/conversations\/(\d+)(?:\?|$)/);
  if (show && method === "GET") {
    const id = Number(show[1]);
    if (failingReads.has(id)) return new Response("nope", { status: 502 });
    if (unparseableReads.has(id)) return Response.json({ nothing: true });
    stamp += 1;
    return Response.json({
      id,
      status: liveStatus.get(id) ?? "pending",
      meta: {
        assignee_type: "AgentBot",
        assignee: { id: liveHolder.get(id) ?? OUR_BOT, name: "Atendente" },
      },
      last_activity_at: stamp,
      updated_at: stamp + 0.5,
    });
  }
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const makeClient = async (config: Parameters<typeof createChatwootClient>[0]) =>
  createChatwootClient(config, {
    assertSafe: async (url: string) => new URL(url),
    fetchImpl: stubFetch,
  });

describe.skipIf(!dbUp)("recovering a takeover a process death lost", () => {
  beforeAll(async () => {
    globalThis.fetch = stubFetch as typeof globalThis.fetch;
    const t = await suDb.tenant.create({
      data: { name: "RT", slug: `rt-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 31,
      baseUrl: "https://chat.recover.example",
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
        webhookRouteTokenHash: `rt-route-${process.pid}`,
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
    // The same agent on a provider whose send path does NOT reserve its WhatsApp id, which is where
    // an outgoing message marked `external_sender_name` can be our own reply echoing back.
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

  // The conversation the mirror is seeded from, plus the version the stranded delivery's payload
  // carried. Both come from ONE clock: the ordering compares the payload's version against the row's
  // `chatwoot_status_at`, and two independent clocks would decide that comparison by accident.
  async function seedStranded(
    convId: number,
    over: {
      shape?: string | null;
      inboxId?: number;
      // How the mirror's status version relates to the version the delivery decided on. `behind` is
      // the ordinary case (nothing has happened since); `ahead` is a hand-back that landed while the
      // row sat stranded — which, since the mark advances on redeclaration, is also what the
      // customer's own next message leaves behind.
      mirrorVersion?: "behind" | "ahead";
      status?: string;
      // The bot route the delivery arrived on, as the ledger recorded it. Omitted = the inbox
      // persona; `null` = a row an older build wrote, which recorded none.
      routeAgentBotId?: number | null;
      // Who holds the conversation in the mirror, when it is not the inbox persona's bot.
      holder?: number;
      // A claim already held on the mirrored row, which is what an attempt whose toggle threw leaves
      // behind: `open` locally, still `pending` at Chatwoot.
      claimHeldMs?: number;
      // The message the ledger recorded this takeover as being about, and the mark an unversioned
      // console write left on the row (issue #469). Omitted = the ordinary pair, a delivery whose
      // message nothing has handed back over; `null` for the message id = a row an older build
      // wrote, which recorded none.
      humanReplyMessageId?: number | null;
      consoleWriteAtMessageId?: number;
    } = {},
  ) {
    stamp += 1;
    const mirrorAt = over.mirrorVersion === "ahead" ? stamp + 10 : stamp - 5;
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: {
        tenantId,
        chatwootInboxId: over.inboxId ?? INBOX_ID,
      },
      select: { id: true },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status:
          over.status ?? (over.claimHeldMs === undefined ? "pending" : "open"),
        ...(over.claimHeldMs === undefined
          ? {}
          : {
              statusClaimFrom: "pending",
              statusClaimUntil: new Date(Date.now() + over.claimHeldMs),
            }),
        assigneeType: "AgentBot",
        assigneeId: over.holder ?? OUR_BOT,
        chatwootStatusAt: mirrorAt,
        ...(over.consoleWriteAtMessageId === undefined
          ? {}
          : { consoleWriteAtMessageId: over.consoleWriteAtMessageId }),
        inboxId: inbox.id,
        threadId: `chatwoot:${tenantId}:${instanceId}:${convId}`,
        lastEventAt: new Date(),
        contactInboxId: 84_000 + convId,
      },
    });
    liveStatus.set(convId, over.status ?? "pending");
    if (over.holder !== undefined) liveHolder.set(convId, over.holder);
    deliverySeq += 1;
    const row = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `rt-${process.pid}-${deliverySeq}`,
        event: "message_created",
        // What a process death leaves: the sweep has already closed it, and the recovery reads the
        // row rather than reclaiming it.
        status: "PROCESSED",
        receivedAt: new Date(Date.now() - 40 * 60 * 1000),
        conversationId: convId,
        humanReplyShape: over.shape === undefined ? "composer" : over.shape,
        routeAgentBotId:
          over.routeAgentBotId === undefined ? OUR_BOT : over.routeAgentBotId,
        humanReplyMessageId:
          over.humanReplyMessageId === undefined
            ? 500
            : over.humanReplyMessageId,
      },
      select: { id: true },
    });
    return row.id;
  }

  async function convRow(convId: number) {
    return suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: {
        status: true,
        statusClaimUntil: true,
        statusClaimFrom: true,
        chatwootStatusAt: true,
      },
    });
  }

  function togglesFor(convId: number) {
    return posted.filter(
      (p) =>
        p.method === "POST" &&
        p.url.includes(`/conversations/${convId}/toggle_status`),
    );
  }

  const customerSays = (text: string) => ({
    content: text,
    message_type: "incoming",
    sender: { id: 77, name: "Cliente", type: null },
  });

  let turnsRan = 0;

  // The customer's NEXT message, through the real receiver. This is where the recovery is measured:
  // a takeover that only moved Chatwoot, or only moved the row, still lets this drive a turn.
  async function customerWrites(convId: number, inboxId = INBOX_ID) {
    deliverySeq += 1;
    messageSeq += 1;
    stamp += 1;
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageSeq,
      private: false,
      ...customerSays("e aí?"),
      conversation: {
        id: convId,
        inbox_id: inboxId,
        status: liveStatus.get(convId) ?? "pending",
        contact_inbox: { id: 84_000 + convId },
        meta: {
          assignee_type: "AgentBot",
          assignee: { id: OUR_BOT, name: "Atendente" },
          sender: { id: 77, name: "Cliente" },
        },
        channel: "Channel::Whatsapp",
        last_activity_at: stamp,
        updated_at: stamp + 0.5,
      },
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `rt-next-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: "PENDING",
      },
      select: { id: true },
    });
    const before = turnsRan;
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: OUR_BOT,
      normalized: n,
      deps: { makeClient },
      onDirectTurn: () => {
        turnsRan += 1;
      },
      base: appDb,
    });
    return turnsRan > before;
  }

  test("the composer reply's lost takeover is re-run, and the next customer message finds a person on it", async () => {
    const convId = 9101;
    const rowId = await seedStranded(convId);

    // The defect, before the recovery runs: the conversation is still the bot's, so the customer's
    // next message drives a full turn — the agent answering over the colleague, which is exactly
    // what issue #430 exists to prevent.
    expect(await customerWrites(convId)).toBe(true);

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("recovered");

    // Chatwoot was told, and the local row moved with a claim on it — the two halves the live path
    // writes, both required (issue #436: an unversioned `open` that claims nothing is walked back by
    // any payload still in flight).
    expect(togglesFor(convId)).toHaveLength(1);
    expect(togglesFor(convId)[0]?.body).toEqual({ status: "open" });
    const row = await convRow(convId);
    expect(row.status).toBe("open");
    expect(row.statusClaimFrom).toBe("pending");
    expect(row.statusClaimUntil).not.toBeNull();

    // And the effect the issue is about.
    expect(await customerWrites(convId)).toBe(false);
  });

  // THE HALF-HOUR THIS PATH WAITS IS THE WINDOW (issue #469). The live path races a hand-back by
  // milliseconds; the recovery is armed only after a row has sat non-terminal for thirty minutes, so
  // an operator clicking "Return to AI" in that stretch is not an edge case, it is the likely order
  // of events. What the recovery would otherwise do is take a conversation back for a reply the
  // operator had already seen and answered by handing it to the agent.
  //
  // The coordinate comes from the LEDGER, which is the only place it can: the payload is never
  // stored (issue #228), and `inboundMessageId` is null on a colleague's reply by construction.
  test("a hand-back made while the row sat stranded is not walked back", async () => {
    const convId = 9130;
    const rowId = await seedStranded(convId, {
      humanReplyMessageId: 700,
      consoleWriteAtMessageId: 700,
    });
    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("not-owed");
    expect(togglesFor(convId)).toHaveLength(0);
    expect((await convRow(convId)).status).toBe("pending");
  });

  test("a reply written AFTER that hand-back is still recovered", async () => {
    const convId = 9131;
    const rowId = await seedStranded(convId, {
      humanReplyMessageId: 701,
      consoleWriteAtMessageId: 700,
    });
    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("recovered");
    expect(togglesFor(convId)).toHaveLength(1);
  });

  // A row an older build wrote names no message, and neither does a conversation nobody has clicked
  // anything on. Each is a missing half, and each has to leave the fence with nothing to order —
  // read as "stale" instead, the recovery issue #439 built would refuse every row it exists for.
  test("a ledger row with no recorded message runs unfenced", async () => {
    const convId = 9132;
    const rowId = await seedStranded(convId, {
      humanReplyMessageId: null,
      consoleWriteAtMessageId: 700,
    });
    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("recovered");
    expect(togglesFor(convId)).toHaveLength(1);
  });

  test("a conversation with no console mark runs unfenced", async () => {
    const convId = 9133;
    const rowId = await seedStranded(convId, { humanReplyMessageId: 700 });
    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("recovered");
    expect(togglesFor(convId)).toHaveLength(1);
  });

  // AND THE ATTEMPT WHOSE TOGGLE NEVER LANDED IS COVERED BY THE SAME BRANCH, which is why the fence
  // sits after the finishing arm rather than before it. A hand-back writes `pending` on the ROW, so
  // it takes the conversation OUT of the `open`-under-a-pending-claim shape the finishing arm is
  // selected by — the claim's residue stays, and the recovery goes down the ordinary path where the
  // fence is asked. Putting the fence in the finishing arm too would instead refuse the case where
  // an operator OPENED the conversation themselves, a click that asks for exactly what finishing
  // does. Measured by writing that guard first and watching this shape prove it unreachable.
  test("a hand-back over a claim whose toggle never landed is still refused", async () => {
    const convId = 9134;
    const rowId = await seedStranded(convId, {
      status: "pending",
      claimHeldMs: -30 * 60 * 1000,
      humanReplyMessageId: 700,
      consoleWriteAtMessageId: 700,
    });
    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("not-owed");
    expect(togglesFor(convId)).toHaveLength(0);
    expect((await convRow(convId)).status).toBe("pending");
  });

  test("the device shape is refused on a provider that does not reserve its send ids", async () => {
    // The half the ledger could not answer. `external_sender_name` is written by every WhatsApp
    // session path in the fork, and on a provider with no id reservation an unmatched echo of OUR
    // OWN reply is stored wearing exactly that marker. Acting on it would have the agent step aside
    // for itself, permanently, on a conversation nobody took over.
    const convId = 9102;
    const rowId = await seedStranded(convId, {
      shape: "device",
      inboxId: ZAPI_INBOX_ID,
    });

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("not-owed");
    expect(togglesFor(convId)).toHaveLength(0);
    expect((await convRow(convId)).status).toBe("pending");
  });

  test("the same device shape IS a person on a provider that reserves them", async () => {
    // The control for the case above: identical row, identical shape, and the only difference is the
    // inbox's provider. Without it, "refused" could be the recovery ignoring `device` altogether.
    const convId = 9103;
    const rowId = await seedStranded(convId, { shape: "device" });

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("recovered");
    expect(togglesFor(convId)).toHaveLength(1);
    expect((await convRow(convId)).status).toBe("open");
  });

  test("the customer writing in the window does NOT refuse the recovery", async () => {
    // THE MEASUREMENT THAT DECIDED THE DESIGN, kept as a test because it is the one thing a reader
    // will want to re-derive. The live takeover refuses a payload whose version is behind the row's
    // status mark, which is how a hand-back outranks a reply that was already sent. Carried into the
    // recovery, that check refuses here: `chatwootStatusAt` advances on every payload that DECLARES
    // a status, so the customer's own next message moves it — and a conversation the customer wrote
    // on is precisely the conversation where the agent has been answering over a person.
    //
    // So the recovery carries no version, and this fixes that: a mirror whose status mark is well
    // ahead of the stranded delivery still gets its takeover.
    const convId = 9104;
    const rowId = await seedStranded(convId, { mirrorVersion: "ahead" });

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("recovered");
    expect(togglesFor(convId)).toHaveLength(1);
    expect((await convRow(convId)).status).toBe("open");
  });

  test("a conversation somebody already moved on is left alone", async () => {
    const convId = 9105;
    const rowId = await seedStranded(convId, { status: "open" });

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("not-owed");
    // Not one HTTP call: the mirror answers this before anything reaches the network.
    expect(togglesFor(convId)).toHaveLength(0);
    expect(
      posted.filter((p) => p.url.includes(`/conversations/${convId}`)),
    ).toHaveLength(0);
  });

  test("a test-mode agent is not taken over", async () => {
    // The same exclusion the live path makes: a test conversation is one an operator activated with
    // /teste, and an operator answering from the composer mid-test would silence the very agent they
    // are testing, with the way back a command they now have to know about.
    //
    // The MODE is what moves, on the agent everything else in this file uses. Pointing the inbox at
    // a second, test-mode agent passes too — and for the wrong reason: that agent has no bot row on
    // this instance, so the ownership question answers "there is no we" long before the mode is
    // read, and the assertion holds with the mode check deleted.
    const convId = 9106;
    const rowId = await seedStranded(convId);
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { mode: "test" },
    });
    try {
      expect(
        await recoverStrandedTakeover({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(togglesFor(convId)).toHaveLength(0);
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "production" },
      });
    }
  });

  test("the agent's takeover switch, read as it stands now", async () => {
    const convId = 9107;
    const rowId = await seedStranded(convId);
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { settings: { takeover: { onHumanReply: false } } },
    });
    try {
      expect(
        await recoverStrandedTakeover({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(togglesFor(convId)).toHaveLength(0);
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { settings: { debounce: { enabled: false } } },
      });
    }
  });

  test("a row that owed nothing is not a takeover to run", async () => {
    // Our own reply coming back around, and every row a build without the column wrote. The job is
    // armed from the row, so the row is what has to refuse.
    const convId = 9108;
    const rowId = await seedStranded(convId, { shape: null });

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("not-owed");
    expect(togglesFor(convId)).toHaveLength(0);
  });

  test("the ROUTE's bot is what the recovery asks ownership about", async () => {
    // ROUND 1, P1. Chatwoot fans one message to up to two bot routes — the conversation's assignee
    // bot AND the inbox's — and only the route holding the conversation passes the gate. The
    // stranded delivery here arrived on the assignee bot's route (OTHER_BOT holds the conversation),
    // and deriving the identity from the inbox persona would ask a stricter question than the
    // delivery did: refused, with the bot that DOES hold it free to answer over the person.
    const convId = 9111;
    const rowId = await seedStranded(convId, {
      holder: OTHER_BOT,
      routeAgentBotId: OTHER_BOT,
    });

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("recovered");
    expect(togglesFor(convId)).toHaveLength(1);
    expect((await convRow(convId)).status).toBe("open");
  });

  test("a row with no recorded route falls back to the inbox persona", async () => {
    // The rows an older build wrote. The fallback can only ever refuse — a wrong identity makes the
    // fence answer "this is not ours" — so it is safe, and on every conversation the inbox's own bot
    // holds it is the same answer the route would have given.
    const convId = 9112;
    const rowId = await seedStranded(convId, { routeAgentBotId: null });

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("recovered");
    expect(togglesFor(convId)).toHaveLength(1);
  });

  test("an attempt whose toggle threw is finished, not refused", async () => {
    // ROUND 1, P1. The claim is written BEFORE the toggle (#430), so a toggle that throws leaves the
    // row `open` under a live claim while Chatwoot still says `pending`. Asked again, the ownership
    // fence reads our own write as somebody else having moved the conversation on and stands down —
    // which spends the scheduler's retry on a verdict that can never change, deletes the job, and
    // leaves Chatwoot `pending` with the bot able to answer.
    const convId = 9113;
    const rowId = await seedStranded(convId, { claimHeldMs: 30_000 });
    // Chatwoot's side of that state: the transition never landed.
    liveStatus.set(convId, "pending");

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("recovered");
    // The remote half, which is the whole point: the row already said `open`.
    expect(togglesFor(convId)).toHaveLength(1);
    expect(liveStatus.get(convId)).toBe("open");
    // And the version the first attempt never earned, written through the claim it still holds.
    expect((await convRow(convId)).chatwootStatusAt).not.toBeNull();
  });

  test("a live claim that replaced some OTHER status is not this takeover's", async () => {
    // The three columns are the signature and none is enough alone. `open` is any human queue and
    // the deadline says only that some claim is live; what says the write was THIS takeover is the
    // status it replaced, which `claimOpenForHumanQueue` pins to `pending`.
    //
    // Unreachable today — that call is the only writer of `status_claim_from` in the tree — and
    // asserted because the verdict must not depend on that staying true: a second claim, taken over
    // a different transition, would otherwise be finished here with a `toggle_status: open` nobody
    // decided.
    const convId = 9115;
    const rowId = await seedStranded(convId, { claimHeldMs: -30 * 60 * 1000 });
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: convId },
      data: { statusClaimFrom: "resolved" },
    });

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("not-owed");
    expect(togglesFor(convId)).toHaveLength(0);
  });

  test("a finished takeover leaves the operator the same trail a live one does", async () => {
    // ROUND 4, P2. The sweep deliberately writes no line for an owed takeover — nothing was lost, so
    // nothing may page anybody — which means the ONLY durable record that a person took this
    // conversation is the `handoff` line the takeover itself writes. Finished through a second
    // implementation it was not written at all, and the operator was left with an agent that stopped
    // answering and nothing anywhere saying why. Running the same unit is what fixes it.
    const convId = 9123;
    const rowId = await seedStranded(convId, { claimHeldMs: -30 * 60 * 1000 });
    liveStatus.set(convId, "pending");

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("recovered");

    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    const deadline = Date.now() + POLL_DEADLINE_MS;
    let rows: Array<{ detail: unknown }> = [];
    while (Date.now() < deadline) {
      rows = await flowLogRows(suDb, {
        where: { tenantId, conversationId: conv.id, stage: "handoff" },
        select: { detail: true },
      });
      if (rows.length > 0) break;
      await Bun.sleep(25);
    }
    expect(rows).toHaveLength(1);
    const line = rows[0];
    if (line === undefined) throw new Error("no handoff line was written");
    // `via` names the route, which is what an operator reads to know where to look — the CRM or
    // somebody's phone.
    expect((line.detail as Record<string, unknown>).via).toBe("composer");
  });

  test("a claim long past its deadline is still the write this recovery finishes", async () => {
    // ROUND 3, P1, and it is arithmetic rather than judgement. Round 1 gated the retry on a LIVE
    // claim; the claim stands for 45 seconds (STATUS_CLAIM_TTL_MS) and the sweep does not call a
    // delivery stranded for 30 minutes (STALE_AFTER_MS), so that branch could never run on a real
    // strand — the deadline is gone before anything reaches it. This is the shape a real one has:
    // `open` on the row, the claim expired long ago, and Chatwoot never told.
    //
    // The authority is the live read inside the retry, not the deadline. What the deadline is still
    // for is the reconcile's ownership comparison, which is by equality and does not care that the
    // instant has passed.
    const convId = 9114;
    const rowId = await seedStranded(convId, { claimHeldMs: -30 * 60 * 1000 });
    liveStatus.set(convId, "pending");

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("recovered");
    expect(togglesFor(convId)).toHaveLength(1);
    expect(liveStatus.get(convId)).toBe("open");
    // And the version the first attempt never earned, written through the claim it still names.
    expect((await convRow(convId)).chatwootStatusAt).not.toBeNull();
  });

  test("a conversation the mirror has never seen is retried, not answered", async () => {
    // ROUND 2, P1. A delivery that died before the mirror write leaves no local row, and everything
    // this path needs hangs off it — the inbox, the agent, and the row the claim is a CAS on. Read
    // as `not-owed` the job completes, the delete-on-done row is gone, and the only recovery the
    // conversation had disappears with it. It is not an answer: the next event on that conversation
    // creates the row.
    const convId = 9116;
    const rowId = await seedStranded(convId);
    await suDb.conversation.deleteMany({
      where: { tenantId, chatwootConversationId: convId },
    });

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("unresolved");
    expect(togglesFor(convId)).toHaveLength(0);
  });

  test("an inbox bound to no agent owes nothing, and that IS an answer", async () => {
    // The other cause of the same null, and the reason the two are told apart: this one never
    // changes, so retrying it would spend a ladder on a question whose answer is fixed.
    const convId = 9117;
    const rowId = await seedStranded(convId);
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: INBOX_ID },
      select: { id: true },
    });
    await suDb.inbox.update({
      where: { id: inbox.id },
      data: { agentId: null },
    });
    try {
      expect(
        await recoverStrandedTakeover({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
    } finally {
      await suDb.inbox.update({
        where: { id: inbox.id },
        data: { agentId: agentDbId },
      });
    }
  });

  test("the retry reads Chatwoot before it writes, and stands down on a resolve", async () => {
    // ROUND 2, P1. Between the failed attempt and this retry an operator can resolve or snooze the
    // conversation, and their webhook is still in flight — the row still says `open` under our claim
    // while Chatwoot has moved on. An unconditional toggle reopens what they just closed, which is
    // the attribution invariant this module is built on.
    const convId = 9118;
    const rowId = await seedStranded(convId, { claimHeldMs: 30_000 });
    liveStatus.set(convId, "resolved");

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("not-owed");
    expect(togglesFor(convId)).toHaveLength(0);
    expect(liveStatus.get(convId)).toBe("resolved");
  });

  test("a first attempt whose RESPONSE was lost is finished, not refused", async () => {
    // The other thing the live read tells apart: Chatwoot committed the transition and only the
    // answer was lost, so the conversation is already `open` there. That is the one status a
    // takeover being DECIDED would refuse and one being FINISHED must accept — it is our own write
    // coming back. What the first attempt still owes is the version, which the reconcile writes
    // through the claim it named.
    //
    // The toggle runs anyway and is deliberately not asserted away: `toggle_status: open` on an
    // already-open conversation is a no-op at Chatwoot, and a branch to skip it would be a second
    // reading of a state the fence above has already decided.
    const convId = 9119;
    const rowId = await seedStranded(convId, { claimHeldMs: -30 * 60 * 1000 });
    liveStatus.set(convId, "open");

    expect(
      await recoverStrandedTakeover({
        tenantId,
        deliveryRowId: rowId,
        base: appDb,
        makeClient,
      }),
    ).toBe("recovered");
    expect(liveStatus.get(convId)).toBe("open");
    expect((await convRow(convId)).chatwootStatusAt).not.toBeNull();
  });

  test("a conversation Chatwoot reassigned is not toggled out of somebody else's queue", async () => {
    // ROUND 4, P1. The row says `open` under our claim and Chatwoot still says `pending`, which is
    // the signature of the write that was lost — but `pending` at Chatwoot is also where a
    // conversation sits after being handed to ANOTHER bot or person. A check that read only the
    // status would toggle it into the open queue on their behalf.
    //
    // The possession half of the fence is the same predicate in both modes; only the STATUS domain
    // differs, and that is what this pins.
    const convId = 9122;
    const rowId = await seedStranded(convId, { claimHeldMs: -30 * 60 * 1000 });
    liveStatus.set(convId, "pending");
    liveHolder.set(convId, OTHER_BOT);
    try {
      expect(
        await recoverStrandedTakeover({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(togglesFor(convId)).toHaveLength(0);
      expect(liveStatus.get(convId)).toBe("pending");
    } finally {
      liveHolder.delete(convId);
    }
  });

  test("a finishing read that came back unreadable writes nothing", async () => {
    // The other shape of "no answer", and the one the exception does not cover: Chatwoot returns 200
    // with a body that is not a conversation. When a takeover is being DECIDED that does not block —
    // silence is not evidence somebody took it, and the mirror fence is the reading behind it — but
    // when one is being FINISHED there is no mirror fence left, because our own `open` is what it
    // would read. Writing blind is the one thing left to prevent.
    const convId = 9124;
    const rowId = await seedStranded(convId, { claimHeldMs: -30 * 60 * 1000 });
    unparseableReads.add(convId);
    try {
      expect(
        await recoverStrandedTakeover({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("failed");
      expect(togglesFor(convId)).toHaveLength(0);
    } finally {
      unparseableReads.delete(convId);
    }
  });

  test("a retry that cannot read Chatwoot writes nothing", async () => {
    // The fence lets an unreadable answer through — silence is not evidence that somebody took the
    // conversation, and it still has a mirror CAS behind it. Here there is no second gate, so a read
    // that fails is the one thing that must not become a blind write.
    const convId = 9120;
    const rowId = await seedStranded(convId, { claimHeldMs: 30_000 });
    failingReads.add(convId);
    try {
      expect(
        await recoverStrandedTakeover({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("failed");
      expect(togglesFor(convId)).toHaveLength(0);
    } finally {
      failingReads.delete(convId);
    }
  });

  test("a fence that stood down is an answer, not a failure", async () => {
    // ROUND 2, P2. The preliminary ownership read is not a lock: Chatwoot can move the conversation
    // between it and the fence's own read, and the fence correctly refuses then. Mapped to `failed`
    // that spends the scheduler's backoff ladder and eventually dead-letters a job about a
    // conversation that owes nothing.
    //
    // Driven through the ONE reading the preliminary check cannot make: the fence asks Chatwoot
    // first, so a conversation the mirror still calls the bot's while Chatwoot has handed it to a
    // person reaches the fence and is refused there.
    const convId = 9121;
    const rowId = await seedStranded(convId);
    liveStatus.set(convId, "open");
    liveHolder.set(convId, OTHER_BOT);
    try {
      expect(
        await recoverStrandedTakeover({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(togglesFor(convId)).toHaveLength(0);
    } finally {
      liveHolder.delete(convId);
    }
  });

  test("a persona that cannot be loaded is a failure, not a silent success", async () => {
    // The one road into the unit's outer catch: `loadAgentBot` decrypts the stored token and throws
    // rather than falling back. Nothing was written, nothing was told to Chatwoot, and the outcome
    // has to say so — reported as recovered, the job completes and the conversation stays with the
    // bot with nothing left to notice it.
    const convId = 9110;
    const rowId = await seedStranded(convId);
    const bot = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { tenantId, chatwootAgentBotId: OUR_BOT },
      select: { id: true, accessToken: true },
    });
    await suDb.chatwootAgentBot.update({
      where: { id: bot.id },
      data: { accessToken: "not-a-blob" },
    });
    try {
      expect(
        await recoverStrandedTakeover({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("failed");
      expect(togglesFor(convId)).toHaveLength(0);
      expect((await convRow(convId)).status).toBe("pending");
    } finally {
      await suDb.chatwootAgentBot.update({
        where: { id: bot.id },
        data: { accessToken: bot.accessToken },
      });
    }
  });

  test("a toggle that fails keeps the claim and reports the failure", async () => {
    // The same answer #430 gives on the live path: a failed call is an UNKNOWN outcome, not a
    // refusal — Chatwoot commits the transition and the response is lost — so releasing the claim
    // would put the agent straight back into a conversation the platform HAS handed over.
    const convId = 9109;
    const rowId = await seedStranded(convId);
    failingToggles.add(convId);
    try {
      expect(
        await recoverStrandedTakeover({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("failed");
      const row = await convRow(convId);
      expect(row.status).toBe("open");
      expect(row.statusClaimUntil).not.toBeNull();
    } finally {
      failingToggles.delete(convId);
    }
  });
});
