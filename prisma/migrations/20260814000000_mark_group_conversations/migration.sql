ALTER TABLE "conversations"
ADD COLUMN "is_group" BOOLEAN NOT NULL DEFAULT false;

UPDATE "conversations" AS conversation
SET "is_group" = true
FROM "contacts" AS contact
WHERE conversation."contact_id" = contact."id"
  AND (
    lower(contact."phone") LIKE '%@g.us'
    OR lower(contact."attributes"->>'identifier') LIKE '%@g.us'
  );
