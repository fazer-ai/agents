-- CreateIndex
-- What the canonical step and a merge read: the readings bound to a canonical. Its own file, and not
-- the transaction that adds the column: `conversation_readings` holds an installation's readings from
-- the moment the occurrence monitor shipped, and a build inside that transaction would scan it while
-- the column's ACCESS EXCLUSIVE lock stopped every observer write.
--
-- CONCURRENTLY because `migrate deploy` runs in the NEW container with the OLD one still serving
-- (docs/deploy.md). Not unique, so always buildable. The DROP clears what an interrupted build left, for
-- the `resolve --rolled-back` door (.claude/rules/prisma.md); the next migration asserts the catalog.
DROP INDEX IF EXISTS "conversation_readings_canonical_id_idx";
CREATE INDEX CONCURRENTLY "conversation_readings_canonical_id_idx" ON "conversation_readings"("canonical_id");
