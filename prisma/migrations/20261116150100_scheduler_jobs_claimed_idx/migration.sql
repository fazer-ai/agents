-- THE ROWS A PROCESS HAS CLAIMED, INDEXED BY THEMSELVES, for the reaper (`reapSql`): as the fleet,
-- `status = 'CLAIMED' AND claimed_at < cutoff`, the same trap as the claim's PENDING read in
-- 20261116150000. PARTIAL, so it holds the claims in flight. Asserted valid by 20261116150300.
DROP INDEX IF EXISTS "scheduler_jobs_claimed_idx";
CREATE INDEX CONCURRENTLY "scheduler_jobs_claimed_idx"
    ON "scheduler_jobs"("claimed_at")
 WHERE "status" = 'CLAIMED';
