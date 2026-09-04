import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";

// `latestAt` IN CONSTANT TIME ON ALL THREE TRAILS (#520, review round 1).
//
// Every audit read reports the newest row of its trail past any filter, so this aggregate runs on
// every page and every filtered request. The tenant trail was already constant: RLS supplies
// `tenant_id = …`, which is the leading column of `audit_logs_tenant_id_created_at_idx`, so Postgres
// rewrites `max(created_at)` into a one-row backward walk of it. Neither scope this PR added can use
// that index the same way -- `scope=all` constrains nothing and `scope=fleet` constrains the leading
// column to NULL, which is indexable but carries no ordering pathkey -- so both degraded into a scan
// of the whole trail. Measured on 500k rows (40 tenants, 12.5k keyed to no tenant), PG 17.10:
//
//   scope=tenant     7 buffers    0.046 ms   Limit + Index Only Scan Backward
//   scope=fleet   5720 buffers    5.6  ms    Bitmap Heap Scan, 12,500 rows read to keep one
//   scope=all     5669 buffers   18.9  ms    Parallel Seq Scan, 500,000 rows read to keep one
//
// and after the migration, 3 and 4 buffers. So the assertion here is the SHAPE of the plan, not a
// duration: a `Limit` under the aggregate is the rewrite itself, and it is exactly what an index
// unusable for the ordering cannot produce. `enable_seqscan = off` keeps the answer about the index
// rather than about the planner's cost choice on a test table that holds a handful of rows -- the
// same reason `rls-policy-shape.test.ts` sets it.
//
// The negative half runs in the SAME transaction, with the indexes dropped and rolled back, because
// a plan assertion that has never been seen to fail proves nothing about the index it names: without
// them the very same query falls back to `Aggregate` over a `Bitmap Heap Scan`, which is the linear
// shape this migration exists to remove.

