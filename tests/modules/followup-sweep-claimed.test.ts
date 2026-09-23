import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  followUpHandler,
  registerFollowUpHandlers,
} from "@/modules/followups/handlers";
import { type ClaimedJob, claimDueJobs } from "@/modules/scheduler/service";
import {
  getJobHandler,
  registerJobHandler,
  runClaimed,
} from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";

// A VARREDURA NÃO PODE SUPLANTAR O FOLLOW-UP QUE ESTÁ RODANDO (issue #786).
//
// A varredura roda a cada minuto e re-arma `followup:<thread>` para toda conversa elegível. Enquanto
// o passo 0 está na chamada do modelo, `last_follow_up_at` ainda não foi carimbado, então a conversa
// continua elegível e o re-arme caía sobre a linha CLAIMED: status de volta a PENDING, payload
// trocado, e o `reschedule` do passo 1 descartado pelo CAS do token. A segunda execução começava no
// passo 0, via a conversa carimbada e devolvia `done`: o último passo (etiqueta e resolve) sumia.
//
// O arranjo é o caminho vivo inteiro: a varredura de verdade arma, `claimDueJobs` reivindica,
// `runClaimed` executa o handler e grava o desfecho. A varredura do meio roda DENTRO do passo 0, na
// sonda de posse ao vivo que precede a chamada do modelo, que é exatamente a janela da issue.
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

const CHATWOOT_INBOX_ID = 7861;
const LABEL = "sem-resposta";
const DAY_MS = 24 * 60 * 60_000;
// Uma conversa por caso: a chave do follow-up nomeia a conversa.
const CONV_ESCADA = 78_601;
const CONV_TICK = 78_602;

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let sweepJobId = 0n;

function threadOf(convId: number): string {
  return `${tenantId}:${instanceId}:${convId}`;
}

function keyOf(convId: number): string {
  return `followup:${threadOf(convId)}`;
}

// O Chatwoot falso, com um gancho na primeira sonda de posse: é o instante em que o passo 0 já foi
// reivindicado e ainda não carimbou nada.
function stubClient(duranteOPasso0: () => Promise<void>) {
  const sent: string[] = [];
  const labelSets: string[][] = [];
  const resolved: number[] = [];
  let currentLabels: string[] = [];
  let hookRan = false;
  const client = {
    getConversation: async (c: number) => {
      if (!hookRan) {
        hookRan = true;
        await duranteOPasso0();
      }
      return { id: c, status: "pending", meta: {} };
    },
    sendMessage: async (_c: number, t: string) => {
      sent.push(t);
      return {};
    },
    sendPrivateNote: async () => ({}),
    getConversationLabels: async () => currentLabels,
    setConversationLabels: async (_c: number, labels: string[]) => {
      currentLabels = labels;
      labelSets.push(labels);
      return {};
    },
    toggleStatus: async (c: number) => {
      resolved.push(c);
      return {};
    },
  } as unknown as ChatwootClient;
  return { sent, labelSets, resolved, makeClient: async () => client };
}

// O FOLLOWUP registrado no worker é o handler de produção com as dependências de teste na frente;
// `runClaimed` o encontra pelo kind, como o tick encontra.
function registerStubbedFollowUp(s: ReturnType<typeof stubClient>) {
  registerJobHandler("FOLLOWUP", (job, base) =>
    followUpHandler(job, base, {
      makeModel: () => new FakeListChatModel({ responses: ["Ainda por aí?"] }),
      makeClient: s.makeClient,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
    }),
  );
}

async function runSweep(): Promise<void> {
  const sweep = getJobHandler("FOLLOWUP_SWEEP");
  if (!sweep) throw new Error("unreachable: registerFollowUpHandlers ran");
  const job: ClaimedJob = {
    id: sweepJobId,
    tenantId,
    kind: "FOLLOWUP_SWEEP",
    payload: {},
    attempts: 0,
    claimSeq: 0,
  };
  await sweep(job, appDb);
}

async function claimOwn(convId: number): Promise<ClaimedJob[]> {
  const claimed = await claimDueJobs(50, appDb, new Date(), tenantId);
  return claimed.filter((j) => j.dedupeKey === keyOf(convId));
}

async function rowOf(convId: number) {
  return suDb.schedulerJob.findFirstOrThrow({
    where: { tenantId, kind: "FOLLOWUP", dedupeKey: keyOf(convId) },
    select: {
      id: true,
      status: true,
      payload: true,
      claimSeq: true,
      runAt: true,
    },
  });
}

// Uma conversa parada há dois minutos, respondida por nós, que a varredura seleciona para o passo 0.
async function seedIdle(convId: number): Promise<void> {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbId,
      chatwootConversationId: convId,
      status: "pending",
      threadId: threadOf(convId),
      lastEventAt: new Date(Date.now() - 2 * 60_000),
      lastInboundAt: new Date(Date.now() - 3 * 60_000),
      lastRepliedMessageId: 1,
    },
  });
}

