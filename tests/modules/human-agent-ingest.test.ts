import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId, getCheckpointer } from "@/graph/checkpointer";
import { isHumanAgentTurn } from "@/graph/markers";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { renderTranscript } from "@/modules/memory/summarize";
import { claimDueTrafficJobs } from "@/modules/scheduler/service";
import { runClaimed } from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// The shape this suite exists for is the most common one in a real deployment: the agent qualifies a
// lead, a human takes the conversation over, and the human closes the sale. Every test here drives
// the REAL receiver (processChatwootDelivery), because the defect was never in the ingestion unit —
// it was that no delivery path reached it with an outgoing message, and a unit test cannot see that.
//
// What it asserts is the OBSERVABLE effect from issue #187: the transcript that compaction hands to
// the summarizer, and from there to the contact's permanent memory. Asserting "the message is in the
// thread" would pass on a message stored as the CUSTOMER's, which is the outcome the issue calls
// worse than the omission it replaces.

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

const INBOX_ID = 63;
// A rota que NÃO lembra: um agente em `test` fica calado e não ingere nada por conta própria
// (`ingestsContinuously("test")` é falso), então numa conversa dessa inbox mensagem nenhuma fica
// devendo uma ingestão.
const INBOX_TEST = 64;
const CONTACT_INBOX_BASE = 63_000;
let tenantId = 0n;
let instanceId = 0n;
let deliverySeq = 0;
let messageSeq = 5000;
let stamp = Math.floor(Date.now() / 1000);

const realFetch = globalThis.fetch;

