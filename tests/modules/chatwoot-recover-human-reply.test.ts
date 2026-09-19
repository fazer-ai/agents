import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import { createChatwootClient } from "@/modules/chatwoot/client";
import {
  recoverStrandedHumanReply,
  registerHumanReplyRecoveryHandler,
} from "@/modules/chatwoot/recover-human-reply";
import { getJobHandler } from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";

// RECOVERING THE COLLEAGUE'S REPLY AN INGESTION LOST (issue #728).
//
// What the delivery loses is one effect: the words reaching the contact's memory. The ledger has
// named the reply since issue #469 (`human_reply_message_id`, written at INSERT for the takeover's
// own fence), so the message can be read back by id and the append armed again — which three places
// in the tree said was impossible, on a premise that was true when each was written.
//
// WHAT IS ASSERTED HERE is the job the recovery arms and the payload it carries, not the append
// itself: the append is the ingest job's, and it is the SAME job the live path would have armed,
// dedup included. Asserting it here would be asserting `../../src/graph/ingest.ts`'s behaviour
// through two layers.
//
// The Chatwoot side serves the message page in the REST spelling, which is the one thing this
// recovery depends on and the one the issue says nobody had measured: `message_type` as an INTEGER
// (`message_type_before_type_cast`) and the sender rendered by `push_event_data`. Serving the
// webhook spelling instead would make every one of these pass by construction.

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
// An inbox NOBODY of ours answers, with a watcher on it: the route issue #620 measured as folding
// nothing in, because there is no responder's memory for the watcher to share.
const UNANSWERED_INBOX_ID = 94;
// A responder of ours, with a watcher whose own agent is in `test` mode. The receiver asks a
// row-backed watcher's SWITCH and not its mode (issue #476 review, round 19), so this route folds
// the reply in — and it is the only shape that tells the two readings of the gate apart.
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
let watcherAgentDbId = 0n;
let quietWatcherAgentDbId = 0n;
let deliverySeq = 0;

// The account's messages, per conversation, in the REST spelling.
const pages = new Map<number, Record<string, unknown>[]>();
// Conversations whose message read fails outright.
const failingReads = new Set<number>();
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

