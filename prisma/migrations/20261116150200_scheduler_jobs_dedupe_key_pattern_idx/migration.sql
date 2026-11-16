-- THE KEY LOOKUPS, BYTE-WISE. A prefix read under the tenant policy (`dedupeKeyStartsWith` in
-- src/modules/scheduler/service.ts) reaches an index only through leakproof operators. `LIKE` and the
-- enums `kind` and `status` are not; `starts_with` is, and Postgres turns it into a range over an index
-- whose order is byte-wise. Without it the turn barrier's fallback read walked every row of the
-- tenant, 15k buffers per call.
-- The same opclass serves `=`, so it replaces `scheduler_jobs_tenant_id_dedupe_key_idx` for the
-- correlated lookups by key, which 20261116150400 drops once this one is asserted valid by
-- 20261116150300.
DROP INDEX IF EXISTS "scheduler_jobs_tenant_id_dedupe_key_pattern_idx";
CREATE INDEX CONCURRENTLY "scheduler_jobs_tenant_id_dedupe_key_pattern_idx"
    ON "scheduler_jobs"("tenant_id", "dedupe_key" text_pattern_ops);
