import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { followUpHandler } from "@/modules/followups/handlers";
import {
  type ClaimedJob,
  enqueueJob,
  jobRetired,
} from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// O CANCELAMENTO POR RESPOSTA DO CLIENTE TEM QUE ALCANÇAR O JOB JÁ REIVINDICADO. "Uma mensagem nova
// do cliente torna sem efeito o follow-up de inatividade pendente" vale também para um job que o
// worker já reivindicou: tudo entre a reivindicação e o envio é janela (portões, fila do thread,
// modelo, moderação, Chatwoot), e ela cresce justamente quando um turno reativo segura o thread, ou
// seja, quando uma mensagem do cliente acabou de chegar. O dano não é só um lembrete redundante: um
// passo final pode RESOLVER a conversa com `sem-cliente-esperando` logo depois de o cliente escrever.
// A mensagem entra pelo caminho de entrada do app, nunca escrita à mão: um fixture que carimbasse
// `last_inbound_at` satisfaria a cerca sem exercitar o cancelamento.
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

const CHATWOOT_INBOX_ID = 7601;
const AGENT_BOT_ID = 76;
// Uma conversa por caso: a chave de dedupe do follow-up NOMEIA a conversa, então dois casos na mesma
// conversa disputariam a mesma linha de `scheduler_jobs`.
const CONV_REIVINDICADO = 96_001;
const CONV_PENDENTE = 96_002;
const CONV_VIZINHA = 96_003;
const CONV_REARME = 96_004;
const CONV_CONTROLE = 96_005;
const CONV_PONTA = 96_006;
const CONV_REPLAY = 96_007;

let tenantId: bigint;
let instanceId: bigint;
let inboxDbId: bigint;

function threadOf(convId: number): string {
  return `${tenantId}:${instanceId}:${convId}`;
}

function chaveDoFollowUp(convId: number): string {
  return `followup:${threadOf(convId)}`;
}

// O job como o worker o entrega ao handler. `claimSeq` é o token daquela reivindicação, e é por ele
// que a retirada faz o handler em voo escrever em nada.
function jobComoReivindicado(row: {
  id: bigint;
  claimSeq: number;
  dedupeKey: string;
  payload: unknown;
}): ClaimedJob {
  return {
    id: row.id,
    tenantId,
    kind: "FOLLOWUP",
    payload: (row.payload ?? {}) as Record<string, unknown>,
    dedupeKey: row.dedupeKey,
    attempts: 1,
    claimSeq: row.claimSeq,
  };
}

// Arma o follow-up como o varredor arma, e o deixa no estado que o caso pede. CLAIMED é o worker
// tendo reivindicado a linha e estando dentro da execução; PENDING é a metade que o status já cobre.
async function armar(
  convId: number,
  estado: "CLAIMED" | "PENDING",
): Promise<ClaimedJob> {
  const id = await enqueueJob({
    tenantId,
    kind: "FOLLOWUP",
    dedupeKey: chaveDoFollowUp(convId),
    runAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    payload: { threadId: threadOf(convId) },
    rearm: "same-work",
    base: suDb,
  });
  if (estado === "CLAIMED") {
    await suDb.schedulerJob.update({
      where: { id },
      data: {
        status: "CLAIMED",
        claimedAt: new Date(),
        claimSeq: { increment: 1 },
        attempts: 1,
      },
    });
  }
  const row = await suDb.schedulerJob.findUniqueOrThrow({
    where: { id },
    select: { id: true, claimSeq: true, dedupeKey: true, payload: true },
  });
  return jobComoReivindicado(row);
}

// A mensagem do cliente, pelo receptor de verdade.
async function clienteEscreve(
  convId: number,
  texto: string,
  // Quando a mensagem foi criada NO CHATWOOT. O padrão é agora, que é a entrega ao vivo; um valor
  // antigo é o replay de uma entrega que ficou encalhada, que é o outro lado da cerca de episódio.
  criadaEm: Date = new Date(),
  // A recuperação de uma entrega encalhada, que é como o webhook sabe que esta passada é um replay:
  // a linha é retomada de `DEAD` em vez de reivindicada de `PENDING`.
  replay = false,
  // Quando a entrega CHEGOU a nós, carimbada pelo banco. Numa entrega ao vivo é agora; numa
  // encalhada é quando o webhook original chegou, que pode ser horas antes da recuperação.
  chegouEm?: Date,
): Promise<void> {
  const n = normalizeChatwootEvent({
    event: "message_created",
    id: 500_000 + convId,
    created_at: Math.floor(criadaEm.getTime() / 1000),
    content: texto,
    message_type: "incoming",
    private: false,
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
      channel: "Channel::Api",
      last_activity_at: Math.floor(criadaEm.getTime() / 1000),
    },
  });
  if (!n) throw new Error("unreachable: o evento do fixture é válido");
  const delivery = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `followup-cancel-${convId}-${Date.now()}`,
      event: "message_created",
      status: replay ? "DEAD" : "PENDING",
      ...(chegouEm ? { receivedAt: chegouEm } : {}),
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: delivery.id,
    agentBotId: AGENT_BOT_ID,
    normalized: n,
    ...(replay ? { claimFrom: "DEAD" as const } : {}),
    base: appDb,
    deps: {
      makeClient: (async () =>
        ({
          sendMessage: async () => ({}),
          sendPrivateNote: async () => ({}),
          toggleTyping: async () => ({}),
          getMessages: async () => ({ payload: [] }),
        }) as unknown as ChatwootClient) as never,
      // O turno em si não é o objeto desta medição, e um modelo de verdade só acrescentaria rede.
      makeModel: () => {
        throw new Error("nenhum turno deve ser pedido neste caso");
      },
    },
  }).catch(() => {
    // O receptor pode desistir do turno por qualquer um dos seus próprios portões; o cancelamento
    // do follow-up é anterior a isso e é o que este teste mede.
  });
}

