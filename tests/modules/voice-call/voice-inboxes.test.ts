import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import config from "@/config";
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
import {
  bindInbox,
  softDisconnectChatwootInstance,
} from "@/modules/chatwoot/management";
import type { CallRecord } from "@/modules/voice-call/bridge";
import * as voiceInboxes from "@/modules/voice-call/inboxes";
import {
  bindInboxVoiceAgent,
  syncVoiceAgentInboxes,
  voiceStreamUrl,
} from "@/modules/voice-call/inboxes";
import {
  fenceConversation,
  reportCall,
  resolveVoiceRoute,
} from "@/modules/voice-call/service";
import { setUpAgentCalls } from "@/modules/voice-call/setup";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import { dbProbeFailed } from "@/tests/db-gate";
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
    // conversation id -> the Chatwoot inbox it is in
    conversations?: Record<number, number>;
    // conversation id -> its messages, oldest first, each a call's when it names one
    history?: Record<number, Array<{ id: number; call?: string }>>;
    // conversation id -> the contact Chatwoot names on it
    senders?: Record<number, { id: number; name: string }>;
  } = {},
) {
  const writes: AiVoice[] = [];
  const reports: Array<{ provider_call_id: string }> = [];
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
        const during = opts.duringAiVoice;
        opts.duringAiVoice = undefined;
        await during?.();
      }
    } else if (path.endsWith("/whatsapp_calls/ai_report")) {
      reports.push(body);
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
        answer = {
          id,
          inbox_id: inbox,
          status: "open",
          ...(sender ? { meta: { sender } } : {}),
        };
      }
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
  return { writes, reports, makeClient };
}

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

  test("a voice agent is never an inbox's text responder", async () => {
    await expect(
      bindInbox(ctx(tenant), whatsappInboxId, voiceId, fakeChatwoot(), appDb),
    ).rejects.toMatchObject({
      statusCode: 422,
      translationKey: "errors.voiceAgentNotResponder",
    });
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
          calls: { elevenLabsAgentId: "agent_original", speed: 1.1 },
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
                elevenLabsAgentId: "agent_winner",
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
    expect(result.ok && result.setup.elevenLabsAgentId).toBe("agent_winner");
    expect(deleted).toEqual(["agent_mine"]);
    const stored = await suDb.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(
      (stored.settings as { calls: { elevenLabsAgentId: string } }).calls
        .elevenLabsAgentId,
    ).toBe("agent_winner");
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
});
