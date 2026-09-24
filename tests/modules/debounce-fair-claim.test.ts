import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { asSuperAdminOn } from "@/lib/tenancy";
import { runDebounceTick } from "@/modules/debounce/worker";
import {
  type ClaimedJob,
  claimDueDebounceJobs,
  claimSql,
  enqueueJob,
} from "@/modules/scheduler/service";

// Issue #810: the debounce lane is cross-tenant, and it used to hand out its slots oldest-first, so
// one tenant's burst took every slot and every other tenant's flush waited for one to free. The
// claim now shares the slots: each due row ranks by what its tenant already has in flight plus its
// place in that tenant's own queue, and ties go to the older row. A tenant alone still gets every
// slot. Real Postgres, the production claim, fenced to this file's tenants.

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
let tenantC = 0n;
const T0 = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One due DEBOUNCE row, `ageS` seconds old.
async function due(tenant: bigint, key: string, ageS: number) {
  await enqueueJob({
    base: appDb,
    tenantId: tenant,
    kind: "DEBOUNCE",
    dedupeKey: `debounce:${tenant}:fair:${key}`,
    runAt: new Date(T0 - ageS * 1000),
    payload: { threadId: `${tenant}:fair:${key}` },
    rearm: "new-work",
  });
  const row = await suDb.schedulerJob.findFirstOrThrow({
    where: { tenantId: tenant, dedupeKey: `debounce:${tenant}:fair:${key}` },
    select: { id: true },
  });
  return row.id;
}

// The production claim over this file's tenants only. `tenantId` takes a list for exactly this: the
// claim is cross-tenant by design, and a test that wants to see tenants share it cannot fence it to
// one of them.
function claim(limit: number, excludeIds: bigint[] = []) {
  const tenantId = [tenantA, tenantB, tenantC];
  return claimDueDebounceJobs(limit, appDb, new Date(), tenantId, excludeIds);
}

const byTenant = (jobs: ClaimedJob[], t: bigint) =>
  jobs.filter((j) => j.tenantId === t).length;

