import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import {
  JOB_DEATH_LEVEL,
  JOB_DELETE_ON_DONE,
  JOB_LANE,
  JOB_SPENDS_PROVIDER,
  JOB_TRAFFIC_PROPORTIONAL,
  type SchedulerLane,
  sharedProviderConcurrency,
} from "@/modules/scheduler/lanes";
import {
  claimDueCompactionJobs,
  claimDueDebounceJobs,
  claimDueJobs,
  claimDueTrafficJobs,
  enqueueJob,
  type SchedulerJobKind,
} from "@/modules/scheduler/service";
import {
  getJobHandler,
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
//
// Both tests fence on this file's tenant. The claim is cross-tenant by design, so a second DB-backed
// suite running at the same time is not a hypothetical: its rows fill the batch, and a deadlock test
// whose pair never got claimed together times out exactly like a serial drain would.

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
  // Shared: the turn drains its own thread before invoking (issue #194), so the tick cadence stops
  // deciding correctness — and the debounce lane can be switched off entirely, which would have
  // stranded every queued message on an install that does not use debounce.
  INGEST_MESSAGE: "shared",
  // Shared: a sweep with a cadence of minutes and one indexed query per tenant. The recovery it
  // arms is a DEBOUNCE job, which is claimed on the fast lane on its own account (issue #228).
  DELIVERY_SWEEP: "shared",
};

// Same discipline as EXPECTED_LANE, and for a sharper reason: the bound test below can only
// exercise one costly kind end to end, so membership for the other three is asserted here or not at
// all. Flipping RAG_INGEST in the source killed no test until this existed — and RAG_INGEST is the
// one whose provider has NO other limiter (`embedTexts` never touches the model semaphore), so a
// silent demotion means twenty embedding batches at once on a bulk import.
const EXPECTED_SPENDS_PROVIDER: Record<SchedulerJobKind, boolean> = {
  FOLLOWUP: true,
  APPOINTMENT_REMINDER: true,
  REDIRECT_FOLLOWUP: true,
  RAG_INGEST: true,
  FOLLOWUP_SWEEP: false,
  WEBHOOK_RETRY: false,
  HEARTBEAT: false,
  FLOWLOG_SWEEP: false,
  DEBOUNCE: false,
  MEMORY_COMPACT: false,
  INGEST_MESSAGE: false,
  // Reads and writes rows, emits log lines, invokes nothing: the sweep reports a stranded delivery
  // rather than answering it (issue #295).
  DELIVERY_SWEEP: false,
};

// Same discipline again, and both of these maps were added by the change that introduced
// INGEST_MESSAGE — the only kind that is `true` in either. A behaviour test can only exercise that
// one end to end, so what stops a SECOND kind from being flipped is this list and nothing else, and
// the two failures are quiet ones: a kind marked traffic-proportional silently leaves the fixed-rate
// batch and is drained at a quarter of the rate; a kind marked delete-on-done stops leaving a
// completed row behind, and the rows nothing sweeps are simply gone.
const EXPECTED_TRAFFIC_PROPORTIONAL: Record<SchedulerJobKind, boolean> = {
  INGEST_MESSAGE: true,
  FOLLOWUP: false,
  FOLLOWUP_SWEEP: false,
  WEBHOOK_RETRY: false,
  DEBOUNCE: false,
  RAG_INGEST: false,
  HEARTBEAT: false,
  FLOWLOG_SWEEP: false,
  APPOINTMENT_REMINDER: false,
  REDIRECT_FOLLOWUP: false,
  MEMORY_COMPACT: false,
  DELIVERY_SWEEP: false,
};

const EXPECTED_DELETE_ON_DONE: Record<SchedulerJobKind, boolean> = {
  INGEST_MESSAGE: true,
  FOLLOWUP: false,
  FOLLOWUP_SWEEP: false,
  WEBHOOK_RETRY: false,
  DEBOUNCE: false,
  RAG_INGEST: false,
  HEARTBEAT: false,
  FLOWLOG_SWEEP: false,
  APPOINTMENT_REMINDER: false,
  REDIRECT_FOLLOWUP: false,
  MEMORY_COMPACT: false,
  DELIVERY_SWEEP: false,
};

// Written out ON PURPOSE, like the tables above: derived, it would mirror whatever the source says.
const EXPECTED_DEATH_LEVEL: Record<
  SchedulerJobKind,
  "info" | "warn" | "error"
