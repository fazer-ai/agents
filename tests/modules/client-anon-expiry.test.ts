import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { getCheckpointer } from "@/graph/checkpointer";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
import type { TenantContext } from "@/lib/tenancy";
import {
  clientAnonSweepHandler,
  type ExpiringApp,
  ensureClientAnonSweep,
  expireAnonymousThreads,
  expiryCutoff,
} from "@/modules/client-apps/expiry";
import {
  createClientApp,
  deleteClientApp,
} from "@/modules/client-apps/service";
import { leaseClientThread } from "@/modules/client-channel/identity";
import { type ClaimedJob, completeJob } from "@/modules/scheduler/service";
import { dbProbeFailed } from "@/tests/db-gate";

// Idle anonymous conversations expire, in the real tables through the runtime role (RLS on), with
// the checkpointer replaced by a recorder. What this file proves: only this app's anonymous
// conversations past the term go, with their checkpoint and then their user once no thread is left;
// a conversation handed over to a signed-in user, a fresh one, one a round-trip holds and one a turn
// reached during the sweep stay; a checkpoint that fails to delete keeps its row for the next pass;
// a conversation with a call billed this month stays until the month is over; creating an app arms the tenant's job, and
// the job ends once the tenant has no app.

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

const NOW = new Date(Date.UTC(2026, 9, 25, 12));
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

let tenantId = 0n;
let agentId = 0n;
let ctx: TenantContext;

async function conversation(
  externalId: string,
  lastTurnAt: Date,
  extra: { activeUntil?: Date; lastSeenAt?: Date } = {},
): Promise<string> {
  const user = await suDb.externalUser.upsert({
    where: {
      tenantId_channel_externalId: { tenantId, channel: "client", externalId },
    },
    create: {
      tenantId,
      channel: "client",
      externalId,
      lastSeenAt: extra.lastSeenAt ?? lastTurnAt,
    },
    update: {},
    select: { id: true },
  });
  const threadId = `${tenantId}:client:${agentId}:${crypto.randomUUID()}`;
  await suDb.detachedThread.create({
    data: {
      threadId,
      tenantId,
      agentId,
      kind: "client",
      externalUserId: user.id,
      lastTurnAt,
      ...(extra.activeUntil
        ? { activeTurnId: "turno", activeUntil: extra.activeUntil }
        : {}),
    },
  });
  return threadId;
}

function recorder(fail: Set<string> = new Set()) {
  const deleted: string[] = [];
  return {
    deleted,
    checkpointer: {
      deleteThread: async (threadId: string) => {
        if (fail.has(threadId)) throw new Error("checkpointer down");
        deleted.push(threadId);
      },
    },
  };
}

// The ids a whole pass expired.
const expireIds = async (
  p: Parameters<typeof expireAnonymousThreads>[0],
): Promise<string[]> => (await expireAnonymousThreads(p)).expired;

const exists = async (threadId: string) =>
  (await suDb.detachedThread.count({ where: { threadId } })) === 1;
const userExists = async (externalId: string) =>
  (await suDb.externalUser.count({
    where: { tenantId, channel: "client", externalId },
  })) === 1;

