-- Source watermark for the contact's identity (name, e-mail, phone, operator identifier), for the
-- same reason `custom_attributes_at` exists: the write is otherwise unconditional and deliveries do
-- arrive out of order, so an older event could restore what a newer one cleared — and the
-- authorization gate asks the endpoint about whoever those values name.
ALTER TABLE "contacts" ADD COLUMN "identity_at" TIMESTAMP(3);

-- Seeded, NOT left null. NULL means "never positioned", and the compare-and-set accepts any payload
-- against it — including a Chatwoot retry that was already in flight when this migration ran, whose
-- snapshot predates the identity now stored. It would overwrite a correct row and, with no newer
-- event behind it, leave the gate asking about the stale identity indefinitely.
--
-- The contact's newest conversation event is the most conservative position available: whatever the
-- old mirror last wrote to this row cannot be older than the events that carried it. A contact with
-- no conversation keeps NULL, which is right — nothing has ever positioned it.
UPDATE "contacts" ct
SET "identity_at" = sub."last_event_at"
FROM (
  SELECT "contact_id", MAX("last_event_at") AS "last_event_at"
  FROM "conversations"
  WHERE "contact_id" IS NOT NULL AND "last_event_at" IS NOT NULL
  GROUP BY "contact_id"
) sub
WHERE ct."id" = sub."contact_id";
