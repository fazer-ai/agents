import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import {
  processChatwootDelivery,
  runEagerMedia,
} from "@/modules/chatwoot/webhook";
import {
  observerArmPermit,
  observerRuleVerdict,
} from "@/modules/contact-auth/observer";
import { clearContactAuthState } from "@/modules/contact-auth/state";
import {
  armObserve,
  retireRefusedObserve,
  runObserve,
} from "@/modules/observe/job";
import { readMonitoringConfig } from "@/modules/observe/settings";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// THE CONTACT GATE ON THE OBSERVER PATH. A monitoring agent watching an inbox asks the gate before
// it arms an observation: the conditions, and the endpoint under the same rules as a responder (after
// the conditions when asked, alone when there are none). A conversation the gate refuses costs no
// OBSERVE job, no transcription and no model call; the refusal speaks to nobody (nothing sent, opened
// or noted) and leaves one `contact_auth` line. The tick re-checks the conditions only.

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

const OBSERVED_INBOX = 1088;
// An inbox whose RESPONDER binding is the monitoring agent itself (no observer row).
const BOUND_INBOX = 1089;
const OBSERVER_BOT = 88;
const AUTH_URL = "https://203.0.113.88:9443/check";
const CW_BASE = "https://203.0.113.89:9";
const GROUP_ONLY = { kind: "conversation_type", type: "group" };

let tenantId = 0n;
let instanceId = 0n;
let observerId = 0n;
let sttKeyRef = "";
let seq = 0;
let stamp = Math.floor(Date.now() / 1000);

const providers = { stt: 0, auth: 0 };
// What the authorization endpoint answers.
let authAnswer: "allow" | "deny" | "error" = "allow";
// The bodies the endpoint received, parsed.
const authBodies: Record<string, unknown>[] = [];
const customerFacing: string[] = [];

