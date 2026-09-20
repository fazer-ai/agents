import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { recoverStrandedDelivery } from "@/modules/chatwoot/recover-delivery";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

// A PASSADA QUE SÓ DEVIA MEMÓRIA NÃO PODE VIRAR UMA RESPOSTA NO REPLAY (issue #725).
//
// O receptor adia ao sweep a entrega cuja ingestão não conseguiu armar, e faz isso TAMBÉM no ramo em
// que nenhum turno ia rodar: a conversa está com uma pessoa (`!act`), então o que aquela passada
// devia era um append e nada mais. Meia hora depois o sweep declara a linha encalhada e o replay
// re-executa a entrega inteira, que re-deriva tudo das condições de AGORA. Se a conversa voltou para
// o bot nesse meio-tempo, `act` agora é verdadeiro e o turno posta — uma resposta que ninguém pediu,
// para uma mensagem que uma pessoa já tratou.
//
// O caminho é o real nas duas metades: o receptor de verdade deixa a linha em `PROCESSING`, e o
// replay de verdade a retoma. Um teste que semeasse a linha à mão provaria o replay e não o par, e é
// o par que produz o estado.

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

const INBOX_ID = 91;
// A inbox cuja agenda de atendimento está SEMPRE fechada: toda mensagem cai no portão de fora de
// horário, que responde o aviso de ausência e CONSOME a mensagem (`act && consumed`).
const INBOX_CLOSED = 92;
const BOT_ID = 11;
const CONTACT_INBOX_BASE = 91_000;
const SENT_AT = Math.floor(Date.now() / 1000) - 3600;
let tenantId = 0n;
let instanceId = 0n;
let deliverySeq = 0;
let messageSeq = 7000;
let stamp = Math.floor(Date.now() / 1000);
const realFetch = globalThis.fetch;

