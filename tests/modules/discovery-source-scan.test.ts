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
import type { TenantContext } from "@/lib/tenancy";
import { leadSourceScanKey } from "@/modules/discovery/scan-jobs";
import {
  ensureAllLeadSourceScans,
  registerLeadSourceScanHandler,
} from "@/modules/discovery/schedule";
import {
  createLeadSource,
  updateLeadSource,
} from "@/modules/discovery/sources";
import { claimDueJobs, enqueueJob } from "@/modules/scheduler/service";
import { runClaimed, runSchedulerTick } from "@/modules/scheduler/worker";

// The lead-source scan lane: `enabled` + `intervalMin` arm one perpetual
// LEAD_SOURCE_SCAN row per source, and the shared tick claims it like any
// other shared-lane row. These run against the real claim + settle path
// (claimDueJobs -> runClaimed) so the due gate, the disabled skip and the
// failure reschedule are exercised the way production runs them. DB-backed,
// with its own app-role client so runs stay under real RLS.

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
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

const CONTENT =
  '{"platform":"tiktok","id":"scan-1","author":"Lan","text":"cần mua serum BHA"}';

async function jobRow(sourceId: bigint) {
  return suDb.schedulerJob.findFirst({
    where: {
      tenantId,
      kind: "LEAD_SOURCE_SCAN",
      dedupeKey: leadSourceScanKey(sourceId),
    },
  });
}

async function sourceRow(sourceId: bigint) {
  return suDb.leadSource.findUniqueOrThrow({ where: { id: sourceId } });
}

// Claims the source's due row through the real shared-lane claim and runs it
// through the production handler path, deadline and CAS settle included.
async function claimAndRun(sourceId: bigint) {
  const jobs = await claimDueJobs(20, appDb, new Date(), tenantId);
  const job = jobs.find((j) => j.dedupeKey === leadSourceScanKey(sourceId));
  if (!job) {
    throw new Error(`no due LEAD_SOURCE_SCAN row for source ${sourceId}`);
  }
  await runClaimed(job, appDb);
  return job;
}

