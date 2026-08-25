// A CONTROL COMMAND THAT DID NOT RUN, AND THE LINE THAT SAYS SO.
//
// `/teste` and `/reset` are the operator driving the tooling from inside the conversation, and a
// delivery drops one in three measured ways: the agent it resolved is not in `test` mode (issue
// #270's dead end, and the ordinary case of an operator typing `/teste` at a production agent), the
// delivery arrived on another persona's route and leaves the command to the inbox's own persona
// (correct behaviour), or the inbox's agent has no Chatwoot bot identity at all, in which case EVERY
// route fails closed and the command runs nowhere.
//
// All three end the same way from the outside: the operator types the command and nothing happens.
// #311 gave the first one a process log line, which is not what an operator reads; #274 settled that
// the operator-facing signal for a silence is the `ExecutionLog` row, because that is what the Logs
// page shows. This file asserts that row (issue #317).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

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

// Never seeded: the mirror creates it, which is what makes an unbound inbox a real row.
const UNBOUND_INBOX = 93;
const PROD_INBOX = 92;
const TEST_INBOX = 91;
const NO_PERSONA_INBOX = 94;
// An inbox whose persona row exists but whose stored token cannot be decrypted (a rotated key, a
// corrupt blob). The line about the dropped command must not read it, and must not die trying.
const BAD_TOKEN_INBOX = 95;
// The bot whose webhook route the delivery arrived on, and one that belongs to nobody here.
const OUR_BOT = 9;
const OTHER_BOT = 8;

let tenantId = 0n;
let instanceId = 0n;
let testAgentId = 0n;
let prodAgentId = 0n;
let deliverySeq = 0;
let messageSeq = 9000;
let stamp = Math.floor(Date.now() / 1000);
const realFetch = globalThis.fetch;

