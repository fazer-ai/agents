import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, type PoolConfig } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  ackPoolOptions,
  instanceHealthPoolOptions,
  metricsPoolOptions,
  runtimePoolOptions,
} from "@/api/lib/pool-options";
import {
  assertSessionZones,
  isUtcZone,
  SessionZoneError,
} from "@/lib/db-session-zone";
import { withSessionOptions, withSessionZoneInUrl } from "@/lib/session-zone";
import { readDatabaseSignals } from "@/modules/instance-health/sampler";
import {
  claimDueJobs,
  enqueueJob,
  failJob,
  reapStaleJobs,
  reclaimAfterDeadline,
} from "@/modules/scheduler/service";
import { dbProbeFailed } from "@/tests/db-gate";

// Every pool pins its sessions to UTC, so `now()` against a `timestamp without time zone` column holds
// whatever zone the server, the database or the role hands a new session. The server's own default
// cannot be changed from here without touching every other test on this database, so the zone a
// session would otherwise start in is handed over the way a server default reaches it: as a startup
// setting in the URL, which the pin has to override.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;

function startingIn(url: string, zone: string): string {
  const u = new URL(url);
  u.searchParams.set("options", `-c TimeZone=${zone}`);
  return u.toString();
}

let dbUp = false;
let su: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;

async function zoneOf(options: PoolConfig): Promise<string> {
  const pool = new Pool(options);
  try {
    const { rows } = await pool.query<{ tz: string }>(
      "SELECT current_setting('TimeZone') AS tz",
    );
    return rows[0]?.tz ?? "";
  } finally {
    await pool.end();
  }
}

describe("the session options", () => {
  test("go in the options field when the URL carries none", () => {
    const out = withSessionOptions("postgres://u:p@h:5432/db");
    expect(out).toEqual({
      connectionString: "postgres://u:p@h:5432/db",
      options: "-c TimeZone=UTC",
    });
  });

  test("are appended to an options the URL carries, since `pg` would let the URL's win", async () => {
    const { parse } = await import("pg-connection-string");
    const { connectionString } = withSessionOptions(
      "postgres://u:p%40ss@h:5432/db?options=-c%20TimeZone%3DAsia%2FTokyo&sslmode=disable",
      ["-c jit=off"],
    );
    const parsed = parse(connectionString as string);
    expect([parsed.options, parsed.password, parsed.database]).toEqual([
      "-c TimeZone=Asia/Tokyo -c TimeZone=UTC -c jit=off",
      "p@ss",
      "db",
    ]);
  });

  test("the Prisma CLI's URL carries the pin, beside an options it already had", async () => {
    const { parse } = await import("pg-connection-string");
    expect(
      parse(withSessionZoneInUrl("postgres://u:p@h:5432/db")).options,
    ).toBe("-c TimeZone=UTC");
    expect(
      parse(
        withSessionZoneInUrl("postgres://u:p@h:5432/db?options=-c%20jit%3Doff"),
      ).options,
    ).toBe("-c jit=off -c TimeZone=UTC");
  });
});

describe("the boot check of the session zone", () => {
  test("refuses naming every pool outside UTC, and a pool that does not answer hides none", async () => {
    const run = assertSessionZones([
      { pool: "main", read: async () => "UTC" },
      { pool: "ack", read: async () => "America/Sao_Paulo" },
      {
        pool: "checkpointer",
        read: async () => {
          throw new Error("connection refused");
        },
      },
      { pool: "metrics", read: async () => "Asia/Tokyo" },
    ]);
    await expect(run).rejects.toBeInstanceOf(SessionZoneError);
    await expect(run).rejects.toThrow(
      "ack (America/Sao_Paulo), metrics (Asia/Tokyo)",
    );
  });

  test("passes the server's own UTC spellings, and reports a pool it could not read", async () => {
    const { unchecked } = await assertSessionZones([
      { pool: "main", read: async () => "Etc/UTC" },
      { pool: "background", read: async () => "UTC" },
      {
        pool: "metrics",
        read: async () => {
          throw new Error("down");
        },
      },
    ]);
    expect(unchecked.map((u) => u.pool)).toEqual(["metrics"]);
  });

  test("a zone at offset 0 only part of the year is not UTC", () => {
    expect(isUtcZone("Europe/London")).toBe(false);
    expect(isUtcZone("Africa/Abidjan")).toBe(false);
    expect(isUtcZone("etc/utc")).toBe(true);
  });
});

