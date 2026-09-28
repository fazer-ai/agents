import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { OPERATOR_EVENT_NOTE_PREFIX, runAgentNudge } from "@/graph/nudge";
import { runAgentTurn } from "@/graph/runtime";
import { clearTurnOwning, markTurnOwning } from "@/graph/thread-claim";
import { buildThreadStateGraph } from "@/graph/thread-state";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { SlowReplyModel } from "../utils/scripted-models";
import { codeOnly } from "../utils/source-text";

// Um invoke do LangGraph é um read-modify-write do canal inteiro: de dois que se sobrepõem no mesmo
// thread, o que termina em SEGUNDO salva o que carregou e desfaz o primeiro. O nudge deve ao
// cliente uma resposta única, então pelo critério de ../../src/graph/thread-claim.ts ele não entra
// junto: espera o thread com `waitForTurnToClear`. Este arquivo testa as duas metades separadas de
// propósito: que o nudge ESPERA (o mecanismo) e que a mensagem entregue SOBREVIVE no canal (a
// consequência, o que o cliente perde). Uma espera que passe só na primeira não protege nada.

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

function stub() {
  const messages: Array<[number, string]> = [];
  const notes: Array<[number, string]> = [];
  const client = {
    sendMessage: async (c: number, t: string) => {
      messages.push([c, t]);
      return {};
    },
    sendPrivateNote: async (c: number, t: string) => {
      notes.push([c, t]);
      return {};
    },
    getConversationLabels: async () => [],
    setConversationLabels: async () => ({}),
    toggleStatus: async () => ({}),
    sendTemplate: async () => ({}),
  } as unknown as ChatwootClient;
  return { client, messages, notes, makeClient: async () => client };
}

async function seedConv(convId: number, contactInboxId: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbId,
      chatwootConversationId: convId,
      contactInboxId,
      status: "pending",
      assigneeType: null,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
      lastInboundAt: new Date(),
    },
  });
}

async function channelOf(
  checkpointer: MemorySaver,
  threadId: string,
): Promise<string[]> {
  const state = await buildThreadStateGraph(checkpointer).getState({
    configurable: { thread_id: threadId },
  });
  const messages = ((state.values as { messages?: BaseMessage[] })?.messages ??
    []) as BaseMessage[];
  return messages.map((m) =>
    typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  );
}

// O símbolo que separa "ainda esperando" de "terminou": um `Promise.race` contra um timer responde
// a pergunta sem depender de o nudge ter terminado com um desfecho específico.
const AINDA_ESPERANDO = Symbol("o nudge ainda não terminou");

async function terminouEm<T>(p: Promise<T>, ms: number) {
  return Promise.race([
    p,
    new Promise<typeof AINDA_ESPERANDO>((r) =>
      setTimeout(() => r(AINDA_ESPERANDO), ms),
    ),
  ]);
}

