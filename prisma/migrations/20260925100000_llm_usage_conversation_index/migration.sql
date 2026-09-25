-- CreateIndex
-- The conversation screen sums the ledger by conversation (issue #853), and without this the sum
-- walks every row of the tenant each time a conversation is opened. CONCURRENTLY for the same reason
-- as `20260924150000_llm_usage_thread_index`: `llm_usage` takes one row per billed model call, and the
-- plain build's SHARE lock would block every turn's ledger row for the whole scan while the old
-- container still serves. Not unique, so always buildable. The DROP clears what an interrupted build
-- left, for the `resolve --rolled-back` door (.claude/rules/prisma.md); the next migration asserts the
-- catalog.
DROP INDEX IF EXISTS "llm_usage_tenant_id_conversation_id_idx";
CREATE INDEX CONCURRENTLY "llm_usage_tenant_id_conversation_id_idx" ON "llm_usage"("tenant_id", "conversation_id");
