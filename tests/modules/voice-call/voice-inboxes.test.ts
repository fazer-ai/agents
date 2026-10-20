import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { tool } from "@langchain/core/tools";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import * as prepare from "@/graph/prepare";
import type { TenantContext } from "@/lib/tenancy";
import {
  cloneAgent,
  createAgent,
  deleteAgent,
  listAgentsPaged,
  updateAgent,
} from "@/modules/agents/service";
import { exportAgent, importAgent } from "@/modules/agents/transfer";
import {
  type ChatwootClient,
  createChatwootClient,
} from "@/modules/chatwoot/client";
import * as chatwootInstance from "@/modules/chatwoot/instance";
import { asRendered } from "@/modules/chatwoot/liquid";
import {
  bindInbox,
  disconnectChatwootDeployment,
  listInboxCustomAttributes,
  listInboxLabels,
  reconnectChatwootInstance,
  removeChatwootInstance,
  softDisconnectChatwootInstance,
} from "@/modules/chatwoot/management";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  agentCreate,
  agentDelete,
  agentUpdate,
} from "@/modules/mcp/write-agents";
import { inboxBindVoice } from "@/modules/mcp/write-channels";
import { loadPlaygroundVoiceAgent } from "@/modules/playground/service";
import type { CallRecord } from "@/modules/voice-call/bridge";
import * as voiceInboxes from "@/modules/voice-call/inboxes";
import {
  bindInboxVoiceAgent,
  checkVoiceBinding,
  syncVoiceAgentInboxes,
  syncVoiceInboxes,
  voiceStreamUrl,
} from "@/modules/voice-call/inboxes";
import { withinInvocation } from "@/modules/voice-call/invocation-deadline";
import { CALL_HTTP_TOOL_TIMEOUT_MS } from "@/modules/voice-call/providers/elevenlabs-tools";
import {
  fenceConversation,
  reportCall,
  resolveVoiceRoute,
} from "@/modules/voice-call/service";
import { setUpAgentCalls } from "@/modules/voice-call/setup";
import { loadVoiceAgent } from "@/modules/voice-call/tools";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import { dbProbeFailed } from "@/tests/db-gate";
import { until } from "@/tests/utils/poll";
import { seedChatwootInstance } from "../../utils/chatwoot";
import { underConcurrentEdit } from "../../utils/pg-waits";

// Which voice agent answers an inbox's calls: a binding of its own beside the text
// responder, written on the Chatwoot fork (`whatsapp_calls/ai_voice`) with the URL the calls' audio
// goes to, and resolved back from that URL's token when a call arrives.

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const ctx = (t: bigint): TenantContext => ({
  tenantId: t,
  userId: null,
  role: "TENANT_ADMIN",
});

type AiVoice = { inbox_id: number; enabled: boolean; stream_url: string };

function fakeChatwoot(
  opts: {
    failAiVoice?: boolean;
    failAgentBots?: boolean;
    duringAiVoice?: () => Promise<void>;
    // One per write, in order: a binding that keeps moving while it is written.
    duringEachAiVoice?: Array<() => Promise<void>>;
    // conversation id -> the Chatwoot inbox it is in
    conversations?: Record<number, number>;
    // conversation id -> its messages, oldest first, each a call's when it names one
    history?: Record<number, Array<{ id: number; call?: string }>>;
    // conversation id -> the contact Chatwoot names on it
    senders?: Record<number, { id: number; name: string }>;
    // conversation id -> its last activity, epoch seconds, which positions what it states
    activityAt?: Record<number, number>;
  } = {},
) {
  const writes: AiVoice[] = [];
  const reports: Array<{ provider_call_id: string }> = [];
  const notes: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const path = new URL(url).pathname;
    let status = 200;
    let answer: unknown = body ?? {};
    if (path.endsWith("/whatsapp_calls/ai_voice")) {
      if (opts.failAiVoice) status = 503;
      else {
        writes.push(body);
        // Runs while this write is in flight, as a save that commits under it would.
        const during = opts.duringAiVoice ?? opts.duringEachAiVoice?.shift();
        opts.duringAiVoice = undefined;
        await during?.();
      }
    } else if (path.endsWith("/whatsapp_calls/ai_report")) {
      reports.push(body);
    } else if (/\/conversations\/\d+\/messages$/.test(path) && body) {
      notes.push(body.content);
    } else if (/\/conversations\/\d+\/messages$/.test(path) && !body) {
      // A page is the twenty messages before `before`, the newest page without it.
      const id = Number(path.split("/").at(-2));
      const before = Number(
        new URL(url).searchParams.get("before") ?? Infinity,
      );
      const older = (opts.history?.[id] ?? []).filter((m) => m.id < before);
      answer = {
        payload: older.slice(-20).map((m) => ({
          id: m.id,
          content: null,
          message_type: 2,
          private: false,
          ...(m.call ? { call: { provider_call_id: m.call } } : {}),
        })),
      };
    } else if (/\/conversations\/\d+$/.test(path)) {
      const inbox = opts.conversations?.[Number(path.split("/").pop())];
      if (inbox === undefined) status = 404;
      else {
        const id = Number(path.split("/").pop());
        const sender = opts.senders?.[id];
        const activityAt = opts.activityAt?.[id];
        answer = {
          id,
          inbox_id: inbox,
          status: "open",
          ...(sender ? { meta: { sender } } : {}),
          ...(activityAt
            ? { last_activity_at: activityAt, updated_at: activityAt }
            : {}),
        };
      }
    } else if (/\/inboxes\/\d+\/agent_bot$/.test(path)) {
      answer = { agent_bot: {} };
    } else if (path.endsWith("/agent_bots")) {
      if (opts.failAgentBots) status = 503;
      answer =
        init?.method === "POST"
          ? { id: 900, access_token: "bot-token", secret: "bot-secret" }
          : [];
    }
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(answer),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const makeClient = (cfg: ConstructorParameters<typeof ChatwootClient>[0]) =>
    createChatwootClient(cfg, {
      fetchImpl,
      assertSafe: async (u: string) => new URL(u),
    });
  return { writes, reports, notes, makeClient };
}

// A tool from an MCP server, carrying the server's scope as the toolset stamps it.
const mcpTool = () =>
  Object.assign(
    tool(async () => "ok", {
      name: "mcp__crm__busca",
      description: "d",
      schema: z.object({}),
    }),
    {
      metadata: {
        mcpServer: {
          label: "crm",
          instructions: "Busque pelo CPF antes do nome.",
        },
      },
    },
  );

