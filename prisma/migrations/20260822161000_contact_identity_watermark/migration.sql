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

-- The identity is CLEARED as the watermark is seeded, and the two halves answer each other.
--
-- Leaving the watermark null was not an option: the compare-and-set accepts anything against null,
-- including a Chatwoot retry already in flight when this ran, whose snapshot predates what is
-- stored. But seeding it from the newest conversation event and KEEPING the identity is not safe
-- either, and for the opposite reason: the old mirror wrote identity before the conversation's
-- stale check, so what sits in these columns came from the last event to ARRIVE, not the newest one
-- to have happened. Stamping a possibly-superseded identity with the newest position would protect
-- it from correction and hand it to the gate as fact.
--
-- Nothing in the row records which of the two it is, so the values are not vouched for and are
-- dropped. The gate reads that as `no_identity`, refuses, and says so — the same fail-closed side
-- the whole feature stands on — and the contact's next event fills it back in. The cost is real:
-- until that event, an agent with the gate ON refuses this contact, and the prompt loses the name.
-- It is paid once, on upgrade, and it buys the guarantee that no contact is ever authorized under
-- an identity nobody can vouch for.
UPDATE "contacts" ct
SET "name" = NULL,
    "email" = NULL,
    "phone" = NULL,
    "attributes" = '{}'::jsonb,
    "name_at" = sub."last_event_at",
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

-- A contact with no positioned conversation keeps null watermarks, which is right (nothing has ever
-- positioned it), but its identity is just as unvouched-for, so it goes too.
UPDATE "contacts"
SET "name" = NULL, "email" = NULL, "phone" = NULL, "attributes" = '{}'::jsonb
WHERE "name_at" IS NULL;

RESET app.is_super_admin;
