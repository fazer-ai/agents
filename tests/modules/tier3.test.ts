import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import {
  getKpis,
  getTimeseries,
  normalizeTimeZone,
} from "@/modules/analytics/service";
import { listAudit, recordAudit } from "@/modules/audit/service";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  bindInbox,
  getChatwootDeployment,
  getChatwootInstance,
  listAgentsAndTeams,
  listInboxes,
  reconcileInboxBots,
  syncInboxes,
} from "@/modules/chatwoot/management";
import {
  getConversationDetail,
  getConversationMedia,
  getConversationMessages,
  handoffConversation,
  replyToConversation,
  returnConversationToAgent,
} from "@/modules/conversations/service";
import { listQuotes, revokeQuote } from "@/modules/quotes/service";
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

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

// Stub ChatwootClient recording the calls the ops make (no network).
function makeStub() {
  const calls = {
    getMessages: 0,
    sendMessage: [] as { content: string; isPrivate: boolean }[],
    assignToAgent: [] as number[],
    unassignConversation: 0,
    toggleStatus: [] as string[],
    downloadAttachment: [] as string[],
  };
  const client = {
    getMessages: async () => {
      calls.getMessages += 1;
      return {
        payload: [
          {
            id: 1,
            content: "hello there",
            message_type: 0,
            private: false,
            created_at: 111,
            sender: { name: "Customer", type: "contact" },
          },
          {
            id: 2,
            content: "",
            message_type: 0,
            private: false,
            created_at: 112,
            sender: { name: "Customer", type: "contact" },
            attachments: [
              {
                id: 9,
                file_type: "audio",
                data_url: "https://chat.example.com/rails/a.ogg",
                transcribed_text: "oi, tudo bem?",
              },
            ],
          },
        ],
      };
    },
    downloadAttachment: async (url: string) => {
      calls.downloadAttachment.push(url);
      return { bytes: new ArrayBuffer(4), contentType: "audio/ogg" };
    },
    sendMessage: async (
      _cid: number,
      content: string,
      opts: { private?: boolean } = {},
    ) => {
      calls.sendMessage.push({ content, isPrivate: opts.private ?? false });
      return {};
    },
    assignToAgent: async (_cid: number, assigneeId: number) => {
      calls.assignToAgent.push(assigneeId);
      return {};
    },
    unassignConversation: async (_cid: number) => {
      calls.unassignConversation += 1;
      return {};
    },
    toggleStatus: async (_cid: number, status: string) => {
      calls.toggleStatus.push(status);
      return {};
    },
  };
  return {
    calls,
    makeClient: async () => client as unknown as ChatwootClient,
  };
}

// Stub for the network-aware bindInbox: records the lazy createAgentBot + each set_agent_bot call
// (botId on connect, null on disconnect). createAgentBot returns a fixed bot 77.
function makeBindStub() {
  const calls = {
    createAgentBot: 0,
    setInbox: [] as Array<[number, number | null]>,
  };
  const client = {
    createAgentBot: async () => {
      calls.createAgentBot += 1;
      return { id: 77, access_token: "tok-77", secret: "sec-77" };
    },
    setInboxAgentBot: async (inboxId: number, botId: number | null) => {
      calls.setInbox.push([inboxId, botId]);
      return {};
    },
  };
  return {
    calls,
    makeClient: async () => client as unknown as ChatwootClient,
  };
}

