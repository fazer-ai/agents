import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { clearTurnInFlight, markTurnInFlight } from "@/graph/inflight";
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
const INBOX_TEST = 93;
let inboxTestDbId: bigint;
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
    // MODO TESTE: a rota que NÃO ingere continuamente (`ingestsContinuously("test")` é falso), e por
    // isso a única em que o dever gravado na linha não tem como ser honrado se o portão da ingestão
    // só olhar a rota. É o caso do achado da rodada 5.
    const emTeste = await suDb.agent.create({
      data: {
        tenantId,
        name: "Em teste",
        systemPrompt: "Você é prestativa.",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        settings: { debounce: { enabled: false } },
        mode: "test",
      },
    });
    const caixaTeste = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_TEST,
        name: "Em teste",
        agentId: emTeste.id,
      },
      select: { id: true },
    });
    inboxTestDbId = caixaTeste.id;
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

  // A MESMA conversa nas mãos de OUTRO AgentBot, que é o único estado em que a liquidação da
  // passada é estreitada: o silêncio é sobre NÓS, e a linha que esta mensagem também tem na rota do
  // outro bot pertence a uma entrega que pode estar trabalhando agora. `meta.assignee` vem com id
  // porque o jbuilder do Chatwoot sempre renderiza o agent_bot_slim junto do `assignee_type`, e sem
  // ele o payload não normaliza.
  function heldByAnotherBot(convId: number, inboxId = INBOX_ID) {
    stamp += 1;
    return {
      id: convId,
      inbox_id: inboxId,
      status: "pending",
      contact_inbox: { id: CONTACT_INBOX_BASE + convId },
      meta: {
        assignee_type: "AgentBot",
        assignee: { id: BOT_ID + 88, name: "Bot do vizinho" },
        sender: { id: 77, name: "Cliente" },
      },
      channel: "Channel::Api",
      last_activity_at: Math.floor(Date.now() / 1000),
      updated_at: stamp,
    };
  }

  // A LINHA IRMÃ: a mesma mensagem, na mesma conversa, por outra rota, no estado que a liquidação
  // ampla alcança (`PROCESSING` com `route_observed` explicitamente `false`, que é o que aquele
  // `updateMany` exige). É ela que mede a diferença entre os dois escopos, porque o escopo estreito
  // nomeia uma linha só e o amplo nomeia a mensagem.
  async function irma(convId: number, messageId: number): Promise<bigint> {
    deliverySeq += 1;
    const row = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `irma-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: "PROCESSING",
        conversationId: convId,
        inboundMessageId: messageId,
        routeObserved: false,
      },
      select: { id: true },
    });
    return row.id;
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
    settleScopedToThisDelivery: boolean | null;
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
        settleScopedToThisDelivery: true,
      },
    });
    return {
      rowId: delivery.id,
      messageId,
      status: row.status,
      owesMemoryOnly: row.owesMemoryOnly,
      settleScopedToThisDelivery: row.settleScopedToThisDelivery,
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
    // A CAIXA QUE O REPLAY VAI LER. É por aqui que ele resolve a rota, então um stub que responde
    // sempre a mesma caixa faz todo replay cair no agente dela — medido: um caso escrito para a rota
    // em modo teste resolvia o agente de produção e passava sem medir nada.
    inboxId = INBOX_ID,
  ) {
    const sent: Array<[number, string]> = [];
    const client = {
      getConversation: async (conversationId: number) => ({
        id: conversationId,
        status: "pending",
        inbox_id: inboxId,
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
          inbox_id: inboxId,
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

  // O TERCEIRO SITE DA ISSUE, e o que o resto do arquivo não alcança. Nos casos acima a posse já
  // era de uma pessoa QUANDO a mensagem chegou, então `act` é falso e a liquidação lá em cima grava
  // a coluna. Aqui a conversa é do bot na chegada, o turno começa, e a pessoa assume ENQUANTO ele
  // espera o thread: `act` fica verdadeiro e `consumed` falso, nenhuma das três metades daquela
  // condição vale, e a linha ia para a varredura com a coluna NULA.
  //
  // O que isso custava foi medido pelo verificador, e é a parte que engana: com a coluna nula o
  // replay re-derivava a posse de agora, achava o bot de volta na conversa e rodava o turno inteiro.
  // Ele não postava, mas quem o parava era a #703 vendo a resposta do colega na página — e uma
  // pessoa que assume e AINDA NÃO ESCREVEU não deixa resposta nenhuma para ser vista. É essa parada
  // que o teste reproduz: takeover sem réplica do colega.
  test("uma pessoa que assume durante o turno e não escreve nada também deixa a linha devendo só memória", async () => {
    const convId = 9410;
    const texto = "posso trocar o horário de amanhã?";
    deliverySeq += 1;
    messageSeq += 1;
    const messageId = messageSeq;
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageId,
      private: false,
      content: texto,
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
      conversation: heldByBot(convId, INBOX_ID),
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
    // O thread ocupado é o que faz o turno ESPERAR, e a espera é a janela inteira do takeover.
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      CONTACT_INBOX_BASE + convId,
    );
    markTurnInFlight(graphThreadId);
    const postado: string[] = [];
    // Num objeto e não num `let`: a atribuição mora numa closure, e o TS mantém o `null` estreitado
    // no ponto da asserção (medido: `TS2769` dizendo que a string não cabe em `null`).
    const visto = { desfecho: null as string | null };
    const run = processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: BOT_ID,
      normalized: n,
      base: semFila(),
      // O DESFECHO É AFIRMADO, e não inferido do efeito: `taken-over-unread` é o que diz que a
      // parada medida foi ESTA. Sem ele, um `SsrfError` a meio turno produz `PROCESSING` igual e o
      // teste passaria sobre a parada errada, que foi o que aconteceu na primeira escrita dele.
      onDirectTurn: (r) => {
        visto.desfecho =
          r.kind === "outcome" ? r.outcome : `error:${String(r.error)}`;
      },
      deps: {
        // O turno tem que chegar à parada por POSSE, e não morrer antes dela: o SafeFetch resolve o
        // DNS antes do fetch, então o stub global de `fetch` deste arquivo não cobre um cliente de
        // verdade e o turno falharia com `SsrfError` — outra parada, com outro desfecho.
        makeClient: (async () =>
          ({
            sendMessage: async (_id: number, text: string) => {
              postado.push(text);
              return {};
            },
            sendPrivateNote: async () => ({}),
            toggleTyping: async () => ({}),
          }) as unknown as ChatwootClient) as never,
        makeModel: () =>
          new FakeListChatModel({ responses: ["Claro, posso trocar."] }),
      },
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    const assumiu = await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: convId },
      data: { assigneeType: "User", assigneeId: 5, status: "open" },
    });
    // A PREMISSA, e ela é afirmada porque pode falhar em silêncio: se o espelho da conversa ainda
    // não existisse, o `updateMany` não mexeria em linha nenhuma, o turno não veria takeover
    // nenhum, e o teste passaria medindo outra parada.
    expect(assumiu.count).toBe(1);
    clearTurnInFlight(graphThreadId);
    await run;

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
      select: {
        status: true,
        owesMemoryOnly: true,
        settleScopedToThisDelivery: true,
      },
    });
    // NADA FOI DITO POR CIMA DA PESSOA, e o desfecho nomeia a parada: o turno leu a posse de novo
    // depois da espera e parou antes do invoke. (O modelo é CONSTRUÍDO antes dessa releitura, na
    // preparação, então contar construções mediria o passo errado.)
    expect(postado).toEqual([]);
    expect(visto.desfecho).toBe("taken-over-unread");
    // A linha ficou para a varredura, que é o desfecho certo (a mensagem não está na memória de
    // ninguém, porque o arme falhou)...
    expect(row.status).toBe("PROCESSING");
    // ...mas agora ela carrega O QUE AQUELA PASSADA DEVIA. Sem esta escrita a coluna é nula, e nula
    // é o replay re-derivando a posse de agora.
    expect(row.owesMemoryOnly).toBe(true);
    // E A LARGURA É AMPLA: o silêncio aqui é sobre a mensagem, não sobre esta rota. Estreitá-lo
    // deixaria a linha irmã da mesma mensagem, noutra rota, sem saber que ela também só deve
    // memória — e o escopo estreito existe só para o caso do outro bot, que pode estar trabalhando
    // nela agora.
    expect(row.settleScopedToThisDelivery).toBe(false);
  });

  // O ACHADO DA RODADA 5, e ele é sobre a ÚNICA rota em que o dever gravado não tinha como ser
  // honrado. A parada por posse FORÇA a ingestão (`routeIngests` lê `stoodDownUnread`), e ela existe
  // exatamente para o modo teste: `ingestsContinuously("test")` é falso, então sem a força a
  // mensagem do cliente não iria a lugar nenhum. Só que no REPLAY o turno é deliberadamente
  // suprimido — é o conserto desta issue —, então `stoodDownUnread` nunca vale ali, e
  // `routeIngests` cai para `routeRemembers`, que é falso nesta rota. Resultado: a linha dizia que
  // devia memória e o replay não tinha por onde pagar.
  //
  // A coluna É o dever, então ela também abre o portão da ingestão. O teste mede as duas pontas na
  // mesma rota: a passada grava o dever, e o replay paga.
  test("no modo teste o dever gravado abre a ingestão do replay, que é a rota onde nada mais abre", async () => {
    const convId = 9411;
    const texto = "esse número é o certo?";
    deliverySeq += 1;
    messageSeq += 1;
    const messageId = messageSeq;
    // A ATIVAÇÃO do `/teste` é o que faz o agente em modo teste agir; ela mora na conversa, e os
    // portões leem a do EPISÓDIO, então o espelho precisa existir carimbado ANTES do evento.
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        contactInboxId: CONTACT_INBOX_BASE + convId,
        // A CAIXA, e não só o id do Chatwoot: o REPLAY resolve a rota pelo espelho, e sem este
        // vínculo ele cai no agente do bot (produção) — medido, e com isso o caso deste teste
        // simplesmente não acontece, porque `routeRemembers` volta a ser verdadeiro.
        inboxId: inboxTestDbId,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${convId}`,
        testActivatedAt: new Date(),
      },
    });
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageId,
      private: false,
      content: texto,
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
      conversation: heldByBot(convId, INBOX_TEST),
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
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      CONTACT_INBOX_BASE + convId,
    );
    markTurnInFlight(graphThreadId);
    const run = processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: BOT_ID,
      normalized: n,
      base: semFila(),
      deps: {
        makeClient: (async () =>
          ({
            sendMessage: async () => ({}),
            sendPrivateNote: async () => ({}),
            toggleTyping: async () => ({}),
          }) as unknown as ChatwootClient) as never,
        makeModel: () =>
          new FakeListChatModel({ responses: ["É esse mesmo!"] }),
      },
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    const assumiu = await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: convId },
      data: { assigneeType: "User", assigneeId: 5, status: "open" },
    });
    expect(assumiu.count).toBe(1);
    clearTurnInFlight(graphThreadId);
    await run;

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
      select: { status: true, owesMemoryOnly: true, routeRemembers: true },
    });
    // A PREMISSA DA ROTA, afirmada porque é ela que torna o caso único: esta rota NÃO lembra
    // continuamente. Num agente de produção o replay pagaria pelo `routeRemembers` e o teste passaria
    // sem medir nada.
    expect(row.routeRemembers).toBe(false);
    expect(row.status).toBe("PROCESSING");
    expect(row.owesMemoryOnly).toBe(true);

    // O REPLAY PAGA O DEVER. Sem o dever no portão da ingestão, nada é enfileirado aqui e a mensagem
    // do cliente fica sem memória nenhuma, com a linha já dizendo que devia.
    await suDb.chatwootWebhookDelivery.update({
      where: { id: delivery.id },
      data: { status: "DEAD" },
    });
    const stub = stubChatwoot(convId, messageId, texto, undefined, INBOX_TEST);
    await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: delivery.id,
      base: appDb,
      deps: {
        makeClient: stub.makeClient,
        makeModel: () =>
          new FakeListChatModel({ responses: ["É esse mesmo!"] }),
        checkpointer: new MemorySaver(),
        sleep: async () => {},
      },
    });
    expect(stub.sent).toEqual([]);
    const jobs = await suDb.schedulerJob.findMany({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: { contains: `:ci:${CONTACT_INBOX_BASE + convId}:` },
      },
      select: { dedupeKey: true },
    });
    expect(jobs.map((j) => j.dedupeKey)).toEqual([
      `ingest:${tenantId}:${instanceId}:ci:${CONTACT_INBOX_BASE + convId}:${messageId}`,
    ]);
  });

  // O SITE IRMÃO DO ACHADO DA RODADA 5. Com o dever abrindo o portão da ingestão, o replay de uma
  // rota que não lembra continuamente passa a enfileirar o append — mas a LIQUIDAÇÃO ainda espera
  // `routeRemembers`, não o dever. Se o arme falhar TAMBÉM no replay, a linha fecha terminal com a
  // marca por cima de uma mensagem que memória nenhuma tem, que é exatamente o trio que o corpo da
  // issue mede, de volta por outra porta.
  test("no modo teste um arme que falha no replay não fecha a linha nem passa a marca", async () => {
    const convId = 9412;
    const texto = "e esse aqui funciona?";
    deliverySeq += 1;
    messageSeq += 1;
    const messageId = messageSeq;
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        contactInboxId: CONTACT_INBOX_BASE + convId,
        inboxId: inboxTestDbId,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${convId}`,
        testActivatedAt: new Date(),
      },
    });
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageId,
      private: false,
      content: texto,
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
      conversation: heldByBot(convId, INBOX_TEST),
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
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      CONTACT_INBOX_BASE + convId,
    );
    markTurnInFlight(graphThreadId);
    const run = processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: BOT_ID,
      normalized: n,
      base: semFila(),
      deps: {
        makeClient: (async () =>
          ({
            sendMessage: async () => ({}),
            sendPrivateNote: async () => ({}),
            toggleTyping: async () => ({}),
          }) as unknown as ChatwootClient) as never,
        makeModel: () => new FakeListChatModel({ responses: ["Funciona!"] }),
      },
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    const assumiu = await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: convId },
      data: { assigneeType: "User", assigneeId: 5, status: "open" },
    });
    expect(assumiu.count).toBe(1);
    clearTurnInFlight(graphThreadId);
    await run;

    await suDb.chatwootWebhookDelivery.update({
      where: { id: delivery.id },
      data: { status: "DEAD" },
    });
    const stub = stubChatwoot(convId, messageId, texto, undefined, INBOX_TEST);
    // O ARME FALHA NO REPLAY TAMBÉM, que é a condição do caso: o scheduler continua recusando.
    await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: delivery.id,
      base: semFila(),
      deps: {
        makeClient: stub.makeClient,
        makeModel: () => new FakeListChatModel({ responses: ["Funciona!"] }),
        checkpointer: new MemorySaver(),
        sleep: async () => {},
      },
    });

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
      select: { status: true, owesMemoryOnly: true },
    });
    const marca = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { lastHandledMessageId: true },
    });
    // NADA FOI DITO, e a linha continua devendo: não é terminal e a marca não passou por cima.
    expect(stub.sent).toEqual([]);
    expect(row.owesMemoryOnly).toBe(true);
    expect(row.status).not.toBe("PROCESSED");
    expect(marca.lastHandledMessageId ?? 0).toBeLessThan(messageId);
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
    // E "recuperada" TEM QUE QUERER DIZER GUARDADA: o desfecho sozinho não distingue um replay que
    // enfileirou o append de um que fechou a linha sem nada. Esta é a asserção que separa os dois.
    // Escopado por contact-inbox: os outros casos deste arquivo enfileiram os seus, e uma leitura
    // solta responderia sobre a conversa do vizinho.
    const jobs = await suDb.schedulerJob.findMany({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: { contains: `:ci:${CONTACT_INBOX_BASE + convId}:` },
      },
      select: { dedupeKey: true },
    });
    // E A MARCA ANDA ATÉ ELA. Sem isto a linha fecharia com a mensagem ainda abaixo do watermark, e
    // com o debounce ligado a rajada seguinte a coalesceria — o turno então responderia a mensagem
    // da era humana, que é este mesmo defeito voltando por outra porta.
    const marca = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { lastHandledMessageId: true },
    });
    expect(marca.lastHandledMessageId).toBe(messageId);
    expect(jobs.map((j) => j.dedupeKey)).toEqual([
      `ingest:${tenantId}:${instanceId}:ci:${CONTACT_INBOX_BASE + convId}:${messageId}`,
    ]);
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

  // O OUTRO LADO DE `(act && consumed) || !act`, E O PIOR DOS TRÊS SÍTIOS SEGUNDO A ISSUE. Aqui
  // ninguém segura a conversa: o bot é o dono e quem calou a mensagem foi um PORTÃO, o horário de
  // atendimento, que já respondeu ao cliente o aviso de ausência. Uma resposta depois contradiz uma
  // decisão explícita do operador.
  //
  // ERA ESTE RAMO QUE A COLUNA NÃO ALCANÇAVA, e não porque ela não fosse gravada: a entrega
  // liquidava na própria passada (`settleAwaitsIngest` pedia `!consumed`), e `PROCESSED` é o estado
  // que nada revisita — a coluna era escrita e nunca lida, com a mensagem do cliente sumindo do mesmo
  // jeito. Com o adiamento valendo nas duas metades, o arme que falha deixa a linha para a varredura,
  // e é a varredura que faz a coluna valer alguma coisa.
  test("o portão que silenciou deixa a linha para a varredura, devendo só memória", async () => {
    const convId = 9405;
    const texto = "vocês abrem sábado?";

    const { rowId, messageId, status, owesMemoryOnly } = await strandOn(
      convId,
      texto,
      heldByBot(convId, INBOX_CLOSED),
    );

    // A linha NÃO é terminal: é o estado que a varredura revisita.
    expect(status).toBe("PROCESSING");
    // E ela diz o que aquela passada devia.
    expect(owesMemoryOnly).toBe(true);
    // E A MARCA NÃO PASSOU POR CIMA DA MENSAGEM, que é a outra metade do trio que o corpo da issue
    // mede: marca acima de uma mensagem que memória nenhuma tem é a perda ficando invisível.
    const marca = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { lastHandledMessageId: true },
    });
    expect(marca.lastHandledMessageId ?? 0).toBeLessThan(messageId);

    // E O REPLAY FECHA A PERDA SEM RESPONDER: é o desfecho inteiro que a issue pede, e o único
    // caminho em que a coluna é lida.
    await suDb.chatwootWebhookDelivery.update({
      where: { id: rowId },
      data: { status: "DEAD" },
    });
    const stub = stubChatwoot(convId, messageId, texto);
    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: {
        makeClient: stub.makeClient,
        makeModel: () =>
          new FakeListChatModel({ responses: ["Abrimos das 9 às 13!"] }),
        checkpointer: new MemorySaver(),
        sleep: async () => {},
      },
    });
    expect(outcome).toBe("recovered");
    // O cliente NÃO recebe a resposta que o operador silenciou...
    expect(stub.sent).toEqual([]);
    // ...e a mensagem dele alcança a memória, que é o que aquela passada devia.
    const jobs = await suDb.schedulerJob.findMany({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: { contains: `:ci:${CONTACT_INBOX_BASE + convId}:` },
      },
      select: { dedupeKey: true },
    });
    expect(jobs.map((j) => j.dedupeKey)).toEqual([
      `ingest:${tenantId}:${instanceId}:ci:${CONTACT_INBOX_BASE + convId}:${messageId}`,
    ]);
  });

  // O ESCOPO DA LIQUIDAÇÃO É UM FATO DAQUELE INSTANTE, E NÃO SE RE-DERIVA (rodada 2 de review).
  //
  // A coluna que a issue acrescentou desarma a RESPOSTA, e sozinha ela não fecha a outra metade do
  // mesmo problema: a largura da liquidação sai de QUEM segurava a conversa — estreita ao lado de
  // outro AgentBot, ampla atrás de uma pessoa ou de um portão. Re-derivada meia hora depois, uma
  // parada que aconteceu ao lado de outro bot liquida a conversa inteira assim que a posse volta
  // para nós, e a linha que aquele bot tem para ESTA mensagem fecha como consumida sem que nenhuma
  // das duas recuperações tenha respondido. É perda silenciosa, que é o que este subsistema existe
  // para impedir.
  test("a parada ao lado de outro bot não liquida a linha dele quando a posse volta", async () => {
    const convId = 9407;
    const texto = "ainda preciso do segundo boleto";

    const {
      rowId,
      messageId,
      status,
      owesMemoryOnly,
      settleScopedToThisDelivery,
    } = await strandOn(convId, texto, heldByAnotherBot(convId));
    // A premissa: a linha ficou para a varredura, devendo memória...
    expect(status).toBe("PROCESSING");
    expect(owesMemoryOnly).toBe(true);
    // ...e gravando o escopo daquele instante, que é o que o replay não tem como recalcular.
    expect(settleScopedToThisDelivery).toBe(true);

    const irmaId = await irma(convId, messageId);

    await suDb.chatwootWebhookDelivery.update({
      where: { id: rowId },
      data: { status: "DEAD" },
    });
    // O passo que produz o defeito: a conversa volta para o bot, então re-derivar a posse responde
    // "ninguém segura isto" e escolhe o escopo amplo.
    await handBackToBot(convId);

    const stub = stubChatwoot(convId, messageId, texto);
    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: {
        makeClient: stub.makeClient,
        makeModel: () => new FakeListChatModel({ responses: ["oi"] }),
        checkpointer: new MemorySaver(),
        sleep: async () => {},
      },
    });
    expect(outcome).toBe("recovered");
    // Nada foi dito, que é o que a issue já garantia.
    expect(stub.sent).toEqual([]);

    // O QUE ESTE TESTE MEDE: a linha do outro bot continua na lista de trabalho. Com o escopo
    // re-derivado ela fecharia em `PROCESSED`, e a única coisa entre aquela mensagem e o silêncio
    // teria sido retirada por uma recuperação que não respondeu nada.
    const daOutraRota = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: irmaId },
      select: { status: true },
    });
    expect(daOutraRota.status).toBe("PROCESSING");

    // E A LINHA VIVA TEM QUE PODER RESPONDER, que é uma asserção diferente de a linha existir
    // (rodada 4 de review). A marca é da CONVERSA: andar com ela aqui escreve um dispensal que
    // nomeia a mensagem, e o turno da outra rota é recusado pelo `claimReplyBurst` depois. A linha
    // ficaria em `PROCESSING`, parecendo viva, e o cliente não seria respondido por ninguém — a
    // mesma perda entrando pela porta do lado. As duas leituras abaixo são exatamente as duas
    // entradas daquela recusa.
    const marca = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true, lastHandledMessageId: true },
    });
    expect(marca.lastHandledMessageId).not.toBe(messageId);
    const dispensas = await suDb.replyDispensal.findMany({
      where: { tenantId, conversationId: marca.id, toMessageId: messageId },
      select: { fromMessageId: true, toMessageId: true },
    });
    expect(dispensas).toEqual([]);
  });

  // O CONTROLE, e ele é o que impede o conserto de virar "estreite sempre". Atrás de uma PESSOA o
  // escopo amplo está certo e é deliberado: ela responde a mensagem por qualquer rota que a tenha
  // carregado, então toda linha daquela mensagem é moot — e essa largura é também o que resgata um
  // encalhe que uma tentativa anterior deixou atrás. Estreitar aqui deixaria a linha irmã na lista
  // de perdas de uma mensagem que uma pessoa atendeu.
  test("atrás de uma pessoa o escopo continua amplo, e a linha irmã fecha com ela", async () => {
    const convId = 9408;
    const texto = "obrigado, era só isso";

    const { rowId, messageId, settleScopedToThisDelivery } = await strandOn(
      convId,
      texto,
      heldByHuman(convId),
    );
    // O outro valor da mesma coluna, gravado pela mesma expressão.
    expect(settleScopedToThisDelivery).toBe(false);

    const irmaId = await irma(convId, messageId);

    await suDb.chatwootWebhookDelivery.update({
      where: { id: rowId },
      data: { status: "DEAD" },
    });
    await handBackToBot(convId);

    const stub = stubChatwoot(convId, messageId, texto);
    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: {
        makeClient: stub.makeClient,
        makeModel: () => new FakeListChatModel({ responses: ["oi"] }),
        checkpointer: new MemorySaver(),
        sleep: async () => {},
      },
    });
    expect(outcome).toBe("recovered");
    expect(stub.sent).toEqual([]);

    const daOutraRota = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: irmaId },
      select: { status: true },
    });
    expect(daOutraRota.status).toBe("PROCESSED");

    // E O OUTRO LADO DA MESMA MOEDA: atrás de uma pessoa a marca CONTINUA andando, porque aí não há
    // rota nenhuma esperando para responder e a marca é o que impede a rajada seguinte de coalescer
    // a mensagem da era humana. Estreitar a marca junto com a liquidação teria quebrado isto.
    const marca = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { lastHandledMessageId: true },
    });
    expect(marca.lastHandledMessageId).toBe(messageId);
  });

  // E O ESCOPO GRAVADO SOBREVIVE A UMA RECUPERAÇÃO QUE FALHOU (rodada 3 de review). O mesmo bloco
  // que grava a coluna roda no replay, e enquanto a leitura e a escrita eram duas expressões o
  // replay lia o valor certo e regravava a derivação de agora por baixo: com a posse de volta, `true`
  // virava `false`. Bastava a ingestão falhar de novo — que é o estado normal de uma linha que já
  // encalhou uma vez — para a linha voltar para `DEAD` com o escopo corrompido, e aí a retentativa
  // SEGUINTE liquidava a conversa inteira. O defeito original um nível acima, e mais difícil de ver,
  // porque a primeira tentativa se comporta certo.
  test("o escopo gravado atravessa uma recuperação que falhou, e a retentativa não alarga", async () => {
    const convId = 9409;
    const texto = "e o terceiro boleto?";

    const { rowId, messageId, settleScopedToThisDelivery } = await strandOn(
      convId,
      texto,
      heldByAnotherBot(convId),
    );
    expect(settleScopedToThisDelivery).toBe(true);

    const irmaId = await irma(convId, messageId);

    await suDb.chatwootWebhookDelivery.update({
      where: { id: rowId },
      data: { status: "DEAD" },
    });
    await handBackToBot(convId);

    // PRIMEIRA retentativa, com a ingestão falhando de novo: é o que devolve a linha para a
    // varredura e a única janela em que a coluna pode ser sobrescrita.
    const stub1 = stubChatwoot(convId, messageId, texto);
    await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: semFila(),
      deps: {
        makeClient: stub1.makeClient,
        makeModel: () => new FakeListChatModel({ responses: ["oi"] }),
        checkpointer: new MemorySaver(),
        sleep: async () => {},
      },
    }).catch(() => {});

    // A ASSERÇÃO QUE PEGA O DEFEITO NA FONTE: a linha continua dizendo o que aquele instante disse.
    const depois = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: rowId },
      select: { settleScopedToThisDelivery: true },
    });
    expect(depois.settleScopedToThisDelivery).toBe(true);

    // E A CONSEQUÊNCIA, medida de ponta a ponta: a linha volta para `DEAD` e a retentativa seguinte
    // roda com o escopo intacto, então a linha do outro bot continua na lista de trabalho.
    await suDb.chatwootWebhookDelivery.update({
      where: { id: rowId },
      data: { status: "DEAD" },
    });
    const stub2 = stubChatwoot(convId, messageId, texto);
    const outcome = await recoverStrandedDelivery({
      tenantId,
      deliveryRowId: rowId,
      base: appDb,
      deps: {
        makeClient: stub2.makeClient,
        makeModel: () => new FakeListChatModel({ responses: ["oi"] }),
        checkpointer: new MemorySaver(),
        sleep: async () => {},
      },
    });
    expect(outcome).toBe("recovered");
    expect(stub2.sent).toEqual([]);

    const daOutraRota2 = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: irmaId },
      select: { status: true },
    });
    expect(daOutraRota2.status).toBe("PROCESSING");
  });
});
