-- The contact's `additional_attributes` keys an agent may see and write (issue #1006), mirrored from
-- every webhook event under their own source watermark. Additive: an existing row reads `{}` until the
-- next event about that contact fills it.
ALTER TABLE "contacts" ADD COLUMN "additional_attributes" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "contacts" ADD COLUMN "additional_attributes_at" TIMESTAMP(3);
