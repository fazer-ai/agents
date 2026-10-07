import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId, contactInboxThreadId } from "@/graph/checkpointer";
import { ingestDedupeKey } from "@/graph/ingest-job";
import { createChatwootClient } from "@/modules/chatwoot/client";
import {
  recoverStrandedHumanReply,
  registerHumanReplyRecoveryHandler,
} from "@/modules/chatwoot/recover-human-reply";
import { getJobHandler } from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// RECOVERING THE COLLEAGUE'S REPLY AN INGESTION LOST.
//
// The delivery loses one effect: the words reaching the contact's memory. The ledger names the reply
// (`human_reply_message_id`, written at INSERT for the takeover's own fence), so the message is read
// back by id and the append armed again. What is asserted is the job the recovery arms and its
// payload, not the append itself, which is the ingest job's (src/graph/ingest.ts), dedup included.
// The Chatwoot side serves the page in the REST spelling this recovery depends on: `message_type`
// as an INTEGER and the sender by `push_event_data`; the webhook spelling would pass by construction.

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
const ZAPI_INBOX_ID = 92;
const TEST_MODE_INBOX_ID = 93;
// An inbox NOBODY of ours answers, with a watcher on it: a route that folds nothing in, because
// there is no responder's memory for the watcher to share.
const UNANSWERED_INBOX_ID = 94;
// A responder of ours, with a watcher whose own agent is in `test` mode. The receiver asks a
// row-backed watcher's SWITCH and not its mode, so this route folds the reply in, and it is the
// only shape that tells the two readings of the gate apart.
const WATCHED_INBOX_ID = 95;
const OUR_BOT = 31;
// A watcher's own bot: Chatwoot fans a message to the inbox's bot AND to any observer attached to
// it, so a strand can carry either route, and only the row says which.
const WATCHER_BOT = 32;
// The `test`-mode agent's own bot. Its route has to carry it, or the fixture would be a state no
// install can be in: a delivery claimed under one agent's bot on an inbox another agent answers.
const TEST_BOT = 33;
// The bot of a watcher whose agent is in `test` mode.
const QUIET_WATCHER_BOT = 34;
let tenantId = 0n;
let instanceId = 0n;
let agentDbId = 0n;
let watcherAgentDbId = 0n;
let testAgentDbId = 0n;
let quietWatcherAgentDbId = 0n;
let deliverySeq = 0;

// The account's messages, per conversation, in the REST spelling.
const pages = new Map<number, Record<string, unknown>[]>();
// Conversations whose message read fails outright.
const failingReads = new Set<number>();
// Conversations whose read answers 200 with a body that is not a message page, which is what a
// degraded account looks like from here.
const unusableReads = new Set<number>();
// Conversations an operator resets WHILE the page is being served, which is the window the second
// reading of the boundary exists for and the only one it can see.
const resetDuringRead = new Map<number, () => Promise<void>>();
const calls: { url: string; method: string }[] = [];
const realFetch = globalThis.fetch;

const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  const method = init?.method ?? "GET";
  calls.push({ url, method });
  const list = url.match(/\/conversations\/(\d+)\/messages/);
  if (list && method === "GET") {
    const id = Number(list[1]);
    if (failingReads.has(id)) return new Response("nope", { status: 502 });
    if (unusableReads.has(id)) return Response.json({});
    const during = resetDuringRead.get(id);
    if (during) await during();
    return Response.json({ payload: pages.get(id) ?? [] });
  }
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const makeClient = async (config: Parameters<typeof createChatwootClient>[0]) =>
  createChatwootClient(config, {
    assertSafe: async (url: string) => new URL(url),
    fetchImpl: stubFetch,
  });

// THE REST SPELLING, which is what the fork serves on this endpoint and is not the webhook one.
// `message_type` renders through `message_type_before_type_cast` (an integer), and the sender
// through `User#push_event_data`, which carries `available_name`, `avatar_url`,
// `availability_status` and `thumbnail` beside the four fields the webhook's `webhook_data` gives.
// The discriminator everything depends on, `sender.type === "user"`, is present in both.
function restComposerReply(id: number, content: string) {
  return {
    id,
    content,
    message_type: 1,
    private: false,
    content_attributes: {},
    sender: {
      id: 5,
      name: "Ana",
      available_name: "Ana",
      avatar_url: "",
      type: "user",
      availability_status: null,
      thumbnail: "",
    },
    attachments: [],
  };
}

// The `device` leg: a reply typed on the paired phone reaches Chatwoot with no sender at all, and the
// fork records who wrote it in `content_attributes`. Byte for byte, this is also what the ECHO of our
// own reply looks like on a provider that does not reserve its send ids.
function restDeviceReply(id: number, content: string) {
  return {
    id,
    content,
    message_type: 1,
    private: false,
    content_attributes: {
      external_sender_name: "WhatsApp",
      external_created_at: Math.floor(Date.now() / 1000),
    },
    sender: null,
    attachments: [],
  };
}