describe.skipIf(!dbUp)("tier-3 chatwoot management + inbox binding", () => {
  let tenant = 0n;
  let other = 0n;
  let instanceId = 0n;
  let otherAgentId = 0n;

  beforeAll(async () => {
    tenant = (
      await suDb.tenant.create({
        data: { name: "T3A", slug: `t3a-${process.pid}` },
      })
    ).id;
    other = (
      await suDb.tenant.create({
        data: { name: "T3O", slug: `t3o-${process.pid}` },
      })
    ).id;
    otherAgentId = (
      await suDb.agent.create({
        data: { tenantId: other, name: "OtherAgent", systemPrompt: "x" },
      })
    ).id;
  });

  afterAll(async () => {
    for (const tid of [tenant, other]) {
      if (!tid) continue;
      for (const tbl of [
        "inboxes",
        "agents",
        "chatwoot_instances",
        "chatwoot_deployments",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
  });

  test("deployment masks the token; account DTO exposes only presence flags", async () => {
    const inst = await seedChatwootInstance(suDb, {
      tenantId: tenant,
      baseUrl: "https://203.0.113.10",
      accountId: 42,
      adminToken: encryptJson("admintok"),
    });
    instanceId = BigInt(inst.id);
    const { deployment, accounts } = await getChatwootDeployment(
      ctx(tenant),
      appDb,
    );
    expect(deployment?.hasAdminToken).toBe(true);
    // neither the deployment nor the account DTOs ever carry the raw token
    expect(JSON.stringify({ deployment, accounts })).not.toContain("admintok");
    const got = await getChatwootInstance(ctx(tenant), instanceId, appDb);
    expect(got.accountId).toBe(42);
  });

  test("binding provisions+connects the bot; cross-tenant agent rejected; unbind disconnects", async () => {
    const inbox = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "WhatsApp",
      },
    });
    const agent = await suDb.agent.create({
      data: { tenantId: tenant, name: "Sales", systemPrompt: "x" },
    });
    const stub = makeBindStub();

    // none → agent: lazily provisions the instance bot and connects it to this inbox on Chatwoot.
    const bound = await bindInbox(
      ctx(tenant),
      inbox.id,
      agent.id,
      { makeClient: stub.makeClient },
      appDb,
    );
    expect(bound.agentId).toBe(String(agent.id));
    expect(stub.calls.createAgentBot).toBe(1);
    expect(stub.calls.setInbox).toEqual([[7, 77]]);
    // the persona's bot is now persisted (lazy provisioning ran)
    const persisted = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { chatwootInstanceId: instanceId, agentId: agent.id },
    });
    expect(persisted.chatwootAgentBotId).toBe(77);

    // cross-tenant agent → rejected BEFORE any network (no extra bot/connect calls)
    expect(
      bindInbox(
        ctx(tenant),
        inbox.id,
        otherAgentId,
        { makeClient: stub.makeClient },
        appDb,
      ),
    ).rejects.toThrow();

    // agent → none: disconnects the bot from this inbox (agent_bot: null), no new bot created.
    const detached = await bindInbox(
      ctx(tenant),
      inbox.id,
      null,
      { makeClient: stub.makeClient },
      appDb,
    );
    expect(detached.agentId).toBeNull();
    expect(stub.calls.createAgentBot).toBe(1);
    expect(stub.calls.setInbox).toEqual([
      [7, 77],
      [7, null],
    ]);
    expect(await listInboxes(ctx(tenant), appDb)).toHaveLength(1);
  });

  test("syncInboxes upserts the mirror and PRESERVES the agent binding", async () => {
    // Bind the existing inbox 7 (left detached by the prior test) so we can prove
    // sync refreshes its name without clearing the local binding.
    const agent = await suDb.agent.create({
      data: { tenantId: tenant, name: "SyncAgent", systemPrompt: "x" },
    });
    const inbox7 = await suDb.inbox.findFirstOrThrow({
      where: { tenantId: tenant, chatwootInboxId: 7 },
      select: { id: true },
    });
    await bindInbox(
      ctx(tenant),
      inbox7.id,
      agent.id,
      { makeClient: makeBindStub().makeClient },
      appDb,
    );

    // Stub the admin-token GET /inboxes (the live shape: { payload: [...] }).
    const stub = {
      listInboxes: async () => ({
        payload: [
          { id: 7, name: "WhatsApp Renamed", channel_type: "Channel::Api" },
          { id: 8, name: "Site Widget", channel_type: "Channel::WebWidget" },
        ],
      }),
    };
    const result = await syncInboxes(
      ctx(tenant),
      instanceId,
      { makeClient: async () => stub as unknown as ChatwootClient },
      appDb,
    );
    expect(result).toEqual({ total: 2, created: 1, updated: 1 });

    const inboxes = await listInboxes(ctx(tenant), appDb);
    const by = new Map(inboxes.map((i) => [i.chatwootInboxId, i]));
    // existing inbox updated in place, binding preserved
    expect(by.get(7)?.name).toBe("WhatsApp Renamed");
    expect(by.get(7)?.agentId).toBe(String(agent.id));
    // new inbox created, unbound
    expect(by.get(8)?.name).toBe("Site Widget");
    expect(by.get(8)?.channelType).toBe("Channel::WebWidget");
    expect(by.get(8)?.agentId).toBeNull();
  });

  test("reconcileInboxBots flags a bound inbox whose persona bot is gone on Chatwoot", async () => {
    const agentLive = await suDb.agent.create({
      data: { tenantId: tenant, name: "Live", systemPrompt: "x" },
    });
    const agentGone = await suDb.agent.create({
      data: { tenantId: tenant, name: "Gone", systemPrompt: "x" },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        agentId: agentLive.id,
        chatwootAgentBotId: 100,
        accessToken: encryptJson("t"),
        webhookSecret: encryptJson("s"),
        webhookRouteTokenHash: `rec-live-${process.pid}`,
        name: "Live",
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        agentId: agentGone.id,
        chatwootAgentBotId: 200,
        accessToken: encryptJson("t"),
        webhookSecret: encryptJson("s"),
        webhookRouteTokenHash: `rec-gone-${process.pid}`,
        name: "Gone",
      },
    });
    const inboxLive = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 20,
        name: "Live inbox",
        agentId: agentLive.id,
      },
    });
    const inboxGone = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 21,
        name: "Gone inbox",
        agentId: agentGone.id,
      },
    });
    // Only bot 100 is live on Chatwoot; 200 was deleted out-of-band.
    const stub = { listAgentBots: async () => [{ id: 100, name: "Live" }] };
    const statuses = await reconcileInboxBots(
      ctx(tenant),
      { makeClient: async () => stub as unknown as ChatwootClient },
      appDb,
    );
    expect(statuses[String(inboxLive.id)]).toBe("active");
    expect(statuses[String(inboxGone.id)]).toBe("missing");
  });

  test("listAgentsAndTeams is agent-scoped: lists only for a single-account agent", async () => {
    const stub = {
      listAgents: async () => [{ id: 9, name: "Maria" }],
      listTeams: async () => [{ id: 3, name: "Suporte" }],
    };
    const makeClient = async () => stub as unknown as ChatwootClient;

    // No bound inbox → no accounts, empty lists (the client is never loaded).
    const lonely = await suDb.agent.create({
      data: { tenantId: tenant, name: "Lonely", systemPrompt: "x" },
    });
    const r0 = await listAgentsAndTeams(
      ctx(tenant),
      lonely.id,
      { makeClient },
      appDb,
    );
    expect(r0.accounts).toHaveLength(0);
    expect(r0.agents).toHaveLength(0);

    // Two inboxes in the SAME account → one account, agents/teams populated.
    const single = await suDb.agent.create({
      data: { tenantId: tenant, name: "Single", systemPrompt: "x" },
    });
    for (const cw of [101, 102]) {
      await suDb.inbox.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instanceId,
          chatwootInboxId: cw,
          name: `i${cw}`,
          agentId: single.id,
        },
      });
    }
    const r1 = await listAgentsAndTeams(
      ctx(tenant),
      single.id,
      { makeClient },
      appDb,
    );
    expect(r1.accounts).toHaveLength(1);
    expect(r1.agents.map((a) => a.name)).toEqual(["Maria"]);
    expect(r1.teams.map((tm) => tm.name)).toEqual(["Suporte"]);

    // Inboxes across TWO accounts → ambiguous: empty lists, both accounts reported. Both accounts
    // share the tenant's single deployment (seedChatwootInstance upserts it).
    const inst2 = await seedChatwootInstance(suDb, {
      tenantId: tenant,
      baseUrl: "https://203.0.113.20",
      accountId: 43,
      accountName: "Conta B",
      adminToken: encryptJson("t"),
    });
    const multi = await suDb.agent.create({
      data: { tenantId: tenant, name: "Multi", systemPrompt: "x" },
    });
    await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 201,
        name: "a",
        agentId: multi.id,
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst2.id,
        chatwootInboxId: 202,
        name: "b",
        agentId: multi.id,
      },
    });
    const r2 = await listAgentsAndTeams(
      ctx(tenant),
      multi.id,
      { makeClient },
      appDb,
    );
    expect(r2.accounts).toHaveLength(2);
    expect(r2.agents).toHaveLength(0);
    expect(r2.teams).toHaveLength(0);
  });
});

