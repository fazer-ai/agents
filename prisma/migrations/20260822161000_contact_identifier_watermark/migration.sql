-- Source watermark for the operator identifier bag, for the same reason `custom_attributes_at`
-- exists: the write is otherwise unconditional and deliveries do arrive out of order, so an older
-- event could restore an identifier a newer one cleared — and the authorization gate asks the
-- endpoint about whoever that value names. Nullable with no backfill: NULL is "never positioned",
-- and the first dated event takes over.
ALTER TABLE "contacts" ADD COLUMN "attributes_at" TIMESTAMP(3);
