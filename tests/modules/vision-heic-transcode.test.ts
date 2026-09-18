import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  extractInboundFile,
  resolveVisionConfig,
} from "@/modules/vision/service";
import type { VisionConfig } from "@/modules/vision/settings";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #697: an iPhone photo arrives as `image/heic`, which OpenAI and Anthropic do not accept and
// Gemini does. It used to go to the provider untouched, come back 400, and the customer was told
// their photo could not be read.
//
// The fetch below personifies OpenAI's own validation rather than nodding at it. Both branches were
// measured against the live API on 2026-09-17 (gpt-4o-mini), with the very fixture this test loads:
//
//   data:image/heic -> 400 invalid_request_error / invalid_image_format, and the message below,
//                      character for character, including the format list the vendor enumerates
//   data:image/png  -> 200, and the model transcribed "R$ 1.480,00" off the image
//
// So a request this test accepts is one the vendor accepts, and a regression that stops converting
// shows up here as the vendor's own 400 instead of as a green test.
//
// FIXTURE: `tests/fixtures/media/recibo.heic` is a 2400x1600 HEIC (HEVC) carrying the legible text
// "R$ 1.480,00", made on macOS with `sips -s format heic` from a generated PNG. Its CONTENT is what
// made the live probe provable (the model read the value back); here only its container matters.

const HEIC = readFileSync(`${import.meta.dir}/../fixtures/media/recibo.heic`);
const OPENAI_FORMATS = ["png", "jpeg", "gif", "webp"];
const EXTRACTED = "um recibo de R$ 1.480,00";

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
let keyId = 0n;
const CHATWOOT_INBOX_ID = 27;

type Part = { type?: string; image_url?: { url?: string } };

// OpenAI's validation of an `image_url` part, as measured.
function openaiFetch() {
  const mimes: string[] = [];
  const impl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}") as {
      messages?: Array<{ content?: Part[] }>;
    };
    const uri = body.messages?.[0]?.content?.[1]?.image_url?.url ?? "";
    const mime = /^data:([^;]+);base64,/.exec(uri)?.[1] ?? "";
    mimes.push(mime);
    const subtype = mime.startsWith("image/") ? mime.slice(6) : "";
    if (!OPENAI_FORMATS.includes(subtype)) {
      return new Response(
        JSON.stringify({
          error: {
            message: `You uploaded an unsupported image. Please make sure your image has of one the following formats: ['${OPENAI_FORMATS.join("', '")}'].`,
            type: "invalid_request_error",
            code: "invalid_image_format",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: EXTRACTED } }],
        usage: { prompt_tokens: 1200, completion_tokens: 12 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, mimes };
}

// Gemini's shape, where the mime rides on `inline_data.mime_type`. It is here to prove the OTHER
// direction: Gemini documents `image/heic` as input, so a HEIC must arrive UNTOUCHED and the
// conversion must not fire just because the type is exotic.
function geminiFetch() {
  const mimes: string[] = [];
  const impl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}") as {
      contents?: Array<{
        parts?: Array<{ inline_data?: { mime_type?: string } }>;
      }>;
    };
    mimes.push(body.contents?.[0]?.parts?.[1]?.inline_data?.mime_type ?? "");
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: EXTRACTED }] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, mimes };
}

function stubClient(bytes: Buffer, contentType: string) {
  return async () =>
    ({
      downloadAttachment: async () => ({
        bytes: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
        contentType,
      }),
      updateAttachmentMeta: async () => ({}),
    }) as unknown as ChatwootClient;
}

describe.skipIf(!dbUp)("heic transcode before the vision call", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "VISION HEIC", slug: `vision-heic-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 37,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const key = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "vision-openai",
        secret: encryptJson("sk-openai"),
      },
      select: { id: true },
    });
    keyId = key.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "x",
        settings: {
          vision: {
            enabled: true,
            provider: "openai",
            credentialRef: `vault:${keyId}`,
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

  async function cfg(provider?: string): Promise<VisionConfig> {
    const resolved = (await resolveVisionConfig(
      tenantId,
      instanceId,
      CHATWOOT_INBOX_ID,
      appDb,
    )) as VisionConfig;
    return provider ? { ...resolved, provider } : resolved;
  }

  test("a HEIC photo reaches OpenAI as jpeg, and is read", async () => {
    const { impl, mimes } = openaiFetch();
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 900,
      messageId: 60,
      attachmentId: 6,
      dataUrl: "https://chat.example.com/IMG_0001.heic",
      cfg: await cfg(),
      base: appDb,
      deps: {
        makeClient: stubClient(HEIC, "image/heic"),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    // What the vendor was handed: a format it accepts, on the FIRST attempt (a 400 is permanent, so
    // there is no second one to hide behind).
    expect(mimes).toEqual(["image/jpeg"]);
    expect(out?.kind).toBe("image");
    expect(out?.text).toBe(EXTRACTED);
  });

  test("the same photo goes to Gemini untouched, because Gemini reads HEIC", async () => {
    const { impl, mimes } = geminiFetch();
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 901,
      messageId: 61,
      attachmentId: 7,
      dataUrl: "https://chat.example.com/IMG_0002.heic",
      cfg: await cfg("gemini"),
      base: appDb,
      deps: {
        makeClient: stubClient(HEIC, "image/heic"),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(mimes).toEqual(["image/heic"]);
    expect(out?.text).toBe(EXTRACTED);
  });

  test("a webp is not converted for nothing", async () => {
    // The 98.6% case. A type the provider reads must never pay the decode, and the bytes the vendor
    // gets must be the ones the customer sent.
    const webp = Buffer.from("RIFF....WEBPVP8 ", "latin1");
    const { impl, mimes } = openaiFetch();
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 902,
      messageId: 62,
      attachmentId: 8,
      dataUrl: "https://chat.example.com/foto.webp",
      cfg: await cfg(),
      base: appDb,
      deps: {
        makeClient: stubClient(webp, "image/webp"),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(mimes).toEqual(["image/webp"]);
    expect(out?.text).toBe(EXTRACTED);
  });

  test("an endpoint we cannot speak for gets the jpeg, not the gamble", async () => {
    // `openai-compatible` is whatever the operator pointed at, so nothing here knows whether it
    // reads a HEIC. Handing over a JPEG is the answer every vendor on the table accepts.
    const { impl, mimes } = openaiFetch();
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 903,
      messageId: 63,
      attachmentId: 9,
      dataUrl: "https://chat.example.com/IMG_0003.heic",
      cfg: {
        ...(await cfg("openai-compatible")),
        baseURL: "https://llm.exemplo.com/v1",
        model: "algum-modelo",
      },
      base: appDb,
      deps: {
        makeClient: stubClient(HEIC, "image/heic"),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(mimes).toEqual(["image/jpeg"]);
    expect(out?.text).toBe(EXTRACTED);
  });

  test("a HEIC that cannot be decoded is skipped, and the provider is never called", async () => {
    // The asymmetry that matters: a failed conversion does NOT fall back to the original bytes. The
    // only reason the conversion was attempted is that this provider does not read them, so sending
    // them anyway would buy a 400 whose answer is already known — and would bill the turn for it.
    const broken = Buffer.from("ftypheic mas o resto e lixo", "latin1");
    const { impl, mimes } = openaiFetch();
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 904,
      messageId: 64,
      attachmentId: 10,
      dataUrl: "https://chat.example.com/IMG_0004.heic",
      cfg: await cfg(),
      base: appDb,
      deps: {
        makeClient: stubClient(broken, "image/heic"),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(out).toBeNull();
    expect(mimes).toEqual([]);
  });
});
