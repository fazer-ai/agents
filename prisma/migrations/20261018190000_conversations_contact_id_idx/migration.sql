-- CreateIndex
-- What a deleted contact's foreign key reads (issue #1531): `conversations.contact_id` is
-- `ON DELETE SET NULL`, so every contact that goes (an account removed, a deployment disconnected, a
-- tenant deleted) makes Postgres find the conversations that point at it. Without an index on the
-- column each one is a scan of the whole table: an account of 10k contacts over 106k conversations
-- took 48.8 s of a 49.9 s delete in that trigger alone, against a 5 s transaction budget.
--
-- CONCURRENTLY because `conversations` is hot and `migrate deploy` runs in the NEW container with the
-- OLD one still serving (docs/deploy.md): a plain build takes SHARE for the whole scan and blocks every
-- mirror write. Not unique, so always buildable. The DROP clears what an interrupted build left, for
-- the `resolve --rolled-back` door (.claude/rules/prisma.md); the next migration asserts the catalog.
DROP INDEX IF EXISTS "conversations_contact_id_idx";
CREATE INDEX CONCURRENTLY "conversations_contact_id_idx" ON "conversations"("contact_id");
