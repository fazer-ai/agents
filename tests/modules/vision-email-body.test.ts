import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import {
  clearMediaAnnotations,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { renderInboundMessage } from "@/modules/chatwoot/render";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { reengageConversation } from "@/modules/conversations/reengage";
import { extractMessageVisuals } from "@/modules/vision/extract-message";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogCount } from "../utils/flowlog";

// ISSUE #864: A PICTURE IN AN EMAIL BODY NEVER REACHES VISION.
//
// Chatwoot's mailbox keeps an inline image INSIDE the body instead of making it an attachment: a
// blob URL in `content_attributes.email.html_content.full` when the HTML references it by `cid:`,
// or `<img src="<blob url>">` appended to `text_content.full` when the mail has no HTML at all
// (Apple Mail on iPhone). The message carries no attachment, the vision pass reads attachments
// only, and the agent answers "I can't see the attachment" to a customer who sent one — on one
// production mailbox, 2,397 of the 4,197 email messages that declared an attachment in 14 days.
//
// Measured at the two places the pass is consumed: the turn that re-reads the thread (REST page,
// real extraction with a fake provider, the model's input captured), and the webhook's eager pass
// (the delivered event, counted by vision stage lines with no credential, as in
// vision-every-attachment.test.ts).
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

const HOST = "https://body.example.com";
const blob = (n: number, name = `image${n}.jpeg`) =>
  `${HOST}/rails/active_storage/blobs/redirect/sig${n}--x/${name}`;
const REMOTE_LOGO = "https://cdn.store.example/rails/active_storage/logo.png";

// A PNG header declaring w x h: all the decorative check reads, and enough for the mime classifier.
function png(w: number, h: number): ArrayBuffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

class TurnCapturingModel extends BaseChatModel {
  humanTexts: string[] = [];
  constructor(private readonly reply: string) {
    super({});
  }
  _llmType() {
    return "fake-turn-capture";
  }
  override bindTools(_tools: BindToolsInput[]) {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    for (const m of messages) {
      if (m.getType() === "human" && typeof m.content === "string")
        this.humanTexts.push(m.content);
    }
    return {
      generations: [{ text: this.reply, message: new AIMessage(this.reply) }],
    };
  }
}

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let agentId = 0n;
let visionKeyId = 0n;

function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function emailBag(opts: { html?: string; text?: string; subject?: string }) {
  return {
    email: {
      subject: opts.subject ?? "Documento",
      html_content: { full: opts.html ?? "" },
      text_content: { full: opts.text ?? "" },
    },
  };
}

