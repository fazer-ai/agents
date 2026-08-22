-- Source watermark for the contact's identity (name, e-mail, phone, operator identifier), for the
-- same reason `custom_attributes_at` exists: the write is otherwise unconditional and deliveries do
-- arrive out of order, so an older event could restore what a newer one cleared — and the
-- authorization gate asks the endpoint about whoever those values name. Nullable with no backfill:
-- NULL is "never positioned", and the first dated event takes over.
ALTER TABLE "contacts" ADD COLUMN "identity_at" TIMESTAMP(3);
