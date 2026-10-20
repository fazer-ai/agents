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
  transcribeClientAudio,
  transcribeInboundAudio,
  transcribePlaygroundAudio,
} from "@/modules/stt/service";
import type { SttConfig } from "@/modules/stt/settings";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";
import { until } from "../utils/poll";

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

let tenantId = 0n;
let instanceId = 0n;
let sttKeyId = 0n;
let agentId = 0n;

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
    agentId = agent.id;
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
    // ...and lands in the in-process annotation store so the flush overlay can read it.
    const rows: ChatwootMessageRow[] = [
      {
        id: 60,
        content: "",
        messageType: "incoming" as const,
        private: false,
        sendId: null,
        emailSubject: null,
        attachmentTypes: ["audio"],
        transcribedText: null,
        imageDescription: null,
        extractedText: null,
        attachmentName: null,
        inReplyTo: null,
        isReaction: false,
        activityType: null,
        senderType: null,
        visuals: [],
        externalSenderName: null,
        imported: false,
        senderId: null,
        location: null,
      },
    ];
    overlayMediaAnnotations(tenantId, instanceId, rows);
    expect(rows[0]?.transcribedText).toBe(TRANSCRIPT);
    // The lost write-back is observable on the flow log (stt stage, warn, step write_back).
    const warned = await until("the write_back warn", async () => {
      const logs = await flowLogRows(suDb, {
        where: { tenantId, turnId, stage: "stt", level: "warn" },
        select: { detail: true },
      });
      return logs.some(
        (r) =>
          (r.detail as Record<string, unknown> | null)?.step === "write_back",
      );
    });
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
        sendId: null,
        emailSubject: null,
        attachmentTypes: ["audio"],
        transcribedText: null,
        imageDescription: null,
        extractedText: null,
        attachmentName: null,
        inReplyTo: null,
        isReaction: false,
        activityType: null,
        senderType: null,
        visuals: [],
        externalSenderName: null,
        imported: false,
        senderId: null,
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
  // A hallucination on silence or noise arrives as fluent text; only the provider's own confidence
  // gives it away. It reaches nobody: not the agent, not the attachment meta, not the flow log.
  test("a transcription the model was unsure of is withheld, logged without its text, and not asked for again", async () => {
    clearMediaAnnotations();
    const cfg = (await resolveSttConfig(
      tenantId,
      instanceId,
      CHATWOOT_INBOX_ID,
      appDb,
    )) as SttConfig;
    const meta: Array<Record<string, unknown>> = [];
    let asked = 0;
    const fetchImpl = (async () => {
      asked++;
      return new Response(
        JSON.stringify({
          text: "Das ist gut.",
          logprobs: [
            { token: "Das", logprob: -1.9, bytes: [] },
            { token: " ist", logprob: -2.1, bytes: [] },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const turnId = crypto.randomUUID();
    const deliver = () =>
      transcribeInboundAudio({
        tenantId,
        instanceId,
        conversationId: 904,
        messageId: 61,
        attachmentId: 13,
        dataUrl: "https://chat.example.com/audio.ogg",
        cfg,
        base: appDb,
        deps: { makeClient: stubClient(meta), fetchImpl },
        flow: {
          tenantId,
          turnId,
          source: "inbox",
          threadId: `${tenantId}:${instanceId}:904`,
          base: appDb,
        },
      });
    expect(await deliver()).toBeNull();
    // Chatwoot delivers a voice note more than once; the next delivery must not draw a new sample.
    expect(await deliver()).toBeNull();
    expect(asked).toBe(1);
    expect(meta).toEqual([]);
    const rows = await until("the stt line", async () => {
      const found = (await flowLogRows(suDb, {
        where: { tenantId, turnId, stage: "stt" },
        select: { status: true, detail: true },
      })) as Array<{ status: string; detail: unknown }>;
      return found.length > 0 ? found : null;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.detail).toEqual({
      signal: "token_logprob",
      meanLogprob: -2,
      withheld: "low_confidence",
    });
    expect(JSON.stringify(rows)).not.toContain("Das ist");
  });
  // The playground shows the operator an empty transcription for silence and for a withheld one alike;
  // the stt line, with the score, is what tells them apart.
  test("a playground transcription logs its confidence on the stt line, withheld, kept or empty", async () => {
    const lowThenHigh = [
      { text: "Das ist gut.", logprobs: [{ token: "x", logprob: -2.5 }] },
      { text: "Oi, tudo bem?", logprobs: [{ token: "x", logprob: -0.05 }] },
      { text: "" },
    ];
    const turnIds: string[] = [];
    const out: string[] = [];
    for (const body of lowThenHigh) {
      const turnId = crypto.randomUUID();
      turnIds.push(turnId);
      out.push(
        await transcribePlaygroundAudio({
          ctx: { tenantId, userId: null, role: "TENANT_ADMIN" },
          agentId,
          audio: new ArrayBuffer(16),
          mimeType: "audio/ogg",
          base: appDb,
          deps: {
            fetchImpl: (async () =>
              new Response(JSON.stringify(body), {
                status: 200,
              })) as unknown as typeof fetch,
          },
          flow: { tenantId, turnId, source: "playground", base: appDb },
        }),
      );
    }
    expect(out).toEqual(["", "Oi, tudo bem?", ""]);
    const details: unknown[] = [];
    for (const turnId of turnIds) {
      const rows = await until("the playground stt line", async () => {
        const found = (await flowLogRows(suDb, {
          where: { tenantId, turnId, stage: "stt", source: "playground" },
          select: { detail: true },
        })) as Array<{ detail: unknown }>;
        return found.length > 0 ? found : null;
      });
      details.push(rows[0]?.detail);
    }
    expect(details).toEqual([
      {
        signal: "token_logprob",
        meanLogprob: -2.5,
        withheld: "low_confidence",
      },
      { signal: "token_logprob", meanLogprob: -0.05 },
      // Nothing heard: no confidence to report, and the line still says why the note is empty.
      { empty: true },
    ]);
  });
  // The SDK widget's voice message: its stt line is the client channel's, naming the agent and the
  // audience as the turn's lines do, and the channel's own ceiling refuses it before the provider.
  test("a client transcription logs a client stt line naming the agent and the audience", async () => {
    const appCtx = {
      tenantId,
      userId: null,
      role: "TENANT_ADMIN" as const,
      actorType: "system" as const,
    };
    const turnId = crypto.randomUUID();
    const text = await transcribeClientAudio({
      ctx: appCtx,
      turnId,
      agentId,
      audio: new ArrayBuffer(16),
      mimeType: "audio/webm",
      anonymous: true,
      base: appDb,
      deps: {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ text: "Quero ver minhas notas." }), {
            status: 200,
          })) as unknown as typeof fetch,
      },
    });
    const rows = await until("the client stt line", async () => {
      const found = (await flowLogRows(suDb, {
        where: { tenantId, turnId, stage: "stt", source: "client" },
        select: { agentId: true, anonymous: true, status: true },
      })) as Array<{
        agentId: bigint | null;
        anonymous: boolean;
        status: string;
      }>;
      return found.length > 0 ? found : null;
    });
    expect({ text, rows }).toEqual({
      text: "Quero ver minhas notas.",
      rows: [{ agentId, anonymous: true, status: "ok" }],
    });
  });

  // A ceiling gate sits immediately before the call it guards: an agent whose speech-to-text could
  // never run is told so, over the ceiling or not, and no refusal is logged for a call that was not
  // going to happen.
  test("over the client ceiling, an agent with speech-to-text off is refused for that, not the ceiling", async () => {
    const monthStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    );
    const mute = await suDb.agent.create({
      data: {
        tenantId,
        name: "Sem voz",
        systemPrompt: "x",
        settings: { stt: { enabled: false, provider: "openai" } },
      },
    });
    await suDb.tenant.update({
      where: { id: tenantId },
      data: {
        settings: { spendCeiling: { enabled: true, monthlyClientUsd: 10 } },
      },
    });
    await suDb.spendCostSnapshot.create({
      data: {
        tenantId,
        source: "client",
        monthStart,
        costUsd: 1000,
        polledAt: new Date(),
      },
    });
    try {
      const refusal = (await transcribeClientAudio({
        ctx: { tenantId, userId: null, role: "TENANT_ADMIN" },
        agentId: mute.id,
        audio: new ArrayBuffer(16),
        mimeType: "audio/webm",
        anonymous: false,
        base: appDb,
      }).catch((e: unknown) => e)) as { statusCode?: number; message?: string };
      expect({ status: refusal.statusCode, message: refusal.message }).toEqual({
        status: 400,
        message: "speech-to-text is not configured",
      });
    } finally {
      await suDb.tenant.update({
        where: { id: tenantId },
        data: { settings: {} },
      });
      await suDb.spendCostSnapshot.deleteMany({ where: { tenantId } });
      await suDb.agent.delete({ where: { id: mute.id } });
    }
  });

  test("a client transcription is refused at the client channel's ceiling, before the provider", async () => {
    const monthStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    );
    await suDb.tenant.update({
      where: { id: tenantId },
      data: {
        settings: { spendCeiling: { enabled: true, monthlyClientUsd: 10 } },
      },
    });
    await suDb.spendCostSnapshot.create({
      data: {
        tenantId,
        source: "client",
        monthStart,
        costUsd: 1000,
        polledAt: new Date(),
      },
    });
    let asked = 0;
    try {
      const refusal = await transcribeClientAudio({
        ctx: { tenantId, userId: null, role: "TENANT_ADMIN" },
        agentId,
        audio: new ArrayBuffer(16),
        mimeType: "audio/webm",
        anonymous: false,
        base: appDb,
        deps: {
          fetchImpl: (async () => {
            asked++;
            return new Response(JSON.stringify({ text: "x" }));
          }) as unknown as typeof fetch,
        },
      }).catch((e: unknown) => e);
      expect({
        status: (refusal as { statusCode?: number }).statusCode,
        message: (refusal as Error).message,
        asked,
      }).toEqual({
        status: 429,
        message:
          "the client channel spend ceiling for this month has been reached",
        asked: 0,
      });
    } finally {
      await suDb.tenant.update({
        where: { id: tenantId },
        data: { settings: {} },
      });
      await suDb.spendCostSnapshot.deleteMany({ where: { tenantId } });
    }
  });
});
