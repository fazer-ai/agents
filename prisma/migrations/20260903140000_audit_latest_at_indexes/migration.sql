-- The two trails #520 added, in constant time.
--
-- `latestAt` runs on EVERY page and every filtered request, and the first page of a trail is what an
-- operator gets by opening it. Both were already constant for a tenant: RLS supplies
-- `tenant_id = …`, the leading column of `audit_logs_tenant_id_created_at_idx`, so Postgres turns
-- `max(created_at)` into a one-row backward walk of it and pages the keyset off the primary key
-- within one tenant's rows. Neither new scope can use that index the same way.
--
-- Measured on 500k rows (40 tenants, 12.5k of them keyed to no tenant), PG 17.10:
--
--   scope=tenant   latestAt      7 buffers    0.046 ms   Limit + Index Only Scan Backward
--   scope=fleet    latestAt   5720 buffers    5.6  ms    Bitmap Heap Scan, 12,500 rows to keep one
--   scope=all      latestAt   5669 buffers   18.9  ms    Parallel Seq Scan, 500,000 rows to keep one
--   scope=fleet    page 1     6731 buffers   19.8  ms    pkey walked backwards, 487,500 discarded
--
-- The first three grow with the table, which on an append-only trail means forever. The fourth does
-- not grow with the table at all -- it grows with how OLD the newest fleet rows are, so it is worst
-- exactly where it looks most harmless: a deployment that has stopped creating tenants pays a walk
-- of the whole table to show page one. Rewriting the aggregate as ORDER BY/LIMIT fixes nothing:
-- `tenant_id IS NULL` is indexable but carries no ordering pathkey, so the planner still sorts the
-- whole group (0.9 ms, 55 buffers, top-N heapsort over 12,500 rows).
--
-- With the three indexes below: 4, 3 and 3 buffers. The two partial ones hold only the rows that
-- belong to no tenant -- 296 kB each against the full index's 11 MB at that size -- and all three are
-- btrees on a column that only ever grows, so an append lands on the rightmost page, the cheapest
-- insert this table can pay.
--
-- CONCURRENTLY, because a plain CREATE INDEX takes a SHARE lock that blocks every INSERT for the
-- length of the build, and on a rolling deploy this runs in the new container while the old one is
-- still serving (see docs/deploy.md). An audit row is written INSIDE the mutation's transaction, so
-- the lock would stall the configuration change itself, not just its record. Prisma runs this file
-- outside a transaction, which is what allows CONCURRENTLY at all -- and is also why the file is not
-- atomic: an interrupted build leaves the index in place and INVALID, which Postgres silently
-- declines to use, so the plan reverts to the walk with nothing to see. The DROPs are that recovery:
-- a redeploy after `migrate resolve --rolled-back` rebuilds from a clean slate rather than finding
-- the leftover and keeping it.
DROP INDEX IF EXISTS "audit_logs_created_at_idx";
DROP INDEX IF EXISTS "audit_logs_fleet_created_at_idx";
DROP INDEX IF EXISTS "audit_logs_fleet_id_idx";

CREATE INDEX CONCURRENTLY "audit_logs_created_at_idx" ON "audit_logs" ("created_at");

CREATE INDEX CONCURRENTLY "audit_logs_fleet_created_at_idx" ON "audit_logs" ("created_at")
  WHERE "tenant_id" IS NULL;

CREATE INDEX CONCURRENTLY "audit_logs_fleet_id_idx" ON "audit_logs" ("id")
  WHERE "tenant_id" IS NULL;
