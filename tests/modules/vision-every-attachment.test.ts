import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  clearMediaAnnotations,
  overlayMediaAnnotations,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { ChatwootMessageRow } from "@/modules/chatwoot/messages";
import { toRenderable } from "@/modules/chatwoot/messages";
import {
  incomingRenderable,
  normalizeChatwootEvent,
} from "@/modules/chatwoot/normalize";
import { renderInboundMessage } from "@/modules/chatwoot/render";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogCount } from "../utils/flowlog";

// THE EAGER VISION PASS OPENS EVERY ATTACHMENT, not only the first.
//
// Asked where it is CONSUMED: the fixture drives the real receiver (`processChatwootDelivery`), so
// counting lines measures the call site; a unit test on `visualAttachments` would pass with the
// webhook still taking `[0]`. Offline like ./eager-media-flow-context.test.ts: vision has NO
// credentialRef, so the service takes its `no_credential` skip (which emits ONE stage line PER
// ATTEMPT) before any Chatwoot client or provider. Debounce is on, so the delivery arms a job instead
// of a turn: the eager pass runs ahead of that gate, and no model is asked for.
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

const CHATWOOT_INBOX_ID = 4711;
const CONV_ID = 9911;
const AGENT_BOT_ID = 79;

let tenantId: bigint;
let instanceId: bigint;
let inboxDbId: bigint;

function anexo(id: number, nome: string, meta?: Record<string, string>) {
  return {
    id,
    file_type: "image",
    data_url: `https://chat.multi.example/blobs/${nome}`,
    ...(meta ? { meta } : {}),
  };
}

// A client that refuses the one call this path must never reach: with no credential the service
// skips before it would download anything.
const clienteQueRecusa = (async () =>
  ({
    downloadAttachment: async () => {
      throw new Error("the file must not be downloaded: no credential");
    },
    sendMessage: async () => ({}),
    sendPrivateNote: async () => ({}),
  }) as unknown as ChatwootClient) as never;