describe.skipIf(!dbUp)("a replay that owes memory only", () => {
  beforeAll(async () => {
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const t = await suDb.tenant.create({
      data: { name: "ROM", slug: `rom-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 21,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        settings: { debounce: { enabled: false } },
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: BOT_ID,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `rom-route-${process.pid}`,
        name: "Atendente",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_ID,
        name: "Vendas",
        agentId: agent.id,
      },
    });
    // FECHADA HOJE, e não "sem janelas": agenda sem janela nenhuma é agente sempre disponível
    // (`scheduleCanClose` pede pelo menos uma), então o portão nunca fecharia. A forma que fecha sem
    // depender da hora em que a suíte roda é ter a semana aberta e o DIA DE HOJE como exceção sem
    // faixas, que é o feriado.
    const hoje = new Date().toISOString().slice(0, 10);
    const fechada = await suDb.businessHours.create({
      data: {
        tenantId,
        name: "Fechado hoje",
        timezone: "UTC",
        windows: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
          day,
          start: "09:00",
          end: "18:00",
        })),
        exceptions: [{ date: hoje, label: "Feriado", ranges: [] }],
      },
      select: { id: true },
    });
    const forazinho = await suDb.agent.create({
      data: {
        tenantId,
        name: "Plantao",
        systemPrompt: "Você é prestativa.",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        settings: { debounce: { enabled: false } },
        businessHoursId: fechada.id,
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_CLOSED,
        name: "Plantao",
        agentId: forazinho.id,
      },
    });
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!dbUp) return;
    for (const table of [
      "execution_logs",
      "scheduler_jobs",
      "chatwoot_webhook_deliveries",
      "agent_threads",
      "conversations",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
      "chatwoot_instances",
      "business_hours",
    ]) {
      await suDb
        .$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = ${tenantId}`)
        .catch(() => {});
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // A conversa como o cliente a encontra quando uma PESSOA a está atendendo: `shouldBotHandle` é
  // falso, nenhum turno roda, e o que a mensagem deve é a ingestão contínua e nada mais.
  function heldByHuman(convId: number, inboxId = INBOX_ID) {
    stamp += 1;
    return {
      id: convId,
      inbox_id: inboxId,
      status: "open",
      contact_inbox: { id: CONTACT_INBOX_BASE + convId },
      meta: {
        assignee_type: "user",
        assignee: { id: 5, name: "Ana" },
        sender: { id: 77, name: "Cliente" },
      },
      channel: "Channel::Api",
      last_activity_at: Math.floor(Date.now() / 1000),
      updated_at: stamp,
    };
  }

  // A MESMA conversa, mas do BOT: ninguém a segura, então `act` é verdadeiro e quem cala a mensagem
  // é o portão, não a posse. É o outro lado de `(act && consumed) || !act`.
  function heldByBot(convId: number, inboxId: number) {
    stamp += 1;
    return {
      id: convId,
      inbox_id: inboxId,
      status: "pending",
      contact_inbox: { id: CONTACT_INBOX_BASE + convId },
      meta: { assignee: null, sender: { id: 77, name: "Cliente" } },
      channel: "Channel::Api",
      last_activity_at: Math.floor(Date.now() / 1000),
      updated_at: stamp,
    };
  }

  // O scheduler recusa exatamente o INGEST_MESSAGE, que é a falha que deixa a linha para o sweep.
  const semFila = () =>
    appDb.$extends({
      query: {
        schedulerJob: {
          $allOperations({ args, query }) {
            const shape = JSON.stringify(args, (_k, v) =>
              typeof v === "bigint" ? String(v) : v,
            );
            if (shape.includes("INGEST_MESSAGE")) {
              throw new Error("injected: scheduler unavailable");
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

  async function strandOn(
    convId: number,
    content: string,
    conversa: Record<string, unknown>,
  ): Promise<{
    rowId: bigint;
    messageId: number;
    status: string;
    owesMemoryOnly: boolean | null;
    routeRemembers: boolean | null;
  }> {
    deliverySeq += 1;
    messageSeq += 1;
    const messageId = messageSeq;
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageId,
      private: false,
      content,
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
      conversation: conversa,
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `rom-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: "PENDING",
        // Os dois fatos que o receptor de verdade grava no INSERT e que a recuperação exige para
        // considerar a linha recuperável (`isRecoverableStrand`). `processChatwootDelivery` recebe a
        // linha já registrada: quem a insere é `recordAndProcessChatwootDelivery`, um passo acima.
        conversationId: convId,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: BOT_ID,
      normalized: n,
      base: semFila(),
    }).catch(() => {});
    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
      select: {
        status: true,
        conversationId: true,
        inboundMessageId: true,
        routeObserved: true,
        routeRemembers: true,
        turnCovered: true,
        owesMemoryOnly: true,
      },
    });
    return {
      rowId: delivery.id,
      messageId,
      status: row.status,
      owesMemoryOnly: row.owesMemoryOnly,
      routeRemembers: row.routeRemembers,
    };
  }

  // A conversa devolvida ao bot, que é o único passo entre o encalhe e o replay. Nenhuma mensagem
  // nova: a medição ao vivo da issue mostra que não é preciso nenhuma para o replay postar.
  async function handBackToBot(convId: number) {
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: convId },
      data: { assigneeType: null, assigneeId: null, status: "pending" },
    });
  }

  function stubChatwoot(
    convId: number,
    messageId: number,
    content: string,
    // Uma mensagem MAIS NOVA do cliente na página não ancorada, que é o que a cerca de frescor lê.
    newer?: { id: number; content: string },
  ) {
    const sent: Array<[number, string]> = [];
    const client = {
      getConversation: async (conversationId: number) => ({
        id: conversationId,
        status: "pending",
        inbox_id: INBOX_ID,
        last_activity_at: SENT_AT,
        timestamp: SENT_AT,
        meta: { assignee: null, sender: { id: 77, name: "Cliente" } },
      }),
      getMessages: async (_conversationId: number, o?: { before?: number }) => {
        const msg = (id: number, text: string, at: number) => ({
          id,
          content: text,
          message_type: 0,
          private: false,
          inbox_id: INBOX_ID,
          created_at: at,
          sender: { id: 77, name: "Cliente", type: "contact" },
          attachments: [],
        });
        const base = [msg(messageId, content, SENT_AT)];
        // A leitura ANCORADA (`before`) é a página que termina na mensagem encalhada; a não ancorada
        // é a mais nova, e é ela que diz se o cliente escreveu de novo.
        if (o?.before !== undefined || newer === undefined)
          return { payload: base };
        return {
          payload: [...base, msg(newer.id, newer.content, SENT_AT + 600)],
        };
      },
      sendMessage: async (conversationId: number, text: string) => {
        sent.push([conversationId, text]);
        return {};
      },
      toggleTyping: async () => ({}),
      sendPrivateNote: async () => ({}),
      listLabels: async () => [],
      listCustomAttributeDefinitions: async () => [],
      kanbanTaskForConversation: async () => null,
    } as unknown as ChatwootClient;
    void convId;
    return { makeClient: async () => client, sent };
  }

  // CONTRASTE: a MESMA entrega sem a falha de arme, para saber o que a linha registra quando nada
  // encalha. Sem isso não dá para dizer se `route_remembers = false` é a assinatura do encalhe ou a
  // verdade da rota.
  test("contraste: a mesma entrega sem falha de arme", async () => {
    const convId = 9402;
    deliverySeq += 1;
    messageSeq += 1;
    const messageId = messageSeq;
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageId,
      private: false,
      content: "e no cartão, dá?",
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
      conversation: heldByHuman(convId),
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `rom-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: "PENDING",
        conversationId: convId,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: BOT_ID,
      normalized: n,
      base: appDb,
    });
    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
      select: { status: true, routeRemembers: true, owesMemoryOnly: true },
    });
    // A MESMA rota, sem encalhe: a linha liquida e registra que a rota LEMBRA.
    expect(row.status).toBe("PROCESSED");
    expect(row.routeRemembers).toBe(true);
    // E A MARCA É SOBRE A PASSADA, NÃO SOBRE O ENCALHE: esta também só devia memória, e diz isso,
    // mesmo tendo liquidado. Tem que ser assim — o receptor escreve antes do arme, e no instante em
    // que escreve ninguém sabe se o arme vai falhar. Numa linha liquidada o fato não custa nada: a
    // varredura lê `PENDING` e `PROCESSING`, então replay nenhum a alcança.
    expect(row.owesMemoryOnly).toBe(true);
  });

  test("a mensagem que uma pessoa já tratou não é respondida quando a conversa volta ao bot", async () => {
    const convId = 9401;
    const texto = "consigo pagar em duas vezes?";

    const { rowId, messageId, status, owesMemoryOnly, routeRemembers } =
      await strandOn(convId, texto, heldByHuman(convId));
    // A premissa do caso: a linha ficou no estado que o sweep revisita...
    expect(status).toBe("PROCESSING");
    // ...carregando o que aquela passada devia...
    expect(owesMemoryOnly).toBe(true);
    // ...e NÃO podendo ser reconhecida por `route_remembers`, que numa linha encalhada é `false`
    // pela própria razão de ela ter encalhado: a correção para `true` roda depois do arme, e o arme
    // é o que falhou. Medido contra o contraste acima, onde a mesma rota registra `true`.
    expect(routeRemembers).toBe(false);

    // O passo do sweep: a linha encalhada é declarada morta, que é o estado do qual a recuperação
    // parte (`seedDeadDelivery` do arquivo irmão descreve a mesma linha).
    await suDb.chatwootWebhookDelivery.update({
      where: { id: rowId },
      data: { status: "DEAD" },
    });

    await handBackToBot(convId);

    const stub = stubChatwoot(convId, messageId, texto);
    // Quantas vezes um modelo foi construído, que é quantos turnos de fato rodaram. Sem isso, um
    // conserto que deixa o turno rodar e só barra o envio no fim passa igual — e aí a conversa
    // carrega um turno inteiro (ferramentas, custo, marcas) por uma mensagem que ninguém pediu.
    const turnos = { built: 0 };
    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: {
        makeClient: stub.makeClient,
        makeModel: () => {
          turnos.built += 1;
          return new FakeListChatModel({ responses: ["Claro, consegue sim!"] });
        },
        checkpointer: new MemorySaver(),
        sleep: async () => {},
      },
    });

    // O QUE A ISSUE MEDE: aquela passada devia memória e não devia resposta, e o replay não tinha
    // como saber disso. Ele re-derivava a posse do estado de agora, encontrava o bot de volta na
    // conversa, e falava por cima de um atendimento humano que já tinha acontecido.
    expect(stub.sent).toEqual([]);
    // E A DECISÃO É ANTES DO TURNO, não no envio: nenhum modelo foi construído.
    expect(turnos.built).toBe(0);
    // E a perda fecha: a mensagem alcançou a memória, que era tudo o que aquela passada devia. É o
    // mesmo desfecho que o replay de um observador já tem, pela mesma razão.
    expect(outcome).toBe("recovered");
  });

  // A SEGUNDA DIREÇÃO DO MESMO FATO QUE FALTAVA: a cerca de frescor existe para não responder por
  // cima de uma conversa que andou, e ela raciocina sobre uma RESPOSTA. Numa passada que só deve
  // memória não há resposta para chegar atrasada, e a recusa custava à mensagem toda memória que ela
  // ainda podia alcançar — que é a perda certa e silenciosa que este subsistema inteiro existe para
  // impedir. É o mesmo argumento que o arquivo já faz para a rota do observador.
  test("uma mensagem mais nova do cliente não impede a memória de uma passada que só a devia", async () => {
    const convId = 9403;
    const texto = "esqueci de dizer: é para amanhã";

    const { rowId, messageId } = await strandOn(
      convId,
      texto,
      heldByHuman(convId),
    );
    await suDb.chatwootWebhookDelivery.update({
      where: { id: rowId },
      data: { status: "DEAD" },
    });
    await handBackToBot(convId);

    // O cliente escreveu de novo enquanto a linha estava encalhada, que é o comum: a varredura só
    // olha linhas com mais de meia hora, e meia hora é mais ou menos o que um cliente sem resposta
    // espera antes de insistir.
    const stub = stubChatwoot(convId, messageId, texto, {
      id: messageId + 50,
      content: "oi? conseguiu ver?",
    });

    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: {
        makeClient: stub.makeClient,
        makeModel: () => new FakeListChatModel({ responses: ["Vi sim!"] }),
        checkpointer: new MemorySaver(),
        sleep: async () => {},
      },
    });

    // A mensagem é recuperada em vez de recusada atrás da mais nova...
    expect(outcome).toBe("recovered");
    // ...e continua sem ninguém falando por cima do atendimento humano.
    expect(stub.sent).toEqual([]);
  });

  // E A CERCA CONTINUA DE PÉ ONDE ELA FOI FEITA PARA ESTAR: o encalhe comum, de uma conversa que era
  // do bot o tempo todo, é respondido. Sem este caso, o conserto acima passaria igual calando o
  // replay inteiro, que é o defeito oposto e pior: o cliente que ninguém atendeu deixaria de ser
  // atendido.
  test("o encalhe comum de uma conversa do bot continua sendo respondido", async () => {
    const convId = 9404;
    const texto = "tem alguém aí?";
    deliverySeq += 1;
    messageSeq += 1;
    const messageId = messageSeq;
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `rom-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: "DEAD",
        conversationId: convId,
        inboundMessageId: messageId,
        // A linha que a passada de um bot deixa: nada nela diz que alguma coisa a silenciou.
        owesMemoryOnly: null,
      },
      select: { id: true },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "pending",
        assigneeType: null,
        assigneeId: null,
        inboxId: (
          await suDb.inbox.findFirstOrThrow({
            where: { tenantId, chatwootInboxId: INBOX_ID },
            select: { id: true },
          })
        ).id,
        threadId: `t-${convId}`,
        lastEventAt: new Date(),
        contactInboxId: CONTACT_INBOX_BASE + convId,
      },
    });

    const stub = stubChatwoot(convId, messageId, texto);
    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: delivery.id,
      base: appDb,
      deps: {
        makeClient: stub.makeClient,
        makeModel: () => new FakeListChatModel({ responses: ["Estou aqui!"] }),
        checkpointer: new MemorySaver(),
        sleep: async () => {},
      },
    });

    expect(outcome).toBe("recovered");
    // O cliente recebe a resposta que o encalhe devia.
    expect(stub.sent).toEqual([[convId, "Estou aqui!"]]);
  });

  // O OUTRO LADO DE `(act && consumed) || !act`, E O QUE ELE REVELOU. Aqui ninguém segura a
  // conversa: o bot é o dono e quem calou a mensagem foi um PORTÃO, o horário de atendimento, que já
  // respondeu ao cliente o aviso de ausência. A issue chama este de o pior dos três sítios, porque
  // uma resposta depois contradiz uma decisão explícita do operador.
  //
  // MEDIDO AQUI: ele não chega a acontecer hoje. A entrega deste ramo NÃO é adiada à varredura, ela
  // liquida na própria passada (`settleAwaitsIngest` pede `!consumed`), então não vira encalhe, não
  // vira `DEAD` e replay nenhum a alcança. É o que o comentário do receptor já dizia ao deixar o
  // sítio irmão de fora do adiamento da #721, e é a metade da issue que não procede como defeito
  // atual: é um risco de quem for adiar esse ramo depois.
  //
  // A MARCA É ESCRITA MESMO ASSIM, e é isso que este caso prende: ela descreve o que a PASSADA
  // devia, não o que aconteceu com a linha. Restringi-la ao ramo da posse humana passaria em toda a
  // suíte de hoje e deixaria o adiamento futuro deste ramo sem a única coisa que impede a resposta
  // duplicada.
  test("a passada que um portão silenciou também diz que só devia memória", async () => {
    const convId = 9405;
    const texto = "vocês abrem sábado?";

    const { status, owesMemoryOnly } = await strandOn(
      convId,
      texto,
      heldByBot(convId, INBOX_CLOSED),
    );

    // A linha fecha na própria passada: este ramo não vai para a varredura.
    expect(status).toBe("PROCESSED");
    // E ainda assim diz o que devia.
    expect(owesMemoryOnly).toBe(true);
  });
});