const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
if (suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;

// The two aggregates `listAudit` issues for the trails this PR added, verbatim in shape: no
// predicate for `all`, `tenant_id IS NULL` for `fleet`.
const AGGREGATES = {
  all: "SELECT max(created_at) FROM audit_logs",
  fleet: "SELECT max(created_at) FROM audit_logs WHERE tenant_id IS NULL",
} as const;

const INDEX_FOR = {
  all: "audit_logs_created_at_idx",
  fleet: "audit_logs_fleet_created_at_idx",
} as const;

// The FIRST PAGE of the fleet trail, which is the request an operator makes by opening it: keyset
// ordered by id, no filter at all.
const FLEET_PAGE =
  "SELECT id FROM audit_logs WHERE tenant_id IS NULL ORDER BY id DESC LIMIT 51";
const FLEET_PAGE_INDEX = "audit_logs_fleet_id_idx";

async function planIn(tx: PrismaClient, sql: string): Promise<string> {
  const rows = (await tx.$queryRawUnsafe(
    `EXPLAIN (FORMAT JSON) ${sql}`,
  )) as Array<{ "QUERY PLAN": Array<{ Plan: unknown }> }>;
  return JSON.stringify(rows[0]?.["QUERY PLAN"]?.[0]?.Plan ?? {});
}

describe.skipIf(!dbUp)("latestAt reaches its index on every scope", () => {
  afterAll(async () => {
    await su?.$disconnect();
  });

  for (const scope of ["all", "fleet"] as const) {
    test(`scope=${scope} takes one row off ${INDEX_FOR[scope]}, and scans without it`, async () => {
      await expect(
        suDb.$transaction(async (tx) => {
          const db = tx as unknown as PrismaClient;
          await db.$executeRawUnsafe("SET LOCAL enable_seqscan = off");

          const withIndex = await planIn(db, AGGREGATES[scope]);
          expect(withIndex).toContain(`"Index Name":"${INDEX_FOR[scope]}"`);
          // The MIN/MAX rewrite: one row off the end of the index, never an aggregate over rows.
          expect(withIndex).toContain('"Node Type":"Limit"');
          // And nothing left to re-check per row. On the fleet trail this is the assertion that
          // separates the partial index from the plain one: with only `audit_logs_created_at_idx`
          // the planner still produces a `Limit`, but it walks created_at backwards carrying
          // `Filter: (tenant_id IS NULL)` -- constant while fleet rows are recent, and a walk of the
          // whole trail the moment the newest ones are old (measured by dropping only the partial
          // index here). Baked into the index, the predicate costs nothing to hold.
          expect(withIndex).not.toContain('"Filter"');

          // What the same query does with neither index: both go, because the fleet aggregate falls
          // back onto the plain one and would hide the shape this is about. Rolled back, so the drop
          // never outlives this assertion.
          await db.$executeRawUnsafe(`DROP INDEX ${INDEX_FOR.fleet}`);
          await db.$executeRawUnsafe(`DROP INDEX ${INDEX_FOR.all}`);
          const without = await planIn(db, AGGREGATES[scope]);
          expect(without).not.toContain('"Node Type":"Limit"');
          expect(without).toContain('"Node Type":"Aggregate"');

          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
    });
  }

  // The drop above is only rolled back if the transaction really did roll back, and a test that
  // silently kept it would take the next one down with it -- so ask the catalog afterwards.
  test("both indexes are still on the table", async () => {
    const rows = (await suDb.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'audit_logs'`,
    )) as Array<{ indexname: string }>;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain(INDEX_FOR.all);
    expect(names).toContain(INDEX_FOR.fleet);
    expect(names).toContain(FLEET_PAGE_INDEX);
  });

  // THE LIST, not the aggregate, and it is the request an operator makes by simply opening the fleet
  // trail. `tenant_id IS NULL` orders and pages by `id`, which neither `created_at` index can supply,
  // so Postgres walked the primary key backwards discarding every tenant row until it had 51 -- and
  // the cost is not proportional to the trail's size but to how OLD its newest fleet rows are, which
  // on a deployment that has stopped creating tenants is the whole table. Measured on 500k rows with
  // the fleet slice at the far end: 6,731 buffers and 487,500 rows discarded to return one page,
  // against 3 buffers off the partial index. The rows keyed to no tenant are a fraction of the trail
  // (12.5k of 500k measured), so the index that makes it exact costs 296 kB.
  test("the fleet trail's first page comes off its own index, not a walk of the table", async () => {
    await expect(
      suDb.$transaction(async (tx) => {
        const db = tx as unknown as PrismaClient;
        await db.$executeRawUnsafe("SET LOCAL enable_seqscan = off");

        const withIndex = await planIn(db, FLEET_PAGE);
        // WHICH ROWS ARE READ AT ALL is the assertion, and it is the one that does not move: they
        // are selected by the fleet index, so the work is bounded by the fleet slice instead of by
        // the trail. Whether the planner then walks that index in order or gathers it and sorts is a
        // cost choice that flips with the slice's SIZE, and both were measured: at 12,500 fleet rows
        // it takes the ordered walk (3 buffers), and on a table holding two it bitmap-scans the same
        // index and sorts, which at that size is right. Pinning either would make this test pass or
        // fail on how much other suites happened to leave in a shared table.
        expect(withIndex).toContain(`"Index Name":"${FLEET_PAGE_INDEX}"`);
        expect(withIndex).not.toContain('"Index Name":"audit_logs_pkey"');
        // A `Filter` is a row read for some other reason and then rejected; the fleet index leaves
        // nothing to reject. (A bitmap scan's `Recheck Cond` is not that -- it re-reads only rows the
        // same index already chose.)
        expect(withIndex).not.toContain('"Filter"');

        await db.$executeRawUnsafe(`DROP INDEX ${FLEET_PAGE_INDEX}`);
        const without = await planIn(db, FLEET_PAGE);
        // WITHOUT it, no index gives BOTH the predicate and the id order, so the plan has to buy one
        // of them with a full pass. Which pass depends on the table: on a large one the planner
        // walks the primary key backwards re-checking every row (measured: 487,500 discarded for a
        // page of 51); on a small one it gathers every fleet row off the other partial index and
        // sorts. Either is unbounded by the page size, which is the property being asserted -- so
        // the assertion names both rather than pinning the plan of whichever table it runs on.
        expect(without).not.toContain(`"Index Name":"${FLEET_PAGE_INDEX}"`);
        expect(without).toMatch(
          /"Node Type":"Sort"|"Filter":"\(tenant_id IS NULL\)"/,
        );

        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
  });

  // The partial predicate is the whole point of the fleet indexes: without it an index would hold
  // every row of the trail and `tenant_id IS NULL` would be a filter over the full history again.
  for (const name of [INDEX_FOR.fleet, FLEET_PAGE_INDEX]) {
    test(`${name} covers only the rows keyed to no tenant`, async () => {
      const rows = (await suDb.$queryRawUnsafe(
        `SELECT indexdef FROM pg_indexes WHERE indexname = '${name}'`,
      )) as Array<{ indexdef: string }>;
      expect(rows[0]?.indexdef ?? "").toContain("WHERE (tenant_id IS NULL)");
    });
  }

  // A CONCURRENT build that is interrupted leaves the index in place and INVALID, which Postgres
  // silently declines to use: the plan quietly goes back to the walk this migration removed, with
  // the migration recorded as applied and nothing to see. The migration re-runs from a clean slate
  // (`DROP INDEX IF EXISTS` before each build) so a redeploy repairs it, and this asks the catalog
  // that no such leftover is here now.
  test("no index on the trail was left behind invalid", async () => {
    const rows = (await suDb.$queryRawUnsafe(
      `SELECT c.relname AS name FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
         JOIN pg_class t ON t.oid = i.indrelid
        WHERE t.relname = 'audit_logs' AND NOT i.indisvalid`,
    )) as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual([]);
  });
});
