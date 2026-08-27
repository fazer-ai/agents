import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { reengageConversation } from "@/modules/conversations/reengage";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";
import { PromptCapturingModel } from "../utils/scripted-models";

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

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let agentId = 0n;

// A literal address in TEST-NET-3: the SSRF guard vets the final URL for real here, and an IP needs
// no resolver to be vetted.
const AUTH_URL = "https://203.0.113.9:9443/check";

const REPLY = "Desculpe a demora, já te ajudo!";
const fakeModel = () => new FakeListChatModel({ responses: [REPLY] });

function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// `pages` serves a DIFFERENT thread per `getMessages` call, which is how a delivery landing between
// two reads of the same conversation is told. Without it the stub is a Chatwoot frozen in time, and
// every re-read in the code under test is answered by the state it already saw.
function makeStub(opts: {
  page?: unknown;
  pages?: unknown[];
  sent: Array<[number, string]>;
}) {
  let i = 0;
  const client = {
    getMessages: async () => {
      if (!opts.pages) return opts.page;
      const p = opts.pages[Math.min(i, opts.pages.length - 1)];
      i += 1;
      return p;
    },
    sendMessage: async (conversationId: number, content: string) => {
      opts.sent.push([conversationId, content]);
      return {};
    },
    toggleTyping: async () => ({}),
  } as unknown as ChatwootClient;
  return async () => client;
}

function page(
  msgs: Array<{
    id: number;
    content: string;
    type?: number;
    private?: boolean;
  }>,
) {
  return {
    payload: msgs.map((m) => ({
      id: m.id,
      content: m.content,
      message_type: m.type ?? 0,
      private: m.private ?? false,
    })),
  };
}

async function seedConversation(
  convId: number,
  over: {
    assigneeType?: string | null;
    assigneeId?: number | null;
    lastError?: string | null;
    contactId?: bigint;
  } = {},
): Promise<bigint> {
  const c = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: over.assigneeType ?? null,
      assigneeId: over.assigneeId ?? null,
      inboxId: inboxDbId,
      ...(over.contactId ? { contactId: over.contactId } : {}),
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
      lastError: over.lastError ?? null,
      lastErrorAt: over.lastError ? new Date() : null,
    },
  });
  return c.id;
}

