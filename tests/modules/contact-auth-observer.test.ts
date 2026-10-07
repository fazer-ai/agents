import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
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
  observerRuleAllows,
  observerRuleVerdict,
} from "@/modules/contact-auth/observer";
import { clearContactAuthState } from "@/modules/contact-auth/state";
import { runObserve } from "@/modules/observe/job";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// THE CONTACT GATE'S RULE ON THE OBSERVER PATH. A monitoring agent watching an inbox runs
// the rule stage before it arms an observation, so a conversation the rule refuses costs no OBSERVE
// job, no transcription and no model call; the refusal speaks to nobody (nothing sent, opened or
// noted) and leaves one `contact_auth` line. The endpoint stage never runs for an observer: an
// endpoint-only gate observes as before, with the endpoint never asked.

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
const customerFacing: string[] = [];

const sttFetch = (async () => {
  providers.stt += 1;
  return new Response(JSON.stringify({ text: "transcrito" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;
const authFetch = (async () => {
  providers.auth += 1;
  return new Response(JSON.stringify({ authorized: true }), { status: 200 });
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
) {
  seq += 1;
  const messageId = 108_000 + seq;
  const n = normalizeChatwootEvent({
    event: "message_created",
    id: messageId,
    content: "",
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
) {
  const n = audioEvent(convId, groupType, anonymous, inboxId);
  const delivery = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `cao-${process.pid}-${seq}`,
      event: "message_created",
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

async function deliverResolve(
  convId: number,
  groupType: "group" | "individual",
) {
  seq += 1;
  const n = normalizeChatwootEvent({
    event: "conversation_status_changed",
    ...conversation(convId, groupType, "resolved"),
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

  test("an endpoint-only gate observes as before, and the endpoint is never asked", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(4, "individual");
    expect(await observeRows(4)).toHaveLength(1);
    expect(providers.auth).toBe(0);
    expect(customerFacing).toEqual([]);
    expect(await gateLines(4)).toEqual([]);
  });

  test("a rule with the endpoint after it runs only the rule on the observer path", async () => {
    await setGate({
      enabled: true,
      rule: GROUP_ONLY,
      url: AUTH_URL,
      askEndpointAfterRule: true,
    });
    await deliverMessage(5, "group");
    expect(await observeRows(5)).toHaveLength(1);
    await deliverMessage(6, "individual");
    expect(await observeRows(6)).toEqual([]);
    expect(providers.auth).toBe(0);
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
      await observerRuleAllows({
        tenantId,
        instanceId,
        conversationId: 11,
        agentId: observerId,
        settings: { contactAuth: { enabled: true, rule: GROUP_ONLY } },
        base: unreadable,
      }),
    ).toBe(false);
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

  // The watcher bound as the inbox's own agent: its media pass is admitted by the rule it just
  // asked, so an endpoint-only gate does not reach the endpoint there either, and a rule-only gate
  // leaves one line, not a second one from the pass asking again.
  test("a watcher bound as the inbox's agent transcribes what it observes without asking the endpoint", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(12, "individual", false, BOUND_INBOX);
    expect(await observeRows(12)).toHaveLength(1);
    expect(providers.stt).toBe(1);
    expect(providers.auth).toBe(0);
    await setGate({ enabled: true, rule: GROUP_ONLY });
    await deliverMessage(13, "group", false, BOUND_INBOX);
    expect(await observeRows(13)).toHaveLength(1);
    expect(providers.stt).toBe(2);
    expect(providers.auth).toBe(0);
    expect((await gateLines(13)).length).toBe(1);
  });

  // A pass that asks for itself (an agent flipped to monitoring while its gate waited, a hand-over)
  // reads the inbox's agent fresh: a watcher has the rule stage only, so its endpoint is never asked.
  test("a media pass that asks for itself under a watcher never asks the endpoint", async () => {
    await setGate({ enabled: true, url: AUTH_URL });
    await deliverMessage(15, "individual", false, BOUND_INBOX);
    expect(providers.stt).toBe(1);
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
    expect(providers.stt).toBe(2);
    expect(providers.auth).toBe(0);
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
});