describe.skipIf(!dbUp)(
  "a human agent's reply reaches the contact's memory",
  () => {
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
        data: { name: "HAI", slug: `hai-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 14,
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
          chatwootAgentBotId: 9,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `hai-route-${process.pid}`,
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
      const ensaio = await suDb.agent.create({
        data: {
          tenantId,
          name: "Ensaio",
          mode: "test",
          systemPrompt: "Você é prestativa.",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          settings: { debounce: { enabled: false } },
        },
      });
      await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: INBOX_TEST,
          name: "Ensaio",
          agentId: ensaio.id,
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
      ]) {
        await suDb
          .$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => {});
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    // A conversation a HUMAN owns: `shouldBotHandle` is false, so the bot stays silent and every
    // message on it is continuous-ingestion territory. No model ever runs in this suite.
    function conversation(convId: number, inboxId = INBOX_ID) {
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

    // INGEST_MESSAGE rides the shared lane, in the TRAFFIC-PROPORTIONAL half of it: the tick claims
    // that half separately and with a cap, so one kind whose row count follows inbound traffic cannot
    // fill the batch and starve an appointment reminder (src/modules/scheduler/lanes.ts). Looped
    // because one delivery can queue more than a claim's worth over a burst.
    async function drainIngest(): Promise<void> {
      for (let pass = 0; pass < 10; pass++) {
        const claimed = await claimDueTrafficJobs(
          50,
          appDb,
          new Date(),
          tenantId,
        );
        if (claimed.length === 0) return;
        for (const job of claimed) await runClaimed(job, appDb);
      }
    }

    async function deliver(
      convId: number,
      message: Record<string, unknown>,
    ): Promise<void> {
      deliverySeq += 1;
      messageSeq += 1;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageSeq,
        private: false,
        ...message,
        conversation: conversation(convId),
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `hai-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
        },
        select: { id: true },
      });
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: 9,
        normalized: n,
        base: appDb,
      });
      // The receiver QUEUES the append now instead of making it (issue #194), so the assertions
      // below run after the same job the fast tick would drain. Draining it here is what keeps this
      // an end-to-end test of the real path rather than of the enqueue.
      await drainIngest();
    }

    // A MESMA entrega do helper acima, com duas diferenças que só os casos da #719 precisam: a base é
    // do caso (um cliente estendido que recusa uma escrita), e o lançamento volta como valor em vez
    // de derrubar o teste, porque é ele que está sendo medido. Não drena a fila: o que se mede aqui é
    // o que o receptor deixa para trás.
    async function deliverRaw(
      convId: number,
      message: Record<string, unknown>,
      base: PrismaClient,
      inboxId = INBOX_ID,
      deps?: { sleep?: (ms: number) => Promise<void> },
    ): Promise<{ erro: string | null; status: string }> {
      deliverySeq += 1;
      messageSeq += 1;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageSeq,
        private: false,
        ...message,
        conversation: conversation(convId, inboxId),
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `hai-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
        },
        select: { id: true },
      });
      const erro = await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: 9,
        normalized: n,
        base,
        ...(deps === undefined ? {} : { deps }),
      }).then(
        () => null,
        (e) => String(e),
      );
      const linha = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
        select: { status: true },
      });
      return { erro, status: linha.status };
    }

    const fromCustomer = (content: string) => ({
      content,
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
    });
    const fromHumanAgent = (content: string) => ({
      content,
      message_type: "outgoing",
      sender: { id: 5, name: "Ana", type: "user" },
    });
    const reactionFromHumanAgent = (emoji: string) => ({
      content: emoji,
      message_type: "outgoing",
      sender: { id: 5, name: "Ana", type: "user" },
      content_attributes: { is_reaction: true },
    });
    const fromOurBot = (content: string) => ({
      content,
      message_type: "outgoing",
      sender: { id: 9, name: "Atendente", type: "agent_bot" },
    });

    async function threadMessages(convId: number): Promise<BaseMessage[]> {
      const cp = await getCheckpointer();
      const state = await cp.get({
        configurable: {
          thread_id: contactInboxThreadId(
            tenantId,
            instanceId,
            CONTACT_INBOX_BASE + convId,
          ),
        },
      });
      return ((state?.channel_values as { messages?: BaseMessage[] })
        ?.messages ?? []) as BaseMessage[];
    }

    test("the transcript of a handed-off attendance carries BOTH voices", async () => {
      const convId = 501;
      await deliver(
        convId,
        fromCustomer("bom dia, quanto fica o plano anual?"),
      );
      await deliver(
        convId,
        fromHumanAgent("Bom dia! Consigo fechar o anual por R$ 1.200."),
      );
      await deliver(convId, fromCustomer("fechado, pode emitir"));

      const transcript = renderTranscript(await threadMessages(convId));
      // The half that already worked.
      expect(transcript).toContain(
        "cliente: bom dia, quanto fica o plano anual?",
      );
      expect(transcript).toContain("cliente: fechado, pode emitir");
      // The half issue #187 is about: without it the memory records a customer who asked a price,
      // never got one, and then agreed to it.
      expect(transcript).toContain(
        "atendente: Bom dia! Consigo fechar o anual por R$ 1.200.",
      );
    });

    // The failure mode the issue calls WORSE than the omission: the operator's words stored as the
    // contact's. A test that only counted messages would pass on exactly that.
    test("the attendant's words are never attributed to the customer", async () => {
      const convId = 502;
      await deliver(convId, fromCustomer("oi"));
      await deliver(convId, fromHumanAgent("o desconto vale até sexta"));

      const messages = await threadMessages(convId);
      const attendant = messages.filter(isHumanAgentTurn);
      expect(attendant.length).toBe(1);
      expect(String(attendant[0]?.content)).toContain(
        "o desconto vale até sexta",
      );

      const transcript = renderTranscript(messages);
      expect(transcript).not.toContain("cliente: o desconto vale até sexta");
    });

    // Our own reply is already in the thread, written by the turn that produced it. Ingesting it again
    // would duplicate every answer the agent ever gave.
    test("our own bot's outgoing message is not ingested", async () => {
      const convId = 503;
      await deliver(convId, fromCustomer("tem em azul?"));
      await deliver(convId, fromOurBot("Temos sim!"));

      const transcript = renderTranscript(await threadMessages(convId));
      expect(transcript).toContain("cliente: tem em azul?");
      expect(transcript).not.toContain("Temos sim!");
    });

    // An emoji react is an acknowledgement, not something the team said. It reaches this seam looking
    // exactly like a reply (outgoing, public, sender type "user"), so it is excluded on the one field
    // that tells them apart.
    test("a reaction from a human agent is not stored as something they said", async () => {
      const convId = 505;
      await deliver(convId, fromCustomer("obrigada, era isso"));
      await deliver(convId, reactionFromHumanAgent("👍"));

      const transcript = renderTranscript(await threadMessages(convId));
      expect(transcript).toContain("cliente: obrigada, era isso");
      expect(transcript).not.toContain("👍");
    });

    // Round-2 review finding (P2): outgoing webhook events carry `attachments`, so an attendant who
    // answers with a file and no caption used to render to an empty string and be dropped on the spot.
    test("an attendant's attachment-only reply still reaches the memory", async () => {
      const convId = 506;
      await deliver(convId, fromCustomer("me manda o contrato"));
      await deliver(convId, {
        content: "",
        message_type: "outgoing",
        sender: { id: 5, name: "Ana", type: "user" },
        attachments: [
          { id: 1, file_type: "file", data_url: "https://x/c.pdf" },
        ],
      });

      const transcript = renderTranscript(await threadMessages(convId));
      expect(transcript).toContain("cliente: me manda o contrato");
      expect(transcript).toContain("atendente: <atendente enviou um arquivo");
    });

    // A private note is the operator talking to their own team. It is not part of the dialogue with the
    // customer, and putting it in the contact's permanent memory would leak internal notes into a
    // future prompt.
    // O ENFILEIRAMENTO QUE FALHA NÃO PODE LEVAR A MENSAGEM JUNTO (issue #719). Nesta conversa quem
    // responde é uma pessoa, então turno nenhum roda: `shouldBotHandle` é falso, o receptor entra no
    // ramo `!act`, avança a marca e liquida a entrega — e só DEPOIS roda a ingestão contínua, que é a
    // única coisa que põe a mensagem na memória.
    //
    // Com o enfileiramento falhando, nada lançava: a linha fechava `PROCESSED`, que é o estado que a
    // varredura não revisita, e a marca já estava por cima da mensagem. Nenhum turno depois a lê (o
    // caminho direto folha a mensagem DO EVENTO, e o flush coalesce a partir da marca), então o que o
    // cliente escreveu não está em lugar nenhum.
    //
    // Os caminhos vizinhos já têm essa cerca — a parada do observador, a transcrição tardia e a
    // parada por posse da #711 lançam quando o enfileiramento delas falha, deixando a linha em
    // PROCESSING para a varredura. Este é o caminho comum, e era o único sem ela.
    test("a customer message is not lost when its ingestion enqueue fails", async () => {
      const convId = 507;
      // A conversa já existe no espelho, com a pessoa como dona: é o estado em que o cliente escreve.
      await deliver(convId, fromCustomer("oi, ainda dá pra fechar hoje?"));
      const antes = await threadMessages(convId);
      const marcaAntes = (
        await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: convId },
          select: { lastHandledMessageId: true },
        })
      ).lastHandledMessageId;

      // O scheduler recusa exatamente o INGEST_MESSAGE, e só ele.
      const semFila = appDb.$extends({
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

      const { erro, status } = await deliverRaw(
        convId,
        fromCustomer("consigo pagar em duas vezes?"),
        semFila,
      );

      // A ENTREGA FALHA ALTO, que é o que deixa a linha recuperável.
      expect(erro ?? "a entrega nao lancou").toContain("could not be armed");
      // PROCESSING é o estado que a varredura revisita; PROCESSED é o que ninguém revisita nunca mais.
      expect(status).toBe("PROCESSING");
      // E a marca NÃO passa por cima da mensagem que memória nenhuma tem.
      const marcaDepois = (
        await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: convId },
          select: { lastHandledMessageId: true },
        })
      ).lastHandledMessageId;
      expect(marcaDepois).toBe(marcaAntes);
      // Nada foi escrito na memória nesta passada: é a premissa do caso, não o efeito a consertar.
      expect((await threadMessages(convId)).length).toBe(antes.length);
    });

    // E SE A MARCA NÃO CONSEGUE PASSAR, A LINHA TAMBÉM FICA PARA A VARREDURA (issue #719). A marca é
    // a escrita que FECHA esta parada: liquidar a linha com ela ainda abaixo da mensagem deixaria um
    // registro terminal sobre uma mensagem que o resto do sistema continua tratando como não lida, e
    // um flush depois responderia a ela. É o mesmo `leave-for-sweep` que a hand-over do observador
    // usa, pela mesma razão (round 21 da #209).
    test("a watermark that cannot be advanced leaves the delivery for the sweep too", async () => {
      const convId = 509;
      await deliver(convId, fromCustomer("oi, ainda dá pra fechar hoje?"));

      // A ingestão funciona; quem falha é a escrita da marca.
      const semMarca = appDb.$extends({
        query: {
          conversation: {
            $allOperations({ operation, args, query }) {
              const shape = JSON.stringify(args, (_k, v) =>
                typeof v === "bigint" ? String(v) : v,
              );
              if (
                operation.startsWith("update") &&
                shape.includes("lastHandledMessageId")
              ) {
                throw new Error("injected: watermark write unavailable");
              }
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;

      const { erro, status } = await deliverRaw(
        convId,
        fromCustomer("e no cartão, dá?"),
        semMarca,
      );

      expect(erro ?? "a entrega nao lancou").toContain(
        "watermark could not be advanced",
      );
      expect(status).toBe("PROCESSING");
    });

    // E O ADIAMENTO É ESTREITO: quem não deve uma ingestão liquida na hora, mesmo com a marca falhando.
    //
    // Este é o outro lado da cerca acima, e ele é a maior parte do tráfego: toda entrega de conversa
    // em posse humana cai no ramo `!act`, inclusive a de um agente em `test`, a de um agente
    // desligado e a de uma inbox sem rota — onde a ingestão contínua nem é tentada e mensagem
    // nenhuma fica devendo nada. Adiar a liquidação também nesses casos prenderia cada uma delas em
    // PROCESSING, com a varredura reprocessando entregas que não perderam nada até declará-las
    // `DEAD`. É por isso que o adiamento exige `routeRemembers`, e é o que este caso mede.
    test("a route that remembers nothing settles at once, even with a failing watermark", async () => {
      const convId = 510;
      await deliverRaw(
        convId,
        fromCustomer("oi, ainda dá pra fechar hoje?"),
        appDb,
        INBOX_TEST,
      );

      const semMarcaTambem = appDb.$extends({
        query: {
          conversation: {
            $allOperations({ operation, args, query }) {
              const shape = JSON.stringify(args, (_k, v) =>
                typeof v === "bigint" ? String(v) : v,
              );
              if (
                operation.startsWith("update") &&
                shape.includes("lastHandledMessageId")
              ) {
                throw new Error("injected: watermark write unavailable");
              }
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;

      const { erro, status } = await deliverRaw(
        convId,
        fromCustomer("e no cartão, dá?"),
        semMarcaTambem,
        INBOX_TEST,
      );

      expect(erro).toBe(null);
      expect(status).toBe("PROCESSED");
    });

    // O CONTROLE POSITIVO do caso acima: com o scheduler normal, a MESMA mensagem na MESMA conversa
    // chega à memória e a linha fecha. Sem ele, o teste acima passaria com a ingestão desligada.
    test("the same message reaches memory when the enqueue works", async () => {
      const convId = 508;
      await deliver(convId, fromCustomer("oi, ainda dá pra fechar hoje?"));
      await deliver(convId, fromCustomer("consigo pagar em duas vezes?"));
      const thread = await threadMessages(convId);
      expect(thread.some((m) => String(m.content).includes("duas vezes"))).toBe(
        true,
      );
    });

    // Um cliente estendido que recusa as `falhas` primeiras escritas de INGEST_MESSAGE e deixa a
    // seguinte passar. É o que separa "tentou uma vez" de "tentou de novo": com uma tentativa só,
    // qualquer indisponibilidade momentânea do scheduler custa a mensagem inteira.
    function schedulerInstavel(falhas: number): {
      base: PrismaClient;
      tentativas: () => number;
    } {
      let vistas = 0;
      const base = appDb.$extends({
        query: {
          schedulerJob: {
            $allOperations({ args, query }) {
              const shape = JSON.stringify(args, (_k, v) =>
                typeof v === "bigint" ? String(v) : v,
              );
              if (!shape.includes("INGEST_MESSAGE")) return query(args);
              vistas += 1;
              if (vistas <= falhas) {
                throw new Error("injected: scheduler unavailable");
              }
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      return { base, tentativas: () => vistas };
    }

    async function linhasDeMemoria(
      convRowId: bigint,
    ): Promise<{ reason: unknown; level: string }[]> {
      const rows = await flowLogRows(suDb, {
        where: { tenantId, conversationId: convRowId, stage: "memory" },
        select: { level: true, detail: true },
      });
      return rows.map((r) => ({
        level: r.level,
        reason: (r.detail as { reason?: unknown } | null)?.reason ?? null,
      }));
    }

    async function convRowId(convId: number): Promise<bigint> {
      return (
        await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: convId },
          select: { id: true },
        })
      ).id;
    }

    // O APPEND É A ÚLTIMA CHANCE AQUI TAMBÉM (issue #720). O retry do enfileiramento existe porque
    // nenhum turno vai cobrir aquela mensagem depois — é o que o próprio `retryArm` diz, e é
    // literalmente verdade da resposta de um colega: o bot não a escreveu, então turno nenhum a lê.
    // Mesmo assim ele só era armado sob observador, e na rota comum (que é a do #187: o agente
    // qualifica, a pessoa fecha a venda) uma indisponibilidade de um segundo do scheduler custava a
    // metade da conversa em que o negócio foi fechado.
    test("a colleague's reply gets the retries the observer's reply gets", async () => {
      const convId = 511;
      await deliver(convId, fromCustomer("fechou, pode mandar o contrato"));
      const { base, tentativas } = schedulerInstavel(3);

      const { erro } = await deliverRaw(
        convId,
        fromHumanAgent("Fechado! Mando o contrato ainda hoje."),
        base,
        INBOX_ID,
        { sleep: async () => {} },
      );
      await drainIngest();

      expect(erro).toBe(null);
      // Quatro tentativas, não uma: as três recusadas e a que passou.
      expect(tentativas()).toBe(4);
      const transcript = renderTranscript(await threadMessages(convId));
      expect(transcript).toContain("atendente: Fechado!");
    });

    // E QUANDO AS TENTATIVAS ACABAM, A ROTA COMUM TAMBÉM É AVISADA (issue #720). O relato existia,
    // mas atrás de `(observing || handedToObserver)`: numa instalação sem observador nenhum — a
    // esmagadora maioria — a resposta do colega sumia da memória sem uma linha em lugar nenhum. A
    // perda não é recuperável (nenhuma recuperação reconstrói o corpo de uma mensagem outgoing hoje),
    // então o que resta é dizer que ela aconteceu, onde um operador lê.
    test("the ordinary route is told when a colleague's reply reaches no memory", async () => {
      const convId = 512;
      await deliver(convId, fromCustomer("combinado então"));
      const { base } = schedulerInstavel(Number.POSITIVE_INFINITY);

      await deliverRaw(
        convId,
        fromHumanAgent("Combinado. Te mando o boleto amanhã."),
        base,
        INBOX_ID,
        { sleep: async () => {} },
      );

      const linhas = await linhasDeMemoria(await convRowId(convId));
      expect(linhas).toContainEqual({
        level: "error",
        reason: "human_reply_not_remembered",
      });
    });

    // E O RELATO NÃO SE ALARGA PARA A MENSAGEM DO CLIENTE (issue #720). Tirar a guarda do observador
    // sem pôr nada no lugar deixaria este bloco responder por qualquer ingestão que falha, e a da
    // mensagem do cliente falha exatamente no mesmo lugar (#719) — poucas linhas antes do lançamento
    // que a deixa para a varredura. O operador leria "a resposta de um colega não pôde ser lembrada"
    // sobre uma mensagem que o cliente escreveu e que a varredura vai recuperar.
    test("the customer's own lost ingestion is not reported as a colleague's reply", async () => {
      const convId = 514;
      await deliver(convId, fromCustomer("oi"));
      const { base, tentativas } = schedulerInstavel(Number.POSITIVE_INFINITY);

      const { erro } = await deliverRaw(
        convId,
        fromCustomer("continua disponível?"),
        base,
        INBOX_ID,
        { sleep: async () => {} },
      );

      // A entrega da #719 lança, e é o lançamento que deixa a linha recuperável.
      expect(erro ?? "a entrega nao lancou").toContain("could not be armed");
      expect(await linhasDeMemoria(await convRowId(convId))).toEqual([]);
      // E A TENTATIVA CONTINUA SENDO UMA, que é a outra metade da fronteira. O retry do colega não
      // se alargou para todo mundo: a mensagem do cliente em rota comum é coberta por um turno na
      // esmagadora maioria das vezes, e quando não é — como aqui — quem a salva é a varredura, não
      // mais três tentativas de enfileiramento segurando o worker por dois segundos.
      expect(tentativas()).toBe(1);
    });

    // E O ECO DA NOSSA PRÓPRIA RESPOSTA NÃO VIRA RELATO (issue #720, review r1). A cerca é o papel
    // RESOLVIDO (`humanReplyBy`), não a forma do payload: a forma inclui de propósito a perna
    // `device` antes de perguntar ao provedor, e num provedor que não reserva os ids do eco aquela
    // forma é a nossa própria resposta voltando. Com a forma no lugar do papel, uma conversa que nem
    // o payload nem o espelho sabem nomear um contact-inbox produz `no-thread` — devolvido ANTES de
    // o papel ser calculado — e um operador seria paginado sobre "a resposta de um colega" que
    // pessoa nenhuma escreveu.
    test("an echo of our own reply is not reported as a colleague's lost reply", async () => {
      const convId = 515;
      deliverySeq += 1;
      messageSeq += 1;
      const { id: _semThread, ...semContactInbox } = conversation(convId);
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageSeq,
        private: false,
        content: "eco da nossa própria resposta",
        message_type: "outgoing",
        sender: null,
        content_attributes: { external_sender_name: "WhatsApp" },
        conversation: { ...semContactInbox, id: convId, contact_inbox: null },
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `hai-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
        },
        select: { id: true },
      });
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: 9,
        normalized: n,
        base: appDb,
      });

      // A inbox deste teste não é WhatsApp, então `providerReservesEchoIds` recusa e o eco não é
      // resposta de ninguém: a ingestão não o guarda, e não há perda a relatar.
      expect(await linhasDeMemoria(await convRowId(convId))).toEqual([]);
    });

    // E A ENTREGA AINDA ASSIM LIQUIDA, que é a metade do desenho que um conserto vizinho desfaria
    // (issue #720). A tentação é lançar, como a #719 fez para a mensagem do cliente, e ali aquilo
    // compra a recuperação: a varredura replaya a entrega e a ingestão é re-armada. Para a resposta
    // de um colega não compra nada. A linha é classificada `owed-takeover` (ou `observer-strand`), e
    // nenhum dos dois re-arma ingestão nenhuma: o primeiro re-roda só a transição de posse, o segundo
    // só relata. Prender a linha em PROCESSING custaria um job de takeover redundante e um `DEAD` no
    // fim, sem salvar uma palavra — e é por isso que o relato acima é a resposta, e não o lançamento.
    test("a colleague's reply whose ingestion fails still settles the delivery", async () => {
      const convId = 513;
      await deliver(convId, fromCustomer("me manda quando puder"));
      const { base } = schedulerInstavel(Number.POSITIVE_INFINITY);

      const { erro, status } = await deliverRaw(
        convId,
        fromHumanAgent("Mando sim."),
        base,
        INBOX_ID,
        { sleep: async () => {} },
      );

      expect(erro).toBe(null);
      expect(status).toBe("PROCESSED");
    });

    test("a private note is not ingested", async () => {
      const convId = 504;
      await deliver(convId, fromCustomer("preciso de ajuda"));
      await deliver(convId, {
        ...fromHumanAgent("cliente reclamou do suporte no mês passado"),
        private: true,
      });

      const transcript = renderTranscript(await threadMessages(convId));
      expect(transcript).toContain("cliente: preciso de ajuda");
      expect(transcript).not.toContain("reclamou do suporte");
    });
  },
);
