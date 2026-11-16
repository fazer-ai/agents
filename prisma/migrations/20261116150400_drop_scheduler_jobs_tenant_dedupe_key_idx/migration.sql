-- `scheduler_jobs_tenant_id_dedupe_key_pattern_idx` answers every lookup this one served (its
-- opclass carries `=`) and the prefix reads it cannot, and it is valid by the time this runs
-- (20261116150300). Two indexes on the same columns would cost every write on the busiest job table.
-- CONCURRENTLY and alone in its file, so the drop takes no lock that stops a claim.
DROP INDEX CONCURRENTLY IF EXISTS "scheduler_jobs_tenant_id_dedupe_key_idx";