describe.skipIf(!dbUp)(
  "the debounce lane shares its slots between tenants (issue #810)",
  () => {
    beforeAll(async () => {
      for (const name of ["A", "B", "C"]) {
        const t = await suDb.tenant.create({
          data: { name: `FAIR-${name}`, slug: `fair-${name}-${process.pid}` },
        });
        if (name === "A") tenantA = t.id;
        else if (name === "B") tenantB = t.id;
        else tenantC = t.id;
      }
    });

    afterEach(async () => {
      await suDb.schedulerJob.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB, tenantC] } },
      });
    });

    afterAll(async () => {
      await suDb.tenant.deleteMany({
        where: { id: { in: [tenantA, tenantB, tenantC] } },
      });
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("a newer flush of another tenant is claimed in the same claim as an older burst", async () => {
      const aIds: bigint[] = [];
      for (let i = 0; i < 10; i++)
        aIds.push(await due(tenantA, `a${i}`, 60 - i));
      const b = await due(tenantB, "b0", 10);
      const jobs = await claim(4);
      expect(jobs).toHaveLength(4);
      expect(jobs.map((j) => j.id)).toContain(b);
      // Work-conserving: the slots B does not take go to A, oldest first.
      expect(byTenant(jobs, tenantA)).toBe(3);
      expect(
        jobs
          .filter((j) => j.tenantId === tenantA)
          .map((j) => j.id)
          .sort(),
      ).toEqual(aIds.slice(0, 3).sort());
    });

    test("what a tenant already has in flight counts: a freed slot goes to the tenant that has none", async () => {
      for (let i = 0; i < 10; i++) await due(tenantA, `a${i}`, 60 - i);
      const first = await claim(4);
      expect(byTenant(first, tenantA)).toBe(4);
      const b = await due(tenantB, "b0", 5);
      // One of A's four finished; the other three are still running.
      const stillRunning = first.slice(1).map((j) => j.id);
      const next = await claim(1, stillRunning);
      expect(next.map((j) => j.id)).toEqual([b]);
    });

    test("a row in flight that was re-armed to PENDING still counts for its tenant and is not claimed", async () => {
      for (let i = 0; i < 3; i++) await due(tenantA, `a${i}`, 60 - i);
      const running = await claim(3);
      expect(byTenant(running, tenantA)).toBe(3);
      // A message during the flush re-arms the same row back to PENDING, due.
      await suDb.schedulerJob.update({
        where: { id: running[0]?.id as bigint },
        data: { status: "PENDING", runAt: new Date(T0 - 1_000) },
      });
      for (let i = 3; i < 8; i++) await due(tenantA, `a${i}`, 60 - i);
      const b = await due(tenantB, "b0", 1);
      const next = await claim(
        1,
        running.map((j) => j.id),
      );
      expect(next.map((j) => j.id)).toEqual([b]);
    });

    test("a tenant alone gets every slot, oldest first", async () => {
      const aIds: bigint[] = [];
      for (let i = 0; i < 10; i++)
        aIds.push(await due(tenantA, `a${i}`, 60 - i));
      const jobs = await claim(4);
      expect(jobs.map((j) => j.id).sort()).toEqual(aIds.slice(0, 4).sort());
    });

    test("equal shares go to the older row", async () => {
      const a0 = await due(tenantA, "a0", 50);
      const a1 = await due(tenantA, "a1", 48);
      const b0 = await due(tenantB, "b0", 45);
      const b1 = await due(tenantB, "b1", 30);
      // Shares: a0=1, b0=1, then a1=2, b1=2. Oldest-first alone would take a0 and a1.
      expect((await claim(2)).map((j) => j.id).sort()).toEqual([a0, b0].sort());
      await suDb.schedulerJob.updateMany({
        where: { id: { in: [a0, b0] } },
        data: { status: "PENDING" },
      });
      // Among the 2s, a1 is older than b1.
      const three = await claim(3);
      expect(three.map((j) => j.id).sort()).toEqual([a0, b0, a1].sort());
      expect(three.map((j) => j.id)).not.toContain(b1);
    });

    test("three tenants with deep queues get one slot each before anyone gets a second", async () => {
      // A's queue is the oldest of the three, B's next, C's the newest.
      for (const [k, t] of [tenantA, tenantB, tenantC].entries())
        for (let i = 0; i < 5; i++) await due(t, `q${i}`, 60 - k * 5 - i);
      const jobs = await claim(3);
      expect([
        byTenant(jobs, tenantA),
        byTenant(jobs, tenantB),
        byTenant(jobs, tenantC),
      ]).toEqual([1, 1, 1]);
    });

    test("a row locked by another session is skipped, not waited for", async () => {
      const a0 = await due(tenantA, "a0", 60);
      await due(tenantA, "a1", 50);
      await due(tenantB, "b0", 40);
      let release: () => void = () => {};
      const locked = new Promise<void>((r) => {
        release = r;
      });
      let holding: () => void = () => {};
      const held = new Promise<void>((r) => {
        holding = r;
      });
      const tx = suDb.$transaction(
        async (db) => {
          await db.$queryRaw`SELECT id FROM scheduler_jobs WHERE id = ${a0} FOR UPDATE`;
          holding();
          await locked;
        },
        { timeout: 20_000 },
      );
      await held;
      try {
        const t = performance.now();
        const jobs = await claim(4);
        expect(performance.now() - t).toBeLessThan(3_000);
        expect(jobs.map((j) => j.id)).not.toContain(a0);
        expect(jobs).toHaveLength(2);
      } finally {
        release();
        await tx;
      }
    });

    test("a row re-armed into the future between the claim's snapshot and its lock is not claimed", async () => {
      // The claim ranks from its statement snapshot and locks afterwards. A re-arm that commits in
      // between leaves the snapshot's version due, and Postgres re-checks only the locked row's own
      // predicates against the new version. `fair_claim_pause()` holds the claim right there, once.
      await suDb.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION fair_claim_pause() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
        BEGIN
          IF current_setting('fair_claim.pause', true) = 'on' THEN
            PERFORM set_config('fair_claim.pause', 'off', true);
            PERFORM pg_sleep(1.5);
          END IF;
          RETURN true;
        END $$`);
      try {
        const a0 = await due(tenantA, "a0", 30);
        const kinds = Prisma.sql`kind IN ('DEBOUNCE') AND fair_claim_pause()`;
        const tenantId = [tenantA, tenantB, tenantC];
        // The production claim's own wrapper and statement, with the pause in the kind filter.
        const claiming = asSuperAdminOn(appDb, async (db) => {
          await db.$executeRaw`SELECT set_config('fair_claim.pause', 'on', true)`;
          return db.$queryRaw<Array<{ id: bigint }>>(
            claimSql(4, new Date(), kinds, tenantId, [], undefined, true),
          );
        });
        await sleep(500);
        // What armDebounce does when a message lands inside the window: the same row, pushed out.
        await suDb.schedulerJob.update({
          where: { id: a0 },
          data: { runAt: new Date(Date.now() + 60_000) },
        });
        const claimed = await claiming;
        expect(claimed.map((j) => j.id)).not.toContain(a0);
        const row = await suDb.schedulerJob.findUniqueOrThrow({
          where: { id: a0 },
          select: { status: true },
        });
        expect(row.status).toBe("PENDING");
      } finally {
        await suDb.$executeRawUnsafe(
          `DROP FUNCTION IF EXISTS fair_claim_pause()`,
        );
      }
    });

    test("through the drain: one tick claims the other tenant's flush while the burst's flushes hang", async () => {
      for (let i = 0; i < 10; i++) await due(tenantA, `a${i}`, 60 - i);
      const b = await due(tenantB, "b0", 10);
      const hung: Array<() => void> = [];
      const started: bigint[] = [];
      try {
        const out = await runDebounceTick(appDb, 4, {
          claim: (limit, _base, _now, _tenant, excludeIds) =>
            claim(limit, excludeIds),
          run: (job) => {
            started.push(job.id);
            return new Promise<void>((r) => {
              hung.push(r);
            });
          },
        });
        expect(out.claimed).toBe(4);
        expect(started).toContain(b);
      } finally {
        for (const r of hung.splice(0)) r();
        await sleep(0);
        await runDebounceTick(appDb, 4, { claim: async () => [] });
      }
    });
  },
);
