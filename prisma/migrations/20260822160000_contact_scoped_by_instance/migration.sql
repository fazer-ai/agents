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

-- `contacts` and `conversations` carry FORCE ROW LEVEL SECURITY, so `tenant_isolation` applies to
-- the table OWNER too and only a superuser is exempt. docs/deploy.md allows MIGRATION_DATABASE_URL
-- to be "superuser OR owner", and on managed Postgres the admin role is typically the owner without
-- rolsuper: there every data statement below would match ZERO rows and report success, leaving the
-- backfill undone and the `SET NOT NULL` at the end failing the deploy. Plain SET, not SET LOCAL:
-- outside a transaction SET LOCAL is a no-op with only a warning, which is the failure this guards.
SET app.is_super_admin = 'on';

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

-- The collapsed case. A contact whose conversations span two instances keeps the instance chosen
-- above, and BOTH sides of that collision are unsafe, not just one:
--
--   * the conversations of the OTHER instance were still pointing at this row, so they would go on
--     reading a phone, an e-mail and an identifier belonging to the other account's customer;
--   * and the row's OWN fields do not necessarily come from the instance it kept. The old mirror
--     wrote identity before the conversation's stale check, so a delayed event from either account
--     could have been the last writer regardless of which has the newest conversation.
--
-- A queued proactive nudge does not wait for a webhook to correct either, so it would authorize and
-- then message the wrong person. The other side is unlinked (NULL is a state the column already
-- has, the FK being ON DELETE SET NULL) and the retained side is cleared, which the gate reads as
-- `no_identity`: fail-closed, and repopulated by the next event from that account.
--
-- EVERY per-contact field the collision could have written, not just the identity ones. The custom
-- attributes are injected into the system prompt, so the losing account's bag would be read to the
-- retained account's customer as facts about them, and its watermark goes with it or the next real
-- event may be judged stale against a position it never held. The audio preference goes too: it is
-- written by the agent and never mirrored back from Chatwoot, so nothing would ever correct it, and
-- null is a state it already has (unknown ⇒ mirror what the customer sends).
--
-- The retained side FIRST, while the cross-instance links are still there to identify it by: the
-- unlink below is what erases the evidence of the collision.
UPDATE "contacts" ct
SET "name" = NULL, "email" = NULL, "phone" = NULL, "attributes" = '{}'::jsonb,
    "custom_attributes" = '{}'::jsonb, "custom_attributes_at" = NULL,
    "voice_reply" = NULL
WHERE EXISTS (
  SELECT 1 FROM "conversations" c
  WHERE c."contact_id" = ct."id"
    AND c."chatwoot_instance_id" IS DISTINCT FROM ct."chatwoot_instance_id"
);

UPDATE "conversations" c
SET "contact_id" = NULL
FROM "contacts" ct
WHERE c."contact_id" = ct."id"
  AND c."chatwoot_instance_id" IS DISTINCT FROM ct."chatwoot_instance_id";

RESET app.is_super_admin;

ALTER TABLE "contacts" ALTER COLUMN "chatwoot_instance_id" SET NOT NULL;

DROP INDEX IF EXISTS "contacts_tenant_id_chatwoot_contact_id_key";
CREATE UNIQUE INDEX "contacts_tenant_id_chatwoot_instance_id_chatwoot_contact_id_key"
  ON "contacts" ("tenant_id", "chatwoot_instance_id", "chatwoot_contact_id");

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_chatwoot_instance_id_fkey"
  FOREIGN KEY ("chatwoot_instance_id") REFERENCES "chatwoot_instances" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