// O estado de uma conversa que MERECE o lembrete: o agente já falou uma vez, o cliente é quem está
// em silêncio, e o silêncio é mais velho que o passo configurado.
async function emSilencioElegivel(convId: number): Promise<void> {
  await suDb.conversation.updateMany({
    where: { tenantId, chatwootConversationId: convId },
    data: {
      status: "pending",
      lastEventAt: new Date(Date.now() - 2 * 60_000),
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: new Date(Date.now() - 10 * 60_000),
      lastRepliedMessageId: 1,
    },
  });
}

// O cliente do Chatwoot que o handler usaria, colecionando o que ele mandaria ao cliente.
function stubDoChatwoot() {
  const enviadas: Array<[number, string]> = [];
  const client = {
    getConversation: async (c: number) => ({
      id: c,
      status: "pending",
      meta: {},
    }),
    sendMessage: async (c: number, t: string) => {
      enviadas.push([c, t]);
      return {};
    },
    sendPrivateNote: async () => ({}),
    getConversationLabels: async () => [],
    setConversationLabels: async () => ({}),
    toggleStatus: async () => ({}),
    toggleTyping: async () => ({}),
    getMessages: async () => ({ payload: [] }),
  } as unknown as ChatwootClient;
  return { enviadas, makeClient: (async () => client) as never };
}

const modeloFalso = () =>
  new FakeListChatModel({ responses: ["Passando para lembrar do que pedi."] });

