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
import { countingBase } from "../utils/counting-base";
import { PromptCapturingModel } from "../utils/scripted-models";

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

// Same shape as stub(), plus the two calls applyPostActions makes — without them the label write
// would land in its own try/catch and read as "nothing was written".
function labelStub() {
  const labelWrites: Array<[number, string[]]> = [];
  const base = stub();
  const client = {
    ...(base.client as unknown as Record<string, unknown>),
    getConversationLabels: async () => [] as string[],
    setConversationLabels: async (c: number, l: string[]) => {
      labelWrites.push([c, l]);
      return {};
    },
  } as unknown as ChatwootClient;
  return { client, labelWrites, makeClient: async () => client };
}

function authFetch(response: () => Response) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return response();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function seedConv(convId: number, contactInboxId: number | null = null) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbId,
      chatwootConversationId: convId,
      contactId,
      contactInboxId,
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

  // The ALLOWED path, and the window this gate opened for every run that passes it. The
  // authorization request is a round-trip to somebody else's endpoint with a ten-second ceiling, and
  // it sits between the run's entry check and the moment the thread is claimed — so a /reset landing
  // inside it used to be followed by this run writing the attendance marker, the divider and the
  // turn itself back onto a thread the command had just cleared. Nothing reaches the customer (the
  // post-generation check stops that), which is exactly what made it invisible: the operator is told
  // the conversation was cleared and the agent goes on answering from the memory it recreated.
  //
  // The ask that stops it is inside the `ingest:` lock, the one position where the answer cannot
  // decay before the write, because the command's own clear needs the same lock.
  test("a /reset during the authorization call leaves the thread untouched", async () => {
    const CIB = 7791;
    await seedConv(9413, CIB);
    const s = labelStub();
    let wanted = true;
    const auth = authFetch(() => {
      // Retired while the endpoint was being asked — and ALLOWED, so nothing else stops the run.
      wanted = false;
      return new Response('{"authorized":true}', { status: 200 });
    });
    // Recorded per ask, and what is recorded is how many Prisma transactions are OPEN at that moment.
    // The ask made inside the thread claim used to have to arrive WITH a connection, because the
    // claim was one long advisory-lock transaction and a provider opening its own there asked a
    // pinned pool for a second one, which fails under `DB_POOL_MAX=1` — and jobRetired swallows a
    // failed read as "not retired", so the fence went quiet exactly where it mattered. The claim
    // holds no transaction any more (issue #225), so the invariant that replaces it is the stronger
    // one: the ask is free to open its own scope precisely because nothing is pinned.
    const openTxAtAsk: number[] = [];
    const strictness: boolean[] = [];
    const counted = countingBase(appDb);
    const outcome = await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:9413`,
      nudge: { source: "followup", kind: "inactivity" },
      postActions: { assignLabels: ["seguimento"] },
      stillWanted: async ({ strict }) => {
        openTxAtAsk.push(counted.open());
        strictness.push(strict);
        return wanted;
      },
      base: counted.base,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: ["Tudo certo?"] }),
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
        contactAuthFetch: auth.fetchImpl,
      },
    });

    expect(outcome).toBe("stale");
    expect(auth.calls).toHaveLength(1);
    // Asked at both moments it has to be: on entry, and again inside the thread claim, which is what
    // makes it exclusive with a /reset. And no ask, the claim's included, finds a transaction open.
    expect(openTxAtAsk.length).toBeGreaterThanOrEqual(2);
    expect(openTxAtAsk.filter((n) => n !== 0)).toEqual([]);
    // EXACTLY ONE of them asks strictly, and it is not the entry one. The two want opposite answers
    // when the read itself fails: before the write an unreadable answer has to stop the run, and
    // around a send it must not, because throwing there abandons the bookkeeping of a message the
    // customer already has.
    expect(strictness[0]).toBe(false);
    expect(strictness.filter(Boolean)).toHaveLength(1);
    // The durable half: had the run gone on, this row would name the conversation the reset cleared.
    const row = await suDb.agentThread.findUnique({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: CIB,
        },
      },
    });
    expect(row).toBeNull();
    expect(s.labelWrites).toEqual([]);
  });

  // The control: the same allowed turn, nothing retired, and the marker IS written.
  test("the same allowed turn does claim the thread when nothing retires it", async () => {
    const CIB = 7792;
    await seedConv(9414, CIB);
    const s = labelStub();
    const auth = authFetch(
      () => new Response('{"authorized":true}', { status: 200 }),
    );
    await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:9414`,
      nudge: { source: "followup", kind: "inactivity" },
      base: appDb,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: ["Tudo certo?"] }),
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
        contactAuthFetch: auth.fetchImpl,
      },
    });

    const row = await suDb.agentThread.findUnique({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: CIB,
        },
      },
    });
    expect(row?.lastConversationId).toBe(9414);
  });

  // The gate's refusal is a WRITING end: it skips the model but still applies the operator's
  // deterministic post-actions. And it reaches them after a round-trip to somebody else's endpoint
  // with a ten-second ceiling, which is exactly the window a /reset lands in. The rendezvous is the
  // authorization call itself, because that is the position the wait occupies in production.
  test("a /reset during the authorization call stops the refusal's post-actions", async () => {
    await seedConv(9411);
    const s = labelStub();
    let wanted = true;
    const auth = authFetch(() => {
      // Retired while the endpoint was being asked.
      wanted = false;
      return new Response('{"authorized":false}', { status: 200 });
    });
    const outcome = await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:9411`,
      nudge: { source: "followup", kind: "inactivity" },
      postActions: { assignLabels: ["seguimento"] },
      stillWanted: async () => wanted,
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
    // "stale", not "silent": the follow-up handler must not stamp the watermark or advance the
    // ladder for a step the reset called off.
    expect(outcome).toBe("stale");
    expect(auth.calls).toHaveLength(1);
    expect(s.labelWrites).toEqual([]);
  });

  // The control, without which the assertion above only proves the refusal writes nothing ever.
  test("the same refusal DOES apply the post-actions when nothing retired it", async () => {
    await seedConv(9412);
    const s = labelStub();
    const auth = authFetch(
      () => new Response('{"authorized":false}', { status: 200 }),
    );
    const outcome = await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:9412`,
      nudge: { source: "followup", kind: "inactivity" },
      postActions: { assignLabels: ["seguimento"] },
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
    expect(s.labelWrites).toEqual([[9412, ["seguimento"]]]);
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

  // A proactive turn benefits from the endpoint's facts the same way a reactive one does, and the
  // check that produced them is the one that just allowed this send. Asserted on the prompt the
  // model received: this path builds its own graph rather than going through runLoadedTurn, so it
  // is the one place a block wired only into the reactive tail would silently be missing.
  test("an authorized contact's facts reach the model of the nudge", async () => {
    await seedConv(9406);
    const s = stub();
    const auth = authFetch(
      () =>
        new Response(
          JSON.stringify({ authorized: true, context: { plan: "premium" } }),
          { status: 200 },
        ),
    );
    const model = new PromptCapturingModel("Oi! Tudo bem?");
    const outcome = await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:9406`,
      nudge: { source: "followup", kind: "inactivity" },
      base: appDb,
      deps: {
        makeModel: () => model,
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
        contactAuthFetch: auth.fetchImpl,
      },
    });
    expect(outcome).toBe("messaged");
    expect(model.systemPrompts[0] ?? "").toContain(
      '<campo chave="plan" valor="premium"/>',
    );
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
