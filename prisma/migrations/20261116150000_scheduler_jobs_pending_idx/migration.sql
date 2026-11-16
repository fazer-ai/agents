-- THE ROWS WAITING TO BE CLAIMED, INDEXED BY THEMSELVES. Every lane's claim (src/modules/scheduler/
-- service.ts, `claimSql`) runs as the fleet and asks for `status = 'PENDING' AND run_at <= now`. With a
-- policy on the table Postgres hides the statistics of `status` from an enum comparison, so through
-- `(status, run_at)` the planner takes PENDING for a third of the table and scans it instead: about 24k
-- buffers per claim on a ledger of 425k rows, almost all DONE, with a few hundred waiting.
--
-- PARTIAL on the PENDING rows, whose predicate the claim's literal proves: its size follows the queue,
-- not the history, and the planner sizes it from the default equality guess, a fraction of the table.
-- CONCURRENTLY with the DROP first, the same re-runnable shape as 20261105000050, and asserted valid by
-- 20261116150300.
DROP INDEX IF EXISTS "scheduler_jobs_pending_idx";
CREATE INDEX CONCURRENTLY "scheduler_jobs_pending_idx"
    ON "scheduler_jobs"("run_at")
 WHERE "status" = 'PENDING';
