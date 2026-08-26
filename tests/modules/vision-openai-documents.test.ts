import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

// Issue #324: choosing `openai` as the vision provider used to skip every PDF before any call was
// made, so the agent saw the "couldn't extract" marker and the content of the attachment was lost
// for the rest of the attendance. These drive the real service down to the effect the operator
// sees: the extracted text written back onto the Chatwoot attachment.
//
// The fetch below personifies the endpoint rather than nodding at it. Every refusal it can answer
// was measured against the live API on 2026-08-26 (gpt-4o), so a request this test accepts is one
// the vendor accepts, and a regression in the content part shows up here as the vendor's own 400
// instead of as a green test.

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

const CHATWOOT_INBOX_ID = 21;
const EXTRACTED = "orçamento no valor de R$ 1.480,00";

type Part = {
  type?: string;
  image_url?: { url?: string };
  file?: { filename?: string; file_data?: string };
};

// The vendor's own validation, as measured. Each branch returns the status and message the live API
// returned for that request.
function openaiFetch() {
  const parts: Part[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const bad = (message: string) =>
      new Response(JSON.stringify({ error: { message } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    const body = JSON.parse((init?.body as string) ?? "{}") as {
      messages?: Array<{ content?: Part[] }>;
    };
    const part = body.messages?.[0]?.content?.[1] ?? {};
    parts.push(part);
    if (!String(url).endsWith("/chat/completions")) return bad("unknown route");
    if (part.type === "image_url") {
      const uri = part.image_url?.url ?? "";
      if (!uri.startsWith("data:image/"))
        return bad("Invalid MIME type. Only image types are supported.");
    } else if (part.type === "file") {
      if (!part.file?.filename)
        return bad(
          "Missing required parameter: 'messages[0].content[1].file.file_id'.",
        );
      const data = part.file?.file_data ?? "";
      if (!data.startsWith("data:"))
        return bad(
          "Invalid file data: got a value without the 'data:' prefix.",
        );
      if (!data.startsWith("data:application/pdf;base64,"))
        return bad("Invalid file data: unsupported MIME type.");
    } else {
      return bad(`unsupported content part '${part.type}'`);
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: EXTRACTED } }],
        usage: { prompt_tokens: 2384, completion_tokens: 31 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, parts };
}

function stubClient(meta: Array<Record<string, unknown>>, contentType: string) {
  return async () =>
    ({
      downloadAttachment: async () => ({
        bytes: new ArrayBuffer(16),
        contentType,
      }),
      updateAttachmentMeta: async (
        _conversationId: number,
        _messageId: number,
        _attachmentId: number,
        m: Record<string, unknown>,
      ) => {
        meta.push(m);
        return {};
      },
    }) as unknown as ChatwootClient;
}

describe.skipIf(!dbUp)("openai vision documents", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "VISION DOC", slug: `vision-doc-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 31,
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

  test("a PDF is read, and the extracted text reaches the Chatwoot attachment", async () => {
    const { impl, parts } = openaiFetch();
    const meta: Array<Record<string, unknown>> = [];
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 800,
      messageId: 50,
      attachmentId: 5,
      dataUrl: "https://chat.example.com/orcamento.pdf",
      cfg: await cfg(),
      base: appDb,
      deps: {
        makeClient: stubClient(meta, "application/pdf"),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(out?.text).toBe(EXTRACTED);
    expect(parts.map((p) => p.type)).toEqual(["file"]);
    expect(meta).toEqual([{ extracted_text: EXTRACTED }]);
  });

  test("an image still goes as image_url on the same provider", async () => {
    const { impl, parts } = openaiFetch();
    const meta: Array<Record<string, unknown>> = [];
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 801,
      messageId: 51,
      attachmentId: 6,
      dataUrl: "https://chat.example.com/foto.png",
      cfg: await cfg(),
      base: appDb,
      deps: {
        makeClient: stubClient(meta, "image/png"),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(out?.text).toBe(EXTRACTED);
    expect(parts.map((p) => p.type)).toEqual(["image_url"]);
  });

  // The provider name is not the endpoint. A base URL outlives the provider it was typed for, so an
  // agent switched from `openai-compatible` to `openai` still posts to the operator's own server —
  // which need not implement the `file` part, and answers 200 with a plausible extraction of
  // nothing if it ignores what it does not know.
  test("openai pointed at another endpoint skips the PDF instead of guessing", async () => {
    const { impl, parts } = openaiFetch();
    const meta: Array<Record<string, unknown>> = [];
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 803,
      messageId: 53,
      attachmentId: 8,
      dataUrl: "https://chat.example.com/orcamento.pdf",
      cfg: { ...(await cfg()), baseURL: "https://llm.internal.example/v1" },
      base: appDb,
      deps: {
        makeClient: stubClient(meta, "application/pdf"),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(out).toBeNull();
    expect(parts).toEqual([]);
    expect(meta).toEqual([]);
  });

  // ...and an image on that same endpoint is untouched: this is about what the endpoint is known to
  // READ, not about trusting it less.
  test("an image on that same endpoint still goes through", async () => {
    const { impl, parts } = openaiFetch();
    const meta: Array<Record<string, unknown>> = [];
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 804,
      messageId: 54,
      attachmentId: 9,
      dataUrl: "https://chat.example.com/foto.png",
      cfg: { ...(await cfg()), baseURL: "https://llm.internal.example/v1" },
      base: appDb,
      deps: {
        makeClient: stubClient(meta, "image/png"),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(out?.text).toBe(EXTRACTED);
    expect(parts.map((p) => p.type)).toEqual(["image_url"]);
  });

  // The registry still governs, and it is the only thing that does: openrouter reaches the same
  // adapter, so if the skip were dropped in favour of "the part exists now", a router pointed at a
  // model that ignores the part would answer with a plausible extraction of nothing.
  test("openrouter still skips a PDF without calling the provider", async () => {
    const { impl, parts } = openaiFetch();
    const meta: Array<Record<string, unknown>> = [];
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 802,
      messageId: 52,
      attachmentId: 7,
      dataUrl: "https://chat.example.com/orcamento.pdf",
      cfg: await cfg("openrouter"),
      base: appDb,
      deps: {
        makeClient: stubClient(meta, "application/pdf"),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(out).toBeNull();
    expect(parts).toEqual([]);
    expect(meta).toEqual([]);
  });
});