// THE REST SPELLING, which is what the fork actually serves on this endpoint and is not the webhook
// one. `message_type` renders through `message_type_before_type_cast` (an integer), and the sender
// through `User#push_event_data` — which carries `available_name`, `avatar_url`,
// `availability_status` and `thumbnail` beside the four fields the webhook's `webhook_data` gives.
// MEASURED against the local fork (4.16.0) before this test was written; the discriminator everything
// depends on, `sender.type === "user"`, is present in both.
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
      // The watcher: `monitoring` and switched on, with a bot of its own, on an inbox a `test`-mode
      // agent answers. The live receiver folds a colleague's reply in through THIS agent, and it
      // asks the watcher's switch without asking its mode (issue #476 review, round 19).
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
        // Omitted = the mirror knows the conversation. `false` = it does not, which is what a delivery
        // that died before the mirror write leaves.
        mirrored?: boolean;
        // The bot the delivery arrived on, as the claim recorded it, and whether that route was a
        // watcher's (issue #476). Omitted = the inbox persona's, answering.
        routeAgentBotId?: number | null;
        routeObserved?: boolean;
        // The episode boundary a `/reset` left on the conversation (issue #447).
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
            assigneeId: OUR_BOT,
            inboxId: inbox.id,
            threadId: `chatwoot:${tenantId}:${instanceId}:${convId}`,
            lastEventAt: new Date(),
            contactInboxId:
              over.contactInboxId === undefined
                ? 91_000 + convId
                : over.contactInboxId,
            ...(over.resetAtMessageId === undefined
              ? {}
              : { resetAtMessageId: over.resetAtMessageId }),
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

    // O QUE A ISSUE CONSERTA. A resposta se perdeu porque o enfileiramento estava fora do ar, e a
    // varredura arma a releitura: a mensagem é lida de volta pelo id que a linha guarda desde a #469, e
    // o append é armado com o PAPEL certo — `human_agent`, que é o que põe a resposta em
    // `recent_agent_message_ids` em vez de fingir que o cliente a escreveu (#187).
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
        `ingest:${tenantId}:${instanceId}:ci:${91_000 + convId}:700`,
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
      // AND NOTHING WAS WRITTEN TO THE CONVERSATION. The recovery of the memory is not the recovery of
      // the handover: a conversation an operator handed back to the bot in the meantime must not be
      // taken away from it again to close a memory gap (issue #469). The takeover has a recovery of its
      // own, armed beside this one.
      expect(calls.filter((c) => c.url.includes("toggle_status"))).toEqual([]);
    });

    // A ARMADILHA MAIS CARA DESTE CONSERTO. Num provedor que não reserva os ids do eco, a nossa própria
    // resposta volta como um `message_created` sem sender e com `external_sender_name` — byte a byte a
    // forma `device` que um colega digitando no telefone pareado produz. A linha guarda a FORMA, então
    // ancorar nela sem re-perguntar ao provedor arquivaria a fala do próprio agente na memória do
    // contato como se um atendente humano a tivesse escrito.
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

      expect(await ingestJobs(convId)).toEqual([]);
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
      expect(await ingestJobs(convId)).toEqual([]);
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
      expect(await ingestJobs(convId)).toEqual([]);
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
      expect(await ingestJobs(convId)).toEqual([]);
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
      expect(await ingestJobs(convId)).toEqual([]);
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
      expect(await ingestJobs(convId)).toEqual([]);
    });

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

    // E A LINHA QUE NÃO NOMEIA RESPOSTA NENHUMA não ganha recuperação por estar encalhada. É a leitura
    // tentadora deste conserto — "linha de `message_created` parada, vamos reler a mensagem" — e ela
    // varreria para dentro a saída do nosso próprio bot, a nota privada e a reação, que são as três
    // coisas que `human_reply_message_id` fica NULO para manter fora por construção.
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
      expect(await ingestJobs(convId)).toEqual([]);
    });

    // A ROTA DA ENTREGA DECIDE DE QUEM É A MEMÓRIA, não a inbox (review r1). O Chatwoot entrega a
    // mesma mensagem ao bot da inbox E ao observador ligado nela, então um encalhe pode ser de
    // qualquer uma das duas rotas, e só a linha diz qual. Lida como a do respondedor, a perda do
    // observador era descartada toda vez que o respondedor estivesse em `test` ou desligado — em
    // silêncio, e para sempre, porque nada revisita a linha.
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

    // E O MODO DO OBSERVADOR NÃO É PERGUNTADO, que é o que separa a leitura certa da errada. O
    // receptor decide a rota do observador pela LINHA dele e pergunta só o interruptor — "a
    // row-backed observer decides this whatever its mode says" (#476 review, round 19) —, então um
    // observador cujo agente está em `test` folheia a resposta na entrega. Lido pelo modo, o append
    // dele nunca seria recuperado, e é exatamente nessa linha que o defeito de r1 morava.
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
      expect((await ingestJobs(convId))[0]?.payload.agentId).toBe(
        String(quietWatcherAgentDbId),
      );
    });

    // E O OBSERVADOR SEM RESPONDEDOR NÃO PERDEU NADA (issue #620), que é a outra metade da mesma
    // condição: numa inbox que ninguém nosso atende não há memória de respondedor para o observador
    // dividir, então a entrega nunca ingeriu e não há o que recuperar.
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
      expect(await ingestJobs(convId)).toEqual([]);
    });

    // A ÚNICA RECUSA AQUI QUE PROTEGE CONTRA DANO ATIVO, e não contra trabalho perdido (review r1).
    // O `/reset` limpa a memória e, dentro da mesma seção crítica, revoga todo `INGEST_MESSAGE` da
    // thread — justamente porque um append com texto de antes reconstruiria o que o operador acabou
    // de mandar apagar. Ele não tem como revogar ESTE job: a recuperação é de um kind próprio,
    // armada antes do comando e rodando depois dele, e apagar a thread leva junto a dedup do append,
    // então nada rio abaixo pegaria a duplicata.
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
      expect(await ingestJobs(convId)).toEqual([]);
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
          data: { resetAtMessageId: 719 },
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
        expect(await ingestJobs(convId)).toEqual([]);
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
