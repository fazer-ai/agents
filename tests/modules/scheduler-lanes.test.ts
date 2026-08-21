import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { JOB_LANE, type SchedulerLane } from "@/modules/scheduler/lanes";
import {
  claimDueCompactionJobs,
  claimDueDebounceJobs,
  claimDueJobs,
  enqueueJob,
  type SchedulerJobKind,
} from "@/modules/scheduler/service";
import {
  registerJobHandler,
  runSchedulerTick,
} from "@/modules/scheduler/worker";

// Issue #165. Two things are asserted here, and they are the two halves of the rule in lanes.ts.
//
// The PARTITION, against the database rather than against the map. The map is the thing under test
// only in the sense that the SQL is derived from it: a test that read `JOB_LANE` and counted would
// be green on a map that is right and a filter that is wrong, which is the shape of every table that
// was never checked against its consumer. So every kind is enqueued for real and every lane claims
// for real, and the assertion is on which lane got which row.
//
// The DRAIN, because "the shared lane is concurrent" is a claim about ordering that no unit test of
// a pure function can make. The handlers below deadlock a serial drain on purpose: the first job
// cannot finish until the second one starts. Serially that is a hang; concurrently it is a pass.

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

// Written out ON PURPOSE instead of derived from JOB_LANE. Deriving would make this test a mirror:
// move a kind to the wrong lane in the source and the expectation moves with it, so the run stays
// green while APPOINTMENT_REMINDER quietly drains on the debounce tick. Stated here, the source and
// the expectation have to be changed by two separate deliberate edits.
const EXPECTED_LANE: Record<SchedulerJobKind, SchedulerLane> = {
  FOLLOWUP: "shared",
  FOLLOWUP_SWEEP: "shared",
  WEBHOOK_RETRY: "shared",
  RAG_INGEST: "shared",
  HEARTBEAT: "shared",
  FLOWLOG_SWEEP: "shared",
  APPOINTMENT_REMINDER: "shared",
  REDIRECT_FOLLOWUP: "shared",
  DEBOUNCE: "debounce",
  MEMORY_COMPACT: "compaction",
};

const ALL_KINDS = Object.keys(EXPECTED_LANE) as SchedulerJobKind[];

describe.skipIf(!dbUp)("scheduler lanes", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "LANES", slug: `lanes-${process.pid}` },
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

  test("every kind is claimed by exactly one lane, and by the one the table names", async () => {
    const ids = new Map<bigint, SchedulerJobKind>();
    for (const kind of ALL_KINDS) {
      const id = await enqueueJob({
        tenantId,
        kind,
        dedupeKey: `lane-${kind}`,
        runAt: past(),
        base: appDb,
      });
      ids.set(id, kind);
    }

    const claimedBy = new Map<SchedulerJobKind, SchedulerLane[]>();
    const record = (lane: SchedulerLane, jobs: { id: bigint }[]) => {
      for (const j of jobs) {
        const kind = ids.get(j.id);
        if (!kind) continue;
        claimedBy.set(kind, [...(claimedBy.get(kind) ?? []), lane]);
      }
    };
    record("shared", await claimDueJobs(50, appDb, new Date(), tenantId));
    record(
      "debounce",
      await claimDueDebounceJobs(50, appDb, new Date(), tenantId),
    );
    record(
      "compaction",
      await claimDueCompactionJobs(50, appDb, new Date(), tenantId),
    );

    // Exactly one, both directions: a kind in no lane never runs, and a kind in two is claimed twice.
    // The old shared filter was a NOT IN, so a kind that got its own lane and was not excluded there
    // landed in both, and one that was excluded without getting a lane landed in neither.
    for (const kind of ALL_KINDS) {
      expect(claimedBy.get(kind) ?? []).toEqual([EXPECTED_LANE[kind]]);
    }
    // And the source table agrees with it, which is what makes a kind added to the enum fail here
    // rather than silently inherit whatever lane its neighbour has.
    expect(JOB_LANE).toEqual(EXPECTED_LANE);
  });

  test("the shared lane drains its batch concurrently", async () => {
    // Two jobs that can only both finish if they run at the same time. `first` refuses to return
    // until `second` has started, so a serial drain never gets to `second` and this test times out.
    let releaseFirst: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let bothRan = false;

    registerJobHandler("HEARTBEAT", async () => {
      await secondStarted;
      return { outcome: "done" };
    });
    registerJobHandler("FLOWLOG_SWEEP", async () => {
      bothRan = true;
      releaseFirst?.();
      return { outcome: "done" };
    });

    await enqueueJob({
      tenantId,
      kind: "HEARTBEAT",
      dedupeKey: "drain-first",
      runAt: new Date(Date.now() - 120_000),
      base: appDb,
    });
    await enqueueJob({
      tenantId,
      kind: "FLOWLOG_SWEEP",
      dedupeKey: "drain-second",
      runAt: new Date(Date.now() - 60_000),
      base: appDb,
    });

    // A serial drain hangs here rather than failing an assertion, so the deadline is the assertion.
    const tick = runSchedulerTick(appDb, { staleMs: 300_000, batchSize: 20 });
    const timedOut = Symbol("timeout");
    const outcome = await Promise.race([
      tick.then(() => "finished" as const),
      new Promise<typeof timedOut>((r) => setTimeout(() => r(timedOut), 5_000)),
    ]);
    expect(outcome).toBe("finished");
    expect(bothRan).toBe(true);
  }, 15_000);
});
