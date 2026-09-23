import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  followUpConfigVersion,
  followUpHandler,
  registerFollowUpHandlers,
} from "@/modules/followups/handlers";
import {
  followUpEpisodeKey,
  silenceStartedAt,
} from "@/modules/followups/settings";
import {
  type ClaimedJob,
  claimDueJobs,
  enqueueJob,
} from "@/modules/scheduler/service";
import {
  getJobHandler,
  registerJobHandler,
  runClaimed,
} from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";

// A VARREDURA SÓ OFERECE O QUE O HANDLER VAI FAZER (issue #796).
//
// A varredura roda a cada minuto e re-arma `followup:<thread>` para toda conversa que ela seleciona.
// Três entradas faziam dela um laço sem fim: um agente com o follow-up desligado continuava
// selecionado (a SQL testava só `follow_up_armed_at`), uma conversa atribuída a OUTRO bot também (o
// portão ao vivo devolve `stale`, que não carimba nada), e uma linha que o handler adiou de propósito
// voltava para agora com o payload trocado, perdendo a contagem de retentativas e a cadência do
// passo 0. Medido em produção: 89 linhas PENDING do passo 0, uma com `claim_seq` 366.
//
// O arranjo é o caminho vivo: a varredura de verdade arma, `claimDueJobs` reivindica, `runClaimed`
// executa o handler de produção com um modelo e um Chatwoot falsos.
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

const DAY_MS = 24 * 60 * 60_000;
const OUR_BOT = 5;
// Uma caixa por agente: a caixa decide o agente da conversa.
const INBOX_ON = 7961;
const INBOX_OFF = 7962;
const INBOX_SLOW = 7963;
// Uma conversa por caso: a chave do follow-up nomeia a conversa.
const CONV_ON = 79_601;
const CONV_OFF = 79_602;
const CONV_OTHER_BOT = 79_603;
const CONV_LATER = 79_605;
const CONV_DUE = 79_606;
const CONV_SLOW = 79_607;
const CONV_DEAD_NOW = 79_609;
const CONV_DEAD_BEFORE = 79_610;
const CONV_OLD_STEP = 79_611;
const CONV_LEGACY = 79_613;
const CONV_OTHER_EPISODE = 79_614;
const CONV_DEAD_LATE = 79_615;
const CONV_DEAD_MARKED = 79_616;
const CONV_RETIRED = 79_617;
const CONV_HELD = 79_618;
const CONV_FAILED = 79_619;
const CONV_HOURS = 79_612;

let tenantId = 0n;
let instanceId = 0n;
let sweepJobId = 0n;
const inboxIds = new Map<number, bigint>();

function threadOf(convId: number): string {
  return `${tenantId}:${instanceId}:${convId}`;
}

function keyOf(convId: number): string {
  return `followup:${threadOf(convId)}`;
}

function stubClient(meta: Record<string, unknown> = {}) {
  const sent: string[] = [];
  const client = {
    getConversation: async (c: number) => ({
      id: c,
      status: "pending",
      meta,
    }),
    sendMessage: async (_c: number, t: string) => {
      sent.push(t);
      return {};
    },
    sendPrivateNote: async () => ({}),
    getConversationLabels: async () => [],
    setConversationLabels: async () => ({}),
    toggleStatus: async () => ({}),
  } as unknown as ChatwootClient;
  return { sent, makeClient: async () => client };
}

function registerStubbed(s: ReturnType<typeof stubClient>) {
  registerJobHandler("FOLLOWUP", (job, base) =>
    followUpHandler(job, base, {
      makeModel: () => new FakeListChatModel({ responses: ["Oi?"] }),
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

async function rowOf(convId: number) {
  return suDb.schedulerJob.findFirst({
    where: { tenantId, kind: "FOLLOWUP", dedupeKey: keyOf(convId) },
    select: {
      status: true,
      payload: true,
      runAt: true,
      claimSeq: true,
      attempts: true,
    },
  });
}

// O episódio que a varredura grava no job: o início do silêncio da conversa, como o handler o lê.
async function episodeOf(convId: number): Promise<string> {
  const c = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, threadId: threadOf(convId) },
    select: { lastInboundAt: true, lastRepliedAt: true },
  });
  const start = silenceStartedAt(c.lastInboundAt, c.lastRepliedAt);
  if (!start) throw new Error("conversa sem silêncio");
  return followUpEpisodeKey(start);
}

// Uma conversa parada há dois minutos, respondida por nós, que a varredura seleciona para o passo 0.
async function seedIdle(
  convId: number,
  inbox: number,
  assignee: { type: string; id: number } | null = null,
): Promise<void> {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxIds.get(inbox) ?? null,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: assignee?.type ?? null,
      assigneeId: assignee?.id ?? null,
      threadId: threadOf(convId),
      lastEventAt: new Date(Date.now() - 2 * 60_000),
      lastInboundAt: new Date(Date.now() - 3 * 60_000),
      lastRepliedMessageId: 1,
    },
  });
}