describe.skipIf(!dbUp)("idle anonymous conversations expire", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "CAE", slug: `cae-${process.pid}` },
      })
    ).id;
    ctx = { tenantId, userId: null, role: "TENANT_ADMIN" };
    agentId = (
      await suDb.agent.create({
        data: { tenantId, name: "a", systemPrompt: "x", modelConfig: {} },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) await suDb.tenant.deleteMany({ where: { id: tenantId } });
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  test("only this app's anonymous conversations past the term go, checkpoint and user with them", async () => {
    const appId = 9001n;
    const a: ExpiringApp = {
      id: appId,
      anonExpiryDays: 30,
    };
    const expired = await conversation(`anon:${appId}:velho`, daysAgo(31));
    const fresh = await conversation(`anon:${appId}:novo`, daysAgo(29));
    const handedOver = await conversation(`app:${appId}:42`, daysAgo(90));
    const otherApp = await conversation(`anon:${appId}0:vizinho`, daysAgo(90));
    const held = await conversation(`anon:${appId}:ocupado`, daysAgo(60), {
      activeUntil: new Date(NOW.getTime() + 60_000),
    });
    const staleClaim = await conversation(
      `anon:${appId}:largado`,
      daysAgo(60),
      {
        activeUntil: daysAgo(59),
      },
    );
    // One user keeps a fresh conversation beside an expired one; one was seen lately with none left.
    const keptOld = await conversation(`anon:${appId}:dois`, daysAgo(40));
    await conversation(`anon:${appId}:dois`, daysAgo(1));
    const seenLately = await conversation(`anon:${appId}:visto`, daysAgo(40), {
      lastSeenAt: daysAgo(2),
    });
    const { deleted, checkpointer } = recorder();
    const result = await expireIds({
      ctx,
      app: a,
      base: appDb,
      checkpointer,
      now: NOW,
    });
    expect({
      result: [...result].sort(),
      checkpoints: [...deleted].sort(),
      rows: {
        expired: await exists(expired),
        fresh: await exists(fresh),
        handedOver: await exists(handedOver),
        otherApp: await exists(otherApp),
        held: await exists(held),
        staleClaim: await exists(staleClaim),
        keptOld: await exists(keptOld),
        seenLately: await exists(seenLately),
      },
      users: {
        velho: await userExists(`anon:${appId}:velho`),
        largado: await userExists(`anon:${appId}:largado`),
        dois: await userExists(`anon:${appId}:dois`),
        visto: await userExists(`anon:${appId}:visto`),
        ocupado: await userExists(`anon:${appId}:ocupado`),
      },
    }).toEqual({
      result: [expired, staleClaim, keptOld, seenLately].sort(),
      checkpoints: [expired, staleClaim, keptOld, seenLately].sort(),
      rows: {
        expired: false,
        fresh: true,
        handedOver: true,
        otherApp: true,
        held: true,
        staleClaim: false,
        keptOld: false,
        seenLately: false,
      },
      users: {
        velho: false,
        largado: false,
        dois: true,
        visto: true,
        ocupado: true,
      },
    });
  });

  test("an expired conversation's transcript goes with it, a kept one's stays", async () => {
    const appId = 9002n;
    const a: ExpiringApp = { id: appId, anonExpiryDays: 30 };
    const expired = await conversation(`anon:${appId}:velho`, daysAgo(31));
    const fresh = await conversation(`anon:${appId}:novo`, daysAgo(1));
    for (const threadId of [expired, fresh])
      await suDb.clientThreadMessage.create({
        data: { tenantId, threadId, role: "user", text: "oi" },
      });
    const { checkpointer } = recorder();
    await expireIds({ ctx, app: a, base: appDb, checkpointer, now: NOW });
    const messages = (threadId: string) =>
      suDb.clientThreadMessage.count({ where: { threadId } });
    expect({
      expired: await messages(expired),
      fresh: await messages(fresh),
    }).toEqual({ expired: 0, fresh: 1 });
  });

  test("a checkpoint that fails to delete keeps its row for the next pass", async () => {
    const appId = 9002n;
    const thread = await conversation(`anon:${appId}:falha`, daysAgo(40));
    const first = recorder(new Set([thread]));
    const a: ExpiringApp = {
      id: appId,
      anonExpiryDays: 30,
    };
    const kept = await expireIds({
      ctx,
      app: a,
      base: appDb,
      checkpointer: first.checkpointer,
      now: NOW,
    });
    const stillThere = await exists(thread);
    const second = recorder();
    const gone = await expireIds({
      ctx,
      app: a,
      base: appDb,
      checkpointer: second.checkpointer,
      now: NOW,
    });
    expect({ kept, stillThere, gone, after: await exists(thread) }).toEqual({
      kept: [],
      stillThere: true,
      gone: [thread],
      after: false,
    });
  });

  test("a turn that reaches the conversation during the sweep keeps it", async () => {
    const appId = 9003n;
    const thread = await conversation(`anon:${appId}:volta`, daysAgo(40));
    let touched = false;
    const racing = appDb.$extends({
      query: {
        detachedThread: {
          async findMany({ args, query }) {
            const found = await query(args);
            if (!touched) {
              touched = true;
              await suDb.detachedThread.update({
                where: { threadId: thread },
                data: { lastTurnAt: NOW },
              });
            }
            return found;
          },
        },
      },
    }) as unknown as PrismaClient;
    const { deleted, checkpointer } = recorder();
    const result = await expireIds({
      ctx,
      app: { id: appId, anonExpiryDays: 30 },
      base: racing,
      checkpointer,
      now: NOW,
    });
    expect({ touched, result, deleted, row: await exists(thread) }).toEqual({
      touched: true,
      result: [],
      deleted: [],
      row: true,
    });
  });

  test("a conversation handed over to a signed-in user during the sweep stays", async () => {
    const appId = 9005n;
    const thread = await conversation(`anon:${appId}:entra`, daysAgo(40));
    const signedIn = await suDb.externalUser.create({
      data: { tenantId, channel: "client", externalId: `app:${appId}:7` },
      select: { id: true },
    });
    let moved = false;
    const racing = appDb.$extends({
      query: {
        detachedThread: {
          async findMany({ args, query }) {
            const found = await query(args);
            if (!moved) {
              moved = true;
              await suDb.detachedThread.update({
                where: { threadId: thread },
                data: { externalUserId: signedIn.id },
              });
            }
            return found;
          },
        },
      },
    }) as unknown as PrismaClient;
    const { deleted, checkpointer } = recorder();
    const result = await expireIds({
      ctx,
      app: { id: appId, anonExpiryDays: 30 },
      base: racing,
      checkpointer,
      now: NOW,
    });
    expect({ moved, result, deleted, row: await exists(thread) }).toEqual({
      moved: true,
      result: [],
      deleted: [],
      row: true,
    });
  });

  test("a conversation with a call billed this month stays until the month is over", async () => {
    const appId = 9004n;
    const a: ExpiringApp = { id: appId, anonExpiryDays: 7 };
    // Both idle since mid-September; one turn's call was billed after the month turned.
    const billedNow = await conversation(`anon:${appId}:virou`, daysAgo(40));
    const billedBefore = await conversation(`anon:${appId}:antes`, daysAgo(40));
    await suDb.llmUsage.createMany({
      data: [
        {
          tenantId,
          model: "m",
          source: "client",
          threadId: billedNow,
          costUsd: 1,
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 5)),
        },
        {
          tenantId,
          model: "m",
          source: "client",
          threadId: billedBefore,
          costUsd: 1,
          createdAt: daysAgo(40),
        },
      ],
    });
    const { checkpointer } = recorder();
    const october = await expireIds({
      ctx,
      app: a,
      base: appDb,
      checkpointer,
      now: NOW,
    });
    const keptInOctober = await exists(billedNow);
    const november = await expireIds({
      ctx,
      app: a,
      base: appDb,
      checkpointer,
      now: new Date(Date.UTC(2026, 10, 2)),
    });
    expect({
      cutoff: expiryCutoff(a, NOW).toISOString(),
      october,
      keptInOctober,
      november,
    }).toEqual({
      cutoff: daysAgo(7).toISOString(),
      october: [billedBefore],
      keptInOctober: true,
      november: [billedNow],
    });
  });

  test("pages past the threads it keeps, so a page full of them does not stop the pass", async () => {
    const appId = 9007n;
    const kept: string[] = [];
    const gone: string[] = [];
    for (let i = 0; i < 5; i++) {
      const thread = await conversation(`anon:${appId}:p${i}`, daysAgo(60 - i));
      if (i < 3) kept.push(thread);
      else gone.push(thread);
    }
    // The three oldest had a call billed this month, so the first pages hold only threads it keeps.
    await suDb.llmUsage.createMany({
      data: kept.map((threadId) => ({
        tenantId,
        model: "m",
        source: "client",
        threadId,
        costUsd: 1,
        createdAt: daysAgo(1),
      })),
    });
    const { checkpointer } = recorder();
    const result = await expireIds({
      ctx,
      app: { id: appId, anonExpiryDays: 30 },
      base: appDb,
      checkpointer,
      now: NOW,
      batch: 2,
    });
    // The two whose conversations went are removed too, in batches of the same size.
    const users = await suDb.externalUser.count({
      where: { tenantId, externalId: { startsWith: `anon:${appId}:` } },
    });
    expect({
      result: [...result].sort(),
      kept: await Promise.all(kept.map(exists)),
      users,
    }).toEqual({
      result: [...gone].sort(),
      kept: [true, true, true],
      users: 3,
    });
  });

  test("idle users with no conversation go in batches until none is left", async () => {
    const appId = 9010n;
    await suDb.externalUser.createMany({
      data: [0, 1, 2, 3, 4].map((i) => ({
        tenantId,
        channel: "client",
        externalId: `anon:${appId}:u${i}`,
        lastSeenAt: daysAgo(90),
      })),
    });
    const { checkpointer } = recorder();
    await expireAnonymousThreads({
      ctx,
      app: { id: appId, anonExpiryDays: 30 },
      base: appDb,
      checkpointer,
      now: NOW,
      batch: 2,
    });
    expect(
      await suDb.externalUser.count({
        where: { tenantId, externalId: { startsWith: `anon:${appId}:` } },
      }),
    ).toBe(0);
  });

  test("a user a turn reaches between the read and the delete stays", async () => {
    const appId = 9011n;
    const user = await suDb.externalUser.create({
      data: {
        tenantId,
        channel: "client",
        externalId: `anon:${appId}:volta`,
        lastSeenAt: daysAgo(90),
      },
      select: { id: true },
    });
    let touched = false;
    const racing = appDb.$extends({
      query: {
        externalUser: {
          async findMany({ args, query }) {
            const found = await query(args);
            if (!touched) {
              touched = true;
              await suDb.externalUser.update({
                where: { id: user.id },
                data: { lastSeenAt: NOW },
              });
            }
            return found;
          },
        },
      },
    }) as unknown as PrismaClient;
    const { checkpointer } = recorder();
    await expireAnonymousThreads({
      ctx,
      app: { id: appId, anonExpiryDays: 30 },
      base: racing,
      checkpointer,
      now: NOW,
    });
    expect({
      touched,
      kept: await userExists(`anon:${appId}:volta`),
    }).toEqual({ touched: true, kept: true });
  });

  test("a run out of time hands the rest to the next run, which resumes where it stopped", async () => {
    const appId = 9008n;
    const threads: string[] = [];
    for (let i = 0; i < 3; i++)
      threads.push(await conversation(`anon:${appId}:t${i}`, daysAgo(80 - i)));
    const { checkpointer } = recorder();
    const app: ExpiringApp = { id: appId, anonExpiryDays: 30 };
    // No time at all: it stops before the first thread and says where to start.
    const stopped = await expireAnonymousThreads({
      ctx,
      app,
      base: appDb,
      checkpointer,
      now: NOW,
      stopAt: 0,
    });
    // An app with nothing to expire stops all the same, before its first query.
    const empty = await expireAnonymousThreads({
      ctx,
      app: { id: 9099n, anonExpiryDays: 30 },
      base: appDb,
      checkpointer,
      now: NOW,
      stopAt: 0,
    });
    // Resumed after the first thread: the first is left for the next full pass.
    const resumed = await expireAnonymousThreads({
      ctx,
      app,
      base: appDb,
      checkpointer,
      now: NOW,
      start: { lastTurnAt: daysAgo(80), threadId: threads[0] as string },
    });
    expect({
      stopped: [stopped.expired, stopped.stopped, stopped.resumeAt],
      empty: empty.stopped,
      resumed: [...resumed.expired].sort(),
      resumedStopped: resumed.stopped,
      first: await exists(threads[0] as string),
    }).toEqual({
      stopped: [[], true, null],
      empty: true,
      resumed: [threads[1] as string, threads[2] as string].sort(),
      resumedStopped: false,
      first: true,
    });
  });

  test("a thread claimed by a pass that stopped refuses turns and is finished by the next pass", async () => {
    const appId = 9006n;
    const thread = await conversation(`anon:${appId}:meio`, daysAgo(40));
    const failing = recorder(new Set([thread]));
    const a: ExpiringApp = {
      id: appId,
      anonExpiryDays: 30,
    };
    await expireIds({
      ctx,
      app: a,
      base: appDb,
      checkpointer: failing.checkpointer,
      now: NOW,
    });
    // A message arrives meanwhile: the row is fresh again, but the claim holds.
    await suDb.detachedThread.update({
      where: { threadId: thread },
      data: { lastTurnAt: NOW },
    });
    const leased = await leaseClientThread({
      ctx,
      threadId: thread,
      turnId: "turno-novo",
      base: appDb,
      leaseMs: 60_000,
      // NOTE: a day later: the claim holds for good, not for a lease's length.
      now: new Date(NOW.getTime() + 86_400_000),
    });
    const next = recorder();
    const finished = await expireIds({
      ctx,
      app: a,
      base: appDb,
      checkpointer: next.checkpointer,
      now: NOW,
    });
    expect({ leased, finished, row: await exists(thread) }).toEqual({
      leased: false,
      finished: [thread],
      row: false,
    });
  });

  test("re-arming keeps a pending pass's time, and arms again once the pass is over", async () => {
    await ensureClientAnonSweep(tenantId, appDb);
    const first = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, kind: "CLIENT_ANON_SWEEP" },
      select: { id: true, runAt: true },
    });
    await new Promise((r) => setTimeout(r, 5));
    await ensureClientAnonSweep(tenantId, appDb);
    const kept = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: first.id },
      select: { runAt: true },
    });
    await suDb.schedulerJob.update({
      where: { id: first.id },
      data: { status: "DONE" },
    });
    await ensureClientAnonSweep(tenantId, appDb);
    const rearmed = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: first.id },
      select: { status: true },
    });
    // A pass running now (it may have read no app just before one was created) is re-armed, and its
    // own outcome no longer lands.
    const running = await suDb.schedulerJob.update({
      where: { id: first.id },
      data: { status: "CLAIMED", claimSeq: { increment: 1 } },
      select: { claimSeq: true },
    });
    await ensureClientAnonSweep(tenantId, appDb);
    const ended = await completeJob(
      tenantId,
      first.id,
      running.claimSeq,
      "CLIENT_ANON_SWEEP",
      appDb,
    );
    const afterRunning = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: first.id },
      select: { status: true },
    });
    expect({
      kept: kept.runAt.getTime() === first.runAt.getTime(),
      rearmed: rearmed.status,
      endedApplied: ended.applied,
      afterRunning: afterRunning.status,
    }).toEqual({
      kept: true,
      rearmed: "PENDING",
      endedApplied: false,
      afterRunning: "PENDING",
    });
  });

  test("creating an app arms the tenant's sweep, a deleted app's conversations go at once, and the sweep ends once nothing is left", async () => {
    // NOTE: the earlier cases' users name apps that do not exist, which the handler treats as
    // deleted apps; this case starts from none.
    await suDb.externalUser.deleteMany({ where: { tenantId } });
    const { app: created } = await createClientApp(
      ctx,
      agentId,
      { name: "Expira", allowedOrigins: ["https://x.exemplo.com"] },
      appDb,
    );
    const jobs = await suDb.schedulerJob.findMany({
      where: { tenantId, kind: "CLIENT_ANON_SWEEP" },
      select: { dedupeKey: true },
    });
    // A real checkpoint on a conversation idle for 40 days, deleted through the real checkpointer.
    const idle = await conversation(
      `anon:${created.id}:real`,
      new Date(Date.now() - 40 * 86_400_000),
    );
    const checkpointer = await getCheckpointer();
    await buildThreadStateGraph(checkpointer).updateState(
      { configurable: { thread_id: idle } },
      { messages: [new HumanMessage("oi")] },
      THREAD_STATE_NODE,
    );
    const seeded =
      (await checkpointer.get({ configurable: { thread_id: idle } })) !==
      undefined;
    const job = { tenantId, payload: {} } as unknown as ClaimedJob;
    // A run resuming at a later app leaves the earlier ones for the next full pass.
    await clientAnonSweepHandler(
      {
        ...job,
        payload: { cursor: { appId: String(BigInt(created.id) + 1000n) } },
      },
      appDb,
    );
    const idleAfterLaterCursor = await exists(idle);
    // With no time, the run hands the whole pass to the next one, a minute out, from the first app.
    const handed = await clientAnonSweepHandler(job, appDb, { budgetMs: 0 });
    const handedCursor =
      handed.outcome === "reschedule"
        ? (handed.payload as { cursor?: { appId?: string } } | undefined)
            ?.cursor?.appId
        : undefined;
    const handedSoon =
      handed.outcome === "reschedule" &&
      handed.runAt.getTime() - Date.now() < 120_000;
    const idleAfterHand = await exists(idle);
    const withAppResult = await clientAnonSweepHandler(
      {
        ...job,
        payload: handed.outcome === "reschedule" ? (handed.payload ?? {}) : {},
      },
      appDb,
    );
    const withApp = withAppResult.outcome;
    const clearedCursor =
      withAppResult.outcome === "reschedule" ? withAppResult.payload : null;
    const checkpointLeft =
      (await checkpointer.get({ configurable: { thread_id: idle } })) !==
      undefined;
    const rowLeft = await exists(idle);
    // A conversation from a minute ago outlives its app only until the next pass.
    const recent = await conversation(
      `anon:${created.id}:recente`,
      new Date(Date.now() - 60_000),
    );
    // NOTE: a sweep that had ended (the tenant's last app gone before) is armed again by the delete.
    await suDb.schedulerJob.updateMany({
      where: { tenantId, kind: "CLIENT_ANON_SWEEP" },
      data: { status: "DONE" },
    });
    await deleteClientApp(ctx, BigInt(created.id), appDb);
    const armedByDelete = (
      await suDb.schedulerJob.findFirstOrThrow({
        where: { tenantId, kind: "CLIENT_ANON_SWEEP" },
        select: { status: true },
      })
    ).status;
    const afterDelete = (await clientAnonSweepHandler(job, appDb)).outcome;
    const recentLeft = await exists(recent);
    const recentUser = await userExists(`anon:${created.id}:recente`);
    const without = (await clientAnonSweepHandler(job, appDb)).outcome;
    expect({
      jobs: jobs.map((j) => j.dedupeKey),
      idleAfterLaterCursor,
      handedCursor,
      handedSoon,
      idleAfterHand,
      clearedCursor,
      seeded,
      withApp,
      checkpointLeft,
      rowLeft,
      armedByDelete,
      afterDelete,
      recentLeft,
      recentUser,
      without,
      days: created.anonExpiryDays,
    }).toEqual({
      jobs: ["client-anon-sweep"],
      idleAfterLaterCursor: true,
      handedCursor: created.id,
      handedSoon: true,
      idleAfterHand: true,
      clearedCursor: {},
      seeded: true,
      withApp: "reschedule",
      checkpointLeft: false,
      rowLeft: false,
      armedByDelete: "PENDING",
      afterDelete: "reschedule",
      recentLeft: false,
      recentUser: false,
      without: "done",
      days: 30,
    });
  });
});
