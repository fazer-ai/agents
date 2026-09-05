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
  all: "audit_logs_created_at_id_idx",
  fleet: "audit_logs_fleet_created_at_id_idx",
} as const;

// The FIRST PAGE of the fleet trail, which is the request an operator makes by opening it. Ordered
// by `(created_at, id)` since #530 -- which is also why the partial index on `id` this used to name
// is gone: the ordering it existed for no longer exists.
const FLEET_PAGE =
  "SELECT id FROM audit_logs WHERE tenant_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 51";

// A TRAIL WORTH PLANNING FOR, seeded inside the caller's own (rolled-back) transaction.
//
// Every assertion in this file is about which index the planner REACHES, and that is a cost choice:
// on a table holding a handful of fleet rows every partial index costs about the same, so the
// planner picks whichever is narrower -- `audit_logs_fleet_id_idx`, which is kept only for the
// pre-#530 rolling overlap -- and pays a `Sort` and a `Filter` on top. That is the exact shape these
// tests exist to forbid, and it appeared only because the plan was being read off whatever rows
// other suites happened to leave in a shared table: the same assertions pass alone and failed inside
// the full run (measured, on the master tree, where the suite writes more of them).
//
// So the rows the plan is read off are the test's own. `ANALYZE` is transactional like the inserts,
// so both are gone at the rollback, and the choice stops depending on the order the suite ran in.
async function seedTrailFor(tx: PrismaClient): Promise<void> {
  // Keyed to NO tenant, which is both what the fleet slice IS and what keeps this free of the
  // tenants table: a row with `tenant_id` set would need one that exists, and the ids in a shared
  // test database are not this file's to know (measured: the lowest is in the hundreds, so the
  // literal `tenant_id = 1` below matches nothing and always did).
  await tx.$executeRawUnsafe(`
    INSERT INTO audit_logs (tenant_id, actor_id, actor_type, action, target, created_at)
    SELECT NULL, NULL, 'system', 'plan.probe', 'p:' || g,
           now() - ((g % 200) || ' days')::interval
    FROM generate_series(1, 12500) g`);
  // ...and the trail AROUND it, so the fleet slice is the MINORITY it is on a real deployment
  // (12,500 of 500,000 measured, and the header's numbers are read off that shape). Seeding only
  // the fleet rows would leave a table that is almost entirely fleet, where the partial indexes and
  // the plain ones cost the same and the plan says nothing about either.
  await tx.$executeRawUnsafe(`
    INSERT INTO audit_logs (tenant_id, actor_id, actor_type, action, target, created_at)
    SELECT (SELECT min(id) FROM tenants), NULL, 'system', 'plan.probe', 'q:' || g,
           now() - ((g % 200) || ' days')::interval
    FROM generate_series(1, 100000) g`);
  await tx.$executeRawUnsafe("ANALYZE audit_logs");
}

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
          await seedTrailFor(db);

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
        // THE ORDERED FLEET INDEX, named rather than either-of-two. An earlier version of this
        // accepted `..._fleet_id_idx` as well, on the reasoning that both are partial on
        // `tenant_id IS NULL` and so both bound the work by the fleet slice. They do -- but only one
        // of them also gives the ORDER the page is read in, and the other buys it with a `Sort`,
        // which is half of what #530 removed. Accepting both hid that, and it was accepted only
        // because the plan was being read off a table whose contents belong to the rest of the
        // suite. With the slice seeded above it is a fact about the indexes again.
        expect(withIndex).toContain(
          '"Index Name":"audit_logs_fleet_created_at_id_idx"',
        );
        expect(withIndex).not.toContain('"Node Type":"Sort"');
        expect(withIndex).not.toContain('"Index Name":"audit_logs_pkey"');
        // A `Filter` is a row read for some other reason and then rejected; the fleet index leaves
        // nothing to reject. (A bitmap scan's `Recheck Cond` is not that -- it re-reads only rows the
        // same index already chose.)
        expect(withIndex).not.toContain('"Filter"');

        // BOTH of them, for the negative half: leaving one standing proves nothing about the other.
        await db.$executeRawUnsafe(`DROP INDEX ${INDEX_FOR.fleet}`);
        await db.$executeRawUnsafe(
          `DROP INDEX IF EXISTS audit_logs_fleet_id_idx`,
        );
        const without = await planIn(db, FLEET_PAGE);
        // WITHOUT it, no index gives BOTH the predicate and the id order, so the plan has to buy one
        // of them with a full pass. Which pass depends on the table: on a large one the planner
        // walks the primary key backwards re-checking every row (measured: 487,500 discarded for a
        // page of 51); on a small one it gathers every fleet row off the other partial index and
        // sorts. Either is unbounded by the page size, which is the property being asserted -- so
        // the assertion names both rather than pinning the plan of whichever table it runs on.
        expect(without).not.toMatch(
          /"Index Name":"audit_logs_fleet_(created_at_id|id)_idx"/,
        );
        expect(without).toMatch(
          /"Node Type":"Sort"|"Filter":"\(tenant_id IS NULL\)"/,
        );

        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
  });

  // THE FILTERED PAGE, WHICH IS WHAT #530 IS ABOUT. A date filter used to be a plain predicate over a
  // walk ordered by `id`, so a window that is not the newest one made Postgres walk the primary key
  // backwards and discard everything outside it -- a cost proportional not to the page but to how
  // far back the window reached. Measured on a 500k-row probe carrying this table's own indexes, a
  // 30-day window 80 days back, page of 51:
  //
  //                     ORDER BY id (before)      ORDER BY created_at, id (after)
  //   scope=tenant   9,277 buffers  24.3 ms        39 buffers  0.15 ms
  //   scope=fleet    6,857 buffers   4.4 ms        32 buffers  0.04 ms
  //   scope=all      9,237 buffers  38.6 ms         5 buffers  0.02 ms
  //
  // 448,000 rows discarded to collect 51. Ordering by the column the window is CUT ON turns it into
  // a range scan of an index already sorted the way the page is read -- and no index had to be
  // added, which is the finding: the ones the table has were unreachable only because of the
  // ORDER BY. So the assertion is that the walk reads the window and not the table, in both
  // directions: WITH the ordering, no pkey and nothing re-checked per row; with the ordering put
  // back to `id`, the pkey walk returns.
  const WINDOW =
    "created_at >= now() - interval '110 days' AND created_at < now() - interval '80 days'";
  for (const [scope, pred] of [
    ["tenant", "tenant_id = 1 AND "],
    ["fleet", "tenant_id IS NULL AND "],
    ["all", ""],
  ] as const) {
    test(`a dated page on scope=${scope} reads the window, not the trail`, async () => {
      await expect(
        suDb.$transaction(async (tx) => {
          const db = tx as unknown as PrismaClient;
          await db.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
          await seedTrailFor(db);
          const page = (order: string) =>
            `SELECT id FROM audit_logs WHERE ${pred}${WINDOW} ORDER BY ${order} LIMIT 51`;

          const now = await planIn(db, page("created_at DESC, id DESC"));
          // A created_at index is what serves it, and the primary key is what must NOT.
          expect(now).toMatch(/"Index Name":"audit_logs_\w*created_at\w*"/);
          expect(now).not.toContain('"Index Name":"audit_logs_pkey"');

          // The same rows asked for in the old order, which is the plan this change removes. On a
          // table holding a handful of rows the planner may still reach an index, so the assertion
          // is that the two plans DIFFER -- the ordering is doing the work, not the indexes, which
          // are identical on both sides of this comparison.
          const before = await planIn(db, page("id DESC"));
          expect(before).not.toBe(now);

          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
    });
  }

  // THE `id` AT THE END OF EACH INDEX, and the case that argues for it. A transaction stamps every
  // row it writes with one `NOW()` -- `20260903120000_rename_http_tools_named_after_natives` writes
  // an audit row per renamed tool that way -- so a large TIED GROUP is something this table really
  // holds. An index that stops at `created_at` cannot supply the `id DESC` inside such a group, so
  // a page landing in it reads the whole group and sorts: measured on 200,000 rows sharing one
  // instant, 4,277 buffers and 22.1 ms against 2 buffers and 0.07 ms. The cost is bounded by the
  // tie, not by the page — which is the same unbounded shape this whole change removes, one level
  // down. A first measurement on a probe with all-distinct stamps said the id changed nothing; it
  // was the probe that was missing the case.
  test("every audit index carries the page's full ordering key", async () => {
    const rows = (await suDb.$queryRawUnsafe(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'audit_logs'`,
    )) as Array<{ indexname: string; indexdef: string }>;
    const ordering = rows.filter((r) => r.indexdef.includes("created_at"));
    expect(ordering.length).toBeGreaterThan(0);
    for (const r of ordering) {
      expect(r.indexdef).toMatch(/created_at DESC, id DESC/);
    }
    // ...and `audit_logs_fleet_id_idx` IS STILL HERE, on purpose. It serves only the old
    // `ORDER BY id` fleet page, which this release stops issuing -- but `docs/deploy.md` describes
    // rolling deploys, so for the length of one overlap a container from the previous release is
    // still asking that question, and without the index it walks the primary key past every tenant
    // row: measured, 8,687 buffers and 21.5 ms against 2. It comes out in a later release, once no
    // old process can be serving (docs/roadmap.md). The other three old indexes went now because
    // the new ones answer their queries too, verified on the same probe.
    expect(rows.map((r) => r.indexname)).toContain("audit_logs_fleet_id_idx");
  });

  // The partial predicate is the whole point of the fleet indexes: without it an index would hold
  // every row of the trail and `tenant_id IS NULL` would be a filter over the full history again.
  for (const name of [INDEX_FOR.fleet]) {
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
