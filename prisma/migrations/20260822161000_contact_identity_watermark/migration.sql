-- Source watermark for the contact's identity (name, e-mail, phone, operator identifier), for the
-- same reason `custom_attributes_at` exists: the write is otherwise unconditional and deliveries do
-- arrive out of order, so an older event could restore what a newer one cleared — and the
-- authorization gate asks the endpoint about whoever those values name.
ALTER TABLE "contacts" ADD COLUMN "identity_at" TIMESTAMP(3);

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
    "identity_at" = sub."last_event_at"
FROM (
  SELECT "contact_id", MAX("last_event_at") AS "last_event_at"
  FROM "conversations"
  WHERE "contact_id" IS NOT NULL AND "last_event_at" IS NOT NULL
  GROUP BY "contact_id"
) sub
WHERE ct."id" = sub."contact_id";

-- A contact with no positioned conversation keeps a null watermark, which is right (nothing has
-- ever positioned it), but its identity is just as unvouched-for, so it goes too.
UPDATE "contacts"
SET "name" = NULL, "email" = NULL, "phone" = NULL, "attributes" = '{}'::jsonb
WHERE "identity_at" IS NULL;

RESET app.is_super_admin;