// The client: serves the thread, downloads by URL (the size of each image decided by the test),
// and records every download and every meta write-back.
function stub(opts: {
  page: unknown;
  sizes: Record<string, [number, number]>;
  downloads: string[];
  metaWrites: number[];
  fail?: Set<string>;
  types?: Record<string, string>;
}) {
  const client = {
    getMessages: async () => opts.page,
    sendMessage: async () => ({}),
    toggleTyping: async () => ({}),
    servesUrl: (url: string) => {
      try {
        return new URL(url).host === new URL(HOST).host;
      } catch {
        return false;
      }
    },
    downloadAttachment: async (dataUrl: string) => {
      opts.downloads.push(dataUrl);
      if (opts.fail?.has(dataUrl)) throw new Error("404 on the blob");
      const [w, h] = opts.sizes[dataUrl] ?? [1200, 1600];
      return {
        bytes: png(w, h),
        contentType: opts.types?.[dataUrl] ?? "image/png",
      };
    },
    updateAttachmentMeta: async (
      _c: number,
      _m: number,
      attachmentId: number,
    ) => {
      opts.metaWrites.push(attachmentId);
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

const provider = { calls: 0 };
function visionFetch(texts: string[]) {
  let i = 0;
  provider.calls = 0;
  return (async () => {
    provider.calls++;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: texts[i++] ?? texts[0] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

async function seedConversation(convId: number): Promise<bigint> {
  const c = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      inboxId: inboxDbId,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
  });
  return c.id;
}

async function setVision(withCredential: boolean) {
  await suDb.agent.update({
    where: { id: agentId },
    data: {
      settings: {
        vision: {
          enabled: true,
          provider: "openai",
          ...(withCredential ? { credentialRef: `vault:${visionKeyId}` } : {}),
        },
        debounce: { enabled: true },
      },
    },
  });
}

describe.skipIf(!dbUp)("a picture in an email body reaches vision", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Body", slug: `email-body-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 11,
      baseUrl: HOST,
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const visionKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "vision-key", secret: encryptJson("sk-v") },
      select: { id: true },
    });
    visionKeyId = visionKey.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        enabled: true,
        mode: "production",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: {},
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 12,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `email-body-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 12,
        name: "E-mail",
        agentId: agent.id,
      },
    });
    inboxDbId = inbox.id;
  });

  beforeEach(() => {
    clearMediaAnnotations();
  });

  afterAll(async () => {
    clearMediaAnnotations();
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      for (const table of [
        "audit_logs",
        "llm_usage",
        "scheduler_jobs",
        "chatwoot_webhook_deliveries",
        "conversations",
        "contacts",
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

  async function reengage(
    convId: number,
    message: { content: string; content_attributes: unknown },
    opts: {
      sizes?: Record<string, [number, number]>;
      texts?: string[];
      fail?: Set<string>;
      types?: Record<string, string>;
    } = {},
  ) {
    const id = await seedConversation(convId);
    const downloads: string[] = [];
    const metaWrites: number[] = [];
    const model = new TurnCapturingModel("Recebi, obrigada.");
    const res = await reengageConversation(
      ctx(),
      id,
      {
        makeModel: () => model,
        makeClient: stub({
          page: {
            payload: [
              {
                id: 1,
                message_type: 0,
                private: false,
                ...message,
              },
            ],
          },
          sizes: opts.sizes ?? {},
          downloads,
          metaWrites,
          fail: opts.fail,
          types: opts.types,
        }),
        visionFetch: visionFetch(opts.texts ?? ["Foto de um RG."]),
        checkpointer: new MemorySaver(),
      },
      appDb,
    );
    return { res, downloads, metaWrites, turn: model.humanTexts.join("\n") };
  }

  test("the iPhone shape: the image appended to the plain text is read", async () => {
    await setVision(true);
    const out = await reengage(1001, {
      content: "Segue o documento.",
      content_attributes: emailBag({
        text: `Segue o documento.\n\nEnviado do meu iPhone\n\n<img src="${blob(1)}" alt="image0.jpeg">`,
      }),
    });
    expect(out.res.outcome).toBe("posted");
    expect(out.turn).toContain("Foto de um RG.");
    expect(provider.calls).toBe(1);
    // There is no attachment to write the reading back to.
    expect(out.metaWrites).toEqual([]);
  });

  test("the pasted shape: every Chatwoot blob in the HTML is read, the remote logo is not fetched", async () => {
    await setVision(true);
    const out = await reengage(
      1002,
      {
        content: "Seguem os prints",
        content_attributes: emailBag({
          html: `<p>Seguem os prints</p><img src="${blob(2, "a.png")}"><img src="${REMOTE_LOGO}"><img src="${blob(3, "b.png")}">`,
          text: "Seguem os prints",
        }),
      },
      { texts: ["Print do pedido 21607129.", "Comprovante de PIX."] },
    );
    expect(out.turn).toContain("Print do pedido 21607129.");
    expect(out.turn).toContain("Comprovante de PIX.");
    expect(provider.calls).toBe(2);
    expect(out.downloads).not.toContain(REMOTE_LOGO);
  });

  test("a logo quoted from another email costs no provider call and is not reported as unread", async () => {
    await setVision(true);
    const logo = blob(4, "LOGO.png");
    const photo = blob(5, "IMG_0001.jpeg");
    const out = await reengage(
      1003,
      {
        content: "Segue a foto",
        content_attributes: emailBag({
          html: `<p>Segue a foto</p><img src="${photo}"><blockquote><img src="${logo}"></blockquote>`,
        }),
      },
      { sizes: { [logo]: [908, 140] }, texts: ["Foto segurando o RG."] },
    );
    expect(out.turn).toContain("Foto segurando o RG.");
    // One file read is one file: no per-file label, as if the logo had been a second one.
    expect(out.turn).not.toContain("[IMG_0001.jpeg]");
    expect(provider.calls).toBe(1);
    // "one file not read" beside a complete reading would make the agent ask for a resend.
    // Read off the renderer rather than transcribed, so a rewording cannot turn this into a no-op.
    const unreadMarker =
      renderInboundMessage({
        text: "",
        attachmentTypes: ["image"],
        imageDescription: "x",
        attachmentsUnread: 1,
      })
        .split("\n")
        .pop() ?? "";
    expect(unreadMarker).toContain("1");
    expect(out.turn).not.toContain(unreadMarker);
  });

  test("a blob that is both attached and shown in the body is one file, read as the attachment", async () => {
    await setVision(true);
    const same = blob(7, "comprovante.jpeg");
    const out = await reengage(1006, {
      content: "Segue o comprovante",
      content_attributes: emailBag({
        html: `<p>Segue o comprovante</p><img src="${same}?disposition=inline">`,
      }),
      attachments: [{ id: 77, file_type: "image", data_url: same }],
    } as never);
    expect(provider.calls).toBe(1);
    expect(out.metaWrites).toEqual([77]);
    expect(out.turn.match(/<imagem>/g)?.length).toBe(1);
  });

  // Read off the renderer, so a rewording cannot turn these into no-ops.
  const unreadMarker = (n: number) =>
    renderInboundMessage({
      text: "",
      attachmentTypes: ["image"],
      imageDescription: "x",
      attachmentsUnread: n,
    })
      .split("\n")
      .pop() ?? "";

  test("ornaments ahead of the photo do not take its slot under the cap", async () => {
    await setVision(true);
    const icons = Array.from({ length: 8 }, (_, i) =>
      blob(20 + i, `icon${i}.png`),
    );
    const photo = blob(30, "IMG_0002.jpeg");
    const sizes = Object.fromEntries(
      icons.map((u) => [u, [144, 144] as [number, number]]),
    );
    const out = await reengage(
      1007,
      {
        content: "Segue",
        content_attributes: emailBag({
          html: `<p>Segue</p>${icons.map((u) => `<img src="${u}">`).join("")}<img src="${photo}">`,
        }),
      },
      { sizes, texts: ["Foto do documento."] },
    );
    expect(provider.calls).toBe(1);
    expect(out.downloads).toContain(photo);
    expect(out.turn).toContain("Foto do documento.");
    expect(out.turn).not.toContain(unreadMarker(1));
  });

  test("ten photos in a body: eight are read and two are named as unread", async () => {
    await setVision(true);
    const photos = Array.from({ length: 10 }, (_, i) =>
      blob(40 + i, `p${i}.jpeg`),
    );
    const out = await reengage(1008, {
      content: "Fotos",
      content_attributes: emailBag({
        html: photos.map((u) => `<img src="${u}">`).join(""),
      }),
    });
    expect(provider.calls).toBe(8);
    expect(out.turn).toContain(unreadMarker(2));
  });

  test("an email whose only content is a body image is answered", async () => {
    await setVision(true);
    const out = await reengage(1009, {
      content: "",
      content_attributes: emailBag({
        subject: "",
        html: `<img src="${blob(50)}">`,
      }),
    });
    expect(out.res.outcome).toBe("posted");
    expect(out.turn).toContain("Foto de um RG.");
  });

  test("a body image that fails to download is named beside the text", async () => {
    await setVision(true);
    const broken = blob(51);
    const out = await reengage(
      1010,
      {
        content: "Segue o documento",
        content_attributes: emailBag({
          html: `<p>Segue o documento</p><img src="${broken}">`,
        }),
      },
      { fail: new Set([broken]) },
    );
    expect(provider.calls).toBe(0);
    expect(out.turn).toContain("Segue o documento");
    expect(out.turn).toContain(unreadMarker(1));
  });

  test("an attachment already read does not keep a distinct body image from being read", async () => {
    await setVision(true);
    const out = await reengage(
      1011,
      {
        content: "Segue",
        content_attributes: emailBag({
          html: `<p>Segue</p><img src="${blob(52, "print.png")}">`,
        }),
        attachments: [
          {
            id: 88,
            file_type: "image",
            data_url: blob(53, "anexo.png"),
            meta: { image_description: "Anexo já lido." },
          },
        ],
      } as never,
      { texts: ["Print do pedido."] },
    );
    expect(provider.calls).toBe(1);
    expect(out.turn).toContain("Anexo já lido.");
    expect(out.turn).toContain("Print do pedido.");
  });

  test("attachments take their slots first; the body gets what is left of the cap", async () => {
    await setVision(true);
    const out = await reengage(1012, {
      content: "Tudo",
      content_attributes: emailBag({
        html: [60, 61, 62].map((n) => `<img src="${blob(n)}">`).join(""),
      }),
      attachments: Array.from({ length: 7 }, (_, i) => ({
        id: 100 + i,
        file_type: "image",
        data_url: blob(70 + i, `a${i}.png`),
      })),
    } as never);
    expect(provider.calls).toBe(8);
    expect(out.turn).toContain(unreadMarker(2));
  });

  test("an aggregate from the pass that read the body is not paid for again", async () => {
    await setVision(true);
    stashMediaAnnotation(
      { tenantId, instanceId, messageId: 1 },
      {
        imageDescription: "Tudo lido antes.",
        attachmentsUnread: 0,
        bodyRead: true,
      },
    );
    const out = await reengage(1013, {
      content: "Segue",
      content_attributes: emailBag({ html: `<img src="${blob(63)}">` }),
      attachments: [
        {
          id: 89,
          file_type: "image",
          data_url: blob(64, "anexo.png"),
          meta: { image_description: "Anexo já lido." },
        },
      ],
    } as never);
    expect(provider.calls).toBe(0);
    expect(out.turn).toContain("Tudo lido antes.");
  });

  test("a remote body image is not counted as unread when the attachments fill the cap", async () => {
    await setVision(true);
    const out = await reengage(1014, {
      content: "Tudo",
      content_attributes: emailBag({ html: `<img src="${REMOTE_LOGO}">` }),
      attachments: Array.from({ length: 8 }, (_, i) => ({
        id: 200 + i,
        file_type: "image",
        data_url: blob(80 + i, `b${i}.png`),
      })),
    } as never);
    expect(provider.calls).toBe(8);
    expect(out.turn).not.toContain(unreadMarker(1));
    expect(out.downloads).not.toContain(REMOTE_LOGO);
  });

  test("a body image vision cannot read is named as unread, not dropped as an ornament", async () => {
    await setVision(true);
    const svg = blob(90, "diagrama.svg");
    const out = await reengage(
      1015,
      {
        content: "Segue o diagrama",
        content_attributes: emailBag({ html: `<img src="${svg}">` }),
      },
      { types: { [svg]: "image/svg+xml" } },
    );
    expect(provider.calls).toBe(0);
    expect(out.turn).toContain(unreadMarker(1));
  });

  test("an email with no text whose only body image is an ornament does not ask for a resend", async () => {
    await setVision(true);
    const logo = blob(91, "LOGO.png");
    const out = await reengage(
      1016,
      {
        content: "",
        content_attributes: emailBag({
          subject: "",
          html: `<img src="${logo}">`,
        }),
      },
      { sizes: { [logo]: [908, 140] } },
    );
    expect(provider.calls).toBe(0);
    const resend = renderInboundMessage({
      text: "",
      attachmentTypes: ["image"],
    });
    expect(out.turn).not.toContain(resend);
    expect(out.turn).toContain(
      renderInboundMessage({ text: "", attachmentTypes: [], bodyImages: 1 }),
    );
  });

  test("when the instance's address cannot be read, no body image is fetched", async () => {
    const downloads: string[] = [];
    const r = await extractMessageVisuals({
      tenantId,
      // An instance that does not exist: the base URL read throws.
      instanceId: 987_654_321n,
      conversationId: 1017,
      messageId: 1,
      visuals: [
        {
          id: null,
          dataUrl: blob(92),
          name: "image92.jpeg",
          imageDescription: null,
          extractedText: null,
        },
      ],
      cfg: {
        enabled: true,
        provider: "openai",
        credentialRef: `vault:${visionKeyId}`,
      } as never,
      base: appDb,
      deps: {
        makeClient: stub({ page: [], sizes: {}, downloads, metaWrites: [] }),
        fetchImpl: visionFetch(["não deveria ler"]),
      },
    });
    expect(downloads).toEqual([]);
    expect(provider.calls).toBe(0);
    expect(r?.attachmentsUnread ?? 0).toBe(0);
  });

  test("an ornament past the cap is not named as an unread file", async () => {
    await setVision(true);
    const signature = blob(93, "assinatura.png");
    const out = await reengage(
      1018,
      {
        content: "Tudo",
        content_attributes: emailBag({ html: `<img src="${signature}">` }),
        attachments: Array.from({ length: 8 }, (_, i) => ({
          id: 300 + i,
          file_type: "image",
          data_url: blob(100 + i, `c${i}.png`),
        })),
      } as never,
      { sizes: { [signature]: [144, 144] } },
    );
    expect(provider.calls).toBe(8);
    // Downloaded to classify, never sent to the provider.
    expect(out.downloads).toContain(signature);
    expect(out.turn).not.toContain(unreadMarker(1));
  });

  test("a failed body image is named beside an audio note too", async () => {
    await setVision(true);
    const broken = blob(94);
    const out = await reengage(
      1019,
      {
        content: "",
        content_attributes: emailBag({ html: `<img src="${broken}">` }),
        attachments: [
          { id: 400, file_type: "audio", data_url: blob(95, "nota.ogg") },
        ],
      } as never,
      { fail: new Set([broken]) },
    );
    expect(out.turn).toContain(unreadMarker(1));
  });

  test("a body of ornaments only is not downloaded again by the next turn", async () => {
    await setVision(true);
    const icon = blob(96, "icon.png");
    const message = {
      content: "Obrigado",
      content_attributes: emailBag({
        html: `<p>Obrigado</p><img src="${icon}">`,
      }),
    };
    const first = await reengage(1020, message, {
      sizes: { [icon]: [144, 144] },
    });
    expect(first.downloads).toEqual([icon]);
    // Same message id, still inside the annotation's TTL: the pass already went through the body.
    const second = await reengage(1021, message, {
      sizes: { [icon]: [144, 144] },
    });
    expect(second.downloads).toEqual([]);
    expect(provider.calls).toBe(0);
  });

  test("overflow is classified in batches no larger than the cap", async () => {
    await setVision(true);
    const photos = Array.from({ length: 8 }, (_, i) =>
      blob(110 + i, `f${i}.jpeg`),
    );
    const icons = Array.from({ length: 12 }, (_, i) =>
      blob(130 + i, `i${i}.png`),
    );
    const sizes = Object.fromEntries(
      icons.map((u) => [u, [144, 144] as [number, number]]),
    );
    const id = await seedConversation(1022);
    let inFlight = 0;
    let peak = 0;
    const base = stub({
      page: {
        payload: [
          {
            id: 1,
            message_type: 0,
            private: false,
            content: "Fotos",
            content_attributes: emailBag({
              html: [...photos, ...icons]
                .map((u) => `<img src="${u}">`)
                .join(""),
            }),
          },
        ],
      },
      sizes,
      downloads: [],
      metaWrites: [],
    });
    const client = await base();
    const download = client.downloadAttachment.bind(client);
    client.downloadAttachment = (async (url: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await download(url);
      } finally {
        inFlight--;
      }
    }) as never;
    const counted = async () => client;
    const res = await reengageConversation(
      ctx(),
      id,
      {
        makeModel: () => new TurnCapturingModel("ok"),
        makeClient: counted,
        visionFetch: visionFetch(["Foto."]),
        checkpointer: new MemorySaver(),
      },
      appDb,
    );
    expect(res.outcome).toBe("posted");
    expect(provider.calls).toBe(8);
    expect(peak).toBeLessThanOrEqual(8);
  });

  test("a message whose body has no Chatwoot blob costs nothing", async () => {
    await setVision(true);
    const out = await reengage(1004, {
      content: "Oi",
      content_attributes: emailBag({
        html: `<p>Oi</p><img src="${REMOTE_LOGO}">`,
      }),
    });
    expect(provider.calls).toBe(0);
    expect(out.downloads).toEqual([]);
  });

  // THE WEBHOOK'S EAGER PASS, on the delivered event. No credential: the service emits one skipped
  // `vision` line per image it would read, so the count is the number of body images it picked up.
  test("the eager pass on arrival picks up the body image too", async () => {
    await setVision(false);
    const convId = 1005;
    await clearFlowLog(suDb, { tenantId });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inboxDbId,
        chatwootConversationId: convId,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${convId}`,
        lastEventAt: new Date(Date.now() - 60_000),
      },
    });
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: 7005,
      content: "Segue o documento.",
      message_type: "incoming",
      private: false,
      content_attributes: emailBag({
        html: `<p>Segue</p><img src="${blob(6)}"><img src="${REMOTE_LOGO}">`,
      }),
      conversation: {
        id: convId,
        inbox_id: 12,
        status: "pending",
        contact_inbox: { id: 71_005 },
        meta: {
          assignee_type: null,
          assignee: null,
          sender: { id: 31, name: "Cliente" },
        },
        channel: "Channel::Email",
        last_activity_at: Math.floor(Date.now() / 1000),
      },
    });
    if (!n) throw new Error("unreachable: the fixture is a valid event");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `email-body-${process.pid}-${convId}`,
        event: "message_created",
        status: "PENDING",
      },
      select: { id: true },
    });
    const downloads: string[] = [];
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: 12,
      normalized: n,
      base: appDb,
      deps: {
        makeClient: stub({ page: [], sizes: {}, downloads, metaWrites: [] }),
        makeModel: () => {
          throw new Error("debounce is on: this delivery arms a job");
        },
      },
    });
    const lines = await flowLogCount(suDb, {
      where: {
        tenantId,
        threadId: `${tenantId}:${instanceId}:${convId}`,
        stage: "vision",
      },
    });
    expect(lines).toBeGreaterThan(0);
    expect(downloads).not.toContain(REMOTE_LOGO);
  });
});
