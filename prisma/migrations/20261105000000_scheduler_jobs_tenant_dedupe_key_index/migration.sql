-- CreateIndex
-- The follow-up sweeps match a conversation's job by (tenant_id, kind, dedupe_key), and under the
-- tenant policy `kind = '...'` never reaches the unique index: enum equality is not LEAKPROOF, so
-- Postgres evaluates it above the security barrier and walks every kind of the tenant per candidate
-- (8.4 s against a 5 s budget on a production tenant with 335k rows, issue #1700). tenant_id and
-- dedupe_key are leakproof comparisons and do reach this index. CONCURRENTLY because scheduler_jobs
-- takes writes from every lane while the old container still serves. The DROP clears what an
-- interrupted build left, and also replaces the copy some instances created by hand with this exact
-- name as a mitigation; the next migration asserts the catalog.
DROP INDEX IF EXISTS "scheduler_jobs_tenant_id_dedupe_key_idx";
CREATE INDEX CONCURRENTLY "scheduler_jobs_tenant_id_dedupe_key_idx" ON "scheduler_jobs"("tenant_id", "dedupe_key");
