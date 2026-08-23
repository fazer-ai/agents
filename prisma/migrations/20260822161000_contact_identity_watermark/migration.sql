-- Source watermarks for the contact's identity, for the same reason `custom_attributes_at` exists:
-- the write is otherwise unconditional and deliveries do arrive out of order, so an older event
-- could restore what a newer one cleared — and the authorization gate asks the endpoint about
-- whoever those values name.
--
-- ONE PER FIELD, not one per row. A Chatwoot payload states a SUBSET of the identity (a degraded
-- one carries no phone at all, and absent is not cleared), so a row-wide position would be advanced
-- by an event that says nothing about the field it then protects: a name-only event at t3 would
-- reject a phone clear from t2 that arrived after it, and the gate would go on asking about a
-- number the customer no longer has. A position may only be moved by a payload that actually spoke
-- about that field.
ALTER TABLE "contacts"
  ADD COLUMN "name_at" TIMESTAMP(3),
  ADD COLUMN "email_at" TIMESTAMP(3),
  ADD COLUMN "phone_at" TIMESTAMP(3),
  ADD COLUMN "attributes_at" TIMESTAMP(3);

-- `contacts` carries FORCE ROW LEVEL SECURITY, so `tenant_isolation` applies to the table OWNER too.
-- On managed Postgres the migration role is typically the owner WITHOUT rolsuper, and there this
-- backfill would match zero rows and report success (docs/deploy.md). Plain SET, not SET LOCAL:
-- outside a transaction SET LOCAL is a no-op with only a warning.
SET app.is_super_admin = 'on';

-- The watermark is seeded and the identity is KEPT, which are two different risks and only one of
-- them is worth paying for here.
--
-- Leaving the watermark null was not an option: the compare-and-set accepts anything against null,
-- including a Chatwoot retry already in flight when this ran, whose snapshot predates what is
-- stored. Seeding it from the newest conversation event closes that.
--
-- What seeding does NOT settle is whether the stored value belongs to that position. The old mirror
-- wrote identity before the conversation's stale check, so these columns hold what the last event to
-- ARRIVE said, not the newest to have happened, and nothing in the row says which. Seeding pins a
-- possibly-superseded value under a newer position, where the next event corrects it.
--
-- Clearing the identity instead would trade that for a certainty, and the wrong way round. The
-- values are LIVE: `{{nome_contato}}` and `{{contact_phone}}` in prompts and HTTP tools, the
-- `{contact_name}` of an HSM template, the name in the console's conversation list. Emptying them
-- for every contact of every tenant breaks all of that until each contact's next event, to protect
-- an authorization gate that ships DISABLED on every agent — so on the day of the upgrade there is
-- no contact being authorized under anything, vouched for or not.
--
-- And the gate does not inherit the doubt when it is switched on later. The reactive check runs
-- AFTER the mirror wrote the very message that triggered it (webhook.ts: mirrorChatwootEvent, then
-- the gate), so it reads identity that the message it is deciding about just refreshed. The one
-- caller that asks without an incoming message is the proactive nudge, and there the exposure is a
-- contact whose stored identity was already stale before this migration ran, which is the state
-- every deployment is in today.
UPDATE "contacts" ct
SET "name_at" = sub."last_event_at",
    "email_at" = sub."last_event_at",
    "phone_at" = sub."last_event_at",
    "attributes_at" = sub."last_event_at"
FROM (
  SELECT "contact_id", MAX("last_event_at") AS "last_event_at"
  FROM "conversations"
  WHERE "contact_id" IS NOT NULL AND "last_event_at" IS NOT NULL
  GROUP BY "contact_id"
) sub
WHERE ct."id" = sub."contact_id";

-- A contact with no positioned conversation keeps null watermarks, which is right: nothing has ever
-- positioned it, and the first dated event takes it over.

RESET app.is_super_admin;
