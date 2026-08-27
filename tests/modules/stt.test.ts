import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  clearMediaAnnotations,
  overlayMediaAnnotations,
} from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { ChatwootMessageRow } from "@/modules/chatwoot/messages";
import {
  resolveSttConfig,
  transcribeInboundAudio,
} from "@/modules/stt/service";
import type { SttConfig } from "@/modules/stt/settings";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

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
let sttKeyId = 0n;

const TRANSCRIPT = "olá, gostaria de agendar uma consulta";
const CHATWOOT_INBOX_ID = 7;

function sttFetch(text: string) {
  return (async () =>
    new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function stubClient(meta: Array<Record<string, unknown>>) {
  const client = {
    downloadAttachment: async () => ({
      bytes: new ArrayBuffer(16),
      contentType: "audio/ogg",
    }),
    updateAttachmentMeta: async (
      conversationId: number,
      messageId: number,
      attachmentId: number,
      m: Record<string, unknown>,
    ) => {
      meta.push({ conversationId, messageId, attachmentId, meta: m });
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

describe.skipIf(!dbUp)("stt", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "STT", slug: `stt-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const sttKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "stt-key", secret: encryptJson("sk-stt") },
      select: { id: true },
    });
    sttKeyId = sttKey.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "x",
        settings: {
          stt: {
            enabled: true,
            provider: "openai",
            credentialRef: `vault:${sttKeyId}`,
          },
        },
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "Suporte",
        agentId: agent.id,
      },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
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

  test("resolveSttConfig returns the agent's enabled config", async () => {
    const cfg = await resolveSttConfig(
      tenantId,
      instanceId,
      CHATWOOT_INBOX_ID,
      appDb,
    );
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.provider).toBe("openai");
    expect(cfg?.credentialRef).toBe(`vault:${sttKeyId}`);
  });

  test("resolveSttConfig returns null for an unbound inbox", async () => {
    expect(await resolveSttConfig(tenantId, instanceId, 999, appDb)).toBeNull();
  });

  test("transcribeInboundAudio downloads, transcribes, and writes back the meta", async () => {
    const cfg = (await resolveSttConfig(
      tenantId,
      instanceId,
      CHATWOOT_INBOX_ID,
      appDb,
    )) as SttConfig;
    const meta: Array<Record<string, unknown>> = [];
    const text = await transcribeInboundAudio({
      tenantId,
      instanceId,
      conversationId: 900,
      messageId: 50,
      attachmentId: 9,
      dataUrl: "https://chat.example.com/audio.ogg",
      cfg,
      base: appDb,
      deps: { makeClient: stubClient(meta), fetchImpl: sttFetch(TRANSCRIPT) },
    });
    expect(text).toBe(TRANSCRIPT);
    expect(meta).toEqual([
      {
        conversationId: 900,
        messageId: 50,
        attachmentId: 9,
        meta: { transcribed_text: TRANSCRIPT },
      },
    ]);
  });

  test("transcribeInboundAudio returns null when no credential is configured", async () => {
    const meta: Array<Record<string, unknown>> = [];
    const text = await transcribeInboundAudio({
      tenantId,
      instanceId,
      conversationId: 901,
      messageId: 51,
      attachmentId: 10,
      dataUrl: "https://chat.example.com/audio.ogg",
      cfg: {
        enabled: true,
        provider: "openai",
        model: "",
        language: "pt",
        credentialRef: null,
        baseURL: null,
      },
      base: appDb,
      deps: { makeClient: stubClient(meta), fetchImpl: sttFetch(TRANSCRIPT) },
    });
    expect(text).toBeNull();
    expect(meta).toEqual([]);
  });

  test("issue #49: a write-back failure (upstream Chatwoot) keeps the transcription, stashes the annotation, and logs a warn", async () => {
    clearMediaAnnotations();
    const cfg = (await resolveSttConfig(
      tenantId,
      instanceId,
      CHATWOOT_INBOX_ID,
      appDb,
    )) as SttConfig;
    const client = {
      downloadAttachment: async () => ({
        bytes: new ArrayBuffer(16),
        contentType: "audio/ogg",
      }),
      // NOTE: Upstream Chatwoot: the fork-only PATCH route does not exist.
      updateAttachmentMeta: async () => {
        throw new Error("HTTP 404: route not found");
      },
    } as unknown as ChatwootClient;
    const turnId = crypto.randomUUID();
    const text = await transcribeInboundAudio({
      tenantId,
      instanceId,
      conversationId: 903,
      messageId: 60,
      attachmentId: 12,
      dataUrl: "https://chat.example.com/audio.ogg",
      cfg,
      base: appDb,
      deps: { makeClient: async () => client, fetchImpl: sttFetch(TRANSCRIPT) },
      flow: {
        tenantId,
        turnId,
        source: "inbox",
        threadId: `${tenantId}:${instanceId}:903`,
        base: appDb,
      },
    });
    // NOTE: The transcription survives the lost write-back...
    expect(text).toBe(TRANSCRIPT);
    // NOTE: ...and lands in the in-process annotation store so the flush overlay can read it.
    const rows: ChatwootMessageRow[] = [
      {
        id: 60,
        content: "",
        messageType: "incoming" as const,
        private: false,
        attachmentTypes: ["audio"],
        transcribedText: null,
        imageDescription: null,
        extractedText: null,
        attachmentName: null,
        inReplyTo: null,
        isReaction: false,
        location: null,
      },
    ];
    overlayMediaAnnotations(tenantId, instanceId, rows);
    expect(rows[0]?.transcribedText).toBe(TRANSCRIPT);
    // NOTE: The lost write-back is observable on the flow log (stt stage, warn, step write_back).
    let warned = false;
    for (let i = 0; i < 30 && !warned; i++) {
      const logs = await flowLogRows(suDb, {
        where: { tenantId, turnId, stage: "stt", level: "warn" },
        select: { detail: true },
      });
      warned = logs.some(
        (r) =>
          (r.detail as Record<string, unknown> | null)?.step === "write_back",
      );
      if (!warned) await new Promise((r) => setTimeout(r, 100));
    }
    expect(warned).toBe(true);
  });

  test("issue #49: the annotation is stashed even when the fork write-back succeeds", async () => {
    clearMediaAnnotations();
    const cfg = (await resolveSttConfig(
      tenantId,
      instanceId,
      CHATWOOT_INBOX_ID,
      appDb,
    )) as SttConfig;
    const meta: Array<Record<string, unknown>> = [];
    const text = await transcribeInboundAudio({
      tenantId,
      instanceId,
      conversationId: 904,
      messageId: 61,
      attachmentId: 13,
      dataUrl: "https://chat.example.com/audio.ogg",
      cfg,
      base: appDb,
      deps: { makeClient: stubClient(meta), fetchImpl: sttFetch(TRANSCRIPT) },
    });
    expect(text).toBe(TRANSCRIPT);
    expect(meta).toHaveLength(1);
    const rows: ChatwootMessageRow[] = [
      {
        id: 61,
        content: "",
        messageType: "incoming" as const,
        private: false,
        attachmentTypes: ["audio"],
        transcribedText: null,
        imageDescription: null,
        extractedText: null,
        attachmentName: null,
        inReplyTo: null,
        isReaction: false,
        location: null,
      },
    ];
    overlayMediaAnnotations(tenantId, instanceId, rows);
    expect(rows[0]?.transcribedText).toBe(TRANSCRIPT);
  });

  test("the Amara.org hallucination is dropped (no write-back)", async () => {
    const cfg = (await resolveSttConfig(
      tenantId,
      instanceId,
      CHATWOOT_INBOX_ID,
      appDb,
    )) as SttConfig;
    const meta: Array<Record<string, unknown>> = [];
    const text = await transcribeInboundAudio({
      tenantId,
      instanceId,
      conversationId: 902,
      messageId: 52,
      attachmentId: 11,
      dataUrl: "https://chat.example.com/audio.ogg",
      cfg,
      base: appDb,
      deps: {
        makeClient: stubClient(meta),
        fetchImpl: sttFetch("Legendas pela comunidade Amara.org"),
      },
    });
    expect(text).toBeNull();
    expect(meta).toEqual([]);
  });
});