async function seedAgent(
  name: string,
  followUp: { enabled: boolean; delayMinutes: number },
  inbox: number,
  botId: number,
): Promise<void> {
  const llmKey = await suDb.vaultEntry.create({
    data: { tenantId, name: `llm-${name}`, secret: encryptJson("sk-test") },
    select: { id: true },
  });
  const agent = await suDb.agent.create({
    data: {
      tenantId,
      name,
      systemPrompt: "Você é prestativa.",
      followUpArmedAt: new Date(Date.now() - 30 * DAY_MS),
      modelConfig: {
        provider: "openai",
        model: "gpt-4o-mini",
        credentialRef: `vault:${llmKey.id}`,
      },
      settings: {
        followUp: {
          enabled: followUp.enabled,
          steps: [
            {
              delayValue: followUp.delayMinutes,
              delayUnit: "minutes",
              instructions: "a",
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
      chatwootAgentBotId: botId,
      accessToken: encryptJson("BOT"),
      webhookSecret: encryptJson("S"),
      webhookRouteTokenHash: `fu796-${name}-${process.pid}`,
      name,
    },
  });
  const row = await suDb.inbox.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootInboxId: inbox,
      name,
      agentId: agent.id,
      channelType: "Channel::Api",
    },
  });
  inboxIds.set(inbox, row.id);
}

describe.skipIf(!dbUp)(
  "the follow-up sweep only offers what the handler will act on (issue #796)",
  () => {
    beforeAll(async () => {
      sweepJobId = await burnSchedulerJobId(suDb);
      const t = await suDb.tenant.create({
        data: { name: "FU796", slug: `fu796-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 5,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      await seedAgent(
        "on",
        { enabled: true, delayMinutes: 1 },
        INBOX_ON,
        OUR_BOT,
      );
      // Armed once, then switched off: `follow_up_armed_at` stays set.
      await seedAgent("off", { enabled: false, delayMinutes: 1 }, INBOX_OFF, 6);
      // A first step longer than the sweep's cutoff, which the minimum over agents sets at 1 minute.
      await seedAgent(
        "slow",
        { enabled: true, delayMinutes: 10 },
        INBOX_SLOW,
        7,
      );
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
          "business_hours",
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

    test("an agent whose follow-up was switched off is not swept, and one that is on is", async () => {
      await seedIdle(CONV_ON, INBOX_ON);
      await seedIdle(CONV_OFF, INBOX_OFF);
      await runSweep();
      expect((await rowOf(CONV_ON))?.status).toBe("PENDING");
      expect(await rowOf(CONV_OFF)).toBeNull();
    });

    // Another bot's conversation stays in the selection, because the mirror's assignee may be the
    // stale half and only the live gate repairs it (review round 1). What ends the loop is the
    // handler parking the row when the gate declines, and the next pass leaving it parked.
    test("a conversation another bot holds is asked once, then parked for an hour", async () => {
      await seedIdle(CONV_OTHER_BOT, INBOX_ON, { type: "AgentBot", id: 99 });
      await runSweep();
      const claimed = (
        await claimDueJobs(50, appDb, new Date(), tenantId)
      ).filter((j) => j.dedupeKey === keyOf(CONV_OTHER_BOT));
      expect(claimed).toHaveLength(1);
      const s = stubClient({ assignee_type: "AgentBot", assignee: { id: 99 } });
      registerStubbed(s);
      const [job] = claimed;
      if (!job) return;
      await runClaimed(job, appDb);
      const parked = await rowOf(CONV_OTHER_BOT);
      expect(parked?.status).toBe("PENDING");
      const until = parked?.runAt.getTime() ?? 0;
      expect(until).toBeGreaterThan(Date.now() + 55 * 60_000);
      await runSweep();
      const after = await rowOf(CONV_OTHER_BOT);
      expect(after?.runAt.getTime()).toBe(until);
      expect(after?.claimSeq).toBe(parked?.claimSeq);
      expect(s.sent).toEqual([]);
    });

    // The retry the handler scheduled keeps its time and its count, so NUDGE_RETRY_LIMIT can be
    // reached; before, each pass put the row back to now with the sweep's own payload.
    test("a run its handler put off keeps its time and its payload; a due one is armed as before", async () => {
      await seedIdle(CONV_LATER, INBOX_ON);
      await seedIdle(CONV_DUE, INBOX_ON);
      const later = new Date(Date.now() + 30 * 60_000);
      const retried = {
        threadId: threadOf(CONV_LATER),
        episode: await episodeOf(CONV_LATER),
        nudgeRetries: 2,
        deferredUnder: "backoff",
      };
      await enqueueJob({
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: keyOf(CONV_LATER),
        runAt: later,
        payload: retried,
        rearm: "same-work",
        base: appDb,
      });
      await enqueueJob({
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: keyOf(CONV_DUE),
        runAt: new Date(Date.now() - 60_000),
        payload: {
          threadId: threadOf(CONV_DUE),
          episode: await episodeOf(CONV_DUE),
          nudgeRetries: 1,
        },
        rearm: "same-work",
        base: appDb,
      });
      // A re-arm of the same episode keeps the budget it has been spending.
      await suDb.$executeRaw`
        UPDATE scheduler_jobs SET attempts = 2
         WHERE tenant_id = ${tenantId} AND dedupe_key = ${keyOf(CONV_DUE)}`;
      const before = Date.now();
      await runSweep();
      const kept = await rowOf(CONV_LATER);
      expect(kept?.runAt.getTime()).toBe(later.getTime());
      expect(kept?.payload).toEqual(retried);
      const due = await rowOf(CONV_DUE);
      expect(due?.payload).toEqual({
        threadId: threadOf(CONV_DUE),
        episode: await episodeOf(CONV_DUE),
      });
      expect(due?.runAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(due?.attempts).toBe(2);
    });

    // Review round 3: only a STEP-0 deferral is this episode's. Our own reply opens a new episode
    // without cancelling the old one's later step, and waiting for that step (days of cadence) would
    // hold back the new episode's first follow-up. The sweep replaces it with step 0.
    test("a later step left over from an earlier episode is replaced by this episode's step 0", async () => {
      await seedIdle(CONV_OLD_STEP, INBOX_ON);
      await enqueueJob({
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: keyOf(CONV_OLD_STEP),
        runAt: new Date(Date.now() + 3 * 24 * 60 * 60_000),
        // Marked as a backoff and with this episode, so what decides is the step alone.
        payload: {
          threadId: threadOf(CONV_OLD_STEP),
          episode: await episodeOf(CONV_OLD_STEP),
          stepIndex: 2,
          deferredUnder: "backoff",
        },
        rearm: "same-work",
        base: appDb,
      });
      const before = Date.now();
      await runSweep();
      const r = await rowOf(CONV_OLD_STEP);
      expect(r?.payload).toEqual({
        threadId: threadOf(CONV_OLD_STEP),
        episode: await episodeOf(CONV_OLD_STEP),
      });
      expect(r?.runAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(r?.runAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    });

    // Review round 5: a deferral that says nothing about why it may be kept was written before
    // deferrals were marked, from a configuration that may have changed since. It is re-armed once,
    // and the handler recomputes and marks it.
    test("an unmarked deferral is re-armed so the handler recomputes it", async () => {
      await seedIdle(CONV_LEGACY, INBOX_ON);
      await enqueueJob({
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: keyOf(CONV_LEGACY),
        runAt: new Date(Date.now() + 3 * 24 * 60 * 60_000),
        // This episode, so what decides is the missing mark alone.
        payload: {
          threadId: threadOf(CONV_LEGACY),
          episode: await episodeOf(CONV_LEGACY),
        },
        rearm: "same-work",
        base: appDb,
      });
      await runSweep();
      const r = await rowOf(CONV_LEGACY);
      expect(r?.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    // Review round 7: our own reply opens a new episode without cancelling the old one's deferral.
    // A backoff armed for the previous episode is not this one's, and its retry count is not either.
    test("a backoff armed for an earlier episode is replaced, and its retry count with it", async () => {
      await seedIdle(CONV_OTHER_EPISODE, INBOX_ON);
      await enqueueJob({
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: keyOf(CONV_OTHER_EPISODE),
        runAt: new Date(Date.now() + 60 * 60_000),
        payload: {
          threadId: threadOf(CONV_OTHER_EPISODE),
          episode: followUpEpisodeKey(new Date(Date.now() - DAY_MS)),
          nudgeRetries: 3,
          deferredUnder: "backoff",
        },
        rearm: "same-work",
        base: appDb,
      });
      await runSweep();
      const r = await rowOf(CONV_OTHER_EPISODE);
      expect(r?.payload).toEqual({
        threadId: threadOf(CONV_OTHER_EPISODE),
        episode: await episodeOf(CONV_OTHER_EPISODE),
      });
      expect(r?.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    // Review round 8: a reply retires the row DONE with its attempts still counted. The next episode
    // is new work and starts with a fresh budget, or one transient failure would dead-letter it.
    test("a row retired in an earlier episode is re-armed with a fresh budget", async () => {
      await seedIdle(CONV_RETIRED, INBOX_ON);
      await enqueueJob({
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: keyOf(CONV_RETIRED),
        runAt: new Date(Date.now() - 60_000),
        payload: {
          threadId: threadOf(CONV_RETIRED),
          episode: followUpEpisodeKey(new Date(Date.now() - DAY_MS)),
        },
        rearm: "same-work",
        base: appDb,
      });
      await suDb.$executeRaw`
        UPDATE scheduler_jobs SET status = 'DONE', attempts = 4
         WHERE tenant_id = ${tenantId} AND dedupe_key = ${keyOf(CONV_RETIRED)}`;
      await runSweep();
      const r = await rowOf(CONV_RETIRED);
      expect(r?.status).toBe("PENDING");
      expect(r?.attempts).toBe(0);
    });

    // Review round 8: an appointment hold is released as soon as the sweep selects the conversation,
    // which it does only once no live appointment holds it (the appointment ended or was cancelled).
    test("an appointment hold is re-armed once the sweep selects the conversation", async () => {
      await seedIdle(CONV_HELD, INBOX_ON);
      await enqueueJob({
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: keyOf(CONV_HELD),
        runAt: new Date(Date.now() + 60 * 60_000),
        payload: {
          threadId: threadOf(CONV_HELD),
          episode: await episodeOf(CONV_HELD),
          deferredUnder: "appointment",
        },
        rearm: "same-work",
        base: appDb,
      });
      await runSweep();
      expect((await rowOf(CONV_HELD))?.runAt.getTime()).toBeLessThanOrEqual(
        Date.now(),
      );
    });

    // Found by the acceptance run: the handler threw, and the scheduler re-pended the row with the
    // error and its own backoff, leaving the payload unmarked. That backoff is kept like the handler's
    // own, or a failing model spends the whole budget one attempt per pass.
    test("the scheduler's failure backoff is kept, with its error and its budget", async () => {
      await seedIdle(CONV_FAILED, INBOX_ON);
      const later = new Date(Date.now() + 4 * 60_000);
      const payload = {
        threadId: threadOf(CONV_FAILED),
        episode: await episodeOf(CONV_FAILED),
      };
      await enqueueJob({
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: keyOf(CONV_FAILED),
        runAt: later,
        payload,
        rearm: "same-work",
        base: appDb,
      });
      await suDb.$executeRaw`
        UPDATE scheduler_jobs SET attempts = 2, last_error = 'model down'
         WHERE tenant_id = ${tenantId} AND dedupe_key = ${keyOf(CONV_FAILED)}`;
      await runSweep();
      const r = await suDb.schedulerJob.findFirstOrThrow({
        where: { tenantId, kind: "FOLLOWUP", dedupeKey: keyOf(CONV_FAILED) },
        select: { runAt: true, attempts: true, lastError: true, payload: true },
      });
      expect(r.runAt.getTime()).toBe(later.getTime());
      expect(r.attempts).toBe(2);
      expect(r.lastError).toBe("model down");
      expect(r.payload).toEqual(payload);
    });

    // Found by the verifier: a model that keeps failing sends the row DEAD, which stamps nothing, and
    // each pass re-armed it for one more model call a minute. A death in this episode keeps the
    // conversation out; one from an earlier episode does not.
    test("a follow-up that died in this episode is not re-armed; one that died before it is", async () => {
      await seedIdle(CONV_DEAD_NOW, INBOX_ON);
      await seedIdle(CONV_DEAD_BEFORE, INBOX_ON);
      for (const conv of [CONV_DEAD_NOW, CONV_DEAD_BEFORE]) {
        await enqueueJob({
          tenantId,
          kind: "FOLLOWUP",
          dedupeKey: keyOf(conv),
          runAt: new Date(Date.now() - 60_000),
          payload: { threadId: threadOf(conv) },
          rearm: "same-work",
          base: appDb,
        });
      }
      await suDb.$executeRaw`
        UPDATE scheduler_jobs SET status = 'DEAD', attempts = 5, updated_at = now()
         WHERE tenant_id = ${tenantId} AND dedupe_key = ${keyOf(CONV_DEAD_NOW)}`;
      // Died a day ago, before the silence that started three minutes ago.
      await suDb.$executeRaw`
        UPDATE scheduler_jobs
           SET status = 'DEAD', attempts = 5, updated_at = now() - interval '1 day'
         WHERE tenant_id = ${tenantId} AND dedupe_key = ${keyOf(CONV_DEAD_BEFORE)}`;
      // Review round 7: a claim of the PREVIOUS episode that died after this silence began. Its death
      // time says "this episode"; the episode written on it says otherwise, and that is what counts.
      await seedIdle(CONV_DEAD_LATE, INBOX_ON);
      await enqueueJob({
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: keyOf(CONV_DEAD_LATE),
        runAt: new Date(Date.now() - 60_000),
        payload: {
          threadId: threadOf(CONV_DEAD_LATE),
          episode: followUpEpisodeKey(new Date(Date.now() - DAY_MS)),
        },
        rearm: "same-work",
        base: appDb,
      });
      await suDb.$executeRaw`
        UPDATE scheduler_jobs SET status = 'DEAD', attempts = 5, updated_at = now()
         WHERE tenant_id = ${tenantId} AND dedupe_key = ${keyOf(CONV_DEAD_LATE)}`;
      // And one marked with THIS episode stays out even though it died before the silence began by
      // the clock: the mark is what is read.
      await seedIdle(CONV_DEAD_MARKED, INBOX_ON);
      await enqueueJob({
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: keyOf(CONV_DEAD_MARKED),
        runAt: new Date(Date.now() - 60_000),
        payload: {
          threadId: threadOf(CONV_DEAD_MARKED),
          episode: await episodeOf(CONV_DEAD_MARKED),
        },
        rearm: "same-work",
        base: appDb,
      });
      await suDb.$executeRaw`
        UPDATE scheduler_jobs
           SET status = 'DEAD', attempts = 5, updated_at = now() - interval '1 day'
         WHERE tenant_id = ${tenantId} AND dedupe_key = ${keyOf(CONV_DEAD_MARKED)}`;
      await runSweep();
      expect((await rowOf(CONV_DEAD_MARKED))?.status).toBe("DEAD");
      expect((await rowOf(CONV_DEAD_LATE))?.status).toBe("PENDING");
      expect((await rowOf(CONV_DEAD_LATE))?.attempts).toBe(0);
      expect((await rowOf(CONV_DEAD_NOW))?.status).toBe("DEAD");
      const revived = await rowOf(CONV_DEAD_BEFORE);
      expect(revived?.status).toBe("PENDING");
      // Review round 6: the budget was spent on the earlier episode, so this one starts with a fresh
      // one instead of dead-lettering on its first transient failure.
      expect(revived?.attempts).toBe(0);
    });

    // The cadence of a step longer than the cutoff: the handler reschedules to when the step is due,
    // and the next pass used to pull it back to now, a claim and a reschedule every minute.
    test("a step-0 cadence longer than the sweep's cutoff is not pulled back every pass", async () => {
      await seedIdle(CONV_SLOW, INBOX_SLOW);
      await runSweep();
      const claimed = (
        await claimDueJobs(50, appDb, new Date(), tenantId)
      ).filter((j) => j.dedupeKey === keyOf(CONV_SLOW));
      expect(claimed).toHaveLength(1);
      const s = stubClient();
      registerStubbed(s);
      const [job] = claimed;
      if (!job) return;
      await runClaimed(job, appDb);
      const deferred = await rowOf(CONV_SLOW);
      expect(deferred?.status).toBe("PENDING");
      const dueAt = deferred?.runAt.getTime() ?? 0;
      expect(dueAt).toBeGreaterThan(Date.now() + 5 * 60_000);
      await runSweep();
      const after = await rowOf(CONV_SLOW);
      expect(after?.runAt.getTime()).toBe(dueAt);
      expect(after?.claimSeq).toBe(deferred?.claimSeq);
      expect(s.sent).toEqual([]);

      // Review round 4: the operator shortens the cadence after the deferral. The instant the handler
      // computed no longer holds, so the next pass re-arms the row now instead of waiting it out.
      const slow = await suDb.agent.findFirstOrThrow({
        where: { tenantId, name: "slow" },
        select: { id: true, settings: true },
      });
      await suDb.agent.update({
        where: { id: slow.id },
        data: {
          settings: {
            followUp: {
              enabled: true,
              steps: [
                { delayValue: 1, delayUnit: "minutes", instructions: "a" },
              ],
            },
          },
        },
      });
      const before = Date.now();
      await runSweep();
      const rearmed = await rowOf(CONV_SLOW);
      expect(rearmed?.payload).toEqual({
        threadId: threadOf(CONV_SLOW),
        episode: await episodeOf(CONV_SLOW),
      });
      expect(rearmed?.runAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(rearmed?.runAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      await suDb.agent.update({
        where: { id: slow.id },
        data: { settings: slow.settings ?? {} },
      });
    });

    // The schedule is the other input of a deferral, and it lives in its own row: editing the hours
    // moves the version as well, while a deferral under the current version is left alone.
    test("editing the schedule a deferral was computed from re-arms it; the same schedule keeps it", async () => {
      const hours = await suDb.businessHours.create({
        data: { tenantId, name: "fu796" },
      });
      const agent = await suDb.agent.findFirstOrThrow({
        where: { tenantId, name: "slow" },
        select: { id: true },
      });
      const { updatedAt: agentAt } = await suDb.agent.update({
        where: { id: agent.id },
        data: { followUpHoursId: hours.id },
        select: { updatedAt: true },
      });
      await seedIdle(CONV_HOURS, INBOX_SLOW);
      const later = new Date(Date.now() + 6 * 60 * 60_000);
      const payload = {
        threadId: threadOf(CONV_HOURS),
        episode: await episodeOf(CONV_HOURS),
        deferredUnder: followUpConfigVersion(agentAt, hours.updatedAt),
      };
      await enqueueJob({
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: keyOf(CONV_HOURS),
        runAt: later,
        payload,
        rearm: "same-work",
        base: appDb,
      });
      try {
        await runSweep();
        const kept = await rowOf(CONV_HOURS);
        expect(kept?.runAt.getTime()).toBe(later.getTime());
        expect(kept?.payload).toEqual(payload);

        await suDb.businessHours.update({
          where: { id: hours.id },
          data: { timezone: "UTC" },
        });
        await runSweep();
        const rearmed = await rowOf(CONV_HOURS);
        expect(rearmed?.payload).toEqual({
          threadId: threadOf(CONV_HOURS),
          episode: await episodeOf(CONV_HOURS),
        });
        expect(rearmed?.runAt.getTime()).toBeLessThanOrEqual(Date.now());
      } finally {
        await suDb.agent.update({
          where: { id: agent.id },
          data: { followUpHoursId: null },
        });
      }
    });
  },
);
