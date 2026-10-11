import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import jpeg from "jpeg-js";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  extractInboundFile,
  extractPlaygroundFile,
  readInboundFile,
  resolveVisionConfig,
} from "@/modules/vision/service";
import type { VisionConfig } from "@/modules/vision/settings";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// An iPhone photo arrives as `image/heic`, which OpenAI and Anthropic refuse (400) and Gemini accepts,
// so it is converted before it reaches a provider that refuses it.
//
// The fetch below mirrors OpenAI's own validation (gpt-4o-mini): `data:image/heic` answers 400
// invalid_image_format with the message below, character for character, and `data:image/png`
// answers 200. So a request this test accepts is one the vendor accepts, and a lost conversion
// shows up as the vendor's own 400. FIXTURE: `tests/fixtures/media/recibo.heic` is a 2400x1600 HEIC
// (HEVC) reading "R$ 1.480,00", made with `sips -s format heic`; here only its container matters.

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

// The whole path, from the attachment to the request: a full-resolution phone photo reaches
// Anthropic within its 8000 px limit and is read. The fetch mirrors the live API's own check,
// message for message, so a request this test accepts is one Anthropic accepts.
const EXTRACTED = "uma foto de um ingresso";
const LIMIT = 8000;

let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
const CHATWOOT_INBOX_ID = 31;

function anthropicFetch() {
  const seen: Array<{ mediaType: string; width: number; height: number }> = [];
  const impl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}") as {
      messages?: Array<{
        content?: Array<{ source?: { media_type?: string; data?: string } }>;
      }>;
    };
    const source = body.messages?.[0]?.content?.[0]?.source ?? {};
    const encoded = source.data ?? "";
    if (encoded.length > 10 * 1024 * 1024) {
      seen.push({ mediaType: source.media_type ?? "", width: 0, height: 0 });
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `messages.0.content.0.image.source.base64: image exceeds 10 MB maximum: ${encoded.length} bytes > 10485760 bytes`,
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const bytes = Buffer.from(encoded, "base64");
    const d = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 100 });
    seen.push({
      mediaType: source.media_type ?? "",
      width: d.width,
      height: d.height,
    });
    if (Math.max(d.width, d.height) > LIMIT)
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `messages.0.content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size: ${LIMIT} pixels`,
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: EXTRACTED }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1600, output_tokens: 12 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, seen };
}

function photo(width: number, height: number): Buffer {
  const data = new Uint8Array(width * height * 4).fill(128);
  return jpeg.encode({ data, width, height }, 70).data as Buffer;
}

// Random noise at quality 100 does not compress, so a photo under 8000 px still weighs more than
// Anthropic's 10 MB base64 ceiling (~7.5 MB of JPEG).
function heavyPhoto(width: number, height: number): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 256) | 0;
  return jpeg.encode({ data, width, height }, 100).data as Buffer;
}

// OpenAI's own check, as gpt-6.1-sol answered it live: 32 px patches, at most 30,000 per image, and a
// photo over that is refused rather than downscaled. The message is the vendor's, character for
// character, with the counts computed the way the measured 4536x8064 (35784) comes out.
function openaiFetch() {
  const seen: Array<{ width: number; height: number }> = [];
  const impl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}") as {
      messages?: Array<{
        content?: Array<{ type?: string; image_url?: { url?: string } }>;
      }>;
    };
    const url =
      body.messages?.[0]?.content?.find((c) => c.type === "image_url")
        ?.image_url?.url ?? "";
    const bytes = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
    const d = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 100 });
    seen.push({ width: d.width, height: d.height });
    const patches = Math.ceil(d.width / 32) * Math.ceil(d.height / 32);
    if (patches > 30_000)
      return new Response(
        JSON.stringify({
          error: {
            message: `The image you provided requires ${patches} patches after processing, exceeding the limit of 30000. Please resize the image and try again.`,
            type: "invalid_request_error",
            param: "messages",
            code: "invalid_value",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: EXTRACTED }, finish_reason: "stop" }],
        usage: { prompt_tokens: 900, completion_tokens: 12 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, seen };
}

