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
  });

  // The partial predicate is the whole point of the fleet index: without it the index would hold
  // every row of the trail and `tenant_id IS NULL` would be a filter over the full history again.
  test("the fleet index covers only the rows keyed to no tenant", async () => {
    const rows = (await suDb.$queryRawUnsafe(
      `SELECT indexdef FROM pg_indexes WHERE indexname = '${INDEX_FOR.fleet}'`,
    )) as Array<{ indexdef: string }>;
    expect(rows[0]?.indexdef ?? "").toContain("WHERE (tenant_id IS NULL)");
  });
});
