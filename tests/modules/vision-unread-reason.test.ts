import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  clearMediaAnnotations,
  mediaAnnotationFor,
  overlayMediaAnnotations,
} from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { ChatwootMessageRow } from "@/modules/chatwoot/messages";
import { toRenderable } from "@/modules/chatwoot/messages";
import { renderInboundMessage } from "@/modules/chatwoot/render";
import { extractMessageVisuals } from "@/modules/vision/extract-message";
import { resolveVisionConfig } from "@/modules/vision/service";
import type { VisionConfig } from "@/modules/vision/settings";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// What the eager vision pass records about a file it did not read: its name and the cause, per file,
// so the model can ask the customer for the one thing that helps. And the flow-log level follows who
// can act: a type vision does not read, or a picture over the conversion pixel cap, is the customer's
// file meeting a known limit (info); a provider or conversion failure is ours (warn).

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
const CHATWOOT_INBOX_ID = 916;

const RECIBO = readFileSync(`${import.meta.dir}/../fixtures/media/recibo.heic`);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// The fixture with its `ispe` boxes rewritten to 9180x16320, the size a phone's 200 MP mode stores:
// the pixel cap refuses it on the declared size, before any decode, which is the production refusal.
const HEIC_GRANDE = (() => {
  const b = Buffer.from(RECIBO);
  for (let i = b.indexOf("ispe"); i >= 0; i = b.indexOf("ispe", i + 4)) {
    b.writeUInt32BE(9180, i + 8);
    b.writeUInt32BE(16320, i + 12);
  }
  return b;
})();
const HEIC_QUEBRADO = RECIBO.subarray(0, 40);

function arrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}

const FILES: Record<string, { bytes: Buffer; type: string }> = {
  "fotos.zip": {
    bytes: Buffer.from("PK\u0003\u0004zip"),
    type: "application/zip",
  },
  "IMG_200MP.heic": { bytes: HEIC_GRANDE, type: "image/heic" },
  "quebrado.heic": { bytes: HEIC_QUEBRADO, type: "image/heic" },
  "doc.png": { bytes: PNG, type: "image/png" },
  "falha.png": { bytes: PNG, type: "image/png" },
};

const client = (async () =>
  ({
    downloadAttachment: async (url: string) => {
      const f = FILES[url.slice(url.lastIndexOf("/") + 1)];
      if (!f) throw new Error(`unexpected download ${url}`);
      return { bytes: arrayBuffer(f.bytes), contentType: f.type };
    },
    updateAttachmentMeta: async () => ({}),
  }) as unknown as ChatwootClient) as never;

// OpenAI's shape: every image is read.
const provider = (async () => {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "Foto de um documento." } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof fetch;
const providerDown = (async () =>
  new Response("boom", { status: 500 })) as unknown as typeof fetch;

function visual(id: number, name: string) {
  return {
    id,
    dataUrl: `https://chat.example.com/blobs/${name}`,
    name,
    imageDescription: null,
    extractedText: null,
  };
}

describe.skipIf(!dbUp)(
  "what the vision pass records about an unread file",
  () => {
    let cfg: VisionConfig;

    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "UNREAD", slug: `unread-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 916,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const key = await suDb.vaultEntry.create({
        data: { tenantId, name: "vision", secret: encryptJson("sk-x") },
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
              provider: "openai",
              credentialRef: `vault:${key.id}`,
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
      cfg = (await resolveVisionConfig(
        tenantId,
        instanceId,
        CHATWOOT_INBOX_ID,
        appDb,
      )) as VisionConfig;
    });

    afterAll(async () => {
      clearMediaAnnotations();
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

    async function run(
      messageId: number,
      names: string[],
      fetchImpl: typeof fetch = provider,
    ) {
      const turnId = `unread-${process.pid}-${messageId}`;
      const r = await extractMessageVisuals({
        tenantId,
        instanceId,
        conversationId: 77,
        messageId,
        visuals: names.map((n, i) => visual(messageId * 10 + i, n)),
        cfg,
        base: appDb,
        flow: { tenantId, turnId, source: "inbox", base: appDb },
        deps: {
          makeClient: client,
          fetchImpl,
          sleep: async () => {},
        },
      });
      const rows = await flowLogRows(suDb, {
        where: { turnId, stage: "vision" },
        select: { level: true, status: true, detail: true },
      });
      return { r, rows };
    }

    const reasonOf = (d: unknown) => (d as { reason?: string } | null)?.reason;

    test("a zip is recorded as a format that is not read, and its skip line is info", async () => {
      const { r, rows } = await run(1, ["doc.png", "fotos.zip"]);
      expect(r?.imageDescription).toContain("documento");
      expect(r?.unreadFiles).toEqual([{ name: "fotos.zip", cause: "format" }]);
      const skip = rows.find((x) => reasonOf(x.detail) === "unsupported_mime");
      expect(skip?.level).toBe("info");
      expect(rows.some((x) => x.level === "warn")).toBe(false);
    });

    test("a picture over the pixel cap is recorded as too large, with its own reason, at info", async () => {
      const { r, rows } = await run(2, ["IMG_200MP.heic"]);
      expect(r?.unreadFiles).toEqual([
        { name: "IMG_200MP.heic", cause: "too_large" },
      ]);
      const skip = rows.find((x) => x.status === "skipped");
      expect(reasonOf(skip?.detail)).toBe("over_pixel_cap");
      expect(skip?.level).toBe("info");
    });

    test("a HEIC the decoder cannot open is a failure: convert_failed at warn", async () => {
      const { r, rows } = await run(3, ["quebrado.heic"]);
      expect(r?.unreadFiles).toEqual([
        { name: "quebrado.heic", cause: "failed" },
      ]);
      const skip = rows.find((x) => x.status === "skipped");
      expect(reasonOf(skip?.detail)).toBe("convert_failed");
      expect(skip?.level).toBe("warn");
    });

    test("a provider failure is a failure on our side, and stays warn", async () => {
      const { r, rows } = await run(4, ["falha.png"], providerDown);
      expect(r?.unreadFiles).toEqual([{ name: "falha.png", cause: "failed" }]);
      expect(rows.some((x) => x.level === "warn")).toBe(true);
    });

    test("the names and causes survive the annotation store into what the model reads", async () => {
      await run(5, ["doc.png", "fotos.zip", "IMG_200MP.heic"]);
      expect(mediaAnnotationFor(tenantId, instanceId, 5)?.unreadFiles).toEqual([
        { name: "fotos.zip", cause: "format" },
        { name: "IMG_200MP.heic", cause: "too_large" },
      ]);
      const row = {
        id: 5,
        content: "",
        attachmentTypes: ["image", "file", "file"],
        transcribedText: null,
        imageDescription: null,
        extractedText: null,
        attachmentName: "doc.png",
      } as unknown as ChatwootMessageRow;
      overlayMediaAnnotations(tenantId, instanceId, [row]);
      const out = renderInboundMessage(toRenderable(row));
      expect(out).toContain("fotos.zip");
      expect(out).toContain('motivo="formato"');
      expect(out).toContain("IMG_200MP.heic");
      expect(out).toContain('motivo="grande-demais"');
    });

    test("the file name never reaches the flow log", async () => {
      const { rows } = await run(6, ["fotos.zip", "IMG_200MP.heic"]);
      expect(rows.length).toBeGreaterThan(0);
      for (const x of rows) {
        expect(JSON.stringify(x.detail)).not.toContain("fotos.zip");
        expect(JSON.stringify(x.detail)).not.toContain("IMG_200MP");
      }
    });
  },
);
