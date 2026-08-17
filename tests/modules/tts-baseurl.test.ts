import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { synthesizeReply } from "@/modules/tts/service";
import { TTS_DEFAULTS, type TtsConfig } from "@/modules/tts/settings";

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
let entryWithBaseUrlId = 0n;
let entryNoBaseUrlId = 0n;

describe.skipIf(!dbUp)("tts: vault entry baseUrl precedence", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "TTSBaseUrl", slug: `tts-bu-${process.pid}` },
    });
    tenantId = t.id;
    const e1 = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "tts-with-base",
        kind: "openai",
        secret: encryptJson("sk-tts"),
        baseUrl: "https://custom.tts-proxy.com/v1",
      },
      select: { id: true },
    });
    entryWithBaseUrlId = e1.id;
    const e2 = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "tts-no-base",
        kind: "openai",
        secret: encryptJson("sk-tts2"),
      },
      select: { id: true },
    });
    entryNoBaseUrlId = e2.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tenantId}`,
      );
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
      return new Response(new ArrayBuffer(16), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }) as unknown as typeof fetch;

    const cfg: TtsConfig = {
      ...TTS_DEFAULTS,
      mode: "mirror",
      provider: "openai",
      model: "tts-1",
      voice: "alloy",
      credentialRef: `vault:${entryWithBaseUrlId}`,
      baseURL: "https://cfg-level-tts.com/v1",
      normalize: false,
    };
    await synthesizeReply({
      tenantId,
      cfg,
      text: "olá",
      base: appDb,
      deps: { fetchImpl: fakeFetch },
    });
    expect(capturedUrls[0]).toContain("custom.tts-proxy.com");
    expect(capturedUrls[0]).not.toContain("cfg-level-tts.com");
  });

  test("cfg.baseURL is used when entry has no baseUrl", async () => {
    const capturedUrls: string[] = [];
    const fakeFetch = (async (url: string) => {
      capturedUrls.push(url);
      return new Response(new ArrayBuffer(16), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }) as unknown as typeof fetch;

    const cfg: TtsConfig = {
      ...TTS_DEFAULTS,
      mode: "mirror",
      provider: "openai",
      model: "tts-1",
      voice: "alloy",
      credentialRef: `vault:${entryNoBaseUrlId}`,
      baseURL: "https://cfg-tts-fallback.com/v1",
      normalize: false,
    };
    await synthesizeReply({
      tenantId,
      cfg,
      text: "olá",
      base: appDb,
      deps: { fetchImpl: fakeFetch },
    });
    expect(capturedUrls[0]).toContain("cfg-tts-fallback.com");
  });
});
