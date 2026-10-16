import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import {
  createAgent,
  deleteAgent,
  listAgentsPaged,
  updateAgent,
} from "@/modules/agents/service";
import {
  type ChatwootClient,
  createChatwootClient,
} from "@/modules/chatwoot/client";
import { bindInbox } from "@/modules/chatwoot/management";
import {
  bindInboxVoiceAgent,
  syncVoiceAgentInboxes,
  voiceStreamUrl,
} from "@/modules/voice-call/inboxes";
import { resolveVoiceRoute } from "@/modules/voice-call/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../../utils/chatwoot";

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

function fakeChatwoot(opts: { failAiVoice?: boolean } = {}) {
  const writes: AiVoice[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const path = new URL(url).pathname;
    let status = 200;
    let answer: unknown = body ?? {};
    if (path.endsWith("/whatsapp_calls/ai_voice")) {
      if (opts.failAiVoice) status = 503;
      else writes.push(body);
    } else if (path.endsWith("/agent_bots")) {
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
  return { writes, makeClient };
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
      "chatwoot_agent_bots",
      "inboxes",
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
});
