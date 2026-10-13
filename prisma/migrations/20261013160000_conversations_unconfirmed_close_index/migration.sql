-- CreateIndex
-- What the delivery sweep reads every five minutes per tenant (issue #1404): the closes this side
-- recorded (`resolved_by`) that the mirror never saw land (`status` not `resolved`), oldest first.
-- Partial, so it holds only that worklist, normally empty, and not every conversation the tenant ever
-- had; without it each pass walks the tenant's whole history to find nothing. Prisma cannot model a
-- partial index, so it lives here and not in schema.prisma. The query spells `'resolved'` as a literal
-- (src/modules/chatwoot/delivery-sweep.ts) because a bound parameter cannot be proven to imply this
-- predicate in a generic plan.
--
-- CONCURRENTLY because `conversations` is hot and `migrate deploy` runs in the NEW container with the
-- OLD one still serving (docs/deploy.md): a plain build takes SHARE for the whole scan and blocks every
-- mirror write. Not unique, so always buildable. The DROP clears what an interrupted build left, for
-- the `resolve --rolled-back` door (.claude/rules/prisma.md); the next migration asserts the catalog.
DROP INDEX IF EXISTS "conversations_unconfirmed_close_idx";
CREATE INDEX CONCURRENTLY "conversations_unconfirmed_close_idx" ON "conversations"("tenant_id", "updated_at") WHERE "resolved_by" IS NOT NULL AND "status" <> 'resolved';
