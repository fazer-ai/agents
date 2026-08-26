import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  type ClaimedJob,
  claimDueJobs,
  completeJob,
  enqueueJob,
  failJob,
  reapStaleJobs,
  rescheduleJob,
} from "@/modules/scheduler/service";
import { registerJobHandler, runClaimed } from "@/modules/scheduler/worker";

// Issue #164. A scheduler row is re-armed IN PLACE — `enqueueJob` upserts the same physical row back
// to PENDING — so "the row is CLAIMED" never said WHICH run holds the claim. Every write that
// finishes a job CAS'd on (id, status = 'CLAIMED') and nothing more, which means a run that finished
// after its row had been re-armed AND re-claimed landed on the newer claim: the arm was marked DONE
// and the work it stood for was done by nobody.
//
// The ordering that produces it is entirely ordinary and needs one process: a handler runs long
// enough for something to re-arm its key, and one tick later the row is claimed again. #163 is the
// same shape with a customer-visible ending (an edit to a knowledge-base document, silently
// discarded), fixed inside the RAG handler; this is the question asked once, for all ten kinds.
//
// What the tests below pin is the STALE side, because the live side is what the old code already
// did. Each one drives a real row through a real claim, so the token under test is the one the claim
// SQL actually issued rather than a number the test picked.

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
const past = () => new Date(Date.now() - 60_000);

async function rowOf(id: bigint) {
  return suDb.schedulerJob.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      attempts: true,
      claimSeq: true,
      runAt: true,
      lastError: true,
    },
  });
}

// The sequence the whole issue is about, set up once: a job is claimed, re-armed while that claim is
// still notionally held, and claimed AGAIN. The first claim's token is now stale, and the row is
// CLAIMED by someone else — which is precisely the state in which the old guard said yes.
async function staleAndCurrent(
  dedupeKey: string,
): Promise<{ id: bigint; stale: ClaimedJob; current: ClaimedJob }> {
  const id = await enqueueJob({
    rearm: "same-work",
    tenantId,
    kind: "WEBHOOK_RETRY",
    dedupeKey,
    runAt: past(),
    base: appDb,
  });
  const first = await claimDueJobs(10, appDb, new Date(), tenantId);
  const stale = first.find((j) => j.id === id) as ClaimedJob;
  expect(stale).toBeDefined();

  await enqueueJob({
    rearm: "same-work",
    tenantId,
    kind: "WEBHOOK_RETRY",
    dedupeKey,
    runAt: past(),
    base: appDb,
  });
  const second = await claimDueJobs(10, appDb, new Date(), tenantId);
  const current = second.find((j) => j.id === id) as ClaimedJob;
  expect(current).toBeDefined();
  return { id, stale, current };
}

