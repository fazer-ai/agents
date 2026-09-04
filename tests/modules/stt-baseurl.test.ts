import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { transcribeInboundAudio } from "@/modules/stt/service";
import type { SttConfig } from "@/modules/stt/settings";
import { seedChatwootInstance } from "../utils/chatwoot";

// Verifies that the vault entry's baseUrl takes precedence over cfg.baseURL when calling the provider.

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
let entryWithBaseUrlId = 0n;
let entryNoBaseUrlId = 0n;

describe.skipIf(!dbUp)("stt: vault entry baseUrl precedence", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "STTBaseUrl", slug: `stt-bu-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("A"),
    });
    instanceId = inst.id;
    const e1 = await suDb.vaultEntry.create({
      data: {
        tenantId,
        // NOTE: `openai_compatible` and not `openai`, since #504: a base URL is only DIALLED for a
        // kind whose catalog entry declares one, so a row with `kind: "openai"` and a base URL is a
        // stray value the resolve now answers `null` for. What this file is about — the entry's base
        // winning over the config's — is unchanged, and this is the kind that can carry one.
        name: "stt-with-base",
        kind: "openai_compatible",
        secret: encryptJson("sk-stt"),
        baseUrl: "https://custom.openai-proxy.com/v1",
      },
      select: { id: true },
    });
    entryWithBaseUrlId = e1.id;
    const e2 = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "stt-no-base",
        kind: "openai",
        secret: encryptJson("sk-stt2"),
      },
      select: { id: true },
    });
    entryNoBaseUrlId = e2.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of ["vault_entries", "chatwoot_instances"]) {
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

  test("entry.baseUrl overrides cfg.baseURL", async () => {
    const capturedUrls: string[] = [];
    const fakeFetch = (async (url: string) => {
      capturedUrls.push(url);
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const cfg: SttConfig = {
      enabled: true,
      provider: "openai",
      model: "whisper-1",
      language: "pt",
      credentialRef: `vault:${entryWithBaseUrlId}`,
      baseURL: "https://cfg-level-base.com/v1", // should be overridden
    };
    const stubClient = {
      downloadAttachment: async () => ({
        bytes: new ArrayBuffer(8),
        contentType: "audio/ogg",
      }),
      updateAttachmentMeta: async () => ({}),
    } as unknown as ChatwootClient;

    await transcribeInboundAudio({
      tenantId,
      instanceId,
      conversationId: 1,
      messageId: 1,
      attachmentId: 1,
      dataUrl: "https://chat.example.com/a.ogg",
      cfg,
      base: appDb,
      deps: {
        makeClient: async () => stubClient,
        fetchImpl: fakeFetch,
      },
    });
    // The URL must use the vault entry's baseUrl, not cfg.baseURL.
    expect(capturedUrls[0]).toContain("custom.openai-proxy.com");
    expect(capturedUrls[0]).not.toContain("cfg-level-base.com");
  });

  test("cfg.baseURL is used when entry has no baseUrl", async () => {
    const capturedUrls: string[] = [];
    const fakeFetch = (async (url: string) => {
      capturedUrls.push(url);
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const cfg: SttConfig = {
      enabled: true,
      provider: "openai",
      model: "whisper-1",
      language: "pt",
      credentialRef: `vault:${entryNoBaseUrlId}`,
      baseURL: "https://cfg-fallback.com/v1",
    };
    const stubClient = {
      downloadAttachment: async () => ({
        bytes: new ArrayBuffer(8),
        contentType: "audio/ogg",
      }),
      updateAttachmentMeta: async () => ({}),
    } as unknown as ChatwootClient;

    await transcribeInboundAudio({
      tenantId,
      instanceId,
      conversationId: 2,
      messageId: 2,
      attachmentId: 2,
      dataUrl: "https://chat.example.com/b.ogg",
      cfg,
      base: appDb,
      deps: {
        makeClient: async () => stubClient,
        fetchImpl: fakeFetch,
      },
    });
    // The URL must use cfg.baseURL as the fallback.
    expect(capturedUrls[0]).toContain("cfg-fallback.com");
  });
});
