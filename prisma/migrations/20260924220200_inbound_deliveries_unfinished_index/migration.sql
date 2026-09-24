-- What the inbound sweep reads every few minutes per tenant (issue #817): the deliveries that are not
-- finished. Partial, so it holds only the handful of rows in flight or stranded and not the whole
-- history the table keeps; without it each pass walks every delivery the tenant ever received through
-- the unique index's tenant prefix and reads each heap row to learn its status. Prisma cannot model a
-- partial index, so it lives here and not in schema.prisma.
CREATE INDEX IF NOT EXISTS "inbound_deliveries_unfinished_idx"
  ON "inbound_deliveries" ("tenant_id", "received_at")
  WHERE "status" IN ('PENDING', 'PROCESSING');