describe.skipIf(!dbUp)("a control command that did not run says so", () => {
  beforeAll(async () => {
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;

    const t = await suDb.tenant.create({
      data: { name: "CD", slug: `cd-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 33,
      baseUrl: "https://chat.dropped.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;

    const mkAgent = async (name: string, mode: string) =>
      (
        await suDb.agent.create({
          data: {
            tenantId,
            name,
            mode,
            systemPrompt: "Você é prestativa.",
            modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
            settings: { debounce: { enabled: false } },
          },
          select: { id: true },
        })
      ).id;
    const bind = async (
      agentId: bigint,
      chatwootInboxId: number,
      name: string,
    ) =>
      suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId,
          name,
          agentId,
        },
      });

    testAgentId = await mkAgent("Teste", "test");
    prodAgentId = await mkAgent("Producao", "production");
    // The agent with no Chatwoot identity: bound to an inbox, in test mode, and unable to speak
    // anywhere — every bot-token call it makes goes out with an empty token (issue #79).
    const orphanAgentId = await mkAgent("SemPersona", "test");
    for (const agentId of [testAgentId, prodAgentId]) {
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId,
          chatwootAgentBotId: OUR_BOT,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `cd-${agentId}-${process.pid}`,
          name: "bot",
        },
      });
    }
    await bind(testAgentId, TEST_INBOX, "Teste");
    await bind(prodAgentId, PROD_INBOX, "Producao");
    await bind(orphanAgentId, NO_PERSONA_INBOX, "SemPersona");

    const badTokenAgentId = await mkAgent("TokenPodre", "production");
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: badTokenAgentId,
        chatwootAgentBotId: OUR_BOT,
        // NOT an encryptJson blob: decrypting this throws.
        accessToken: "nao-e-um-blob-cifrado",
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `cd-bad-${process.pid}`,
        name: "bot",
      },
    });
    await bind(badTokenAgentId, BAD_TOKEN_INBOX, "TokenPodre");
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

  // Open gate throughout: `pending` with nobody assigned is the state a command arrives in.
  async function deliver(
    convId: number,
    inboxId: number,
    content: string,
    agentBotId: number | null,
    over: {
      // The SAME Chatwoot message, redelivered on another bot's route: that is the fan-out, not a
      // second command (`agent_bots_for` sends one message to the conversation's assigned bot and
      // to the inbox's).
      sameMessage?: boolean;
      // A payload that names no inbox ANYWHERE, which is the shape issue #270's fallback exists
      // for: the agent is resolved from the conversation the mirror already stored.
      sparse?: boolean;
    } = {},
  ): Promise<void> {
    const { sameMessage = false, sparse = false } = over;
    deliverySeq += 1;
    if (!sameMessage) messageSeq += 1;
    stamp += 1;
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageSeq,
      private: false,
      content,
      message_type: "incoming",
      sender: { id: 77, name: "Operadora", type: null },
      conversation: {
        id: convId,
        ...(sparse ? {} : { inbox_id: inboxId }),
        status: "pending",
        contact_inbox: { id: 91_000 + convId },
        meta: { assignee: null, sender: { id: 77, name: "Operadora" } },
        channel: "Channel::Api",
        last_activity_at: Math.floor(Date.now() / 1000),
        updated_at: stamp,
      },
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `cd-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: "PENDING",
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId,
      normalized: n,
      base: appDb,
    });
  }

  // Scoped to the conversation by its INTERNAL id, and polled for the count the test EXPECTS: the
  // emit is fire-and-forget, so an unscoped read answers with a neighbour's row and one that stops
  // at the first row reads the fan-out's first delivery while the second is still in flight, then
  // calls that the answer. Zero is the same rule from the other side: nothing to wait for, so the
  // window is spent before reading rather than short-circuited.
  async function commandRows(convId: number, expected: number, waitMs = 2000) {
    const conv = await suDb.conversation.findFirst({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true },
    });
    if (!conv) return [];
    const deadline = Date.now() + waitMs;
    for (;;) {
      const rows = await suDb.executionLog.findMany({
        where: { tenantId, stage: "command", conversationId: conv.id },
        orderBy: { id: "asc" },
      });
      if (expected > 0 && rows.length >= expected) return rows;
      if (Date.now() > deadline) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  test("a command at a production agent is ordinary text, and the line says which mode dropped it", async () => {
    await deliver(9201, PROD_INBOX, "/teste", OUR_BOT);
    const rows = await commandRows(9201, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe("info");
    expect(rows[0]?.status).toBe("skipped");
    expect(rows[0]?.agentId).toBe(prodAgentId);
    expect(rows[0]?.detail).toMatchObject({
      command: "teste",
      reason: "inactive",
      mode: "production",
      routeBot: OUR_BOT,
    });
  });

  test("a command at an inbox nobody bound names the mode as unresolved", async () => {
    await deliver(9301, UNBOUND_INBOX, "/reset", OUR_BOT);
    const rows = await commandRows(9301, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({
      command: "reset",
      reason: "inactive",
      mode: "unresolved",
    });
    // The two lines answer different questions and both belong: `route` says nothing will ever
    // answer this inbox, `command` says the command the operator typed is gone.
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 9301 },
      select: { id: true },
    });
    const route = await suDb.executionLog.findMany({
      where: { tenantId, stage: "route", conversationId: conv.id },
    });
    expect(route).toHaveLength(1);
  });

  test("a delivery on another persona's route says it left the command to the inbox's", async () => {
    await deliver(9101, TEST_INBOX, "/teste", OTHER_BOT);
    const rows = await commandRows(9101, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe("info");
    expect(rows[0]?.detail).toMatchObject({
      command: "teste",
      reason: "other_route",
      routeBot: OTHER_BOT,
      personaBot: OUR_BOT,
    });
  });

  // The one state nobody recovers from by waiting: with no identity on the inbox's agent, the fence
  // fails closed on EVERY route, so no delivery runs the command. `warn`, because it is a
  // misconfiguration to repair rather than a route deferring to its sibling.
  test("an inbox whose agent has no bot identity drops the command on every route, at warn", async () => {
    await deliver(9401, NO_PERSONA_INBOX, "/teste", OUR_BOT);
    const rows = await commandRows(9401, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe("warn");
    expect(rows[0]?.status).toBe("skipped");
    expect(rows[0]?.detail).toMatchObject({
      command: "teste",
      reason: "no_persona",
      routeBot: OUR_BOT,
    });
  });

  // Measured live before this was written: one `/teste` on a production agent whose conversation is
  // assigned to another persona's bot produced TWO identical `inactive` rows, one per route. They
  // are not the same fact, and the pair now reads as one command: the inbox's persona reports what
  // stopped it, the other route reports that it deferred.
  test("the fan-out reports one command, not the same drop twice", async () => {
    await deliver(9202, PROD_INBOX, "/teste", OUR_BOT);
    await deliver(9202, PROD_INBOX, "/teste", OTHER_BOT, { sameMessage: true });
    const rows = await commandRows(9202, 2);
    expect(rows).toHaveLength(2);
    expect(
      rows.map((r) => (r.detail as { reason: string }).reason).sort(),
    ).toEqual(["inactive", "other_route"]);
    const deferred = rows.find(
      (r) => (r.detail as { reason: string }).reason === "other_route",
    );
    expect(deferred?.detail).toMatchObject({
      command: "teste",
      routeBot: OTHER_BOT,
      personaBot: OUR_BOT,
    });
  });

  // The sparse-payload path (#270): no inbox anywhere on the event, so `inboxAgentRuntime` answers
  // nothing and the agent comes from the conversation the mirror already stored. The row has to name
  // that agent, and the route question has to be asked against ITS persona — reading only the
  // payload's runtime writes a row attributed to nobody, and calls both fan-out deliveries the same
  // drop, on the one path where the ids cost nothing to keep.
  test("a sparse payload names the agent the conversation stored", async () => {
    await deliver(9203, PROD_INBOX, "bom dia", OUR_BOT);
    await deliver(9203, PROD_INBOX, "/teste", OUR_BOT, { sparse: true });
    await deliver(9203, PROD_INBOX, "/teste", OTHER_BOT, {
      sparse: true,
      sameMessage: true,
    });
    const rows = await commandRows(9203, 2);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.agentId).toBe(prodAgentId);
    expect(
      rows.map((r) => (r.detail as { reason: string }).reason).sort(),
    ).toEqual(["inactive", "other_route"]);
    const inactive = rows.find(
      (r) => (r.detail as { reason: string }).reason === "inactive",
    );
    expect(inactive?.detail).toMatchObject({
      mode: "production",
      routeBot: OUR_BOT,
    });
  });

  // The line reports the delivery; it must not be able to drop it. The persona's token is
  // undecryptable here, which is what `loadAgentBot` would have thrown on — after the mirror
  // committed, leaving the ledger row on PROCESSING with nothing running and no upstream retry.
  test("an unreadable persona still writes the line, and the delivery finishes", async () => {
    await deliver(9501, BAD_TOKEN_INBOX, "/teste", OUR_BOT);
    const rows = await commandRows(9501, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({
      command: "teste",
      reason: "inactive",
      mode: "production",
    });
    const delivery = await suDb.chatwootWebhookDelivery.findFirstOrThrow({
      where: { tenantId, deliveryId: `cd-${process.pid}-${deliverySeq}` },
      select: { status: true },
    });
    expect(delivery.status).toBe("PROCESSED");
  });

  test("a command that RUNS writes no dropped line", async () => {
    await deliver(9102, TEST_INBOX, "/teste", OUR_BOT);
    const rows = await commandRows(9102, 0, 400);
    expect(rows).toHaveLength(0);
  });

  test("an ordinary message writes no dropped line", async () => {
    await deliver(9103, PROD_INBOX, "bom dia", OUR_BOT);
    const rows = await commandRows(9103, 0, 400);
    expect(rows).toHaveLength(0);
  });
});
