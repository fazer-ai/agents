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
import { FakeListChatModel } from "@langchain/core/utils/testing";
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
import { reengageConversation } from "@/modules/conversations/reengage";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// ISSUE #757: O REENGAGE NÃO RODA A VISION, E O ANEXO CHEGA AO MODELO COMO IMAGEM ILEGÍVEL.
//
// A extração de imagem e documento é um passo eager do caminho de CHEGADA da mensagem
// (`runEagerMedia`, ../../src/modules/chatwoot/webhook.ts): ela escreve o resultado na meta do
// anexo, e é de lá que `parseChatwootMessages` monta `imageDescription`/`extractedText`. Uma
// conversa cujas mensagens chegaram ANTES de o agente observar a caixa nunca passou por esse
// caminho, e o reengage é justamente o botão que existe para atendê-la depois: ele relê a thread,
// acha o anexo sem meta, e `renderInboundMessage` entrega ao modelo o marcador
// "<usuário enviou uma imagem; peça que envie a informação por texto ou áudio>".
//
// O efeito, medido numa caixa de e-mail de produção: uma em cada cinco conversas elegíveis de um
// backfill tem anexo na última mensagem do cliente, e a resposta que sai diz que a imagem não deu
// para ler e pede de novo o número do pedido que está dentro dela.
//
// DETERMINÍSTICO E OFFLINE, pelo mesmo desenho de `vision-every-attachment.test.ts`: a vision do
// agente fica LIGADA e SEM credencial, então `extractInboundFile` toma o desvio `no_credential`
// antes de carregar cliente ou provedor, e emite a linha de estágio `vision` mesmo assim. Contar
// linhas mede a TENTATIVA, que é exatamente o que esta issue afirma não existir — e mede no ponto
// em que ela é consumida (o reengage de verdade), não numa função isolada.
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
let inboxDbId = 0n;
let agentId = 0n;

const REPLY = "Já verifiquei o que você mandou.";
const fakeModel = () => new FakeListChatModel({ responses: [REPLY] });

// O que o turno entregou ao modelo. O marcador do anexo não está no system prompt: ele é o texto
// da mensagem do cliente, montado por `renderInboundMessage`.
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

function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

interface Anexo {
  id: number;
  fileType?: string;
  dataUrl?: string;
  // O que uma passagem anterior já extraiu e gravou na meta do anexo.
  imageDescription?: string;
  extractedText?: string;
}

function page(
  msgs: Array<{
    id: number;
    content: string;
    type?: number;
    anexos?: Anexo[];
  }>,
) {
  return {
    payload: msgs.map((m) => ({
      id: m.id,
      content: m.content,
      message_type: m.type ?? 0,
      private: false,
      ...(m.anexos
        ? {
            attachments: m.anexos.map((a) => ({
              id: a.id,
              file_type: a.fileType ?? "image",
              data_url: a.dataUrl ?? `https://chat.example.com/a/${a.id}.png`,
              ...(a.imageDescription || a.extractedText
                ? {
                    meta: {
                      ...(a.imageDescription
                        ? { image_description: a.imageDescription }
                        : {}),
                      ...(a.extractedText
                        ? { extracted_text: a.extractedText }
                        : {}),
                    },
                  }
                : {}),
            })),
          }
        : {}),
    })),
  };
}