describe.skipIf(!dbUp)("tier-3 conversation ops (stub client)", () => {
  let tenant = 0n;
  let instanceId = 0n;
  let convId = 0n;

  beforeAll(async () => {
    tenant = (
      await suDb.tenant.create({
        data: { name: "T3C", slug: `t3c-${process.pid}` },
      })
    ).id;
    instanceId = (
      await seedChatwootInstance(suDb, {
        tenantId: tenant,
        baseUrl: "https://203.0.113.10",
        accountId: 99,
        adminToken: encryptJson("admintok"),
      })
    ).id;
    convId = (
      await suDb.conversation.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instanceId,
          chatwootConversationId: 500,
          status: "pending",
          threadId: `${tenant}:${instanceId}:500`,
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!tenant) return;
    for (const tbl of [
      "conversations",
      "chatwoot_instances",
      "chatwoot_deployments",
    ]) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM ${tbl} WHERE tenant_id = ${tenant}`,
      );
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenant}`);
  });

  test("detail returns the metadata shell with NO network call", async () => {
    const stub = makeStub();
    const detail = await getConversationDetail(ctx(tenant), convId, appDb);
    // metadata-only: the thread is a separate fetch, so getMessages is NOT called here.
    expect(stub.calls.getMessages).toBe(0);
    expect(detail.chatwootConversationId).toBe(500);
    expect(detail.status).toBe("pending");
    expect(detail).not.toHaveProperty("messages");
  });

  test("messages fetches + normalizes the thread on demand", async () => {
    const stub = makeStub();
    const thread = await getConversationMessages(
      ctx(tenant),
      convId,
      { makeClient: stub.makeClient },
      appDb,
    );
    expect(stub.calls.getMessages).toBe(1);
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0]?.content).toBe("hello there");
    expect(thread.messages[0]?.senderType).toBe("contact");
    expect(thread.messages[0]?.attachments).toEqual([]);
    // The voice note: the attachment + its STT transcription propagate from the payload.
    expect(thread.messages[1]?.attachments).toHaveLength(1);
    expect(thread.messages[1]?.attachments[0]).toMatchObject({
      fileType: "audio",
      dataUrl: "https://chat.example.com/rails/a.ogg",
      transcribedText: "oi, tudo bem?",
    });
    expect(thread.messagesUnavailable).toBe(false);
    // A short (2-message) page is below the fork's page size → no older history → button hidden.
    expect(thread.hasMoreOlder).toBe(false);
  });

  test("hasMoreOlder is true when the fork returns a full page (older history likely)", async () => {
    const stub = makeStub();
    // A full page (20 rows) is the signal that older messages may exist before it.
    stub.makeClient = async () =>
      ({
        getMessages: async () => ({
          payload: Array.from({ length: 20 }, (_, i) => ({
            id: i + 1,
            content: `m${i + 1}`,
            message_type: 0,
            private: false,
            created_at: 100 + i,
          })),
        }),
      }) as unknown as ChatwootClient;
    const thread = await getConversationMessages(
      ctx(tenant),
      convId,
      { makeClient: stub.makeClient },
      appDb,
    );
    expect(thread.hasMoreOlder).toBe(true);
  });

  test("media proxies a same-origin attachment, refuses a foreign origin", async () => {
    const stub = makeStub();
    // The instance baseUrl is https://203.0.113.10 → a same-origin attachment url proxies through.
    const blob = await getConversationMedia(
      ctx(tenant),
      convId,
      "https://203.0.113.10/rails/a.ogg",
      { makeClient: stub.makeClient },
      appDb,
    );
    expect(blob?.contentType).toBe("audio/ogg");
    expect(stub.calls.downloadAttachment).toEqual([
      "https://203.0.113.10/rails/a.ogg",
    ]);
    // A different origin is refused (never an open proxy) without ever calling the client.
    const foreign = makeStub();
    await expect(
      getConversationMedia(
        ctx(tenant),
        convId,
        "https://evil.example.net/x.ogg",
        { makeClient: foreign.makeClient },
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(foreign.calls.downloadAttachment).toEqual([]);
  });

  test("messages degrade gracefully when the live thread fetch fails", async () => {
    // A slow/unreachable Chatwoot (the live timeout the operator hit) must NOT 500: the thread comes
    // back empty with messagesUnavailable=true so the UI shows a retry in the messages area only.
    const thread = await getConversationMessages(
      ctx(tenant),
      convId,
      {
        makeClient: async () =>
          ({
            getMessages: async () => {
              throw new Error("The operation timed out.");
            },
          }) as unknown as ChatwootClient,
      },
      appDb,
    );
    expect(thread.messagesUnavailable).toBe(true);
    expect(thread.messages).toEqual([]);
  });

  test("reply sends a message via the client", async () => {
    const stub = makeStub();
    await replyToConversation(
      ctx(tenant),
      convId,
      "thanks!",
      false,
      { makeClient: stub.makeClient },
      appDb,
    );
    expect(stub.calls.sendMessage).toEqual([
      { content: "thanks!", isPrivate: false },
    ]);
  });

  test("handoff assigns + opens + updates the mirror", async () => {
    const stub = makeStub();
    await handoffConversation(
      ctx(tenant),
      convId,
      7,
      { makeClient: stub.makeClient },
      appDb,
    );
    expect(stub.calls.assignToAgent).toEqual([7]);
    expect(stub.calls.toggleStatus).toEqual(["open"]);
    const row = await suDb.conversation.findUnique({
      where: { id: convId },
      select: { status: true, assigneeType: true, assigneeId: true },
    });
    expect(row?.status).toBe("open");
    expect(row?.assigneeType).toBe("User");
    expect(row?.assigneeId).toBe(7);
  });

  test("return sets pending + clears assignee in the mirror", async () => {
    const stub = makeStub();
    await returnConversationToAgent(
      ctx(tenant),
      convId,
      { makeClient: stub.makeClient },
      appDb,
    );
    expect(stub.calls.unassignConversation).toBe(1);
    expect(stub.calls.toggleStatus).toEqual(["pending"]);
    const row = await suDb.conversation.findUnique({
      where: { id: convId },
      select: { status: true, assigneeType: true },
    });
    expect(row?.status).toBe("pending");
    expect(row?.assigneeType).toBeNull();
  });
});