describe.skipIf(!dbUp)(
  "o cancelamento do follow-up quando o cliente responde",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "FollowCancel", slug: `follow-cancel-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 6,
        baseUrl: "https://chat.followcancel.example",
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
          systemPrompt: "x",
          enabled: true,
          mode: "production",
          // A cerca que diz a partir de quando este agente tem follow-up: sem ela, todo job é
          // descartado como armado antes de a feature existir para ele.
          followUpArmedAt: new Date(Date.now() - 30 * 86_400_000),
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${llmKey.id}`,
          },
          settings: {
            followUp: {
              enabled: true,
              steps: [
                { delayValue: 1, delayUnit: "minutes", instructions: "lembre" },
              ],
            },
          },
        },
        select: { id: true },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: AGENT_BOT_ID,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `follow-cancel-${process.pid}`,
          name: "Atendente",
        },
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
      for (const convId of [
        CONV_REIVINDICADO,
        CONV_PENDENTE,
        CONV_VIZINHA,
        CONV_REARME,
        CONV_CONTROLE,
        CONV_PONTA,
        CONV_REPLAY,
      ]) {
        await suDb.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            inboxId: inboxDbId,
            chatwootConversationId: convId,
            status: "pending",
            threadId: threadOf(convId),
            lastEventAt: new Date(Date.now() - 60_000),
          },
        });
      }
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
          "chatwoot_agent_bots",
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

    test("o job JÁ REIVINDICADO é retirado quando o cliente escreve", async () => {
      const job = await armar(CONV_REIVINDICADO, "CLAIMED");
      expect(await jobRetired(job, suDb)).toBe(false);

      await clienteEscreve(
        CONV_REIVINDICADO,
        "segue o comprovante que vocês pediram",
      );

      // A PERGUNTA QUE O HANDLER FAZ ANTES DE ENVIAR, e não o status da linha: `stillWanted` é
      // `!jobRetired`, então é esta resposta que decide se o lembrete sai. Medi-la pelo status seria
      // medir a implementação do cancelamento em vez da garantia que ele existe para dar.
      expect(await jobRetired(job, suDb)).toBe(true);
    });

    test("o job ainda PENDENTE continua sendo cancelado", async () => {
      const job = await armar(CONV_PENDENTE, "PENDING");
      await clienteEscreve(CONV_PENDENTE, "oi, alguma novidade?");

      // A metade PENDING, aqui para que o cancelamento do job reivindicado não a leve junto. A GARANTIA
      // dela é o job não poder mais ser reivindicado, e isso se lê no status: a marca de aposentadoria é a
      // pergunta do handler EM VOO, que um job nunca reivindicado não chega a fazer.
      const row = await suDb.schedulerJob.findUniqueOrThrow({
        where: { id: job.id },
        select: { status: true },
      });
      expect(row.status).not.toBe("PENDING");
    });

    test("uma resposta em OUTRA conversa não derruba este follow-up", async () => {
      const job = await armar(CONV_VIZINHA, "CLAIMED");
      await clienteEscreve(
        CONV_REARME,
        "falando de outro assunto, em outra conversa",
      );

      // A chave de dedupe nomeia a conversa: um cancelamento que alcançasse a vizinha apagaria o
      // lembrete de quem de fato está em silêncio.
      expect(await jobRetired(job, suDb)).toBe(false);
    });

    test("a retirada não olha a idade da mensagem, e isso é a decisão", async () => {
      const job = await armar(CONV_REPLAY, "CLAIMED");

      // NOTE: A conversa NO MEIO da escada: o primeiro lembrete já saiu e ninguém falou desde então. A varredura
      // não re-arma essa linha (`GREATEST(last_inbound_at, last_replied_at) > last_follow_up_at` no
      // sweepHandler), então retirar aqui mata o resto da escada, inclusive o resolve do passo final. E
      // retira assim mesmo: nenhuma ordenação disponível distingue a entrega velha da nova (o carimbo é do
      // relógio do Chatwoot, a hora de chegada confunde a resposta que cruza um lembrete em voo, e a
      // retomada de DEAD não prova que a mensagem foi atendida), e cada cerca dessas deixa o lembrete sair
      // por cima de quem acabou de escrever. Perder a escada custa pouco: responder avança
      // `last_replied_at`, que abre episódio novo, e a varredura arma outra escada no silêncio seguinte.
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: CONV_REPLAY },
        data: {
          lastInboundAt: new Date(Date.now() - 60 * 60_000),
          lastRepliedAt: null,
          lastFollowUpAt: new Date(Date.now() - 10 * 60_000),
        },
      });

      await clienteEscreve(
        CONV_REPLAY,
        "mensagem antiga, entregue com atraso",
        new Date(Date.now() - 60 * 60_000),
        true,
        new Date(Date.now() - 60 * 60_000),
      );

      expect(await jobRetired(job, suDb)).toBe(true);
    });

    test("depois da retirada, um episódio novo volta a valer", async () => {
      const antigo = await armar(CONV_REARME, "CLAIMED");
      await clienteEscreve(CONV_REARME, "obrigado, era isso");
      expect(await jobRetired(antigo, suDb)).toBe(true);

      // O varredor arma de novo quando o silêncio recomeça, e o re-arme reescreve o payload inteiro —
      // é o que impede a marca de retirada de virar uma lápide permanente sobre a conversa, calando
      // todo follow-up futuro dela. Sem esta asserção, um conserto que retirasse "para sempre"
      // passaria, e o defeito apareceria semanas depois como silêncio do agente.
      const novo = await armar(CONV_REARME, "CLAIMED");
      expect(await jobRetired(novo, suDb)).toBe(false);
    });
    // NOTE: PONTA A PONTA, e o par é o ponto: o que interessa é o LEMBRETE NÃO SAIR. Sem o controle positivo,
    // o par passaria por qualquer motivo (agente inelegível, cerca de silêncio, conversa resolvida). A
    // ÚNICA diferença entre os dois casos é a marca de aposentadoria: a mensagem do cliente também
    // carimba o silêncio da conversa, que é OUTRA cerca, então o estado de silêncio é reposto DEPOIS de a
    // mensagem entrar pelo caminho de verdade, e o que sobra medindo é a retirada.
    test("controle: sem resposta do cliente, o lembrete SAI", async () => {
      const job = await armar(CONV_CONTROLE, "CLAIMED");
      await emSilencioElegivel(CONV_CONTROLE);
      const s = stubDoChatwoot();

      await followUpHandler(job, appDb, {
        makeModel: modeloFalso,
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      });

      expect(s.enviadas.length).toBeGreaterThan(0);
    });

    test("o lembrete NÃO sai depois de o cliente ter escrito, com o job já reivindicado", async () => {
      const job = await armar(CONV_PONTA, "CLAIMED");
      await clienteEscreve(
        CONV_PONTA,
        "já mandei os documentos, seguem de novo",
      );
      await emSilencioElegivel(CONV_PONTA);
      const s = stubDoChatwoot();

      await followUpHandler(job, appDb, {
        makeModel: modeloFalso,
        makeClient: s.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      });

      expect(s.enviadas).toEqual([]);
    });
  },
);
