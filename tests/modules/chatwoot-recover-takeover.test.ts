import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { createChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { recoverStrandedTakeover } from "@/modules/chatwoot/recover-takeover";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

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
let tenantId = 0n;
let instanceId = 0n;
let agentDbId = 0n;
let deliverySeq = 0;
let messageSeq = 84_000;
let stamp = Math.floor(Date.now() / 1000);

const liveStatus = new Map<number, string>();
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
    stamp += 1;
    return Response.json({
      id,
      status: liveStatus.get(id) ?? "pending",
      meta: {
        assignee_type: "AgentBot",
        assignee: { id: OUR_BOT, name: "Atendente" },
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
        status: over.status ?? "pending",
        assigneeType: "AgentBot",
        assigneeId: OUR_BOT,
        chatwootStatusAt: mirrorAt,
        inboxId: inbox.id,
        threadId: `chatwoot:${tenantId}:${instanceId}:${convId}`,
        lastEventAt: new Date(),
        contactInboxId: 84_000 + convId,
      },
    });
    liveStatus.set(convId, over.status ?? "pending");
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
