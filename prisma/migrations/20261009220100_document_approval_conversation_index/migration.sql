-- CreateIndex
-- A conversation's approval requests, for the console's conversation view and the conversations list
-- flag (docs/documents.md, Approval). CONCURRENTLY because the requests are written while the old
-- container still serves, and the plain build's SHARE lock would block every request, decision and
-- outcome for the whole scan. Not unique, so always buildable. The DROP clears what an interrupted
-- build left, for the `resolve --rolled-back` door (.claude/rules/prisma.md); the next migration
-- asserts the catalog.
DROP INDEX IF EXISTS "document_approval_requests_tenant_id_conversation_id_idx";
CREATE INDEX CONCURRENTLY "document_approval_requests_tenant_id_conversation_id_idx" ON "document_approval_requests"("tenant_id", "conversation_id");
