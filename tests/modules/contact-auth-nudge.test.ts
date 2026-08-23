import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentNudge } from "@/graph/nudge";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { clearContactAuthState } from "@/modules/contact-auth/state";
import { seedChatwootInstance } from "../utils/chatwoot";

// The gate on the PROACTIVE side: a follow-up is a turn the agent starts, so a contact the reactive
// gate would refuse must not be reached out to either. A refused nudge ends as "silent", before any
// model spend; nothing is posted, not even a note, because the nudge's text was written FOR the
// customer.

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

const AUTH_URL = "https://203.0.113.9:9443/check";
const PHONE = "+5511966665555";

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let contactId = 0n;

function stub() {
  const messages: Array<[number, string]> = [];
  const notes: Array<[number, string]> = [];
  const client = {
    sendMessage: async (c: number, t: string) => {
      messages.push([c, t]);
      return {};
    },
    sendPrivateNote: async (c: number, t: string) => {
      notes.push([c, t]);
      return {};
    },
  } as unknown as ChatwootClient;
  return { client, messages, notes, makeClient: async () => client };
}

function authFetch(response: () => Response) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return response();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function seedConv(convId: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbId,
      chatwootConversationId: convId,
      contactId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
      lastInboundAt: new Date(),
    },
  });
}

describe.skipIf(!dbUp)("contact authorization on the proactive nudge", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CAN", slug: `can-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 43,
      baseUrl: "https://203.0.113.22:9",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const vault = await suDb.vaultEntry.create({
      data: { tenantId, name: "k", secret: encryptJson("sk") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${vault.id}`,
        },
        settings: {
          split: { enabled: false },
          contactAuth: { enabled: true, url: AUTH_URL },
        },
      },
      select: { id: true },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 31,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `can-route-${process.pid}`,
        name: "bot",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 44,
        name: "Suporte",
        agentId: agent.id,
      },
      select: { id: true },
    });
    inboxDbId = inbox.id;
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: instanceId,
        tenantId,
        chatwootContactId: 601,
        name: "Cliente",
        phone: PHONE,
      },
      select: { id: true },
    });
    contactId = contact.id;
  });

  beforeEach(() => {
    clearContactAuthState();
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "llm_usage",
        "execution_logs",
        "scheduler_jobs",
        "agent_threads",
        "conversations",
        "contacts",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "vault_entries",
        "chatwoot_instances",
      ]) {
        await suDb
          .$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => {});
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a denied contact is not followed up: silent, no model spend", async () => {
    await seedConv(9401);
    const s = stub();
    const auth = authFetch(
      () => new Response('{"authorized":false}', { status: 200 }),
    );
    const outcome = await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:9401`,
      nudge: { source: "followup", kind: "inactivity" },
      base: appDb,
      deps: {
        makeModel: () => {
          throw new Error("the model must not be invoked for a refused nudge");
        },
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
        contactAuthFetch: auth.fetchImpl,
      },
    });
    expect(outcome).toBe("silent");
    expect(auth.calls).toHaveLength(1);
    expect(s.messages).toEqual([]);
    expect(s.notes).toEqual([]);
  });

  test("an endpoint failure also silences the nudge (fail-closed)", async () => {
    await seedConv(9402);
    const s = stub();
    const auth = authFetch(() => new Response("boom", { status: 500 }));
    const outcome = await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:9402`,
      nudge: { source: "followup", kind: "inactivity" },
      base: appDb,
      deps: {
        makeModel: () => {
          throw new Error("the model must not be invoked for a refused nudge");
        },
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
        contactAuthFetch: auth.fetchImpl,
      },
    });
    expect(outcome).toBe("silent");
    expect(s.messages).toEqual([]);
  });

  // An event nudge on a conversation a human already owns has a documented path: it cannot message
  // the customer, so it leaves a private note for the operator (docs/integrations.md). The gate has
  // no business there — the note is signal FOR the human, not an approach to the customer — and the
  // post-verdict takeover fence would otherwise read "not the bot's" (which was already true before
  // the call) and turn that note into silence.
  test("a human-owned event nudge keeps its private note and is never asked about", async () => {
    await seedConv(9405);
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: 9405 },
      data: { assigneeType: "User", assigneeId: 52, status: "open" },
    });
    const s = stub();
    const auth = authFetch(
      () => new Response('{"authorized":true}', { status: 200 }),
    );
    const outcome = await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:9405`,
      nudge: { source: "followup", kind: "inactivity" },
      base: appDb,
      deps: {
        makeModel: () =>
          new FakeListChatModel({ responses: ["Pagamento confirmado."] }),
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
        contactAuthFetch: auth.fetchImpl,
      },
    });
    expect(outcome).toBe("noted");
    expect(auth.calls).toEqual([]);
    expect(s.messages).toEqual([]);
  });

  // The ownership probe runs before the authorization round-trip, which has a ten-second ceiling. A
  // human arriving inside it used to have the follow-up's tools run on their conversation: the
  // post-model re-probe only decides whether the TEXT goes out.
  test("a human taking over during the authorization call stops the follow-up", async () => {
    await seedConv(9404);
    const s = stub();
    let modelBuilds = 0;
    const auth = authFetch(
      () => new Response('{"authorized":true}', { status: 200 }),
    );
    const takeOverThenAllow = (async (input: RequestInfo | URL) => {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: 9404 },
        data: { assigneeType: "User", assigneeId: 51, status: "open" },
      });
      return auth.fetchImpl(input);
    }) as unknown as typeof fetch;
    const outcome = await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:9404`,
      nudge: { source: "followup", kind: "inactivity" },
      base: appDb,
      deps: {
        makeModel: () => {
          modelBuilds += 1;
          return new FakeListChatModel({ responses: ["não devia sair"] });
        },
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
        contactAuthFetch: takeOverThenAllow,
      },
    });
    expect(outcome).toBe("silent");
    expect(auth.calls).toHaveLength(1);
    expect(modelBuilds).toBe(0);
    expect(s.messages).toEqual([]);
  });

  test("an authorized contact is followed up normally (the control)", async () => {
    await seedConv(9403);
    const s = stub();
    const auth = authFetch(
      () => new Response('{"authorized":true}', { status: 200 }),
    );
    const outcome = await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:9403`,
      nudge: { source: "followup", kind: "inactivity" },
      base: appDb,
      deps: {
        makeModel: () =>
          new FakeListChatModel({ responses: ["Oi! Tudo bem?"] }),
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
        contactAuthFetch: auth.fetchImpl,
      },
    });
    expect(outcome).toBe("messaged");
    expect(auth.calls).toHaveLength(1);
    expect(s.messages).toEqual([[9403, "Oi! Tudo bem?"]]);
  });
});
