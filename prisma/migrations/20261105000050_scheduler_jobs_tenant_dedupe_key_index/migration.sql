-- CreateIndex
-- The follow-up sweeps match a conversation's job by (tenant_id, kind, dedupe_key), and under the
-- tenant policy `kind = '...'` never reaches the unique index: enum equality is not LEAKPROOF, so
-- Postgres evaluates it above the security barrier and walks every kind of the tenant per candidate
-- (8.4 s against a 5 s budget on a production tenant with 335k rows, issue #1700). tenant_id and
-- dedupe_key are leakproof comparisons and do reach this index. CONCURRENTLY because scheduler_jobs
-- takes writes from every lane while the old container still serves. IF NOT EXISTS keeps the valid
-- copy an instance may already have under this name; an invalid leftover was dropped by the previous
-- migration, and the next one asserts the catalog.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "scheduler_jobs_tenant_id_dedupe_key_idx" ON "scheduler_jobs"("tenant_id", "dedupe_key");
