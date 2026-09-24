-- CreateIndex
-- CONCURRENTLY because `llm_usage` takes one row per billed model call, and `migrate deploy` runs in
-- the NEW container with the OLD one still serving (docs/deploy.md): the plain build takes SHARE,
-- which blocks every usage write, and so every turn's ledger row, for the whole scan (issue #839).
-- Not unique, so always buildable. The DROP clears what an interrupted build left, for the
-- `resolve --rolled-back` door (.claude/rules/prisma.md); the next migration asserts the catalog.
DROP INDEX IF EXISTS "llm_usage_tenant_id_thread_id_idx";
CREATE INDEX CONCURRENTLY "llm_usage_tenant_id_thread_id_idx" ON "llm_usage"("tenant_id", "thread_id");