function makeStub(opts: { page: unknown; sent: Array<[number, string]> }) {
  const client = {
    getMessages: async () => opts.page,
    sendMessage: async (conversationId: number, content: string) => {
      opts.sent.push([conversationId, content]);
      return {};
    },
    toggleTyping: async () => ({}),
  } as unknown as ChatwootClient;
  return async () => client;
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

// As linhas de estágio `vision` desta conversa, que é o que conta a TENTATIVA de extração.
async function visionLines(convDbId: bigint) {
  return flowLogRows(suDb, {
    where: { tenantId, conversationId: convDbId, stage: "vision" },
    select: { status: true, detail: true },
    orderBy: { id: "asc" },
  });
}

describe.skipIf(!dbUp)("reengage: vision no anexo que nunca foi lido", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "RV", slug: `rv-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        // LIGADA E SEM CREDENCIAL: ver o cabeçalho. A extração para no desvio `no_credential`, que
        // é onde a linha de estágio sai, sem rede e sem provedor.
        settings: { vision: { enabled: true, provider: "openai" } },
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `rv-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "Suporte",
        agentId: agent.id,
      },
    });
    inboxDbId = inbox.id;
  });

  // O STASH É POR (tenant, instance, messageId), E OS CASOS AQUI REPETEM O ID DA MENSAGEM: sem
  // limpar entre eles, a anotação de um caso responde pelo seguinte, e o seguinte deixa de exercitar
  // o caminho que ele diz exercitar. Foi assim que a mutação "vision desligada deixa de ser
  // respeitada" sobreviveu à bateria: o agregado stashado pelo caso anterior fazia a mensagem passar
  // por já lida, e nenhuma extração era tentada nem com a cerca removida.
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

  test("a imagem sem extração é lida no turno do reengage", async () => {
    const id = await seedConversation(940);
    await clearFlowLog(suDb, { tenantId });
    const sent: Array<[number, string]> = [];

    const res = await reengageConversation(
      ctx(),
      id,
      {
        makeModel: fakeModel,
        makeClient: makeStub({
          page: page([{ id: 1, content: "", anexos: [{ id: 11 }] }]),
          sent,
        }),
        checkpointer: new MemorySaver(),
      },
      appDb,
    );

    expect(res.outcome).toBe("posted");
    // UMA TENTATIVA POR ANEXO. Hoje são zero: o reengage nunca chama a vision, e o anexo chega ao
    // modelo como "<usuário enviou uma imagem; peça que envie a informação por texto ou áudio>".
    const linhas = await visionLines(id);
    expect(linhas.length).toBe(1);
  });

  test("conversa sem anexo não custa nenhuma extração", async () => {
    const id = await seedConversation(941);
    await clearFlowLog(suDb, { tenantId });
    const sent: Array<[number, string]> = [];

    const res = await reengageConversation(
      ctx(),
      id,
      {
        makeModel: fakeModel,
        makeClient: makeStub({
          page: page([{ id: 1, content: "cadê meu pedido?" }]),
          sent,
        }),
        checkpointer: new MemorySaver(),
      },
      appDb,
    );

    expect(res.outcome).toBe("posted");
    expect(await visionLines(id)).toEqual([]);
  });

  test("anexo que já tem descrição não é extraído de novo", async () => {
    const id = await seedConversation(942);
    await clearFlowLog(suDb, { tenantId });
    const sent: Array<[number, string]> = [];

    const res = await reengageConversation(
      ctx(),
      id,
      {
        makeModel: fakeModel,
        makeClient: makeStub({
          page: page([
            {
              id: 1,
              content: "",
              anexos: [
                { id: 11, imageDescription: "Print do pedido 21607129." },
              ],
            },
          ]),
          sent,
        }),
        checkpointer: new MemorySaver(),
      },
      appDb,
    );

    expect(res.outcome).toBe("posted");
    // A meta já responde: reextrair custaria uma chamada paga para chegar ao mesmo texto.
    expect(await visionLines(id)).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------
  // COM EXTRAÇÃO DE VERDADE. Os casos acima medem a TENTATIVA; estes medem o que o modelo recebe,
  // que é onde a issue dói: o marcador que manda pedir reenvio some e o conteúdo do anexo entra.
  // O provedor é um fetch falso e o download é um stub, então não há rede nem custo.
  // ---------------------------------------------------------------------------------------------

  // Liga a credencial da vision só durante o caso: o resto do arquivo depende de ela NÃO existir.
  async function comCredencial<T>(fn: () => Promise<T>): Promise<T> {
    const key = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: `vis-${Date.now()}`,
        secret: encryptJson("sk-v"),
      },
      select: { id: true },
    });
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          vision: {
            enabled: true,
            provider: "openai",
            credentialRef: `vault:${key.id}`,
          },
        },
      },
    });
    try {
      return await fn();
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { vision: { enabled: true, provider: "openai" } } },
      });
    }
  }

  // Um PNG de 1x1, que é tudo o que o classificador de mime precisa ver.
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  function stubComAnexos(opts: {
    page: unknown;
    sent: Array<[number, string]>;
    metaEscrita: Array<[number, string]>;
    falharDownloadDe?: Set<number>;
  }) {
    const client = {
      getMessages: async () => opts.page,
      sendMessage: async (conversationId: number, content: string) => {
        opts.sent.push([conversationId, content]);
        return {};
      },
      toggleTyping: async () => ({}),
      downloadAttachment: async (dataUrl: string) => {
        const id = Number(/\/a\/(\d+)\./.exec(dataUrl)?.[1] ?? 0);
        if (opts.falharDownloadDe?.has(id))
          throw new Error("404 do anexo que não abre");
        return {
          bytes: PNG.buffer.slice(
            PNG.byteOffset,
            PNG.byteOffset + PNG.byteLength,
          ),
          contentType: dataUrl.endsWith(".pdf")
            ? "application/pdf"
            : "image/png",
        };
      },
      updateAttachmentMeta: async (
        _conversationId: number,
        _messageId: number,
        attachmentId: number,
        meta: Record<string, string>,
      ) => {
        opts.metaEscrita.push([
          attachmentId,
          meta.image_description ?? meta.extracted_text ?? "",
        ]);
        return {};
      },
    } as unknown as ChatwootClient;
    return async () => client;
  }

  // O provedor: devolve um texto por chamada, na ordem, e CONTA as chamadas — é a contagem que
  // separa "reusou o que já estava extraído" de "pagou de novo pelo mesmo anexo".
  const chamadasDoProvedor = { n: 0 };
  function visionFetch(textos: string[]) {
    let i = 0;
    chamadasDoProvedor.n = 0;
    return (async () => {
      chamadasDoProvedor.n++;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: textos[i++] ?? textos[0] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  }

  test("a descrição entra no turno, no lugar do marcador que pede reenvio", async () => {
    await comCredencial(async () => {
      const id = await seedConversation(943);
      await clearFlowLog(suDb, { tenantId });
      clearMediaAnnotations();
      const sent: Array<[number, string]> = [];
      const metaEscrita: Array<[number, string]> = [];
      const modelo = new TurnCapturingModel(REPLY);

      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: () => modelo,
          makeClient: stubComAnexos({
            page: page([{ id: 1, content: "", anexos: [{ id: 11 }] }]),
            sent,
            metaEscrita,
          }),
          visionFetch: visionFetch([
            "Print do pedido 21607129, no valor de R$ 115,00.",
          ]),
          checkpointer: new MemorySaver(),
        },
        appDb,
      );

      expect(res.outcome).toBe("posted");
      const turno = modelo.humanTexts.join("\n");
      expect(turno).toContain("Print do pedido 21607129");
      // O MARCADOR SOME. Ele é a frase que manda o agente pedir a informação "por texto ou áudio",
      // num canal que pode não ter áudio nenhum — e pedir de volta o que está dentro do anexo.
      expect(turno).not.toContain("peça que envie a informação");
      // E o resultado fica gravado no anexo, para o próximo turno não pagar de novo.
      expect(metaEscrita).toEqual([
        [11, "Print do pedido 21607129, no valor de R$ 115,00."],
      ]);
    });
  });

  test("imagem e documento na mesma mensagem: os dois chegam ao modelo", async () => {
    await comCredencial(async () => {
      const id = await seedConversation(944);
      await clearFlowLog(suDb, { tenantId });
      clearMediaAnnotations();
      const sent: Array<[number, string]> = [];
      const metaEscrita: Array<[number, string]> = [];
      const modelo = new TurnCapturingModel(REPLY);

      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: () => modelo,
          makeClient: stubComAnexos({
            page: page([
              {
                id: 1,
                content: "segue em anexo",
                anexos: [
                  { id: 21 },
                  {
                    id: 22,
                    fileType: "file",
                    dataUrl: "https://chat.example.com/a/22.pdf",
                  },
                ],
              },
            ]),
            sent,
            metaEscrita,
          }),
          visionFetch: visionFetch([
            "Foto do RG.",
            "Comprovante de PIX de R$ 115,00.",
          ]),
          checkpointer: new MemorySaver(),
        },
        appDb,
      );

      expect(res.outcome).toBe("posted");
      const turno = modelo.humanTexts.join("\n");
      expect(turno).toContain("<imagem>");
      expect(turno).toContain("<documento>");
      expect(metaEscrita.length).toBe(2);
    });
  });

  test("um anexo que não abre é nomeado ao modelo, e o outro chega inteiro", async () => {
    await comCredencial(async () => {
      const id = await seedConversation(945);
      await clearFlowLog(suDb, { tenantId });
      clearMediaAnnotations();
      const sent: Array<[number, string]> = [];
      const metaEscrita: Array<[number, string]> = [];
      const modelo = new TurnCapturingModel(REPLY);

      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: () => modelo,
          makeClient: stubComAnexos({
            page: page([
              { id: 1, content: "", anexos: [{ id: 31 }, { id: 32 }] },
            ]),
            sent,
            metaEscrita,
            falharDownloadDe: new Set([32]),
          }),
          visionFetch: visionFetch(["Print do pedido 21607129."]),
          checkpointer: new MemorySaver(),
        },
        appDb,
      );

      // O turno acontece: um arquivo ilegível não pode custar a resposta.
      expect(res.outcome).toBe("posted");
      const turno = modelo.humanTexts.join("\n");
      expect(turno).toContain("Print do pedido 21607129");
      // E o que não deu para ler é DITO, com a contagem: um modelo a quem não se diz nada responde
      // como se a mensagem tivesse um anexo a menos.
      expect(turno).toContain("<anexos-nao-lidos");
    });
  });

  test("vision desligada: o turno sai como saía, sem nenhuma tentativa", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: { settings: { vision: { enabled: false } } },
    });
    try {
      const id = await seedConversation(946);
      await clearFlowLog(suDb, { tenantId });
      const sent: Array<[number, string]> = [];

      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: fakeModel,
          makeClient: makeStub({
            page: page([{ id: 1, content: "", anexos: [{ id: 41 }] }]),
            sent,
          }),
          checkpointer: new MemorySaver(),
        },
        appDb,
      );

      expect(res.outcome).toBe("posted");
      expect(await visionLines(id)).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { vision: { enabled: true, provider: "openai" } } },
      });
    }
  });

  test("mensagem meio lida não é reaberta: a chegada já passou por ela", async () => {
    await comCredencial(async () => {
      const id = await seedConversation(947);
      await clearFlowLog(suDb, { tenantId });
      const sent: Array<[number, string]> = [];
      const metaEscrita: Array<[number, string]> = [];
      const modelo = new TurnCapturingModel(REPLY);
      const fetchFalso = visionFetch(["NÃO DEVERIA SER CHAMADO."]);

      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: () => modelo,
          makeClient: stubComAnexos({
            page: page([
              {
                id: 1,
                content: "",
                anexos: [
                  { id: 51, imageDescription: "Print do pedido 21607129." },
                  { id: 52 },
                ],
              },
            ]),
            sent,
            metaEscrita,
          }),
          visionFetch: fetchFalso,
          checkpointer: new MemorySaver(),
        },
        appDb,
      );

      expect(res.outcome).toBe("posted");
      // ZERO chamadas. Um anexo com meta e outro sem é a assinatura de uma mensagem que a CHEGADA
      // já processou e cujo write-back pousou pela metade: o stash daquela passagem tem o agregado
      // dos dois. Reabrir o que falta reextrai o que já existe, e uma segunda tentativa que perca
      // um arquivo publica um agregado mais pobre por cima do completo.
      expect(chamadasDoProvedor.n).toBe(0);
      // O que a meta tem continua chegando ao modelo.
      expect(modelo.humanTexts.join("\n")).toContain("Print do pedido 21607129");
    });
  });

  // OS DOIS CASOS ABAIXO SÃO O CHATWOOT UPSTREAM, onde a rota de write-back da meta não existe: a
  // extração da chegada não volta para o anexo, ela vive só no stash em memória. Foram achados pela
  // rodada 1 do review da PR, e cada um mata uma regra diferente.

  test("extração que só existe no stash: o reengage não paga o provedor de novo", async () => {
    await comCredencial(async () => {
      const id = await seedConversation(948);
      await clearFlowLog(suDb, { tenantId });
      clearMediaAnnotations();
      const sent: Array<[number, string]> = [];
      const metaEscrita: Array<[number, string]> = [];
      const modelo = new TurnCapturingModel(REPLY);
      const fetchFalso = visionFetch(["NÃO DEVERIA SER CHAMADO."]);
      // A passagem da chegada leu este anexo e stashou o agregado; a meta do anexo ficou vazia
      // porque o PATCH não existe no upstream.
      stashMediaAnnotation(
        { tenantId, instanceId, messageId: 601 },
        {
          imageDescription: "Print do pedido 21607129.",
          attachmentsUnread: 0,
        },
      );

      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: () => modelo,
          makeClient: stubComAnexos({
            page: page([{ id: 601, content: "", anexos: [{ id: 61 }] }]),
            sent,
            metaEscrita,
          }),
          visionFetch: fetchFalso,
          checkpointer: new MemorySaver(),
        },
        appDb,
      );

      expect(res.outcome).toBe("posted");
      // ZERO chamadas. Perguntando só à meta do anexo, esta mensagem pareceria intocada e o
      // religar pagaria de novo por um texto que já está em mãos — e uma segunda passagem em que
      // um arquivo falhe trocaria o agregado completo por um mais pobre.
      expect(chamadasDoProvedor.n).toBe(0);
      expect(modelo.humanTexts.join("\n")).toContain(
        "Print do pedido 21607129",
      );
    });
  });

  test("o stash expira no meio da rajada e a leitura não se perde", async () => {
    await comCredencial(async () => {
      const id = await seedConversation(950);
      await clearFlowLog(suDb, { tenantId });
      clearMediaAnnotations();
      const sent: Array<[number, string]> = [];
      const metaEscrita: Array<[number, string]> = [];
      const modelo = new TurnCapturingModel(REPLY);
      // O laço é sequencial e o stash tem TTL de 15 minutos: numa rajada de mensagens com
      // documento, a extração da PRIMEIRA pode vencer antes de o overlay final rodar. Aqui a
      // segunda chamada ao provedor apaga a loja inteira, que é essa expiração encenada.
      const base = visionFetch([
        "Comprovante de PIX de R$ 115,00.",
        "Print do pedido 21607129.",
      ]);
      const fetchFalso = (async (...args: unknown[]) => {
        const r = await (base as (...a: unknown[]) => Promise<Response>)(
          ...args,
        );
        if (chamadasDoProvedor.n >= 2) clearMediaAnnotations();
        return r;
      }) as unknown as typeof fetch;

      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: () => modelo,
          makeClient: stubComAnexos({
            page: page([
              { id: 801, content: "", anexos: [{ id: 81 }] },
              { id: 802, content: "", anexos: [{ id: 82 }] },
            ]),
            sent,
            metaEscrita,
          }),
          visionFetch: fetchFalso,
          checkpointer: new MemorySaver(),
        },
        appDb,
      );

      expect(res.outcome).toBe("posted");
      const turno = modelo.humanTexts.join("\n");
      // A primeira leitura chega ao modelo mesmo tendo saído da loja antes do fim do laço.
      expect(turno).toContain("Comprovante de PIX");
      expect(turno).toContain("Print do pedido 21607129");
    });
  });

  test("depois de ler tudo, o aviso de não lidos da tentativa anterior some", async () => {
    await comCredencial(async () => {
      const id = await seedConversation(949);
      await clearFlowLog(suDb, { tenantId });
      clearMediaAnnotations();
      const sent: Array<[number, string]> = [];
      const metaEscrita: Array<[number, string]> = [];
      const modelo = new TurnCapturingModel(REPLY);
      const fetchFalso = visionFetch([
        "Comprovante de PIX de R$ 115,00.",
        "Print do pedido 21607129.",
      ]);
      // A passagem da chegada TENTOU e não leu nenhum dos dois: sem descrição nenhuma, e a
      // contagem de não lidos em 2.
      stashMediaAnnotation(
        { tenantId, instanceId, messageId: 602 },
        { attachmentsUnread: 2 },
      );

      const res = await reengageConversation(
        ctx(),
        id,
        {
          makeModel: () => modelo,
          makeClient: stubComAnexos({
            page: page([
              { id: 602, content: "", anexos: [{ id: 71 }, { id: 72 }] },
            ]),
            sent,
            metaEscrita,
          }),
          visionFetch: fetchFalso,
          checkpointer: new MemorySaver(),
        },
        appDb,
      );

      expect(res.outcome).toBe("posted");
      const turno = modelo.humanTexts.join("\n");
      expect(turno).toContain("Comprovante de PIX");
      expect(turno).toContain("Print do pedido 21607129");
      // E NÃO diz mais que sobrou arquivo por ler: a contagem nova é zero, e zero é uma resposta.
      expect(turno).not.toContain("anexos-nao-lidos");
    });
  });
});