describe.skipIf(!dbUp)("scheduler claim token", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CLAIMTOK", slug: `claimtok-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("the claim issues a new token every time, and the re-arm does not", async () => {
    const { id, stale, current } = await staleAndCurrent("tok-monotonic");
    // The whole guard rests on these two being different. A token that repeated across claims would
    // let every assertion below pass while protecting nothing.
    expect(current.claimSeq).toBeGreaterThan(stale.claimSeq);
    expect((await rowOf(id)).claimSeq).toBe(current.claimSeq);
  });

  test("a superseded run cannot complete the arm that replaced it", async () => {
    const { id, stale, current } = await staleAndCurrent("tok-complete");
    // `applied` is the only thing the superseded run can learn. Refusing in silence would leave the
    // ordering exactly as invisible as it was before the token, which is what #164 is about.
    expect(
      await completeJob(tenantId, id, stale.claimSeq, "FOLLOWUP", appDb),
    ).toEqual({
      applied: false,
    });
    // Still CLAIMED: the arm belongs to the run that is working on it right now, and the work it
    // stands for has not been done. Under the old guard this row read DONE and nothing ever ran it.
    expect((await rowOf(id)).status).toBe("CLAIMED");

    expect(
      await completeJob(tenantId, id, current.claimSeq, "FOLLOWUP", appDb),
    ).toEqual({
      applied: true,
    });
    expect((await rowOf(id)).status).toBe("DONE");
  });

  test("a superseded run cannot fail the arm that replaced it", async () => {
    const { id, stale, current } = await staleAndCurrent("tok-fail");
    const before = await rowOf(id);
    const refused = await failJob(
      tenantId,
      id,
      stale.claimSeq,
      before.attempts,
      "boom",
      appDb,
    );
    expect(refused.deadLettered).toBe(false);
    // `applied` has to be reported SEPARATELY: deadLettered is false for a healthy non-terminal
    // retry too, so on its own it cannot tell a recorded failure from a refused one.
    expect(refused.applied).toBe(false);
    const after = await rowOf(id);
    // Nothing of the failure sticks: not the status, not the retry budget, not the error text. A
    // stale failure that spent an attempt would walk an otherwise healthy key toward DEAD.
    expect(after.status).toBe("CLAIMED");
    expect(after.attempts).toBe(before.attempts);
    expect(after.lastError).toBeNull();

    // And the live run's failure IS recorded, with the same two fields saying different things.
    const landed = await failJob(
      tenantId,
      id,
      current.claimSeq,
      before.attempts,
      "boom",
      appDb,
    );
    expect(landed.applied).toBe(true);
    expect(landed.deadLettered).toBe(false);
    expect((await rowOf(id)).lastError).toBe("boom");
  });

  test("a superseded run cannot push the arm that replaced it into the future", async () => {
    const { id, stale } = await staleAndCurrent("tok-reschedule");
    const before = await rowOf(id);
    const far = new Date(Date.now() + 86_400_000);
    expect(
      await rescheduleJob(tenantId, id, stale.claimSeq, far, undefined, appDb),
    ).toEqual({ applied: false });
    const after = await rowOf(id);
    expect(after.status).toBe("CLAIMED");
    expect(after.runAt.getTime()).toBe(before.runAt.getTime());
  });

  test("the reaper does not issue a token, so the run it declared dead stays out", async () => {
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "tok-reap",
      runAt: past(),
      base: appDb,
    });
    const claimed = await claimDueJobs(10, appDb, new Date(), tenantId);
    const mine = claimed.find((j) => j.id === id) as ClaimedJob;
    expect(mine).toBeDefined();
    await suDb.schedulerJob.update({
      where: { id },
      data: { claimedAt: new Date(Date.now() - 600_000) },
    });
    const reaped = await reapStaleJobs(
      60_000,
      suDb,
      new Date(),
      tenantId,
      "WEBHOOK_RETRY",
    );
    expect(reaped.some((r) => r.id === id)).toBe(true);
    // The reap re-pends without bumping, and it does not have to: the hung run's CAS also asks for
    // CLAIMED, which a re-pended row is not. What must not happen is the run coming back and marking
    // the re-pended row DONE.
    expect(
      await completeJob(tenantId, id, mine.claimSeq, "FOLLOWUP", appDb),
    ).toEqual({
      applied: false,
    });
    expect((await rowOf(id)).status).toBe("PENDING");
  });

  test("a handler whose key is re-armed mid-run leaves the new arm runnable", async () => {
    // The end the issue is about, through the worker rather than through the three writes directly:
    // the handler is what takes time, and the re-arm is what lands while it does. The observable
    // effect is that the arm is still there to be run afterwards, by anybody.
    let armedDuring = false;
    registerJobHandler("HEARTBEAT", async (job) => {
      if (!armedDuring) {
        armedDuring = true;
        await enqueueJob({
          rearm: "same-work",
          tenantId: job.tenantId,
          kind: "HEARTBEAT",
          dedupeKey: "tok-handler",
          runAt: past(),
          base: appDb,
        });
        await claimDueJobs(10, appDb, new Date(), tenantId);
      }
      return { outcome: "done" };
    });

    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "HEARTBEAT",
      dedupeKey: "tok-handler",
      runAt: past(),
      base: appDb,
    });
    const claimed = await claimDueJobs(10, appDb, new Date(), tenantId);
    const mine = claimed.find((j) => j.id === id) as ClaimedJob;
    expect(mine).toBeDefined();

    await runClaimed(mine, appDb);

    // DONE here would mean the re-arm was consumed by the run that never saw it.
    expect((await rowOf(id)).status).toBe("CLAIMED");
  });
});
