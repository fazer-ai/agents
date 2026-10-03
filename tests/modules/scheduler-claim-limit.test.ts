import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { claimSql, laneFilter } from "@/modules/scheduler/service";

// Everything a lane budgets is the claim's one `LIMIT`. As `id IN (SELECT ... FOR UPDATE SKIP
// LOCKED LIMIT n)` it is a semi-join whose inner side Postgres may re-execute per outer row, each
// run skipping what the last locked, so the LIMIT is ignored (see `claimSql`). The plan is PINNED:
// the planner may pick the safe `Hash Semi Join` on one machine and the hazardous `Nested Loop Semi
// Join` on another, so the knobs below force the latter, on the CONNECTION (libpq `options`)
// because the statement runs in a transaction this test does not open. It runs as the MIGRATION
// role because the fleet role's RLS quals push the planner back to the safe plan. The statement is
// production's own, taken from the module.
const KNOBS = [
  "enable_sort=off",
  "enable_material=off",
  "enable_hashjoin=off",
  "enable_mergejoin=off",
  "enable_hashagg=off",
]
  .map((k) => `-c ${k}`)
  .join(" ");

const suUrl = process.env.MIGRATION_DATABASE_URL;
const pinnedUrl = suUrl
  ? `${suUrl}${suUrl.includes("?") ? "&" : "?"}options=${encodeURIComponent(KNOBS)}`
  : undefined;

let dbUp = false;
let su: PrismaClient | undefined;
let pinned: PrismaClient | undefined;
if (suUrl && pinnedUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    pinned = new PrismaClient({
      adapter: new PrismaPg({ connectionString: pinnedUrl }),
    });
    await pinned.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;
const pinnedDb = pinned as PrismaClient;

const DUE = 10;
let tenantId = 0n;

async function arm(kind: "INGEST_MESSAGE" | "HEARTBEAT", tag: string) {
  await suDb.$executeRaw`
    INSERT INTO scheduler_jobs (tenant_id, kind, dedupe_key, payload, run_at,
                                status, attempts, claim_seq, created_at, updated_at)
    SELECT ${tenantId}, ${kind}::"SchedulerJobKind", ${tag} || '-' || g, '{}'::jsonb,
           (now() - interval '2 min') AT TIME ZONE 'UTC', 'PENDING', 0, 0, now(), now() AT TIME ZONE 'UTC'
    FROM generate_series(1, ${DUE}) g`;
}

async function claim(lim: number, filter: Prisma.Sql): Promise<number> {
  const rows = await pinnedDb.$queryRaw<Array<{ id: bigint }>>(
    claimSql(lim, new Date(), filter, tenantId),
  );
  return rows.length;
}

describe.skipIf(!dbUp)("the claim hands back its limit and no more", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CLAIMLIMIT", slug: `claim-limit-${process.pid}` },
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
    await pinned?.$disconnect();
  });

  // NOTE: without this the two below could go green because the rig stopped working rather than
  // because the statement is sound: an `options` string the driver silently dropped leaves them
  // running on the same safe plan that hides the bug on this machine.
  test("the connection really carries the planner settings the rig depends on", async () => {
    for (const knob of ["enable_sort", "enable_material", "enable_hashjoin"]) {
      const [row] = await pinnedDb.$queryRawUnsafe<
        Array<Record<string, string>>
      >(`SHOW ${knob}`);
      expect(row?.[knob]).toBe("off");
    }
  });

  // NOTE: the property the count below rests on, asserted where a reader can see it: the due set is
  // computed ONCE, as its own node, instead of being a subquery the join may re-enter.
  test("the due set is evaluated once, as a CTE", async () => {
    const plan = await pinnedDb.$queryRaw<Array<Record<string, string>>>(
      Prisma.sql`EXPLAIN (COSTS OFF) ${claimSql(5, new Date(), laneFilter("shared", true), tenantId)}`,
    );
    const text = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(text).toContain("CTE due");
    expect(text).not.toContain("Semi Join");
  });

  test("the traffic share claims its five of ten, not all ten", async () => {
    await arm("INGEST_MESSAGE", "claim-limit-traffic");
    expect(await claim(5, laneFilter("shared", true))).toBe(5);
    // And the five it left are PENDING for the next tick, not lost and not locked away.
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, kind: "INGEST_MESSAGE", status: "PENDING" },
      }),
    ).toBe(DUE - 5);
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
    );
  });

  test("the fixed batch claims its four of ten, not all ten", async () => {
    await arm("HEARTBEAT", "claim-limit-batch");
    expect(await claim(4, laneFilter("shared", false))).toBe(4);
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
    );
  });
});