describe.skipIf(!dbUp)("discovery lead source scan lane", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DiscoveryScan", slug: `discovery-scan-${process.pid}` },
    });
    tenantId = t.id;
    registerLeadSourceScanHandler();
  });

  afterEach(async () => {
    // A leftover PENDING row would be claimed by the NEXT test's claim and run
    // there: each test asserts on its own source id, so the lane must start empty.
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM lead_product_matches WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM leads WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM lead_sources WHERE tenant_id = ${tenantId}`,
    );
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("creating an enabled source arms a due scan row; a disabled one gets none", async () => {
    const on = await createLeadSource(
      ctx(),
      {
        name: "armed",
        kind: "file_import",
        config: { format: "jsonl", content: CONTENT },
        intervalMin: 30,
      },
      appDb,
    );
    const armed = await jobRow(BigInt(on.id));
    expect(armed).not.toBeNull();
    expect(armed?.status).toBe("PENDING");
    expect(armed?.payload).toEqual({ sourceId: on.id });
    // Never run: due now.
    expect(armed?.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);

    const off = await createLeadSource(
      ctx(),
      {
        name: "unarmed",
        kind: "file_import",
        config: { format: "jsonl", content: CONTENT },
        enabled: false,
      },
      appDb,
    );
    expect(await jobRow(BigInt(off.id))).toBeNull();
  });

  test("a due enabled source runs through the tick and reschedules one interval out", async () => {
    const source = await createLeadSource(
      ctx(),
      {
        name: "due",
        kind: "file_import",
        config: { format: "jsonl", content: CONTENT },
        intervalMin: 60,
      },
      appDb,
    );
    await runSchedulerTick(appDb, {
      staleMs: 300_000,
      batchSize: 20,
      tenantId,
    });
    const stored = await sourceRow(BigInt(source.id));
    expect(stored.lastStatus).toBe("ok");
    expect(stored.lastError).toBeNull();
    expect(stored.lastRunAt).not.toBeNull();
    // The perpetual row is re-armed, not finished: due at the fresh stamp + interval.
    const job = await jobRow(BigInt(source.id));
    expect(job?.status).toBe("PENDING");
    expect(job?.attempts).toBe(0);
    const lastMs = stored.lastRunAt?.getTime();
    expect(lastMs).toBeDefined();
    const expected = (lastMs ?? 0) + stored.intervalMin * 60_000;
    expect(
      job === null ? -1 : Math.abs(job.runAt.getTime() - expected),
    ).toBeLessThan(10_000);
    // And the scan actually produced the lead.
    const lead = await suDb.lead.findFirst({
      where: { tenantId, externalId: "scan-1" },
    });
    expect(lead).not.toBeNull();
  });

  test("interval gating: an armed row fires but waits out the rest of the interval instead of rescanning", async () => {
    const source = await createLeadSource(
      ctx(),
      {
        name: "fresh",
        kind: "file_import",
        config: { format: "jsonl", content: CONTENT },
        intervalMin: 60,
      },
      appDb,
    );
    // A run the row does not know about (the manual /run path stamps lastRunAt
    // without touching the job row): the handler must re-ask due from the stamp.
    const stamp = new Date();
    await suDb.leadSource.update({
      where: { id: BigInt(source.id) },
      data: { lastRunAt: stamp },
    });

    await claimAndRun(BigInt(source.id));

    const stored = await sourceRow(BigInt(source.id));
    // The scan did NOT run: no bookkeeping was written, no lead exists.
    expect(stored.lastStatus).toBeNull();
    expect(stored.lastRunAt?.getTime()).toBe(stamp.getTime());
    expect(await suDb.lead.count({ where: { tenantId } })).toBe(0);
    // The row is re-armed at the real due time, still PENDING.
    const job = await jobRow(BigInt(source.id));
    expect(job?.status).toBe("PENDING");
    const expected = stamp.getTime() + stored.intervalMin * 60_000;
    expect(
      job === null ? -1 : Math.abs(job.runAt.getTime() - expected),
    ).toBeLessThan(10_000);

    // And nothing is claimable for it now: the due gate is the row's run_at.
    const again = await claimDueJobs(20, appDb, new Date(), tenantId);
    expect(
      again.find((j) => j.dedupeKey === leadSourceScanKey(BigInt(source.id))),
    ).toBeUndefined();
  });

  test("disabling retires the waiting row; a stray row for a disabled source finishes without running", async () => {
    const source = await createLeadSource(
      ctx(),
      {
        name: "toggle",
        kind: "file_import",
        config: { format: "jsonl", content: CONTENT },
      },
      appDb,
    );
    const id = BigInt(source.id);

    await updateLeadSource(ctx(), id, { enabled: false }, appDb);
    expect((await jobRow(id))?.status).toBe("DONE");

    // A row armed before the switch (or armed by a race) still claims once;
    // the handler is the second fence and ends it without touching the source.
    await enqueueJob({
      tenantId,
      kind: "LEAD_SOURCE_SCAN",
      dedupeKey: leadSourceScanKey(id),
      runAt: new Date(Date.now() - 60_000),
      rearm: "new-work",
      payload: { sourceId: source.id },
      base: appDb,
    });
    await claimAndRun(id);
    const stored = await sourceRow(id);
    expect(stored.lastRunAt).toBeNull();
    expect(stored.lastStatus).toBeNull();
    expect((await jobRow(id))?.status).toBe("DONE");

    // Re-enabling re-arms the schedule (a never-run source is due now).
    await updateLeadSource(ctx(), id, { enabled: true }, appDb);
    const rearmed = await jobRow(id);
    expect(rearmed?.status).toBe("PENDING");
    expect(rearmed?.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  test("one failing source keeps its interval and never blocks the source beside it", async () => {
    // file_import with no stored content fails its scan with a 422: the failure
    // is the source's own bookkeeping, the row reschedules instead of dying.
    const bad = await createLeadSource(
      ctx(),
      { name: "broken", kind: "file_import", config: {}, intervalMin: 45 },
      appDb,
    );
    const good = await createLeadSource(
      ctx(),
      {
        name: "healthy",
        kind: "file_import",
        config: { format: "jsonl", content: CONTENT },
        intervalMin: 45,
      },
      appDb,
    );

    const jobs = await claimDueJobs(20, appDb, new Date(), tenantId);
    const byKey = new Map(jobs.map((j) => [j.dedupeKey, j]));
    const badJob0 = byKey.get(leadSourceScanKey(BigInt(bad.id)));
    const goodJob0 = byKey.get(leadSourceScanKey(BigInt(good.id)));
    expect(badJob0).toBeDefined();
    expect(goodJob0).toBeDefined();
    if (!badJob0 || !goodJob0) return;
    // Run both through the real path: the bad one's throw is caught inside the
    // handler, so whatever order the drain took, the good one is unaffected.
    await runClaimed(badJob0, appDb);
    await runClaimed(goodJob0, appDb);

    const badStored = await sourceRow(BigInt(bad.id));
    expect(badStored.lastStatus).toBe("error");
    expect(badStored.lastError).toContain("no content");
    const badJob = await jobRow(BigInt(bad.id));
    // Rescheduled one interval out, still in the loop - not FAILED, not DEAD.
    expect(badJob?.status).toBe("PENDING");
    expect(badJob?.attempts).toBe(0);
    expect(badJob?.runAt.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);

    const goodStored = await sourceRow(BigInt(good.id));
    expect(goodStored.lastStatus).toBe("ok");
    expect(
      await suDb.lead.count({
        where: { tenantId, sourceId: BigInt(good.id) },
      }),
    ).toBe(1);
  });

  test("boot re-arm covers every enabled source at its due time and never pushes a pending run later", async () => {
    const mk = async (name: string) =>
      createLeadSource(
        ctx(),
        { name, kind: "file_import", config: {}, enabled: false },
        appDb,
      );
    const now = Date.now();
    // Seeded straight through the superuser client so the arming paths do not
    // pre-create the rows this test controls.
    const never = await mk("never");
    const overdue = await mk("overdue");
    const later = await mk("later");
    const off = await mk("off");
    await suDb.leadSource.updateMany({
      where: {
        id: { in: [BigInt(never.id), BigInt(overdue.id), BigInt(later.id)] },
      },
      data: { enabled: true },
    });
    await suDb.leadSource.update({
      where: { id: BigInt(overdue.id) },
      data: { lastRunAt: new Date(now - 2 * 3_600_000), intervalMin: 60 },
    });
    await suDb.leadSource.update({
      where: { id: BigInt(later.id) },
      data: { lastRunAt: new Date(now), intervalMin: 120 },
    });
    // A pending run asked for sooner than the recomputed due time must be kept.
    const earlier = new Date(now + 10 * 60_000);
    await enqueueJob({
      tenantId,
      kind: "LEAD_SOURCE_SCAN",
      dedupeKey: leadSourceScanKey(BigInt(later.id)),
      runAt: earlier,
      rearm: "same-work",
      payload: { sourceId: later.id },
      base: appDb,
    });

    await ensureAllLeadSourceScans(appDb);

    const neverRow = await jobRow(BigInt(never.id));
    expect(neverRow?.status).toBe("PENDING");
    expect(neverRow?.runAt.getTime()).toBeLessThanOrEqual(now + 5_000);

    const overdueRow = await jobRow(BigInt(overdue.id));
    expect(overdueRow?.status).toBe("PENDING");
    expect(overdueRow?.runAt.getTime()).toBeLessThanOrEqual(now + 5_000);

    const laterRow = await jobRow(BigInt(later.id));
    expect(laterRow?.status).toBe("PENDING");
    expect(
      laterRow === null
        ? -1
        : Math.abs(laterRow.runAt.getTime() - earlier.getTime()),
    ).toBeLessThan(10_000);

    // Disabled sources are left alone.
    expect(await jobRow(BigInt(off.id))).toBeNull();
  });
});
