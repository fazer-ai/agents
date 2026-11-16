-- THE MONTH'S COST OF ONE SOURCE, READ FROM THE INDEX ALONE. The spend-ceiling poll
-- (src/modules/spend-ceiling/poll.ts) sums `cost_usd` per tenant and source over the calendar month
-- every minute, and the console's usage read asks the same window. On (tenant_id, created_at) every
-- such read visits the heap row of every ledger entry of the month to filter `source` and read
-- `cost_usd`: about 300k buffers and 220 ms per source per poll on a busy production ledger.
--
-- `cost_usd` is the LAST KEY COLUMN rather than an INCLUDE, so the schema can declare the index and
-- `migrate dev` does not drop it: the plan and the size are the same (78 MB on 1.4M rows, both
-- forms, measured).
--
-- CONCURRENTLY with the DROP first, the same re-runnable shape as 20261109120000, and asserted valid
-- by the migration after this one.
DROP INDEX IF EXISTS "llm_usage_tenant_id_source_created_at_cost_usd_idx";
CREATE INDEX CONCURRENTLY "llm_usage_tenant_id_source_created_at_cost_usd_idx"
    ON "llm_usage"("tenant_id", "source", "created_at", "cost_usd");