const sttFetch = (async () => {
  providers.stt += 1;
  return new Response(JSON.stringify({ text: "transcrito" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;
const authFetch = (async (_url: unknown, init?: { body?: unknown }) => {
  providers.auth += 1;
  if (typeof init?.body === "string") authBodies.push(JSON.parse(init.body));
  if (authAnswer === "error") return new Response("boom", { status: 500 });
  return new Response(JSON.stringify({ authorized: authAnswer === "allow" }), {
    status: 200,
  });
}) as unknown as typeof fetch;

function stubClient() {
  const record = (what: string) => async () => {
    customerFacing.push(what);
    return {};
  };
  const client = {
    downloadAttachment: async () => ({
      bytes: new ArrayBuffer(64),
      contentType: "audio/ogg",
    }),
    updateAttachmentMeta: async () => ({}),
    sendMessage: record("sendMessage"),
    sendPrivateNote: record("sendPrivateNote"),
    toggleStatus: record("toggleStatus"),
    assignTeam: record("assignTeam"),
    toggleTyping: async () => ({}),
    getMessages: async () => ({ payload: [] }),
  } as unknown as ChatwootClient;
  return async () => client;
}

function deps() {
  return {
    makeClient: stubClient() as never,
    makeModel: () => {
      throw new Error("an observer's delivery must not reach the model");
    },
    persistUsage: async () => {},
    contactAuthFetch: authFetch,
    sttFetch,
  };
}

async function setGate(contactAuth: Prisma.InputJsonObject | null) {
  await suDb.agent.update({
    where: { id: observerId },
    data: {
      settings: {
        stt: { enabled: true, provider: "openai", credentialRef: sttKeyRef },
        ...(contactAuth ? { contactAuth } : {}),
      },
    },
  });
}

function conversation(
  convId: number,
  groupType: "group" | "individual",
  status = "pending",
  anonymous = false,
  inboxId = OBSERVED_INBOX,
) {
  stamp += 1;
  return {
    id: convId,
    inbox_id: inboxId,
    status,
    group_type: groupType,
    labels: [],
    contact_inbox: { id: 108_800 + convId },
    meta: {
      assignee: null,
      sender: {
        id: 8800 + convId,
        name: groupType === "group" ? "Grupo" : "Cliente",
        ...(anonymous
          ? {}
          : {
              identifier:
                groupType === "group"
                  ? `1203630${convId}@g.us`
                  : `cli-${convId}`,
            }),
      },
    },
    channel: "Channel::Api",
    last_activity_at: stamp,
    updated_at: stamp,
  };
}

function audioEvent(
  convId: number,
  groupType: "group" | "individual",
  anonymous: boolean,
  inboxId: number,
  update?: { messageId?: number; text?: string },
) {
  seq += 1;
  const messageId = update?.messageId ?? 108_000 + seq;
  const n = normalizeChatwootEvent({
    event: update?.messageId != null ? "message_updated" : "message_created",
    id: messageId,
    content: update?.text ?? "",
    message_type: "incoming",
    private: false,
    sender: { id: 8800 + convId, name: "Cliente", type: null },
    attachments: [
      {
        id: messageId * 10 + 1,
        file_type: "audio",
        data_url: `${CW_BASE}/rails/active_storage/blobs/a${messageId}.ogg`,
      },
    ],
    conversation: conversation(
      convId,
      groupType,
      "pending",
      anonymous,
      inboxId,
    ),
  });
  if (!n) throw new Error("the fixture did not normalize");
  return n;
}

async function deliverMessage(
  convId: number,
  groupType: "group" | "individual",
  anonymous = false,
  inboxId = OBSERVED_INBOX,
  update?: { messageId?: number; text?: string },
) {
  const n = audioEvent(convId, groupType, anonymous, inboxId, update);
  const delivery = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `cao-${process.pid}-${seq}`,
      event: n.event,
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: delivery.id,
    agentBotId: OBSERVER_BOT,
    normalized: n,
    base: appDb,
    deps: deps() as never,
  });
  return n.message?.id as number;
}

async function deliverResolve(
  convId: number,
  groupType: "group" | "individual",
  // Pins the conversation's version, for several deliveries of ONE resolution.
  version?: number,
) {
  seq += 1;
  const n = normalizeChatwootEvent({
    event: "conversation_status_changed",
    ...conversation(convId, groupType, "resolved"),
    ...(version != null ? { updated_at: version } : {}),
  });
  if (!n) throw new Error("the fixture did not normalize");
  const delivery = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `cao-${process.pid}-${seq}`,
      event: "conversation_status_changed",
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: delivery.id,
    agentBotId: OBSERVER_BOT,
    normalized: n,
    base: appDb,
    deps: deps() as never,
  });
}

function runnableObserveRows(convId: number) {
  return suDb.schedulerJob.findMany({
    where: {
      tenantId,
      kind: "OBSERVE",
      status: { in: ["PENDING", "CLAIMED"] },
      dedupeKey: { startsWith: `observe:${tenantId}:${instanceId}:${convId}:` },
    },
    select: { payload: true },
  });
}

function observeRows(convId: number) {
  return suDb.schedulerJob.findMany({
    where: {
      tenantId,
      kind: "OBSERVE",
      dedupeKey: { startsWith: `observe:${tenantId}:${instanceId}:${convId}:` },
    },
    select: { payload: true },
  });
}

async function gateLines(convId: number) {
  const conv = await suDb.conversation.findFirst({
    where: { tenantId, chatwootConversationId: convId },
    select: { id: true },
  });
  if (!conv) return [];
  return flowLogRows(suDb, {
    where: { tenantId, conversationId: conv.id, stage: "contact_auth" },
    select: { detail: true, agentId: true },
  });
}

describe.skipIf(!dbUp)("the contact gate's rule on the observer path", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CAOBS", slug: `caobs-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 88,
      baseUrl: CW_BASE,
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "stt-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    sttKeyRef = `vault:${key.id}`;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Triagem",
        systemPrompt: "…",
        modelConfig: {
          provider: "openai",
          model: "gpt-5.4-mini",
          credentialRef: sttKeyRef,
        },
        enabled: true,
        mode: "monitoring",
      },
    });
    observerId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: OBSERVER_BOT,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `caobs-route-${process.pid}`,
        name: "Triagem",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OBSERVED_INBOX,
        name: "Atendimento",
      },
    });
    await suDb.inboxObserver.create({
      data: { tenantId, inboxId: inbox.id, agentId: agent.id },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: BOUND_INBOX,
        name: "Grupos",
        agentId: agent.id,
      },
    });
  });

  beforeEach(async () => {
    providers.stt = 0;
    providers.auth = 0;
    authAnswer = "allow";
    authBodies.length = 0;
    customerFacing.length = 0;
    clearContactAuthState();
  });

  afterAll(async () => {
    if (!dbUp) return;
    await clearFlowLog(suDb, { tenantId });
    for (const table of [
      "scheduler_jobs",
      "chatwoot_webhook_deliveries",
      "conversations",
      "contacts",
      "inbox_observers",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
      "vault_entries",
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

  test("a message the rule refuses arms no observation, transcribes nothing, speaks to nobody, and leaves one refusal line", async () => {
    await setGate({ enabled: true, rule: GROUP_ONLY });
    await deliverMessage(1, "individual");
    expect(await observeRows(1)).toEqual([]);
    expect(providers.stt).toBe(0);
    expect(customerFacing).toEqual([]);
    const lines = await gateLines(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.agentId).toBe(observerId);
    expect(lines[0]?.detail).toMatchObject({
      outcome: "denied",
      reason: "rule_conversation_type",
    });
  });

  test("a message the rule lets through is observed as before", async () => {
    await setGate({ enabled: true, rule: GROUP_ONLY });
    await deliverMessage(2, "group");
    const rows = await observeRows(2);
    expect(rows).toHaveLength(1);
    expect((rows[0]?.payload as { reason?: string } | undefined)?.reason).toBe(
      "burst",
    );
    expect(providers.stt).toBe(1);
    expect(customerFacing).toEqual([]);
    const lines = await gateLines(2);
    expect(lines.map((l) => (l.detail as { outcome: string }).outcome)).toEqual(
      ["allowed"],
    );
  });

  test("a burst the rule refuses arms nothing on any of its messages", async () => {
    await setGate({ enabled: true, rule: GROUP_ONLY });
    await deliverMessage(3, "individual");
    await deliverMessage(3, "individual");
    await deliverMessage(3, "individual");
    expect(await observeRows(3)).toEqual([]);
    expect(providers.stt).toBe(0);
    expect(customerFacing).toEqual([]);
  });

  test("an endpoint-only gate asks the endpoint once before arming, and its allow is observed", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(4, "individual");
    expect(await observeRows(4)).toHaveLength(1);
    expect(providers.auth).toBe(1);
    expect(customerFacing).toEqual([]);
    const lines = await gateLines(4);
    expect(lines.map((l) => l.detail)).toEqual([
      expect.objectContaining({ outcome: "allowed", stage: "endpoint" }),
    ]);
    // The request carries the conversation's inbox, as a responder's does, and never the text.
    expect(authBodies).toHaveLength(1);
    expect(authBodies[0]?.conversation).toMatchObject({
      id: 4,
      inboxId: OBSERVED_INBOX,
    });
    expect(authBodies[0]).not.toHaveProperty("message");
  });

  test("an endpoint denial is not observed, speaks to nobody, and leaves one endpoint line", async () => {
    authAnswer = "deny";
    await setGate({
      enabled: true,
      url: AUTH_URL,
      denyMessage: "Atendemos apenas clientes cadastrados.",
      handoffEnabled: true,
      includeMessageText: true,
    });
    await deliverMessage(17, "individual", false, OBSERVED_INBOX, {
      text: "codigo 4711",
    });
    expect(await runnableObserveRows(17)).toEqual([]);
    expect(providers.stt).toBe(0);
    expect(providers.auth).toBe(1);
    // ...with the text of the message that armed it, under the responder's contract.
    expect(authBodies[0]?.message).toEqual({ text: "codigo 4711" });
    expect(customerFacing).toEqual([]);
    const lines = await gateLines(17);
    expect(lines.map((l) => l.detail)).toEqual([
      expect.objectContaining({ outcome: "denied", stage: "endpoint" }),
    ]);
  });

  test("an endpoint that fails leaves the conversation unobserved, with an error line", async () => {
    authAnswer = "error";
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(18, "individual");
    expect(await runnableObserveRows(18)).toEqual([]);
    expect(customerFacing).toEqual([]);
    const lines = await gateLines(18);
    expect(lines.map((l) => l.detail)).toEqual([
      expect.objectContaining({ outcome: "error", stage: "endpoint" }),
    ]);
  });

  test("an endpoint that later denies retires the observation an earlier allow armed", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(23, "individual");
    expect(await runnableObserveRows(23)).toHaveLength(1);
    authAnswer = "deny";
    await deliverMessage(23, "individual");
    expect(providers.auth).toBe(2);
    expect(await runnableObserveRows(23)).toEqual([]);
  });

  test("an endpoint that fails after an allow retires the armed observation too", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(24, "individual");
    expect(await runnableObserveRows(24)).toHaveLength(1);
    authAnswer = "error";
    await deliverMessage(24, "individual");
    expect(await runnableObserveRows(24)).toEqual([]);
  });

  // Two deliveries in flight on one conversation: the allow asked first must not re-arm after the
  // denial asked later has retired the observation.
  test("an allow asked before a later denial cannot re-arm the observation the denial retired", async () => {
    const settings = { contactAuth: { enabled: true, url: AUTH_URL } };
    await setGate(settings.contactAuth);
    await deliverMessage(25, "individual");
    expect(await runnableObserveRows(25)).toHaveLength(1);
    const permit = await observerArmPermit({
      tenantId,
      instanceId,
      conversationId: 25,
      agentId: observerId,
      settings,
      base: appDb,
      fetchImpl: deps().contactAuthFetch,
    });
    expect(permit).not.toBeNull();
    authAnswer = "deny";
    await deliverMessage(25, "individual");
    expect(
      await armObserve({
        tenantId,
        instanceId,
        conversationId: 25,
        agentId: observerId,
        reason: "burst",
        cfg: readMonitoringConfig({}),
        gateAskedAt: permit?.askedAt,
        base: appDb,
      }),
    ).toBe("off");
    expect(await runnableObserveRows(25)).toEqual([]);
    // An allow asked after the denial arms as before.
    authAnswer = "allow";
    await deliverMessage(25, "individual");
    expect(await runnableObserveRows(25)).toHaveLength(1);
  });

  // The reverse interleaving: a refusal asked before an allow, whose bookkeeping lands after the
  // allow armed, does not retire the newer observation.
  test("a refusal asked before an allow that already armed leaves the newer observation runnable", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(27, "individual");
    expect(await runnableObserveRows(27)).toHaveLength(1);
    await retireRefusedObserve({
      tenantId,
      instanceId,
      conversationId: 27,
      agentId: observerId,
      askedAt: Date.now() - 60_000,
      base: appDb,
    });
    expect(await runnableObserveRows(27)).toHaveLength(1);
  });

  // An arm that cannot read the gate (the database failing under it) on a gate that asks an
  // endpoint takes back the observation an earlier allow queued, since the tick will not ask the
  // endpoint again.
  test("an arm that cannot read an endpoint gate retires the observation an earlier allow queued", async () => {
    const settings = { contactAuth: { enabled: true, url: AUTH_URL } };
    await setGate(settings.contactAuth);
    await deliverMessage(28, "individual");
    expect(await runnableObserveRows(28)).toHaveLength(1);
    let reads = 0;
    const flaky = new Proxy(appDb, {
      get(target, prop, receiver) {
        // The gate's first read fails; the retirement after it reaches the database.
        if (prop === "$extends" && reads++ === 0) {
          return () => ({
            $transaction: () =>
              Promise.reject(new Error("database unreachable")),
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as PrismaClient;
    expect(
      await observerArmPermit({
        tenantId,
        instanceId,
        conversationId: 28,
        agentId: observerId,
        settings,
        base: flaky,
        fetchImpl: deps().contactAuthFetch,
      }),
    ).toBeNull();
    expect(await runnableObserveRows(28)).toEqual([]);
  });

  // One contact in two conversations at once: each conversation is its own question to the
  // endpoint, which may answer by the conversation's inbox or id.
  test("two conversations of one contact asked at once each ask the endpoint", async () => {
    const settings = { contactAuth: { enabled: true, url: AUTH_URL } };
    await setGate(settings.contactAuth);
    await deliverMessage(30, "individual");
    await deliverMessage(31, "individual");
    const first = await suDb.conversation.findFirst({
      where: { tenantId, chatwootConversationId: 30 },
      select: { contactId: true },
    });
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: 31 },
      data: { contactId: first?.contactId },
    });
    clearContactAuthState();
    providers.auth = 0;
    authBodies.length = 0;
    const permit = (conversationId: number) =>
      observerArmPermit({
        tenantId,
        instanceId,
        conversationId,
        agentId: observerId,
        settings,
        base: appDb,
        fetchImpl: deps().contactAuthFetch,
      });
    await Promise.all([permit(30), permit(31)]);
    expect(providers.auth).toBe(2);
    expect(
      authBodies
        .map((b) => (b.conversation as { id: number }).id)
        .sort((a, b) => a - b),
    ).toEqual([30, 31]);
  });

  // A resolution delivered again while its verdict is queued: the newer allow is kept on the row,
  // so a refusal asked between the two allows and landing after both leaves it runnable.
  test("a newer allow of a resolution already queued is kept against an older refusal", async () => {
    await setGate(null);
    await deliverMessage(32, "individual");
    const arm = (gateAskedAt: number) =>
      armObserve({
        tenantId,
        instanceId,
        conversationId: 32,
        agentId: observerId,
        reason: "resolved",
        cfg: readMonitoringConfig({}),
        mark: 1_900_000_000,
        gateAskedAt,
        base: appDb,
      });
    const t = Date.now();
    expect(await arm(t + 1_000)).toBe("armed");
    expect(await arm(t + 3_000)).toBe("off");
    await retireRefusedObserve({
      tenantId,
      instanceId,
      conversationId: 32,
      agentId: observerId,
      askedAt: t + 2_000,
      base: appDb,
    });
    expect(await runnableObserveRows(32)).toHaveLength(1);
  });

  // A conversation the gate cannot tie to a contact is refused before either stage; on an
  // endpoint-only gate the tick has no condition to ask again, so the arm takes back what was queued.
  test("a refusal for want of a contact retires an observation queued before the gate was on", async () => {
    // A conversation not mirrored yet has no contact: the gate refuses before either stage.
    expect(
      await armObserve({
        tenantId,
        instanceId,
        conversationId: 33,
        agentId: observerId,
        reason: "burst",
        cfg: readMonitoringConfig({}),
        base: appDb,
      }),
    ).toBe("armed");
    const settings = { contactAuth: { enabled: true, url: AUTH_URL } };
    expect(
      await observerArmPermit({
        tenantId,
        instanceId,
        conversationId: 33,
        agentId: observerId,
        settings,
        base: appDb,
        fetchImpl: deps().contactAuthFetch,
      }),
    ).toBeNull();
    expect(await runnableObserveRows(33)).toEqual([]);
  });

  // A refusal whose retirement never reaches the database is still heard by this process's tick.
  test("a refusal whose retirement keeps failing still stops the queued tick in this process", async () => {
    const settings = { contactAuth: { enabled: true, url: AUTH_URL } };
    await setGate(settings.contactAuth);
    await deliverMessage(34, "individual");
    expect(await runnableObserveRows(34)).toHaveLength(1);
    authAnswer = "deny";
    let asked = false;
    const askingFetch = (async (url: unknown, init?: unknown) => {
      asked = true;
      return (authFetch as (u: unknown, i?: unknown) => Promise<Response>)(
        url,
        init,
      );
    }) as unknown as typeof fetch;
    const downAfterAsk = new Proxy(appDb, {
      get(target, prop, receiver) {
        if (prop === "$extends" && asked) {
          return () => ({
            $transaction: () =>
              Promise.reject(new Error("database unreachable")),
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as PrismaClient;
    expect(
      await observerArmPermit({
        tenantId,
        instanceId,
        conversationId: 34,
        agentId: observerId,
        settings,
        base: downAfterAsk,
        fetchImpl: askingFetch,
        sleep: async () => {},
      }),
    ).toBeNull();
    expect(await runnableObserveRows(34)).toHaveLength(1);
    expect(
      await observerRuleVerdict(
        {
          tenantId,
          instanceId,
          conversationId: 34,
          agentId: observerId,
          settings,
          base: appDb,
        },
        { emit: false },
      ),
    ).toBe("refused");
    // A later allow clears it.
    authAnswer = "allow";
    await deliverMessage(34, "individual");
    expect(
      await observerRuleVerdict(
        {
          tenantId,
          instanceId,
          conversationId: 34,
          agentId: observerId,
          settings,
          base: appDb,
        },
        { emit: false },
      ),
    ).toBe("allowed");
  });

  // The in-memory fallback follows the verdicts' ask order: a denial asked before an allow, whose
  // retries run out after it, does not fence the newer observation.
  test("a denial whose retries end after a newer allow does not fence the tick", async () => {
    const settings = { contactAuth: { enabled: true, url: AUTH_URL } };
    await setGate(settings.contactAuth);
    await deliverMessage(35, "individual");
    authAnswer = "deny";
    let asked = false;
    let releaseRetries: () => void = () => {};
    const retriesHeld = new Promise<void>((r) => {
      releaseRetries = r;
    });
    const askingFetch = (async (url: unknown, init?: unknown) => {
      asked = true;
      return (authFetch as (u: unknown, i?: unknown) => Promise<Response>)(
        url,
        init,
      );
    }) as unknown as typeof fetch;
    const downAfterAsk = new Proxy(appDb, {
      get(target, prop, receiver) {
        if (prop === "$extends" && asked) {
          return () => ({
            $transaction: () =>
              Promise.reject(new Error("database unreachable")),
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as PrismaClient;
    const denial = observerArmPermit({
      tenantId,
      instanceId,
      conversationId: 35,
      agentId: observerId,
      settings,
      base: downAfterAsk,
      fetchImpl: askingFetch,
      sleep: () => retriesHeld,
    });
    await new Promise((r) => setTimeout(r, 50));
    authAnswer = "allow";
    clearContactAuthState();
    await new Promise((r) => setTimeout(r, 5));
    await deliverMessage(35, "individual");
    releaseRetries();
    expect(await denial).toBeNull();
    expect(
      await observerRuleVerdict(
        {
          tenantId,
          instanceId,
          conversationId: 35,
          agentId: observerId,
          settings,
          base: appDb,
        },
        { emit: false },
      ),
    ).toBe("allowed");
  });

  // Chatwoot follows a voice note with a `message_updated`: the bound watcher's allow for the
  // message covers it, and the endpoint is not asked again.
  test("a bound watcher's late update of an allowed audio does not ask the endpoint again", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    const messageId = await deliverMessage(
      36,
      "individual",
      false,
      BOUND_INBOX,
    );
    expect(providers.auth).toBe(1);
    await deliverMessage(36, "individual", false, BOUND_INBOX, { messageId });
    expect(providers.auth).toBe(1);
    expect(await runnableObserveRows(36)).toHaveLength(1);
  });

  // While the retirement is still being retried, a tick due in that window already hears the refusal.
  test("a tick due while a refusal's retirement is retried is refused", async () => {
    const settings = { contactAuth: { enabled: true, url: AUTH_URL } };
    await setGate(settings.contactAuth);
    await deliverMessage(37, "individual");
    authAnswer = "deny";
    let asked = false;
    const askingFetch = (async (url: unknown, init?: unknown) => {
      asked = true;
      return (authFetch as (u: unknown, i?: unknown) => Promise<Response>)(
        url,
        init,
      );
    }) as unknown as typeof fetch;
    // Down from the ask until the first pause, so the first retirement fails and the second lands.
    let paused = false;
    const flakyAfterAsk = new Proxy(appDb, {
      get(target, prop, receiver) {
        if (prop === "$extends" && asked && !paused) {
          return () => ({
            $transaction: () =>
              Promise.reject(new Error("database unreachable")),
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as PrismaClient;
    const tickDuringRetry: string[] = [];
    const ruleParams = {
      tenantId,
      instanceId,
      conversationId: 37,
      agentId: observerId,
      settings,
      base: appDb,
    };
    await observerArmPermit({
      ...ruleParams,
      base: flakyAfterAsk,
      fetchImpl: askingFetch,
      sleep: async () => {
        paused = true;
        tickDuringRetry.push(
          await observerRuleVerdict(ruleParams, { emit: false }),
        );
      },
    });
    expect(tickDuringRetry).toEqual(["refused"]);
    expect(await runnableObserveRows(37)).toEqual([]);
  });

  // The allow the late update reuses is the endpoint's: the conditions are asked again, so an
  // update arriving after the conversation left them is not transcribed.
  test("a bound watcher's late update is not transcribed once the conditions no longer cover it", async () => {
    await setGate({
      enabled: true,
      rule: GROUP_ONLY,
      url: AUTH_URL,
      askEndpointAfterRule: true,
    });
    const messageId = await deliverMessage(38, "group", false, BOUND_INBOX);
    expect(providers.stt).toBe(1);
    await deliverMessage(38, "individual", false, BOUND_INBOX, { messageId });
    expect(providers.stt).toBe(1);
    expect(providers.auth).toBe(1);
    // The update was put to the conditions, which refused it.
    expect((await gateLines(38)).map((l) => l.detail)).toEqual([
      expect.objectContaining({ outcome: "allowed" }),
      expect.objectContaining({ outcome: "denied", stage: "rule" }),
    ]);
  });

  // A pass that finds the inbox's agent observing takes the delivery's own ask of the watcher's
  // gate, so the arm after it does not put the question to the endpoint a second time.
  test("a pass handed the delivery's watcher ask uses it instead of asking the endpoint", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(43, "individual", false, BOUND_INBOX);
    providers.auth = 0;
    providers.stt = 0;
    const asks: bigint[] = [];
    const n = audioEvent(43, "individual", false, BOUND_INBOX);
    await runEagerMedia(tenantId, instanceId, n, appDb, {
      conversationId: null,
      agentId: null,
      inboxId: null,
      chatwootInboxId: BOUND_INBOX,
      deliveryRowId: null,
      deps: deps() as never,
      admission: "unverified",
      watcherPermit: async (agentId) => {
        asks.push(agentId);
        return { askedAt: Date.now() };
      },
    });
    expect(asks).toEqual([observerId]);
    expect(providers.auth).toBe(0);
    expect(providers.stt).toBe(1);
  });

  // An observer beside the inbox's own agent: its allow for a voice note covers Chatwoot's late
  // update of it too, without a second question to the endpoint.
  test("a row-backed observer's late update of an allowed audio does not ask the endpoint again", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    const messageId = await deliverMessage(44, "individual");
    expect(providers.auth).toBe(1);
    await deliverMessage(44, "individual", false, OBSERVED_INBOX, {
      messageId,
    });
    expect(providers.auth).toBe(1);
    expect(await runnableObserveRows(44)).toHaveLength(1);
  });

  // A claimed tick whose row an endpoint refusal retired ends before the model.
  test("a claimed tick retired by an endpoint refusal ends before the model", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(45, "individual");
    const row = await suDb.schedulerJob.findFirst({
      where: {
        tenantId,
        kind: "OBSERVE",
        dedupeKey: { startsWith: `observe:${tenantId}:${instanceId}:45:` },
      },
      select: { id: true, claimSeq: true },
    });
    await suDb.schedulerJob.update({
      where: { id: row?.id },
      data: { status: "CLAIMED" },
    });
    authAnswer = "deny";
    await deliverMessage(45, "individual");
    const out = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: 45,
        agentId: observerId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        claim: { jobId: row?.id as bigint, claimSeq: row?.claimSeq as number },
        makeModel: () => {
          throw new Error("a retired claim must not reach the model");
        },
        makeClient: stubClient() as never,
      },
    );
    expect(out).toEqual({ outcome: "done" });
  });

  // A caller that joins an endpoint question already in flight carries that question's ask time:
  // joining after a denial must not make an older allow look newer than it.
  test("an allow shared from a flight that began before a denial cannot re-arm what the denial retired", async () => {
    const settings = {
      contactAuth: { enabled: true, url: AUTH_URL, includeMessageText: true },
    };
    await setGate(settings.contactAuth);
    await deliverMessage(46, "individual");
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const heldFetch = (async () => {
      await held;
      return new Response(JSON.stringify({ authorized: true }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const ask = () =>
      observerArmPermit({
        tenantId,
        instanceId,
        conversationId: 46,
        agentId: observerId,
        settings,
        base: appDb,
        fetchImpl: heldFetch,
        message: { id: 990_046, text: "a" },
      });
    const first = ask();
    await new Promise((r) => setTimeout(r, 30));
    authAnswer = "deny";
    await deliverMessage(46, "individual", false, OBSERVED_INBOX, {
      text: "b",
    });
    expect(await runnableObserveRows(46)).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    const joined = ask();
    // Long enough for the second ask to reach the flight the first one holds open.
    await new Promise((r) => setTimeout(r, 30));
    release();
    await first;
    const permit = await joined;
    expect(permit).not.toBeNull();
    expect(
      await armObserve({
        tenantId,
        instanceId,
        conversationId: 46,
        agentId: observerId,
        reason: "burst",
        cfg: readMonitoringConfig({}),
        gateAskedAt: permit?.askedAt,
        base: appDb,
      }),
    ).toBe("off");
  });

  // A denial asked in the same millisecond as an allow wins the tie, as the durable marks do.
  test("a denial asked in the same millisecond as an allow still fences the tick", async () => {
    const settings = { contactAuth: { enabled: true, url: AUTH_URL } };
    await setGate(settings.contactAuth);
    await deliverMessage(47, "individual");
    setSystemTime(new Date(Date.now() + 60_000));
    try {
      await deliverMessage(47, "individual");
      authAnswer = "deny";
      let asked = false;
      const askingFetch = (async (url: unknown, init?: unknown) => {
        asked = true;
        return (authFetch as (u: unknown, i?: unknown) => Promise<Response>)(
          url,
          init,
        );
      }) as unknown as typeof fetch;
      const downAfterAsk = new Proxy(appDb, {
        get(target, prop, receiver) {
          if (prop === "$extends" && asked) {
            return () => ({
              $transaction: () =>
                Promise.reject(new Error("database unreachable")),
            });
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as PrismaClient;
      const ruleParams = {
        tenantId,
        instanceId,
        conversationId: 47,
        agentId: observerId,
        settings,
        base: appDb,
      };
      await observerArmPermit({
        ...ruleParams,
        base: downAfterAsk,
        fetchImpl: askingFetch,
        sleep: async () => {},
      });
      expect(await observerRuleVerdict(ruleParams, { emit: false })).toBe(
        "refused",
      );
    } finally {
      setSystemTime();
    }
  });

  // An allow remembered for a voice note stops covering its late update once the endpoint has
  // refused the conversation since (here at the resolve): the update asks the gate again.
  test("a late update after a newer endpoint refusal does not reuse the message's allow", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    const messageId = await deliverMessage(
      48,
      "individual",
      false,
      BOUND_INBOX,
    );
    expect(providers.auth).toBe(1);
    authAnswer = "deny";
    await deliverResolve(48, "individual");
    expect(providers.auth).toBe(2);
    await deliverMessage(48, "individual", false, BOUND_INBOX, { messageId });
    expect(providers.auth).toBe(3);
  });

  // An allow given with no endpoint behind it (the gate off) is not one a late update may reuse
  // once an endpoint guards the agent: the update asks it.
  test("a late update asks an endpoint enabled after its message was let through ungated", async () => {
    await setGate(null);
    const messageId = await deliverMessage(
      49,
      "individual",
      false,
      BOUND_INBOX,
    );
    expect(providers.auth).toBe(0);
    authAnswer = "deny";
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(49, "individual", false, BOUND_INBOX, { messageId });
    expect(providers.auth).toBe(1);
  });

  // The bound watcher's media pass is skipped on a refusal, and the refusal is remembered for the
  // message, so Chatwoot's late update of the same audio is not transcribed by a later allow.
  test("a bound watcher's refused audio stays untranscribed when its late update is allowed", async () => {
    authAnswer = "deny";
    await setGate({ enabled: true, url: AUTH_URL });
    const messageId = await deliverMessage(
      26,
      "individual",
      false,
      BOUND_INBOX,
    );
    expect(providers.stt).toBe(0);
    authAnswer = "allow";
    await deliverMessage(26, "individual", false, BOUND_INBOX, { messageId });
    expect(providers.stt).toBe(0);
  });

  // With forwarding on, each message is its own question (the key carries its id, as a
  // responder's does); with it off, the text never travels.
  test("the observer forwards the arming message's text only when asked to, one question per message", async () => {
    await setGate({ enabled: true, url: AUTH_URL, includeMessageText: true });
    await deliverMessage(39, "individual", false, OBSERVED_INBOX, {
      text: "primeira",
    });
    await deliverMessage(39, "individual", false, OBSERVED_INBOX, {
      text: "segunda",
    });
    expect(authBodies.map((b) => b.message)).toEqual([
      { text: "primeira" },
      { text: "segunda" },
    ]);
    authBodies.length = 0;
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(40, "individual", false, OBSERVED_INBOX, {
      text: "nao vai",
    });
    expect(authBodies).toHaveLength(1);
    expect(authBodies[0]).not.toHaveProperty("message");
  });

  // A resolve has no message of its own: the request goes without the key, as a responder's nudge.
  test("the resolve arm asks without message text even with forwarding on", async () => {
    await setGate({ enabled: true, url: AUTH_URL, includeMessageText: true });
    await deliverMessage(41, "individual", false, OBSERVED_INBOX, {
      text: "oi",
    });
    authBodies.length = 0;
    await deliverResolve(41, "individual");
    expect(authBodies).toHaveLength(1);
    expect(authBodies[0]).not.toHaveProperty("message");
  });

  // The bound watcher's media pass and arm share one question, text and all.
  test("a bound watcher forwarding the text asks once for the media pass and the arm", async () => {
    await setGate({ enabled: true, url: AUTH_URL, includeMessageText: true });
    await deliverMessage(42, "individual", false, BOUND_INBOX, {
      text: "codigo 9",
    });
    expect(providers.auth).toBe(1);
    expect(authBodies[0]?.message).toEqual({ text: "codigo 9" });
  });

  test("with conditions and the endpoint after them, the endpoint is asked only about what they let through", async () => {
    await setGate({
      enabled: true,
      rule: GROUP_ONLY,
      url: AUTH_URL,
      askEndpointAfterRule: true,
    });
    await deliverMessage(5, "group");
    expect(await observeRows(5)).toHaveLength(1);
    expect(providers.auth).toBe(1);
    await deliverMessage(6, "individual");
    expect(await observeRows(6)).toEqual([]);
    expect(providers.auth).toBe(1);
  });

  test("a rule with a url left beside it and the switch off asks only the rule", async () => {
    await setGate({ enabled: true, rule: GROUP_ONLY, url: AUTH_URL });
    await deliverMessage(22, "group");
    expect(await observeRows(22)).toHaveLength(1);
    expect(providers.auth).toBe(0);
  });

  test("under mode once, the endpoint's allow is reused on the next message", async () => {
    await setGate({ enabled: true, url: AUTH_URL, mode: "once" });
    await deliverMessage(20, "individual");
    await deliverMessage(20, "individual");
    expect(await observeRows(20)).toHaveLength(1);
    expect(providers.auth).toBe(1);
  });

  test("the tick does not ask the endpoint again", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(19, "individual");
    expect(await observeRows(19)).toHaveLength(1);
    expect(providers.auth).toBe(1);
    authAnswer = "deny";
    await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: 19,
        agentId: observerId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        makeModel: () => {
          throw new Error("no model in this test");
        },
        makeClient: stubClient() as never,
      },
    ).catch(() => {});
    expect(providers.auth).toBe(1);
  });

  test("a contact the list cannot identify is not observed, and nothing is opened even with the handoff on", async () => {
    await setGate({
      enabled: true,
      rule: { kind: "allowlist", phones: ["5511999990000"], identifiers: [] },
      handoffEnabled: true,
      denyMessage: "Atendemos apenas clientes cadastrados.",
    });
    await deliverMessage(10, "individual", true);
    expect(await observeRows(10)).toEqual([]);
    expect(customerFacing).toEqual([]);
    const lines = await gateLines(10);
    expect(lines.map((l) => (l.detail as { outcome: string }).outcome)).toEqual(
      ["no_identity"],
    );
  });

  test("a rule that cannot be evaluated refuses, the gate's fail-closed direction", async () => {
    const unreadable = new Proxy(
      {},
      {
        get: () => {
          throw new Error("database unreachable");
        },
      },
    ) as PrismaClient;
    expect(
      await observerArmPermit({
        tenantId,
        instanceId,
        conversationId: 11,
        agentId: observerId,
        settings: { contactAuth: { enabled: true, rule: GROUP_ONLY } },
        base: unreadable,
      }),
    ).toBeNull();
    // ...and says why to the tick, which retries a read that failed instead of treating it as a no.
    expect(
      await observerRuleVerdict(
        {
          tenantId,
          instanceId,
          conversationId: 11,
          agentId: observerId,
          settings: { contactAuth: { enabled: true, rule: GROUP_ONLY } },
          base: unreadable,
        },
        { emit: false },
      ),
    ).toBe("unreadable");
  });

  // The watcher bound as the inbox's own agent: its media pass is admitted by the verdict the arm
  // just reached, so the endpoint is asked once per delivery and leaves one line, not a second one
  // from the pass asking again.
  test("a watcher bound as the inbox's agent asks the endpoint once for the media pass and the arm", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(12, "individual", false, BOUND_INBOX);
    expect(await observeRows(12)).toHaveLength(1);
    expect(providers.stt).toBe(1);
    expect(providers.auth).toBe(1);
    expect((await gateLines(12)).length).toBe(1);
    await setGate({ enabled: true, rule: GROUP_ONLY });
    await deliverMessage(13, "group", false, BOUND_INBOX);
    expect(await observeRows(13)).toHaveLength(1);
    expect(providers.stt).toBe(2);
    expect(providers.auth).toBe(1);
    expect((await gateLines(13)).length).toBe(1);
  });

  // A pass that asks for itself (an agent flipped to monitoring while its gate waited, a hand-over)
  // reads the inbox's agent fresh and asks the whole gate a watcher has: here, the endpoint.
  test("a media pass that asks for itself under a watcher asks the watcher's endpoint", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(15, "individual", false, BOUND_INBOX);
    expect(providers.stt).toBe(1);
    expect(providers.auth).toBe(1);
    authAnswer = "deny";
    const n = audioEvent(15, "individual", false, BOUND_INBOX);
    await runEagerMedia(tenantId, instanceId, n, appDb, {
      conversationId: null,
      agentId: null,
      inboxId: null,
      chatwootInboxId: BOUND_INBOX,
      deliveryRowId: null,
      deps: deps() as never,
      admission: "unverified",
    });
    expect(providers.auth).toBe(2);
    expect(providers.stt).toBe(1);
    expect(customerFacing).toEqual([]);
    // ...and its denial takes back the observation the first message queued, as an arm's does.
    expect(await runnableObserveRows(15)).toEqual([]);
  });

  // An observation armed while the rule allowed it is asked again when it runs: a label removed or a
  // rule tightened in between keeps the model out.
  test("a queued observation the rule now refuses ends before the model, with a skipped line", async () => {
    await setGate({ enabled: true, rule: GROUP_ONLY });
    await deliverMessage(14, "group");
    expect(await observeRows(14)).toHaveLength(1);
    await setGate({
      enabled: true,
      rule: { kind: "label", label: "suporte" },
    });
    let modelCalls = 0;
    const out = await runObserve(
      tenantId,
      {
        instanceId,
        conversationId: 14,
        agentId: observerId,
        reason: "burst",
        atMessageId: null,
      },
      appDb,
      {
        makeModel: () => {
          modelCalls += 1;
          throw new Error("the model must not be reached");
        },
        makeClient: stubClient() as never,
      },
    );
    expect(out).toEqual({ outcome: "done" });
    expect(modelCalls).toBe(0);
    const conv = await suDb.conversation.findFirst({
      where: { tenantId, chatwootConversationId: 14 },
      select: { id: true },
    });
    const skipped = await flowLogRows(suDb, {
      where: { tenantId, conversationId: conv?.id, stage: "observe" },
      select: { detail: true },
    });
    expect(
      skipped.map((r) => (r.detail as { skipped?: string }).skipped),
    ).toEqual(["contact_auth_refused"]);
  });

  test("a queued observation the rule now refuses completes even when no model could run", async () => {
    await setGate({ enabled: true, rule: GROUP_ONLY });
    await deliverMessage(16, "group");
    expect(await observeRows(16)).toHaveLength(1);
    await setGate({ enabled: true, rule: { kind: "label", label: "suporte" } });
    const modelConfig = (
      await suDb.agent.findUniqueOrThrow({
        where: { id: observerId },
        select: { modelConfig: true },
      })
    ).modelConfig as Prisma.InputJsonObject;
    await suDb.agent.update({
      where: { id: observerId },
      data: {
        modelConfig: { ...modelConfig, credentialRef: "cred_absent_1088" },
      },
    });
    try {
      const out = await runObserve(
        tenantId,
        {
          instanceId,
          conversationId: 16,
          agentId: observerId,
          reason: "burst",
          atMessageId: null,
        },
        appDb,
        {
          makeModel: () => {
            throw new Error("the model must not be reached");
          },
          makeClient: stubClient() as never,
        },
      );
      expect(out).toEqual({ outcome: "done" });
    } finally {
      await suDb.agent.update({
        where: { id: observerId },
        data: { modelConfig },
      });
    }
  });

  test("a switched-off gate observes everything, with no line", async () => {
    await setGate({ enabled: false, rule: GROUP_ONLY });
    await deliverMessage(7, "individual");
    expect(await observeRows(7)).toHaveLength(1);
    expect(await gateLines(7)).toEqual([]);
  });

  test("the resolve arm honours the rule: refused arms no verdict, allowed pulls one forward", async () => {
    await setGate(null);
    await deliverMessage(8, "individual");
    await deliverMessage(9, "group");
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "OBSERVE" },
    });
    await setGate({ enabled: true, rule: GROUP_ONLY });
    await deliverResolve(8, "individual");
    expect(await observeRows(8)).toEqual([]);
    await deliverResolve(9, "group");
    const rows = await observeRows(9);
    expect(rows).toHaveLength(1);
    expect((rows[0]?.payload as { reason?: string } | undefined)?.reason).toBe(
      "resolved",
    );
    expect(customerFacing).toEqual([]);
  });

  // Two deliveries of one resolution: the first allowed queues the verdict, a failure retires it
  // before it ran, and a later allow of the same resolution brings it back.
  test("a resolution whose queued verdict an endpoint failure retired is armed again by a later allow", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(29, "individual");
    const version = 1_800_000_000;
    await deliverResolve(29, "individual", version);
    expect(await runnableObserveRows(29)).toHaveLength(1);
    authAnswer = "error";
    await deliverResolve(29, "individual", version);
    expect(await runnableObserveRows(29)).toEqual([]);
    authAnswer = "allow";
    await deliverResolve(29, "individual", version);
    expect(await runnableObserveRows(29)).toHaveLength(1);
  });

  test("the resolve arm asks the endpoint too: a denial arms no verdict", async () => {
    await setGate(null);
    await deliverMessage(21, "individual");
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "OBSERVE" },
    });
    authAnswer = "deny";
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverResolve(21, "individual");
    expect(await runnableObserveRows(21)).toEqual([]);
    expect(providers.auth).toBe(1);
    expect(customerFacing).toEqual([]);
  });
});