> = {
  FOLLOWUP: "error",
  FOLLOWUP_SWEEP: "error",
  WEBHOOK_RETRY: "error",
  DEBOUNCE: "error",
  RAG_INGEST: "error",
  HEARTBEAT: "error",
  FLOWLOG_SWEEP: "error",
  APPOINTMENT_REMINDER: "error",
  REDIRECT_FOLLOWUP: "error",
  MEMORY_COMPACT: "error",
  INGEST_MESSAGE: "error",
  DELIVERY_SWEEP: "error",
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
        rearm: "same-work",
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
    // The shared lane is claimed in TWO halves — the fixed-rate kinds and the traffic-proportional
    // ones — so that a kind whose row count follows inbound traffic cannot fill the batch and starve
    // the rest (../../src/modules/scheduler/lanes.ts, JOB_TRAFFIC_PROPORTIONAL). Both are recorded
    // as "shared", because they are one lane: what the assertion below still means is that no kind
    // is claimed by two lanes or by none, and a kind dropped from BOTH halves fails it.
    record("shared", await claimDueJobs(50, appDb, new Date(), tenantId));
    record(
      "shared",
      await claimDueTrafficJobs(50, appDb, new Date(), tenantId),
    );
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
    // Two jobs that can only both finish if they run at the same time. Each ANNOUNCES its own start
    // and then waits for the other's, so the deadlock does not depend on which one the claim returns
    // first — `UPDATE … RETURNING` does not guarantee the subquery's order, and a one-sided
    // rendezvous would let a serial drain pass whenever the resolver happened to run first.
    let startedA: (() => void) | undefined;
    let startedB: (() => void) | undefined;
    const aStarted = new Promise<void>((r) => {
      startedA = r;
    });
    const bStarted = new Promise<void>((r) => {
      startedB = r;
    });
    let ranA = false;
    let ranB = false;

    registerJobHandler("HEARTBEAT", async () => {
      ranA = true;
      startedA?.();
      await bStarted;
      return { outcome: "done" };
    });
    registerJobHandler("FLOWLOG_SWEEP", async () => {
      ranB = true;
      startedB?.();
      await aStarted;
      return { outcome: "done" };
    });

    await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "HEARTBEAT",
      dedupeKey: "drain-first",
      runAt: new Date(Date.now() - 120_000),
      base: appDb,
    });
    await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "FLOWLOG_SWEEP",
      dedupeKey: "drain-second",
      runAt: new Date(Date.now() - 60_000),
      base: appDb,
    });

    // A serial drain hangs here rather than failing an assertion, so the deadline is the assertion.
    // Fenced to this tenant: without it the batch fills with another concurrent suite's rows, and
    // the pair below never gets claimed together — the deadlock then reads as a real serial drain.
    const tick = runSchedulerTick(appDb, {
      staleMs: 300_000,
      batchSize: 20,
      tenantId,
    });
    const timedOut = Symbol("timeout");
    const outcome = await Promise.race([
      tick.then(() => "finished" as const),
      new Promise<typeof timedOut>((r) => setTimeout(() => r(timedOut), 5_000)),
    ]);
    expect(outcome).toBe("finished");
    expect(ranA && ranB).toBe(true);
  }, 15_000);

  test("provider-spending kinds are bounded; the cheap ones are not", async () => {
    // The bound the concurrent drain made necessary. Twenty due follow-ups used to be able to hold
    // every permit in the process-wide model semaphore while a customer's reply queued behind a
    // proactive nudge — the serial drain took at most one, and that was the only thing protecting
    // the interactive path.
    //
    // The bound is INJECTED and the workload is a constant. Deriving either from
    // AGENT_MODEL_CONCURRENCY made the test assert whatever that machine was configured to: at 400
    // the bound is 100, the workload would be 206 rows, and claimWhere hard-caps a tick at 100.
    const BOUND = 2;
    const N = 5;

    let live = 0;
    let peak = 0;
    let costlyStarted = 0;
    let cheapLive = 0;
    let cheapPeak = 0;
    let cheapStarted = 0;
    const release: Array<() => void> = [];
    const gate = () =>
      new Promise<void>((r) => {
        release.push(r);
      });

    registerJobHandler("APPOINTMENT_REMINDER", async () => {
      costlyStarted += 1;
      live += 1;
      peak = Math.max(peak, live);
      await gate();
      live -= 1;
      return { outcome: "done" };
    });
    registerJobHandler("HEARTBEAT", async () => {
      cheapStarted += 1;
      cheapLive += 1;
      cheapPeak = Math.max(cheapPeak, cheapLive);
      await gate();
      cheapLive -= 1;
      return { outcome: "done" };
    });

    for (let i = 0; i < N; i++) {
      await enqueueJob({
        rearm: "same-work",
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: `bound-costly-${i}`,
        runAt: past(),
        base: appDb,
      });
      await enqueueJob({
        rearm: "same-work",
        tenantId,
        kind: "HEARTBEAT",
        dedupeKey: `bound-cheap-${i}`,
        runAt: past(),
        base: appDb,
      });
    }

    const tick = runSchedulerTick(appDb, {
      staleMs: 300_000,
      batchSize: 100,
      tenantId,
      providerConcurrency: BOUND,
    });

    // RENDEZVOUS, not a sleep. A fixed wait samples the counters before the reap and the claim have
    // returned on a slow or contended database, which is a red that says nothing about concurrency.
    // Waiting for the cheap ones to ALL have started is the signal that the drain is under way, and
    // it does not presuppose the bound: if the bound were broken the costly count would race past it
    // and the peak assertion below is what catches that.
    const deadline = Date.now() + 10_000;
    while (
      (cheapStarted < N || costlyStarted < BOUND) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // One more turn of the loop, so a broken bound has had the chance to start more than BOUND.
    await new Promise((r) => setTimeout(r, 30));
    const costlyAtRest = peak;
    const cheapAtRest = cheapPeak;

    // Then drain until the tick is done, rather than in a fixed number of waves: how many waves
    // there are is ceil(N / BOUND), and teardown must not be what decides whether the test finishes.
    let finished = false;
    void tick.then(() => {
      finished = true;
    });
    const drainDeadline = Date.now() + 10_000;
    while (!finished && Date.now() < drainDeadline) {
      for (const r of release.splice(0)) r();
      await new Promise((r) => setTimeout(r, 10));
    }
    await tick;

    expect(costlyAtRest).toBe(BOUND);
    // The cheap kind is deliberately NOT gated: bounding the whole drain would put a heartbeat back
    // behind a nudge, which is the blocking this change removed.
    expect(cheapAtRest).toBe(N);
    // Which kinds the bound APPLIES to, stated independently of the source. One kind is exercised
    // above; the rest are only ever covered here.
    expect(JOB_SPENDS_PROVIDER).toEqual(EXPECTED_SPENDS_PROVIDER);
    expect(JOB_TRAFFIC_PROPORTIONAL).toEqual(EXPECTED_TRAFFIC_PROPORTIONAL);
    expect(JOB_DELETE_ON_DONE).toEqual(EXPECTED_DELETE_ON_DONE);
    // What each kind's DEATH says to the operator (issue #356). Stated here for the same reason as
    // the three above, and with one more: the answers currently agree, so no behavioural test can
    // tell this table from a default. This is what says the thirteenth kind has to be asked.
    expect(JOB_DEATH_LEVEL).toEqual(EXPECTED_DEATH_LEVEL);
  }, 30_000);

  // The production sizing, which the test above deliberately does not exercise: never the whole
  // budget (a lane nobody waits on must not be able to starve the turn somebody is waiting on),
  // never zero (proactive work that never runs is worse than proactive work that runs slowly).
  test("the production bound never takes the whole model budget, and never none", () => {
    for (const budget of [1, 2, 4, 8, 20, 100, 400]) {
      const bound = sharedProviderConcurrency(budget);
      expect(bound).toBeGreaterThanOrEqual(1);
      if (budget > 1) expect(bound).toBeLessThan(budget);
    }
    expect(sharedProviderConcurrency(20)).toBe(5);
    expect(sharedProviderConcurrency(1)).toBe(1);
  });

  test("the tick claims only its fenced tenant's jobs", async () => {
    // The fence is test-only isolation, and a mutation removing it survives any single-file run —
    // its whole point is what happens when ANOTHER suite has rows due at the same moment. A second
    // tenant reproduces that without needing a second process.
    const other = await suDb.tenant.create({
      data: { name: "LANES2", slug: `lanes2-${process.pid}` },
    });
    try {
      const foreign = await enqueueJob({
        rearm: "same-work",
        tenantId: other.id,
        kind: "WEBHOOK_RETRY",
        dedupeKey: "foreign",
        runAt: past(),
        base: appDb,
      });
      let touched = false;
      registerJobHandler("WEBHOOK_RETRY", async () => {
        touched = true;
        return { outcome: "done" };
      });
      await runSchedulerTick(appDb, {
        staleMs: 300_000,
        batchSize: 20,
        tenantId,
      });
      expect(touched).toBe(false);
      const row = await suDb.schedulerJob.findUniqueOrThrow({
        where: { id: foreign },
        select: { status: true },
      });
      expect(row.status).toBe("PENDING");
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM scheduler_jobs WHERE tenant_id = ${other.id}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${other.id}`,
      );
    }
  });

  // The shared tick claims in TWO parts so a traffic-proportional kind cannot fill the batch, and
  // this is the half a mutation caught untested: the split is asserted at the claim functions, and
  // deleting the second claim from the tick itself killed nothing. It is the third time in this
  // change that a function was covered and its call site was not.
  test("the shared tick drains both halves of its lane", async () => {
    const fixed = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-tick-fixed",
      runAt: past(),
      base: appDb,
    });
    const traffic = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "INGEST_MESSAGE",
      dedupeKey: "dk-tick-traffic",
      runAt: past(),
      base: appDb,
    });
    const ran: SchedulerJobKind[] = [];
    const previous = {
      WEBHOOK_RETRY: getJobHandler("WEBHOOK_RETRY"),
      INGEST_MESSAGE: getJobHandler("INGEST_MESSAGE"),
    };
    for (const kind of ["WEBHOOK_RETRY", "INGEST_MESSAGE"] as const) {
      registerJobHandler(kind, async () => {
        ran.push(kind);
        return { outcome: "done" };
      });
    }
    try {
      await runSchedulerTick(appDb, {
        staleMs: 300_000,
        batchSize: 20,
        tenantId,
      });
    } finally {
      for (const [kind, handler] of Object.entries(previous)) {
        if (handler) registerJobHandler(kind, handler);
      }
    }

    expect(ran.sort()).toEqual(["INGEST_MESSAGE", "WEBHOOK_RETRY"]);
    // Both rows are finished: the traffic half is DELETED on completion, the fixed one retired.
    expect(await suDb.schedulerJob.count({ where: { id: traffic } })).toBe(0);
    expect(
      (
        await suDb.schedulerJob.findUniqueOrThrow({
          where: { id: fixed },
          select: { status: true },
        })
      ).status,
    ).toBe("DONE");
  });

  test("a write that cannot reach the database is logged, and the batch still drains", async () => {
    // The regression `allSettled` introduces if nothing reads its results: the serial loop let an
    // infrastructure failure propagate out of the tick, where startScheduler logged it. runClaimed
    // swallows a HANDLER's error (it fails the job instead), so a rejection here is the database
    // being unreachable under completeJob — and the row is left CLAIMED for the reaper. Discarded,
    // that is a job silently stuck for minutes with nothing in the log saying why.
    let ran = 0;
    registerJobHandler("WEBHOOK_RETRY", async () => {
      ran += 1;
      return { outcome: "done" };
    });

    for (const key of ["reject-a", "reject-b"]) {
      await enqueueJob({
        rearm: "same-work",
        tenantId,
        kind: "WEBHOOK_RETRY",
        dedupeKey: key,
        runAt: past(),
        base: appDb,
      });
    }

    // Every finishing write goes through schedulerJob.updateMany; the claim and the reap are raw SQL
    // and still work, so the batch is claimed normally and then cannot be closed.
    const broken = appDb.$extends({
      query: {
        schedulerJob: {
          updateMany() {
            throw new Error("connection terminated");
          },
        },
      },
    }) as unknown as PrismaClient;

    const errors: unknown[] = [];
    const realError = logger.error;
    (logger as { error: unknown }).error = (...args: unknown[]) => {
      errors.push(args[0]);
    };
    try {
      const out = await runSchedulerTick(broken, {
        staleMs: 300_000,
        batchSize: 20,
        tenantId,
      });
      // The tick RESOLVES (one unreachable row must not decide the other nineteen) and reports what
      // it claimed, so the count alone can never be the signal that something went wrong.
      expect(out.claimed).toBe(2);
    } finally {
      (logger as { error: unknown }).error = realError;
    }

    expect(ran).toBe(2);
    // One line per job that was left unfinished, naming it.
    expect(errors).toHaveLength(2);
    for (const e of errors) {
      expect((e as { kind?: string }).kind).toBe("WEBHOOK_RETRY");
      expect((e as { jobId?: string }).jobId).toBeTruthy();
    }
  });
});