// A WebP header (VP8X) declaring the given size, with no image data behind it: the size is all the
// plan reads, and there is no WebP decoder here to fit it with.
function webpOf(width: number, height: number): Buffer {
  const b = Buffer.alloc(64);
  b.write("RIFF", 0);
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WEBP", 8);
  b.write("VP8X", 12);
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function stubClient(bytes: Buffer, contentType = "image/jpeg") {
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

describe.skipIf(!dbUp)("an image over Anthropic's dimension limit", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "VISION 8000", slug: `vision-8000-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 41,
      baseUrl: "https://vision-limit.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const key = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "vision-anthropic",
        secret: encryptJson("sk-ant-test"),
      },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "x",
        settings: {
          vision: {
            enabled: true,
            provider: "anthropic",
            model: "claude-haiku-5-5",
            credentialRef: `vault:${key.id}`,
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
      await clearFlowLog(suDb, { tenantId });
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

  let nextId = 70;
  async function read(bytes: Buffer, impl: typeof fetch) {
    nextId += 1;
    return extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 910,
      messageId: nextId,
      attachmentId: nextId,
      dataUrl: "https://vision-limit.example.com/IMG_0003.jpg",
      cfg: (await resolveVisionConfig(
        tenantId,
        instanceId,
        CHATWOOT_INBOX_ID,
        appDb,
      )) as VisionConfig,
      base: appDb,
      deps: {
        makeClient: stubClient(bytes),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
  }

  test("a photo taller than 8000 px is downscaled before the call, and read", async () => {
    const { impl, seen } = anthropicFetch();
    const out = await read(photo(600, 8100), impl);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.mediaType).toBe("image/jpeg");
    expect(
      Math.max(seen[0]?.width ?? 0, seen[0]?.height ?? 0),
    ).toBeLessThanOrEqual(LIMIT);
    expect(seen[0]?.height ?? 0).toBeGreaterThan(seen[0]?.width ?? 0);
    expect(out?.text).toBe(EXTRACTED);
  });

  test("a photo under 8000 px but over the 10 MB base64 ceiling is re-encoded, and read", async () => {
    const heavy = heavyPhoto(1400, 1600);
    expect(Math.ceil(heavy.length / 3) * 4).toBeGreaterThan(10 * 1024 * 1024);
    const { impl, seen } = anthropicFetch();
    const out = await read(heavy, impl);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.width).toBeGreaterThan(0);
    expect(out?.text).toBe(EXTRACTED);
  });

  test("on OpenAI a full-resolution phone photo is downscaled under its patch limit, and read", async () => {
    const { impl, seen } = openaiFetch();
    const cfg = (await resolveVisionConfig(
      tenantId,
      instanceId,
      CHATWOOT_INBOX_ID,
      appDb,
    )) as VisionConfig;
    nextId += 1;
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 910,
      messageId: nextId,
      attachmentId: nextId,
      dataUrl: "https://vision-limit.example.com/IMG_0004.jpg",
      cfg: { ...cfg, provider: "openai", model: "gpt-6.1-sol" },
      base: appDb,
      deps: {
        makeClient: stubClient(photo(4536, 8064)),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(seen).toHaveLength(1);
    const sent = seen[0] ?? { width: 0, height: 0 };
    expect(
      Math.ceil(sent.width / 32) * Math.ceil(sent.height / 32),
    ).toBeLessThanOrEqual(30_000);
    expect(sent.height).toBeGreaterThan(sent.width);
    expect(out?.text).toBe(EXTRACTED);
  });

  test("on OpenAI a photo too large to fit here is sent as received, since the model may resize it itself", async () => {
    // A header declaring 8000x7000 (56 MP, over the converter's pixel cap) on a tiny JPEG body.
    const forged = Buffer.from(photo(32, 32));
    let sof = 2;
    while (!(forged[sof] === 0xff && forged[sof + 1] === 0xc0))
      sof += 2 + forged.readUInt16BE(sof + 2);
    forged.writeUInt16BE(7000, sof + 5);
    forged.writeUInt16BE(8000, sof + 7);
    const sent: string[] = [];
    const impl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        messages?: Array<{
          content?: Array<{ type?: string; image_url?: { url?: string } }>;
        }>;
      };
      const url =
        body.messages?.[0]?.content?.find((c) => c.type === "image_url")
          ?.image_url?.url ?? "";
      sent.push(url.slice(url.indexOf(",") + 1));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: EXTRACTED }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const cfg = (await resolveVisionConfig(
      tenantId,
      instanceId,
      CHATWOOT_INBOX_ID,
      appDb,
    )) as VisionConfig;
    nextId += 1;
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 910,
      messageId: nextId,
      attachmentId: nextId,
      dataUrl: "https://vision-limit.example.com/IMG_0005.jpg",
      cfg: { ...cfg, provider: "openai", model: "gpt-4o" },
      base: appDb,
      deps: {
        makeClient: stubClient(forged),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(sent).toEqual([forged.toString("base64")]);
    expect(out?.text).toBe(EXTRACTED);
  });

  test("a WebP over the limit, which nothing here can fit, is not sent and its line says why", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return new Response("{}", { status: 400 });
    }) as unknown as typeof fetch;
    nextId += 1;
    const turnId = `vision-over-limit-${process.pid}-${nextId}`;
    const out = await readInboundFile({
      tenantId,
      instanceId,
      conversationId: 910,
      messageId: nextId,
      attachmentId: nextId,
      dataUrl: "https://vision-limit.example.com/banner.webp",
      cfg: (await resolveVisionConfig(
        tenantId,
        instanceId,
        CHATWOOT_INBOX_ID,
        appDb,
      )) as VisionConfig,
      base: appDb,
      flow: { tenantId, turnId, source: "inbox", base: appDb },
      deps: {
        makeClient: stubClient(webpOf(10_000, 1_000), "image/webp"),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(calls).toBe(0);
    expect(out).toEqual({ unread: "too_large" });
    const rows = await flowLogRows(suDb, {
      where: { turnId, stage: "vision" },
      select: { level: true, status: true, detail: true },
    });
    expect(
      rows.map((r) => ({ level: r.level, status: r.status, detail: r.detail })),
    ).toEqual([
      {
        level: "info",
        status: "skipped",
        detail: { reason: "over_provider_limit" },
      },
    ]);
  });

  test("the same WebP to an endpoint that is not Anthropic's is sent, since its limits are not ours to know", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: EXTRACTED }],
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const cfg = (await resolveVisionConfig(
      tenantId,
      instanceId,
      CHATWOOT_INBOX_ID,
      appDb,
    )) as VisionConfig;
    nextId += 1;
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 910,
      messageId: nextId,
      attachmentId: nextId,
      dataUrl: "https://vision-limit.example.com/banner.webp",
      cfg: { ...cfg, baseURL: "https://llm-proxy.example.com/v1" },
      base: appDb,
      deps: {
        makeClient: stubClient(webpOf(10_000, 1_000), "image/webp"),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(calls).toBe(1);
    expect(out?.text).toBe(EXTRACTED);
  });

  test("the playground path refuses the same WebP on Anthropic's endpoint and sends it to another one", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: EXTRACTED }],
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const webp = webpOf(10_000, 1_000);
    const file = new Uint8Array(webp).buffer;
    const vision = {
      enabled: true,
      provider: "anthropic",
      model: "claude-haiku-5-5",
      credentialRef: (
        (await resolveVisionConfig(
          tenantId,
          instanceId,
          CHATWOOT_INBOX_ID,
          appDb,
        )) as VisionConfig
      ).credentialRef,
    };
    const turnId = `vision-playground-${process.pid}-${nextId}`;
    const run = (baseURL?: string) =>
      extractPlaygroundFile({
        ctx: { tenantId, userId: null, role: "TENANT_ADMIN" },
        agentId,
        file,
        mimeType: "image/webp",
        settings: { vision: baseURL ? { ...vision, baseURL } : vision },
        base: appDb,
        deps: { fetchImpl: impl, sleep: async () => {} },
        flow: { tenantId, turnId, source: "playground", base: appDb },
      });
    expect(await run()).toEqual({ kind: "unsupported", text: "" });
    expect(calls).toBe(0);
    const rows = await flowLogRows(suDb, {
      where: { turnId, stage: "vision" },
      select: { level: true, status: true, detail: true },
    });
    expect(
      rows.map((r) => ({ level: r.level, status: r.status, detail: r.detail })),
    ).toEqual([
      {
        level: "info",
        status: "skipped",
        detail: { reason: "over_provider_limit" },
      },
    ]);
    expect((await run("https://llm-proxy.example.com/v1")).text).toBe(
      EXTRACTED,
    );
    expect(calls).toBe(1);
  });

  test("a photo at the limit goes as it came", async () => {
    const { impl, seen } = anthropicFetch();
    const out = await read(photo(300, 8000), impl);
    expect(seen).toEqual([
      { mediaType: "image/jpeg", width: 300, height: 8000 },
    ]);
    expect(out?.text).toBe(EXTRACTED);
  });
});
