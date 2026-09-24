-- CreateIndex
-- What the inbound sweep reads every two minutes per tenant (issue #817): the deliveries that are not
-- finished. Partial, so it holds only the handful of rows in flight or stranded and not the whole
-- history the table keeps; without it each pass walks every delivery the tenant ever received. Prisma
-- cannot model a partial index, so it lives here and not in schema.prisma.
--
-- CONCURRENTLY because `migrate deploy` runs in the NEW container with the OLD one still serving
-- (docs/deploy.md), and a plain build takes SHARE for the whole scan, which blocks every inbound
-- webhook's insert and every processing update: the acks stall for as long as the history takes to
-- read. Not unique, so always buildable. The DROP clears what an interrupted build left, for the
-- `resolve --rolled-back` door (.claude/rules/prisma.md); the next migration asserts the catalog.
DROP INDEX IF EXISTS "inbound_deliveries_unfinished_idx";
CREATE INDEX CONCURRENTLY "inbound_deliveries_unfinished_idx" ON "inbound_deliveries"("tenant_id", "id") WHERE "status" IN ('PENDING', 'PROCESSING');