describe.skipIf(!dbUp)("every pool's sessions run in UTC", () => {
  const tokyo = () => startingIn(appUrl as string, "Asia/Tokyo");

  test("the main, background and checkpointer pools", async () => {
    expect(await zoneOf(runtimePoolOptions(tokyo(), 1))).toBe("UTC");
  });

  test("the ack pool", async () => {
    expect(await zoneOf(ackPoolOptions(tokyo()))).toBe("UTC");
  });

  test("the instance health pool", async () => {
    expect(await zoneOf(instanceHealthPoolOptions(tokyo()))).toBe("UTC");
  });

  test("the metrics pool", async () => {
    expect(await zoneOf(metricsPoolOptions(tokyo()))).toBe("UTC");
  });
});

// The scheduler round trip through the app's own pool options, in a session that would start at
// UTC-3 and at UTC+9: a claim taken back after its deadline must hold the real instant, or the
// reaper takes it back while the run is in flight (behind) or leaves a dead run claimed (ahead).
describe.skipIf(!dbUp)("the scheduler round trip outside UTC", () => {
  let tenantId = 0n;
  const clients: PrismaClient[] = [];

  function appOn(zone: string): PrismaClient {
    const client = new PrismaClient({
      adapter: new PrismaPg(
        new Pool(runtimePoolOptions(startingIn(appUrl as string, zone), 2)),
        { disposeExternalPool: true },
      ),
    });
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SESSIONZONE", slug: `session-zone-${process.pid}` },
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
    for (const c of clients) await c.$disconnect();
    await su?.$disconnect();
  });

  async function claimedAtOf(id: bigint): Promise<Date> {
    const row = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id },
      select: { claimedAt: true },
    });
    if (!row.claimedAt) throw new Error("not claimed");
    return row.claimedAt;
  }

  // Claim, fail by deadline, take back: the state `reclaimAfterDeadline` leaves for the outcome.
  async function reclaimed(app: PrismaClient, key: string): Promise<bigint> {
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: key,
      runAt: new Date(Date.now() - 60_000),
      base: app,
    });
    const job = (await claimDueJobs(10, app, new Date(), tenantId)).find(
      (j) => j.id === id,
    );
    if (!job) throw new Error("not claimed");
    await failJob(
      tenantId,
      id,
      job.claimSeq,
      job.attempts,
      "WEBHOOK_RETRY",
      "deadline",
      app,
    );
    const back = await reclaimAfterDeadline(
      tenantId,
      id,
      job.claimSeq,
      job.attempts,
      "deadline",
      app,
    );
    expect(back.applied).toBe(true);
    return id;
  }

  for (const zone of ["America/Sao_Paulo", "Asia/Tokyo"]) {
    test(`at ${zone}, the reclaim writes the real instant and the reaper leaves the live run`, async () => {
      const app = appOn(zone);
      const before = Date.now();
      const id = await reclaimed(app, `live-${zone}`);
      const claimedAt = (await claimedAtOf(id)).getTime();
      expect(claimedAt).toBeGreaterThanOrEqual(before - 5_000);
      expect(claimedAt).toBeLessThanOrEqual(Date.now() + 5_000);

      const reaped = await reapStaleJobs(5 * 60_000, app, new Date(), tenantId);
      expect(reaped.map((r) => r.id)).not.toContain(id);
    });
  }

  test("at Asia/Tokyo, a run that died is reaped once its claim is past the stale window", async () => {
    const app = appOn("Asia/Tokyo");
    const id = await reclaimed(app, "dead-tokyo");
    // The reaper's clock six minutes ahead stands for a run that died right after its reclaim.
    const later = new Date(Date.now() + 6 * 60_000);
    const reaped = await reapStaleJobs(5 * 60_000, app, later, tenantId);
    expect(reaped.map((r) => r.id)).toContain(id);
  });

  test("at America/Sao_Paulo, the instance health reads a due job's real age", async () => {
    const app = appOn("America/Sao_Paulo");
    await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "health-age",
      runAt: new Date(Date.now() - 120_000),
      base: app,
    });
    const reading = await readDatabaseSignals(app);
    const age = reading.kindAges.WEBHOOK_RETRY ?? -1;
    expect(age).toBeGreaterThanOrEqual(115_000);
    expect(age).toBeLessThan(3_600_000);
  });
});