// O tempo passa: a conversa inteira recua, mantendo a ordem entre as colunas, que é o que define o
// episódio. Nada aqui muda a quem pertence a última palavra.
async function elapse(convId: number, ms: number): Promise<void> {
  await suDb.$executeRaw`
    UPDATE conversations
       SET last_event_at = last_event_at - ${ms} * interval '1 millisecond',
           last_inbound_at = last_inbound_at - ${ms} * interval '1 millisecond',
           last_follow_up_at = last_follow_up_at - ${ms} * interval '1 millisecond'
     WHERE tenant_id = ${tenantId} AND chatwoot_conversation_id = ${convId}`;
  await suDb.$executeRaw`
    UPDATE scheduler_jobs SET run_at = now() - interval '1 second'
     WHERE tenant_id = ${tenantId} AND dedupe_key = ${keyOf(convId)}`;
}

describe.skipIf(!dbUp)(
  "the follow-up sweep and a claimed follow-up (issue #786)",
  () => {
    beforeAll(async () => {
      sweepJobId = await burnSchedulerJobId(suDb);
      const t = await suDb.tenant.create({
        data: { name: "FU786", slug: `fu786-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 5,
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
          followUpArmedAt: new Date(Date.now() - 30 * DAY_MS),
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${llmKey.id}`,
          },
          settings: {
            followUp: {
              enabled: true,
              steps: [
                { delayValue: 1, delayUnit: "minutes", instructions: "a" },
                {
                  delayValue: 1,
                  delayUnit: "days",
                  instructions: "b",
                  assignLabels: [LABEL],
                  resolve: true,
                },
              ],
            },
          },
        },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: 5,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `fu786-route-${process.pid}`,
          name: "Atendente",
        },
      });
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: CHATWOOT_INBOX_ID,
          name: "Suporte",
          agentId: agent.id,
          channelType: "Channel::Api",
        },
      });
      inboxDbId = inbox.id;
      registerFollowUpHandlers();
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of [
          "scheduler_jobs",
          "llm_usage",
          "conversations",
          "inboxes",
          "chatwoot_agent_bots",
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

    test("a sweep during step 0 leaves the run alone, and the ladder reaches its last step", async () => {
      await seedIdle(CONV_ESCADA);
      await runSweep();
      const [step0] = await claimOwn(CONV_ESCADA);
      expect(step0).toBeDefined();
      if (!step0) return;

      const s = stubClient(runSweep);
      registerStubbedFollowUp(s);
      await runClaimed(step0, appDb);

      // O reschedule do passo 0 pousou: a mesma linha, com o passo seguinte, no token que a
      // reivindicação entregou.
      const after = await rowOf(CONV_ESCADA);
      expect(after.status).toBe("PENDING");
      expect(after.payload).toEqual({
        threadId: threadOf(CONV_ESCADA),
        stepIndex: 1,
        // O episódio que a varredura gravou no passo 0 segue com a escada (issue #796).
        episode: expect.any(String),
      });
      expect(after.claimSeq).toBe(step0.claimSeq);
      expect(after.runAt.getTime()).toBeGreaterThan(Date.now() + DAY_MS / 2);
      expect(s.sent).toHaveLength(1);

      // Um dia depois o último passo roda, e é ele que etiqueta e resolve.
      await elapse(CONV_ESCADA, 2 * DAY_MS);
      const [step1] = await claimOwn(CONV_ESCADA);
      expect(step1?.payload.stepIndex).toBe(1);
      if (!step1) return;
      await runClaimed(step1, appDb);
      expect(s.sent).toHaveLength(2);
      expect(s.labelSets.at(-1)).toContain(LABEL);
      expect(s.resolved).toEqual([CONV_ESCADA]);
      expect((await rowOf(CONV_ESCADA)).status).toBe("DONE");
    });

    test("a tick during step 0 cannot claim the row the sweep just passed over, so step 0 speaks once", async () => {
      await seedIdle(CONV_TICK);
      await runSweep();
      const [step0] = await claimOwn(CONV_TICK);
      expect(step0).toBeDefined();
      if (!step0) return;

      const reclaimed: ClaimedJob[] = [];
      const s = stubClient(async () => {
        await runSweep();
        reclaimed.push(...(await claimOwn(CONV_TICK)));
      });
      registerStubbedFollowUp(s);
      await runClaimed(step0, appDb);

      expect(reclaimed).toEqual([]);
      expect(s.sent).toHaveLength(1);
      const after = await rowOf(CONV_TICK);
      expect(after.payload).toMatchObject({ stepIndex: 1 });
      expect(after.claimSeq).toBe(step0.claimSeq);
    });
  },
);