describe.skipIf(!dbUp)(
  "o nudge não corre ao lado de um invoke que já lê",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "NW", slug: `nw-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 9,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const vault = await suDb.vaultEntry.create({
        data: { tenantId, name: "k", secret: encryptJson("sk") },
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
            credentialRef: `vault:${vault.id}`,
          },
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
          webhookRouteTokenHash: `nw-route-${process.pid}`,
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
          channelType: "Channel::Whatsapp",
          provider: "whatsapp_cloud",
        },
      });
      inboxDbId = inbox.id;
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of [
          "llm_usage",
          "scheduler_jobs",
          "agent_threads",
          "conversations",
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

    // NOTE: O MECANISMO. Um invoke mais velho segura o thread; o nudge tem que ficar parado até ele
    // soltar, e não apenas "não estourar". Sem a espera as duas asserções abaixo passam por
    // acidente: o nudge termina antes do timer porque nunca esperou nada.
    test("um nudge encontra o thread ocupado e espera soltar", async () => {
      const contactInboxId = 8901;
      await seedConv(8901, contactInboxId);
      const graphThreadId = contactInboxThreadId(
        tenantId,
        instanceId,
        contactInboxId,
      );
      const owner = { tenantId, instanceId, contactInboxId, graphThreadId };
      const invokeMaisVelho = await markTurnOwning(owner, appDb);

      const s = stub();
      const nudge = runAgentNudge({
        tenantId,
        threadId: `${tenantId}:${instanceId}:8901`,
        nudge: { source: "followup", kind: "inactivity", step: 1 },
        base: appDb,
        deps: {
          makeModel: () =>
            new FakeListChatModel({ responses: ["Oi, tudo bem?"] }),
          makeClient: s.makeClient,
          checkpointer: new MemorySaver(),
          persistUsage: async () => {},
        },
      });

      expect(await terminouEm(nudge, 400)).toBe(AINDA_ESPERANDO);
      // E NADA FOI ENTREGUE ENQUANTO ESPERAVA. Uma espera colocada depois do envio protegeria o canal
      // e deixaria o cliente com a mensagem de um turno que nem começou.
      expect(s.messages).toHaveLength(0);

      await clearTurnOwning(owner, appDb, invokeMaisVelho);
      expect(await nudge).toBe("messaged");
      expect(s.messages).toHaveLength(1);
    }, 15_000);

    // NOTE: A CONSEQUÊNCIA, o que o cliente perde: um turno reativo lento começa, o nudge dispara
    // em cima dele e entrega rápido, e o reativo termina por último salvando o canal que carregou,
    // sem a mensagem proativa. Usa o turno reativo DE VERDADE: o que apaga é o read-modify-write do
    // `graph.invoke`, e simulá-lo com `updateState` testa outra coisa (o reducer do canal faz
    // append, então um update nunca apagaria nada e o teste passaria vazio).
    test("a mensagem entregue sobrevive ao turno reativo que a sobrepôs", async () => {
      const contactInboxId = 8902;
      await seedConv(8902, contactInboxId);
      const graphThreadId = contactInboxThreadId(
        tenantId,
        instanceId,
        contactInboxId,
      );
      const checkpointer = new MemorySaver();

      const reativo = stub();
      const clienteReativo = {
        ...reativo.client,
        getMessages: async () => ({
          payload: [{ id: 1, content: "oi", message_type: 0, private: false }],
        }),
        sendMessage: reativo.client.sendMessage,
        toggleTyping: async () => ({}),
      } as unknown as ChatwootClient;

      const turno = runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: 9,
        event: {
          event: "message_created",
          conversationId: 8902,
          inboxId: 7,
          status: "pending",
          assigneeType: null,
          assigneeId: null,
          assigneeName: null,
          contactInboxId,
          message: {
            id: 1,
            content: "oi",
            messageType: "incoming",
            private: false,
          },
        },
        base: appDb,
        deps: {
          makeModel: () => new SlowReplyModel("RESP-R", 1_500) as never,
          makeClient: async () => clienteReativo,
          checkpointer,
          persistUsage: async () => {},
        },
      });

      // NOTE: Em cima do turno reativo, que já reivindicou o thread.
      await new Promise((r) => setTimeout(r, 300));
      const s = stub();
      const nudge = runAgentNudge({
        tenantId,
        threadId: `${tenantId}:${instanceId}:8902`,
        nudge: { source: "followup", kind: "inactivity", step: 1 },
        base: appDb,
        deps: {
          makeModel: () => new FakeListChatModel({ responses: ["RESP-N"] }),
          makeClient: s.makeClient,
          checkpointer,
          persistUsage: async () => {},
        },
      });

      await Promise.all([turno, nudge]);
      // A entrega aconteceu: o cliente leu RESP-N.
      expect(s.messages.map(([, t]) => t)).toEqual(["RESP-N"]);
      // NOTE: A PROVA: o thread lembra dela. Sem a espera o canal termina sem RESP-N, porque o invoke
      // do reativo termina em segundo e salva o canal de antes do nudge.
      const canal = await channelOf(checkpointer, graphThreadId);
      expect(canal.some((t) => t.includes("RESP-N"))).toBe(true);
    }, 30_000);

    // A DEVOLUÇÃO DO HOLD, que é o passo que só aparece quando DOIS esperam. Os dois leem "livre" no
    // mesmo instante e os dois chegam na declaração que adquire; dela exatamente um sai com
    // `heldBefore` falso. Sem a devolução o perdedor segue ao lado do vencedor — que é a
    // sobreposição de novo, agora entre dois turnos proativos — e uma das duas entregas some do
    // canal. Uma espera sem devolução parece pronta e conserta metade.
    test("dois nudges esperando o mesmo thread não se sobrepõem ao acordar", async () => {
      const contactInboxId = 8905;
      // Duas conversas, o MESMO contact-inbox: o thread do grafo é keyed por contact-inbox, então as
      // duas escadas invocam o mesmo canal. É a forma real (um lembrete e um follow-up do mesmo
      // contato), não uma montagem.
      await seedConv(8905, contactInboxId);
      await seedConv(8906, contactInboxId);
      const graphThreadId = contactInboxThreadId(
        tenantId,
        instanceId,
        contactInboxId,
      );
      const owner = { tenantId, instanceId, contactInboxId, graphThreadId };
      const terceiro = await markTurnOwning(owner, appDb);

      const checkpointer = new MemorySaver();
      const a = stub();
      const b = stub();
      const nudgeA = runAgentNudge({
        tenantId,
        threadId: `${tenantId}:${instanceId}:8905`,
        nudge: { source: "followup", kind: "inactivity", step: 1 },
        base: appDb,
        deps: {
          // NOTE: O PRIMEIRO É LENTO DE PROPÓSITO. A fila `ingest:` serializa a seção da
          // reivindicação, não o invoke: com os dois modelos instantâneos o perdedor acaba antes de
          // o vencedor começar a escrever, e o teste passaria mesmo com a devolução arrancada. Um
          // invoke de 1,5 s põe os dois de fato em cima um do outro.
          makeModel: () => new SlowReplyModel("RESP-A", 1_500) as never,
          makeClient: a.makeClient,
          checkpointer,
          persistUsage: async () => {},
        },
      });
      const nudgeB = runAgentNudge({
        tenantId,
        threadId: `${tenantId}:${instanceId}:8906`,
        nudge: { source: "followup", kind: "inactivity", step: 2 },
        base: appDb,
        deps: {
          // NOTE: OS DOIS LENTOS, e o segundo um pouco menos: quem vence a corrida da reivindicação não
          // é determinístico, e com um modelo instantâneo o desfecho sem a devolução dependeria de
          // quem vencesse. Com os dois lentos o invoke que termina por último é sempre o de 1,5 s,
          // qualquer que seja a ordem de reivindicação, e sem a devolução do hold ele sempre salva
          // um canal carregado antes da escrita do outro.
          makeModel: () => new SlowReplyModel("RESP-B", 1_200) as never,
          makeClient: b.makeClient,
          checkpointer,
          persistUsage: async () => {},
        },
      });

      // Os dois estão na espera, e é a liberação que os solta juntos.
      expect(await terminouEm(Promise.all([nudgeA, nudgeB]), 400)).toBe(
        AINDA_ESPERANDO,
      );
      await clearTurnOwning(owner, appDb, terceiro);
      await Promise.all([nudgeA, nudgeB]);

      // As duas entregas aconteceram...
      expect(a.messages.map(([, t]) => t)).toEqual(["RESP-A"]);
      expect(b.messages.map(([, t]) => t)).toEqual(["RESP-B"]);
      // ...e as duas estão na memória. Sem a devolução do hold, uma delas não está.
      const canal = await channelOf(checkpointer, graphThreadId);
      expect(canal.some((t) => t.includes("RESP-A"))).toBe(true);
      expect(canal.some((t) => t.includes("RESP-B"))).toBe(true);
    }, 30_000);

    // NOTE: O PORTÃO DO OUTRO LADO DA ESPERA. A espera abre uma janela de minutos entre o
    // `canMessagePre` e o invoke, e a re-checagem pós-geração só suprime o envio: não desfaz uma
    // etiqueta escrita nem uma chamada HTTP que as ferramentas do modelo fizeram. Uma pessoa que
    // assume a conversa durante a espera tem que parar o turno ANTES de o modelo rodar.
    test("quem assume a conversa durante a espera para o turno antes do modelo", async () => {
      const contactInboxId = 8907;
      await seedConv(8907, contactInboxId);
      const graphThreadId = contactInboxThreadId(
        tenantId,
        instanceId,
        contactInboxId,
      );
      const owner = { tenantId, instanceId, contactInboxId, graphThreadId };
      const invokeMaisVelho = await markTurnOwning(owner, appDb);
      await clearFlowLog(suDb, { tenantId });

      const s = stub();
      // Mesmo motivo do teste de baixo: o contador é do `SlowReplyModel`, porque o `i` do
      // FakeListChatModel fica em 0 mesmo quando o modelo respondeu.
      const modelo = new SlowReplyModel("RESP-N", 0);
      const nudge = runAgentNudge({
        tenantId,
        threadId: `${tenantId}:${instanceId}:8907`,
        nudge: { source: "followup", kind: "inactivity", step: 1 },
        base: appDb,
        deps: {
          makeModel: () => modelo as never,
          makeClient: s.makeClient,
          checkpointer: new MemorySaver(),
          persistUsage: async () => {},
        },
      });

      expect(await terminouEm(nudge, 300)).toBe(AINDA_ESPERANDO);
      // A pessoa assume DENTRO da espera. O espelho é o que a webhook de atribuição escreve.
      await suDb.conversation.updateMany({
        where: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: 8907,
        },
        data: { assigneeType: "User", assigneeId: 4242, status: "open" },
      });
      await clearTurnOwning(owner, appDb, invokeMaisVelho);

      expect(await nudge).toBe("stale");
      expect(s.messages).toHaveLength(0);
      // ANTES DO MODELO, e não só antes do envio: é o que separa este portão da sonda pós-geração.
      // Um turno que rodou o modelo já rodou as ferramentas dele.
      expect(modelo.calls).toBe(0);
      // E o portão escreve a linha do vocabulário compartilhado, para o operador que filtra por ela.
      const rows = await flowLogRows(suDb, {
        where: {
          tenantId,
          stage: "handoff",
          threadId: `${tenantId}:${instanceId}:8907`,
        },
      });
      expect(
        rows.map((r) => ((r.detail ?? {}) as Record<string, unknown>).outcome),
      ).toContain("taken_over");
    }, 15_000);

    // NOTE: O mesmo portão com um evento do operador: quem assumiu recebe o relatório como veio, em
    // nota privada, em vez de o evento sumir como `stale`.
    test("quem assume durante a espera recebe o evento do operador como nota", async () => {
      const contactInboxId = 8931;
      await seedConv(8931, contactInboxId);
      const graphThreadId = contactInboxThreadId(
        tenantId,
        instanceId,
        contactInboxId,
      );
      const owner = { tenantId, instanceId, contactInboxId, graphThreadId };
      const invokeMaisVelho = await markTurnOwning(owner, appDb);
      const s = stub();
      const modelo = new SlowReplyModel("RESP-N", 0);
      const nudge = runAgentNudge({
        tenantId,
        threadId: `${tenantId}:${instanceId}:8931`,
        nudge: {
          source: "GENERIC",
          kind: "agent_nudge",
          framing: "operator_event",
          text: "Entraram 120 de 400.",
        },
        deliverToResolved: true,
        base: appDb,
        deps: {
          makeModel: () => modelo as never,
          makeClient: s.makeClient,
          checkpointer: new MemorySaver(),
          persistUsage: async () => {},
        },
      });
      expect(await terminouEm(nudge, 300)).toBe(AINDA_ESPERANDO);
      await suDb.conversation.updateMany({
        where: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: 8931,
        },
        data: { assigneeType: "User", assigneeId: 4242, status: "open" },
      });
      await clearTurnOwning(owner, appDb, invokeMaisVelho);

      expect(await nudge).toBe("noted");
      expect(s.messages).toHaveLength(0);
      expect(modelo.calls).toBe(0);
      expect(s.notes.map(([, t]) => t)).toEqual([
        `${OPERATOR_EVENT_NOTE_PREFIX}Entraram 120 de 400.`,
      ]);
    }, 15_000);

    // NOTE: "NÃO DEU PARA VERIFICAR" NÃO É "UMA PESSOA ASSUMIU", e isso atravessa o `.catch` do
    // portão sem tocá-lo. No modo `requireLiveBotOwnership` a sonda engole a falha por dentro e
    // responde `unavailable`; dobrar isso em "não é nosso" faria uma indisponibilidade do Chatwoot
    // encerrar o episódio, um fail-closed que entra por uma porta que não lança.
    test("a sonda live indisponível no portão deixa o turno seguir", async () => {
      const contactInboxId = 8908;
      await seedConv(8908, contactInboxId);
      const graphThreadId = contactInboxThreadId(
        tenantId,
        instanceId,
        contactInboxId,
      );
      const owner = { tenantId, instanceId, contactInboxId, graphThreadId };
      const invokeMaisVelho = await markTurnOwning(owner, appDb);

      const s = stub();
      // A primeira leitura passa (é ela que deixa o run começar); da segunda em diante o Chatwoot
      // some. A segunda é a do portão pós-espera.
      let leituras = 0;
      const client = {
        ...(await s.makeClient()),
        getConversation: async (c: number) => {
          if (++leituras > 1) throw new Error("chatwoot fora do ar");
          return { id: c, status: "pending", meta: {} };
        },
      } as unknown as ChatwootClient;
      // `SlowReplyModel` e não `FakeListChatModel` porque este conta as chamadas: o `i` do
      // FakeList existe e fica em 0 mesmo num turno que respondeu, então uma asserção sobre ele
      // passaria verde sobre um modelo que nunca rodou e sobre um que rodou.
      const modelo = new SlowReplyModel("RESP-N", 0);
      const nudge = runAgentNudge({
        tenantId,
        threadId: `${tenantId}:${instanceId}:8908`,
        nudge: { source: "followup", kind: "inactivity", step: 1 },
        requireLiveBotOwnership: true,
        base: appDb,
        deps: {
          makeModel: () => modelo as never,
          makeClient: async () => client,
          checkpointer: new MemorySaver(),
          persistUsage: async () => {},
        },
      });

      expect(await terminouEm(nudge, 300)).toBe(AINDA_ESPERANDO);
      await clearTurnOwning(owner, appDb, invokeMaisVelho);
      await nudge;

      // A PROVA: o portão deixou passar, e o turno rodou. O que ele faz depois é assunto da sonda
      // pós-modelo, que é fail-closed de propósito e segura o envio.
      expect(modelo.calls).toBeGreaterThan(0);
      expect(leituras).toBeGreaterThan(1);
      expect(s.messages).toHaveLength(0);
    }, 15_000);

    // NOTE: O TETO. Passado ele o nudge segue ao lado de quem está lá, e ali a entrega PODE não ser
    // lembrada: é a única porta por onde a sobreposição ainda passa. Então ela não sai calada: uma
    // linha de flowlog diz o que acabou de acontecer, no lugar onde o operador procura.
    test("passado o teto o nudge segue, e a entrega que pode ser esquecida é declarada", async () => {
      const contactInboxId = 8903;
      await seedConv(8903, contactInboxId);
      const graphThreadId = contactInboxThreadId(
        tenantId,
        instanceId,
        contactInboxId,
      );
      const owner = { tenantId, instanceId, contactInboxId, graphThreadId };
      // Segura o thread e NÃO solta: é o holder que renova o lease e nunca termina.
      await markTurnOwning(owner, appDb);
      await clearFlowLog(suDb, { tenantId });

      const s = stub();
      const outcome = await runAgentNudge({
        tenantId,
        threadId: `${tenantId}:${instanceId}:8903`,
        nudge: { source: "followup", kind: "inactivity", step: 1 },
        base: appDb,
        deps: {
          makeModel: () => new FakeListChatModel({ responses: ["RESP-N"] }),
          makeClient: s.makeClient,
          checkpointer: new MemorySaver(),
          persistUsage: async () => {},
          // Um teto já vencido põe o teste no instante do estouro: os cinco minutos de verdade não
          // cabem numa suíte, e o que se mede é o que acontece DEPOIS deles.
          turnWaitDeadline: () => Date.now(),
        },
      });

      // (1) termina sozinho, com palavra do vocabulário, e entrega.
      expect(outcome).toBe("messaged");
      expect(s.messages.map(([, t]) => t)).toEqual(["RESP-N"]);
      // (2) e a linha existe, no stage que o operador filtra, em warn.
      // Pelo superusuário: o papel de runtime tem RLS e uma leitura sem contexto de tenant
      // devolve zero linhas em silêncio, que é a armadilha do CLAUDE.md.
      const rows = await flowLogRows(suDb, {
        where: { tenantId, threadId: `${tenantId}:${instanceId}:8903` },
      });
      const aviso = rows.filter((r) => {
        const d = (r.detail ?? null) as Record<string, unknown> | null;
        return d?.threadWaitExpired === true;
      });
      expect(aviso).toHaveLength(1);
      expect(aviso[0]?.level).toBe("warn");
      // (3) e ela DIZ o que está em jogo, em vez de só marcar que esperou.
      expect(
        String(
          ((aviso[0]?.detail ?? {}) as Record<string, unknown>).note ?? "",
        ),
      ).toContain("may not survive");
    }, 15_000);

    // NOTE: A OCASIÃO NÃO É ENTREGUE DUAS VEZES POR CAUSA DA ESPERA. O teto (305 s) é MAIOR que a
    // janela do reaper do scheduler (`staleMs` de 300 s, src/modules/scheduler/worker.ts), então
    // uma espera no teto atravessa o reaper: a linha volta a PENDING, outro tick a reivindica (o
    // que incrementa o `claim_seq`) e o mesmo nudge roda de novo enquanto o primeiro espera. Quem
    // segura é o `stillWanted(true)` do nudge, DEPOIS da espera, que responde pelo `claim_seq`.
    // Este teste prova a posição, não o predicado: a retirada é encenada no instante da
    // reivindicação do segundo handler.
    test("uma ocasião reivindicada de novo durante a espera não é entregue duas vezes", async () => {
      const contactInboxId = 8904;
      await seedConv(8904, contactInboxId);
      const graphThreadId = contactInboxThreadId(
        tenantId,
        instanceId,
        contactInboxId,
      );
      const owner = { tenantId, instanceId, contactInboxId, graphThreadId };
      const invokeMaisVelho = await markTurnOwning(owner, appDb);

      // O reaper devolve a linha e outro tick a reivindica ENQUANTO este handler espera: daí em diante
      // o token deste handler não é mais o da linha.
      let reivindicadaDeNovo = false;
      const s = stub();
      const nudge = runAgentNudge({
        tenantId,
        threadId: `${tenantId}:${instanceId}:8904`,
        nudge: { source: "followup", kind: "inactivity", step: 1 },
        stillWanted: async () => !reivindicadaDeNovo,
        base: appDb,
        deps: {
          makeModel: () => new FakeListChatModel({ responses: ["RESP-N"] }),
          makeClient: s.makeClient,
          checkpointer: new MemorySaver(),
          persistUsage: async () => {},
        },
      });

      expect(await terminouEm(nudge, 300)).toBe(AINDA_ESPERANDO);
      reivindicadaDeNovo = true;
      await clearTurnOwning(owner, appDb, invokeMaisVelho);

      // Sai com palavra do vocabulário, sem lançar e sem entregar.
      expect(await nudge).toBe("stale");
      expect(s.messages).toHaveLength(0);
    }, 15_000);
  },
);

// As duas metades acima testam o comportamento. O que elas não pegam é o laço desmontado de um
// jeito que ainda passa nos dois testes: um símbolo próprio em cada arquivo (os dois laços voltam a
// divergir sem ninguém notar), a espera indo para DENTRO da fila (passa verde e trava exatamente o
// turno que ela espera), ou a devolução do hold saindo do lugar.
describe("o laço da espera é o mesmo nos dois turnos", () => {
  test("nenhum dos dois declara o próprio sentinela", async () => {
    for (const f of ["src/graph/nudge.ts", "src/graph/runtime.ts"]) {
      const src = codeOnly(await Bun.file(f).text());
      // Declarar significa divergir: dois símbolos com o mesmo nome não são o mesmo valor, e o
      // `!==` de um laço contra o sentinela do outro é sempre verdadeiro.
      expect(src).not.toMatch(/WAIT_AGAIN\s*=\s*Symbol/);
      expect(src).toMatch(/WAIT_AGAIN/);
    }
  });

  // NOTE: A ESPERA, A BARREIRA E A FILA, NESTA ORDEM. Esperar dentro da fila trava quem está sendo
  // esperado (o rollback do turno anterior toma a MESMA chave na saída), e drenar antes da espera
  // lê um thread que fica velho pelos minutos da espera (../../src/graph/runtime.ts diz as duas no mesmo lugar).
  test("no nudge a espera vem antes da barreira, e a barreira antes da fila", async () => {
    const src = codeOnly(await Bun.file("src/graph/nudge.ts").text());
    const espera = src.indexOf("waitForTurnToClear(");
    const barreira = src.indexOf("drainPendingIngest(");
    const fila = src.indexOf("withKeyedQueue(");
    expect(espera).toBeGreaterThanOrEqual(0);
    expect(espera).toBeLessThan(barreira);
    expect(barreira).toBeLessThan(fila);
  });

  // NOTE: O PORTÃO PÓS-ESPERA FALHA ABERTO, e isto é cerca e não gosto: fechado, uma leitura que
  // falha ali viraria desistência para TODO nudge que esperou, e a sonda pós-modelo já segura o
  // envio.
  test("a leitura de posse que falha deixa o nudge seguir", async () => {
    const src = codeOnly(await Bun.file("src/graph/nudge.ts").text());
    const i = src.indexOf("botOwnsItNowDetailed().catch(");
    expect(i).toBeGreaterThanOrEqual(0);
    // O catch devolve posse, em vez de devolver o oposto ou relançar.
    expect(src.slice(i, src.indexOf("});", i))).toInclude("ours: true");
  });

  // A devolução do hold fica DEPOIS da declaração que adquire e ANTES de qualquer escrita: é a
  // declaração, e não a leitura acima dela, que vê dois começos simultâneos.
  test("no nudge o hold é devolvido logo depois da declaração que adquire", async () => {
    const src = codeOnly(await Bun.file("src/graph/nudge.ts").text());
    const adquire = src.indexOf("markTurnOwning(owner, base)");
    const devolve = src.indexOf("return WAIT_AGAIN;");
    const escreve = src.indexOf("conversationDividerMessage(");
    expect(adquire).toBeGreaterThanOrEqual(0);
    expect(adquire).toBeLessThan(devolve);
    expect(devolve).toBeLessThan(escreve);
    // E ela devolve de verdade, em vez de só sair do laço com o hold na mão: um hold guardado
    // impede a liberação do vencedor de chegar a zero.
    const trecho = src.slice(adquire, devolve);
    expect(trecho).toInclude("clearTurnOwning(owner, base, giveBack)");
  });
});