describe.skipIf(!dbUp)(
  "tier-3 analytics KPIs/timeseries + quotes + audit",
  () => {
    let tenant = 0n;
    let instanceId = 0n;

    beforeAll(async () => {
      tenant = (
        await suDb.tenant.create({
          data: { name: "T3M", slug: `t3m-${process.pid}` },
        })
      ).id;
      instanceId = (
        await seedChatwootInstance(suDb, {
          tenantId: tenant,
          baseUrl: "https://203.0.113.10",
          accountId: 77,
          adminToken: encryptJson("x"),
        })
      ).id;
      // one bot-resolved conversation + its usage row → involved=1, resolvedByBot=1
      const conv = await suDb.conversation.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instanceId,
          chatwootConversationId: 1,
          status: "resolved",
          assigneeType: "AgentBot",
          // The fixture means "the bot handled it and closed it", which since issue #188 has to be
          // RECORDED rather than inferred from status + assignee — that inference also matched a
          // follow-up closing out a lead that never answered, and Chatwoot resolving on inactivity.
          resolvedBy: "agent",
          threadId: `${tenant}:${instanceId}:1`,
        },
      });
      await suDb.llmUsage.create({
        data: {
          tenantId: tenant,
          conversationId: conv.id,
          model: "gpt-4o-mini",
          promptTokens: 10,
          completionTokens: 5,
        },
      });
      await suDb.quote.create({
        data: {
          tenantId: tenant,
          idempotencyKey: "k1",
          status: "READY",
          snapshot: { title: "Orçamento", currency: "BRL" },
        },
      });
    });

    afterAll(async () => {
      if (!tenant) return;
      for (const tbl of [
        "llm_usage",
        "conversations",
        "chatwoot_instances",
        "quotes",
        "audit_logs",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tenant}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenant}`);
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("KPIs: involvement/resolution/automation from local data", async () => {
      const kpis = await getKpis(ctx(tenant), {}, appDb);
      expect(kpis.totalConversations).toBe(1);
      expect(kpis.involved).toBe(1);
      expect(kpis.resolvedByBot).toBe(1);
      expect(kpis.resolvedBeforeTracking).toBe(0);
      expect(kpis.involvementRate).toBe(1);
      expect(kpis.resolutionRate).toBe(1);
      expect(kpis.automationRate).toBe(1);
    });

    test("timeseries returns a daily cost bucket", async () => {
      const points = await getTimeseries(ctx(tenant), {}, appDb);
      expect(points.length).toBeGreaterThanOrEqual(1);
      const total = points.reduce((a, p) => a + p.calls, 0);
      expect(total).toBeGreaterThanOrEqual(1);
      // The single usage row is tied to one conversation → distinct-conversation count is 1.
      const convs = points.reduce((a, p) => a + p.conversations, 0);
      expect(convs).toBe(1);
    });

    test("quotes list + revoke", async () => {
      const list = await listQuotes(ctx(tenant), {}, appDb);
      expect(list).toHaveLength(1);
      expect(list[0]?.title).toBe("Orçamento");
      await revokeQuote(ctx(tenant), BigInt(list[0]?.id as string), appDb);
      const after = await listQuotes(ctx(tenant), {}, appDb);
      expect(after[0]?.revoked).toBe(true);
    });

    test("audit: record then list (RLS-scoped)", async () => {
      await runScopedOn(appDb, ctx(tenant), (db: ScopedDb) =>
        recordAudit(db, tenant, { action: "test.action", target: "thing" }),
      );
      const entries = await listAudit(ctx(tenant), {}, appDb);
      expect(entries.some((e) => e.action === "test.action")).toBe(true);
    });
  },
);

describe("normalizeTimeZone", () => {
  test("keeps a valid IANA zone, falls back to UTC otherwise", () => {
    expect(normalizeTimeZone("America/Sao_Paulo")).toBe("America/Sao_Paulo");
    expect(normalizeTimeZone(undefined)).toBe("UTC");
    expect(normalizeTimeZone("")).toBe("UTC");
    expect(normalizeTimeZone("Not/AZone")).toBe("UTC");
  });
});

// The recurring "21h BRT shows usage on tomorrow (00h UTC)" bug: a turn at 23h local (02h UTC the
// next day) must bucket on the LOCAL day, not the UTC day. Proven by querying the same row in two
// zones and asserting the day key shifts.
describe.skipIf(!dbUp)("timeseries day bucketing respects timezone", () => {
  let tenant = 0n;

  beforeAll(async () => {
    tenant = (
      await suDb.tenant.create({
        data: { name: "TZ", slug: `tz-${process.pid}` },
      })
    ).id;
    // 2026-06-19T02:00:00Z === 2026-06-18 23:00 in America/Sao_Paulo (UTC-3, no DST).
    await suDb.llmUsage.create({
      data: {
        tenantId: tenant,
        model: "gpt-4o-mini",
        promptTokens: 1,
        createdAt: new Date("2026-06-19T02:00:00.000Z"),
      },
    });
  });

  afterAll(async () => {
    if (!tenant) return;
    await suDb.$executeRawUnsafe(
      `DELETE FROM llm_usage WHERE tenant_id = ${tenant}`,
    );
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenant}`);
  });

  test("UTC buckets on 06-19; America/Sao_Paulo buckets on 06-18", async () => {
    const utc = await getTimeseries(ctx(tenant), { tz: "UTC" }, appDb);
    expect(utc).toHaveLength(1);
    expect(utc[0]?.bucket).toBe("2026-06-19");

    const brt = await getTimeseries(
      ctx(tenant),
      { tz: "America/Sao_Paulo" },
      appDb,
    );
    expect(brt).toHaveLength(1);
    expect(brt[0]?.bucket).toBe("2026-06-18");
  });
});
