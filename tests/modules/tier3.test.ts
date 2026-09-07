import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { type AppError, ConflictError } from "@/lib/errors";
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
  assertConversationReturnable,
  getConversationDetail,
  getConversationMedia,
  getConversationMessages,
  handoffConversation,
  replyToConversation,
  requireAnsweringResponder,
  returnConversationToAgent,
} from "@/modules/conversations/service";
import {
  listIssuedDocuments,
  revokeIssuedDocument,
} from "@/modules/documents/issue";
import { syntheticAction } from "../utils/audit-action";
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
  live: {
    assigneeType?: string | null;
    assigneeId?: number | null;
    // The bot Chatwoot reports on the inbox. Omitted = attached (501, the fixture's own); `null` is
    // the drift the round-3 refusal is about (issue #495 review, round 3).
    // Keyed by inbox NUMBER when a test moves the conversation, so "attached on the inbox it left,
    // nothing on the one it arrived at" is expressible; a bare value answers for every inbox.
    attachedBotId?: number | null | Record<number, number | null>;
    // The inbox Chatwoot renders on the conversation. Omitted = the payload names none, which is
    // every pre-round-6 fixture and the only shape that falls back to the mirror.
    inboxId?: number;
    // ...and the inbox it MOVES to, from `movedFromRead` on: a transfer landing after the baseline
    // was read and while the probes were awaiting (issue #495 review, round 7).
    movedTo?: number;
    movedFromRead?: number;
  } = {},
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
    // Which live read it first appears on. The hand-back reads the conversation FOUR times, and the
    // windows between them are different defects: 1 the baseline before the status call, 2 the
    // move-confirmation immediately before it (issue #495 review, round 7 — it looks only at
    // `inbox_id`, so a holder appearing there is invisible to it), 3 the check after the unassign,
    // and 4 the mirror write's own.
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
    inboxAgentBotId: [] as number[],
  };
  const client = {
    // The attachment Chatwoot actually has (issue #495 review, round 3). Attached by default —
    // the hand-back's happy path is an inbox whose bot is where it was put; `attachedBotId` is what
    // a test sets to say otherwise, and `null` is the drift the refusal is about.
    inboxAgentBotId: async (inboxId: number) => {
      calls.inboxAgentBotId.push(inboxId);
      const a = live.attachedBotId;
      if (a === undefined) return 501;
      if (a === null || typeof a === "number") return a;
      return inboxId in a ? a[inboxId] : null;
    },
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
      const moved =
        live.movedTo !== undefined && liveReads >= (live.movedFromRead ?? 2);
      const shown = moved ? live.movedTo : live.inboxId;
      const on = shown === undefined ? {} : { inbox_id: shown };
      return late
        ? {
            id: cid,
            status: "pending",
            ...on,
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
              ...on,
              meta: { assignee_type: null, assignee: null },
            }
          : {
              id: cid,
              status: "pending",
              ...on,
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
    expect(statuses.inboxes[String(inboxLive.id)]).toBe("active");
    expect(statuses.inboxes[String(inboxGone.id)]).toBe("missing");

    // The observer's half of the same reading: the binding is a pair, so an agent whose bot is gone
    // reports missing on the inbox it observes even though that inbox's responder is alive.
    await suDb.inboxObserver.create({
      data: { tenantId: tenant, inboxId: inboxLive.id, agentId: agentGone.id },
    });
    const withObserver = await reconcileInboxBots(
      ctx(tenant),
      { makeClient: async () => stub as unknown as ChatwootClient },
      appDb,
    );
    expect(withObserver.inboxes[String(inboxLive.id)]).toBe("active");
    expect(withObserver.observers[`${inboxLive.id}:${agentGone.id}`]).toBe(
      "missing",
    );
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
  // The conversation's inbox and the responder answering it: a hand-back is refused on an inbox
  // nothing answers (issue #495), so the fixture carries one that does.
  let inboxId = 0n;
  let responderId = 0n;

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
    responderId = (
      await suDb.agent.create({
        data: {
          tenantId: tenant,
          name: "Ops",
          systemPrompt: "x",
          // A RUNNABLE configuration, which the hand-back now asks for (issue #495 review, round 6):
          // an `openai-compatible` endpoint authenticates by its URL, so it needs no vault entry and
          // is genuinely runnable — an agent with no model config at all is not, and the fixture
          // having one was hiding exactly the state the probe exists to refuse.
          modelConfig: {
            provider: "openai-compatible",
            model: "local",
            baseURL: "https://llm.example.invalid/v1",
          },
        },
      })
    ).id;
    inboxId = (
      await suDb.inbox.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instanceId,
          chatwootInboxId: 9,
          name: "Ops inbox",
          agentId: responderId,
        },
      })
    ).id;
    // The persona's bot on THIS deployment. A binding is not an identity, and the hand-back is one
    // of the calls docs/chatwoot.md requires it before (issue #495 review, round 1).
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        agentId: responderId,
        chatwootAgentBotId: 501,
        accessToken: encryptJson("t"),
        webhookSecret: encryptJson("s"),
        webhookRouteTokenHash: `tier3-return-${process.pid}`,
        name: "Ops",
      },
    });
    convId = (
      await suDb.conversation.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instanceId,
          chatwootConversationId: 500,
          status: "pending",
          threadId: `${tenant}:${instanceId}:500`,
          inboxId,
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!tenant) return;
    for (const tbl of [
      "conversations",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
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
      data: {
        tenantId: tenant,
        name: "OursBack",
        systemPrompt: "x",
        // Runnable, like the fixture responder (issue #495 review, round 6).
        modelConfig: {
          provider: "openai-compatible",
          model: "local",
          baseURL: "https://llm.example.invalid/v1",
        },
      },
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
        // This inbox's own bot is 950, not the fixture's 501, and the attachment check compares the
        // id (issue #495 review, round 4).
        { attachedBotId: 950 },
        {
          assigneeType: "AgentBot",
          assigneeId: 950,
          updatedAt: Math.floor(Date.now() / 1000) + 60,
          fromRead: 4,
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
        { attachedBotId: 950 },
        {
          assigneeType: "AgentBot",
          assigneeId: 951,
          updatedAt: Math.floor(Date.now() / 1000) + 120,
          fromRead: 4,
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
      // Back on the fixture's own inbox (the one a responder answers), not on none.
      await suDb.conversation.update({
        where: { id: convId },
        data: {
          inboxId,
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

  // A hand-back needs somebody to hand back TO (issue #495): on an inbox with no responder, or one
  // whose responder is switched off or only observes, the same `pending` + unassign strands the
  // conversation — nothing picks it up again, and the person who had it is gone. Refused before any
  // write, with the reason named, whichever of the three it is.
  for (const [title, arrange, key] of [
    [
      "the responder only observes",
      async () =>
        suDb.agent.update({
          where: { id: responderId },
          data: { mode: "monitoring" },
        }),
      "errors.returnAgentObserves",
    ],
    [
      "the responder is switched off",
      async () =>
        suDb.agent.update({
          where: { id: responderId },
          data: { enabled: false },
        }),
      "errors.returnAgentOff",
    ],
    [
      "nothing is bound to the inbox",
      async () =>
        suDb.inbox.update({ where: { id: inboxId }, data: { agentId: null } }),
      "errors.returnNoResponder",
    ],
    [
      // A BINDING IS NOT AN IDENTITY (issue #495 review, round 1). The row can be gone — an instance
      // reconnected, the bot deleted upstream and the reconcile not run — and the runtime then has
      // no token and no route to answer with, which docs/chatwoot.md requires before anything is
      // claimed. Read as bound, the hand-back parked the conversation pending with nobody able to
      // pick it up.
      "the responder has no bot on this Chatwoot",
      async () =>
        suDb.chatwootAgentBot.deleteMany({
          where: { tenantId: tenant, agentId: responderId },
        }),
      "errors.returnAgentNoBot",
    ],
  ] as const) {
    test(`return is refused, nothing written, when ${title}`, async () => {
      await suDb.conversation.update({
        where: { id: convId },
        data: { status: "open", assigneeType: "User", assigneeId: 7 },
      });
      await arrange();
      try {
        const stub = makeStub({ assigneeType: "User", assigneeId: 7 });
        let caught: unknown = null;
        try {
          await returnConversationToAgent(
            ctx(tenant),
            convId,
            { makeClient: stub.makeClient },
            appDb,
          );
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ConflictError);
        expect((caught as ConflictError).translationKey).toBe(key);
        // Refused BEFORE the status write: the conversation is exactly as it was.
        expect(stub.calls.toggleStatus).toEqual([]);
        expect(stub.calls.unassignConversation).toBe(0);
        const row = await suDb.conversation.findUnique({
          where: { id: convId },
          select: { status: true, assigneeType: true, assigneeId: true },
        });
        expect(row?.status).toBe("open");
        expect(row?.assigneeType).toBe("User");
        expect(row?.assigneeId).toBe(7);
      } finally {
        await suDb.agent.update({
          where: { id: responderId },
          data: { mode: "production", enabled: true },
        });
        await suDb.inbox.update({
          where: { id: inboxId },
          data: { agentId: responderId },
        });
        await suDb.chatwootAgentBot.upsert({
          where: {
            tenantId_chatwootInstanceId_agentId: {
              tenantId: tenant,
              chatwootInstanceId: instanceId,
              agentId: responderId,
            },
          },
          create: {
            tenantId: tenant,
            chatwootInstanceId: instanceId,
            agentId: responderId,
            chatwootAgentBotId: 501,
            accessToken: encryptJson("t"),
            webhookSecret: encryptJson("s"),
            webhookRouteTokenHash: `tier3-return-${process.pid}`,
            name: "Ops",
          },
          update: {},
        });
      }
    });
  }

  // THE ROW IS NOT THE ATTACHMENT (issue #495 review, round 3). Our `ChatwootAgentBot` says a bot was
  // created and attached once; a bot deleted or detached in the Chatwoot UI leaves it behind, and
  // `reconcileInboxBots` only reports the drift — it asks whether the BOT exists, not whether it is
  // attached. Handing back then set the conversation pending with no delivery route at all.
  test("return is refused when Chatwoot has no bot on the inbox", async () => {
    await suDb.conversation.update({
      where: { id: convId },
      data: { status: "open", assigneeType: "User", assigneeId: 7 },
    });
    const stub = makeStub({
      assigneeType: "User",
      assigneeId: 7,
      attachedBotId: null,
    });
    let caught: unknown = null;
    try {
      await returnConversationToAgent(
        ctx(tenant),
        convId,
        { makeClient: stub.makeClient },
        appDb,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).translationKey).toBe(
      "errors.returnAgentNotAttached",
    );
    expect(stub.calls.toggleStatus).toEqual([]);
    expect(stub.calls.unassignConversation).toBe(0);
  });

  // BOUND, ON, ANSWERING AND WITH A BOT IS STILL NOT "WOULD ANSWER" (issue #495 review, round 3). A
  // credential deleted, pending or rotated makes every reactive turn end as `agent-unavailable`, so
  // the hand-back would park the conversation pending on an agent that cannot run. Asked with the
  // runtime's own loader, so the two cannot drift about what runnable means.
  test("return is refused when the responder's config cannot be built", async () => {
    await suDb.conversation.update({
      where: { id: convId },
      data: { status: "open", assigneeType: "User", assigneeId: 7 },
    });
    const before = await suDb.agent.findUniqueOrThrow({
      where: { id: responderId },
      select: { modelConfig: true },
    });
    try {
      await suDb.agent.update({
        where: { id: responderId },
        data: {
          modelConfig: {
            provider: "openai",
            model: "gpt-5.4-mini",
            credentialRef: "vault:missing-on-purpose",
          },
        },
      });
      const stub = makeStub({ assigneeType: "User", assigneeId: 7 });
      let caught: unknown = null;
      try {
        await returnConversationToAgent(
          ctx(tenant),
          convId,
          { makeClient: stub.makeClient },
          appDb,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as ConflictError).translationKey).toBe(
        "errors.returnAgentNotRunnable",
      );
      expect(stub.calls.toggleStatus).toEqual([]);
      expect(stub.calls.unassignConversation).toBe(0);
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { modelConfig: before.modelConfig ?? {} },
      });
    }
  });

  // A DIFFERENT BOT IS NOT OUR BOT (issue #495 review, round 4). An out-of-band rebind, or a local
  // persistence that failed after the remote call, leaves another persona receiving the inbox: some
  // bot is attached, so a null-only check passes, and the hand-back gives the conversation to one
  // this workspace never validated.
  test("return is refused when Chatwoot has a different bot on the inbox", async () => {
    await suDb.conversation.update({
      where: { id: convId },
      data: { status: "open", assigneeType: "User", assigneeId: 7 },
    });
    const stub = makeStub({
      assigneeType: "User",
      assigneeId: 7,
      // Ours is 501.
      attachedBotId: 4242,
    });
    let caught: unknown = null;
    try {
      await returnConversationToAgent(
        ctx(tenant),
        convId,
        { makeClient: stub.makeClient },
        appDb,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).translationKey).toBe(
      "errors.returnAgentNotAttached",
    );
    expect(stub.calls.toggleStatus).toEqual([]);
  });

  // THE COMMONEST NON-RUNNABLE STATE OF ALL (issue #495 review, round 6): an agent nobody has
  // configured. `modelConfig: {}` makes the loader THROW rather than answer null, and folding that
  // into "unreadable" let it straight through — the fail-open rule is for a vault that could not
  // answer, not for an answer saying the configuration is invalid.
  for (const [title, modelConfig] of [
    ["it has no model configuration at all", {}],
    [
      // Refused by `createChatModel` and by nothing before it.
      "it is openai-compatible with no endpoint",
      { provider: "openai-compatible", model: "local" },
    ],
    [
      // Loads AND builds — the `ChatOpenAI` constructors accept an empty key — and every request the
      // vendor sees is rejected (issue #495 review, round 15).
      "its provider needs a key and it has none",
      { provider: "openai", model: "gpt-5.4-mini" },
    ],
  ] as const) {
    test(`return is refused when ${title}`, async () => {
      await suDb.conversation.update({
        where: { id: convId },
        data: { status: "open", assigneeType: "User", assigneeId: 7 },
      });
      const before = await suDb.agent.findUniqueOrThrow({
        where: { id: responderId },
        select: { modelConfig: true },
      });
      try {
        await suDb.agent.update({
          where: { id: responderId },
          data: { modelConfig },
        });
        const stub = makeStub({ assigneeType: "User", assigneeId: 7 });
        let caught: unknown = null;
        try {
          await returnConversationToAgent(
            ctx(tenant),
            convId,
            { makeClient: stub.makeClient },
            appDb,
          );
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ConflictError);
        expect((caught as ConflictError).translationKey).toBe(
          "errors.returnAgentNotRunnable",
        );
        expect(stub.calls.toggleStatus).toEqual([]);
      } finally {
        await suDb.agent.update({
          where: { id: responderId },
          data: { modelConfig: before.modelConfig ?? {} },
        });
      }
    });
  }

  // THE INBOX IS READ OFF CHATWOOT, NOT OFF THE MIRROR (issue #495 review, round 6). A transfer
  // reaches this side by webhook, so for the length of that delivery the local row still names the
  // inbox the conversation LEFT — and every rule above, asked of that row, answers about an inbox
  // the conversation is no longer on.
  describe("transferred before the hand-back", () => {
    // Same instance, no responder: the destination a transfer into an unstaffed inbox lands on.
    let bare = 0n;
    // The responder of that third inbox.
    let other = 0n;
    // Same instance, same healthy responder: a transfer that changes nothing about the answer.
    let staffed = 0n;
    // ...and one staffed by a DIFFERENT responder, with its own bot: the destination whose own bot
    // holding the conversation afterwards is the SUCCESS state, not a takeover.
    let elsewhere = 0n;

    beforeAll(async () => {
      bare = (
        await suDb.inbox.create({
          data: {
            tenantId: tenant,
            chatwootInstanceId: instanceId,
            chatwootInboxId: 91,
            name: "Sem responder",
          },
        })
      ).id;
      staffed = (
        await suDb.inbox.create({
          data: {
            tenantId: tenant,
            chatwootInstanceId: instanceId,
            chatwootInboxId: 92,
            name: "Com responder",
            agentId: responderId,
          },
        })
      ).id;
      other = (
        await suDb.agent.create({
          data: {
            tenantId: tenant,
            name: "Ops 2",
            systemPrompt: "x",
            modelConfig: {
              provider: "openai-compatible",
              model: "local",
              baseURL: "https://llm.example.invalid/v1",
            },
          },
        })
      ).id;
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instanceId,
          agentId: other,
          chatwootAgentBotId: 950,
          accessToken: encryptJson("t"),
          webhookSecret: encryptJson("s"),
          webhookRouteTokenHash: `tier3-moved-${process.pid}`,
          name: "Ops 2",
        },
      });
      elsewhere = (
        await suDb.inbox.create({
          data: {
            tenantId: tenant,
            chatwootInstanceId: instanceId,
            chatwootInboxId: 93,
            name: "Outro responder",
            agentId: other,
          },
        })
      ).id;
    });

    afterAll(async () => {
      // The hand-back CORRECTS the mirror's inbox when the transfer was real (issue #495 review,
      // round 13), so the successful cases above leave the conversation on the destination — which
      // is the point, and which the rest of this file does not expect.
      await suDb.conversation.update({
        where: { id: convId },
        data: { inboxId },
      });
      await suDb.inbox.deleteMany({
        where: { id: { in: [bare, staffed, elsewhere] } },
      });
      await suDb.chatwootAgentBot.deleteMany({ where: { agentId: other } });
      await suDb.agent.deleteMany({ where: { id: other } });
    });

    const held = async () => {
      await suDb.conversation.update({
        where: { id: convId },
        data: { status: "open", assigneeType: "User", assigneeId: 7 },
      });
    };

    test("an inbox with no responder refuses, though the mirror's has one", async () => {
      await held();
      const stub = makeStub({
        assigneeType: "User",
        assigneeId: 7,
        inboxId: 91,
      });
      let caught: unknown = null;
      try {
        await returnConversationToAgent(
          ctx(tenant),
          convId,
          { makeClient: stub.makeClient },
          appDb,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as ConflictError).translationKey).toBe(
        "errors.returnNoResponder",
      );
      expect(stub.calls.toggleStatus).toEqual([]);
      // The mirror's inbox is bound and attached; had the old row been trusted, this would have
      // returned "returned" and parked the conversation on an inbox nobody answers.
      const mirrored = await suDb.conversation.findUniqueOrThrow({
        where: { id: convId },
        select: { inboxId: true },
      });
      expect(mirrored.inboxId).toBe(inboxId);
    });

    // An inbox this runtime has never synced is not a reason to fall back to the stale row: it is an
    // inbox with no responder of ours, which is the refusal, not an unreadable answer.
    test("an inbox this side does not know refuses", async () => {
      await held();
      const stub = makeStub({
        assigneeType: "User",
        assigneeId: 7,
        inboxId: 4096,
      });
      let caught: unknown = null;
      try {
        await returnConversationToAgent(
          ctx(tenant),
          convId,
          { makeClient: stub.makeClient },
          appDb,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as ConflictError).translationKey).toBe(
        "errors.returnNoResponder",
      );
      expect(stub.calls.toggleStatus).toEqual([]);
    });

    // ...and the attachment is asked about the inbox it ARRIVED at. A bot attached to the one it
    // left says nothing about the destination, and reading the old number was how a hand-back into
    // an inbox with a detached bot passed the remote half.
    test("a staffed destination returns, and is probed on its own number", async () => {
      await held();
      const stub = makeStub({
        assigneeType: "User",
        assigneeId: 7,
        inboxId: 92,
        attachedBotId: { 92: 501 },
      });
      const outcome = await returnConversationToAgent(
        ctx(tenant),
        convId,
        { makeClient: stub.makeClient },
        appDb,
      );
      expect(outcome).toBe("returned");
      expect(stub.calls.toggleStatus).toEqual(["pending"]);
      expect(stub.calls.inboxAgentBotId).toEqual([92]);
      // ...AND THE MIRROR LEARNS WHERE IT IS (issue #495 review, round 13). The reconcile that
      // follows a hand-back writes status and assignee and never `inboxId`, so a transfer whose
      // webhook is delayed or lost left the row naming the inbox the conversation LEFT — and the
      // console's "Respond now" resolves its agent from that row, which is the ORIGIN inbox's
      // persona sending a customer-facing reply on a conversation that is not its own.
      const moved = await suDb.conversation.findUniqueOrThrow({
        where: { id: convId },
        select: { inboxId: true },
      });
      expect(moved.inboxId).toBe(staffed);
    });

    // ...and a destination whose bot is NOT attached is refused there, on the destination's own
    // reading — the same map, answering `null` for 92 while 9 is still attached.
    test("a destination with no attached bot refuses", async () => {
      await held();
      const stub = makeStub({
        assigneeType: "User",
        assigneeId: 7,
        inboxId: 92,
        attachedBotId: { 9: 501 },
      });
      let caught: unknown = null;
      try {
        await returnConversationToAgent(
          ctx(tenant),
          convId,
          { makeClient: stub.makeClient },
          appDb,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as ConflictError).translationKey).toBe(
        "errors.returnAgentNotAttached",
      );
      expect(stub.calls.toggleStatus).toEqual([]);
    });

    // ...AND THE MOVE CAN LAND *AFTER* THE BASELINE (issue #495 review, round 7). Between that read
    // and the toggle sit the locked row read, the vault round trip of the runnable probe and the
    // attachment GET; a transfer landing in there had the OLD inbox validated and the new one never
    // looked at, which parks the conversation on an inbox nothing answers and takes it from the
    // person holding it.
    test("a move after the baseline is caught before the write", async () => {
      await held();
      const stub = makeStub({
        assigneeType: "User",
        assigneeId: 7,
        inboxId: 9,
        movedTo: 91,
        // From the confirmation read on, which is the one taken immediately before the toggle.
        movedFromRead: 2,
      });
      let caught: unknown = null;
      try {
        await returnConversationToAgent(
          ctx(tenant),
          convId,
          { makeClient: stub.makeClient },
          appDb,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as ConflictError).translationKey).toBe(
        "errors.returnConversationMoved",
      );
      expect(stub.calls.toggleStatus).toEqual([]);
      expect(stub.calls.unassignConversation).toBe(0);
    });

    // ...and an unreadable confirmation is a blip, not a move: it fails open like every other live
    // answer on this path.
    test("an unreadable confirmation still hands back", async () => {
      await held();
      const stub = makeStub({
        assigneeType: "User",
        assigneeId: 7,
        inboxId: 9,
      });
      const client = await stub.makeClient();
      const real = client.getConversation.bind(client);
      let n = 0;
      (client as { getConversation: unknown }).getConversation = async (
        cid: number,
      ) => {
        n += 1;
        if (n === 2) throw new Error("chatwoot 502");
        return real(cid);
      };
      const outcome = await returnConversationToAgent(
        ctx(tenant),
        convId,
        { makeClient: async () => client },
        appDb,
      );
      expect(outcome).toBe("returned");
      expect(stub.calls.toggleStatus).toEqual(["pending"]);
    });

    // ...AND THE FINAL OWNERSHIP CHECK IS ASKED OF THE RESOLVED INBOX TOO (issue #495 review, round
    // 8). Everything else was judged against the inbox Chatwoot names while this last comparison
    // still read the row loaded at the top, so a conversation transferred to an inbox with ANOTHER
    // responder came back held by that responder's own bot — the success state — and was reported and
    // audited as `taken-over`, which takes the re-engage offer away from an operator whose hand-back
    // worked.
    test("the destination's own bot holding it is a return, not a takeover", async () => {
      await held();
      const stub = makeStub(
        {
          assigneeType: "User",
          assigneeId: 7,
          inboxId: 93,
          attachedBotId: { 93: 950 },
        },
        {
          assigneeType: "AgentBot",
          assigneeId: 950,
          updatedAt: Math.floor(Date.now() / 1000) + 60,
          // From the read after the unassign: where the hand-back's own outcome is decided.
          fromRead: 3,
        },
      );
      const outcome = await returnConversationToAgent(
        ctx(tenant),
        convId,
        { makeClient: stub.makeClient },
        appDb,
      );
      expect(outcome).toBe("returned");
      expect(stub.calls.toggleStatus).toEqual(["pending"]);
    });

    // PREVIEW AND APPLY ANSWER THE SAME THING (docs/mcp.md): the transfer had already happened when
    // the preview ran, so a preview reading the mirror approves what the apply refuses one call
    // later with no state change in between.
    test("the dry-run refuses what the apply refuses", async () => {
      await held();
      const stub = makeStub({
        assigneeType: "User",
        assigneeId: 7,
        inboxId: 91,
      });
      let caught: unknown = null;
      try {
        await assertConversationReturnable(
          ctx(tenant),
          convId,
          { makeClient: stub.makeClient },
          appDb,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as ConflictError).translationKey).toBe(
        "errors.returnNoResponder",
      );
    });
  });

  // THE READING THAT DECIDES IS THE LAST ONE TAKEN (issue #495 review, round 10). The local check
  // used to sit before the attachment GET and the move confirmation — two round trips — so an
  // administrator switching the agent off inside that window was invisible to it, and the hand-back
  // removed the human for an agent that will not answer.
  test("a responder switched off during the GETs stops the write", async () => {
    await suDb.conversation.update({
      where: { id: convId },
      data: { status: "open", assigneeType: "User", assigneeId: 7 },
    });
    const stub = makeStub({ assigneeType: "User", assigneeId: 7 });
    const client = await stub.makeClient();
    // Switched off while the ATTACHMENT read is in flight: past every earlier check, and before the
    // toggle.
    (client as { inboxAgentBotId: unknown }).inboxAgentBotId = async () => {
      await suDb.agent.update({
        where: { id: responderId },
        data: { enabled: false },
      });
      return 501;
    };
    let caught: unknown = null;
    try {
      await returnConversationToAgent(
        ctx(tenant),
        convId,
        { makeClient: async () => client },
        appDb,
      );
    } catch (e) {
      caught = e;
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { enabled: true },
      });
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).translationKey).toBe(
      "errors.returnAgentOff",
    );
    expect(stub.calls.toggleStatus).toEqual([]);
    expect(stub.calls.unassignConversation).toBe(0);
  });

  // THE BINDING IS RE-READ, NOT ONLY THE AGENT IT NAMED (issue #495 review, round 12). The inbox row
  // is resolved before the attachment GET and the move confirmation, so a rebind landing in that
  // window left the last validation judging the agent that USED to be there — and the confirmation
  // sees nothing, because it compares the inbox NUMBER, which did not move.
  test("a responder swapped during the GETs stops the write", async () => {
    await suDb.conversation.update({
      where: { id: convId },
      data: { status: "open", assigneeType: "User", assigneeId: 7 },
    });
    const spare = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "Spare",
        systemPrompt: "x",
        modelConfig: {
          provider: "openai-compatible",
          model: "local",
          baseURL: "https://llm.example.invalid/v1",
        },
      },
    });
    const stub = makeStub({ assigneeType: "User", assigneeId: 7 });
    const client = await stub.makeClient();
    // The rebind lands while the ATTACHMENT read is in flight: past the resolution the validation
    // below is built on, and before the toggle.
    (client as { inboxAgentBotId: unknown }).inboxAgentBotId = async () => {
      await suDb.inbox.update({
        where: { id: inboxId },
        data: { agentId: spare.id },
      });
      return 501;
    };
    let caught: unknown = null;
    try {
      await returnConversationToAgent(
        ctx(tenant),
        convId,
        { makeClient: async () => client },
        appDb,
      );
    } catch (e) {
      caught = e;
    } finally {
      await suDb.inbox.update({
        where: { id: inboxId },
        data: { agentId: responderId },
      });
      await suDb.agent.delete({ where: { id: spare.id } });
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).translationKey).toBe(
      "errors.returnResponderChanged",
    );
    expect(stub.calls.toggleStatus).toEqual([]);
    expect(stub.calls.unassignConversation).toBe(0);
  });

  // A TEST AGENT NOBODY ACTIVATED HERE ANSWERS NOTHING (issue #495 review, round 10). `test` is not
  // a mode that answers on its own: the receiver's gate keeps it silent on every conversation whose
  // `testActivatedAt` is null, and the runnable probe knows nothing about activation — so this
  // responder passed every rule and the hand-back parked the conversation pending with nobody there.
  test("a test agent not activated on this conversation refuses", async () => {
    const before = await suDb.agent.findUniqueOrThrow({
      where: { id: responderId },
      select: { mode: true },
    });
    try {
      await suDb.agent.update({
        where: { id: responderId },
        data: { mode: "test" },
      });
      await suDb.conversation.update({
        where: { id: convId },
        data: {
          status: "open",
          assigneeType: "User",
          assigneeId: 7,
          testActivatedAt: null,
        },
      });
      const stub = makeStub({ assigneeType: "User", assigneeId: 7 });
      let caught: unknown = null;
      try {
        await returnConversationToAgent(
          ctx(tenant),
          convId,
          { makeClient: stub.makeClient },
          appDb,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as ConflictError).translationKey).toBe(
        "errors.returnAgentTestSilent",
      );
      expect(stub.calls.toggleStatus).toEqual([]);

      // ...and the SAME agent, on a conversation `/teste` has activated, is handed it back: the rule
      // is about this conversation, not about the mode.
      await suDb.conversation.update({
        where: { id: convId },
        data: { testActivatedAt: new Date() },
      });
      const live = makeStub({ assigneeType: "User", assigneeId: 7 });
      expect(
        await returnConversationToAgent(
          ctx(tenant),
          convId,
          { makeClient: live.makeClient },
          appDb,
        ),
      ).toBe("returned");
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { mode: before.mode },
      });
      await suDb.conversation.update({
        where: { id: convId },
        data: { testActivatedAt: null },
      });
    }
  });

  // A LOCAL BOT ROW THAT VANISHED IS DEFINITE (issue #495 review, round 10). `deleteAgent` leaves the
  // remote bot attached on purpose, so Chatwoot keeps reporting a numeric id for a persona whose
  // route token no longer exists here — and the attachment check accepted it, handing the
  // conversation to nobody.
  //
  // WHAT THIS TEST DOES AND DOES NOT PROVE, stated because the two round-10 fixes overlap here: with
  // the local responder state now read LAST, this same deletion is also caught by that reading, so
  // the observable refusal survives reverting the attachment guard alone. It is kept as a lock on
  // the OUTCOME — a row that vanished mid-request never reaches the write — and the guard itself
  // stands on the condition having been wrong on its own terms, not on this test isolating it.
  test("a bot row deleted mid-hand-back refuses", async () => {
    await suDb.conversation.update({
      where: { id: convId },
      data: { status: "open", assigneeType: "User", assigneeId: 7 },
    });
    const row = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { tenantId: tenant, agentId: responderId },
    });
    const stub = makeStub({ assigneeType: "User", assigneeId: 7 });
    // Deleted after the first responder check has passed, while the client is being built.
    const inner = stub.makeClient;
    let caught: unknown = null;
    try {
      await returnConversationToAgent(
        ctx(tenant),
        convId,
        {
          makeClient: async () => {
            await suDb.chatwootAgentBot.delete({ where: { id: row.id } });
            return inner();
          },
        },
        appDb,
      );
    } catch (e) {
      caught = e;
    }
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId: row.tenantId,
        chatwootInstanceId: row.chatwootInstanceId,
        agentId: row.agentId,
        chatwootAgentBotId: row.chatwootAgentBotId,
        accessToken: row.accessToken,
        webhookSecret: row.webhookSecret,
        webhookRouteTokenHash: row.webhookRouteTokenHash,
        name: row.name,
      },
    });
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).translationKey).toBe(
      "errors.returnAgentNoBot",
    );
    expect(stub.calls.toggleStatus).toEqual([]);
  });

  // PREVIEW AND APPLY GIVE THE SAME REASON, not merely the same verdict (issue #495 review, round
  // 14). A responder that is switched off AND whose bot is detached is refused by both halves, and
  // with the two asking their checks in different orders they answered `returnAgentOff` and
  // `returnAgentNotAttached` for one state with nothing in between — so an operator who approved a
  // preview was handed a different remediation than the one they had read.
  test("the dry-run and the apply refuse with the same key", async () => {
    await suDb.conversation.update({
      where: { id: convId },
      data: { status: "open", assigneeType: "User", assigneeId: 7 },
    });
    const keyOf = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return null;
      } catch (e) {
        return e instanceof ConflictError ? e.translationKey : "other";
      }
    };
    try {
      await suDb.agent.update({
        where: { id: responderId },
        data: { enabled: false },
      });
      // Both broken at once: off locally, and detached in Chatwoot.
      const preview = makeStub({
        assigneeType: "User",
        assigneeId: 7,
        attachedBotId: null,
      });
      const apply = makeStub({
        assigneeType: "User",
        assigneeId: 7,
        attachedBotId: null,
      });
      const a = await keyOf(() =>
        assertConversationReturnable(
          ctx(tenant),
          convId,
          { makeClient: preview.makeClient },
          appDb,
        ),
      );
      const b = await keyOf(() =>
        returnConversationToAgent(
          ctx(tenant),
          convId,
          { makeClient: apply.makeClient },
          appDb,
        ),
      );
      expect(a).not.toBeNull();
      expect(a).toBe(b as string);
      expect(apply.calls.toggleStatus).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { enabled: true },
      });
    }
  });

  // THE REASON IS DECIDED AFTER THE LAST READING, NOT BY THE LOADER (issue #495 review, round 16).
  // `loadAgentConfig` answers `null` for a switched-off agent and for a monitoring one as much as
  // for a credential that will not resolve, so an administrator flipping the switch between this
  // function's OWN two reads was answered with "check its model credential" — the one remediation
  // that does not fix it — and the re-read that names it correctly sat behind that throw.
  //
  // The flip is placed exactly in that window by the client itself: the extension fires on the read
  // at the top of the function, commits the change from another connection, and the loader's read a
  // few statements later is the first to see it. Nothing coarser reaches the window — switching the
  // agent off before the call is refused by the first check, which is the state the two earlier
  // tests already cover.
  test("a responder switched off between the two reads is named off, not unrunnable", async () => {
    let reads = 0;
    const racing = appDb.$extends({
      query: {
        agent: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (++reads === 1) {
              await suDb.agent.update({
                where: { id: responderId },
                data: { enabled: false },
              });
            }
            return row;
          },
        },
      },
    }) as unknown as PrismaClient;
    let caught: unknown = null;
    try {
      await requireAnsweringResponder(
        ctx(tenant),
        { agentId: responderId },
        instanceId,
        racing,
        {
          conversationId: 500,
          threadId: `${tenant}:${instanceId}:500`,
          testActivatedAt: null,
          contactId: null,
          chatwootInboxId: 9,
        },
      );
    } catch (e) {
      caught = e;
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { enabled: true },
      });
    }
    expect(reads).toBeGreaterThan(1);
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).translationKey).toBe(
      "errors.returnAgentOff",
    );
  });

  // A CONSTRUCTOR THROW REFUSES, WHATEVER IT THREW (issue #495 review, round 9). `createChatModel`
  // reads no database and calls nobody: a throw from it is deterministic and the runtime's own next
  // turn gets the identical one. Several of those come out of the vendors' SDKs as a plain `Error`
  // rather than an `AppError` — `ChatAnthropic` throws when no key is available anywhere — and
  // reading a plain `Error` as a blip unassigned a human for a responder that cannot start.
  test("a plain constructor failure refuses the hand-back", async () => {
    await suDb.conversation.update({
      where: { id: convId },
      data: { status: "open", assigneeType: "User", assigneeId: 7 },
    });
    const before = await suDb.agent.findUniqueOrThrow({
      where: { id: responderId },
      select: { modelConfig: true },
    });
    try {
      await suDb.agent.update({
        where: { id: responderId },
        // Anthropic with no credential: the SDK refuses to construct, with a bare Error.
        data: {
          modelConfig: { provider: "anthropic", model: "claude-opus-5" },
        },
      });
      const stub = makeStub({ assigneeType: "User", assigneeId: 7 });
      let caught: unknown = null;
      try {
        await returnConversationToAgent(
          ctx(tenant),
          convId,
          { makeClient: stub.makeClient },
          appDb,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as ConflictError).translationKey).toBe(
        "errors.returnAgentNotRunnable",
      );
      expect(stub.calls.toggleStatus).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { modelConfig: before.modelConfig ?? {} },
      });
    }
  });

  // ...and a credential that cannot be DECRYPTED is preserved, not folded into "unreadable" (issue
  // #495 review, round 9). A corrupt blob, or `ENCRYPTION_KEY` rotated, throws a plain crypto or
  // JSON error and will throw the same one on every turn; CLAUDE.md says to throw rather than fall
  // back on exactly that, and swallowing it handed the conversation over having unassigned somebody.
  test("a credential that cannot be decrypted is not read as a blip", async () => {
    await suDb.conversation.update({
      where: { id: convId },
      data: { status: "open", assigneeType: "User", assigneeId: 7 },
    });
    const before = await suDb.agent.findUniqueOrThrow({
      where: { id: responderId },
      select: { modelConfig: true },
    });
    const entry = await suDb.vaultEntry.create({
      data: {
        tenantId: tenant,
        name: `tier3-rotten-${process.pid}`,
        kind: "api_key",
        // What a blob encrypted under another key looks like from here: base64 that decrypts to
        // nothing.
        secret: Buffer.from("not-a-blob-at-all").toString("base64"),
      },
    });
    try {
      await suDb.agent.update({
        where: { id: responderId },
        data: {
          modelConfig: {
            provider: "openai",
            model: "gpt-5.4-mini",
            credentialRef: `vault:${entry.id}`,
          },
        },
      });
      const stub = makeStub({ assigneeType: "User", assigneeId: 7 });
      let caught: unknown = null;
      try {
        await returnConversationToAgent(
          ctx(tenant),
          convId,
          { makeClient: stub.makeClient },
          appDb,
        );
      } catch (e) {
        caught = e;
      }
      // Preserved rather than converted: the operator gets the real cause, and the hand-back is
      // not performed either way.
      expect(caught).not.toBeNull();
      expect(stub.calls.toggleStatus).toEqual([]);
      expect(stub.calls.unassignConversation).toBe(0);
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { modelConfig: before.modelConfig ?? {} },
      });
      await suDb.vaultEntry.delete({ where: { id: entry.id } });
    }
  });

  // ...but an UNREADABLE answer is not "no bot": a blip on that GET must not refuse a hand-back the
  // operator asked for.
  test("an unreadable attachment read does not refuse the hand-back", async () => {
    await suDb.conversation.update({
      where: { id: convId },
      data: { status: "open", assigneeType: "User", assigneeId: 7 },
    });
    const stub = makeStub({ assigneeType: "User", assigneeId: 7 });
    const client = await stub.makeClient();
    (client as { inboxAgentBotId: unknown }).inboxAgentBotId = async () => {
      throw new Error("chatwoot 502");
    };
    const outcome = await returnConversationToAgent(
      ctx(tenant),
      convId,
      { makeClient: async () => client },
      appDb,
    );
    expect(outcome).toBe("returned");
    expect(stub.calls.toggleStatus).toEqual(["pending"]);
  });

  // ...AND THE SAME REFUSAL ON THE FAR SIDE OF THE NETWORK (issue #495 review, round 1). The first
  // check runs before the client is built and the baseline is read, both of which await; an unbind
  // committing inside that window reached the status write on a stale snapshot and stranded the
  // conversation, which is the outcome the guard exists to prevent.
  test("a responder unbound mid-hand-back stops the write", async () => {
    await suDb.conversation.update({
      where: { id: convId },
      data: { status: "open", assigneeType: "User", assigneeId: 7 },
    });
    try {
      const stub = makeStub({ assigneeType: "User", assigneeId: 7 });
      // The unbind lands while the baseline read is in flight — after the first check passed.
      const inner = stub.makeClient;
      let caught: unknown = null;
      try {
        await returnConversationToAgent(
          ctx(tenant),
          convId,
          {
            makeClient: async (...a: Parameters<typeof inner>) => {
              await suDb.inbox.update({
                where: { id: inboxId },
                data: { agentId: null },
              });
              return inner(...a);
            },
          },
          appDb,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as ConflictError).translationKey).toBe(
        "errors.returnNoResponder",
      );
      // Nothing written: the status call is on the far side of the second check.
      expect(stub.calls.toggleStatus).toEqual([]);
      expect(stub.calls.unassignConversation).toBe(0);
      const row = await suDb.conversation.findUnique({
        where: { id: convId },
        select: { status: true, assigneeType: true },
      });
      expect(row?.status).toBe("open");
      expect(row?.assigneeType).toBe("User");
    } finally {
      await suDb.inbox.update({
        where: { id: inboxId },
        data: { agentId: responderId },
      });
    }
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
        fromRead: 4,
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
          // On the fixture's inbox, the one a responder answers (issue #495).
          inboxId,
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
          // On the fixture's inbox, the one a responder answers (issue #495).
          inboxId,
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
        { assigneeType: "User", assigneeId: 4321, fromRead: 4 },
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
          // On the fixture's inbox, the one a responder answers (issue #495).
          inboxId,
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
      // Attached, which is this test's premise: the race it measures is a human arriving, not a bot
      // going missing (issue #495 review, round 3).
      inboxAgentBotId: async () => 501,
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
      { assigneeType: "User", assigneeId: 4321, fromRead: 4 },
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
        recordAudit(db, tenant, {
          action: syntheticAction("test.action"),
          target: "thing",
        }),
      );
      const page = await listAudit(ctx(tenant), {}, appDb);
      expect(page.entries.some((e) => e.action === "test.action")).toBe(true);
    });
  },
);

describe("normalizeTimeZone", () => {
  test("keeps a valid IANA zone; ABSENT means UTC", () => {
    expect(normalizeTimeZone("America/Sao_Paulo")).toBe("America/Sao_Paulo");
    expect(normalizeTimeZone(undefined)).toBe("UTC");
  });

  test("a zone the caller SENT and this cannot read is refused, not replaced", () => {
    // Changed in issue #372. The old contract answered "UTC" here, which meant one typo
    // (`America/Sao_Paolo`) bucketed the dashboard a day off with no way for the caller to tell.
    for (const bad of ["", "Not/AZone", "America/Sao_Paolo", "UTC+3"]) {
      let err: unknown = null;
      try {
        normalizeTimeZone(bad);
      } catch (e) {
        err = e;
      }
      expect(`${bad}: ${err === null ? "accepted" : "refused"}`).toBe(
        `${bad}: refused`,
      );
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).field).toBe("tz");
    }
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
