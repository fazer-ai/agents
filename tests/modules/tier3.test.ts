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
import {
  listIssuedDocuments,
  revokeIssuedDocument,
} from "@/modules/documents/issue";
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
// `live` is what GET /conversations/:id answers — the hand-back reads it before unassigning, so a
// stub without it is a Chatwoot that cannot be asked who is holding the conversation. Defaults to
// nobody, which is the shape that lets the unassign proceed.
function makeStub(
  live: { assigneeType?: string | null; assigneeId?: number | null } = {},
  // A holder that appears only from the SECOND live read on. The hand-back reads the conversation
  // twice — once to decide whether the unassign is aimed at somebody who is still there, once inside
  // the mirror write — and a takeover landing between them is visible only to the second. It carries
  // `updated_at` because that is what makes the mirror write take the versioned path and return a
  // stored row at all. Omitting it is a case in its own right rather than a broken fixture: the write
  // then goes unversioned, and what the caller has left is the OBSERVATION, which is the half that
  // must survive not being versionable.
  lateLive: {
    assigneeType: string;
    // Null renders the payload shape Chatwoot can send and `parseLiveConversation` accepts: a type
    // naming a person, with no assignee object to identify them.
    assigneeId: number | null;
    updatedAt?: number;
    // Which live read it first appears on. The hand-back reads the conversation three times — the
    // baseline before the status call, the check after it, and the mirror write's own — and the
    // three windows between them are different defects.
    fromRead?: number;
  } | null = null,
) {
  let liveReads = 0;
  // Set by the unassign below, and overridden by a `lateLive` holder whose read has come round:
  // somebody who claims the conversation AFTER the clear is holding it again.
  let cleared = false;
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
      // The endpoint REMOVES whoever is holding the conversation, so the double has to as well. An
      // inert unassign models a Chatwoot that never takes anybody away, which is the one thing this
      // call does — and it hid a hand-back that swept away a human who had arrived in the round trip,
      // because every read after the write still reported them.
      cleared = true;
      return {};
    },
    toggleStatus: async (_cid: number, status: string) => {
      calls.toggleStatus.push(status);
      return {};
    },
    getConversation: async (cid: number) => {
      liveReads += 1;
      const late =
        lateLive !== null && liveReads >= (lateLive.fromRead ?? 2)
          ? lateLive
          : null;
      return late
        ? {
            id: cid,
            status: "pending",
            ...(late.updatedAt != null ? { updated_at: late.updatedAt } : {}),
            meta: {
              assignee_type: late.assigneeType,
              assignee:
                late.assigneeId === null
                  ? null
                  : { id: late.assigneeId, name: "Bea" },
            },
          }
        : cleared
          ? {
              id: cid,
              status: "pending",
              meta: { assignee_type: null, assignee: null },
            }
          : {
              id: cid,
              status: "pending",
              meta: {
                assignee_type: live.assigneeType ?? null,
                assignee:
                  live.assigneeId != null
                    ? { id: live.assigneeId, name: "Ana" }
                    : null,
              },
            };
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

  // The hand-back's own success state, which the type-only test called a takeover. `toggle_status ->
  // pending` (or a concurrent assignment) can leave the conversation on the INBOX'S OWN agent bot,
  // and that is precisely what the caller asked for — the gate reads it as the AI holding it. Reported
  // as "taken-over", the console warns that somebody claimed a conversation the intended agent owns
  // and takes the re-engage offer away with it.
  test("landing on the inbox's own bot is a return, not a takeover", async () => {
    const inbox = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 4343,
        name: "Own",
      },
    });
    const ours = await suDb.agent.create({
      data: { tenantId: tenant, name: "OursBack", systemPrompt: "x" },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        agentId: ours.id,
        chatwootAgentBotId: 950,
        accessToken: encryptJson("t"),
        webhookSecret: encryptJson("s"),
        webhookRouteTokenHash: `own-${process.pid}`,
        name: "OursBack",
      },
    });
    await suDb.inbox.update({
      where: { id: inbox.id },
      data: { agentId: ours.id },
    });
    // Its OWN row, not the shared `convId`. `reconcileMirrorFromLive` stores the version it wrote, so
    // a test that leaves a future timestamp behind makes the next test's older read lose on version
    // and its assertion fail for a reason that has nothing to do with the code.
    const ownConv = (
      await suDb.conversation.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instanceId,
          chatwootConversationId: 561,
          status: "pending",
          inboxId: inbox.id,
          threadId: `${tenant}:${instanceId}:561`,
        },
      })
    ).id;
    try {
      // Chatwoot answers with our own bot on the read the mirror write makes, which is the shape a
      // successful hand-back leaves behind.
      const stub = makeStub(
        {},
        {
          assigneeType: "AgentBot",
          assigneeId: 950,
          updatedAt: Math.floor(Date.now() / 1000) + 60,
          fromRead: 3,
        },
      );
      const outcome = await returnConversationToAgent(
        ctx(tenant),
        ownConv,
        { makeClient: stub.makeClient },
        appDb,
      );
      expect(outcome).toBe("returned");

      // And a DIFFERENT bot on the same shape is still a takeover, so the rule above is the id
      // comparison rather than "any AgentBot is fine".
      const other = makeStub(
        {},
        {
          assigneeType: "AgentBot",
          assigneeId: 951,
          updatedAt: Math.floor(Date.now() / 1000) + 120,
          fromRead: 3,
        },
      );
      expect(
        await returnConversationToAgent(
          ctx(tenant),
          ownConv,
          { makeClient: other.makeClient },
          appDb,
        ),
      ).toBe("taken-over");
    } finally {
      await suDb.conversation.delete({ where: { id: ownConv } });
      await suDb.chatwootAgentBot.deleteMany({
        where: { tenantId: tenant, agentId: ours.id },
      });
      await suDb.inbox.delete({ where: { id: inbox.id } });
      await suDb.agent.delete({ where: { id: ours.id } });
    }
  });

  // The wiring behind that flag, which is the half a pure test cannot reach: the console gets one
  // boolean, and it is only worth anything if the server actually resolved the bound persona's bot id
  // to compare against. Driven with a DIFFERENT bot holding the conversation, because that is the
  // case the browser cannot decide for itself and the one an `assigneeType === "User"` test calls
  // "the AI has it".
  test("detail names another persona's bot as an external holder", async () => {
    const inbox = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 4242,
        name: "Held",
      },
    });
    const ours = await suDb.agent.create({
      data: { tenantId: tenant, name: "Ours", systemPrompt: "x" },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        agentId: ours.id,
        chatwootAgentBotId: 900,
        accessToken: encryptJson("t"),
        webhookSecret: encryptJson("s"),
        webhookRouteTokenHash: `held-${process.pid}`,
        name: "Ours",
      },
    });
    await suDb.inbox.update({
      where: { id: inbox.id },
      data: { agentId: ours.id },
    });
    try {
      await suDb.conversation.update({
        where: { id: convId },
        // Another persona's bot, and the status the AI's own conversations sit in — so status alone
        // says "the AI has this" and only the id comparison disagrees.
        data: {
          inboxId: inbox.id,
          status: "pending",
          assigneeType: "AgentBot",
          assigneeId: 901,
        },
      });
      const held = await getConversationDetail(ctx(tenant), convId, appDb);
      expect(held.heldByAnotherParty).toBe(true);

      // And our own bot on the same row is not: without this the flag could be true for every
      // AgentBot, which is the same wrong answer pointing the other way.
      await suDb.conversation.update({
        where: { id: convId },
        data: { assigneeId: 900 },
      });
      const mine = await getConversationDetail(ctx(tenant), convId, appDb);
      expect(mine.heldByAnotherParty).toBe(false);
    } finally {
      await suDb.conversation.update({
        where: { id: convId },
        data: {
          inboxId: null,
          assigneeType: null,
          assigneeId: null,
          status: "pending",
        },
      });
      await suDb.chatwootAgentBot.deleteMany({
        where: { tenantId: tenant, agentId: ours.id },
      });
      await suDb.inbox.delete({ where: { id: inbox.id } });
      await suDb.agent.delete({ where: { id: ours.id } });
    }
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
    // A human is holding it, which is what makes this a hand-back with a write to perform. The
    // unassign is aimed at somebody, so it is sent, and the mirror read afterwards sees it land.
    const stub = makeStub({ assigneeType: "User", assigneeId: 7 });
    const outcome = await returnConversationToAgent(
      ctx(tenant),
      convId,
      { makeClient: stub.makeClient },
      appDb,
    );
    // The control the takeover test needs: an outcome that were always "taken-over" would pass it.
    expect(outcome).toBe("returned");
    expect(stub.calls.unassignConversation).toBe(1);
    expect(stub.calls.toggleStatus).toEqual(["pending"]);
    const row = await suDb.conversation.findUnique({
      where: { id: convId },
      select: { status: true, assigneeType: true },
    });
    expect(row?.status).toBe("pending");
    expect(row?.assigneeType).toBeNull();
  });

  // Putting the status call first opened a window the other order did not have: a human claiming the
  // conversation while the hand-back runs would be removed by an unassign aimed at somebody else.
  // The live read closes it, and it fails toward LEAVING the human in place — a takeover always wins.
  test("a human who claimed it mid-hand-back is not unassigned", async () => {
    await suDb.conversation.update({
      where: { id: convId },
      data: { assigneeType: "User", assigneeId: 7 },
    });
    // Nobody is holding it when the request starts, and Chatwoot says somebody arrived by the read
    // after the status call — which is the window this compare exists for.
    const stub = makeStub({}, { assigneeType: "User", assigneeId: 42 });
    const outcome = await returnConversationToAgent(
      ctx(tenant),
      convId,
      { makeClient: stub.makeClient },
      appDb,
    );
    // Said out loud, because nothing throws here: the status was set and the mirror corrected, so a
    // caller that only watched for an exception would report the agent as having it back.
    expect(outcome).toBe("taken-over");
    expect(stub.calls.toggleStatus).toEqual(["pending"]);
    expect(stub.calls.unassignConversation).toBe(0);
    const row = await suDb.conversation.findUnique({
      where: { id: convId },
      select: { assigneeType: true, assigneeId: true },
    });
    expect(row?.assigneeType).toBe("User");
    expect(row?.assigneeId).toBe(42);
  });

  // And the window one step further in: the unassign was correctly aimed — the person it names was
  // still there when it was decided — it lands, and a DIFFERENT human arrives before the mirror write
  // reads the conversation back. That read is what the row and the console event are built from, so
  // an outcome derived from the FIRST read reports the agent as having it back while everything else
  // this call produced names a person.
  test("a takeover found by the mirror read is reported, not the earlier snapshot", async () => {
    const stub = makeStub(
      { assigneeType: "User", assigneeId: 7 },
      {
        assigneeType: "User",
        assigneeId: 4321,
        updatedAt: Math.floor(Date.now() / 1000) + 60,
        fromRead: 3,
      },
    );
    const outcome = await returnConversationToAgent(
      ctx(tenant),
      convId,
      { makeClient: stub.makeClient },
      appDb,
    );
    // It DID unassign: at the moment that was decided, the holder it was aimed at was still there.
    expect(stub.calls.unassignConversation).toBe(1);
    expect(outcome).toBe("taken-over");
    // And the row the same call wrote agrees, which is the disagreement being closed.
    const row = await suDb.conversation.findUnique({
      where: { id: convId },
      select: { assigneeType: true, assigneeId: true },
    });
    expect([row?.assigneeType, row?.assigneeId]).toEqual(["User", 4321]);
  });

  // The same column, the other direction, and the one the primitive answers on its own: a hand-back
  // that SUCCEEDS empties the holder, and a name left behind reads as the person still having the
  // conversation on the very screen that just said it went back to the agent.
  test("a successful hand-back clears the name with the holder", async () => {
    const namedConv = (
      await suDb.conversation.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instanceId,
          chatwootConversationId: 564,
          status: "pending",
          threadId: `${tenant}:${instanceId}:564`,
          assigneeType: "User",
          assigneeId: 7,
          assigneeName: "Ana",
        },
      })
    ).id;
    try {
      // No `lateLive`, so the read after the unassign reports the conversation as free — the shape a
      // hand-back that worked leaves behind.
      const stub = makeStub({ assigneeType: "User", assigneeId: 7 });
      expect(
        await returnConversationToAgent(
          ctx(tenant),
          namedConv,
          { makeClient: stub.makeClient },
          appDb,
        ),
      ).toBe("returned");
      const row = await suDb.conversation.findUnique({
        where: { id: namedConv },
        select: { assigneeType: true, assigneeName: true },
      });
      expect([row?.assigneeType, row?.assigneeName]).toEqual([null, null]);
    } finally {
      await suDb.conversation.delete({ where: { id: namedConv } });
    }
  });

  // The NAME is a column of its own, and the takeover write above moves the id without it. The
  // console renders the two together, so a row carrying the new holder's id under the previous
  // holder's name tells an operator, on the screen they use to decide who is handling a
  // conversation, that the wrong person has it — and it stays that way until some later webhook
  // happens to repair the row.
  test("the takeover's name lands with the takeover, not the name it replaced", async () => {
    const namedConv = (
      await suDb.conversation.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instanceId,
          chatwootConversationId: 563,
          status: "pending",
          threadId: `${tenant}:${instanceId}:563`,
          assigneeType: "User",
          assigneeId: 7,
          assigneeName: "Ana",
        },
      })
    ).id;
    try {
      // Versionless on purpose: that is the path that writes the fallback by hand instead of letting
      // the reconcile carry the whole live snapshot, and it is the one that moved the id alone.
      const stub = makeStub(
        { assigneeType: "User", assigneeId: 7 },
        { assigneeType: "User", assigneeId: 4321, fromRead: 3 },
      );
      expect(
        await returnConversationToAgent(
          ctx(tenant),
          namedConv,
          { makeClient: stub.makeClient },
          appDb,
        ),
      ).toBe("taken-over");
      const row = await suDb.conversation.findUnique({
        where: { id: namedConv },
        select: { assigneeId: true, assigneeName: true },
      });
      // Bea is who the stub's late read names. Ana is who the row said before, and reading Ana next
      // to 4321 is the defect.
      expect([row?.assigneeId, row?.assigneeName]).toEqual([4321, "Bea"]);
    } finally {
      await suDb.conversation.delete({ where: { id: namedConv } });
    }
  });

  // The window the compare above cannot see, because the write it guards is what destroys the
  // evidence. The read after the status call says nobody is holding the conversation, so the unassign
  // is aimed at NOBODY — and a human who claims it in the round trip that follows is removed by a
  // request that had no work to do in the first place. Every read afterwards then agrees the
  // conversation is free, so the call reports a clean return and the mirror stores one.
  //
  // Chatwoot has no conditional assignment to aim with: assignments#create writes whatever it is
  // handed, with no holder or version to compare against. What closes the window is not spending the
  // write at all when the read says there is nothing to remove.
  //
  // Its own double, because the shared one models arrival by READ NUMBER and this is about arriving
  // between a read and a write. Here the unassign removes whoever holds the conversation when it
  // lands, which is what the endpoint does.
  test("a human who arrives while the unassign is in flight is not swept away", async () => {
    // Its OWN row: the reads below carry a future `updated_at`, and leaving that version on the
    // shared conversation makes the next test's older read lose and fail for an unrelated reason.
    const raceConv = (
      await suDb.conversation.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instanceId,
          chatwootConversationId: 562,
          status: "pending",
          threadId: `${tenant}:${instanceId}:562`,
        },
      })
    ).id;
    let holder: number | null = null;
    let reads = 0;
    const calls = { unassign: 0 };
    const client = {
      getConversation: async (cid: number) => {
        reads += 1;
        const seen = holder;
        // Claimed the instant the guard read answered: the decision is already made, and the
        // unassign, if one is sent, is on the wire while this person arrives.
        if (reads === 2) holder = 88;
        return {
          id: cid,
          status: "pending",
          updated_at: Math.floor(Date.now() / 1000) + 60,
          meta: {
            assignee_type: seen === null ? null : "User",
            assignee: seen === null ? null : { id: seen, name: "Bea" },
          },
        };
      },
      unassignConversation: async () => {
        calls.unassign += 1;
        holder = null;
        return {};
      },
      toggleStatus: async () => ({}),
    };
    try {
      const outcome = await returnConversationToAgent(
        ctx(tenant),
        raceConv,
        { makeClient: async () => client as unknown as ChatwootClient },
        appDb,
      );
      // The person is still there, and the caller is told so.
      expect(outcome).toBe("taken-over");
      const row = await suDb.conversation.findUnique({
        where: { id: raceConv },
        select: { assigneeType: true, assigneeId: true },
      });
      expect([row?.assigneeType, row?.assigneeId]).toEqual(["User", 88]);
      // And the reason it survived: no request was spent on a conversation that had nobody to remove.
      expect(calls.unassign).toBe(0);
    } finally {
      await suDb.conversation.delete({ where: { id: raceConv } });
    }
  });

  // The same takeover, seen through a Chatwoot that sends no `updated_at` (anything older than
  // 4.0.2). The mirror write cannot version that read, so it writes the unversioned fallback and has
  // no stored row to hand back — and the holder read BEFORE the unassign names the person it was
  // aimed at, who is gone. Falling straight to it treats "I could not decide" as "nobody is there"
  // and answers "returned" while a person holds the conversation, which is the one answer every
  // caller acts on. The observation survives the failure to version it.
  test("a takeover seen on a versionless read is still reported", async () => {
    const stub = makeStub(
      { assigneeType: "User", assigneeId: 7 },
      { assigneeType: "User", assigneeId: 4321, fromRead: 3 },
    );
    const outcome = await returnConversationToAgent(
      ctx(tenant),
      convId,
      { makeClient: stub.makeClient },
      appDb,
    );
    expect(stub.calls.unassignConversation).toBe(1);
    expect(outcome).toBe("taken-over");
    // And the ROW, which no return value reaches. The unversioned write already stored what this call
    // ASKED for — pending, unassigned — so correcting only the answer leaves the durable copy saying
    // the conversation is the bot's. That is the copy `shouldBotHandle` reads, so the agent would
    // answer over the human until an assignment webhook happened to arrive.
    const row = await suDb.conversation.findUnique({
      where: { id: convId },
      select: { assigneeType: true, assigneeId: true },
    });
    expect([row?.assigneeType, row?.assigneeId]).toEqual(["User", 4321]);
  });

  // The baseline is the LIVE holder, not the mirrored row. An assignment webhook that was late or
  // lost leaves the mirror naming somebody else, and against that a human who was already there
  // before the request reads as a takeover — the hand-back refuses and the caller is told the
  // conversation stayed with a person who never arrived. /reset never saw this because it reconciles
  // from live first; the console and MCP callers do not.
  test("a stale mirror does not turn the sitting holder into a takeover", async () => {
    await suDb.conversation.update({
      where: { id: convId },
      // What the mirror believes, and it is wrong: nobody told us about this assignment.
      data: { assigneeType: "User", assigneeId: 31 },
    });
    // What Chatwoot says, before and after the status call alike.
    const stub = makeStub({ assigneeType: "User", assigneeId: 99 });
    const outcome = await returnConversationToAgent(
      ctx(tenant),
      convId,
      { makeClient: stub.makeClient },
      appDb,
    );
    expect(outcome).toBe("returned");
    expect(stub.calls.unassignConversation).toBe(1);
  });

  // A payload that names a person and does not identify them. `parseLiveConversation` accepts that
  // shape for "User" on purpose, so the compare has to read the TYPE: against a null id it answered
  // "nobody moved" and unassigned the human who had just arrived.
  test("a human whose live id never arrived is still left holding it", async () => {
    const stub = makeStub({}, { assigneeType: "User", assigneeId: null });
    const outcome = await returnConversationToAgent(
      ctx(tenant),
      convId,
      { makeClient: stub.makeClient },
      appDb,
    );
    expect(stub.calls.unassignConversation).toBe(0);
    // And reported as such: "returned" would be the same disagreement one step later.
    expect(outcome).toBe("taken-over");
  });

  // "User" and "AgentBot" are separate id namespaces in Chatwoot, so the comparison is the whole
  // identity and not the number. Against the number alone, a human claiming a conversation a BOT of
  // the same id was holding reads as nobody having moved — and the hand-back removes them.
  test("a human with the same id as the bot that held it is not unassigned", async () => {
    await suDb.conversation.update({
      where: { id: convId },
      data: { assigneeType: "AgentBot", assigneeId: 7 },
    });
    const stub = makeStub(
      { assigneeType: "AgentBot", assigneeId: 7 },
      { assigneeType: "User", assigneeId: 7 },
    );
    await returnConversationToAgent(
      ctx(tenant),
      convId,
      { makeClient: stub.makeClient },
      appDb,
    );
    expect(stub.calls.unassignConversation).toBe(0);
    const row = await suDb.conversation.findUnique({
      where: { id: convId },
      select: { assigneeType: true, assigneeId: true },
    });
    expect(row?.assigneeType).toBe("User");
    expect(row?.assigneeId).toBe(7);
  });
});

describe.skipIf(!dbUp)(
  "tier-3 analytics KPIs/timeseries + documents + audit",
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
      await suDb.issuedDocument.create({
        data: {
          tenantId: tenant,
          title: "Orçamento",
          number: 1,
          idempotencyKey: "k1",
          status: "READY",
          snapshot: {},
        },
      });
    });

    afterAll(async () => {
      if (!tenant) return;
      for (const tbl of [
        "llm_usage",
        "conversations",
        "chatwoot_instances",
        "issued_documents",
        "document_templates",
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

    test("issued documents list + revoke", async () => {
      const list = await listIssuedDocuments(ctx(tenant), {}, appDb);
      expect(list).toHaveLength(1);
      expect(list[0]?.title).toBe("Orçamento");
      // No template row behind it, so the prefix is absent and the number pads on its own.
      expect(list[0]?.number).toBe("0001");
      await revokeIssuedDocument(
        ctx(tenant),
        BigInt(list[0]?.id as string),
        appDb,
      );
      const after = await listIssuedDocuments(ctx(tenant), {}, appDb);
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