describe.skipIf(!dbUp)("the voice agent bound to an inbox's calls", () => {
  let tenant = 0n;
  let instanceId = 0n;
  let voiceId = 0n;
  let textId = 0n;
  let whatsappInboxId = 0n;
  let apiInboxId = 0n;

  beforeAll(async () => {
    tenant = (
      await suDb.tenant.create({
        data: { name: "Voice", slug: `voice-${process.pid}` },
      })
    ).id;
    instanceId = BigInt(
      (
        await seedChatwootInstance(suDb, {
          tenantId: tenant,
          baseUrl: "https://chat.voice.test",
          accountId: 1,
          adminToken: encryptJson("admintok"),
        })
      ).id,
    );
    const agent = (name: string, kind: string) =>
      suDb.agent.create({
        data: {
          tenantId: tenant,
          name,
          kind,
          systemPrompt: "x",
          mode: "production",
        },
      });
    voiceId = (await agent("Raquel", "voice")).id;
    textId = (await agent("Maria", "text")).id;
    const inbox = (chatwootInboxId: number, channelType: string) =>
      suDb.inbox.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instanceId,
          chatwootInboxId,
          name: `Inbox ${chatwootInboxId}`,
          channelType,
          agentId: textId,
        },
      });
    whatsappInboxId = (await inbox(501, "Channel::Whatsapp")).id;
    apiInboxId = (await inbox(502, "Channel::Api")).id;
  });

  afterAll(async () => {
    if (!tenant) return;
    for (const tbl of [
      "conversations",
      "contacts",
      "chatwoot_agent_bots",
      "inboxes",
      "agents",
      "chatwoot_instances",
      "chatwoot_deployments",
      "vault_entries",
    ]) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM ${tbl} WHERE tenant_id = ${tenant}`,
      );
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenant}`);
  });

  async function routeToken(): Promise<string> {
    const row = await suDb.inbox.findUniqueOrThrow({
      where: { id: whatsappInboxId },
      select: { voiceRouteToken: true },
    });
    return decryptJson<string>(row.voiceRouteToken as string);
  }

  async function setMode(mode: string, enabled = true) {
    await suDb.agent.update({
      where: { id: voiceId },
      data: { mode, enabled },
    });
  }

  test("binding a voice agent switches the inbox's calls on, with the inbox's own stream URL", async () => {
    const cw = fakeChatwoot();
    expect(
      await bindInboxVoiceAgent(
        ctx(tenant),
        whatsappInboxId,
        voiceId,
        cw,
        appDb,
      ),
    ).toEqual({ voiceAgentId: String(voiceId) });
    const token = await routeToken();
    expect(cw.writes).toEqual([
      expect.objectContaining({ inbox_id: 501, enabled: true }),
    ]);
    expect(cw.writes[0]?.stream_url).toBe(
      voiceStreamUrl(config.publicUrl, token),
    );
    expect(cw.writes[0]?.stream_url).toMatch(/^wss?:\/\//);
    // The text responder is untouched, and the voice agent's own bot exists to sign its notes.
    const inbox = await suDb.inbox.findUniqueOrThrow({
      where: { id: whatsappInboxId },
    });
    expect(inbox.agentId).toBe(textId);
    expect(
      await suDb.chatwootAgentBot.count({ where: { agentId: voiceId } }),
    ).toBe(1);
  });

  test("the agents list shows the inbox under the agent that answers its calls, and under its text agent", async () => {
    const { agents } = await listAgentsPaged(ctx(tenant), {}, appDb);
    const inboxesOf = (id: bigint) =>
      agents.find((a) => a.id === String(id))?.inboxes.map((i) => i.name);
    expect(inboxesOf(voiceId)).toEqual(["Inbox 501"]);
    expect(inboxesOf(textId)).toEqual(["Inbox 501", "Inbox 502"]);
  });

  test("the route token is minted once: rebinding keeps the same URL", async () => {
    const before = await routeToken();
    const cw = fakeChatwoot();
    await bindInboxVoiceAgent(ctx(tenant), whatsappInboxId, voiceId, cw, appDb);
    expect(await routeToken()).toBe(before);
    expect(cw.writes[0]?.stream_url).toEndWith(`/${before}`);
  });

  test("the token resolves the call to its inbox and agent, only while the agent answers", async () => {
    const token = await routeToken();
    expect(await resolveVoiceRoute(token, appDb)).toMatchObject({
      tenantId: tenant,
      instanceId,
      inboxId: 501,
      agentId: voiceId,
      agentName: "Raquel",
    });
    expect(await resolveVoiceRoute("not-a-token", appDb)).toBeNull();
    await setMode("test");
    expect(await resolveVoiceRoute(token, appDb)).toBeNull();
    await setMode("production", false);
    expect(await resolveVoiceRoute(token, appDb)).toBeNull();
    await setMode("production");
    expect(await resolveVoiceRoute(token, appDb)).not.toBeNull();
    // A disconnected Chatwoot account has nowhere to post the call's note, and its inbox is off.
    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { disconnectedAt: new Date() },
    });
    expect(await resolveVoiceRoute(token, appDb)).toBeNull();
    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { disconnectedAt: null },
    });
    expect(await resolveVoiceRoute(token, appDb)).not.toBeNull();
  });

  test("a call reaches only a conversation of its own inbox", async () => {
    await bindInboxVoiceAgent(
      ctx(tenant),
      whatsappInboxId,
      voiceId,
      fakeChatwoot(),
      appDb,
    );
    const route = await resolveVoiceRoute(await routeToken(), appDb);
    if (!route) throw new Error("the bound inbox has no route");
    const cw = fakeChatwoot({ conversations: { 10: 501, 11: 502 } });
    const fence = (id: number | null) =>
      fenceConversation(route, id, { base: appDb, makeClient: cw.makeClient });
    expect(await fence(10)).toBe(10);
    expect(await fence(11)).toBeNull();
    expect(await fence(12)).toBeNull();
    expect(await fence(null)).toBeNull();
  });

  test("a conversation this product never saw is recorded with its contact, once fenced", async () => {
    const route = await resolveVoiceRoute(await routeToken(), appDb);
    if (!route) throw new Error("no route");
    const cw = fakeChatwoot({
      conversations: { 20: 501, 21: 502 },
      senders: { 20: { id: 77, name: "Ana" }, 21: { id: 78, name: "Bia" } },
    });
    const fence = (id: number) =>
      fenceConversation(route, id, { base: appDb, makeClient: cw.makeClient });
    expect(await fence(20)).toBe(20);
    expect(await fence(21)).toBeNull();
    const rows = await suDb.conversation.findMany({
      where: { tenantId: tenant, chatwootConversationId: { in: [20, 21] } },
      select: {
        chatwootConversationId: true,
        contact: { select: { name: true } },
      },
    });
    expect(rows).toEqual([
      { chatwootConversationId: 20, contact: { name: "Ana" } },
    ]);
  });

  test("every call refreshes the recorded conversation from Chatwoot", async () => {
    const route = await resolveVoiceRoute(await routeToken(), appDb);
    if (!route) throw new Error("no route");
    const opts = {
      conversations: { 22: 501 },
      senders: { 22: { id: 79, name: "Carla" } },
      activityAt: { 22: 1_792_000_000 },
    };
    const cw = fakeChatwoot(opts);
    const fence = () =>
      fenceConversation(route, 22, { base: appDb, makeClient: cw.makeClient });
    expect(await fence()).toBe(22);
    // Renamed in Chatwoot between two calls, on an inbox no webhook reaches.
    opts.senders[22] = { id: 79, name: "Carla Dias" };
    opts.activityAt[22] = 1_792_000_600;
    expect(await fence()).toBe(22);
    const row = await suDb.conversation.findFirst({
      where: { tenantId: tenant, chatwootConversationId: 22 },
      select: { contact: { select: { name: true } } },
    });
    expect(row?.contact?.name).toBe("Carla Dias");
  });

  test("a call is reported only when it is one of the fenced conversation's calls", async () => {
    const route = {
      tenantId: tenant,
      instanceId,
      inboxId: 501,
      agentId: voiceId,
      agentName: "Raquel",
      systemPrompt: "",
    };
    const record = (callId: string): CallRecord => ({
      callId,
      direction: "inbound",
      peer: null,
      provider: "elevenlabs",
      startedAt: "2026-10-16T10:00:00Z",
      answeredAt: "2026-10-16T10:00:01Z",
      endedAt: "2026-10-16T10:01:00Z",
      endedBy: "connector",
      endReason: null,
      engineConversationId: null,
      transcript: [],
    });
    // The call rang, then twenty-five messages were written on the conversation during it.
    const notes = Array.from({ length: 25 }, (_, i) => ({ id: 101 + i }));
    const cw = fakeChatwoot({
      history: { 10: [{ id: 100, call: "own-call" }, ...notes] },
    });
    const deps = {
      summarize: async () => "resumo",
      base: appDb,
      makeClient: cw.makeClient,
    };
    const ctxOf = (conversationId: number | null) => ({
      conversationId,
      inboxId: 501,
      direction: "inbound" as const,
    });
    await reportCall(route, ctxOf(10), record("own-call"), deps);
    await reportCall(route, ctxOf(10), record("other-inbox-call"), deps);
    await reportCall(route, ctxOf(null), record("own-call"), deps);
    expect(cw.reports.map((r) => r.provider_call_id)).toEqual(["own-call"]);
  });

  test("a summary that reads as Liquid reaches the note as written", async () => {
    const cw = fakeChatwoot({ history: { 10: [{ id: 100, call: "c" }] } });
    await reportCall(
      {
        tenantId: tenant,
        instanceId,
        inboxId: 501,
        agentId: voiceId,
        agentName: "Raquel",
        systemPrompt: "",
      },
      { conversationId: 10, inboxId: 501, direction: "inbound" },
      {
        callId: "c",
        direction: "inbound",
        peer: null,
        provider: "elevenlabs",
        startedAt: "2026-10-16T10:00:00Z",
        answeredAt: "2026-10-16T10:00:01Z",
        endedAt: "2026-10-16T10:01:00Z",
        endedBy: "connector",
        endReason: null,
        engineConversationId: null,
        transcript: [],
      },
      {
        summarize: async () => "Pediu o {{contact.email}} de volta",
        base: appDb,
        makeClient: cw.makeClient,
      },
    );
    expect(cw.notes).toHaveLength(1);
    expect(cw.notes[0]).not.toContain("{{contact");
    expect(asRendered(cw.notes[0] ?? "")).toContain("{{contact.email}}");
  });

  test("the agent's switch and mode decide whether the bound inboxes' calls are on", async () => {
    const token = await routeToken();
    const sync = async () => {
      const cw = fakeChatwoot();
      await syncVoiceAgentInboxes(ctx(tenant), voiceId, appDb, cw);
      return cw.writes.map((w) => [
        w.inbox_id,
        w.enabled,
        w.stream_url.endsWith(`/${token}`),
      ]);
    };
    expect(await sync()).toEqual([[501, true, true]]);
    await setMode("test");
    expect(await sync()).toEqual([[501, false, true]]);
    await setMode("production", false);
    expect(await sync()).toEqual([[501, false, true]]);
    await setMode("production");
    expect(await sync()).toEqual([[501, true, true]]);
  });

  test("a mode change that commits while Chatwoot is being written is written too", async () => {
    await setMode("production");
    await bindInboxVoiceAgent(
      ctx(tenant),
      whatsappInboxId,
      voiceId,
      fakeChatwoot(),
      appDb,
    );
    const cw = fakeChatwoot({ duringAiVoice: () => setMode("test") });
    await syncVoiceAgentInboxes(ctx(tenant), voiceId, appDb, cw);
    expect(cw.writes.map((w) => w.enabled)).toEqual([true, false]);
    await setMode("production");
  });

  test("switching the calls off does not wait on the agent's reporting bot", async () => {
    await bindInboxVoiceAgent(
      ctx(tenant),
      whatsappInboxId,
      voiceId,
      fakeChatwoot(),
      appDb,
    );
    await setMode("test");
    const cw = fakeChatwoot({ failAgentBots: true });
    await syncVoiceAgentInboxes(ctx(tenant), voiceId, appDb, cw);
    expect(cw.writes.map((w) => [w.inbox_id, w.enabled])).toEqual([
      [501, false],
    ]);
    await setMode("production");
  });

  test("an inbox removed while its calls were being switched on is switched off again", async () => {
    await setMode("production");
    // An account of its own, removed with its credentials, as a removal does.
    const account = await seedChatwootInstance(suDb, {
      tenantId: tenant,
      baseUrl: "https://chat.voice.test",
      accountId: 9,
      adminToken: encryptJson("admintok"),
    });
    const doomed = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: BigInt(account.id),
        chatwootInboxId: 702,
        name: "Inbox 702",
        channelType: "Channel::Whatsapp",
        voiceAgentId: voiceId,
        voiceRouteToken: encryptJson("rota-702"),
      },
    });
    // The removal commits while the switch-on is on its way, after its own switch-off went out.
    const cw = fakeChatwoot({
      duringAiVoice: async () => {
        await suDb.chatwootInstance.delete({
          where: { id: BigInt(account.id) },
        });
      },
    });
    await syncVoiceInboxes(ctx(tenant), [{ id: doomed.id }], appDb, cw);
    expect(cw.writes.map((w) => [w.inbox_id, w.enabled])).toEqual([
      [702, true],
      [702, false],
    ]);
  });

  test("a binding still moving after every pass is written again a moment later", async () => {
    await setMode("production");
    await bindInboxVoiceAgent(
      ctx(tenant),
      whatsappInboxId,
      voiceId,
      fakeChatwoot(),
      appDb,
    );
    // A switch on every one of the three passes: the last write is the older state.
    const cw = fakeChatwoot({
      duringEachAiVoice: [
        () => setMode("test"),
        () => setMode("production"),
        () => setMode("test"),
      ],
    });
    await syncVoiceAgentInboxes(ctx(tenant), voiceId, appDb, cw);
    expect(cw.writes.map((w) => w.enabled)).toEqual([true, false, true]);
    await until(
      "the retry to write what is stored",
      () => cw.writes.length === 4,
    );
    expect(cw.writes.at(-1)?.enabled).toBe(false);
    await setMode("production");
  });

  test("a token that changes while Chatwoot is being written is written too", async () => {
    await bindInboxVoiceAgent(
      ctx(tenant),
      whatsappInboxId,
      voiceId,
      fakeChatwoot(),
      appDb,
    );
    const before = await routeToken();
    const cw = fakeChatwoot({
      duringAiVoice: async () => {
        await suDb.inbox.update({
          where: { id: whatsappInboxId },
          data: {
            voiceRouteToken: encryptJson("rotated-token"),
            voiceRouteTokenHash: "rotated-hash",
          },
        });
      },
    });
    await syncVoiceAgentInboxes(ctx(tenant), voiceId, appDb, cw);
    expect(cw.writes.map((w) => w.stream_url.split("/").pop())).toEqual([
      before,
      "rotated-token",
    ]);
    const restored = generateRouteToken();
    await suDb.inbox.update({
      where: { id: whatsappInboxId },
      data: {
        voiceRouteToken: encryptJson(restored.token),
        voiceRouteTokenHash: restored.hash,
      },
    });
  });

  test("a disconnected account's inbox does not answer, even with its binding still there", async () => {
    await bindInboxVoiceAgent(
      ctx(tenant),
      whatsappInboxId,
      voiceId,
      fakeChatwoot(),
      appDb,
    );
    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { disconnectedAt: new Date() },
    });
    const cw = fakeChatwoot();
    await syncVoiceAgentInboxes(ctx(tenant), voiceId, appDb, cw);
    expect(cw.writes.map((w) => [w.inbox_id, w.enabled])).toEqual([
      [501, false],
    ]);
    await expect(
      bindInboxVoiceAgent(ctx(tenant), whatsappInboxId, voiceId, cw, appDb),
    ).rejects.toMatchObject({
      statusCode: 409,
      translationKey: "errors.chatwootAccountDisconnected",
    });
    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { disconnectedAt: null },
    });
  });

  test("disconnecting the account unbinds its voice agents and switches its calls off", async () => {
    await bindInboxVoiceAgent(
      ctx(tenant),
      whatsappInboxId,
      voiceId,
      fakeChatwoot(),
      appDb,
    );
    const cw = fakeChatwoot();
    await softDisconnectChatwootInstance(ctx(tenant), instanceId, appDb, cw);
    expect(cw.writes.map((w) => [w.inbox_id, w.enabled])).toEqual([
      [501, false],
    ]);
    const inbox = await suDb.inbox.findUniqueOrThrow({
      where: { id: whatsappInboxId },
    });
    expect(inbox.voiceAgentId).toBeNull();
    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { disconnectedAt: null },
    });
    await suDb.inbox.update({
      where: { id: whatsappInboxId },
      data: { agentId: textId },
    });
  });

  test("an unbind whose write to Chatwoot failed is repaired by the next save of a voice agent", async () => {
    await bindInboxVoiceAgent(
      ctx(tenant),
      whatsappInboxId,
      voiceId,
      fakeChatwoot(),
      appDb,
    );
    await expect(
      bindInboxVoiceAgent(
        ctx(tenant),
        whatsappInboxId,
        null,
        fakeChatwoot({ failAiVoice: true }),
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
    const cw = fakeChatwoot();
    await syncVoiceAgentInboxes(ctx(tenant), voiceId, appDb, cw);
    expect(cw.writes.map((w) => [w.inbox_id, w.enabled])).toEqual([
      [501, false],
    ]);
    await bindInboxVoiceAgent(
      ctx(tenant),
      whatsappInboxId,
      voiceId,
      fakeChatwoot(),
      appDb,
    );
  });

  test("a binding whose bot could not be created switches no calls on, and the next save creates it", async () => {
    await suDb.chatwootAgentBot.deleteMany({ where: { agentId: voiceId } });
    const down = fakeChatwoot({ failAgentBots: true });
    await expect(
      bindInboxVoiceAgent(ctx(tenant), whatsappInboxId, voiceId, down, appDb),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(down.writes).toEqual([]);
    const cw = fakeChatwoot();
    await syncVoiceAgentInboxes(ctx(tenant), voiceId, appDb, cw);
    expect(
      await suDb.chatwootAgentBot.count({ where: { agentId: voiceId } }),
    ).toBe(1);
    expect(cw.writes.map((w) => [w.inbox_id, w.enabled])).toEqual([
      [501, true],
    ]);
  });

  test("only a WhatsApp inbox takes calls, and only a voice agent answers them", async () => {
    const cw = fakeChatwoot();
    await expect(
      bindInboxVoiceAgent(ctx(tenant), apiInboxId, voiceId, cw, appDb),
    ).rejects.toMatchObject({
      statusCode: 422,
      translationKey: "errors.voiceInboxNotWhatsapp",
    });
    await expect(
      bindInboxVoiceAgent(ctx(tenant), whatsappInboxId, textId, cw, appDb),
    ).rejects.toMatchObject({
      statusCode: 422,
      translationKey: "errors.voiceAgentRequired",
    });
    expect(cw.writes).toEqual([]);
    const inbox = await suDb.inbox.findUniqueOrThrow({
      where: { id: whatsappInboxId },
    });
    expect(inbox.voiceAgentId).toBe(voiceId);
  });

  // The fork takes a voice agent only on the connector's own WhatsApp provider: a Cloud inbox is
  // refused here, before the binding is stored, rather than by Chatwoot after it (502, kept).
  test("a WhatsApp inbox on another provider is refused before anything is stored", async () => {
    const cloud = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 531,
        name: "Inbox 531",
        channelType: "Channel::Whatsapp",
        provider: "whatsapp_cloud",
      },
    });
    const cw = fakeChatwoot();
    const refused = {
      statusCode: 422,
      translationKey: "errors.voiceInboxNotConnector",
    };
    await expect(
      checkVoiceBinding(ctx(tenant), cloud.id, voiceId, appDb),
    ).rejects.toMatchObject(refused);
    await expect(
      bindInboxVoiceAgent(ctx(tenant), cloud.id, voiceId, cw, appDb),
    ).rejects.toMatchObject(refused);
    expect(cw.writes).toEqual([]);
    const stored = await suDb.inbox.findUniqueOrThrow({
      where: { id: cloud.id },
    });
    expect([stored.voiceAgentId, stored.voiceRouteToken]).toEqual([null, null]);
    // On the connector's provider it binds.
    await suDb.inbox.update({
      where: { id: cloud.id },
      data: { provider: "native" },
    });
    await bindInboxVoiceAgent(ctx(tenant), cloud.id, voiceId, cw, appDb);
    expect(
      (await suDb.inbox.findUniqueOrThrow({ where: { id: cloud.id } }))
        .voiceAgentId,
    ).toBe(voiceId);
    await bindInboxVoiceAgent(ctx(tenant), cloud.id, null, cw, appDb);
  });

  // A binding stored while the provider was unknown (null takes calls) outlives the discovery that the
  // inbox is on Cloud: clearing it is never refused, or the agent could not be deleted.
  test("a binding on an inbox that turned out not to take calls can still be cleared", async () => {
    const later = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 532,
        name: "Inbox 532",
        channelType: "Channel::Whatsapp",
        provider: null,
      },
    });
    const cw = fakeChatwoot();
    await bindInboxVoiceAgent(ctx(tenant), later.id, voiceId, cw, appDb);
    await suDb.inbox.update({
      where: { id: later.id },
      data: { provider: "whatsapp_cloud" },
    });
    await expect(
      bindInboxVoiceAgent(ctx(tenant), later.id, voiceId, cw, appDb),
    ).rejects.toMatchObject({
      statusCode: 422,
      translationKey: "errors.voiceInboxNotConnector",
    });
    await checkVoiceBinding(ctx(tenant), later.id, null, appDb);
    await bindInboxVoiceAgent(ctx(tenant), later.id, null, cw, appDb);
    expect(
      (await suDb.inbox.findUniqueOrThrow({ where: { id: later.id } }))
        .voiceAgentId,
    ).toBeNull();
    // The same for an inbox that is no longer WhatsApp at all.
    await bindInboxVoiceAgent(ctx(tenant), whatsappInboxId, voiceId, cw, appDb);
    await suDb.inbox.update({
      where: { id: whatsappInboxId },
      data: { channelType: "Channel::Api" },
    });
    await checkVoiceBinding(ctx(tenant), whatsappInboxId, null, appDb);
    await bindInboxVoiceAgent(ctx(tenant), whatsappInboxId, null, cw, appDb);
    await suDb.inbox.update({
      where: { id: whatsappInboxId },
      data: { channelType: "Channel::Whatsapp" },
    });
    expect(
      (await suDb.inbox.findUniqueOrThrow({ where: { id: whatsappInboxId } }))
        .voiceAgentId,
    ).toBeNull();
  });

  test("a voice agent is never an inbox's text responder", async () => {
    await expect(
      bindInbox(ctx(tenant), whatsappInboxId, voiceId, fakeChatwoot(), appDb),
    ).rejects.toMatchObject({
      statusCode: 422,
      translationKey: "errors.voiceAgentNotResponder",
    });
  });

  // Removing an account, or the whole deployment, deletes its inboxes with their route tokens and
  // credentials: their calls are switched off on the fork first, so they ring the team instead of a
  // token nothing answers. Each on a tenant of its own, since the removal takes everything with it.
  for (const removal of ["the account", "the deployment"] as const) {
    test(`removing ${removal} switches its inboxes' calls off first`, async () => {
      const t = (
        await suDb.tenant.create({
          data: {
            name: "Remoção",
            slug: `voice-rm-${removal.length}-${process.pid}`,
          },
        })
      ).id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId: t,
        baseUrl: "https://chat.removal.test",
        accountId: 7,
        adminToken: encryptJson("admintok"),
      });
      const answering = await suDb.agent.create({
        data: {
          tenantId: t,
          name: "Voz",
          kind: "voice",
          systemPrompt: "x",
          mode: "production",
        },
      });
      const routed = await suDb.inbox.create({
        data: {
          tenantId: t,
          chatwootInstanceId: BigInt(inst.id),
          chatwootInboxId: 701,
          name: "Inbox 701",
          channelType: "Channel::Whatsapp",
          voiceAgentId: answering.id,
          voiceRouteToken: encryptJson("rota-701"),
        },
      });
      // A save of the agent landing while the removal switches the calls off: it writes them off
      // too, since the account is already marked gone.
      const racing = fakeChatwoot();
      const cw = fakeChatwoot({
        duringAiVoice: () =>
          syncVoiceAgentInboxes(ctx(t), answering.id, appDb, racing),
      });
      try {
        if (removal === "the account")
          await removeChatwootInstance(ctx(t), BigInt(inst.id), appDb, cw);
        else await disconnectChatwootDeployment(ctx(t), appDb, cw);
        expect(cw.writes).toMatchObject([{ inbox_id: 701, enabled: false }]);
        expect(racing.writes).toMatchObject([
          { inbox_id: 701, enabled: false },
        ]);
        expect(
          await suDb.inbox.findUnique({ where: { id: routed.id } }),
        ).toBeNull();
      } finally {
        await suDb.tenant.delete({ where: { id: t } });
      }
    });
  }

  // Reconnected while the removal switches its calls off: the removal stops at its next batch and the
  // account stays, so the calls it switched off are written again as the binding stands, never left
  // off on an inbox that still has a voice agent.
  // A deployment disconnect switches every account's calls off before emptying the first one. When
  // several accounts are reconnected meanwhile, the first one found stops the teardown, and every one
  // that stays, not only that first, has its calls written back on.
  test("a deployment disconnect stopped by reconnects writes every reconnected account's calls back on", async () => {
    const t = (
      await suDb.tenant.create({
        data: {
          name: "Desconexão desfeita",
          slug: `voice-dep-back-${process.pid}`,
        },
      })
    ).id;
    const answering = await suDb.agent.create({
      data: {
        tenantId: t,
        name: "Voz",
        kind: "voice",
        systemPrompt: "x",
        mode: "production",
      },
    });
    const accounts: bigint[] = [];
    for (const n of [1, 2]) {
      const inst = await seedChatwootInstance(suDb, {
        tenantId: t,
        baseUrl: "https://chat.deployment-back.test",
        accountId: n,
        adminToken: encryptJson("admintok"),
      });
      accounts.push(BigInt(inst.id));
      await suDb.inbox.create({
        data: {
          tenantId: t,
          chatwootInstanceId: BigInt(inst.id),
          chatwootInboxId: 900 + n,
          name: `Inbox ${900 + n}`,
          channelType: "Channel::Whatsapp",
          voiceAgentId: answering.id,
          voiceRouteToken: encryptJson(`rota-${900 + n}`),
        },
      });
    }
    const cw = fakeChatwoot({
      duringAiVoice: async () => {
        for (const id of accounts)
          await reconnectChatwootInstance(ctx(t), id, appDb);
      },
    });
    try {
      await expect(
        disconnectChatwootDeployment(ctx(t), appDb, cw),
      ).rejects.toMatchObject({
        translationKey: "errors.chatwootRemovalReconnected",
      });
      for (const inbox of [901, 902]) {
        expect(
          cw.writes.filter((w) => w.inbox_id === inbox).at(-1),
        ).toMatchObject({ inbox_id: inbox, enabled: true });
      }
    } finally {
      await suDb.tenant.delete({ where: { id: t } });
    }
  });

  test("a removal stopped by a reconnect writes the account's calls back on", async () => {
    const t = (
      await suDb.tenant.create({
        data: {
          name: "Remoção desfeita",
          slug: `voice-rm-back-${process.pid}`,
        },
      })
    ).id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId: t,
      baseUrl: "https://chat.removal-back.test",
      accountId: 8,
      adminToken: encryptJson("admintok"),
    });
    const answering = await suDb.agent.create({
      data: {
        tenantId: t,
        name: "Voz",
        kind: "voice",
        systemPrompt: "x",
        mode: "production",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId: t,
        chatwootInstanceId: BigInt(inst.id),
        chatwootInboxId: 801,
        name: "Inbox 801",
        channelType: "Channel::Whatsapp",
        voiceAgentId: answering.id,
        voiceRouteToken: encryptJson("rota-801"),
      },
    });
    const cw = fakeChatwoot({
      duringAiVoice: async () => {
        await reconnectChatwootInstance(ctx(t), BigInt(inst.id), appDb);
      },
    });
    try {
      await expect(
        removeChatwootInstance(ctx(t), BigInt(inst.id), appDb, cw),
      ).rejects.toMatchObject({
        translationKey: "errors.chatwootRemovalReconnected",
      });
      expect(cw.writes.at(-1)).toMatchObject({ inbox_id: 801, enabled: true });
    } finally {
      await suDb.tenant.delete({ where: { id: t } });
    }
  });

  test("unbinding the inbox's text agent leaves its calls agent bound", async () => {
    await bindInboxVoiceAgent(
      ctx(tenant),
      whatsappInboxId,
      voiceId,
      fakeChatwoot(),
      appDb,
    );
    await bindInbox(ctx(tenant), whatsappInboxId, null, fakeChatwoot(), appDb);
    const row = await suDb.inbox.findUniqueOrThrow({
      where: { id: whatsappInboxId },
    });
    expect([row.agentId, row.voiceAgentId]).toEqual([null, voiceId]);
    await bindInbox(
      ctx(tenant),
      whatsappInboxId,
      textId,
      fakeChatwoot(),
      appDb,
    );
  });

  test("a voice agent bound to an inbox cannot be deleted", async () => {
    await expect(
      deleteAgent(ctx(tenant), voiceId, appDb),
    ).rejects.toMatchObject({
      statusCode: 422,
      translationKey: "errors.agentAnswersCalls",
    });
    expect(await suDb.agent.count({ where: { id: voiceId } })).toBe(1);
  });

  test("a Chatwoot that cannot be written answers 502 and keeps the binding for the next save", async () => {
    await expect(
      bindInboxVoiceAgent(
        ctx(tenant),
        whatsappInboxId,
        null,
        fakeChatwoot({ failAiVoice: true }),
        appDb,
      ),
    ).rejects.toMatchObject({
      statusCode: 502,
      translationKey: "errors.voiceInboxChatwootUnreachable",
    });
    const inbox = await suDb.inbox.findUniqueOrThrow({
      where: { id: whatsappInboxId },
    });
    expect(inbox.voiceAgentId).toBeNull();
  });

  test("unbinding switches the calls off, and the agent can then be deleted", async () => {
    await bindInboxVoiceAgent(
      ctx(tenant),
      whatsappInboxId,
      voiceId,
      fakeChatwoot(),
      appDb,
    );
    const token = await routeToken();
    const cw = fakeChatwoot();
    expect(
      await bindInboxVoiceAgent(ctx(tenant), whatsappInboxId, null, cw, appDb),
    ).toEqual({ voiceAgentId: null });
    expect(cw.writes).toEqual([
      expect.objectContaining({ inbox_id: 501, enabled: false }),
    ]);
    expect(cw.writes[0]?.stream_url).toEndWith(`/${token}`);
    expect(await resolveVoiceRoute(token, appDb)).toBeNull();
    const spare = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "Spare",
        kind: "voice",
        systemPrompt: "x",
      },
    });
    await deleteAgent(ctx(tenant), spare.id, appDb);
    expect(await suDb.agent.count({ where: { id: spare.id } })).toBe(0);
  });

  test("a copy of a voice agent is a voice agent with an ElevenLabs agent of its own", async () => {
    const source = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "Original",
        kind: "voice",
        systemPrompt: "x",
        settings: {
          calls: { providerAgentId: "agent_original", speed: 1.1 },
        },
      },
    });
    const clone = await cloneAgent(ctx(tenant), source.id, "Clone", appDb);
    expect(clone.kind).toBe("voice");
    expect(clone.settings.calls).toEqual({ speed: 1.1 });

    const bundle = await exportAgent(ctx(tenant), source.id, appDb);
    expect(bundle.agent.kind).toBe("voice");
    expect(bundle.agent.settings.calls).toEqual({ speed: 1.1 });
    const imported = await importAgent(
      ctx(tenant),
      { ...bundle, agent: { ...bundle.agent, name: "Importado" } },
      appDb,
    );
    expect(imported.agent.kind).toBe("voice");
    // A bundle from before voice agents has no kind: it is a text agent.
    const { kind: _kind, ...legacy } = bundle.agent;
    const old = await importAgent(
      ctx(tenant),
      { ...bundle, agent: { ...legacy, name: "Antigo" } },
      appDb,
    );
    expect(old.agent.kind).toBe("text");
  });

  test("a settings replacement that leaves the calls block out keeps the ElevenLabs agent id", async () => {
    const stored = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "Substituída",
        kind: "voice",
        systemPrompt: "x",
        settings: { calls: { providerAgentId: "agent_in_use", speed: 1.1 } },
      },
    });
    const updated = await updateAgent(
      ctx(tenant),
      stored.id,
      { settings: {} },
      appDb,
      { settingsMode: "replace" },
    );
    expect(updated.settings.calls).toEqual({
      providerAgentId: "agent_in_use",
    });
  });

  test("an agent created or imported with another's ElevenLabs agent id gets none of its own", async () => {
    // A fresh bag per write: create strips the id from the one it is given.
    const copied = () => ({
      calls: { providerAgentId: "agent_of_another", speed: 1.1 },
    });
    const made = await createAgent(
      ctx(tenant),
      { name: "Copiada", kind: "voice", systemPrompt: "x", settings: copied() },
      appDb,
    );
    expect(made.settings.calls).toEqual({ speed: 1.1 });
    const source = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "Fonte",
        kind: "voice",
        systemPrompt: "x",
      },
    });
    const bundle = await exportAgent(ctx(tenant), source.id, appDb);
    // A bundle written by hand, naming the other agent's id.
    const imported = await importAgent(
      ctx(tenant),
      {
        ...bundle,
        agent: { ...bundle.agent, name: "Importada", settings: copied() },
      },
      appDb,
    );
    expect(imported.agent.settings.calls).toEqual({ speed: 1.1 });
  });

  test("two setups that both found no ElevenLabs agent keep one, and the loser deletes its own", async () => {
    const key = await suDb.vaultEntry.create({
      data: { tenantId: tenant, name: "eleven", secret: encryptJson("xi-key") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "Paralela",
        kind: "voice",
        systemPrompt: "x",
        settings: { calls: { credentialRef: `vault:${key.id}` } },
      },
    });
    const deleted: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted.push(url.split("/").pop() ?? "");
        return new Response("{}");
      }
      if (url.endsWith("/v1/convai/agents/create")) {
        // The other setup, finishing first while this one waited on ElevenLabs.
        await suDb.agent.update({
          where: { id: agent.id },
          data: {
            settings: {
              calls: {
                credentialRef: `vault:${key.id}`,
                providerAgentId: "agent_winner",
              },
            },
          },
        });
        return new Response(JSON.stringify({ agent_id: "agent_mine" }));
      }
      return new Response("{}");
    }) as unknown as typeof fetch;
    const result = await setUpAgentCalls(ctx(tenant), agent.id, {
      fetchImpl,
      base: appDb,
    });
    expect(result.ok && result.setup.providerAgentId).toBe("agent_winner");
    expect(deleted).toEqual(["agent_mine"]);
    const stored = await suDb.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(
      (stored.settings as { calls: { providerAgentId: string } }).calls
        .providerAgentId,
    ).toBe("agent_winner");
  });

  test("a setup that loses the race to one on another key takes the winner's id with the winner's key", async () => {
    const mine = await suDb.vaultEntry.create({
      data: { tenantId: tenant, name: "eleven-a", secret: encryptJson("xi-a") },
      select: { id: true },
    });
    const theirs = await suDb.vaultEntry.create({
      data: { tenantId: tenant, name: "eleven-b", secret: encryptJson("xi-b") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "Troca",
        kind: "voice",
        systemPrompt: "x",
        settings: { calls: { credentialRef: `vault:${mine.id}` } },
      },
    });
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/v1/convai/agents/create")) {
        // The operator switched the key, and a setup on it finished while this one waited.
        await suDb.agent.update({
          where: { id: agent.id },
          data: {
            settings: {
              calls: {
                credentialRef: `vault:${theirs.id}`,
                providerAgentId: "agent_on_b",
              },
            },
          },
        });
        return new Response(JSON.stringify({ agent_id: "agent_on_a" }));
      }
      return new Response("{}");
    }) as unknown as typeof fetch;
    const result = await setUpAgentCalls(ctx(tenant), agent.id, {
      fetchImpl,
      base: appDb,
    });
    expect(
      result.ok && [result.setup.providerAgentId, result.setup.apiKey],
    ).toEqual(["agent_on_b", "xi-b"]);
  });

  test("a key ElevenLabs refuses while the agent is written is the key's problem, not the settings'", async () => {
    const key = await suDb.vaultEntry.create({
      data: {
        tenantId: tenant,
        name: "eleven-bad",
        secret: encryptJson("xi-bad"),
      },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "Chave ruim",
        kind: "voice",
        systemPrompt: "x",
        settings: { calls: { credentialRef: `vault:${key.id}` } },
      },
    });
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          detail: { status: "invalid_api_key", message: "Invalid API key" },
        }),
        { status: 401 },
      )) as unknown as typeof fetch;
    expect(
      await setUpAgentCalls(ctx(tenant), agent.id, { fetchImpl, base: appDb }),
    ).toEqual({ ok: false, problem: "invalid_key", detail: "Invalid API key" });
  });

  test("the agent created on ElevenLabs carries the voice agent's prompt", async () => {
    const key = await suDb.vaultEntry.create({
      data: {
        tenantId: tenant,
        name: "eleven-prompt",
        secret: encryptJson("xi-p"),
      },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "Paula",
        kind: "voice",
        systemPrompt: "Você é a Paula, da padaria.",
        settings: { calls: { credentialRef: `vault:${key.id}` } },
      },
    });
    const bodies: unknown[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/convai/agents/create")) {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ agent_id: "agent_paula" }));
      }
      return new Response("{}");
    }) as unknown as typeof fetch;
    const result = await setUpAgentCalls(ctx(tenant), agent.id, {
      fetchImpl,
      base: appDb,
    });
    expect(result.ok).toBe(true);
    expect(bodies).toMatchObject([
      {
        conversation_config: {
          agent: { prompt: { prompt: "Você é a Paula, da padaria." } },
        },
      },
    ]);
  });

  test("an agent created on a key replaced meanwhile is deleted there, and the setup starts over on the new key", async () => {
    const old = await suDb.vaultEntry.create({
      data: {
        tenantId: tenant,
        name: "eleven-old",
        secret: encryptJson("xi-old"),
      },
      select: { id: true },
    });
    const replacement = await suDb.vaultEntry.create({
      data: {
        tenantId: tenant,
        name: "eleven-new",
        secret: encryptJson("xi-new"),
      },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "Chave trocada",
        kind: "voice",
        systemPrompt: "x",
        settings: { calls: { credentialRef: `vault:${old.id}` } },
      },
    });
    const created: string[] = [];
    const deleted: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("xi-api-key") ?? "";
      if (init?.method === "DELETE") {
        deleted.push(`${url.split("/").pop()} on ${key}`);
        return new Response("{}");
      }
      if (url.endsWith("/v1/convai/agents/create")) {
        created.push(key);
        // The operator switches the key while the first create is in flight; no setup has set an id.
        if (created.length === 1)
          await suDb.agent.update({
            where: { id: agent.id },
            data: {
              settings: { calls: { credentialRef: `vault:${replacement.id}` } },
            },
          });
        return new Response(JSON.stringify({ agent_id: `agent_on_${key}` }));
      }
      return new Response("{}");
    }) as unknown as typeof fetch;
    const result = await setUpAgentCalls(ctx(tenant), agent.id, {
      fetchImpl,
      base: appDb,
    });
    expect(
      result.ok && [result.setup.providerAgentId, result.setup.apiKey],
    ).toEqual(["agent_on_xi-new", "xi-new"]);
    expect(created).toEqual(["xi-old", "xi-new"]);
    expect(deleted).toEqual(["agent_on_xi-old on xi-old"]);
    const stored = await suDb.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(
      (stored.settings as { calls: { providerAgentId: string } }).calls
        .providerAgentId,
    ).toBe("agent_on_xi-new");
  });

  test("a voice agent is created as one, never in monitoring mode, and its kind does not change", async () => {
    const made = await createAgent(
      ctx(tenant),
      { name: "Nova", kind: "voice", systemPrompt: "x" },
      appDb,
    );
    expect(made.kind).toBe("voice");
    expect(
      (
        await createAgent(
          ctx(tenant),
          { name: "Texto", systemPrompt: "x" },
          appDb,
        )
      ).kind,
    ).toBe("text");
    await expect(
      createAgent(
        ctx(tenant),
        { name: "Vigia", kind: "voice", mode: "monitoring", systemPrompt: "x" },
        appDb,
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      translationKey: "errors.voiceAgentMonitoring",
    });
    await expect(
      updateAgent(ctx(tenant), BigInt(made.id), { mode: "monitoring" }, appDb),
    ).rejects.toMatchObject({
      statusCode: 422,
      translationKey: "errors.voiceAgentMonitoring",
    });
    await expect(
      updateAgent(
        ctx(tenant),
        BigInt(made.id),
        { kind: "text" } as Parameters<typeof updateAgent>[2],
        appDb,
      ),
    ).rejects.toThrow("The request is not valid.");
    expect(
      (await suDb.agent.findUniqueOrThrow({ where: { id: BigInt(made.id) } }))
        .kind,
    ).toBe("voice");
  });

  test("a bind waits for a disconnect in flight, and then refuses the disconnected account", async () => {
    await bindInboxVoiceAgent(
      ctx(tenant),
      whatsappInboxId,
      null,
      fakeChatwoot(),
      appDb,
    );
    const cw = fakeChatwoot();
    await expect(
      underConcurrentEdit(
        suDb,
        (tx) =>
          tx.chatwootInstance.update({
            where: { id: instanceId },
            data: { disconnectedAt: new Date() },
          }),
        () =>
          bindInboxVoiceAgent(ctx(tenant), whatsappInboxId, voiceId, cw, appDb),
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      translationKey: "errors.chatwootAccountDisconnected",
    });
    const inbox = await suDb.inbox.findUniqueOrThrow({
      where: { id: whatsappInboxId },
    });
    expect(inbox.voiceAgentId).toBeNull();
    expect(cw.writes).toEqual([]);
    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { disconnectedAt: null },
    });
  });

  test("a bind waits for the agent's deletion in flight, and then finds no agent", async () => {
    const doomed = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "Some",
        kind: "voice",
        systemPrompt: "x",
        mode: "production",
      },
    });
    await expect(
      underConcurrentEdit(
        suDb,
        (tx) => tx.$executeRaw`DELETE FROM agents WHERE id = ${doomed.id}`,
        () =>
          bindInboxVoiceAgent(
            ctx(tenant),
            whatsappInboxId,
            doomed.id,
            fakeChatwoot(),
            appDb,
          ),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    const inbox = await suDb.inbox.findUniqueOrThrow({
      where: { id: whatsappInboxId },
    });
    expect(inbox.voiceAgentId).toBeNull();
  });

  test("saving a text agent writes no inbox's calls; saving a voice agent does", async () => {
    const sync = spyOn(
      voiceInboxes,
      "syncVoiceAgentInboxes",
    ).mockImplementation(async () => {});
    try {
      await updateAgent(ctx(tenant), textId, { enabled: true }, appDb);
      expect(sync).not.toHaveBeenCalled();
      await updateAgent(ctx(tenant), voiceId, { enabled: true }, appDb);
      expect(sync).toHaveBeenCalledTimes(1);
    } finally {
      sync.mockRestore();
    }
  });

  test("each change to who answers an inbox's calls is audited, and a save that changes nothing is not", async () => {
    await bindInboxVoiceAgent(
      ctx(tenant),
      whatsappInboxId,
      null,
      fakeChatwoot(),
      appDb,
    );
    const since = new Date();
    for (const agentId of [voiceId, voiceId, null])
      await bindInboxVoiceAgent(
        ctx(tenant),
        whatsappInboxId,
        agentId,
        fakeChatwoot(),
        appDb,
      );
    const rows = await suDb.auditLog.findMany({
      where: {
        tenantId: tenant,
        target: `inbox:${whatsappInboxId}`,
        createdAt: { gte: since },
      },
      orderBy: { id: "asc" },
      select: { action: true, before: true, after: true },
    });
    expect(rows).toEqual([
      {
        action: "inbox.bind_voice",
        before: { voiceAgentId: null },
        after: { voiceAgentId: String(voiceId) },
      },
      {
        action: "inbox.bind_voice",
        before: { voiceAgentId: String(voiceId) },
        after: { voiceAgentId: null },
      },
    ]);
  });

  // The voice editor's Tools tab offers the account's attributes for a tool's preconditions, and a
  // voice agent reaches an inbox only through its calls.
  test("the editor's label and attribute listings cover the inboxes whose calls the agent answers", async () => {
    const caller = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "Só ligações",
        kind: "voice",
        systemPrompt: "x",
      },
    });
    const calls = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 504,
        name: "Inbox 504",
        channelType: "Channel::Whatsapp",
        voiceAgentId: caller.id,
      },
    });
    const makeClient = async () =>
      ({
        listLabelsDetailed: async () => [{ title: "retorno", color: null }],
        listCustomAttributeDefinitions: async () => [],
      }) as unknown as ChatwootClient;
    try {
      const labels = await listInboxLabels(
        ctx(tenant),
        caller.id,
        { makeClient },
        appDb,
      );
      expect(labels.accountCount).toBe(1);
      expect(labels.labels.map((l) => l.title)).toEqual(["retorno"]);
      const attributes = await listInboxCustomAttributes(
        ctx(tenant),
        caller.id,
        { makeClient },
        appDb,
      );
      expect(attributes.accountCount).toBe(1);
    } finally {
      await suDb.inbox.delete({ where: { id: calls.id } });
      await suDb.agent.delete({ where: { id: caller.id } });
    }
  });

  test("two first bindings of one inbox mint one route token: the second reads the first's", async () => {
    const fresh = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 503,
        name: "Inbox 503",
        channelType: "Channel::Whatsapp",
      },
    });
    const first = generateRouteToken();
    await underConcurrentEdit(
      suDb,
      (tx) =>
        tx.inbox.update({
          where: { id: fresh.id },
          data: {
            voiceRouteToken: encryptJson(first.token),
            voiceRouteTokenHash: first.hash,
          },
        }),
      () =>
        bindInboxVoiceAgent(
          ctx(tenant),
          fresh.id,
          voiceId,
          fakeChatwoot(),
          appDb,
        ),
    );
    const row = await suDb.inbox.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(row.voiceRouteTokenHash).toBe(first.hash);
    await bindInboxVoiceAgent(
      ctx(tenant),
      fresh.id,
      null,
      fakeChatwoot(),
      appDb,
    );
  });

  test("a call's tools are built unmuted, for a call, on the call's HTTP deadline", async () => {
    const route = {
      tenantId: tenant,
      instanceId,
      inboxId: 501,
      agentId: voiceId,
      agentName: "Raquel",
      systemPrompt: "",
    };
    const seen: Parameters<typeof prepare.buildToolset>[1][] = [];
    const configs: Parameters<typeof prepare.buildToolset>[0][] = [];
    const build = spyOn(prepare, "buildToolset").mockImplementation(
      async (cfg, toolsetCtx) => {
        configs.push(cfg);
        seen.push(toolsetCtx);
        return [mcpTool()];
      },
    );
    // The agent's configuration as the turn would load it; what is asked here is how the call
    // builds its tools from it.
    const load = spyOn(prepare, "loadAgentConfig").mockImplementation(
      async () =>
        ({
          systemPrompt: "x",
          agentBotToken: null,
          documentSelections: [{ templateId: "1" }],
        }) as unknown as Awaited<ReturnType<typeof prepare.loadAgentConfig>>,
    );
    // A client that is only what it was asked to be: muted or not, and how it would be built.
    const clientDeps: Array<
      Parameters<typeof chatwootInstance.loadChatwootClient>[2]
    > = [];
    const client = spyOn(
      chatwootInstance,
      "loadChatwootClient",
    ).mockImplementation(async (_tenant, _instance, deps) => {
      clientDeps.push(deps);
      return { muted: deps?.mute === true } as unknown as ChatwootClient;
    });
    let agent: Awaited<ReturnType<typeof loadVoiceAgent>> | undefined;
    try {
      agent = await loadVoiceAgent(route, 20, appDb);
    } finally {
      build.mockRestore();
      load.mockRestore();
      client.mockRestore();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.client.muted).toBe(false);
    expect(seen[0]?.onCall).toBe(true);
    expect(seen[0]?.httpToolTimeoutMs).toBe(CALL_HTTP_TOOL_TIMEOUT_MS);
    // An MCP server's instructions reach the call's prompt, as they reach a text turn's.
    expect(agent?.systemPrompt).toContain("Busque pelo CPF antes do nome.");
    // A document is a file sent to the contact, which a call cannot do.
    expect(configs[0]?.documentSelections).toEqual([]);
    // The outbound tools and the Chatwoot writes send nothing past their invocation's deadline.
    const outbound = seen[0]?.outboundFetch;
    await expect(
      withinInvocation(AbortSignal.abort(), async () =>
        outbound?.("https://8.8.8.8/x"),
      ),
    ).rejects.toThrow("deadline passed");
    const built = await clientDeps[0]?.makeClient?.({
      baseUrl: "https://8.8.8.8",
      accountId: 1,
      adminToken: "a",
      botToken: "b",
    });
    await expect(
      withinInvocation(AbortSignal.abort(), async () =>
        built?.sendPrivateNote(1, "x"),
      ),
    ).rejects.toThrow("deadline passed");
  });

  test("the Playground's call builds its tools as a call does: no documents, the call's HTTP deadline", async () => {
    const seen: Parameters<typeof prepare.buildToolset>[1][] = [];
    const configs: Parameters<typeof prepare.buildToolset>[0][] = [];
    const build = spyOn(prepare, "buildToolset").mockImplementation(
      async (cfg, toolsetCtx) => {
        configs.push(cfg);
        seen.push(toolsetCtx);
        return [mcpTool()];
      },
    );
    // An agent granted a document, as the API or an import can leave a voice agent.
    const load = spyOn(prepare, "loadAgentConfig").mockImplementation(
      async () =>
        ({
          systemPrompt: "x",
          documentSelections: [{ templateId: "1" }],
        }) as unknown as Awaited<ReturnType<typeof prepare.loadAgentConfig>>,
    );
    let agent: Awaited<ReturnType<typeof loadPlaygroundVoiceAgent>> | undefined;
    try {
      agent = await loadPlaygroundVoiceAgent(ctx(tenant), voiceId, appDb);
    } finally {
      build.mockRestore();
      load.mockRestore();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.httpToolTimeoutMs).toBe(CALL_HTTP_TOOL_TIMEOUT_MS);
    expect(configs[0]?.documentSelections).toEqual([]);
    expect(agent?.systemPrompt).toContain("Busque pelo CPF antes do nome.");
    const outbound = seen[0]?.outboundFetch;
    await expect(
      withinInvocation(AbortSignal.abort(), async () =>
        outbound?.("https://8.8.8.8/x"),
      ),
    ).rejects.toThrow("deadline passed");
  });

  test("an agent created over MCP as a voice agent is one", async () => {
    const principal = {
      userId: 1n,
      tenantId: tenant,
      clientId: "c",
      jti: "j",
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
    } as unknown as VerifiedToken;
    const name = `mcp-voice-${Date.now()}`;
    const created = await agentCreate(
      principal,
      { name, kind: "voice", dry_run: false },
      { base: appDb },
    );
    expect(created.ok).toBe(true);
    const row = await suDb.agent.findFirst({
      where: { tenantId: tenant, name },
      select: { kind: true },
    });
    expect(row?.kind).toBe("voice");
  });

  test("the MCP previews of a voice agent's mode and deletion refuse what the applies refuse", async () => {
    const principal = {
      userId: 1n,
      tenantId: tenant,
      clientId: "c",
      jti: "j",
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
    } as unknown as VerifiedToken;
    await bindInboxVoiceAgent(
      ctx(tenant),
      whatsappInboxId,
      voiceId,
      fakeChatwoot(),
      appDb,
    );
    const both = async (
      write: (dryRun: boolean) => Promise<{ ok: boolean }>,
    ) => [(await write(true)).ok, (await write(false)).ok];
    const id = String(voiceId);
    expect(
      await both((dry) =>
        agentUpdate(
          principal,
          { agent_id: id, mode: "monitoring", dry_run: dry },
          { base: appDb },
        ),
      ),
    ).toEqual([false, false]);
    expect(
      await both((dry) =>
        agentDelete(principal, { agent_id: id, dry_run: dry }, { base: appDb }),
      ),
    ).toEqual([false, false]);
  });

  test("the MCP preview of a voice binding refuses what the bind refuses", async () => {
    const principal = {
      userId: 1n,
      tenantId: tenant,
      clientId: "c",
      jti: "j",
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
    } as unknown as VerifiedToken;
    const both = async (inbox: bigint, agent: bigint) => {
      const args = { inbox_id: String(inbox), agent_id: String(agent) };
      const preview = await inboxBindVoice(principal, args, { base: appDb });
      const apply = await inboxBindVoice(
        principal,
        { ...args, dry_run: false },
        { base: appDb },
      );
      return [preview.ok, apply.ok];
    };
    expect(await both(apiInboxId, voiceId)).toEqual([false, false]);
    expect(await both(whatsappInboxId, textId)).toEqual([false, false]);
    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { disconnectedAt: new Date() },
    });
    try {
      expect(await both(whatsappInboxId, voiceId)).toEqual([false, false]);
    } finally {
      await suDb.chatwootInstance.update({
        where: { id: instanceId },
        data: { disconnectedAt: null },
      });
    }
  });
});