describe.skipIf(!dbUp)(
  "recovering a colleague's reply an ingestion lost",
  () => {
    beforeAll(async () => {
      globalThis.fetch = stubFetch as typeof globalThis.fetch;
      const t = await suDb.tenant.create({
        data: { name: "HRR", slug: `hrr-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 41,
        baseUrl: "https://chat.hrr.example",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          mode: "production",
          enabled: true,
          systemPrompt: "Você é prestativa.",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          settings: { debounce: { enabled: false } },
        },
      });
      agentDbId = agent.id;
      // The route that does NOT remember: a `test`-mode agent leaves a ledger row byte for byte like
      // the one a failed enqueue leaves, `route_remembers = false` included.
      const testAgent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente (teste)",
          mode: "test",
          enabled: true,
          systemPrompt: "Você é prestativa.",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          settings: {},
        },
      });
      testAgentDbId = testAgent.id;
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: OUR_BOT,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `hrr-route-${process.pid}`,
          name: "Atendente",
        },
      });
      // The watcher: `monitoring` and switched on, with a bot of its own, on an inbox a
      // `test`-mode agent answers. The live receiver folds a colleague's reply in through THIS agent,
      // and it asks the watcher's switch without asking its mode.
      const watcher = await suDb.agent.create({
        data: {
          tenantId,
          name: "Observadora",
          mode: "monitoring",
          enabled: true,
          systemPrompt: "Você observa.",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          settings: {},
        },
      });
      watcherAgentDbId = watcher.id;
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: testAgent.id,
          chatwootAgentBotId: TEST_BOT,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `hrr-test-${process.pid}`,
          name: "Atendente (teste)",
        },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: watcher.id,
          chatwootAgentBotId: WATCHER_BOT,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `hrr-watch-${process.pid}`,
          name: "Observadora",
        },
      });
      const quietWatcher = await suDb.agent.create({
        data: {
          tenantId,
          name: "Observadora silenciosa",
          mode: "test",
          enabled: true,
          systemPrompt: "Você observa.",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          settings: {},
        },
      });
      quietWatcherAgentDbId = quietWatcher.id;
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: quietWatcher.id,
          chatwootAgentBotId: QUIET_WATCHER_BOT,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `hrr-quiet-${process.pid}`,
          name: "Observadora silenciosa",
        },
      });
      for (const [chatwootInboxId, provider, boundAgent] of [
        [INBOX_ID, "baileys", agent.id],
        [ZAPI_INBOX_ID, "zapi", agent.id],
        [TEST_MODE_INBOX_ID, "baileys", testAgent.id],
        [UNANSWERED_INBOX_ID, "baileys", null],
        [WATCHED_INBOX_ID, "baileys", agent.id],
      ] as const) {
        await suDb.inbox.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootInboxId,
            name: `WhatsApp ${chatwootInboxId}`,
            provider,
            agentId: boundAgent,
          },
        });
      }
      // NOTE: A LIGAÇÃO QUE FAZ DE UMA ROTA A DO OBSERVADOR: é a linha de `inbox_observers` que
      // `observerRuntimeForRoute` exige antes de chamar uma rota de observada, e é por ela que uma
      // entrega encalhada ANTES da reivindicação (que não declarou papel) recupera o papel que teve.
      for (const [chatwootInboxId, observerAgentId] of [
        [TEST_MODE_INBOX_ID, watcher.id],
        [WATCHED_INBOX_ID, watcher.id],
        [UNANSWERED_INBOX_ID, quietWatcher.id],
      ] as const) {
        const inbox = await suDb.inbox.findFirstOrThrow({
          where: { tenantId, chatwootInboxId },
          select: { id: true },
        });
        await suDb.inboxObserver.create({
          data: {
            tenantId,
            inboxId: inbox.id,
            agentId: observerAgentId,
            // ANTERIOR ÀS ENTREGAS que este arquivo semeia (o `seedStranded` data cada uma em 40
            // minutos atrás). Uma ligação mais NOVA que a entrega não diz nada sobre a rota em que
            // ela chegou, e o produto a ignora de propósito — o que tem teste próprio abaixo.
            createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          },
        });
      }
    });

    afterAll(async () => {
      globalThis.fetch = realFetch;
      if (!dbUp) return;
      for (const table of [
        "execution_logs",
        "scheduler_jobs",
        "chatwoot_webhook_deliveries",
        "conversations",
        "contacts",
        "inbox_observers",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "chatwoot_instances",
        "chatwoot_deployments",
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

    // The row exactly as the receiver leaves it: the reply's shape and id written at INSERT, the
    // conversation mirrored, the delivery closed by the sweep.
    async function seedStranded(
      convId: number,
      over: {
        inboxId?: number;
        shape?: string | null;
        messageId?: number | null;
        contactInboxId?: number | null;
        // NOTE: Quem DETÉM a conversa no espelho. O default é o bot da inbox; um encalhe numa
        // conversa que o bot da ROTA ainda segura é o caso em que a ligação de observação não faz
        // dela uma rota de observador.
        assigneeId?: number;
        // Omitted = the mirror knows the conversation. `false` = it does not, which is what a delivery
        // that died before the mirror write leaves.
        mirrored?: boolean;
        // NOTE: The bot the delivery arrived on, as the claim recorded it, and whether that route
        // was a watcher's. Omitted = the inbox persona's, answering.
        routeAgentBotId?: number | null;
        // `null` é o que a coluna carrega numa entrega que morreu ANTES da reivindicação: papel não
        // declarado, que é um dos três vereditos pelos quais a varredura arma a recuperação.
        routeObserved?: boolean | null;
        // NOTE: The episode boundary a `/reset` left on the conversation, written as a SUCCESSFUL
        // clear leaves it: the command's own stamp plus the one the clearing transaction writes,
        // which is the one the fences read.
        resetAtMessageId?: number;
      } = {},
    ) {
      const messageId = over.messageId === undefined ? 700 : over.messageId;
      if (over.mirrored !== false) {
        const inbox = await suDb.inbox.findFirstOrThrow({
          where: { tenantId, chatwootInboxId: over.inboxId ?? INBOX_ID },
          select: { id: true },
        });
        await suDb.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: convId,
            status: "open",
            assigneeType: "AgentBot",
            assigneeId: over.assigneeId ?? OUR_BOT,
            inboxId: inbox.id,
            threadId: `chatwoot:${tenantId}:${instanceId}:${convId}`,
            lastEventAt: new Date(),
            contactInboxId:
              over.contactInboxId === undefined
                ? 91_000 + convId
                : over.contactInboxId,
            ...(over.resetAtMessageId === undefined
              ? {}
              : {
                  resetAtMessageId: over.resetAtMessageId,
                  memoryClearedAtMessageId: over.resetAtMessageId,
                }),
          },
        });
      }
      deliverySeq += 1;
      const row = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `hrr-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PROCESSED",
          receivedAt: new Date(Date.now() - 40 * 60 * 1000),
          conversationId: convId,
          humanReplyShape: over.shape === undefined ? "composer" : over.shape,
          humanReplyMessageId: messageId,
          // THE ROUTE THE CLAIM RECORDED. Defaulted from the inbox, so a fixture cannot quietly
          // describe a delivery claimed under one agent's bot on an inbox another agent answers.
          routeAgentBotId:
            over.routeAgentBotId === undefined
              ? (over.inboxId ?? INBOX_ID) === TEST_MODE_INBOX_ID
                ? TEST_BOT
                : OUR_BOT
              : over.routeAgentBotId,
          ...(over.routeObserved === undefined
            ? {}
            : { routeObserved: over.routeObserved }),
        },
        select: { id: true },
      });
      return row.id;
    }

    // Scoped to ONE conversation, because the rows are shared by the whole file: a helper that reads
    // every INGEST_MESSAGE row would make each test's "nothing was queued" depend on the tests before
    // it, which is exactly the assertion these negatives exist to make.
    async function ingestJobs(convId: number) {
      const rows = await suDb.schedulerJob.findMany({
        where: { tenantId, kind: "INGEST_MESSAGE" },
        select: { payload: true, payloadSecret: true, dedupeKey: true },
      });
      return rows
        .map((r) => ({
          dedupeKey: r.dedupeKey,
          payload: r.payload as Record<string, unknown>,
          text:
            r.payloadSecret === null
              ? null
              : decryptJson<string>(r.payloadSecret),
        }))
        .filter((r) => r.payload.conversationId === convId);
    }

    // PELA IDENTIDADE DO APPEND, e não pelo tamanho de uma população.
    // `ingest:<thread>:<messageId>` nomeia exatamente um append (src/graph/ingest-job.ts), e a chave
    // vem do construtor que o produto usa, em vez de remontada à mão. Uma negativa contada afirmaria
    // sobre um número que este módulo move de propósito (a linha é apagada ao concluir e
    // `drainPendingIngest` drena as pendentes da thread). A THREAD É A DO CONTACT-INBOX
    // (`91_000 + convId`, o `seedStranded` acima): montada com a da CONVERSA, a pergunta responderia
    // "não armada" para tudo e as negativas passariam por construção.
    function threadOf(convId: number) {
      return contactInboxThreadId(tenantId, instanceId, 91_000 + convId);
    }

    async function ingestArmedOn(graphThreadId: string, messageId: number) {
      return (
        (await suDb.schedulerJob.findFirst({
          where: {
            tenantId,
            kind: "INGEST_MESSAGE",
            dedupeKey: ingestDedupeKey(graphThreadId, messageId),
          },
          select: { id: true },
        })) !== null
      );
    }

    async function ingestArmedFor(convId: number, messageId: number) {
      return ingestArmedOn(threadOf(convId), messageId);
    }

    // O INSTRUMENTO ANTES DO PRIMEIRO CENÁRIO. Treze testes deste arquivo provam uma AUSÊNCIA com
    // esta pergunta, e uma pergunta errada responde "não armada" para tudo: o verde delas seria a
    // chave não casar, não a ausência do append. Aqui a chave é plantada de propósito nas duas
    // grafias que o arquivo usa, e o que se afirma é que a pergunta ACHA o que existe e não acha o
    // vizinho de id.
    test("the question the negatives ask fires on a row that exists", async () => {
      const convId = 9199;
      for (const threadId of [
        threadOf(convId),
        chatwootThreadId(tenantId, instanceId, convId),
      ]) {
        await suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "INGEST_MESSAGE",
            dedupeKey: ingestDedupeKey(threadId, 799),
            payload: { conversationId: convId, messageId: 799 },
            runAt: new Date(),
          },
        });
        expect(await ingestArmedOn(threadId, 799)).toBe(true);
        expect(await ingestArmedOn(threadId, 798)).toBe(false);
      }
      expect(await ingestArmedFor(convId, 799)).toBe(true);
    });

    // NOTE: A resposta se perdeu porque o enfileiramento estava fora do ar, e a varredura arma a
    // releitura: a mensagem é lida de volta pelo id que a linha guarda, e o append é armado com o
    // PAPEL certo, `human_agent`, que põe a resposta em `recent_agent_message_ids` em vez de fingir
    // que o cliente a escreveu. A resposta é datada com o instante que o Chatwoot registrou, que
    // viaja com o append para o modelo saber quando o atendente a disse.
    test("the recovered reply carries the instant Chatwoot recorded for it", async () => {
      const convId = 9755;
      pages.set(convId, [
        {
          ...restComposerReply(700, "Seu contrato segue em anexo."),
          created_at: 1_789_563_900,
        },
      ]);
      const rowId = await seedStranded(convId);
      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("remembered");
      const jobs = await ingestJobs(convId);
      expect(jobs[0]?.payload.sentAt).toBe(
        new Date(1_789_563_900 * 1000).toISOString(),
      );
    });

    test("the lost reply is read back by id and queued for the contact's memory", async () => {
      const convId = 9101;
      pages.set(convId, [
        restComposerReply(700, "Mando o contrato ainda hoje."),
      ]);
      const rowId = await seedStranded(convId);

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("remembered");

      const jobs = await ingestJobs(convId);
      // BY THE APPEND'S OWN IDENTITY, not by how many rows came back: `ingest:<thread>:<messageId>`
      // names exactly one append (../../src/graph/ingest-job.ts), so this says "the ingestion of
      // THIS message is queued" instead of "one more job than before exists", which would keep
      // agreeing with itself if a neighbour armed the wrong message on the same conversation.
      expect(jobs.map((j) => j.dedupeKey)).toEqual([
        ingestDedupeKey(threadOf(convId), 700),
      ]);
      expect(jobs[0]?.payload.role).toBe("human_agent");
      expect(jobs[0]?.payload.messageId).toBe(700);
      expect(jobs[0]?.text).toContain("Mando o contrato ainda hoje.");
      // The thread the append lands on is the CONTACT-INBOX's, which is what the memory is keyed by.
      // The conversation's own thread id is a DIFFERENT thread (`resolveGraphThreadId` falls back to
      // it when no contact-inbox is known), so a recovery that keyed by it would write the reply
      // into a memory no later turn reads — a green run with the words still missing.
      expect(jobs[0]?.payload.contactInboxId).toBe(91_000 + convId);
      expect(jobs[0]?.payload.graphThreadId).toBe(
        `${tenantId}:${instanceId}:ci:${91_000 + convId}`,
      );
      // NOTE: AND NOTHING WAS WRITTEN TO THE CONVERSATION. Recovering the memory is not recovering
      // the handover: a conversation an operator handed back to the bot in the meantime must not be
      // taken away again to close a memory gap. The takeover has a recovery of its own.
      expect(calls.filter((c) => c.url.includes("toggle_status"))).toEqual([]);
    });

    // NOTE: A ARMADILHA MAIS CARA. Num provedor que não reserva os ids do eco, a nossa própria
    // resposta volta como um `message_created` sem sender e com `external_sender_name`, byte a byte
    // a forma `device` que um colega digitando no telefone pareado produz. A linha guarda a FORMA,
    // então ancorar nela sem re-perguntar ao provedor arquivaria a fala do próprio agente na memória
    // do contato como se um atendente humano a tivesse escrito.
    test("our own echo on an unreserved provider is never folded into memory", async () => {
      const convId = 9102;
      pages.set(convId, [restDeviceReply(701, "Posso ajudar em algo mais?")]);
      const rowId = await seedStranded(convId, {
        inboxId: ZAPI_INBOX_ID,
        shape: "device",
        messageId: 701,
      });
      const before = calls.length;

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");

      expect(await ingestArmedFor(convId, 701)).toBe(false);
      // E RECUSADO ANTES DA REDE, que é o outro lado da mesma decisão: a rota resolvida não depende de
      // nada que só a mensagem diga, então ler a página primeiro custaria uma ida ao Chatwoot por eco,
      // em toda instalação com um provedor desses.
      expect(calls.slice(before)).toEqual([]);
    });

    // E A MESMA FORMA NUM PROVEDOR QUE RESERVA OS IDS É UMA PESSOA, que é a outra metade da fronteira:
    // ali o eco tem id nosso e não chega aqui, então uma `device` é o colega digitando no telefone.
    test("the same shape on a reserving provider is a colleague at the paired phone", async () => {
      const convId = 9103;
      pages.set(convId, [restDeviceReply(702, "Já estou indo aí.")]);
      const rowId = await seedStranded(convId, {
        shape: "device",
        messageId: 702,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("remembered");
      const jobs = await ingestJobs(convId);
      expect(jobs.map((j) => j.payload.messageId)).toContain(702);
    });

    // A ROTA QUE NÃO LEMBRA NADA NÃO PERDEU NADA (a ressalva que a coluna não resolve). Uma inbox em
    // modo `test` deixa `route_remembers = false` na linha, que é EXATAMENTE a assinatura de uma
    // ingestão que falhou. Nada na linha separa as duas histórias, então a pergunta não é feita à
    // linha: é feita ao agente, agora, do jeito que o receptor a faz.
    test("a route that remembers nothing is not a loss to recover", async () => {
      const convId = 9104;
      pages.set(convId, [restComposerReply(703, "Testando por aqui.")]);
      const rowId = await seedStranded(convId, {
        inboxId: TEST_MODE_INBOX_ID,
        messageId: 703,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(await ingestArmedFor(convId, 703)).toBe(false);
    });

    // A PERDA PERMANENTE NÃO VIRA REARME. Uma conversa que nem o payload nem o espelho sabem nomear um
    // contact-inbox não tem onde guardar a resposta: o receptor já relatou isso como a perda definitiva
    // que é, e uma recuperação armada mesmo assim não tem por onde chavear o thread.
    test("a conversation with no contact-inbox thread is not retried forever", async () => {
      const convId = 9105;
      pages.set(convId, [restComposerReply(704, "Te mando por aqui.")]);
      const rowId = await seedStranded(convId, {
        messageId: 704,
        contactInboxId: null,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(
        await ingestArmedOn(
          chatwootThreadId(tenantId, instanceId, convId),
          704,
        ),
      ).toBe(false);
    });

    // A CERCA DA LEITURA DEGRADADA, que espelha a `rebuiltInbound` da recuperação vizinha. A linha é a
    // prova de que aquilo FOI resposta de colega; uma releitura que volta como outra coisa descreve uma
    // resposta REST que perdeu um campo — um `message_type` ausente normaliza para "other" —, e passar
    // isso adiante appenda na memória permanente do contato palavras que ninguém escreveu.
    test("a degraded REST read is refused instead of appended", async () => {
      const convId = 9106;
      pages.set(convId, [
        { ...restComposerReply(705, "Confirmado."), message_type: undefined },
      ]);
      const rowId = await seedStranded(convId, { messageId: 705 });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("unreachable");
      expect(await ingestArmedFor(convId, 705)).toBe(false);
    });

    // A MENSAGEM QUE O CHATWOOT NÃO TEM MAIS é um veredito, não uma falha: apagada, ou a conversa foi.
    // Nenhuma tentativa muda isso, e insistir gastaria a escada até a dead-letter sobre nada.
    test("a message Chatwoot no longer has is a verdict, not a retry", async () => {
      const convId = 9107;
      pages.set(convId, [restComposerReply(999, "Outra mensagem qualquer.")]);
      const rowId = await seedStranded(convId, { messageId: 706 });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(await ingestArmedFor(convId, 706)).toBe(false);
    });

    // A CONTA QUE NÃO RESPONDE É ADIAMENTO. Reparável por um operador, e a próxima tentativa pode ter
    // outra resposta — ao contrário de todo veredito acima, que pergunta as mesmas linhas a mesma coisa.
    test("an account that cannot be read is a deferral", async () => {
      const convId = 9108;
      failingReads.add(convId);
      const rowId = await seedStranded(convId, { messageId: 707 });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("unreachable");
      expect(await ingestArmedFor(convId, 707)).toBe(false);
    });

    // NOTE: E A CONTA QUE RESPONDE 200 COM ALGO QUE NÃO É UMA PÁGINA também é adiamento. As duas
    // formas que o Chatwoot responde são um array e `{ payload: [...] }`; um corpo vazio, um `{}` ou
    // um objeto de erro com 200 é resposta que esta leitura não sabe ler, e lê-la como página VAZIA
    // faria de uma conta degradada um veredito: a mensagem "apagada" e a linha liquidada para sempre.
    test("an account answering with something that is not a page is a deferral", async () => {
      const convId = 9137;
      unusableReads.add(convId);
      const rowId = await seedStranded(convId, { messageId: 735 });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("unreachable");
      expect(await ingestArmedFor(convId, 735)).toBe(false);
    });

    // E A PÁGINA VÁLIDA QUE NÃO TRAZ A MENSAGEM continua sendo veredito, que é a outra metade do par:
    // o Chatwoot não tem mais aquela mensagem, e nenhuma tentativa muda isso.
    // O ESPELHO QUE AINDA NÃO CONHECE A CONVERSA não é veredito: uma entrega que morreu antes da
    // escrita do espelho não deixa linha, e o próximo evento naquela conversa cria uma.
    test("a conversation the mirror has never seen is retried, not discarded", async () => {
      const convId = 9109;
      const rowId = await seedStranded(convId, {
        messageId: 708,
        mirrored: false,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("unresolved");
    });

    // NOTE: E A LINHA QUE NÃO NOMEIA RESPOSTA NENHUMA não ganha recuperação por estar encalhada.
    // Reler toda linha de `message_created` parada varreria para dentro a saída do nosso próprio
    // bot, a nota privada e a reação, as três coisas que `human_reply_message_id` fica NULO para
    // manter fora por construção.
    test("a row that names no reply gets no recovery", async () => {
      const convId = 9110;
      pages.set(convId, [restComposerReply(709, "não deveria ser lido")]);
      const rowId = await seedStranded(convId, {
        messageId: null,
        shape: null,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(await ingestArmedFor(convId, 709)).toBe(false);
    });

    // NOTE: A ROTA DA ENTREGA DECIDE DE QUEM É A MEMÓRIA, não a inbox. O Chatwoot entrega a mesma
    // mensagem ao bot da inbox E ao observador ligado nela, então um encalhe pode ser de qualquer uma
    // das duas rotas, e só a linha diz qual. Lida como a do respondedor, a perda do observador seria
    // descartada sempre que o respondedor estivesse em `test` ou desligado, em silêncio e para
    // sempre, porque nada revisita a linha.
    test("a watcher's lost append is recovered under the watcher, not the inbox's responder", async () => {
      const convId = 9114;
      pages.set(convId, [restComposerReply(713, "Já separei o seu pedido.")]);
      const rowId = await seedStranded(convId, {
        inboxId: TEST_MODE_INBOX_ID,
        messageId: 713,
        routeAgentBotId: WATCHER_BOT,
        routeObserved: true,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("remembered");
      const jobs = await ingestJobs(convId);
      // E SOB O AGENTE DA ROTA: o append armado sob o respondedor iria para a compactação e para a
      // contabilidade do agente errado.
      expect(jobs[0]?.payload.agentId).toBe(String(watcherAgentDbId));
      // E O MODO DO OBSERVADOR NÃO FOI PERGUNTADO: `monitoring` não é `production`, e uma cerca que
      // exigisse produção aqui recusaria exatamente a rota que devia o append.
      expect(jobs[0]?.payload.messageId).toBe(713);
    });

    // NOTE: COM MAIS DE UM OBSERVADOR, A MEMÓRIA É DO PRIMEIRO DELES, nas duas pontas: o caminho ao
    // vivo arquiva sob o primeiro, e a recuperação do encalhe de um observador posterior arma o mesmo
    // job da thread. Arquivada sob a rota, a ordem das recuperações decidiria a compactação.
    test("beside another watcher, a later watcher's lost append is filed under the first watcher", async () => {
      const SECOND_WATCHER_BOT = 39;
      const second = await suDb.agent.create({
        data: {
          tenantId,
          name: "Segunda observadora",
          mode: "monitoring",
          enabled: true,
          systemPrompt: "Você observa.",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          settings: { memory: { compaction: { enabled: false } } },
        },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: second.id,
          chatwootAgentBotId: SECOND_WATCHER_BOT,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `hrr-second-${process.pid}`,
          name: "Segunda observadora",
        },
      });
      const inbox = await suDb.inbox.findFirstOrThrow({
        where: { tenantId, chatwootInboxId: TEST_MODE_INBOX_ID },
        select: { id: true },
      });
      await suDb.inboxObserver.create({
        data: {
          tenantId,
          inboxId: inbox.id,
          agentId: second.id,
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        },
      });
      try {
        expect(second.id > watcherAgentDbId).toBe(true);
        const convId = 9177;
        pages.set(convId, [restComposerReply(7916, "Já confirmei a troca.")]);
        const rowId = await seedStranded(convId, {
          inboxId: TEST_MODE_INBOX_ID,
          messageId: 7916,
          routeAgentBotId: SECOND_WATCHER_BOT,
          routeObserved: true,
        });
        expect(
          await recoverStrandedHumanReply({
            tenantId,
            deliveryRowId: rowId,
            base: appDb,
            makeClient,
          }),
        ).toBe("remembered");
        const jobs = await ingestJobs(convId);
        expect(jobs[0]?.payload.agentId).toBe(String(watcherAgentDbId));
        expect(jobs[0]?.payload.compactionEnabled).toBe(true);
      } finally {
        await suDb.inboxObserver.deleteMany({
          where: { tenantId, inboxId: inbox.id, agentId: second.id },
        });
      }
    });

    // NOTE: O PAPEL QUE A LINHA NÃO DECLAROU SE RECUPERA DA LIGAÇÃO. `route_observed` é escrito pela
    // reivindicação, então uma entrega que encalhou ANTES dela carrega NULO, e `role-unstated` é um
    // dos três vereditos pelos quais a varredura arma esta recuperação: um terço do trabalho de
    // entrada, não caso de borda. Lido como `false`, o append perdido de um observador ao lado de um
    // respondedor em `test` seria descartado no portão do respondedor, para sempre.
    test("an unstated role is recovered from the observer binding, not read as the responder's", async () => {
      const convId = 9131;
      pages.set(convId, [restComposerReply(728, "Anotado, já encaminhei.")]);
      const rowId = await seedStranded(convId, {
        inboxId: TEST_MODE_INBOX_ID,
        messageId: 728,
        routeAgentBotId: WATCHER_BOT,
        // A entrega morreu antes da reivindicação: o papel não foi declarado.
        routeObserved: null,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("remembered");
      const jobs = await ingestJobs(convId);
      expect(jobs[0]?.payload.agentId).toBe(String(watcherAgentDbId));
      expect(jobs[0]?.payload.messageId).toBe(728);
    });

    // NOTE: E SEGURAR A CONVERSA ENCERRA A PERGUNTA, com linha de observação ou sem ela. O fork
    // entrega também ao bot ATRIBUÍDO da conversa, e um agente que respondia esta inbox continua
    // segurando o que lhe foi atribuído, inclusive depois de virar observador.
    // `observerRuntimeForRoute` recusa chamar essa rota de observadora sempre que a inbox tem
    // respondedor próprio; recuperada como do observador, ela folhearia memória numa rota que o
    // caminho ao vivo resolve para o respondedor da inbox, em `test`, que não lembra nada.
    test("a conversation the route's own bot holds is not an observer's route", async () => {
      const convId = 9136;
      pages.set(convId, [
        restComposerReply(734, "Ninguém devia lembrar disto."),
      ]);
      const rowId = await seedStranded(convId, {
        inboxId: TEST_MODE_INBOX_ID,
        messageId: 734,
        routeAgentBotId: WATCHER_BOT,
        routeObserved: null,
        // O próprio bot da rota segura a conversa.
        assigneeId: WATCHER_BOT,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(await ingestArmedFor(convId, 734)).toBe(false);
    });

    // NOTE: E A LIGAÇÃO MAIS NOVA QUE A ENTREGA NÃO É EVIDÊNCIA, a mesma regra que o subsistema já
    // escreve para a outra evidência a posteriori: "bot equality is evidence about the role only
    // while the binding is OLDER than the delivery". Um agente anexado como observador DEPOIS de a
    // mensagem chegar não diz nada sobre a rota em que ela chegou, e a varredura roda meia hora
    // depois, então essa janela é real.
    test("an observer binding younger than the delivery is not evidence of the role", async () => {
      const convId = 9133;
      const LATE_INBOX_ID = 96;
      pages.set(convId, [restComposerReply(731, "Chegou antes da ligação.")]);
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: LATE_INBOX_ID,
          name: `WhatsApp ${LATE_INBOX_ID}`,
          provider: "baileys",
          agentId: testAgentDbId,
        },
        select: { id: true },
      });
      // A ligação nasce AGORA; a entrega é de quarenta minutos atrás.
      await suDb.inboxObserver.create({
        data: { tenantId, inboxId: inbox.id, agentId: watcherAgentDbId },
      });
      const rowId = await seedStranded(convId, {
        inboxId: LATE_INBOX_ID,
        messageId: 731,
        routeAgentBotId: WATCHER_BOT,
        routeObserved: null,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(await ingestArmedFor(convId, 731)).toBe(false);
    });

    // NOTE: E O ESPELHO QUE CONHECE A CONVERSA E NÃO A INBOX É UM TERCEIRO ESTADO. Um evento cujo
    // payload não nomeia inbox cria a linha com `inbox_id` nulo, e um evento posterior a preenche.
    // Dobrado no "sem rota" do vizinho, isso viraria `not-owed`: terminal, com a resposta nunca
    // relida, num espelho que o Chatwoot completaria um minuto depois.
    test("a mirrored conversation with no inbox yet is retried, not discarded", async () => {
      const convId = 9134;
      pages.set(convId, [restComposerReply(732, "O espelho ainda não sabe.")]);
      const rowId = await seedStranded(convId, { messageId: 732 });
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: convId },
        data: { inboxId: null },
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("unresolved");
      expect(await ingestArmedFor(convId, 732)).toBe(false);
    });

    // NOTE: E O CONTROLE DA MESMA PERGUNTA: o mesmo nulo, o mesmo respondedor em `test`, e um bot
    // que NÃO observa esta inbox. Aí não há observador a quem a perda pertença, a rota é a do
    // respondedor, e o veredito volta a ser `not-owed`. Sem este par, a regra acima passaria também
    // se simplesmente não perguntasse o modo.
    test("an unstated role with no observer binding stays the responder's", async () => {
      const convId = 9132;
      pages.set(convId, [restComposerReply(729, "Ninguém devia isto.")]);
      const rowId = await seedStranded(convId, {
        inboxId: TEST_MODE_INBOX_ID,
        messageId: 729,
        // O bot do observador SILENCIOSO, ligado a outra inbox.
        routeAgentBotId: QUIET_WATCHER_BOT,
        routeObserved: null,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(await ingestArmedFor(convId, 729)).toBe(false);
    });

    // NOTE: E O MODO DO OBSERVADOR NÃO É PERGUNTADO, que é o que separa a leitura certa da errada. O
    // receptor decide a rota do observador pela LINHA dele e pergunta só o interruptor, então um
    // observador cujo agente está em `test` folheia a resposta na entrega. Lido pelo modo, o append
    // dele nunca seria recuperado.
    test("a watcher whose own agent is in test mode still had its append owed", async () => {
      const convId = 9118;
      pages.set(convId, [restComposerReply(716, "Anotei o pedido dela.")]);
      const rowId = await seedStranded(convId, {
        inboxId: WATCHED_INBOX_ID,
        messageId: 716,
        routeAgentBotId: QUIET_WATCHER_BOT,
        routeObserved: true,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("remembered");
      // NOTE: SOB O RESPONDEDOR DA INBOX, e não sob o observador: a thread é a dele, ele recebeu a
      // mensagem e guarda continuamente. O que este teste protege é o append ser devido apesar do
      // modo do observador; de quem é o resumo é a outra pergunta, e a resposta é o dono.
      expect((await ingestJobs(convId))[0]?.payload.agentId).toBe(
        String(agentDbId),
      );
    });

    // NOTE: E O OBSERVADOR SEM RESPONDEDOR NÃO PERDEU NADA, a outra metade da mesma condição: numa
    // inbox que ninguém nosso atende não há memória de respondedor para o observador dividir, então
    // a entrega nunca ingeriu e não há o que recuperar.
    test("a watcher with no responder beside it has nothing to recover", async () => {
      const convId = 9115;
      pages.set(convId, [restComposerReply(714, "Ninguém lembra disto.")]);
      const rowId = await seedStranded(convId, {
        inboxId: UNANSWERED_INBOX_ID,
        messageId: 714,
        routeAgentBotId: WATCHER_BOT,
        routeObserved: true,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(await ingestArmedFor(convId, 714)).toBe(false);
    });

    // NOTE: E O COMANDO QUE NÃO CONSEGUIU LIMPAR NÃO RECUSA NADA: o carimbo do comando é commitado
    // por um statement anterior e independente, e o passo da memória recusa por desenho quando um
    // turno já escreve a thread. A cerca lê a coluna que a transação da limpeza escreve, então a
    // resposta encalhada volta para uma memória que ninguém esvaziou.
    test("a /reset whose memory step failed does not discard the stranded reply", async () => {
      const convId = 9135;
      pages.set(convId, [restComposerReply(733, "Ninguém apagou isto.")]);
      const rowId = await seedStranded(convId, { messageId: 733 });
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: convId },
        // Só o carimbo do COMANDO: a limpeza recusou.
        data: { resetAtMessageId: 740 },
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("remembered");
      expect(await ingestArmedFor(convId, 733)).toBe(true);
    });

    // NOTE: A ÚNICA RECUSA AQUI QUE PROTEGE CONTRA DANO ATIVO, e não contra trabalho perdido. O
    // `/reset` limpa a memória e, na mesma seção crítica, revoga todo `INGEST_MESSAGE` da thread,
    // porque um append com texto de antes reconstruiria o que o operador mandou apagar. Ele não
    // revoga ESTE job (um kind próprio, armado antes do comando e rodando depois), e apagar a thread
    // leva junto a dedup do append, então nada rio abaixo pegaria a duplicata.
    test("a reply cleared by a /reset is not restored into the cleared memory", async () => {
      const convId = 9116;
      pages.set(convId, [restComposerReply(715, "Texto de antes do reset.")]);
      const rowId = await seedStranded(convId, {
        messageId: 715,
        resetAtMessageId: 720,
      });
      const before = calls.length;

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(await ingestArmedFor(convId, 715)).toBe(false);
      // E SEM IR AO CHATWOOT: numa conversa já limpa, a leitura da página é uma chamada por resposta
      // encalhada de um episódio inteiro, e a resposta não depende de nada que só a mensagem diga.
      expect(calls.slice(before)).toEqual([]);
    });

    // O RESET QUE CHEGA DURANTE A LEITURA, que é a única janela que a segunda pergunta enxerga. A
    // primeira é feita antes de uma ida ao Chatwoot, e um `/reset` dentro daquela ida deixa a
    // decisão apoiada num estado que já não existe — a memória foi limpa e os `INGEST_MESSAGE`
    // revogados, e este append entraria depois de tudo isso.
    test("a /reset that lands during the REST read still stops the append", async () => {
      const convId = 9119;
      pages.set(convId, [restComposerReply(717, "Texto que o reset alcança.")]);
      const rowId = await seedStranded(convId, { messageId: 717 });
      resetDuringRead.set(convId, async () => {
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: convId },
          data: {
            resetAtMessageId: 719,
            memoryClearedAtMessageId: 719,
          },
        });
      });

      try {
        expect(
          await recoverStrandedHumanReply({
            tenantId,
            deliveryRowId: rowId,
            base: appDb,
            makeClient,
          }),
        ).toBe("not-owed");
        expect(await ingestArmedFor(convId, 717)).toBe(false);
      } finally {
        resetDuringRead.delete(convId);
      }
    });

    // E A FRONTEIRA É ORDENADA, não um interruptor: uma resposta ACIMA da marca é do episódio novo
    // e continua sendo recuperada. Uma cerca que recusasse toda conversa já resetada alguma vez
    // trocaria um defeito pelo outro.
    test("a reply newer than the reset boundary is still recovered", async () => {
      const convId = 9117;
      pages.set(convId, [restComposerReply(730, "Texto depois do reset.")]);
      const rowId = await seedStranded(convId, {
        messageId: 730,
        resetAtMessageId: 720,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("remembered");
      expect((await ingestJobs(convId))[0]?.payload.messageId).toBe(730);
    });

    // NOTE: O RESET É DA THREAD, NÃO DA CONVERSA. O `/reset` limpa a memória por CONTACT-INBOX
    // (`agent_threads` e os resumos chaveados por ela) e carimba `reset_at_message_id` só na
    // conversa em que o comando foi digitado. Duas conversas do mesmo contato no mesmo canal
    // dividem uma thread, então um reset na mais NOVA apaga a memória da resposta encalhada da
    // antiga sem carimbá-la; perguntando só à conversa da resposta, a cerca restauraria texto de
    // antes da limpeza numa thread cuja dedup foi apagada junto.
    test("a /reset in a sibling conversation of the same thread still stops the append", async () => {
      const convId = 9121;
      const siblingId = 9122;
      pages.set(convId, [restComposerReply(724, "Texto de antes da limpeza.")]);
      const rowId = await seedStranded(convId, { messageId: 724 });
      // A irmã: outra conversa, o MESMO contact-inbox, e é nela que o operador digitou o comando.
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: siblingId,
          status: "open",
          assigneeType: "AgentBot",
          assigneeId: OUR_BOT,
          inboxId: (
            await suDb.inbox.findFirstOrThrow({
              where: { tenantId, chatwootInboxId: INBOX_ID },
              select: { id: true },
            })
          ).id,
          threadId: `chatwoot:${tenantId}:${instanceId}:${siblingId}`,
          lastEventAt: new Date(),
          contactInboxId: 91_000 + convId,
          resetAtMessageId: 726,
          memoryClearedAtMessageId: 726,
        },
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(await ingestArmedFor(convId, 724)).toBe(false);
    });

    // NOTE: O APPEND QUE JÁ NÃO PODE POUSAR DIZ ISSO. A thread lembra os últimos `INGEST_ID_WINDOW`
    // ids por direção e, com a janela SATURADA, um id abaixo do piso é `ancient`:
    // `ingestMessageIntoThread` recusa com SUCESSO, o job completa e as palavras ficam ausentes com
    // tudo dizendo que a recuperação funcionou. O desfecho relata INCERTEZA, não perda: o mesmo
    // estado sai de uma entrega que armou a ingestão e morreu antes de liquidar, depois de 64
    // mensagens de atendente, e nenhum banco separa os dois; relatado como perda, mandaria um
    // operador redigitar palavras que podem já estar lá.
    test("a reply older than the thread's whole memory is reported as undecidable, not as lost", async () => {
      const convId = 9123;
      pages.set(convId, [restComposerReply(700, "Velha demais para voltar.")]);
      const rowId = await seedStranded(convId, { messageId: 700 });
      // A janela cheia, toda acima do id perdido: é a forma que 64 respostas de atendente na mesma
      // contact-inbox deixam enquanto a linha esperava pela varredura.
      await suDb.agentThread.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: 91_000 + convId,
          threadId: `${tenantId}:${instanceId}:ci:${91_000 + convId}`,
          recentAgentMessageIds: Array.from({ length: 64 }, (_, i) => 900 + i),
        },
      });

      const before = calls.length;
      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("undecided");
      expect(await ingestArmedFor(convId, 700)).toBe(false);
      // E NUM REGISTRO QUE UM OPERADOR CONSULTA, não numa linha de log de processo. Sem isto,
      // a única linha nomeando esta mensagem seria `human_reply_not_remembered`, escrita pelo
      // receptor no instante da perda, cuja razão diz o OPOSTO do que é verdade agora: que a perda é
      // transitória e que uma retentativa vem aí.
      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: convId },
        select: { id: true },
      });
      const linhas = await flowLogRows(suDb, {
        where: { tenantId, conversationId: conv.id, stage: "memory" },
        select: { level: true, detail: true },
      });
      expect(
        linhas.map((l) => ({
          level: l.level,
          reason: (l.detail as { reason?: string } | null)?.reason ?? null,
        })),
      ).toEqual([
        { level: "error", reason: "human_reply_recovery_undecidable" },
      ]);
      // E SEM IR AO CHATWOOT: a janela é lida antes da rede, e `ancient` é um dos dois desfechos que
      // uma varredura de backlog produz em massa.
      expect(calls.slice(before)).toEqual([]);
    });

    // E A QUE JÁ ESTÁ NA MEMÓRIA NÃO GASTA JOB NENHUM, que é a outra ponta da mesma leitura: uma
    // linha que encalhou DEPOIS de o append ter pousado não perdeu nada, e armar a ingestão dela
    // seria pagar um job para o `ingestVerdict` recusar do outro lado.
    test("a reply already in the thread's memory is not queued again", async () => {
      const convId = 9124;
      pages.set(convId, [restComposerReply(725, "Esta já entrou.")]);
      const rowId = await seedStranded(convId, { messageId: 725 });
      await suDb.agentThread.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: 91_000 + convId,
          threadId: `${tenantId}:${instanceId}:ci:${91_000 + convId}`,
          recentAgentMessageIds: [725],
        },
      });
      const before = calls.length;

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("not-owed");
      expect(await ingestArmedFor(convId, 725)).toBe(false);
      // Nem esta: a resposta já está na memória e a página não decide nada disso.
      expect(calls.slice(before)).toEqual([]);
    });

    // NOTE: UMA RAJADA, E AS TRÊS VOLTAM. Uma pessoa manda três mensagens seguidas com o scheduler
    // fora do ar para as três. Uma recuperação chaveada pela CONVERSA, ou pela thread, recuperaria
    // uma e liquidaria as outras duas em silêncio. O que impede isso é a linha do ledger ser por
    // ENTREGA e nomear UMA mensagem, e o append ser chaveado por `ingest:<thread>:<messageId>`, que
    // nomeia um append e não uma conversa.
    test("a burst of three lost replies comes back as three appends", async () => {
      const convId = 9120;
      const ids = [721, 722, 723];
      pages.set(
        convId,
        ids.map((id) => restComposerReply(id, `parte ${id} da resposta`)),
      );
      const rows = [];
      for (const [i, id] of ids.entries()) {
        // A conversa é uma só e as linhas são três, que é a forma da rajada: `mirrored: false` a
        // partir da segunda diz ao seed para não recriar o espelho, não que ele não exista.
        rows.push(
          await seedStranded(convId, {
            messageId: id,
            ...(i === 0 ? {} : { mirrored: false }),
          }),
        );
      }

      for (const rowId of rows) {
        expect(
          await recoverStrandedHumanReply({
            tenantId,
            deliveryRowId: rowId,
            base: appDb,
            makeClient,
          }),
        ).toBe("remembered");
      }

      const jobs = await ingestJobs(convId);
      // TRÊS APPENDS DISTINTOS, nomeados pelas três mensagens: uma chave por conversa deixaria um
      // job só, com o texto do último a escrever, e os outros dois sumiriam sem erro nenhum.
      expect(jobs.map((j) => j.payload.messageId).sort()).toEqual(ids);
      expect(new Set(jobs.map((j) => j.dedupeKey)).size).toBe(3);
      expect(jobs.map((j) => j.text).sort()).toEqual(
        ids.map((id) => `parte ${id} da resposta`),
      );
    });

    // NOTE: E A ROTA DO RESPONDEDOR RESOLVE PELA INBOX, NÃO PELO BOT. As duas rotas do receptor não
    // são simétricas: `responder` sai de `inboxAgentRuntime(…, n.inboxId, …)` e `watcher` de
    // `observerRuntimeForRoute(…, params.agentBotId, …)`. O Chatwoot entrega a mensagem ao bot
    // ATRIBUÍDO à conversa e ao da inbox, então numa conversa mantida pelo bot de outra persona o
    // `route_agent_bot_id` nomeia aquela persona enquanto a ingestão correu sob o respondedor da
    // inbox. Perguntando pelo bot, um agente atribuído em `test` descartaria um append que o
    // respondedor em produção devia.
    test("a responder route resolves through the inbox, not the assigned bot", async () => {
      const convId = 9126;
      pages.set(convId, [
        restComposerReply(727, "Sob o respondedor da inbox."),
      ]);
      const rowId = await seedStranded(convId, {
        messageId: 727,
        // A inbox é a 70 (respondedor em produção); o bot que trouxe a entrega é o do agente em
        // `test`, que é o que uma conversa mantida por outra persona produz. A rota NÃO é observada.
        routeAgentBotId: TEST_BOT,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: rowId,
          base: appDb,
          makeClient,
        }),
      ).toBe("remembered");
      // Sob o agente da INBOX, e não sob o do bot atribuído.
      expect((await ingestJobs(convId))[0]?.payload.agentId).toBe(
        String(agentDbId),
      );
    });

    // NOTE: DUAS ROTAS, UMA MENSAGEM, UM APPEND. Uma resposta perdida numa inbox observada deixa
    // DUAS linhas de ledger com o mesmo id, e a varredura arma uma recuperação para cada; o que
    // impede o dobro é a chave `ingest:<thread>:<messageId>` (thread do contact-inbox) com
    // `rearm: "same-work"`, uma linha viva por chave. O re-arme SUBSTITUI o payload, então
    // `agentId` e `compactionEnabled` são os da última recuperação a escrever: o pior caso é um
    // resumo não armado naquele fechamento (`armCompaction` é o único consumidor do `agentId`), não
    // uma palavra perdida. O mecanismo é o mesmo do receptor ao vivo, e mudá-lo só aqui divergiria
    // dele.
    test("two ledger rows for one message produce one append", async () => {
      const convId = 9125;
      pages.set(convId, [restComposerReply(726, "Uma resposta, duas rotas.")]);
      const respondedora = await seedStranded(convId, {
        inboxId: WATCHED_INBOX_ID,
        messageId: 726,
      });
      const observadora = await seedStranded(convId, {
        inboxId: WATCHED_INBOX_ID,
        messageId: 726,
        mirrored: false,
        routeAgentBotId: QUIET_WATCHER_BOT,
        routeObserved: true,
      });

      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: respondedora,
          base: appDb,
          makeClient,
        }),
      ).toBe("remembered");
      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: observadora,
          base: appDb,
          makeClient,
        }),
      ).toBe("remembered");

      // UM append, não dois: a chave é da mensagem e não da entrega.
      const jobs = await ingestJobs(convId);
      expect(jobs.map((j) => j.dedupeKey)).toEqual([
        `ingest:${tenantId}:${instanceId}:ci:${91_000 + convId}:726`,
      ]);
      // E o texto é o mesmo pelas duas rotas, que é o que faz a substituição ser inofensiva para o
      // conteúdo: cada recuperação relê a mesma mensagem e renderiza com o mesmo renderizador.
      expect(jobs[0]?.text).toContain("Uma resposta, duas rotas.");
      // NOTE: E O AGENTE TAMBÉM: a thread é a do respondedor, que recebeu a mensagem e guarda
      // continuamente, então as duas linhas armam sob ele, e a última a armar não decide nada.
      expect(jobs[0]?.payload.agentId).toBe(String(agentDbId));
    });

    // NOTE: A ORDEM INVERSA: a linha do observador é recuperada primeiro. O payload já nasce sob o
    // respondedor, e o arme do respondedor que vem depois o repete em vez de trocá-lo.
    test("two ledger rows armed observer first are still filed under the responder", async () => {
      const convId = 9171;
      pages.set(convId, [restComposerReply(771, "A outra ordem.")]);
      const respondedora = await seedStranded(convId, {
        inboxId: WATCHED_INBOX_ID,
        messageId: 771,
      });
      const observadora = await seedStranded(convId, {
        inboxId: WATCHED_INBOX_ID,
        messageId: 771,
        mirrored: false,
        routeAgentBotId: QUIET_WATCHER_BOT,
        routeObserved: true,
      });

      // A COMPACTAÇÃO TAMBÉM É A DO DONO: o respondedor a tem desligada e o observador ligada, e o
      // que o payload carrega é o que resume o atendimento.
      const { settings } = await suDb.agent.findUniqueOrThrow({
        where: { id: agentDbId },
        select: { settings: true },
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { settings: { memory: { compaction: { enabled: false } } } },
      });
      try {
        expect(
          await recoverStrandedHumanReply({
            tenantId,
            deliveryRowId: observadora,
            base: appDb,
            makeClient,
          }),
        ).toBe("remembered");
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { settings: settings ?? {} },
        });
      }
      // Antes de a linha do respondedor rodar: nenhum instante em que o payload diga o observador.
      expect((await ingestJobs(convId))[0]?.payload.agentId).toBe(
        String(agentDbId),
      );
      expect((await ingestJobs(convId))[0]?.payload.compactionEnabled).toBe(
        false,
      );
      expect(
        await recoverStrandedHumanReply({
          tenantId,
          deliveryRowId: respondedora,
          base: appDb,
          makeClient,
        }),
      ).toBe("remembered");
      const jobs = await ingestJobs(convId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload.agentId).toBe(String(agentDbId));
    });

    // NOTE: DATADO PELA EMISSÃO, NÃO PELO RECEBIMENTO. O Chatwoot escolhe os destinatários quando
    // emite: uma resposta emitida antes de o respondedor ser ligado nunca chegou a ele, mesmo que a
    // entrega do observador tenha sido recebida depois do vínculo. A página relida traz o
    // `created_at` da mensagem, e é ele que responde, como o payload responde ao vivo.
    test("a reply emitted before the responder was bound stays the watcher's, whenever it was received", async () => {
      const convId = 9174;
      pages.set(convId, [
        {
          ...restComposerReply(774, "Emitida antes do vínculo."),
          created_at: Math.floor((Date.now() - 60 * 60 * 1000) / 1000),
        },
      ]);
      const observadora = await seedStranded(convId, {
        inboxId: WATCHED_INBOX_ID,
        messageId: 774,
        routeAgentBotId: QUIET_WATCHER_BOT,
        routeObserved: true,
      });
      // Ligado há 50 minutos: antes do recebimento (40 min, o do `seedStranded`), depois da emissão.
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: WATCHED_INBOX_ID },
        data: { responderBoundAt: new Date(Date.now() - 50 * 60 * 1000) },
      });
      try {
        expect(
          await recoverStrandedHumanReply({
            tenantId,
            deliveryRowId: observadora,
            base: appDb,
            makeClient,
          }),
        ).toBe("remembered");
        expect((await ingestJobs(convId))[0]?.payload.agentId).toBe(
          String(quietWatcherAgentDbId),
        );
      } finally {
        await suDb.inbox.updateMany({
          where: { tenantId, chatwootInboxId: WATCHED_INBOX_ID },
          data: { responderBoundAt: null },
        });
      }
    });

    // E O MESMO RELÓGIO NO OUTRO SENTIDO: emitida bem depois do vínculo, a resposta chegou ao
    // respondedor, e é dele sem precisar de linha irmã no ledger.
    test("a reply emitted well after the responder was bound is the responder's", async () => {
      const convId = 9175;
      pages.set(convId, [
        {
          ...restComposerReply(775, "Emitida depois do vínculo."),
          created_at: Math.floor((Date.now() - 42 * 60 * 1000) / 1000),
        },
      ]);
      const observadora = await seedStranded(convId, {
        inboxId: WATCHED_INBOX_ID,
        messageId: 775,
        routeAgentBotId: QUIET_WATCHER_BOT,
        routeObserved: true,
      });
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: WATCHED_INBOX_ID },
        data: { responderBoundAt: new Date(Date.now() - 50 * 60 * 1000) },
      });
      try {
        expect(
          await recoverStrandedHumanReply({
            tenantId,
            deliveryRowId: observadora,
            base: appDb,
            makeClient,
          }),
        ).toBe("remembered");
        expect((await ingestJobs(convId))[0]?.payload.agentId).toBe(
          String(agentDbId),
        );
      } finally {
        await suDb.inbox.updateMany({
          where: { tenantId, chatwootInboxId: WATCHED_INBOX_ID },
          data: { responderBoundAt: null },
        });
      }
    });

    // NOTE: O RESPONDEDOR DESLIGADO NÃO GUARDA NADA, então não é dono: a rota do observador continua
    // devendo o append (ao lado de um respondedor, desligado ou não) e o arma sob o próprio agente.
    test("a switched-off responder does not own the watcher's append", async () => {
      const convId = 9173;
      pages.set(convId, [
        restComposerReply(773, "Com o respondedor desligado."),
      ]);
      const observadora = await seedStranded(convId, {
        inboxId: WATCHED_INBOX_ID,
        messageId: 773,
        routeAgentBotId: QUIET_WATCHER_BOT,
        routeObserved: true,
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { enabled: false },
      });
      try {
        expect(
          await recoverStrandedHumanReply({
            tenantId,
            deliveryRowId: observadora,
            base: appDb,
            makeClient,
          }),
        ).toBe("remembered");
        expect((await ingestJobs(convId))[0]?.payload.agentId).toBe(
          String(quietWatcherAgentDbId),
        );
      } finally {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { enabled: true },
        });
      }
    });

    // NOTE: O RESPONDEDOR QUE NÃO RECEBEU A MENSAGEM NÃO É DONO DELA. Ligado depois de ela chegar, o
    // Chatwoot não lhe entregou nada, então só a rota do observador a guardou, e ela a arma sob o
    // próprio agente, como o caminho ao vivo faz quando `responderCoversMessage` diz que não.
    test("a responder bound after the message does not own the watcher's append", async () => {
      const convId = 9172;
      pages.set(convId, [
        restComposerReply(772, "Chegou antes do respondedor."),
      ]);
      const observadora = await seedStranded(convId, {
        inboxId: WATCHED_INBOX_ID,
        messageId: 772,
        routeAgentBotId: QUIET_WATCHER_BOT,
        routeObserved: true,
      });
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: WATCHED_INBOX_ID },
        data: { responderBoundAt: new Date() },
      });
      try {
        expect(
          await recoverStrandedHumanReply({
            tenantId,
            deliveryRowId: observadora,
            base: appDb,
            makeClient,
          }),
        ).toBe("remembered");
        const jobs = await ingestJobs(convId);
        expect(jobs[0]?.payload.agentId).toBe(String(quietWatcherAgentDbId));
      } finally {
        await suDb.inbox.updateMany({
          where: { tenantId, chatwootInboxId: WATCHED_INBOX_ID },
          data: { responderBoundAt: null },
        });
      }
    });

    // O QUE O JOB FAZ COM CADA DESFECHO, que é onde os vereditos e os adiamentos se separam na
    // prática. Um veredito repetido gasta a escada até a dead-letter e anuncia uma perda que não
    // existe; um adiamento tratado como veredito descarta em silêncio a resposta que uma segunda
    // tentativa salvaria — e a segunda tentativa é a razão de este job existir.
    test("the job retries what can change and settles what cannot", async () => {
      registerHumanReplyRecoveryHandler();
      const handler = getJobHandler("HUMAN_REPLY_RECOVERY");
      if (!handler) throw new Error("handler não registrado");

      // The verdict is reached WITHOUT the network on all three, deliberately: the handler builds
      // its own client, so a case that needs a REST read would be measuring SafeFetch here instead
      // of the mapping this test is about. The `test`-mode route refuses before any call, and the
      // unreadable account is the account itself being unreachable.
      const settled = await seedStranded(9111, {
        inboxId: TEST_MODE_INBOX_ID,
        messageId: 710,
      });
      const unreadable = await seedStranded(9112, { messageId: 711 });
      const unmirrored = await seedStranded(9113, {
        messageId: 712,
        mirrored: false,
      });

      const run = async (rowId: bigint) =>
        (
          await handler(
            {
              id: 1n,
              tenantId,
              kind: "HUMAN_REPLY_RECOVERY",
              payload: { deliveryRowId: String(rowId) },
              attempts: 0,
            } as never,
            appDb,
          )
        ).outcome;

      expect(await run(settled)).toBe("done");
      expect(await run(unreadable)).toBe("fail");
      expect(await run(unmirrored)).toBe("fail");
      // E UM PAYLOAD QUE ESTE PROCESSO NÃO SABE LER nunca vira legível: `done`, não `fail`, porque
      // repetir só adia a dead-letter sem mudar a resposta.
      expect(
        (await handler({ id: 2n, tenantId, payload: {} } as never, appDb))
          .outcome,
      ).toBe("done");
    });
  },
);