describe.skipIf(!dbUp)("reengage", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "RE", slug: `re-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
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
          credentialRef: `vault:${llmKey.id}`,
        },
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `re-route-${process.pid}`,
        name: "Atendente",
      },
    });
    agentId = agent.id;
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "Suporte",
        agentId: agent.id,
      },
    });
    inboxDbId = inbox.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "llm_usage",
        "conversations",
        "contacts",
        "inboxes",
        "agents",
        "vault_entries",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("re-fires the unanswered tail (incoming after last outgoing) and clears lastError", async () => {
    const id = await seedConversation(900, { lastError: "boom: timeout" });
    const sent: Array<[number, string]> = [];
    const res = await reengageConversation(
      ctx(),
      id,
      {
        makeModel: fakeModel,
        makeClient: makeStub({
          page: page([
            { id: 1, content: "oi", type: 0 },
            { id: 2, content: "resposta antiga", type: 1 }, // outgoing
            { id: 3, content: "e aí, esqueceu de mim?", type: 0 }, // unanswered
          ]),
          sent,
        }),
        checkpointer: new MemorySaver(),
      },
      appDb,
    );

    expect(res.outcome).toBe("posted");
    expect(sent).toEqual([[900, REPLY]]);
    const row = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 900 },
      select: { lastError: true, lastErrorAt: true },
    });
    expect(row.lastError).toBeNull();
    expect(row.lastErrorAt).toBeNull();
  });

  test("a human assignee closes the gate (no fetch, no post)", async () => {
    const id = await seedConversation(901, { assigneeType: "User" });
    const sent: Array<[number, string]> = [];
    const res = await reengageConversation(
      ctx(),
      id,
      {
        makeModel: fakeModel,
        makeClient: makeStub({ page: page([{ id: 1, content: "oi" }]), sent }),
        checkpointer: new MemorySaver(),
      },
      appDb,
    );
    expect(res.outcome).toBe("gate-closed");
    expect(sent).toEqual([]);
  });

  // NOTE: Our bot is 9 (beforeAll); 77 is another AgentBot on the same Chatwoot account. The
  // button was pressed on a conversation that is not ours to answer, and the gate is the only
  // thing that knows: the re-engage has no incoming payload to consult, only the mirror.
  test("another bot's conversation closes the gate (no fetch, no post)", async () => {
    const id = await seedConversation(910, {
      assigneeType: "AgentBot",
      assigneeId: 77,
    });
    const sent: Array<[number, string]> = [];
    const res = await reengageConversation(
      ctx(),
      id,
      {
        makeModel: fakeModel,
        makeClient: makeStub({ page: page([{ id: 1, content: "oi" }]), sent }),
        checkpointer: new MemorySaver(),
      },
      appDb,
    );
    expect(res.outcome).toBe("gate-closed");
    expect(sent).toEqual([]);
  });

  // NOTE: The same seat, taken by OUR bot: the gate has to stay open, or the fix would buy silence
  // rather than discrimination.
  test("our own bot holding the conversation keeps the gate open", async () => {
    const id = await seedConversation(911, {
      assigneeType: "AgentBot",
      assigneeId: 9,
    });
    const sent: Array<[number, string]> = [];
    const res = await reengageConversation(
      ctx(),
      id,
      {
        makeModel: fakeModel,
        makeClient: makeStub({ page: page([{ id: 1, content: "oi" }]), sent }),
        checkpointer: new MemorySaver(),
      },
      appDb,
    );
    expect(res.outcome).toBe("posted");
    expect(sent).toEqual([[911, REPLY]]);
  });

  test("nothing unanswered → empty (no post)", async () => {
    const id = await seedConversation(902);
    const sent: Array<[number, string]> = [];
    const res = await reengageConversation(
      ctx(),
      id,
      {
        makeModel: fakeModel,
        makeClient: makeStub({
          page: page([
            { id: 1, content: "oi", type: 0 },
            { id: 2, content: "já respondi", type: 1 }, // last message is outgoing
          ]),
          sent,
        }),
        checkpointer: new MemorySaver(),
      },
      appDb,
    );
    expect(res.outcome).toBe("empty");
    expect(sent).toEqual([]);
  });

  // A private note is the operator's team talking to itself, and Chatwoot stores it after the message
  // it is about. Counted as a reply it empties the tail, and the conversations most likely to be
  // re-engaged are exactly the ones carrying one: a failed turn, an out-of-hours notice, a refusal.
  test("a private note is not a reply, so the tail behind it is still answered", async () => {
    const id = await seedConversation(906);
    const sent: Array<[number, string]> = [];
    const res = await reengageConversation(
      ctx(),
      id,
      {
        makeModel: fakeModel,
        makeClient: makeStub({
          page: page([
            { id: 1, content: "oi, alguém aí?", type: 0 },
            {
              id: 2,
              content: "contato não autorizado",
              type: 1,
              private: true,
            },
          ]),
          sent,
        }),
        checkpointer: new MemorySaver(),
      },
      appDb,
    );
    expect(res.outcome).toBe("posted");
    expect(sent).toEqual([[906, REPLY]]);
  });

  // Re-engage runs the model and SENDS its answer, so it is a turn, and the contact-authorization
  // invariant covers it: an operator pressing the button is not the authorization. The tail this
  // answers may be unanswered precisely because the contact was refused when it arrived.
  describe("with the contact-authorization gate on", () => {
    let previousSettings: unknown = null;

    beforeAll(async () => {
      const before = await suDb.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { settings: true },
      });
      previousSettings = before.settings;
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          settings: {
            contactAuth: { enabled: true, url: AUTH_URL },
          },
        },
      });
    });

    afterAll(async () => {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: previousSettings as object },
      });
    });

    async function seedContact(chatwootContactId: number): Promise<bigint> {
      const c = await suDb.contact.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootContactId,
          phone: `+55119888877${chatwootContactId}`,
        },
        select: { id: true },
      });
      return c.id;
    }

    function answering(authorized: boolean, calls: { n: number }) {
      return (async () => {
        calls.n += 1;
        return new Response(JSON.stringify({ authorized }), { status: 200 });
      }) as unknown as typeof fetch;
    }

    test("a refused contact is not re-engaged (no model, no post)", async () => {
      const id = await seedConversation(903, {
        contactId: await seedContact(41),
      });
      const sent: Array<[number, string]> = [];
      const calls = { n: 0 };
      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: fakeModel,
          makeClient: makeStub({
            page: page([{ id: 1, content: "oi" }]),
            sent,
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: answering(false, calls),
        },
        appDb,
      );
      expect(res.outcome).toBe("not-authorized");
      expect(calls.n).toBe(1);
      expect(sent).toEqual([]);
    });

    test("an authorized contact is re-engaged as usual", async () => {
      const id = await seedConversation(904, {
        contactId: await seedContact(42),
      });
      const sent: Array<[number, string]> = [];
      const calls = { n: 0 };
      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: fakeModel,
          makeClient: makeStub({
            page: page([{ id: 1, content: "oi" }]),
            sent,
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: answering(true, calls),
        },
        appDb,
      );
      expect(res.outcome).toBe("posted");
      expect(calls.n).toBe(1);
      expect(sent).toEqual([[904, REPLY]]);
    });

    // The button re-asks the endpoint for the same reason it re-reads the mirror, so the facts it
    // volunteers are current. Asserted on the prompt the model received: the block is built
    // elsewhere, and this is what proves this path forwards the verdict it just read.
    test("an authorized contact's facts reach the model of the re-engaged turn", async () => {
      const id = await seedConversation(912, {
        contactId: await seedContact(48),
      });
      const sent: Array<[number, string]> = [];
      const model = new PromptCapturingModel(REPLY);
      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: () => model,
          makeClient: makeStub({
            page: page([{ id: 1, content: "oi" }]),
            sent,
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: (async () =>
            new Response(
              JSON.stringify({
                authorized: true,
                context: { plan: "premium" },
              }),
              { status: 200 },
            )) as unknown as typeof fetch,
        },
        appDb,
      );
      expect(res.outcome).toBe("posted");
      expect(model.systemPrompts[0] ?? "").toContain(
        '<campo chave="plan" valor="premium"/>',
      );
    });

    // A message that arrives and is REFUSED while this re-engage waits on the endpoint has already
    // had the watermark advanced past it by its own delivery. The tail here is chosen from the last
    // OUTGOING message, which a refusal never writes, so without a watermark floor that refused
    // message rides into the very turn the gate exists to prevent.
    //
    // The floor is blunt on purpose: the watermark is aggregate, so it covers the older unanswered
    // tail too and the re-engage comes back "empty". That IS the fail-closed side — what a
    // concurrent delivery consumed is not this button's to re-answer — and it applies only with the
    // gate on, so the button keeps its old reach everywhere else.
    test("a message refused during the authorization call is not re-answered", async () => {
      const id = await seedConversation(908, {
        contactId: await seedContact(45),
      });
      const sent: Array<[number, string]> = [];
      let modelBuilds = 0;
      const refusedDuringTheCall = (async () => {
        // The refused delivery's own webhook did this while we were asking.
        await suDb.conversation.update({
          where: { id },
          data: { lastHandledMessageId: 2 },
        });
        return new Response(JSON.stringify({ authorized: true }), {
          status: 200,
        });
      }) as unknown as typeof fetch;
      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: () => {
            modelBuilds += 1;
            return fakeModel();
          },
          makeClient: makeStub({
            page: page([
              { id: 1, content: "a primeira" },
              { id: 2, content: "a recusada" },
            ]),
            sent,
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: refusedDuringTheCall,
        },
        appDb,
      );
      expect(res.outcome).toBe("empty");
      expect(modelBuilds).toBe(0);
      expect(sent).toEqual([]);
    });

    // The floor only ever removes what something else handled. With nothing concurrent, the tail is
    // the tail and the button does its job — which is what stops the guard above from quietly
    // turning re-engage into a no-op wherever the gate is on.
    test("with nothing handled concurrently the tail is answered as usual", async () => {
      const id = await seedConversation(909, {
        contactId: await seedContact(46),
      });
      const sent: Array<[number, string]> = [];
      const calls = { n: 0 };
      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: fakeModel,
          makeClient: makeStub({
            page: page([
              { id: 1, content: "oi" },
              { id: 2, content: "alguém aí?" },
            ]),
            sent,
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: answering(true, calls),
        },
        appDb,
      );
      expect(res.outcome).toBe("posted");
      expect(calls.n).toBe(1);
      expect(sent).toEqual([[909, REPLY]]);
    });

    // The assignee gate runs before the authorization round-trip, which has a ten-second ceiling. A
    // human arriving inside it used to get the turn run on their conversation: the post gate holds
    // the reply back, and by then the tools have written.
    test("a human taking over during the authorization call closes the gate", async () => {
      const id = await seedConversation(907, {
        contactId: await seedContact(44),
      });
      const sent: Array<[number, string]> = [];
      let modelBuilds = 0;
      const takeOverThenAllow = (async () => {
        await suDb.conversation.update({
          where: { id },
          data: { assigneeType: "User", status: "open" },
        });
        return new Response(JSON.stringify({ authorized: true }), {
          status: 200,
        });
      }) as unknown as typeof fetch;
      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: () => {
            modelBuilds += 1;
            return fakeModel();
          },
          makeClient: makeStub({
            page: page([{ id: 1, content: "oi" }]),
            sent,
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: takeOverThenAllow,
        },
        appDb,
      );
      // "gate-closed", not "not-authorized": the endpoint DID clear the contact, and what stopped
      // the turn is the same thing the early check reports.
      expect(res.outcome).toBe("gate-closed");
      expect(modelBuilds).toBe(0);
      expect(sent).toEqual([]);
    });

    // Nothing to ask the endpoint about is not a pass: the mirror holds no phone, no e-mail and no
    // identifier, so the request is never made and the answer is a refusal.
    test("a contact with no identity is refused without asking", async () => {
      const id = await seedConversation(905);
      const sent: Array<[number, string]> = [];
      const calls = { n: 0 };
      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: fakeModel,
          makeClient: makeStub({
            page: page([{ id: 1, content: "oi" }]),
            sent,
          }),
          checkpointer: new MemorySaver(),
          contactAuthFetch: answering(true, calls),
        },
        appDb,
      );
      expect(res.outcome).toBe("not-authorized");
      expect(calls.n).toBe(0);
      expect(sent).toEqual([]);
    });
  });

  // The re-engage button is a billed call like any other, and nothing above it in this path is
  // (issue #146). Unlike the customer-facing seams it REPORTS rather than going quiet: an operator
  // is looking at the button, and the reason is one they can act on from the settings page.
  describe("with the spend ceiling reached", () => {
    let previousTenantSettings: unknown = null;

    beforeAll(async () => {
      const before = await suDb.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { settings: true },
      });
      previousTenantSettings = before.settings;
      await suDb.tenant.update({
        where: { id: tenantId },
        data: {
          settings: {
            ...(before.settings as object),
            spendCeiling: { enabled: true, monthlyInboxTokens: 1000 },
          },
        },
      });
      await suDb.llmUsage.create({
        data: {
          tenantId,
          model: "gpt-4o-mini",
          source: "inbox",
          promptTokens: 1200,
          completionTokens: 0,
        },
      });
    });

    afterAll(async () => {
      await suDb.llmUsage.deleteMany({ where: { tenantId } });
      await suDb.tenant.update({
        where: { id: tenantId },
        data: { settings: previousTenantSettings as object },
      });
    });

    test("the button reports the ceiling instead of spending a turn", async () => {
      const id = await seedConversation(920);
      const sent: Array<[number, string]> = [];
      const res = await reengageConversation(
        ctx(),
        id,
        {
          // The assertion is the factory: a re-engage that reaches the model at all fails here.
          makeModel: () => {
            throw new Error("the model must not be invoked over the ceiling");
          },
          makeClient: makeStub({
            page: page([{ id: 1, content: "oi" }]),
            sent,
          }),
          checkpointer: new MemorySaver(),
        },
        appDb,
      );
      expect(res.outcome).toBe("over-ceiling");
      expect(sent).toEqual([]);
    });

    // A CLICK WITH NOTHING TO ANSWER WAS NEVER A TURN, so the ceiling has nothing to refuse. The
    // button reporting a spent budget here tells the operator to raise a number that would change
    // nothing, and writes an `error` line saying a turn was skipped when none was ever going to run.
    // THE SAME QUESTION, ASKED AGAIN WHERE THE ANSWER IS USED. The pre-fetch above proves there was
    // a tail; the verdict underneath it is two database reads deep, and the conversation is live the
    // whole time. A delivery that answers the tail inside that window leaves this click nothing to
    // run, so a refusal would tell the operator to raise a ceiling for work that no longer exists.
    test("a tail answered while the ceiling was being read is empty, not refused", async () => {
      const id = await seedConversation(923);
      const sent: Array<[number, string]> = [];
      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: () => {
            throw new Error("the model must not be invoked");
          },
          makeClient: makeStub({
            pages: [
              // The pre-fetch sees an unanswered tail...
              page([{ id: 1, content: "oi", type: 0 }]),
              // ...and by the re-read another delivery has answered it.
              page([
                { id: 1, content: "oi", type: 0 },
                { id: 2, content: "já respondi", type: 1 },
              ]),
            ],
            sent,
          }),
          checkpointer: new MemorySaver(),
        },
        appDb,
      );
      expect(res.outcome).toBe("empty");
      expect(sent).toEqual([]);
      await settleFlowEvents();
      const rows = await flowLogRows(suDb, {
        where: {
          tenantId,
          threadId: `${tenantId}:${instanceId}:923`,
          stage: "spend_ceiling",
        },
        select: { level: true },
      });
      expect(rows).toEqual([]);
    });

    test("with nothing unanswered the button says so, not that the budget stopped it", async () => {
      const id = await seedConversation(922);
      const sent: Array<[number, string]> = [];
      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: () => {
            throw new Error("the model must not be invoked");
          },
          makeClient: makeStub({
            page: page([
              { id: 1, content: "oi", type: 0 },
              { id: 2, content: "já respondi", type: 1 },
            ]),
            sent,
          }),
          checkpointer: new MemorySaver(),
        },
        appDb,
      );
      expect(res.outcome).toBe("empty");
      expect(sent).toEqual([]);
      // ...and no refusal on the record, because nothing was refused.
      await settleFlowEvents();
      const rows = await flowLogRows(suDb, {
        where: {
          tenantId,
          threadId: `${tenantId}:${instanceId}:922`,
          stage: "spend_ceiling",
        },
        select: { level: true },
      });
      expect(rows).toEqual([]);
    });

    test("under the ceiling the button still answers", async () => {
      await suDb.tenant.update({
        where: { id: tenantId },
        data: {
          settings: {
            ...(previousTenantSettings as object),
            spendCeiling: { enabled: true, monthlyInboxTokens: 1_000_000 },
          },
        },
      });
      const id = await seedConversation(921);
      const sent: Array<[number, string]> = [];
      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: fakeModel,
          makeClient: makeStub({
            page: page([{ id: 1, content: "oi" }]),
            sent,
          }),
          checkpointer: new MemorySaver(),
        },
        appDb,
      );
      expect(res.outcome).toBe("posted");
      expect(sent.length).toBe(1);
    });
  });
});
