import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { claimSql, laneFilter } from "@/modules/scheduler/service";

// ISSUE #627. Everything a lane budgets is that one `LIMIT`: the traffic share, the observe cap, the
// batch itself. And for the shape the claim used to be written in, Postgres does not honour it.
// `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)` is a SEMI-JOIN, which keeps
// the UPDATE's target on the OUTER side, so the subquery is the inner one; with no `Materialize`
// above it the inner side is re-executed once per outer row, each re-execution SKIPs the rows the
// previous one locked and returns a DIFFERENT n, and every row the outer scan reaches matches. A
// claim of five came back with ten — measured on CI inside one transaction, where a plain
// `SELECT ... LIMIT 5` on the same parameters returned 5.
//
// THE PLAN IS PINNED, not waited for. The planner picks the safe `Hash Semi Join` here and the
// hazardous `Nested Loop Semi Join` on CI, off the same code and the same Postgres 17 — which is
// exactly why the failure looked like a flake for four runs. The knobs below are the smallest set
// that reproduced the CI plan locally, and they ride on the CONNECTION (libpq `options`) because the
// statement runs inside a transaction this test does not open.
//
// It runs as the MIGRATION role, and that is part of the rig rather than laziness: under the fleet
// role RLS adds its quals and the planner goes back to the safe plan, so the claim's own path cannot
// be made to fail here at all. What is under test is the statement, and it is the statement
// production runs, taken from the module instead of retyped.
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
           now() - interval '2 min', 'PENDING', 0, 0, now(), now()
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

  // Without this the two below could go green because the rig stopped working rather than because
  // the statement is sound: an `options` string the driver silently dropped leaves them running on
  // the same safe plan that hides the bug on this machine.
  test("the connection really carries the planner settings the rig depends on", async () => {
    for (const knob of ["enable_sort", "enable_material", "enable_hashjoin"]) {
      const [row] = await pinnedDb.$queryRawUnsafe<
        Array<Record<string, string>>
      >(`SHOW ${knob}`);
      expect(row?.[knob]).toBe("off");
    }
  });

  // And the property the count below rests on, asserted where a reader can see it: the due set is
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
