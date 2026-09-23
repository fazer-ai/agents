import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  type DebounceTickDeps,
  startDebounceWorker,
  stopDebounceWorker,
} from "@/modules/debounce/worker";
import {
  type ClaimedJob,
  claimDueDebounceJobs,
  enqueueJob,
  reapStaleJobs,
} from "@/modules/scheduler/service";

// Issue #807, on real rows and through the real interval: a DEBOUNCE job whose run never settles
// must not stop the lane from claiming the next due job, of another tenant, and the row of the job
// still in flight must not be run a second time when it becomes claimable again — by a re-arm (a
// message arriving during the flush upserts the same row back to PENDING) or by the reaper. The
// run itself is injected; the claim, the rows, the re-arm and the reap are the production ones.

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

let tenantA = 0n;
let tenantB = 0n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const past = () => new Date(Date.now() - 1_000);

async function until(cond: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

// The production claim, fenced to this file's two tenants: the claim is cross-tenant by design, and
// on the shared test database an unfenced one takes other suites' rows.
const claimMine: NonNullable<DebounceTickDeps["claim"]> = async (
  limit,
  base,
  now,
  _tenantId,
  excludeIds,
) => {
  const out: ClaimedJob[] = [];
  for (const tenantId of [tenantA, tenantB]) {
    if (out.length >= limit) break;
    out.push(
      ...(await claimDueDebounceJobs(
        limit - out.length,
        base,
        now,
        tenantId,
        excludeIds,
      )),
    );
  }
  return out;
};

function arm(tenantId: bigint, key: string) {
  return enqueueJob({
    base: appDb,
    tenantId,
    kind: "DEBOUNCE",
    dedupeKey: key,
    runAt: past(),
    payload: {},
    rearm: "same-work",
  });
}

async function statusOf(id: bigint) {
  const row = await suDb.schedulerJob.findUniqueOrThrow({
    where: { id },
    select: { status: true },
  });
  return row.status;
}

describe.skipIf(!dbUp)("debounce drain: slots instead of batches", () => {
  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "DDS-A", slug: `dds-a-${process.pid}` },
    });
    const b = await suDb.tenant.create({
      data: { name: "DDS-B", slug: `dds-b-${process.pid}` },
    });
    tenantA = a.id;
    tenantB = b.id;
  });

  afterEach(() => {
    stopDebounceWorker();
  });

  afterAll(async () => {
    for (const id of [tenantA, tenantB]) {
      if (!id) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM scheduler_jobs WHERE tenant_id = ${id}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // One scenario, run once per road by which a row in flight becomes claimable again.
  async function hungJobScenario(
    tag: string,
    makeClaimableAgain: (rowA: bigint) => Promise<void>,
  ) {
    let releaseA: () => void = () => {};
    const aSettled = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const runs: bigint[] = [];
    let rowA = 0n;
    const runsOf = (id: bigint) => runs.filter((r) => r === id).length;
    const run = async (job: ClaimedJob) => {
      runs.push(job.id);
      if (job.id === rowA && runsOf(rowA) === 1) await aSettled;
    };

    // NOTE: released on every exit, because the in-flight set is process-wide and a run left
    // pending by an early failure would take a slot from every file that runs after this one.
    try {
      rowA = await arm(tenantA, `debounce:dds-a-${tag}-${process.pid}`);
      startDebounceWorker({
        base: appDb,
        intervalMs: 20,
        slots: 5,
        deps: { claim: claimMine, run },
      });
      expect(await until(() => runsOf(rowA) === 1)).toBe(true);
      expect(await statusOf(rowA)).toBe("CLAIMED");

      // Another tenant's flush comes due while A is still running, and is drained.
      const rowB = await arm(tenantB, `debounce:dds-b-${tag}-${process.pid}`);
      expect(await until(() => runsOf(rowB) === 1)).toBe(true);

      // A becomes claimable again (PENDING and due) while its first run is pending. Only the
      // in-flight exclusion keeps it out, which the last step proves by claiming it once the run
      // settles.
      await makeClaimableAgain(rowA);
      expect(await statusOf(rowA)).toBe("PENDING");
      await sleep(200);
      expect(runsOf(rowA)).toBe(1);

      releaseA();
      expect(await until(() => runsOf(rowA) === 2)).toBe(true);
    } finally {
      releaseA();
    }
  }

  test("re-armed while in flight: another tenant is drained, and the row is not run twice at once", async () => {
    await hungJobScenario("rearm", async () => {
      await arm(tenantA, `debounce:dds-a-rearm-${process.pid}`);
    });
  });

  test("reaped while in flight: another tenant is drained, and the row is not run twice at once", async () => {
    await hungJobScenario("reap", async (rowA) => {
      // The claim ages past the stale window, as a model call longer than the reaper's cutoff does.
      await suDb.schedulerJob.update({
        where: { id: rowA },
        data: { claimedAt: new Date(Date.now() - 60_000) },
      });
      const tenantId = tenantA;
      const reaped = await reapStaleJobs(
        1_000,
        appDb,
        new Date(),
        tenantId,
        "DEBOUNCE",
      );
      expect(reaped.map((r) => r.id)).toEqual([rowA]);
    });
  });
});
