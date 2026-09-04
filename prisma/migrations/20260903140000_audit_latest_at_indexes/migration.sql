-- `latestAt` in constant time on the two trails #520 added.
--
-- Every audit read reports the newest row of its trail past any filter, so this aggregate runs on
-- EVERY page and every filtered request. On the tenant trail it was already constant: the RLS
-- predicate is `tenant_id = …`, which lets Postgres turn `max(created_at)` into a one-row backward
-- walk of `audit_logs_tenant_id_created_at_idx`. Neither new scope can use that index the same way,
-- and the leading column is why:
--
--   scope=all    no predicate at all      -> Parallel Seq Scan of the whole table
--   scope=fleet  tenant_id IS NULL        -> Bitmap Heap Scan over EVERY fleet row
--
-- Measured on 500k rows (40 tenants, 12.5k of them keyed to no tenant), PG 17.10:
--
--   scope=tenant     7 buffers    0.046 ms   Limit + Index Only Scan Backward
--   scope=fleet   5720 buffers    5.6  ms    Bitmap Heap Scan, 12,500 rows read to keep one
--   scope=all     5669 buffers   18.9  ms    Parallel Seq Scan, 500,000 rows read to keep one
--
-- Both grow with the table, which on an append-only trail means forever. Rewriting the aggregate as
-- ORDER BY/LIMIT does not help: `tenant_id IS NULL` is indexable but does not carry the ordering
-- pathkey, so the planner still sorts the whole group (measured: 0.9 ms, 55 buffers, top-N heapsort
-- over 12,500 rows).
--
-- With the two indexes below, both become the same one-row walk the tenant trail already had:
--
--   scope=fleet      3 buffers    0.034 ms
--   scope=all        4 buffers    0.060 ms
--
-- The partial index is what makes `IS NULL` exact rather than a filter over the full history, and it
-- costs almost nothing (296 kB against the full index's 11 MB at that size) because it holds only
-- the rows that belong to no tenant. Both are btrees on a near-monotonic column, so an append lands
-- on the rightmost page -- the cheapest insert this table can pay.
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" ("created_at");

CREATE INDEX "audit_logs_fleet_created_at_idx" ON "audit_logs" ("created_at")
  WHERE "tenant_id" IS NULL;
