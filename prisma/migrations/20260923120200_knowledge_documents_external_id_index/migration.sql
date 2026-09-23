-- CreateIndex
-- CONCURRENTLY because `knowledge_documents` is read by every search and written by every upload, and
-- `migrate deploy` runs in the NEW container with the OLD one still serving (docs/deploy.md): the
-- plain build takes SHARE, which blocks every document write for the whole scan.
-- UNIQUE, and buildable by construction: every row that exists before this release has a NULL
-- external id, and NULLs never collide. The DROP clears what an interrupted build left, for the
-- `resolve --rolled-back` door (.claude/rules/prisma.md); the next migration asserts the catalog.
DROP INDEX IF EXISTS "knowledge_documents_knowledge_base_id_external_id_key";
CREATE UNIQUE INDEX CONCURRENTLY "knowledge_documents_knowledge_base_id_external_id_key" ON "knowledge_documents"("knowledge_base_id", "external_id");
