import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { readInstanceHealth } from "@/modules/instance-health/read";
import {
  readDatabaseSignals,
  resetSamplerState,
  type SamplerSources,
  sampleOnce,
} from "@/modules/instance-health/sampler";
import {
  FOLLOWUP_SWEEP_SIGNAL,
  signalDef,
} from "@/modules/instance-health/signals";
import { dbProbeFailed } from "@/tests/db-gate";

// A follow-up sweep that stops completing stops every follow-up of its tenant while the instance reads
// healthy. The signal is the time since each tenant's last completed pass, read from the stamp the
// pass writes, so a run of failures keeps it growing; its value is the worst tenant and the read lists
// them all. Catches a failing sweep counted as fresh because its row was just written.
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
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const MINUTE = 60_000;
const ids: Record<
  "fresh" | "failing" | "legacy" | "legacyFailing" | "legacyReaped",
  bigint
> = { fresh: 0n, failing: 0n, legacy: 0n, legacyFailing: 0n, legacyReaped: 0n };

describe.skipIf(!dbUp)("the follow-up sweep signal", () => {
  beforeAll(async () => {
    const now = Date.now();
    for (const name of [
      "fresh",
      "failing",
      "legacy",
      "legacyFailing",
      "legacyReaped",
    ] as const) {
      const t = await suDb.tenant.create({
        data: {
          name: `Sweep ${name}`,
          slug: `sweepsig-${name}-${process.pid}`,
        },
      });
      ids[name] = t.id;
    }
    // Completed half a minute ago.
    await suDb.schedulerJob.create({
      data: {
        tenantId: ids.fresh,
        kind: "FOLLOWUP_SWEEP",
        dedupeKey: "sweep",
        runAt: new Date(now + 30_000),
        payload: { completedAt: now - 30_000 },
      },
    });
    // Completed two hours ago and failing since: each failure rewrites the row, not the stamp.
    await suDb.schedulerJob.create({
      data: {
        tenantId: ids.failing,
        kind: "FOLLOWUP_SWEEP",
        dedupeKey: "sweep",
        runAt: new Date(now + 60_000),
        attempts: 9,
        lastError: "canceling statement due to statement timeout",
        payload: { completedAt: now - 120 * MINUTE },
      },
    });
    // A row from before the stamp, whose last write was a pass that completed.
    await suDb.$executeRaw`
      INSERT INTO scheduler_jobs (tenant_id, kind, dedupe_key, payload, status, run_at, created_at, updated_at)
      VALUES (${ids.legacy}, 'FOLLOWUP_SWEEP', 'sweep', '{}'::jsonb, 'PENDING',
              now() AT TIME ZONE 'UTC',
              (now() - interval '3 days') AT TIME ZONE 'UTC',
              (now() - interval '5 minutes') AT TIME ZONE 'UTC')`;
    // A row from before the stamp that is failing: its last write is a failure, so it counts from
    // its creation, not from the write.
    await suDb.$executeRaw`
      INSERT INTO scheduler_jobs (tenant_id, kind, dedupe_key, payload, status, run_at, attempts, last_error, created_at, updated_at)
      VALUES (${ids.legacyFailing}, 'FOLLOWUP_SWEEP', 'sweep', '{}'::jsonb, 'PENDING',
              now() AT TIME ZONE 'UTC', 7, 'statement timeout',
              (now() - interval '3 hours') AT TIME ZONE 'UTC',
              (now() - interval '1 minute') AT TIME ZONE 'UTC')`;
    // A row from before the stamp whose last write was the reaper: it spends the budget and leaves no
    // error, so it is not a completed pass either.
    await suDb.$executeRaw`
      INSERT INTO scheduler_jobs (tenant_id, kind, dedupe_key, payload, status, run_at, attempts, created_at, updated_at)
      VALUES (${ids.legacyReaped}, 'FOLLOWUP_SWEEP', 'sweep', '{}'::jsonb, 'PENDING',
              now() AT TIME ZONE 'UTC', 2,
              (now() - interval '3 hours') AT TIME ZONE 'UTC',
              (now() - interval '1 minute') AT TIME ZONE 'UTC')`;
  });

  afterAll(async () => {
    resetSamplerState();
    for (const id of Object.values(ids)) {
      await suDb.schedulerJob.deleteMany({ where: { tenantId: id } });
      await suDb.tenant.delete({ where: { id } });
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("the database read gives each tenant the time since its last completed pass", async () => {
    const reading = await readDatabaseSignals(appDb);
    const since = (id: bigint) =>
      reading.followUpSweeps?.find((f) => f.tenantId === String(id))
        ?.sinceCompletedMs ?? -1;
    expect(since(ids.fresh)).toBeGreaterThanOrEqual(30_000);
    expect(since(ids.fresh)).toBeLessThan(MINUTE);
    expect(since(ids.failing)).toBeGreaterThanOrEqual(120 * MINUTE);
    expect(since(ids.failing)).toBeLessThan(121 * MINUTE);
    expect(since(ids.legacy)).toBeGreaterThanOrEqual(5 * MINUTE);
    expect(since(ids.legacy)).toBeLessThan(6 * MINUTE);
    expect(since(ids.legacyFailing)).toBeGreaterThanOrEqual(180 * MINUTE);
    expect(since(ids.legacyReaped)).toBeGreaterThanOrEqual(180 * MINUTE);
  });

  test("the age does not move with the session's time zone", async () => {
    // A session nine hours ahead of UTC: a timestamp without zone read as local would add nine hours
    // to a pass completed half a minute ago.
    const tokyo = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: appUrl as string,
        options: "-c timezone=Asia/Tokyo",
      }),
    });
    try {
      const reading = await readDatabaseSignals(tokyo);
      const fresh = reading.followUpSweeps?.find(
        (f) => f.tenantId === String(ids.fresh),
      );
      expect(fresh?.sinceCompletedMs ?? -1).toBeGreaterThanOrEqual(30_000);
      expect(fresh?.sinceCompletedMs ?? -1).toBeLessThan(MINUTE);
    } finally {
      await tokyo.$disconnect();
    }
  });

  test("the signal is the worst tenant, and the read says which tenants are above the threshold", async () => {
    resetSamplerState();
    const now = Date.now();
    const sources: SamplerSources = {
      now: () => now,
      eventLoopP99Ms: () => 0,
      modelPermitWaiters: () => 0,
      modelPermitOldestMs: () => 0,
      debounceLaneFullMs: () => 0,
      ingressLagP95Ms: () => 0,
      readDatabase: async () => ({
        kindAges: {},
        chatwootPendingOldestMs: 0,
        followUpSweeps: [
          { tenantId: "1", tenantSlug: "fresh", sinceCompletedMs: 30_000 },
          { tenantId: "2", tenantSlug: "stuck", sinceCompletedMs: 7_200_000 },
        ],
      }),
    };
    const values = await sampleOnce(sources, { database: true });
    expect(values[FOLLOWUP_SWEEP_SIGNAL]).toBe(7_200_000);
    expect(signalDef(FOLLOWUP_SWEEP_SIGNAL)?.defaultThreshold).toBe(600_000);
    const health = await readInstanceHealth(true, appDb, now);
    expect(health.followUpSweeps).toEqual([
      {
        tenantId: "2",
        tenantSlug: "stuck",
        sinceCompletedMs: 7_200_000,
        aboveThreshold: true,
      },
      {
        tenantId: "1",
        tenantSlug: "fresh",
        sinceCompletedMs: 30_000,
        aboveThreshold: false,
      },
    ]);
  });
});
