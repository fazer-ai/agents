-- Scope the mirrored contact by Chatwoot instance (issue #182's gate treats it as identity).
--
-- A Chatwoot contact id is unique inside ONE account, not across a tenant. `contacts` was keyed
-- (tenant_id, chatwoot_contact_id) while `inboxes` and `conversations` were already keyed by
-- instance, so two accounts under one tenant collapsed contact 42 into a single row and the
-- mirror's last-writer-wins left one person's name sitting over another's phone. That was already
-- wrong for the prompt; the contact-authorization gate makes it an authorization decision, because
-- the row is the identity sent to the operator's endpoint.
--
-- Backfill: a contact's instance is the instance of its conversations, which is the only record of
-- where it came from. A contact whose conversations span two instances is exactly the collapsed
-- case; it keeps the instance of its most recent conversation and the other account's contact is
-- re-mirrored as a new row on its next event. A contact with no conversation at all cannot be
-- placed and is deleted: nothing references it, and the mirror rebuilds it on the next event.
ALTER TABLE "contacts" ADD COLUMN "chatwoot_instance_id" BIGINT;

UPDATE "contacts" c
SET "chatwoot_instance_id" = sub."chatwoot_instance_id"
FROM (
  SELECT DISTINCT ON ("contact_id") "contact_id", "chatwoot_instance_id"
  FROM "conversations"
  WHERE "contact_id" IS NOT NULL
  ORDER BY "contact_id", "last_event_at" DESC NULLS LAST, "id" DESC
) sub
WHERE c."id" = sub."contact_id";

DELETE FROM "contacts" WHERE "chatwoot_instance_id" IS NULL;

ALTER TABLE "contacts" ALTER COLUMN "chatwoot_instance_id" SET NOT NULL;

DROP INDEX IF EXISTS "contacts_tenant_id_chatwoot_contact_id_key";
CREATE UNIQUE INDEX "contacts_tenant_id_chatwoot_instance_id_chatwoot_contact_id_key"
  ON "contacts" ("tenant_id", "chatwoot_instance_id", "chatwoot_contact_id");

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_chatwoot_instance_id_fkey"
  FOREIGN KEY ("chatwoot_instance_id") REFERENCES "chatwoot_instances" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