describe.skipIf(!dbUp)("the eager vision pass", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Multi", slug: `multi-anexo-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 7,
      baseUrl: "https://chat.multi.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "x",
        enabled: true,
        mode: "production",
        // No credentialRef: the vision service skips on it, and the skip is what emits the line.
        settings: {
          vision: { enabled: true, provider: "openai" },
          // Debounce ON so the delivery arms a job instead of running a turn: the eager pass runs
          // ahead of the gate for a production agent, and the answer is not the subject here.
          debounce: { enabled: true },
        },
      },
      select: { id: true },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "E-mail",
        agentId: agent.id,
      },
      select: { id: true },
    });
    inboxDbId = inbox.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "scheduler_jobs",
        "chatwoot_webhook_deliveries",
        "conversations",
        "inboxes",
        "agents",
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

  // Each case gets its own conversation: two cases sharing one would let a line written by the
  // first be counted by the second, which is the whole measurement here.
  async function entregar(
    convId: number,
    anexos: ReturnType<typeof anexo>[],
    opts: { reentrega?: boolean } = {},
  ) {
    if (!opts.reentrega)
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
        select: { id: true },
      });
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: 6000 + convId,
      content: "",
      message_type: "incoming",
      private: false,
      attachments: anexos,
      conversation: {
        id: convId,
        inbox_id: CHATWOOT_INBOX_ID,
        status: "pending",
        contact_inbox: { id: 70_000 + convId },
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
        deliveryId: `multi-anexo-${process.pid}-${convId}${opts.reentrega ? "-r" : ""}`,
        event: "message_created",
        status: "PENDING",
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: AGENT_BOT_ID,
      normalized: n,
      base: appDb,
      deps: {
        makeClient: clienteQueRecusa,
        makeModel: () => {
          throw new Error(
            "debounce is on: this delivery must arm a job, not a turn",
          );
        },
      },
    });
    return n;
  }

  async function linhasDeVisao(convId: number): Promise<number> {
    return await flowLogCount(suDb, {
      where: {
        tenantId,
        threadId: `${tenantId}:${instanceId}:${convId}`,
        stage: "vision",
      },
    });
  }

  // NOTE: a RATIO against the one-attachment message, never an absolute count: the eager pass has more
  // than one call site per delivery (ahead of the gate and after it, idempotent on a stashed text, and
  // nothing is stashed on a skip). The subject is how many attachments each pass opens.
  test("every attachment is analyzed, not only the first", async () => {
    await clearFlowLog(suDb, { tenantId });
    await entregar(CONV_ID + 9, [anexo(401, "unico.png")]);
    const umSo = await linhasDeVisao(CONV_ID + 9);
    expect(umSo).toBeGreaterThan(0);

    await entregar(CONV_ID, [
      anexo(101, "pedido.png"),
      anexo(102, "comprovante.jpg"),
      anexo(103, "documento.png"),
    ]);
    // NOTE: three files, three times the work.
    expect(await linhasDeVisao(CONV_ID)).toBe(3 * umSo);
  });

  // NOTE: the album. The cap is the point here, and so is saying so: a model told nothing answers as
  // if the message had those files fewer.
  test("beyond the cap, the overflow is named to the model instead of dropped", async () => {
    await clearFlowLog(suDb, { tenantId });
    const muitos = Array.from({ length: 11 }, (_, i) =>
      anexo(200 + i, `foto-${i + 1}.jpg`),
    );
    const n = await entregar(CONV_ID + 1, muitos);

    // Eleven files cost EIGHT extractions, not eleven and not one — and exactly one pass, because
    // `attachmentsUnread` marks the event as already analyzed and the second call site takes its
    // idempotence path. That mark keeps a message whose every extraction fails from paying the whole
    // provider bill twice.
    expect(await linhasDeVisao(CONV_ID + 1)).toBe(8);
    // A COUNT on the event, not text glued to the extraction: that is what lets it cross the
    // debounce re-fetch, and the marker itself is the renderer's job. Eleven here because vision
    // cannot run in this fixture: three are over the cap and the eight attempted all failed, and
    // a file that could not be read is as absent to the model as one never opened.
    expect(n.message?.attachmentsUnread).toBe(11);
    // NOTE: through `incomingRenderable`, what the DIRECT path hands the renderer: handing the count
    // straight to `renderInboundMessage` passes even when no adapter copies the field. The count rides
    // along; the marker itself waits for something that WAS read (see the render case below).
    expect(incomingRenderable(n).attachmentsUnread).toBe(11);
  });

  // NOTE: THE DEBOUNCE FLUSH, the path most agents take, throws the webhook event away and rebuilds
  // the message from Chatwoot's page plus the in-process annotation store, so what lives only on
  // `n.message` reaches nobody. Both the joined extraction (the store merges field by field, so
  // per-file stashes under one key keep whichever finished last) and the overflow notice must survive.
  test("the joined extraction and the overflow both survive the flush's re-fetch", async () => {
    clearMediaAnnotations();
    await clearFlowLog(suDb, { tenantId });
    const convId = CONV_ID + 3;
    const muitos = Array.from({ length: 10 }, (_, i) =>
      anexo(500 + i, `foto-${i + 1}.jpg`),
    );
    const n = await entregar(convId, muitos);

    // What the flush rebuilds: a page row that knows nothing (upstream Chatwoot, where the meta
    // write-back route does not exist), then the overlay.
    const row: ChatwootMessageRow = {
      id: n.message?.id ?? 0,
      content: "",
      messageType: "incoming" as const,
      private: false,
      attachmentTypes: ["image"],
      transcribedText: null,
      imageDescription: null,
      extractedText: null,
      attachmentName: null,
      location: null,
      inReplyTo: null,
      isReaction: false,
      emailSubject: null,
      activityType: null,
      senderType: null,
      visuals: [],
      externalSenderName: null,
      imported: false,
      senderId: null,
      sendId: null,
    };
    overlayMediaAnnotations(tenantId, instanceId, [row]);

    expect(row.attachmentsUnread).toBe(10);
    // Through `toRenderable`, which is what the FLUSH hands the renderer. With an extraction beside
    // it, the marker is what tells the model the message is incomplete.
    expect(
      renderInboundMessage(
        toRenderable({ ...row, imageDescription: "[a.jpg] comprovante" }),
      ),
    ).toContain('<anexos-nao-lidos quantidade="10">');
    // NOTE: without one, the tried files are still named with their cause, and the image marker does
    // not ask for the file on its own: one request, not two.
    const semLeitura = renderInboundMessage(toRenderable(row));
    expect(semLeitura).toContain('motivo="falha"');
    expect(semLeitura).not.toContain("reenvie o arquivo");
  });

  // NOTE: DELIVERY RECOVERY RE-RUNS THE PASS FROM SCRATCH, and the stash wins over the page, so a
  // partial re-run (A and B persisted, only B extracted again) would publish B alone. An attachment
  // that already carries its extraction is reused instead, which makes the aggregate complete by
  // construction, and cheaper.
  test("an attachment already extracted is reused, not paid for again", async () => {
    clearMediaAnnotations();
    await clearFlowLog(suDb, { tenantId });
    const convId = CONV_ID + 4;
    const n = await entregar(convId, [
      anexo(601, "ja-lido.png", { image_description: "pedido 40000001" }),
      anexo(602, "novo.png"),
    ]);

    // Só o que ainda não tinha extração custou uma chamada.
    const linhas = await linhasDeVisao(convId);
    const umSo = 1;
    expect(linhas).toBeLessThan(2 * 2 * umSo);
    // E o que já estava lá continua no agregado, com rótulo porque são dois arquivos.
    expect(n.message?.imageDescription).toContain("pedido 40000001");
    expect(n.message?.imageDescription).toContain("ja-lido.png");
  });

  // NOTE: a recovery that finally reads everything has to CLEAR the earlier failure: the store merges
  // field by field, so a count left out survives and the flush renders "N unread" beside the complete
  // extraction. Driven through TWO deliveries of the SAME message, because the webhook writes the
  // count and a test that stashes it by hand passes with the call site omitting it.
  test("a pass that reads everything clears the count a failed one left", async () => {
    clearMediaAnnotations();
    await clearFlowLog(suDb, { tenantId });
    const convId = CONV_ID + 5;

    // Primeira entrega: vision não roda, os dois anexos ficam não lidos.
    const primeira = await entregar(convId, [
      anexo(701, "a.png"),
      anexo(702, "b.png"),
    ]);
    expect(primeira.message?.attachmentsUnread).toBe(2);

    // Recuperação: os mesmos anexos, agora com a extração já persistida na meta.
    const segunda = await entregar(
      convId,
      [
        anexo(701, "a.png", { image_description: "pedido 40000001" }),
        anexo(702, "b.png", { image_description: "comprovante PIX" }),
      ],
      { reentrega: true },
    );
    expect(segunda.message?.attachmentsUnread).toBeUndefined();

    // O que o flush monta: a página não sabe de nada, o overlay responde.
    const row = {
      id: segunda.message?.id ?? 0,
      content: "",
      messageType: "incoming" as const,
      private: false,
      attachmentTypes: ["image", "image"],
      transcribedText: null,
      imageDescription: null,
      extractedText: null,
      attachmentName: null,
      location: null,
      inReplyTo: null,
      isReaction: false,
      emailSubject: null,
      activityType: null,
      senderType: null,
      visuals: [],
      externalSenderName: null,
      imported: false,
      senderId: null,
      sendId: null,
    } as ChatwootMessageRow;
    overlayMediaAnnotations(tenantId, instanceId, [row]);

    expect(row.imageDescription).toContain("comprovante PIX");
    expect(renderInboundMessage(toRenderable(row))).not.toContain(
      "anexos-nao-lidos",
    );
  });

  // NOTE: THE CAP IS A BUDGET ON PROVIDER CALLS, NOT ON HOW MUCH OF THE MESSAGE WE READ. Cutting the
  // list before checking what is already extracted would count results in hand as unread, and since
  // the overlay WINS over the page, nine descriptions would become eight plus "1 not read" and the
  // model would ask the customer to resend a file the page shows it.
  test("what is already extracted does not count against the cap", async () => {
    clearMediaAnnotations();
    await clearFlowLog(suDb, { tenantId });
    const convId = CONV_ID + 6;
    const nove = Array.from({ length: 9 }, (_, i) =>
      anexo(800 + i, `foto-${i + 1}.jpg`, {
        image_description: `descricao ${i + 1}`,
      }),
    );
    const n = await entregar(convId, nove);

    // Nada foi pago: nove extrações já estavam na meta, e o teto só governa o que falta ler.
    expect(await linhasDeVisao(convId)).toBe(0);
    // A nona é a que o corte descartava, e é ela que prova o defeito.
    expect(n.message?.imageDescription).toContain("descricao 9");
    expect(n.message?.attachmentsUnread).toBeUndefined();

    // O que o flush monta: a página não sabe de nada (Chatwoot upstream), o overlay responde.
    const row = {
      id: n.message?.id ?? 0,
      content: "",
      messageType: "incoming" as const,
      private: false,
      attachmentTypes: Array.from({ length: 9 }, () => "image"),
      transcribedText: null,
      imageDescription: null,
      extractedText: null,
      attachmentName: null,
      location: null,
      inReplyTo: null,
      isReaction: false,
      emailSubject: null,
      activityType: null,
      senderType: null,
      visuals: [],
      externalSenderName: null,
      imported: false,
      senderId: null,
      sendId: null,
    } as ChatwootMessageRow;
    overlayMediaAnnotations(tenantId, instanceId, [row]);

    expect(row.imageDescription).toContain("descricao 9");
    expect(renderInboundMessage(toRenderable(row))).not.toContain(
      "anexos-nao-lidos",
    );
  });

  // A meta write-back that lands for SOME attachments must not suppress the complete aggregate: it
  // is best-effort per attachment, so a page carrying one description out of two is a partial
  // reading of the same pass (a `??=` would let it win).
  test("a partially written meta does not suppress the complete aggregate", () => {
    clearMediaAnnotations();
    const alvo = { tenantId: 1n, instanceId: 2n, messageId: 4242 };
    stashMediaAnnotation(alvo, {
      imageDescription: "[a.png] pedido 40000001\n\n[b.png] comprovante PIX",
    });
    const row = {
      id: 4242,
      content: "",
      messageType: "incoming" as const,
      private: false,
      attachmentTypes: ["image", "image"],
      transcribedText: null,
      // Só o write-back do primeiro anexo chegou.
      imageDescription: "pedido 40000001",
      extractedText: null,
      attachmentName: null,
      location: null,
      inReplyTo: null,
      isReaction: false,
      emailSubject: null,
      activityType: null,
      senderType: null,
      visuals: [],
      externalSenderName: null,
      imported: false,
      senderId: null,
      sendId: null,
    } as ChatwootMessageRow;
    overlayMediaAnnotations(1n, 2n, [row]);

    expect(row.imageDescription).toContain("comprovante PIX");
  });

  // A message within the cap must not carry the notice: it would tell the model files are missing
  // when none are, and the model would ask the customer to resend what it already read.
  test("within the cap there is no overflow notice", async () => {
    await clearFlowLog(suDb, { tenantId });
    const n = await entregar(CONV_ID + 2, [anexo(301, "unico.png")]);

    expect(await linhasDeVisao(CONV_ID + 2)).toBeGreaterThan(0);
    // O único anexo foi tentado e a vision não pôde rodar: não lido, nomeado com o motivo, e sem o
    // aviso de que passou do teto.
    expect(n.message?.attachmentsUnread).toBe(1);
    const texto = renderInboundMessage(incomingRenderable(n));
    expect(texto).toContain('nome="unico.png" motivo="falha"');
    expect(texto).not.toContain("mais ");
  });
});
